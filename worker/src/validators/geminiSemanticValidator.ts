import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import type { ValidationEvidence, RiskLevel } from "./validationEvidence";
import { createEmptyEvidence, shouldInjectEvidence } from "./validationEvidence";
import { getEvidenceGatingVariant, isEvidenceGatingEnabledForJob } from "./evidenceGating";
import { VALIDATION_FOCUS_MODE } from "../utils/logFocus";
import type { Stage2ValidationMode } from "./stage2ValidationMode";

const logger = console;

// AUDIT FIX: Validator thresholds consolidated and documented
// MIN_CONFIDENCE: Below this, never hard-fail (low confidence = uncertain → allow through)
const MIN_CONFIDENCE = 0.75;
// BUILTIN_HARDFAIL_CONFIDENCE: Built-in violation requires this + ≥2 structural anchors to hard-fail
const BUILTIN_HARDFAIL_CONFIDENCE = 0.85;

/**
 * Model routing: LOW risk → fast model, MEDIUM/HIGH risk → strong model
 */
function getModelForRisk(riskLevel?: RiskLevel): string {
  const strongModel = process.env.GEMINI_VALIDATOR_MODEL_STRONG || "gemini-2.5-flash";
  const fastModel = process.env.GEMINI_VALIDATOR_MODEL_FAST || "gemini-2.0-flash";

  if (!riskLevel || riskLevel === "LOW") return fastModel;
  return strongModel; // MEDIUM and HIGH → strong model
}

function collectEvidenceKeys(evidence: ValidationEvidence): string[] {
  const keys: string[] = [];
  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;
  const hasAnchors = Object.values(evidence.anchorChecks || {}).some(Boolean);
  const hasDrift = (evidence.drift?.wallPercent ?? 0) > 0 ||
    (evidence.drift?.maskedEdgePercent ?? 0) > 0 ||
    (evidence.drift?.angleDegrees ?? 0) > 0;
  const ssimSignal = evidence.ssimPassed === false || evidence.ssim < evidence.ssimThreshold;

  if (ssimSignal) keys.push("ssim");
  if (windowsDelta !== 0 || doorsDelta !== 0) keys.push("openings");
  if (hasAnchors) keys.push("anchors");
  if (hasDrift) keys.push("drift");
  if (evidence.localFlags && evidence.localFlags.length > 0) keys.push("localFlags");

  return keys;
}

function gateEvidenceForGemini(stage: "1B" | "2", evidence: ValidationEvidence, jobId?: string): ValidationEvidence {
  if (!isEvidenceGatingEnabledForJob(jobId)) return evidence;

  const gated = createEmptyEvidence(evidence.jobId, evidence.stage);

  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;
  const openingsChanged = windowsDelta !== 0 || doorsDelta !== 0;
  const hasAnchors = Object.values(evidence.anchorChecks || {}).some(Boolean);

  const allowFlags: string[] = [];
  if (hasAnchors) {
    gated.anchorChecks = { ...evidence.anchorChecks };
    allowFlags.push(...evidence.localFlags.filter((flag) => flag.startsWith("anchor:")));
  }

  if (openingsChanged) {
    gated.openings = { ...evidence.openings };
  }

  const wallRemovalDetected = evidence.localFlags.some((flag) =>
    flag.toLowerCase().includes("wall") && flag.toLowerCase().includes("remove")
  );
  const structuralMaskFailed = evidence.localFlags.some((flag) =>
    flag.toLowerCase().includes("structuralmask") || flag.toLowerCase().includes("structural mask")
  );

  if (wallRemovalDetected) {
    allowFlags.push(...evidence.localFlags.filter((flag) =>
      flag.toLowerCase().includes("wall") && flag.toLowerCase().includes("remove")
    ));
  }

  if (structuralMaskFailed) {
    allowFlags.push(...evidence.localFlags.filter((flag) =>
      flag.toLowerCase().includes("structuralmask") || flag.toLowerCase().includes("structural mask")
    ));
  }

  if (stage === "1B") {
    const allowDrift = (evidence.drift?.wallPercent ?? 0) > 35 ||
      (evidence.drift?.maskedEdgePercent ?? 0) > 55 ||
      (evidence.drift?.angleDegrees ?? 0) > 25;
    if (allowDrift) {
      gated.drift = { ...evidence.drift };
    }
  }

  gated.localFlags = Array.from(new Set(allowFlags));
  gated.geometryProfile = evidence.geometryProfile;

  return gated;
}

/**
 * Build evidence-injected adjudicator prompt
 *
 * Architecture:
 * - SYSTEM BLOCK: Role definition + decision rules
 * - SIGNAL BLOCK: Auto-inserted ValidationEvidence (no human edits)
 * - RULE OVERRIDE BLOCK: Anchor overrides (any anchor flag → must say "structure")
 */
function buildAdjudicatorPrompt(
  basePrompt: string,
  evidence?: ValidationEvidence,
  riskLevel?: RiskLevel
): string {
  if (!evidence) return basePrompt;
  const jobId = evidence.jobId || "unknown";
  const variant = getEvidenceGatingVariant(jobId);
  const gatingEnabled = isEvidenceGatingEnabledForJob(jobId);
  const gatedEvidence = gateEvidenceForGemini(evidence.stage, evidence, jobId);
  if (VALIDATION_FOCUS_MODE) {
    logger.info("[EVIDENCE_GATING_VARIANT]", {
      jobId,
      variant,
      stage: evidence.stage,
    });
    if (gatingEnabled) {
      const keysBefore = collectEvidenceKeys(evidence).length;
      const keysAfter = collectEvidenceKeys(gatedEvidence).length;
      logger.info("[EVIDENCE_GATING_ACTIVE]", {
        jobId,
        stage: evidence.stage,
        keys_before: keysBefore,
        keys_after: keysAfter,
      });
    }
  }

  if (!shouldInjectEvidence(gatedEvidence)) {
    logger.info("[VALIDATION_EVIDENCE] skipped_below_threshold", {
      stage: gatedEvidence.stage,
      jobId: gatedEvidence.jobId,
    });
    return basePrompt;
  }

  const windowsDelta = gatedEvidence.openings.windowsAfter - gatedEvidence.openings.windowsBefore;
  const doorsDelta = gatedEvidence.openings.doorsAfter - gatedEvidence.openings.doorsBefore;

  const anchorFlags = [
    gatedEvidence.anchorChecks.islandChanged ? "ISLAND_CHANGED" : null,
    gatedEvidence.anchorChecks.hvacChanged ? "HVAC_CHANGED" : null,
    gatedEvidence.anchorChecks.cabinetryChanged ? "CABINETRY_CHANGED" : null,
    gatedEvidence.anchorChecks.lightingChanged ? "LIGHTING_CHANGED" : null,
  ].filter(Boolean).slice(0, 3);

  const limitedLocalFlags = gatedEvidence.localFlags.slice(0, 3);

  const localSignals = {
    wallDriftPct: Number(gatedEvidence.drift.wallPercent.toFixed(1)),
    maskedDriftPct: Number(gatedEvidence.drift.maskedEdgePercent.toFixed(1)),
    openingDelta: {
      windows: windowsDelta,
      doors: doorsDelta,
    },
    lineDeviationDeg: Number(gatedEvidence.drift.angleDegrees.toFixed(1)),
    anchorFlags,
  };

  const signalBlock = `
────────────────────────────────
AUTOMATED STRUCTURE OBSERVATIONS (heuristic — may be noisy)
These measurements are heuristic signals and may contain noise.

You must independently verify any opening count change,
anchor flag, or extreme wall drift by visually inspecting the images.

If the visual evidence clearly supports the signal
(e.g., an opening is missing, sealed, or relocated),
you must classify it as structural.

If the signal is contradicted by clear visual evidence
(e.g., the opening still exists and remains functional),
you may treat it as a false positive and explain why.
────────────────────────────────
These are computer-vision measurements from the validation pipeline.
They are factual measurements, not opinions.

SSIM: ${gatedEvidence.ssim.toFixed(4)} (threshold: ${gatedEvidence.ssimThreshold}, ${gatedEvidence.ssimPassed ? "OK" : "LOW"})
Risk Level: ${riskLevel || "UNKNOWN"}
Geometry Profile: ${gatedEvidence.geometryProfile}

Openings Delta:
- Windows: ${gatedEvidence.openings.windowsBefore} → ${gatedEvidence.openings.windowsAfter} (delta: ${windowsDelta >= 0 ? "+" : ""}${windowsDelta})
- Doors: ${gatedEvidence.openings.doorsBefore} → ${gatedEvidence.openings.doorsAfter} (delta: ${doorsDelta >= 0 ? "+" : ""}${doorsDelta})

Drift Metrics:
- Wall drift: ${(gatedEvidence.drift.wallPercent).toFixed(1)}%
- Masked edge drift: ${(gatedEvidence.drift.maskedEdgePercent).toFixed(1)}%
- Angle deviation: ${gatedEvidence.drift.angleDegrees.toFixed(1)}°

Anchor Region Flags: ${anchorFlags.length > 0 ? anchorFlags.join(", ") : "NONE"}

Local Validator Flags: ${limitedLocalFlags.length > 0 ? limitedLocalFlags.join("; ") : "NONE"}

LOCAL VALIDATOR SIGNALS (JSON):
${JSON.stringify(localSignals, null, 2)}

────────────────────────────────
NUMERIC DRIFT SIGNAL RULE
────────────────────────────────
SSIM failure alone is NOT structural.
Edge IoU failure alone is NOT structural.
Angle deviation alone is NOT structural.

These signals are advisory unless accompanied by:
• opening count change
• anchor removal/addition
• built-in joinery change
• window/door relocation

────────────────────────────────

Numeric drift alone is NOT structural failure.
Anchor change IS structural failure.
`;

  const hasAnchorViolation = anchorFlags.length > 0;
  const hasOpeningDelta = windowsDelta !== 0 || doorsDelta !== 0;

  const overrideBlock = (hasAnchorViolation || hasOpeningDelta) ? `
────────────────────────────────
MANDATORY OVERRIDE RULES
────────────────────────────────
${hasOpeningDelta ? `⚠️ OPENING COUNT CHANGED — Computer vision detected window/door count delta.
   You MUST verify this. If you agree openings changed: category=structure, hardFail=true.
   If you disagree (e.g., furniture occluding view), explain in reasons.` : ""}
${hasAnchorViolation ? `⚠️ ANCHOR REGION FLAGS ACTIVE: ${anchorFlags.join(", ")}
   Structural function anchors were detected as changed by computer vision.
   You MUST verify these. If you agree anchors changed: category=structure, hardFail=true.
   If you disagree (false positive), explain why in reasons.` : ""}

Do NOT downgrade to style_only or furniture_change when anchor/opening flags are active
unless you have HIGH CONFIDENCE (>0.90) that the flag is a false positive.

Do not assign high-confidence structural violation scores to desks, shelving,
or freestanding storage furniture.
` : "";

  logger.info("[VALIDATION_EVIDENCE] injected", {
    stage: gatedEvidence.stage,
    jobId: gatedEvidence.jobId,
  });

  return basePrompt + signalBlock + overrideBlock;
}

