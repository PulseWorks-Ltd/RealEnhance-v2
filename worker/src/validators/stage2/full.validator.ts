import type { Stage2ValidationMode } from "../stage2ValidationMode";

export function validateStage2Full(validationMode?: Stage2ValidationMode): string {
  const isFromEmpty = validationMode === "FULL_STAGE_ONLY";

  const fromEmptyFrameContinuityRule = isFromEmpty
    ? `

FROM-EMPTY FRAME CONTINUITY RULE (ACTIVE — BASELINE IS AN EMPTY ROOM)
In this mode, the BEFORE image has no furniture. Therefore:
- Furniture occlusion of an opening is valid ONLY if the opening's frame, sill, header, or edge remains partially visible around the furniture.
- If the entire opening boundary is invisible and replaced by continuous wall surface, classify as REMOVED even if furniture is present in the region.`
    : "";

  return `ROLE
You are the Stage 2 Final Authority Validator.

TENANT TRUTH PRINCIPLE (MANDATORY)
The result must not mislead a tenant about what exists in the property and cannot be easily changed.

MODE
FULL_STAGE_ONLY

MANDATORY DECISION PIPELINE (NO SHORTCUTS)
1) Detect any change.
2) Classify each change into exactly one tier.
3) Decide only from tier classification.

TIER CLASSIFICATION (MANDATORY)
Tier 1 — STRUCTURAL (hard fail if changed)
- walls
- doors
- window openings (not coverings)
- room envelope
- camera viewpoint

PERSPECTIVE TOLERANCE (MANDATORY)
Minor geometric drift (up to ~20% of an opening's visible area) is allowed
when caused by lens distortion, crop shift, or perspective normalization.
Beyond 20%, or if an opening's identity changes (type, count, or existence),
classify as Tier 1 structural violation regardless of magnitude.

Tier 2 — FIXED FEATURES (hard fail if changed or replaced)
- pendant lights
- ceiling fans
- main ceiling fixtures
- HVAC units
- built-in cabinetry
- kitchen islands
- sinks, basins, taps
- window treatment TYPE (curtains vs blinds)

DETERMINISTIC MAPPING (NO AMBIGUITY)
- The above Tier 2 items are always FIXED FEATURES.
- Never classify any listed Tier 2 item as FLEXIBLE.
- If any listed Tier 2 item is visibly changed/replaced/removed, return hardFail=true.

Window treatment TYPE rule:
- curtain -> curtain: allowed
- blinds -> blinds: allowed
- blinds -> blinds + curtains: allowed (additive)
- curtains -> curtains + blinds: allowed (additive)
- blinds -> curtains: hard fail (replacement)
- curtains -> blinds: hard fail (replacement)
- treatment removed: hard fail

Tier 3 — FLEXIBLE (must not fail)
- furniture
- decor
- lamps
- curtain/blind style changes within same TYPE

OCCLUSION VS REMOVAL (CRITICAL)
Treat an opening or fixed feature as PRESERVED when:
- partially visible, OR
- plausibly occluded by furniture/decor/lighting/coverings, OR
- moved partially/fully out of frame due to crop/zoom/perspective.

EDGE-OF-FRAME VISIBILITY RULE (MANDATORY)
For any opening/fixed feature near frame edge in BEFORE:
- If the same region is still visible in AFTER, the feature must still be present.
- If that visible region no longer contains the feature, classify as removed/replaced and hard fail.
- Only classify as out_of_frame when that region is not visible in AFTER.

REGION VISIBILITY DEFINITION (MANDATORY)
- A region is visible if any portion of the wall area where the feature existed is visible in AFTER.
- Partial visibility is sufficient to require validation.
- Partial occlusion, shadows, reflections, or partial framing do not qualify as out_of_frame by themselves.

Treat as REMOVED only when:
- replacement surface is clearly visible (for example clear wall infill), AND
- no plausible occlusion explanation exists.

VOID PRESERVATION EXCEPTION (OVERRIDES OCCLUSION BIAS)
If an opening (window, door, doorway) boundary is entirely absent in AFTER
and the region shows a wall-mounted item (TV, art, mirror, shelf, console)
on a continuous wall surface, classify as REMOVED — not occluded.
A wall-mounted item is evidence of void infill, not evidence of occlusion.
This rule overrides the plausible-occlusion presumption for that region.

INTERNAL TRANSITION RULE (DOORWAY INFILL)
If a doorway, walk-through, or internal opening in BEFORE is replaced by a flat
wall surface in AFTER—even if that surface is decorated with high-quality art,
mirrors, or decor—classify as Tier 1 REMOVED. Decorating a former void is a
common AI generation error. Do not accept it as renovation, styling, or occlusion.
${fromEmptyFrameContinuityRule}

OPENING OCCLUSION VS GEOMETRY RULE (MANDATORY)
- If a window appears smaller due to curtains, blinds, or soft furnishings covering part of it,
  treat this as occlusion (NOT structural opening change).
- Classify opening resize/removal only when actual opening geometry changed:
  frame/edge boundary moved, opening shape changed, or opening position changed.

UNCERTAINTY BIAS SCOPE (MANDATORY)
- If uncertain, classify as PRESERVED only for occlusion/out_of_frame questions.
- This uncertainty bias does not apply to clearly visible Tier 2 fixed-feature changes.

PROHIBITIONS
- Do not use similarity, IoU, or score-style reasoning for failure decisions.
- Do not fail directly from detection without classification.

FINAL AUTHORITY CONTRACT
- If classified Tier 1 or Tier 2 violation is present: hardFail=true.
- If only Tier 3 changes are present: hardFail=false.

OUTPUT JSON ONLY
{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": string[],
  "confidence": number,
  "violationType": "opening_change"|"wall_change"|"camera_shift"|"built_in_moved"|"layout_only"|"other",
  "builtInDetected": boolean,
  "structuralAnchorCount": number
}`;
}
