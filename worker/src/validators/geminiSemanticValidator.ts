import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import type { ValidationEvidence, RiskLevel } from "./validationEvidence";
import { shouldInjectEvidence } from "./validationEvidence";

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
  if (!shouldInjectEvidence(evidence)) {
    logger.info("[VALIDATION_EVIDENCE] skipped_below_threshold", {
      stage: evidence.stage,
      jobId: evidence.jobId,
    });
    return basePrompt;
  }

  const windowsDelta = evidence.openings.windowsAfter - evidence.openings.windowsBefore;
  const doorsDelta = evidence.openings.doorsAfter - evidence.openings.doorsBefore;

  const anchorFlags = [
    evidence.anchorChecks.islandChanged ? "ISLAND_CHANGED" : null,
    evidence.anchorChecks.hvacChanged ? "HVAC_CHANGED" : null,
    evidence.anchorChecks.cabinetryChanged ? "CABINETRY_CHANGED" : null,
    evidence.anchorChecks.lightingChanged ? "LIGHTING_CHANGED" : null,
  ].filter(Boolean).slice(0, 3);

  const limitedLocalFlags = evidence.localFlags.slice(0, 3);

  const localSignals = {
    wallDriftPct: Number(evidence.drift.wallPercent.toFixed(1)),
    maskedDriftPct: Number(evidence.drift.maskedEdgePercent.toFixed(1)),
    openingDelta: {
      windows: windowsDelta,
      doors: doorsDelta,
    },
    lineDeviationDeg: Number(evidence.drift.angleDegrees.toFixed(1)),
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

SSIM: ${evidence.ssim.toFixed(4)} (threshold: ${evidence.ssimThreshold}, ${evidence.ssimPassed ? "OK" : "LOW"})
Risk Level: ${riskLevel || "UNKNOWN"}
Geometry Profile: ${evidence.geometryProfile}

Openings Delta:
- Windows: ${evidence.openings.windowsBefore} → ${evidence.openings.windowsAfter} (delta: ${windowsDelta >= 0 ? "+" : ""}${windowsDelta})
- Doors: ${evidence.openings.doorsBefore} → ${evidence.openings.doorsAfter} (delta: ${doorsDelta >= 0 ? "+" : ""}${doorsDelta})

Drift Metrics:
- Wall drift: ${(evidence.drift.wallPercent).toFixed(1)}%
- Masked edge drift: ${(evidence.drift.maskedEdgePercent).toFixed(1)}%
- Angle deviation: ${evidence.drift.angleDegrees.toFixed(1)}°

Anchor Region Flags: ${anchorFlags.length > 0 ? anchorFlags.join(", ") : "NONE"}

Local Validator Flags: ${limitedLocalFlags.length > 0 ? limitedLocalFlags.join("; ") : "NONE"}

LOCAL VALIDATOR SIGNALS (JSON):
${JSON.stringify(localSignals, null, 2)}

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
` : "";

  logger.info("[VALIDATION_EVIDENCE] injected", {
    stage: evidence.stage,
    jobId: evidence.jobId,
  });

  return basePrompt + signalBlock + overrideBlock;
}

export type GeminiSemanticVerdict = {
  hardFail: boolean;
  category: "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown";
  reasons: string[];
  confidence: number;
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

4. WINDOW COVERING STRUCTURE RULE + FLOOR LOCK — Rails/tracks and blinds are
  structural anchors; if added/removed/repositioned → structure, hardFail: true.
  Curtain fabric may change only when rails/tracks already exist.
  Floor color/material must match.

5. STAGING / FURNITURE — Furniture placement, style, and completeness.
   Furniture rules may NEVER override rules 1–4 above.

If a lower-priority rule conflicts with a higher-priority rule,
the higher-priority rule ALWAYS wins.

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
BUILT-IN vs MOVABLE DISAMBIGUATION
─────────────────────────────
Before classifying any element as "movable furniture":

CHECK: Is this element a built-in or structural anchor?

BUILT-IN indicators (treat as STRUCTURAL):
• Connected to walls, floor, or ceiling with fixed joinery
• Has plumbing, electrical, or ventilation connections
• Kitchen islands, counter runs, vanities with plumbing
• Wardrobes built into alcoves or walls
• Shelving integrated into wall framing

MOVABLE indicators (treat as FURNITURE):
• Freestanding with visible floor gap
• No utility connections
• Can be lifted and carried out
• Standalone chairs, tables, sofas, beds, rugs

When in doubt, treat as BUILT-IN and protect it.
DO NOT classify built-in elements as furniture to justify their removal.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered in any way:
- Walls, ceilings, floors, baseboards
- Windows, doors, sliding doors, frames
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, vanities, splashbacks, rangehoods
- Fixed lighting (pendants, downlights, track lights, ceiling roses, sconces)
- Electrical outlets, switches
- Heat pumps, radiators, vents, HRV/DVS systems
- Smoke detectors, sprinklers, alarms
- Plumbing fixtures (toilets, baths, showers, sinks, tapware)
- Exterior views through windows

ANY modification → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────

1. STRUCTURAL PRESERVATION
- Confirm all ZERO-TOUCH elements are present, aligned, and unchanged.
- Warping, removal, distortion, recoloring, or hallucination → structure, hardFail: true

🔒 ADD — STRUCTURAL FUNCTION ANCHOR LOCK
ADDITIONAL STRUCTURAL FUNCTION ANCHORS — HARD LOCK
The following elements are FUNCTIONAL STRUCTURAL ANCHORS. If present, they MUST remain visually and geometrically identical. NEVER clutter/staging targets, NEVER replaceable.
- Kitchen islands, fixed counter runs, benchtops, breakfast bars
- Upper/lower cabinets, pantry cabinets, splashbacks
- Built-in ovens, cooktops, range hoods, integrated dishwashers
- Sink/faucet zones, appliance cavities/surrounds
- Toilets, vanities, fixed mirrors, shower enclosures/glass, bathtubs
- Built-in vanity cabinetry, wall-mounted towel rails, extractor fans
- Heat pumps/split units, radiators/heaters, air vents/grilles, ceiling cassettes
- Pendant lights, downlights, ceiling/track lights, wall sconces, ceiling fans with lights
- Windows and frames, sliding door tracks, bi-fold doors, skylights, internal glass walls
If removal/declutter would require changing ANY of the above:
→ DO NOT modify the element; reduce removal actions instead

🪟 WINDOW COVERING STRUCTURE RULE
- Curtain rails, rods, and tracks are structural anchors. Must NOT be added, removed, or repositioned.
- If rails/tracks exist, curtain fabric may change.
- If rails/tracks do NOT exist, adding curtains/drapes is a STRUCTURAL violation.
- Blinds must NOT be added, removed, or replaced with a different covering type.

FLOOR COLOR/MATERIAL LOCK
- Floor material AND FLOOR COLOR; carpet color/texture; timber tone/stain; tile color must match.

Any violation → structure, hardFail: true.

5. SOFT FIXED ELEMENTS (STRICT)
- Curtains, curtain rails, blinds must match BEFORE image
- Pendant lights and ceiling fixtures must match BEFORE image
- Carpet and floor color/material must match BEFORE image
If any change is detected → category: structure, hardFail: true

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

ADDITIONAL HARD FAIL TRIGGERS
- Pendant or fixed lighting fixture changed
- Curtain system or rails changed
- Blind system changed
- Carpet color changed
- Timber floor tone changed
- Kitchen island removed or altered
- Counter runs removed or altered
- Built-in cabinetry altered

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (FAIL if incomplete removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

─────────────────────────────
OUTPUT JSON
─────────────────────────────
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number
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

4. WINDOW COVERING STRUCTURE RULE + FLOOR LOCK — Rails/tracks and blinds are
  structural anchors; if added/removed/repositioned → structure, hardFail: true.
  Curtain fabric may change only when rails/tracks already exist.
  Floor color/material must match.

5. STAGING / FURNITURE — Furniture placement, style, and completeness.
   Furniture rules may NEVER override rules 1–4 above.

If a lower-priority rule conflicts with a higher-priority rule,
the higher-priority rule ALWAYS wins.

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
BUILT-IN vs MOVABLE DISAMBIGUATION
─────────────────────────────
Before classifying any element as "movable furniture":

CHECK: Is this element a built-in or structural anchor?

BUILT-IN indicators (treat as STRUCTURAL):
• Connected to walls, floor, or ceiling with fixed joinery
• Has plumbing, electrical, or ventilation connections
• Kitchen islands, counter runs, vanities with plumbing
• Wardrobes built into alcoves or walls
• Shelving integrated into wall framing

MOVABLE indicators (treat as FURNITURE):
• Freestanding with visible floor gap
• No utility connections
• Can be lifted and carried out
• Standalone chairs, tables, sofas, beds, rugs

When in doubt, treat as BUILT-IN and protect it.
DO NOT classify built-in elements as furniture to justify their removal.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, islands, vanities, splashbacks, rangehoods
- Fixed lighting (pendants, downlights, track lighting, sconces)
- Electrical switches and outlets
- Heat pumps, vents, radiators, HVAC units
- Smoke detectors, sprinklers, alarms
- Plumbing fixtures
- Exterior views through windows (must remain consistent)

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
• Curtain rails, blinds, rods, tracks
• Fireplaces
• Staircases
• Built-in shelving

Removed, replaced, relocated, or altered → structure hardFail true

🪟 WINDOW COVERING STRUCTURE RULE
• Curtain rails, rods, and tracks are structural anchors. Must NOT be added, removed, or repositioned.
• If rails/tracks exist, curtain fabric may change.
• If rails/tracks do NOT exist, adding curtains/drapes is a STRUCTURAL violation.
• Blinds must NOT be added, removed, or replaced with a different covering type.

FLOOR COLOR/MATERIAL LOCK
• Floor material AND color must match
• Carpet color must match
• No floor recoloring allowed

Any violation → structure hardFail true

LIGHTING FIXTURE STYLE LOCK
Existing fixed lighting fixtures must remain identical in style, shape, size, position, mounting type.
Do NOT modernize, replace, redesign, restyle, or simplify:
• Pendant lights
• Ceiling fixtures
• Downlight layouts
• Track systems
• Wall sconces
Lighting fixtures are structural anchors, not decor.

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

ADDITIONAL HARD FAIL TRIGGERS
- Pendant or fixed lighting fixture changed
- Curtain system or rails changed
- Blind system changed
- Carpet color changed
- Timber floor tone changed
- Kitchen island removed or altered
- Counter runs removed or altered
- Built-in cabinetry altered

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (FAIL if refresh incomplete)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

─────────────────────────────
OUTPUT JSON
─────────────────────────────
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": [string],
  "confidence": number
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
BUILT-IN vs MOVABLE DISAMBIGUATION
────────────────────────────────
Before classifying any element as "movable furniture":

CHECK: Is this element a built-in or structural anchor?

BUILT-IN indicators (treat as STRUCTURAL):
• Connected to walls, floor, or ceiling with fixed joinery
• Has plumbing, electrical, or ventilation connections
• Kitchen islands, counter runs, vanities with plumbing
• Wardrobes built into alcoves or walls
• Shelving integrated into wall framing

MOVABLE indicators (treat as FURNITURE):
• Freestanding with visible floor gap
• No utility connections
• Can be lifted and carried out
• Standalone chairs, tables, sofas, beds, rugs

When in doubt, treat as BUILT-IN and protect it.
DO NOT classify built-in elements as furniture to justify their removal.

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

────────────────────────────────
OUTPUT FORMAT (JSON ONLY)
────────────────────────────────

{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": [
    "Concise, specific reasons such as 'Window count changed from 2 to 1'",
    "or 'Doorway blocked by fixed wardrobe'"
  ],
  "confidence": number
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

    let hardFail = parsed.hardFail;
    if (category === "structure") hardFail = true;
    else if (category === "opening_blocked") hardFail = parsed.hardFail;
    else if (category === "furniture_change" || category === "style_only") hardFail = false;

    if (lowConfidence) hardFail = false;

    const verdict: GeminiSemanticVerdict = {
      hardFail,
      category,
      reasons: parsed.reasons || [],
      confidence: parsed.confidence ?? 0,
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