export type GeminiSemanticVerdict = {
  hardFail: boolean;
  category: "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown";
  reasons: string[];
  confidence: number;
  violationType?: "opening_change" | "wall_change" | "camera_shift" | "built_in_moved" | "layout_only" | "other";
  builtInDetected?: boolean;
  structuralAnchorCount?: number;
  rawText?: string;
};

export type Stage1BValidationMode =
  | "LIGHT_DECLUTTER"
  | "STRUCTURED_RETAIN";

function isBuiltInDowngradeAllowed(input: {
  violationType: GeminiSemanticVerdict["violationType"];
  builtInDetected: boolean;
  structuralAnchorCount: number;
  confidence: number;
}): boolean {
  if (input.violationType !== "built_in_moved") return false;
  if (!input.builtInDetected) return false;
  return input.structuralAnchorCount < 2 || input.confidence < BUILTIN_HARDFAIL_CONFIDENCE;
}

export function buildFinalFixtureConfirmPrompt(input: {
  sceneType?: "interior" | "exterior";
  localFindings?: string[];
} = {}): string {
  const findings = (input.localFindings || []).filter(Boolean);
  const findingsBlock = findings.length
    ? findings.map((f) => `- ${f}`).join("\n")
    : "- none";

  return `ROLE — Final Fixture & Built-In Identity Auditor

You are the final-pass adjudicator for fixed fixtures and built-in identity consistency.

Compare BEFORE (Stage 1A baseline/original-enhanced image) vs AFTER (Stage 2 candidate image).

CRITICAL STRUCTURAL OPENING VERIFICATION

OCCLUSION & REVEAL PROTECTION (CRITICAL)

Structural visibility must remain consistent with BEFORE.

If a structural surface was partially obscured (e.g., by curtains, blinds, or soft furnishings),
AFTER must not:

• Remove occluding elements to reveal new wall area
• Reveal previously unseen structural boundaries
• Reveal new opening geometry
• Extend visible wall envelope beyond what was visible in BEFORE

Hard fail if newly visible structural surfaces appear that were not clearly visible in BEFORE.

If detected:
→ category = structure
→ violationType = layout_only
→ hardFail = true

You MUST verify that every doorway and window visible in BEFORE
still exists in AFTER.

If an opening has been sealed, covered with wall surface,
visually removed, or converted into solid wall area,
this is structural removal.

This MUST be classified as:
→ category = structure
→ violationType = opening_change
→ hardFail = true

Focus ONLY on these fixed/built-in checks:
• faucets and taps
• sinks and sink count
• built-in ovens
• cooktops
• rangehoods
• built-in cabinetry
• cabinet count
• cabinet layout
• cabinet door style class
• kitchen islands
• pendant lights
• downlights
• fixed ceiling fixtures

CEILING FIXTURE STRUCTURAL ENFORCEMENT (CRITICAL)

Ceiling-mounted fixtures are structural elements.

Adding, removing, relocating, resizing, or changing the count of:

• pendant lights
• downlights
• fixed ceiling fixtures

is structural.

Hard fail if any of the above changes are detected.

If detected:
→ category = structure
→ violationType = built_in_moved
→ hardFail = true

• vents and grilles
• HVAC / heat pump units
• thermostats and control panels
• switch plates and outlet plates
• doorway openings added or removed

BUILT-IN GEOMETRIC ENVELOPE LOCK (CRITICAL)

Built-in elements must preserve their exact geometric footprint and silhouette envelope.

This includes:

• Edge boundary alignment
• Countertop length
• Cabinet depth
• Cabinet termination points
• Island footprint dimensions
• Spatial alignment relative to walls

Hard fail if:

• A kitchen island footprint expands or contracts
• A cabinet run extends into new floor area
• Counter length increases or decreases
• Built-in geometry encloses previously open space
• Silhouette envelope changes even if material appears similar

Subtle perspective-adjusted enlargement counts as built-in movement.

If detected:
→ category = structure
→ violationType = built_in_moved
→ hardFail = true

IGNORE (out of scope):
• general wall surface color differences
• general wall texture differences
• cosmetic repainting
• staging furniture styling
• decor differences
• lighting tone differences

FINAL LOCAL VALIDATOR FINDINGS — MUST ADJUDICATE
The following automated validators detected potential violations.
You MUST explicitly CONFIRM or REJECT each listed finding in your reasons output.

${findingsBlock}

Hard adjudication rule:
If findings indicate openings delta ≠ 0,
doorway removed/added, opening sealed,
anchor moved, or built-in changed,
you must return category=structure or opening_blocked
with hardFail=true,
unless you provide a high-confidence, image-based
false-positive explanation in reasons.

Return JSON only.

Output schema (unchanged):
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}

Scene: ${(input.sceneType || "interior").toUpperCase()}`;
}

const STAGE1B_LIGHT_DECLUTTER_CONTEXT_BLOCK = `
─────────────────────────────
STAGE CONTEXT — LIGHT DECLUTTER
─────────────────────────────
The BEFORE image is the original furnished room.
The AFTER image is a light decluttered version.

Light declutter MAY remove:
• small loose items
• decor objects
• table-top items
• small floor clutter
• portable accessories

Light declutter MAY:
• simplify surfaces
• clear visual clutter
• remove small movable objects

Light declutter MUST NOT:
• remove built-in furniture
• remove large primary furniture
• modify structure
• change layout anchors
• change fixtures
• change camera viewpoint
`;

const STAGE1B_LIGHT_DECLUTTER_ALLOWED_DIFFERENCES_BLOCK = `
─────────────────────────────
ALLOWED DIFFERENCES — DO NOT FLAG
─────────────────────────────
Do NOT flag as violations:
• missing small decor
• cleared tabletops
• removed small objects
• simplified shelves
• fewer loose accessories

These are expected results of decluttering.
`;

