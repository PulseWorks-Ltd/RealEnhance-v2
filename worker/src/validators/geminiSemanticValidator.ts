import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import type { ValidationEvidence, RiskLevel } from "./validationEvidence";
import { createEmptyEvidence, shouldInjectEvidence } from "./validationEvidence";
import { getEvidenceGatingVariant, isEvidenceGatingEnabledForJob } from "./evidenceGating";
import { VALIDATION_FOCUS_MODE } from "../utils/logFocus";

const logger = console;

const MIN_CONFIDENCE = 0.75;

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
Use as secondary signals only.
Visual comparison between images is primary authority.
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
  builtInDetected?: boolean;
  structuralAnchorCount?: number;
  rawText?: string;
};

function buildPrompt(
  stage: "1A" | "1B" | "2",
  scene?: string,
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready"
) {
  if (stage === "1B") {
    return `You are a Structural Integrity & Quality Auditor for New Zealand real estate imagery (Stage 1B: Declutter / Removal).

Compare BEFORE and AFTER images.

Return JSON only. No prose outside JSON.

─────────────────────────────
DECISION PRIORITY HIERARCHY
─────────────────────────────
When evaluating the AFTER image, apply rules in this strict order:

1. STRUCTURAL ANCHORS — Kitchen islands, counter runs, built-in cabinetry,
   plumbing fixtures, HVAC, fixed lighting. If ANY anchor is removed,
   relocated, resized, reshaped, or replaced → structure, hardFail: true.
   This takes ABSOLUTE PRIORITY over all other rules.

2. OPENINGS & ACCESS — Doors, windows, pass-throughs must remain functional.
   Blocked or sealed → opening_blocked, hardFail: true.

3. MATERIAL & SURFACE — Floors, walls, ceilings must retain original
   material, color, and finish. Changes → structure, hardFail: true.

4. WINDOW COVERING STRUCTURE RULE + FLOOR LOCK — Rails, rods, tracks, and blind
  SYSTEMS are structural. Fabric/color changes on existing rails → style_only (PASS).
  Adding/removing rails, tracks, or blind systems → structure, hardFail: true.
  Floor color/material must match.

5. STAGING / FURNITURE — Furniture placement, style, and completeness.
   Furniture rules may NEVER override rules 1–4 above.

If a lower-priority rule conflicts with a higher-priority rule,
the higher-priority rule ALWAYS wins.

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

─────────────────────────────
ANCHOR RELOCATION RULE
─────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not staging.
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
STAGING CONTEXT OVERRIDE RULE
─────────────────────────────
If furniture appears newly added, replaced, refreshed, or staged as part
of the enhancement process, it must be treated as movable staging furniture
— not as a structural built-in — even if it visually aligns with walls.

Staged furniture must not trigger structural violation blocks.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered in any way:
- Walls, ceilings, floors, baseboards
- Windows, doors, sliding doors, frames
- Built-in cabinetry, wardrobes, shelving
- Kitchen islands, counters, vanities, splashbacks
- Fixed lighting (pendants, downlights, sconces)
- Heat pumps, radiators, vents
- Plumbing fixtures
- Exterior views through windows

ANY modification → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────

1. STRUCTURAL PRESERVATION
- Confirm all ZERO-TOUCH elements are present, aligned, and unchanged.
- Warping, removal, distortion, recoloring, or hallucination → structure, hardFail: true

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
- Floor material AND FLOOR COLOR; carpet color/texture; timber tone/stain; tile color must match.

Any violation → structure, hardFail: true.

2. DECLUTTER COMPLETENESS
- ALL movable items must be removed: chairs, tables, sofas, beds, stools, loose shelving, decor, clutter, appliances.
- Partial removal (some furniture left behind) → category: furniture_change, hardFail: true

3. MATERIAL & INPAINTING QUALITY
- Floors, walls, ceilings retain original texture and continuity.
- No blur, smudge, ghost shadows, or texture mismatch.
- Damaged surfaces → category: structure, hardFail: true

4. FUNCTIONAL OPENINGS
- Doors and windows remain fully passable and unobstructed.
- Any blockage or sealing → opening_blocked, hardFail: true

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
- furniture_change (FAIL if incomplete removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

BUILT-IN DOWNGRADE RULE:
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85)
→ hardFail = false (warning only)

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
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
  }

  if (stage === "2") {
    const isFullStaging = sourceStage === "1B-stage-ready";
    const stagingModeInstruction = isFullStaging
      ? "The BEFORE image is an EMPTY/DECLUTTERED room. The AFTER image should contain NEW furniture appropriate for staging."
      : "The BEFORE image contains EXISTING furniture. The AFTER image should show ALL furniture REPLACED with modern equivalents.";
    const stagingIntentRule = isFullStaging
      ? "- FULL STAGING MODE: Empty room must now contain appropriate furniture for the room type.\n  Missing furniture in empty areas is FAILURE. Inappropriate furniture type is FAILURE."
      : "- REFRESH STAGING MODE: ALL existing furniture must be replaced with new furniture.\n  Reusing original furniture without replacement → furniture_change, hardFail: true\n  Partially replaced furniture → furniture_change, hardFail: true";

    return `You are a Structural Integrity & Quality Auditor for New Zealand real estate imagery (Stage 2: Staging / Refresh).

Compare BEFORE and AFTER images.

Return JSON only.

─────────────────────────────
DECISION PRIORITY HIERARCHY
─────────────────────────────
When evaluating the AFTER image, apply rules in this strict order:

1. STRUCTURAL ANCHORS — Kitchen islands, counter runs, built-in cabinetry,
   plumbing fixtures, HVAC, fixed lighting. If ANY anchor is removed,
   relocated, resized, reshaped, or replaced → structure, hardFail: true.
   This takes ABSOLUTE PRIORITY over all other rules.

2. OPENINGS & ACCESS — Doors, windows, pass-throughs must remain functional.
   Blocked or sealed → opening_blocked, hardFail: true.

3. MATERIAL & SURFACE — Floors, walls, ceilings must retain original
   material, color, and finish. Changes → structure, hardFail: true.

4. WINDOW COVERING STRUCTURE RULE + FLOOR LOCK — Rails, rods, tracks, and blind
  SYSTEMS are structural. Fabric/color changes on existing rails → style_only (PASS).
  Adding/removing rails, tracks, or blind systems → structure, hardFail: true.
  Floor color/material must match.

5. STAGING / FURNITURE — Furniture placement, style, and completeness.
   Furniture rules may NEVER override rules 1–4 above.

If a lower-priority rule conflicts with a higher-priority rule,
the higher-priority rule ALWAYS wins.

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

─────────────────────────────
ANCHOR RELOCATION RULE
─────────────────────────────
If a structural anchor (kitchen island, counter run, built-in wardrobe,
vanity, fixed cabinetry) appears in a DIFFERENT POSITION in the AFTER
image compared to the BEFORE image:

→ This is RELOCATION, not staging.
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
STAGING CONTEXT OVERRIDE RULE
─────────────────────────────
If furniture appears newly added, replaced, refreshed, or staged as part
of the enhancement process, it must be treated as movable staging furniture
— not as a structural built-in — even if it visually aligns with walls.

Staged furniture must not trigger structural violation blocks.

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

EXTERNAL VIEW CONSISTENCY
Window views must remain consistent.
Hallucinated scenery → structure hardFail true

2. FUNCTIONAL CIRCULATION
- Clear walk paths to doors, sliding doors, and key access points.
- Furniture blocking paths → opening_blocked, hardFail: true

3. PHYSICS & REALISM
- Furniture grounded with contact shadows.
- Reflections consistent with floor material.
- Rugs lie flat, not merged into baseboards.
- Floating/clipping furniture → furniture_change, hardFail: false

4. STAGING INTENT VALIDATION (MODE: ${isFullStaging ? 'FULL STAGING' : 'REFRESH STAGING'})
${stagingModeInstruction}
${stagingIntentRule}

─────────────────────────────
STAGING INTENT LIMITATION
─────────────────────────────
Staging intent (FULL or REFRESH) governs FURNITURE ONLY.
Staging intent NEVER overrides structural anchor protection.

Even if staging would benefit from:
• Removing a kitchen island to place a dining table
• Removing built-in shelving to create open wall space
• Relocating a vanity or counter run
• Replacing fixed lighting with modern alternatives

→ These are ALL structural violations: category: structure, hardFail: true
→ Staging must work AROUND existing anchors, not replace them.

5. MATERIAL PRESERVATION
- Floors, walls, ceilings retain original material and finish.
- Inpainting damage → structure, hardFail: true

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
- furniture_change (FAIL if refresh incomplete)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

BUILT-IN DOWNGRADE RULE:
If builtInDetected == true AND (structuralAnchorCount < 2 OR confidence < 0.85)
→ hardFail = false (warning only)

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
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
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
    builtInDetected: false,
    structuralAnchorCount: 0,
    rawText: text,
  };

  if (!text) return fallback;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const target = jsonMatch ? jsonMatch[0] : text;

  try {
    const parsed = JSON.parse(target);
    return {
      hardFail: Boolean(parsed.hardFail),
      category: parsed.category || "unknown",
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
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
  evidence?: ValidationEvidence;
  riskLevel?: RiskLevel;
}): Promise<GeminiSemanticVerdict> {
  const ai = getGeminiClient();
  const before = toBase64(opts.basePath).data;
  const after = toBase64(opts.candidatePath).data;

  // Build base prompt, then inject evidence signals
  const basePrompt = buildPrompt(opts.stage, opts.sceneType, opts.sourceStage);
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
    const builtInLowConfidence = builtInDetected && parsed.confidence < 0.85;

    let hardFail = parsed.hardFail;
    if (category === "structure") hardFail = true;
    else if (category === "opening_blocked") hardFail = parsed.hardFail;
    else if (category === "furniture_change" || category === "style_only") hardFail = false;

    if (lowConfidence) hardFail = false;
    if (builtInDetected && structuralAnchorCount < 2) hardFail = false;
    if (builtInLowConfidence) hardFail = false;

    const verdict: GeminiSemanticVerdict = {
      hardFail,
      category,
      reasons: parsed.reasons || [],
      confidence: parsed.confidence ?? 0,
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