const STAGE1B_LIGHT_DECLUTTER_FURNITURE_RULE_BLOCK = `
─────────────────────────────
FURNITURE RULE — LIGHT DECLUTTER
─────────────────────────────
Large primary furniture (sofas, beds, dining tables, cabinets, desks) should normally remain.

If a large primary furniture item is missing in AFTER:
→ category: furniture_change
→ hardFail: false (warning), not structure fail

Only mark hardFail true if a built-in or structural anchor is removed.
`;

const STAGE1B_STRUCTURED_RETAIN_CONTEXT_BLOCK = `
─────────────────────────────
STAGE CONTEXT — STRUCTURED RETAIN DECLUTTER
─────────────────────────────
The BEFORE image is the original furnished room.
The AFTER image is a structured-retain decluttered version.

This edit removes clutter and secondary/non-core items while retaining
primary anchor furniture and layout structure.

Empty-room output is NOT expected.
`;

const STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_BLOCK = `
─────────────────────────────
ALLOWED DIFFERENCES — STRUCTURED RETAIN
─────────────────────────────
Do NOT flag the following as structural violations:

• removed clutter and loose decor
• removed wall art and accessories
• removed secondary seating or small movable furniture
• reduced non-core movable objects
• decor removal
• accessory cleanup

These are expected results of structured retain decluttering.
`;

const STAGE1B_STRUCTURED_RETAIN_STRUCTURAL_SIGNAL_RULE_BLOCK = `
─────────────────────────────
STRUCTURAL SIGNAL RULE — WHAT COUNTS AS STRUCTURE
─────────────────────────────
Judge structure ONLY by:

• wall positions
• door and window openings
• built-in cabinetry and islands
• plumbing fixtures
• fixed lighting
• HVAC units and vents
• camera perspective and framing

Do NOT judge structure using:

• shadows
• furniture outlines
• decor presence
• floor shading differences
• contact marks
`;

const STAGE1B_STRUCTURED_RETAIN_SUBTRACTIVE_ENVELOPE_LOCK_BLOCK = `
─────────────────────────────
STAGE 1B CORE PRINCIPLE — SUBTRACTIVE ONLY
─────────────────────────────
Stage 1B structured retain is strictly subtractive.

It may remove clutter and secondary furniture.

It must NEVER:
• regenerate the room
• alter architectural geometry
• change camera position
• change room proportions
• replace walls
• replace windows
• alter envelope scale

If the room envelope appears materially different, this is structural failure.

─────────────────────────────
GLOBAL ENVELOPE LOCK — CRITICAL
─────────────────────────────
The architectural shell must remain visually identical between BEFORE and AFTER.

The following must match:
• wall positions and angles
• corner locations
• ceiling height and geometry
• floor boundaries and depth perspective
• window-to-wall ratio
• door-to-wall ratio
• room depth perception
• camera position and field of view

If AFTER appears to depict different room geometry, wall spacing,
window proportion, or camera viewpoint:
→ category: structure
→ violationType: wall_change OR camera_shift
→ hardFail: true

Even if openings still exist, geometry must match BEFORE.

─────────────────────────────
ZERO-TOLERANCE GEOMETRY RULE
─────────────────────────────
For Stage 1B structured retain, material envelope drift is structural drift.

Low structural similarity is sufficient to escalate structural investigation.
If visual envelope similarity is low, err toward structural violation.
`;

const STAGE1B_STRUCTURED_RETAIN_OPENING_CAMERA_LOCK_BLOCK = `
─────────────────────────────
OPENINGS LOCK
─────────────────────────────
Windows and doors must:
• exist in identical positions
• maintain identical proportions
• maintain identical relative wall placement

Even if not removed, if proportion relative to wall changes,
this is structural drift.

─────────────────────────────
CAMERA LOCK
─────────────────────────────
Camera viewpoint must remain consistent.

The following indicate camera shift:
• vanishing point change
• room appears wider or narrower
• perspective depth changes
• window framing differs significantly
• wall convergence differs

Minor micro-straightening is acceptable.
Material viewpoint shift is not.
`;

const STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_STRICT_BLOCK = `
─────────────────────────────
ALLOWED DIFFERENCES (ONLY)
─────────────────────────────
Only the following are allowed:
• removal of clutter
• removal of wall art
• removal of secondary movable furniture
• removal of decor
• minor surface exposure from object removal

Declutter must not alter geometry.
`;

const STAGE1B_STRUCTURED_RETAIN_FAILURE_CONDITIONS_BLOCK = `
─────────────────────────────
FAILURE CONDITIONS (ANY = HARD FAIL)
─────────────────────────────
• architectural envelope appears different
• wall boundary shifts
• room proportions differ
• window-to-wall ratio differs
• ceiling geometry differs
• camera perspective shifts materially
• structural edges do not align

Return:
category: structure
hardFail: true
`;

const STAGE1B_STRUCTURED_RETAIN_NUMERIC_SIGNAL_ENFORCEMENT_BLOCK = `
─────────────────────────────
NUMERIC SIGNAL INTERPRETATION — STAGE 1B
─────────────────────────────
Low structural IoU OR
low edge alignment OR
low spatial similarity

→ increases likelihood of structural drift.

Do NOT downgrade these to advisory in Stage 1B structured retain.
Investigate visually and fail if geometry differs.
`;

const STAGE1B_OPENING_HALLUCINATION_RULE_BLOCK = `
─────────────────────────────
NEW OPENING HALLUCINATION RULE (HARD FAIL)
─────────────────────────────
If any doorway, window, pass-through, or opening appears in AFTER
that was NOT clearly visible in BEFORE, this is structural hallucination.

→ category: structure
→ violationType: opening_change
→ hardFail: true

This includes newly invented openings in wall regions that were previously
plain wall or ambiguous due to reconstruction.
`;

const STAGE1B_PARTIAL_FRAME_COMPLETION_RULE_BLOCK = `
─────────────────────────────
PARTIAL FRAME COMPLETION RULE (HARD FAIL)
─────────────────────────────
Do NOT allow inferred completion of partially visible openings.

Hard fail if AFTER shows completed or extended opening geometry that is not
clearly supported by BEFORE, including:
• completed door frames from partial edges
• extended jambs
• inferred lintels/headers
• completed recess depth or alcove geometry

If frame geometry is completed beyond visible evidence:
→ category: structure
→ violationType: opening_change
→ hardFail: true
`;

const STAGE1B_STRUCTURED_RETAIN_FURNITURE_RULE_BLOCK = `
─────────────────────────────
FURNITURE RULE — STRUCTURED RETAIN
─────────────────────────────
Primary anchor furniture is expected to remain.

Preserved anchors must NOT be treated as violations.

Secondary furniture and non-core movable items are expected to be reduced/removed.

If a primary anchor appears missing, classify as furniture_change (warning) unless
clear structural/built-in alteration is also present.

Missing secondary movable items should not trigger structural failure.

If remaining furniture is boundary-adjacent (window frame, sliding door,
visible seam, or partially occluded by a structural boundary), classify as
furniture_change advisory when structure is intact.

Do not hard-fail boundary-adjacent preserved items unless there is clear
opening, wall, or camera structural violation.

Only built-in or structural element removal may trigger hardFail true.
`;

export function buildStage1BLightDeclutterValidatorPrompt(_options: {
  scene?: string;
} = {}): string {
  return `You are a Structural Integrity & Edit Compliance Auditor for NZ real estate imagery — Stage 1B Light Declutter.

Compare BEFORE and AFTER images.

Return JSON only. No prose outside JSON.

${STAGE1B_LIGHT_DECLUTTER_CONTEXT_BLOCK}

${STAGE1B_LIGHT_DECLUTTER_ALLOWED_DIFFERENCES_BLOCK}

─────────────────────────────
STRUCTURAL PRIORITY HIERARCHY
─────────────────────────────
Priority order:

1. Structural anchors and built-ins
2. Openings and access
3. Floors, walls, ceilings
4. Fixed fixtures and lighting
5. Camera and perspective
6. Furniture and decor

Higher priority always overrides lower.

─────────────────────────────
PERSPECTIVE & VISIBILITY TOLERANCE — OPENINGS
─────────────────────────────
Do not classify a window or opening as structurally modified if the
difference is caused by:
• Perspective correction
• Vertical line straightening
• Minor camera geometry normalization
• Small crop or framing shift
• Slightly increased or decreased visible window area

These are considered camera or lens corrections, not architectural changes.

Only flag a structural violation if the window or opening itself has been:
✗ Moved to a new wall position
✗ Removed entirely
✗ Newly created
✗ Shape changed
✗ Proportionally resized relative to wall structure

A change in how much of the window is visible is NOT a structural modification.

${STAGE1B_OPENING_HALLUCINATION_RULE_BLOCK}

${STAGE1B_PARTIAL_FRAME_COMPLETION_RULE_BLOCK}

─────────────────────────────
ANCHOR RELOCATION RULE
─────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not declutter.
→ category: structure, hardFail: true

Anchors are physically fixed to the building. They cannot move.
Any positional shift — even if the element looks identical — is a failure.

─────────────────────────────
BUILT-IN vs MOVABLE DISAMBIGUATION (STRICT)
─────────────────────────────
Only classify an object as BUILT-IN if it meets at least TWO physical criteria.

BUILT-IN OBJECT = MUST meet >= 2:
• Physically continuous with wall surface
• No visible rear gap
• No visible legs or movable base
• Extends from floor to wall or wall to ceiling
• Shares material + finish with wall cabinetry
• Enclosed in recess or alcove
• Part of a continuous cabinetry run
• Cannot be moved without tools or demolition

MOVABLE OBJECT = ANY object with:
• Legs
• Visible rear gap
• Shadow gap behind
• Separate base
• Freestanding footprint
• Visible floor clearance

Set builtInDetected = true only if structuralAnchorCount >= 2.
structuralAnchorCount = number of built-in criteria matched.
Only block for built-in violations when builtInDetected == true AND structuralAnchorCount >= 2.

Desk + shelving units with legs or visible floor clearance MUST be treated as movable furniture — not built-in — even if positioned against a wall.

If uncertain, treat as MOVABLE (do NOT elevate to built-in without evidence).

─────────────────────────────
STRUCTURAL BUILT-IN CLASSIFICATION — STRICT DEFINITION
─────────────────────────────
Only classify an object as a structural built-in if it is permanently
integrated into the architecture and would require construction work to remove.

TRUE structural built-ins include:
• Kitchen cabinetry fixed to walls
• Kitchen counters and islands
• Bathroom vanities connected to plumbing
• Recessed built-in wardrobes
• Fixed wall cabinetry
• Fireplaces
• Staircases
• Permanently installed window seating
• Architectural millwork fixed into walls

The following are NOT structural built-ins and must NOT trigger
structural violation failures:
✗ Desks
✗ Freestanding shelving units
✗ Bookcases
✗ Dressers
✗ Tallboys
✗ Sideboards
✗ Staging wardrobes
✗ Modular storage systems
✗ Removable shelving
✗ Office furniture
✗ Nightstands
✗ Staging cabinets

Desks and shelving units must be treated as movable furniture unless
clearly recessed into wall structure.

Never classify freestanding desks or shelving as structural built-ins.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen islands, counters, vanities, splashbacks
- Fixed lighting (pendants, downlights, sconces)
- Heat pumps, vents, radiators
- Plumbing fixtures
- Exterior views through windows

ANY violation → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────
STRUCTURAL FUNCTION ANCHOR CHECK (CRITICAL)
If any of the following appear in BEFORE image, they MUST remain unchanged:
• Kitchen islands and counters
• Built-in cabinets and wardrobes
• Bathroom fixtures
• Heat pumps and vents
• Pendant lights and fixed lighting
• Curtain rails, rods, tracks, blind systems (NOT fabric)
• Fireplaces
• Staircases
• Built-in shelving

Removed, replaced, relocated, or altered → structure hardFail true

🪟 WINDOW COVERING STRUCTURE RULE (REVISED)

Window covering STRUCTURE = rails, rods, tracks, blind housings.

HARD FAIL (structure):
• Blind systems added where none existed
• Blind systems removed
• Curtain rails or tracks added where none existed
• Curtain rails or tracks removed

WARNING ONLY (style_only — NOT hardFail):
• Curtain fabric changed but rail already existed
• Curtains added to an EXISTING rail
• Curtain color or material changed

Curtain fabric is decor.
Rails/tracks/blind systems are structure.

FLOOR COLOR/MATERIAL LOCK
• Floor material AND color must match
• Carpet color must match
• No floor recoloring allowed

Any violation → structure hardFail true

${STAGE1B_LIGHT_DECLUTTER_FURNITURE_RULE_BLOCK}

─────────────────────────────
NUMERIC DRIFT ADVISORY
─────────────────────────────
SSIM failure alone is NOT structural.
Edge IoU failure alone is NOT structural.
Angle deviation alone is NOT structural.

These signals are advisory unless accompanied by:
• opening count change
• anchor removal/addition
• built-in joinery change
• window/door relocation

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (warning for large furniture removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

BUILT-IN DOWNGRADE RULE:
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85)
→ hardFail = false (warning only)

VIOLATION TYPE (REQUIRED)
Choose exactly one:
- opening_change = window/door/opening added/removed/moved
- wall_change = wall added/removed/shifted
- camera_shift = viewpoint or perspective changed
- built_in_moved = built-in cabinetry or anchored fixture changed
- layout_only = furniture/layout/staging only
- other = none of the above

─────────────────────────────
OUTPUT JSON
─────────────────────────────
Return JSON only. Include builtInDetected and structuralAnchorCount.
structuralAnchorCount = number of built-in criteria matched (0-8).
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
}

export function buildStage1BStructuredRetainValidatorPrompt(_options: {
  scene?: string;
} = {}): string {
  return `You are a Structural Integrity & Edit Compliance Auditor for NZ real estate imagery — Stage 1B Structured Retain Declutter.

Compare BEFORE and AFTER images.

Return JSON only. No prose outside JSON.

${STAGE1B_STRUCTURED_RETAIN_CONTEXT_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_STRUCTURAL_SIGNAL_RULE_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_SUBTRACTIVE_ENVELOPE_LOCK_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_OPENING_CAMERA_LOCK_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_ALLOWED_DIFFERENCES_STRICT_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_FAILURE_CONDITIONS_BLOCK}

${STAGE1B_OPENING_HALLUCINATION_RULE_BLOCK}

${STAGE1B_PARTIAL_FRAME_COMPLETION_RULE_BLOCK}

─────────────────────────────
STRUCTURAL PRIORITY HIERARCHY
─────────────────────────────
Priority order:

1. Structural anchors and built-ins
2. Openings and access
3. Floors, walls, ceilings
4. Fixed fixtures and lighting
5. Camera and perspective
6. Furniture and decor

Higher priority always overrides lower.

─────────────────────────────
ANCHOR RELOCATION RULE
─────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not declutter.
→ category: structure, hardFail: true

Anchors are physically fixed to the building. They cannot move.
Any positional shift — even if the element looks identical — is a failure.

─────────────────────────────
BUILT-IN vs MOVABLE DISAMBIGUATION (STRICT)
─────────────────────────────
Only classify an object as BUILT-IN if it meets at least TWO physical criteria.

BUILT-IN OBJECT = MUST meet >= 2:
• Physically continuous with wall surface
• No visible rear gap
• No visible legs or movable base
• Extends from floor to wall or wall to ceiling
• Shares material + finish with wall cabinetry
• Enclosed in recess or alcove
• Part of a continuous cabinetry run
• Cannot be moved without tools or demolition

MOVABLE OBJECT = ANY object with:
• Legs
• Visible rear gap
• Shadow gap behind
• Separate base
• Freestanding footprint
• Visible floor clearance

Set builtInDetected = true only if structuralAnchorCount >= 2.
structuralAnchorCount = number of built-in criteria matched.
Only block for built-in violations when builtInDetected == true AND structuralAnchorCount >= 2.

Desk + shelving units with legs or visible floor clearance MUST be treated as movable furniture — not built-in — even if positioned against a wall.

If uncertain, treat as MOVABLE (do NOT elevate to built-in without evidence).

─────────────────────────────
STRUCTURAL BUILT-IN CLASSIFICATION — STRICT DEFINITION
─────────────────────────────
Only classify an object as a structural built-in if it is permanently
integrated into the architecture and would require construction work to remove.

TRUE structural built-ins include:
• Kitchen cabinetry fixed to walls
• Kitchen counters and islands
• Bathroom vanities connected to plumbing
• Recessed built-in wardrobes
• Fixed wall cabinetry
• Fireplaces
• Staircases
• Permanently installed window seating
• Architectural millwork fixed into walls

The following are NOT structural built-ins and must NOT trigger
structural violation failures:
✗ Desks
✗ Freestanding shelving units
✗ Bookcases
✗ Dressers
✗ Tallboys
✗ Sideboards
✗ Staging wardrobes
✗ Modular storage systems
✗ Removable shelving
✗ Office furniture
✗ Nightstands
✗ Staging cabinets

Desks and shelving units must be treated as movable furniture unless
clearly recessed into wall structure.

Never classify freestanding desks or shelving as structural built-ins.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen islands, counters, vanities, splashbacks
- Fixed lighting (pendants, downlights, sconces)
- Heat pumps, vents, radiators
- Plumbing fixtures
- Exterior views through windows

ANY violation → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────
STRUCTURAL FUNCTION ANCHOR CHECK (CRITICAL)
If any of the following appear in BEFORE image, they MUST remain unchanged:
• Kitchen islands and counters
• Built-in cabinets and wardrobes
• Bathroom fixtures
• Heat pumps and vents
• Pendant lights and fixed lighting
• Curtain rails, rods, tracks, blind systems (NOT fabric)
• Fireplaces
• Staircases
• Built-in shelving

Removed, replaced, relocated, or altered → structure hardFail true

🪟 WINDOW COVERING STRUCTURE RULE (REVISED)

Window covering STRUCTURE = rails, rods, tracks, blind housings.

HARD FAIL (structure):
• Blind systems added where none existed
• Blind systems removed
• Curtain rails or tracks added where none existed
• Curtain rails or tracks removed

WARNING ONLY (style_only — NOT hardFail):
• Curtain fabric changed but rail already existed
• Curtains added to an EXISTING rail
• Curtain color or material changed

Curtain fabric is decor.
Rails/tracks/blind systems are structure.

FLOOR COLOR/MATERIAL LOCK
• Floor material AND color must match
• Carpet color must match
• No floor recoloring allowed

Any violation → structure hardFail true

${STAGE1B_STRUCTURED_RETAIN_FURNITURE_RULE_BLOCK}

${STAGE1B_STRUCTURED_RETAIN_NUMERIC_SIGNAL_ENFORCEMENT_BLOCK}

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (warning for large furniture removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

BUILT-IN DOWNGRADE RULE:
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85)
→ hardFail = false (warning only)

VIOLATION TYPE (REQUIRED)
Choose exactly one:
- opening_change = window/door/opening added/removed/moved
- wall_change = wall added/removed/shifted
- camera_shift = viewpoint or perspective changed
- built_in_moved = built-in cabinetry or anchored fixture changed
- layout_only = furniture/layout/staging only
- other = none of the above

─────────────────────────────
OUTPUT JSON
─────────────────────────────
Return JSON only. Include builtInDetected and structuralAnchorCount.
structuralAnchorCount = number of built-in criteria matched (0-8).
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
}

function buildPrompt(
  stage: "1A" | "1B" | "2",
  scene?: string,
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready",
  validationMode?: Stage2ValidationMode,
  stage1BValidationMode?: Stage1BValidationMode
) {
  if (stage === "1B") {
    if (stage1BValidationMode === "STRUCTURED_RETAIN") {
      return buildStage1BStructuredRetainValidatorPrompt({ scene });
    }
    return buildStage1BLightDeclutterValidatorPrompt({ scene });
  }

  if (stage === "2") {
    const resolvedValidationMode: Stage2ValidationMode =
      validationMode ?? (sourceStage === "1A" ? "FULL_STAGE_ONLY" : "REFRESH_OR_DIRECT");
    const isFullStaging = resolvedValidationMode === "FULL_STAGE_ONLY";
    const contextHeader = buildStage2ContextHeader(resolvedValidationMode);
    const stagingModeInstruction = isFullStaging
      ? "The BEFORE image is a stage-only baseline (typically empty). The AFTER image should contain staged furniture appropriate for the room type."
      : "The BEFORE image is a structured-retain or light-declutter baseline. The AFTER image should augment the room while preserving architecture and anchor geometry.";
    const stagingIntentRule = isFullStaging
      ? "- FULL STAGING MODE: Empty room must now contain appropriate furniture for the room type.\n  Missing furniture in empty areas is FAILURE. Inappropriate furniture type is FAILURE."
      : "- REFRESH STAGING MODE: Preserved anchors may remain and be restyled.\n  New complementary furniture/decor additions are allowed in augmentable zones.\n  Do NOT treat expected additions as structural drift.";
    const refreshHistoryContext = `STAGE HISTORY CONTEXT — DECLUTTER AWARE INTERPRETATION

The BEFORE image represents the original Stage 1A baseline.

However, Stage 1B structured-retain declutter has already occurred prior to this refresh stage.

Therefore, differences caused by Stage 1B must be treated as pre-approved and NON-STRUCTURAL.

These differences alone must NEVER be classified as structural violations:

• Removal of secondary furniture
• Removal of clutter
• Removal of decor
• Removal of wall art
• Removal of rugs
• Removal of surface-level objects
• Removal of island countertop items
• Removal of movable seating

Structural violations must be determined only by architectural envelope or built-in base geometry.`;
    const refreshStructuralCategorySeparation = `STRUCTURAL CATEGORY SEPARATION — REFRESH MODE

Distinguish clearly between:

1️⃣ STRUCTURAL ENVELOPE (HARD STRUCTURE)

Walls (position, thickness, geometry)

Ceiling height and shape

Floor boundaries and depth

Door frames and window frames

Bulkheads, beams, columns

Permanent recesses

Any modification to these is structural.

2️⃣ BUILT-IN ANCHORS — BASE GEOMETRY ONLY

Kitchen islands (BASE footprint only)

Fixed cabinetry

Built-in wardrobes

Fixed vanities

Fireplaces

Staircases

For built-in anchors:
Only base footprint, dimensions, silhouette envelope, and position are structural.

Surface-level contents are NOT structural:

Countertop decor

Items sitting on islands

Bar stools

Small appliances

Styling accessories

3️⃣ FREESTANDING FURNITURE — NEVER STRUCTURAL

The following are always non-structural in refresh mode:

Beds

Sofas

Chairs

Tables

Dressers

Nightstands

Stools

Movable shelving

Rugs

Removal, replacement, resizing, or repositioning of freestanding furniture
must NEVER trigger structural classification.`;
    const refreshBuiltInSection = `3️⃣ BUILT-IN / STRUCTURAL ANCHORS

These are considered structural anchors:

Kitchen islands (fixed cabinetry)

Built-in wardrobes

Fixed vanities

Fixed joinery

Fireplaces

Staircases

HVAC built-ins

Permanent cabinetry

KITCHEN ISLAND STRUCTURAL RULE — BASE GEOMETRY LOCK

The island BASE structure is architectural.

Structural violation occurs ONLY if:
• Island base footprint changes
• Island base dimensions change
• Island base position shifts
• Island base silhouette envelope changes
• Island base is removed entirely

The following are NOT structural:
• Removal of items placed on island
• Countertop styling changes
• Addition or removal of stools
• Replacement of surface decor
• Small appliance removal

Only island BASE geometry is structural.

FAIL if:

• Built-in cabinetry base geometry is extended, reduced, or relocated
• A fixed vanity or wardrobe base geometry changes form
• A fireplace base geometry is altered or removed
• A staircase base geometry is altered or removed`;
    const refreshMaterialSection = `4️⃣ MATERIAL & SURFACE PRESERVATION

Material preservation applies ONLY to:

Fixed architectural surfaces

Structural flooring materials

Built-in cabinetry finishes

FAIL if:

• Structural flooring material changes
• Fixed wall or ceiling finishes are altered to conceal structural edits
• Built-in cabinetry finishes are altered to conceal anchor geometry edits

Removal of rugs is NOT structural.
Removal of movable coverings is NOT structural.
Countertop object removal is NOT structural.

Lighting brightness or white balance changes are acceptable.`;

    return `ROLE

You are a Structural Integrity & Staging Compliance Auditor for New Zealand real estate virtual staging.

  ${contextHeader}

  ${stagingModeInstruction}

  ${stagingIntentRule}

  IMMUTABLE ANCHOR RULE (REFRESH MODE)
  In refresh mode, retained anchors are immutable geometry references.
  They may be restyled, but must not be translated, rotated, resized, removed, or relaid out.
  They must not be replaced with new geometry of different proportions,
  silhouette envelope, footprint, or edge boundaries.

  AUGMENTABLE ZONES RULE (REFRESH MODE)
  New furniture/decor additions are allowed in non-anchor open zones when they preserve walkways and structural constraints.
  Expected additions are not structural drift.

You are comparing:

BEFORE image (baseline after Stage 1)

AFTER image (Stage 2 staged result)

Your responsibility is to determine whether the AFTER image preserves the architectural structure while applying valid staging.

${isFullStaging ? "" : `${refreshHistoryContext}\n\n`}

DECISION PRIORITY (STRICT ORDER)

Always evaluate in this order:

Structural Integrity

Openings & Access

Built-in / Anchored Fixtures

Material Preservation

Staging Logic & Furniture Placement

If any rule in sections 1–4 fails → this is a structural violation.

${isFullStaging ? "" : `${refreshStructuralCategorySeparation}\n\n`}

1️⃣ STRUCTURAL INTEGRITY (CRITICAL)

The following elements are ZERO-TOUCH and must not change:

Walls (position, thickness, shape)

Ceiling geometry

Floor boundaries

Bulkheads and soffits

Columns and beams

Permanent wall recesses

Door frames and window frames

FAIL if any of the following occur:

• A wall is added, removed, extended, or shortened
• A doorway is sealed, filled, narrowed, widened, or repositioned
• A window is removed, resized, relocated, or newly created
• A doorway/window/opening appears in AFTER that was not clearly visible in BEFORE
• A wall boundary is subtly extended, shifted, or expanded even without full wall removal
• Structural edges shift significantly
• A room boundary changes

If any of the above are true:

category: structure
violationType: opening_change OR wall_change OR layout_change
hardFail: true

${isFullStaging ? `GEOMETRIC PLANE STABILITY CHECK (CRITICAL)

All structural planes must preserve geometric alignment and boundary envelope.

This includes:

• Wall plane angle and alignment
• Ceiling-to-wall seam position
• Floor-to-wall junction alignment
• Corner intersection geometry
• Structural edge boundaries

Hard fail if:

• A wall plane visibly shifts angle or alignment
• Corner geometry softens or realigns
• Ceiling-wall seam migrates
• Structural edges relocate even if the wall still exists
• Plane boundary envelope expands or contracts

If detected:

category: structure
violationType: layout_change
hardFail: true

OPEN-PLAN ENCLOSURE CHECK (CRITICAL)

In FULL staging mode, open-plan layouts must remain open-plan.

Hard fail if:

• A built-in extension creates a new visual partition
• An island extension narrows circulation into a corridor
• Furniture or cabinetry creates a pseudo-wall
• Previously open functional zones become enclosed

If detected:

category: structure
violationType: layout_change
hardFail: true
` : ""}

EXTERIOR UTILITY FIXTURE CHECK — CRITICAL

If the BEFORE image contains any of the following:

• Exterior power outlet
• Exterior plumbing tap
• Gas outlet
• Meter box
• Wall-mounted service box
• Exterior conduit entry point

These must remain present in the AFTER image.

Removal, relocation, resizing, or wall patching over these fixtures
is a structural violation.

If removed:
category: structure
violationType: wall_change
hardFail: true

2️⃣ OPENINGS & FUNCTIONAL ACCESS (CRITICAL)

All doors, windows, and pass-through openings must:

Exist in the same locations

Remain fully visible

Remain functional and unobstructed

FAIL if:

• A doorway is walled over
• A door is replaced with solid wall
• A pass-through becomes a closed surface
• Furniture permanently blocks a doorway
• Walkways between rooms are obstructed

If the opening still exists but is partially hidden by angle or perspective, verify carefully before failing.

If clearly sealed or removed → hardFail true.

NEW OPENING HALLUCINATION CHECK (CRITICAL)

If a new doorway/window/opening appears in AFTER that was not clearly visible in BEFORE:

→ category: structure
→ violationType: opening_change
→ hardFail: true

Do not classify this as style_only.

PARTIAL FRAME COMPLETION CHECK (CRITICAL)

Hard fail if AFTER completes or extends opening/frame geometry not clearly visible in BEFORE, including:

• completed door/window frames from partial edges
• extended jambs or inferred recess boundaries
• inferred frame completion beyond visible evidence

If this occurs:

→ category: structure
→ violationType: opening_change
→ hardFail: true

${isFullStaging ? `OCCLUSION PRESERVATION CHECK (CRITICAL)

Structural visibility must remain consistent with BEFORE.

If a structural surface was partially obscured (e.g., by curtains, blinds, or soft furnishings),
AFTER must not:

• Remove occluding elements to reveal new wall area
• Reveal previously unseen structural boundaries
• Reveal new opening geometry
• Extend visible wall envelope beyond what was visible in BEFORE

Hard fail if newly visible wall or opening geometry appears that was not clearly visible in BEFORE.

If detected:

category: structure
violationType: layout_change
hardFail: true
` : ""}

${isFullStaging ? `3️⃣ BUILT-IN / STRUCTURAL ANCHORS

These are considered structural anchors:

Kitchen islands (fixed cabinetry)

Built-in wardrobes

Fixed vanities

Fixed joinery

Fireplaces

Staircases

HVAC built-ins

Permanent cabinetry

FAIL if:

• A kitchen island changes size, shape, or position
• Built-in cabinetry is extended, reduced, or relocated
• A fixed vanity or wardrobe changes form
• A fireplace is altered or removed

Bar stools or decor do NOT justify island resizing.

If island geometry changes → structural violation.

BUILT-IN FOOTPRINT & SILHOUETTE LOCK (CRITICAL)

Built-in anchors must preserve their exact footprint and silhouette envelope.

This includes:

• Edge boundary alignment
• Countertop length
• Cabinet depth
• Island footprint dimensions
• Joinery termination points

Hard fail if:

• A kitchen island footprint expands or contracts
• Counter length increases or decreases
• Cabinet edges extend into new floor area
• Built-in geometry encloses open-plan space
• Silhouette envelope changes even if material appears similar

This includes subtle expansion or perspective-adjusted enlargement.

If detected:

category: structure
violationType: anchor_change
hardFail: true` : refreshBuiltInSection}

${isFullStaging ? `4️⃣ MATERIAL & SURFACE PRESERVATION

Surfaces must preserve material identity:

Floor material (timber, tile, carpet)

Wall finish

Ceiling finish

Cabinet material (unless refresh mode explicitly allows)

FAIL if:

• Flooring changes material
• Walls are repainted to cover structure
• Cabinet material shifts without refresh mode
• Textures are altered to conceal structural edits

Lighting brightness or white balance changes are acceptable.` : refreshMaterialSection}

5️⃣ STAGING LOGIC (NON-STRUCTURAL)

Staging is allowed ONLY if structure is preserved.

Check:

• Furniture scale appropriate
• Circulation paths remain clear
• No furniture blocks door swings
• Dual-room staging respects functional zones
• Dining tables not placed randomly in kitchen workspace
• Bar stools only allowed if refresh mode explicitly permits

If furniture placement blocks access or creates structural illusion → treat as opening_blocked.

VISUAL AUTHORITY RULE

Image comparison is primary authority.

Do NOT rely solely on advisory signals.

Even if local validators show drift, you must visually confirm structural presence.

If you clearly see structural alteration → hardFail true.

PERSPECTIVE TOLERANCE

Minor angle distortion is acceptable.

Only fail if you are visually confident a structural element has changed form or location.

OUTPUT FORMAT

Return:

{
  category: "structure" | "staging" | "style_only",
  violationType: "opening_change" | "wall_change" | "layout_change" | "anchor_change" | "material_change" | null,
  hardFail: true | false,
  confidence: 0.0–1.0,
  reasoning: "Clear explanation referencing visual evidence."
}

HARD FAIL RULE

If any structural rule (Sections 1–4) fails:

hardFail MUST be true.

Do not downgrade structural violations to style_only.

Do not reinterpret anchor resizing as furniture change.

IMPORTANT

Do NOT assume structure was validated earlier.

You are responsible for confirming structural integrity.`;
  }

  const stageLabel = stage === "1A" ? "Stage 1A (color/cleanup)" : stage;
  const sceneLabel = scene === "exterior" ? "EXTERIOR" : "INTERIOR";

  return `You are a Structural Integrity Auditor for New Zealand real estate imagery.

You will receive two images:
- BEFORE (original image)
- AFTER (processed / staged image)

Your sole task is to determine whether the AFTER image violates structural or functional integrity when compared to the BEFORE image.

Return JSON only. Do NOT include any prose outside JSON.

────────────────────────────────
DECISION PRIORITY HIERARCHY
────────────────────────────────
When evaluating the AFTER image, apply rules in this strict order:

1. STRUCTURAL ANCHORS — Kitchen islands, counter runs, built-in cabinetry,
   plumbing fixtures, HVAC, fixed lighting. If ANY anchor is removed,
   relocated, resized, reshaped, or replaced → structure, hardFail: true.
   This takes ABSOLUTE PRIORITY over all other rules.

2. OPENINGS & ACCESS — Doors, windows, pass-throughs must remain functional.
   Blocked or sealed → opening_blocked, hardFail: true.

3. MATERIAL & SURFACE — Floors, walls, ceilings must retain original
   material, color, and finish. Changes → structure, hardFail: true.

4. CURTAIN & FLOOR LOCK — Window coverings and floor color/material must
   match the BEFORE image exactly. Changes → structure, hardFail: true.

5. STAGING / FURNITURE — Furniture placement, style, and completeness.
   Furniture rules may NEVER override rules 1–4 above.

If a lower-priority rule conflicts with a higher-priority rule,
the higher-priority rule ALWAYS wins.

────────────────────────────────
PERSPECTIVE & VISIBILITY TOLERANCE — OPENINGS
────────────────────────────────
Do not classify a window or opening as structurally modified if the
difference is caused by:
• Perspective correction
• Vertical line straightening
• Minor camera geometry normalization
• Small crop or framing shift
• Slightly increased or decreased visible window area

These are considered camera or lens corrections, not architectural changes.

Only flag a structural violation if the window or opening itself has been:
✗ Moved to a new wall position
✗ Removed entirely
✗ Newly created
✗ Shape changed
✗ Proportionally resized relative to wall structure

A change in how much of the window is visible is NOT a structural modification.

────────────────────────────────
ANCHOR RELOCATION RULE
────────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not staging.
→ category: structure, hardFail: true

Anchors are physically fixed to the building. They cannot move.
Any positional shift — even if the element looks identical — is a failure.

────────────────────────────────
BUILT-IN vs MOVABLE DISAMBIGUATION (STRICT)
────────────────────────────────
Only classify an object as BUILT-IN if it meets at least TWO physical criteria.

BUILT-IN OBJECT = MUST meet >= 2:
• Physically continuous with wall surface
• No visible rear gap
• No visible legs or movable base
• Extends from floor to wall or wall to ceiling
• Shares material + finish with wall cabinetry
• Enclosed in recess or alcove
• Part of a continuous cabinetry run
• Cannot be moved without tools or demolition

MOVABLE OBJECT = ANY object with:
• Legs
• Visible rear gap
• Shadow gap behind
• Separate base
• Freestanding footprint
• Visible floor clearance

Set builtInDetected = true only if structuralAnchorCount >= 2.
structuralAnchorCount = number of built-in criteria matched.
Only block for built-in violations when builtInDetected == true AND structuralAnchorCount >= 2.

Desk + shelving units with legs or visible floor clearance MUST be treated as movable furniture — not built-in — even if positioned against a wall.

If uncertain, treat as MOVABLE (do NOT elevate to built-in without evidence).

────────────────────────────────
STRUCTURAL BUILT-IN CLASSIFICATION — STRICT DEFINITION
────────────────────────────────
Only classify an object as a structural built-in if it is permanently
integrated into the architecture and would require construction work to remove.

TRUE structural built-ins include:
• Kitchen cabinetry fixed to walls
• Kitchen counters and islands
• Bathroom vanities connected to plumbing
• Recessed built-in wardrobes
• Fixed wall cabinetry
• Fireplaces
• Staircases
• Permanently installed window seating
• Architectural millwork fixed into walls

The following are NOT structural built-ins and must NOT trigger
structural violation failures:
✗ Desks
✗ Freestanding shelving units
✗ Bookcases
✗ Dressers
✗ Tallboys
✗ Sideboards
✗ Staging wardrobes
✗ Modular storage systems
✗ Removable shelving
✗ Office furniture
✗ Nightstands
✗ Staging cabinets

Desks and shelving units must be treated as movable furniture unless
clearly recessed into wall structure.

Never classify freestanding desks or shelving as structural built-ins.

────────────────────────────────
STAGING CONTEXT OVERRIDE RULE
────────────────────────────────
If furniture appears newly added, replaced, refreshed, or staged as part
of the enhancement process, it must be treated as movable staging furniture
— not as a structural built-in — even if it visually aligns with walls.

Staged furniture must not trigger structural violation blocks.

────────────────────────────────
CORE PRINCIPLE
────────────────────────────────

You must verify that FIXED ARCHITECTURE in the AFTER image remains
geometrically, materially, and functionally identical to the BEFORE image.

Movable furniture and décor may change unless they block access or appear permanently fixed.

────────────────────────────────
PHASE 1: GEOMETRIC & COUNT VERIFICATION (CRITICAL)
────────────────────────────────

1. OPENING COUNT
Count all windows, doors, and pass-through openings in BOTH images.

If the number of openings changes (added or removed):
→ category = structure
→ hardFail = true

2. EDGE & GEOMETRIC ALIGNMENT
Check fixed vertical and horizontal edges:
- Walls
- Door frames
- Window frames
- Major openings

If edges are shifted, resized, warped, slanted, or spatially moved:
→ category = structure
→ hardFail = true

Minor lens correction or perspective straightening is acceptable.

3. MATERIAL CONSISTENCY
Check fixed finishes:
- Floors
- Walls
- Ceilings

If a fixed material changes (e.g., carpet → timber, painted wall removed):
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 2: FUNCTIONAL ACCESS & BLOCKAGE (CRITICAL)
────────────────────────────────

DOORS:
- Must remain realistically passable
- Furniture must not barricade doorways
- Swinging doors must appear able to open
- Sliding doors must retain a usable sliding path

If a door exists but is not realistically usable:
→ category = opening_blocked
→ hardFail = true

WINDOWS:
- Partial visual occlusion by movable furniture is acceptable
- The window must still clearly exist as a window
- Objects must NOT appear permanently fixed to window panes or frames

If a window is fully sealed, replaced, or functionally removed:
→ category = structure OR opening_blocked
→ hardFail = true

────────────────────────────────
PHASE 3: IMPROPER FIXATION (ALWAYS FAILURE)
────────────────────────────────

Treat as STRUCTURAL FAILURE if any movable item appears:
- Permanently attached to a wall, window, door, or opening
- Used to cover, replace, or seal a structural element

Examples (non-exhaustive):
- Artwork or mirrors mounted over doors or windows
- Objects visually replacing glazing
- Panels fixed across openings

If improper fixation is detected:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 4: STRUCTURAL ANCHORS (HIGH-RISK ELEMENTS)
────────────────────────────────

The following elements must be treated as FIXED unless clearly movable:
- Window coverings defining openness (curtains, blinds, rods, tracks)
- Built-in wardrobes or shelving
- Heat pumps / wall-mounted HVAC units
- Fixed lighting and wall-mounted fixtures

If these are removed, relocated, or materially altered:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 5: FALSE POSITIVE FILTER
────────────────────────────────

DO NOT flag the following as failures:
- Exposure, brightness, colour, or white balance changes
- Virtual staging furniture changes alone
- Minor perspective correction
- Partial visual occlusion by movable furniture that does not block access

────────────────────────────────
CATEGORIES (SELECT ONE)
────────────────────────────────

structure:
- Fixed architecture changed, resized, added, removed, warped
- Openings added/removed
- Structural anchors altered
- Room geometry or proportions manipulated

opening_blocked:
- Doors or windows exist but are functionally unusable
- Circulation paths fully blocked

furniture_change:
- Movable furniture or décor added, removed, or repositioned only

style_only:
- Lighting, exposure, or colour changes only

unknown:
- Insufficient information to decide confidently

────────────────────────────────
CATEGORY PRIORITY
────────────────────────────────

1. structure
2. opening_blocked
3. furniture_change
4. style_only
5. unknown

If fixation or loss of function is involved:
→ NEVER downgrade to furniture_change

────────────────────────────────
DECISION RULES
────────────────────────────────

structure → hardFail = true  
opening_blocked → hardFail = true  
furniture_change → hardFail = false  
style_only → hardFail = false  
If confidence < ${MIN_CONFIDENCE} → hardFail = false  
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85) → hardFail = false  

VIOLATION TYPE (REQUIRED)
Choose exactly one:
- opening_change = window/door/opening added/removed/moved
- wall_change = wall added/removed/shifted
- camera_shift = viewpoint or perspective changed
- built_in_moved = built-in cabinetry or anchored fixture changed
- layout_only = furniture/layout/staging only
- other = none of the above

────────────────────────────────
OUTPUT FORMAT (JSON ONLY)
────────────────────────────────
Return JSON only. Include builtInDetected and structuralAnchorCount.
structuralAnchorCount = number of built-in criteria matched (0-8).
{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": [
    "Concise, specific reasons such as 'Window count changed from 2 to 1'",
    "or 'Doorway blocked by fixed wardrobe'"
  ],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}

Stage: ${stageLabel}
Scene: ${sceneLabel}`;
}

export function parseGeminiSemanticText(text: string): GeminiSemanticVerdict {
  const fallback: GeminiSemanticVerdict = {
    hardFail: false,
    category: "unknown",
    reasons: [],
    confidence: 0,
    violationType: "other",
    builtInDetected: false,
    structuralAnchorCount: 0,
    rawText: text,
  };

  if (!text) return fallback;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const target = jsonMatch ? jsonMatch[0] : text;

  try {
    const parsed = JSON.parse(target);
    const violationType = typeof parsed.violationType === "string"
      ? parsed.violationType.toLowerCase()
      : "other";
    const normalizedViolationType = (
      violationType === "opening_change" ||
      violationType === "wall_change" ||
      violationType === "camera_shift" ||
      violationType === "built_in_moved" ||
      violationType === "layout_only" ||
      violationType === "other"
    ) ? (violationType as GeminiSemanticVerdict["violationType"]) : "other";
    return {
      hardFail: Boolean(parsed.hardFail),
      category: parsed.category || "unknown",
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      violationType: normalizedViolationType,
      builtInDetected: Boolean(parsed.builtInDetected),
      structuralAnchorCount: typeof parsed.structuralAnchorCount === "number"
        ? Math.max(0, Math.floor(parsed.structuralAnchorCount))
        : 0,
      rawText: text,
    };
  } catch (err) {
    return fallback;
  }
}

export async function runGeminiSemanticValidator(opts: {
  basePath: string;
  candidatePath: string;
  stage: "1A" | "1B" | "2";
  sceneType?: string;
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
  validationMode?: Stage2ValidationMode;
  stage1BValidationMode?: Stage1BValidationMode;
  promptOverride?: string;
  evidence?: ValidationEvidence;
  riskLevel?: RiskLevel;
}): Promise<GeminiSemanticVerdict> {
  const ai = getGeminiClient();
  const before = toBase64(opts.basePath).data;
  const after = toBase64(opts.candidatePath).data;

  // Build base prompt, then inject evidence signals
  if (opts.stage === "1B") {
    logger.info("Stage1B validator mode", { mode: opts.stage1BValidationMode || "LIGHT_DECLUTTER" });
  }
  const basePrompt = opts.promptOverride || buildPrompt(opts.stage, opts.sceneType, opts.sourceStage, opts.validationMode, opts.stage1BValidationMode);
  if (opts.stage === "2" && opts.validationMode) {
    logger.info("Stage2 validator mode", { validationMode: opts.validationMode });
  }
  const prompt = buildAdjudicatorPrompt(basePrompt, opts.evidence, opts.riskLevel);

  // Model routing: LOW risk → fast, MEDIUM/HIGH → strong
  const model = getModelForRisk(opts.riskLevel);

  const contents = [
    { role: "user", parts: [{ text: prompt }] },
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/webp", data: before } },
        { inlineData: { mimeType: "image/webp", data: after } },
      ],
    },
  ];

  try {
    const start = Date.now();
    const response = await (ai as any).models.generateContent({
      model,
      contents,
      generationConfig: {
        temperature: 0.2,
        topP: 0.5,
        maxOutputTokens: 512,
      },
    } as any);

    const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
    const text = textParts.map((p: any) => p?.text || "").join(" ").trim();
    const parsed = parseGeminiSemanticText(text);
    parsed.rawText = text;

    const lowConfidence = !Number.isFinite(parsed.confidence) || parsed.confidence < MIN_CONFIDENCE;
    const category = parsed.category as GeminiSemanticVerdict["category"];
    const builtInDetected = parsed.builtInDetected === true;
    const structuralAnchorCount = typeof parsed.structuralAnchorCount === "number"
      ? parsed.structuralAnchorCount
      : 0;
    const builtInLowConfidence = builtInDetected && parsed.confidence < BUILTIN_HARDFAIL_CONFIDENCE;
    const violationType = parsed.violationType || "other";
    const builtInDowngradeAllowed = isBuiltInDowngradeAllowed({
      violationType,
      builtInDetected,
      structuralAnchorCount,
      confidence: parsed.confidence,
    });

    const reasonText = (parsed.reasons || []).join(" ").toLowerCase();
    const boundaryAdjacentFurnitureCue = [
      "window frame",
      "sliding door",
      "visible seam",
      "door frame seam",
      "wall seam",
      "boundary",
      "occluded",
      "partially occluded",
      "frame edge",
      "glass panel edge",
    ].some((token) => reasonText.includes(token));
    const alwaysHardFail = violationType === "opening_change" ||
      violationType === "wall_change" ||
      violationType === "camera_shift" ||
      [
        "window count",
        "door count",
        "opening count",
        "new opening",
        "added opening",
        "removed opening",
        "opening removed",
        "opening added",
        "new window",
        "removed window",
        "new door",
        "removed door",
        "camera viewpoint",
        "camera angle",
        "perspective shift",
        "viewpoint shift",
        "wall removed",
        "wall removal",
        "wall added",
        "wall addition",
        "wall deleted",
      ].some((token) => reasonText.includes(token));

    const structuredRetainFurnitureDowngrade =
      opts.stage === "1B" &&
      opts.stage1BValidationMode === "STRUCTURED_RETAIN" &&
      boundaryAdjacentFurnitureCue &&
      (category === "furniture_change" || (category === "structure" && (violationType === "layout_only" || violationType === "other"))) &&
      !alwaysHardFail;

    let hardFail = parsed.hardFail;
    if (category === "structure") {
      const builtInViolation = violationType === "built_in_moved" || builtInDetected;
      const builtInHardFail = builtInViolation && structuralAnchorCount >= 2 && parsed.confidence >= BUILTIN_HARDFAIL_CONFIDENCE;
      hardFail = opts.stage === "2" ? true : (alwaysHardFail || builtInHardFail);
    }
    else if (category === "opening_blocked") hardFail = parsed.hardFail;
    else if (category === "furniture_change" || category === "style_only") hardFail = false;

    if (opts.stage === "2" && category === "structure") {
      if (builtInDowngradeAllowed) {
        hardFail = false;
      } else {
        hardFail = true;
        console.log("[STRUCTURAL_ENFORCEMENT_APPLIED] stage=2 cat=structure forcedHardFail=true");
      }
    } else {
      if (lowConfidence) hardFail = false;
      if (builtInDetected && structuralAnchorCount < 2) hardFail = false;
      if (builtInLowConfidence) hardFail = false;
      if (structuredRetainFurnitureDowngrade) hardFail = false;
    }

    const verdict: GeminiSemanticVerdict = {
      hardFail,
      category,
      reasons: parsed.reasons || [],
      confidence: parsed.confidence ?? 0,
      violationType,
      builtInDetected,
      structuralAnchorCount,
      rawText: text,
    };

    const ms = Date.now() - start;
    console.log(`[gemini-semantic] completed in ${ms}ms model=${model} risk=${opts.riskLevel || "N/A"} (hardFail=${verdict.hardFail} conf=${verdict.confidence} cat=${verdict.category})`);
    return verdict;
  } catch (err: any) {
    console.warn("[gemini-semantic] error (fail-open):", err?.message || err);
    return {
      hardFail: false,
      category: "unknown",
      confidence: 0,
      reasons: ["gemini_error"],
      rawText: err?.message,
    };
  }
}

export function buildStage2ContextHeader(mode: Stage2ValidationMode): string {
  if (mode === "FULL_STAGE_ONLY") {
    return `STAGE2 VALIDATION CONTEXT
- Mode: FULL_STAGE_ONLY
- BEFORE is a stage-only baseline (typically empty input from user).
- AFTER should introduce suitable staged furniture while preserving all fixed architecture.`;
  }

  return `STAGE2 VALIDATION CONTEXT
- Mode: REFRESH_OR_DIRECT
- BEFORE is a structured-retain or light-declutter baseline.
- AFTER may augment furniture/decor while preserving fixed architecture and anchor geometry.`;
}
