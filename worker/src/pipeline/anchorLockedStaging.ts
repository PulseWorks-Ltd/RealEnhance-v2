// Anchor-locked Stage 2 prompt path — production integration of the
// pattern validated overnight in tmp/test_anchor_only_staging_v3.ts and
// tmp/stage2_nanobanana_prompt_audit.md.
//
// Design: category-A general structural locks are always included, in
// full, unconditionally. Category-B clauses (room-specific fixture
// protections) are included only when the real baseline extraction detects
// the corresponding fixture/opening type for THIS image. The anchor item's
// wall + orientation come from a real, per-job wall-visibility extraction
// and deterministic planner — not a hand-authored or reused test result.
//
// SCOPE: only "bedroom" has validated anchor-item placement logic right
// now (bed against the planner-selected wall, oriented toward a focal
// opening). Any other room type — and any failure at any stage of
// baseline extraction, wall-visibility extraction, or planning — falls
// back to null (caller uses the existing default prompt path). This
// module never throws; every failure mode returns a explicit, logged
// fallback reason instead.
import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";
import { focusLog } from "../utils/logFocus";
import { nLog } from "../logger";
import {
  extractStructuralBaseline,
  type StructuralBaseline,
} from "../validators/openingPreservationValidator";

const WALL_VISIBILITY_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

// ── Category A: general structural locks — ALWAYS included in full,
// regardless of room contents. Verbatim from STAGE2_PROMPT_NANO_BANANA
// (worker/src/pipeline/stage2.ts:755-812), audited clause-by-clause in
// tmp/stage2_nanobanana_prompt_audit.md, with four additions:
// - AC/HVAC-unit clause, ceiling-fixture/smoke-detector clause, and a
//   general catch-all backstop, validated in tmp/test_anchor_only_staging_v3.ts.
// - A GEOMETRIC ENVELOPE LOCK block (Bedroom 2 production incident: room
//   depth/proportions subtly redrawn — "back wall pushed back" — without
//   this ever registering as camera zoom/crop/rotate, since nano-banana's
//   camera-lock section only constrains camera MOVEMENT, not room geometry
//   independent of the camera). Nano-banana never had this; it's ported
//   from the fuller STAGE2_PROMPT_LEGACY prompt (buildStage2FullPromptNZ's
//   STRUCTURAL_HARDENING_LAYER_V2, worker/src/ai/prompts/stage2/full.prompt.ts),
//   which already carries dedicated, repeated language for exactly this —
//   distinct from and in addition to camera lock, not a replacement for it.
// Do not add room-specific (category-B) content here — that goes in
// CATEGORY_B_RULES below, conditionally. ──
export const CATEGORY_A_LOCKS = `As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo, placing items within the unchanging physical structure of the room. You must still produce a high-quality, fully staged, listing-ready result — do not default to sparse or minimal staging; adapt placement, scale, and composition to fit the room instead. All added items must have realistic lighting, shadows, and perspective matching the room, and must be to-scale.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement and always overrides staging choices. You are explicitly and completely prohibited from making ANY changes — adding, removing, resizing, extending, re-coloring, relocating, or otherwise altering — the core structure, appearance, or built-in elements of the room, including:

Walls: location, dimensions, surface texture, or finish. Do not repaint, wallpaper, add, or remove walls.

Openings & views: the existence, size, or shape of any window, door, doorway, archway, or skylight, their frames/glass/hardware, or the view through them. Do not cover any opening. Keep the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor.

Floors & ceilings: floor material (e.g. hardwood, carpet, tile) and ceiling finish (paint, texture, tray ceilings). If two or more distinct flooring materials are visible in the original photo, each must stay exactly in its original location, boundary, and type — do not blend, unify, or extend one material over another, or smooth over a visible seam. Only place rugs and furniture on top of the existing floor.

Fixtures: HVAC vents, thermostats, switches, outlets, wall-mounted AC/split-system units, and other visible HVAC equipment; baseboards, crown molding, and railings; and any other fixed fixture, fitting, appliance, or built-in feature — do not remove, relocate, resize, alter, cover, or obstruct any of them, even if not individually named here.

Lighting: existing ceiling-mounted fixtures (flush-mount, semi-flush, pendant, or other) and ceiling-mounted safety devices (smoke/heat detectors) must be preserved exactly as-is. Do not add any new ceiling-mounted, wall-mounted, or hanging light fixture as staging decor (including pendant lights, chandeliers, hanging fixtures over tables, or wall sconces) — only movable/portable lighting (table lamps, floor lamps) may be added.

GEOMETRIC ENVELOPE LOCK — ZERO TOLERANCE:
The architectural envelope must remain visually and geometrically identical to the original photo, independent of camera movement. You must NOT:
* change wall positions, lengths, or angles
* alter corner locations
* modify ceiling height or plane geometry
* change window-to-wall ratio or door-to-wall ratio
* alter visible wall spacing
* adjust depth perspective or compression
* modify vanishing point alignment
Perspective lines, wall intersections, and opening proportions must align with the original image. Do NOT "improve" room proportions, straighten perspective, extend wall planes for symmetry, or reinterpret spatial depth in any way, even subtly or to make the room look larger — the camera may stay perfectly still while the room's geometry is redrawn, and that is equally prohibited.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing must remain exactly as in the original photo — do not zoom, crop, rotate, widen, narrow, or otherwise shift camera position or perspective. The final image must look like the same photo with furniture simply placed into the scene.`;

// ── Universal position-bound feature protection (replaces the old fixed
// per-type CATEGORY_B_RULES lookup for this layer). Every real compliance
// failure found this session traced to the same root cause: a real,
// correctly-detected fact from extraction never made it into the specific
// instruction Gemini reasons from at generation time — a category name
// alone ("Fireplaces, mantels, and hearths.") wasn't enough to protect
// Diningroom 01's wall bracket even though it WAS detected and named.
// Fix: generate one specific, position-bound sentence per item the
// baseline extraction actually found for THIS image — using its own
// type/description and detected position — instead of a hand-curated
// clause keyed by type. A novel object gets the same treatment as a
// correctly-typed fixture, because the sentence is built from what
// extraction found, not from whether a developer wrote a template for
// that category. Applies to every opening AND every anchor fixture, not a
// curated subset. ──

function resolveWallLabel(walls: WallVisibilityWall[] | null | undefined, wallIndex: number): string {
  const wall = (walls || []).find((w) => w.id === `wall_${wallIndex}`);
  return wall ? `${wall.id} (${wall.wallLabel})` : `wall_${wallIndex}`;
}

function fallbackItemDescription(type: string): string {
  return type.replace(/_/g, " ");
}

function describeItemPosition(
  walls: WallVisibilityWall[] | null | undefined,
  wallIndex: number,
  horizontalBand: string,
  verticalBand?: string
): string {
  const wallRef = resolveWallLabel(walls, wallIndex);
  const horizontal = describeHorizontalBand(horizontalBand);
  const vertical = verticalBand ? `, in the ${describeVerticalBand(verticalBand)} area` : "";
  return `${wallRef}, ${horizontal}${vertical}`;
}

export function buildUniversalFeatureProtectionSection(
  baseline: StructuralBaseline,
  walls: WallVisibilityWall[] | null | undefined
): { section: string; itemCount: number; sentences: string[] } {
  const sentences: string[] = [];

  for (const opening of baseline.openings || []) {
    const description = opening.description || fallbackItemDescription(opening.type);
    const position = describeItemPosition(walls, opening.wallIndex, opening.horizontalBand, opening.verticalBand);
    sentences.push(
      `This room has ${description}, located at/on ${position}. Do not remove, relocate, obstruct, or place new furniture, decor, or artwork over or directly in front of this feature. It must remain exactly as shown in the original photo.`
    );
  }
  for (const fixture of baseline.anchorFixtures || []) {
    const description = fixture.description || fallbackItemDescription(fixture.type);
    const position = describeItemPosition(walls, fixture.wallIndex, fixture.horizontalBand);
    sentences.push(
      `This room has ${description}, located at/on ${position}. Do not remove, relocate, obstruct, or place new furniture, decor, or artwork over or directly in front of this feature. It must remain exactly as shown in the original photo.`
    );
  }

  const section =
    sentences.length > 0
      ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, each must remain exactly as shown and fully unobstructed:\n${sentences.map((s) => `* ${s}`).join("\n")}`
      : "";

  return { section, itemCount: sentences.length, sentences };
}

// ── Wall-visibility extraction: per-job, real Gemini call. Ported from
// tmp/investigate_wall_visibility_v2.ts (the corrected, wall-count-aware
// version) — same system instruction, same JSON schema, same
// deterministic (temperature 0) call pattern. ──
export type Point = [number, number];
export type WallVisibilitySegment = { range: [number, number]; widthFraction: number; description: string };
export type WallVisibilityWall = {
  id: string;
  wallLabel: string;
  extent: { polygon: Point[] };
  openingIds: string[];
  usableWidthFraction: number;
  usableSegments: WallVisibilitySegment[];
  confidence: number;
};

const WALL_VISIBILITY_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis with wall-level visibility data.

You are given a room photograph AND an existing structural baseline (openings and fixtures already
detected, with stable IDs).

CRITICAL FIRST STEP — before describing any walls, first explicitly determine: how many distinct flat
wall planes are actually visible in this photograph? A new wall plane is indicated by a genuine visible
boundary — a corner where two surfaces meet at an angle, a change in the ceiling cornice line's slope, a
change in the skirting/baseboard line's direction, or a shadow/seam line — NOT merely by whether two
wall segments look similar in color or texture (most interior walls in a room are painted the same
color, so similarity in appearance is not evidence they are the same wall).

Pay particular attention to whether any wall segment that appears to run from one opening (e.g. a
walkthrough doorway or a mounted fixture) all the way to the edge of the frame is actually ONE
continuous wall, or whether it is actually TWO separate walls that were merged because there was no
obvious color change between them.

For each distinct wall you identify:
- Assign a wall id using the SAME 0-indexed wallIndex convention already used in the baseline
  (wall_0, wall_1, wall_2, wall_3).
- Give the wall's total visible extent as a polygon (perspective-skewed quadrilateral, following the
  actual visible floor-to-ceiling boundary of that wall).
- List which of the GIVEN opening/fixture IDs (from the baseline below) fall on this wall, if any.
- Estimate usableWidthFraction: the fraction (0-1) of this wall's total width that is clear, usable
  wall space once the openings/fixtures on it are subtracted.
- Describe usableSegments as horizontal fraction ranges [start, end] along that wall, each with a
  short plain description.
- Give a confidence value (0-1) for this wall's existence as a distinct wall.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildWallVisibilityUserPrompt(baseline: StructuralBaseline): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

First, internally determine how many distinct walls are visible. Then analyze this room photograph
and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "wallCount": number,
  "wallCountReasoning": string,
  "walls": [
    {
      "id": "wall_0" | "wall_1" | "wall_2" | "wall_3",
      "wallLabel": string,
      "extent": { "polygon": [[x,y], [x,y], ...] },
      "openingIds": string[],
      "usableWidthFraction": number,
      "usableSegments": [
        { "range": [start, end], "widthFraction": number, "description": string }
      ],
      "confidence": number
    }
  ]
}`;
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function extractWallVisibility(
  imagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string }
): Promise<WallVisibilityWall[] | null> {
  try {
    const image = toBase64(imagePath);
    const ai = getGeminiClient();
    const response: any = await (ai as any).models.generateContent({
      model: WALL_VISIBILITY_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: WALL_VISIBILITY_SYSTEM_INSTRUCTION },
            { text: buildWallVisibilityUserPrompt(baseline) },
            { inlineData: { mimeType: image.mime, data: image.data } },
          ],
        },
      ],
      generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
    });

    const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p: any) => typeof p?.text === "string");
    if (!textPart) {
      focusLog("STAGE2_ANCHOR_LOCKED", "[anchorLockedStaging] wall-visibility: no text returned", { jobId: ctx.jobId, imageId: ctx.imageId });
      return null;
    }
    const parsed = extractJsonFromModelText(textPart.text);
    if (!Array.isArray(parsed?.walls) || parsed.walls.length === 0) {
      focusLog("STAGE2_ANCHOR_LOCKED", "[anchorLockedStaging] wall-visibility: no walls in response", { jobId: ctx.jobId, imageId: ctx.imageId });
      return null;
    }
    return parsed.walls as WallVisibilityWall[];
  } catch (e) {
    focusLog("STAGE2_ANCHOR_LOCKED", "[anchorLockedStaging] wall-visibility extraction failed", { jobId: ctx.jobId, imageId: ctx.imageId, error: String(e) });
    return null;
  }
}

// ── Deterministic anchor planner — ported from
// tmp/build_deterministic_layout_plan_v3.ts. SCOPE: bedroom only (bed
// anchor). Callers must not invoke this for other room types; see
// buildAnchorLockedStage2Prompt's early room-type gate below. ──
const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;
const FOCAL_OPENING_TYPE_PRIORITY: Array<StructuralBaseline["openings"][number]["type"]> = ["window", "door"];
const FRAME_EDGE_EPSILON = 0.03;

type AnchorPlan = {
  anchorWallId: string;
  anchorWallLabel: string;
  anchorWallIndex: number;
  anchorSegmentDescription: string;
  anchorOrientationInstruction: string;
  anchorFramingNote: string | null;
  wallPartiallyVisible: boolean;
  noDecorAboveBedNote: string | null;
  confidence: number;
  selectionReason: string;
};

// Bedroom 11 production incident (real job, anchor_locked path): the bed
// was correctly placed against a wall that also had a small window on it
// (W2), but the model then added a mirror/artwork above the headboard —
// landing directly on the window's footprint and visually "walling it
// over." The generic category-A "do not cover openings" instruction
// wasn't concrete enough to stop this once the model was independently
// deciding where to hang decor. Fix: explicitly name every opening/fixture
// that shares the anchor wall's wallIndex, with its real detected
// position, and forbid new decor over each one specifically — not a
// blanket "no decor above the bed" rule, which would also suppress the
// (normal, desirable) above-headboard-art convention in every bedroom
// that DOESN'T have this conflict.
function describeHorizontalBand(band: string): string {
  if (band === "left_third") return "left portion";
  if (band === "right_third") return "right portion";
  return "center";
}
function describeVerticalBand(band: string): string {
  if (band === "floor_zone") return "lower";
  if (band === "ceiling_zone") return "upper, near the ceiling";
  if (band === "full_height") return "full-height";
  return "middle";
}

function wallBBox(wall: WallVisibilityWall) {
  const xs = wall.extent.polygon.map((p) => p[0]);
  const ys = wall.extent.polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function planBedroomAnchor(baseline: StructuralBaseline, walls: WallVisibilityWall[]): AnchorPlan | null {
  const wallCandidates = walls.map((wall) => {
    const largestSegment = wall.usableSegments.reduce((max, s) => Math.max(max, s.widthFraction), 0);
    return { wall, largestSegment };
  });

  const ranked = [...wallCandidates].sort((a, b) => b.largestSegment - a.largestSegment);
  const qualifying = ranked.filter((w) => w.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR);

  // Production behavior differs from the tmp/ exploratory scripts here:
  // those always returned a plan (with a low-confidence fallback wall) so
  // the reasoning could be inspected. In production, "no wall confidently
  // qualifies" is itself a fallback trigger — callers should use the
  // existing prompt path rather than stage a bed against a wall that
  // doesn't have enough clear space, however plausible-looking.
  if (qualifying.length === 0) {
    return null;
  }

  const selected = qualifying[0];
  const selectedWall = selected.wall;
  const bestSegment = [...selectedWall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];
  const selectedWallIndex = Number(String(selectedWall.id).replace("wall_", ""));

  // Orientation: prefer a focal opening (window > door) not on the anchor's
  // own wall; fall back to whatever's available.
  let focalFeatureId: string | null = null;
  let focalFeatureType: string | null = null;
  let focalFeatureWallIndex: number | null = null;
  for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
    const candidates = baseline.openings.filter((o) => o.type === focalType);
    const offAnchorWall = candidates.filter((o) => o.wallIndex !== selectedWallIndex);
    const pick = offAnchorWall[0] || candidates[0];
    if (pick) {
      focalFeatureId = pick.id;
      focalFeatureType = pick.type;
      focalFeatureWallIndex = pick.wallIndex;
      break;
    }
  }
  const anchorOrientationInstruction = focalFeatureId
    ? `Orient the bed so its foot end points toward ${focalFeatureId} (the ${focalFeatureType} on wall_${focalFeatureWallIndex}) — NOT toward the camera. The camera should see the long side profile of the bed, not the headboard/footboard face-on.`
    : `No focal opening identified; orient the bed facing into the open floor area of the room.`;

  const { minX, maxX } = wallBBox(selectedWall);
  const touchesRight = maxX >= 1 - FRAME_EDGE_EPSILON;
  const touchesLeft = minX <= FRAME_EDGE_EPSILON;
  const wallPartiallyVisible = touchesLeft || touchesRight;
  const anchorFramingNote = wallPartiallyVisible
    ? `${selectedWall.id} is only partially visible in the frame (truncated at the ${touchesRight ? "right" : "left"} edge). Edge-cropped placement is acceptable.`
    : null;

  // A wall that's cropped by the frame edge can't be fully verified —
  // whatever's just off-frame (another opening, a fixture) isn't visible
  // to the baseline extraction at all, so co-located-feature protection
  // can't cover it either. Bedroom 11/14 both involved decor or the bed
  // itself landing on an opening that undermined a "should be fine"
  // assumption about the wall; an edge-cropped wall is exactly the case
  // where that assumption is least trustworthy. Conservative backstop:
  // no wall-mounted decor above the bed at all on a wall we can't fully see.
  const noDecorAboveBedNote = wallPartiallyVisible
    ? `${selectedWall.id} is only partially visible in this photo, so its full extent cannot be verified. Do NOT place any wall-mounted artwork, mirrors, shelving, or other decor above the bed on this wall, even if it looks like there is room for it — leave the wall above the headboard bare.`
    : null;

  return {
    anchorWallId: selectedWall.id,
    anchorWallLabel: selectedWall.wallLabel,
    anchorWallIndex: selectedWallIndex,
    anchorSegmentDescription: bestSegment.description,
    anchorOrientationInstruction,
    anchorFramingNote,
    wallPartiallyVisible,
    noDecorAboveBedNote,
    confidence: Math.min(selectedWall.confidence, 0.9),
    selectionReason: `${selectedWall.id} (${selectedWall.wallLabel}) selected: largest contiguous usable segment ${selected.largestSegment.toFixed(3)} ("${bestSegment.description}"), meets the ${MIN_USABLE_FRACTION_FOR_ANCHOR} minimum threshold.`,
  };
}

// ── Living/dining zoning + multi-anchor planning. Ported from the real,
// validated tmp/ implementations rather than rewritten from memory:
//   - Zoning system instruction + schema + FLOOR-REGION EXTENT baseboard-
//     anchoring fix + kitchen-proximity signal: tmp/fix_zoning_and_depth_check.ts:48-82.
//   - TV-wall / sofa / dining multi-anchor planner: tmp/fix_zoning_and_depth_check.ts:111-215,
//     WITH ONE DELIBERATE CHANGE: the original script's depth-proxy
//     "sanity check" could override a failing primary depth check and
//     force TV placement anyway (`depthOk = true` override, its own
//     comment calls this "Part 2.2"). That inversion was explicitly
//     removed per a later decision in the same session — a
//     flagged-suspect depth reading is now logged as diagnostic
//     reasoning ONLY; it no longer flips the placement decision. When the
//     primary depth check fails, the standard no-TV fallback applies,
//     full stop. Do not reintroduce the override.
//   - Circulation-aware floating sofa placement (findLivingZoneEntryOpenings,
//     the 0.12 clearance radius, computeFloatingSofaPosition, checkClearance):
//     tmp/fix_lightfixture_sofa_placement.ts:110-151, ported directly.
//   - Anchor-section prose structure: tmp/fix_lightfixture_sofa_placement.ts:182-196.
// Flooring-boundary/material preservation across a two-material zone split
// is explicitly NOT ported here — three real tests found it unresolved
// (inconsistent failure modes; the zone polygon used for furniture
// placement and the real material-boundary polygon are different shapes
// being treated as one, which needs new extraction-schema work). The
// shared, always-on category-A "Floors & ceilings... must stay exactly in
// its original location, boundary, and type" lock still applies via
// CATEGORY_A_LOCKS above — this section adds nothing further on top of it. ──

export type LivingDiningZone = {
  id: string;
  purpose: "living" | "dining";
  floorRegion: { polygon: Point[] };
  borderingWallIndices: number[];
  reasoning: string;
};
type KitchenSignal = { present: boolean; openingId: string | null; confidence: number; evidence: string };

const ZONING_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

const ZONING_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis to identify functional zones within an open-plan living/dining room.

You are given a room photograph AND an existing structural baseline (openings and fixtures already detected, with stable IDs).

This room combines two functions: a LIVING zone (seating area) and a DINING zone (table + chairs area). Identify how the visible floor space divides into these two zones, based on genuine visual cues — a change in flooring material, a change in ceiling treatment, existing furniture grouping if the room happens to be furnished (use furniture position only as a cue for how the space is naturally used, not as a placement instruction to preserve), sightlines, and traffic flow. If the room is empty, rely on architectural geometry alone (room shape, alcoves, ceiling breaks, wall offsets) — do not assume an even 50/50 split, and do not invent a furniture-based cue that isn't visible. The two zones' floor regions should not overlap.

FLOOR-REGION EXTENT — CRITICAL: each zone's floorRegion polygon must extend all the way to the actual visible baseboard / wall-to-floor junction line for every wall that borders it, not stop short of it. Locate the baseboard line at the base of each bordering wall — usually a thin, fairly straight line where the wall surface meets the floor — and trace the polygon out to that line, not to some more conservative point partway there. This is easy to get wrong in rooms with plain, evenly-lit, low-texture-contrast flooring (e.g. bare carpet with no rug or furniture to judge distance against) — in those cases it is especially important to look carefully for the actual baseboard line rather than guessing a shorter distance. A floor region that stops well short of the real baseboard line anywhere along a bordering wall is wrong, even if the general shape/cues used to divide the two zones are otherwise correct.

Additionally, determine whether any of the given openings appears to lead toward or provide a sightline into a KITCHEN — look for cues such as visible countertops, cabinetry, appliances, a kitchen island, pendant/track lighting typical of kitchens, or distinct kitchen-style flooring/splashback visible through or beyond the opening. This is inference from visible cues, not a labeled fact in the baseline — report your confidence honestly, and report present:false if no such cue exists anywhere in the photo.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildZoningUserPrompt(baseline: StructuralBaseline): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

Analyze this room photograph and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "zones": [
    {
      "id": "zone_living" | "zone_dining",
      "purpose": "living" | "dining",
      "floorRegion": { "polygon": [[x,y], [x,y], ...] },
      "borderingWallIndices": number[],
      "reasoning": string
    }
  ],
  "kitchenSignal": {
    "present": boolean,
    "openingId": string | null,
    "confidence": number,
    "evidence": string
  }
}`;
}

async function extractZoning(
  imagePath: string,
  baseline: StructuralBaseline,
  ctx: { jobId: string; imageId: string }
): Promise<{ zones: LivingDiningZone[]; kitchenSignal: KitchenSignal | null } | null> {
  try {
    const image = toBase64(imagePath);
    const ai = getGeminiClient();
    const response: any = await (ai as any).models.generateContent({
      model: ZONING_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: ZONING_SYSTEM_INSTRUCTION },
            { text: buildZoningUserPrompt(baseline) },
            { inlineData: { mimeType: image.mime, data: image.data } },
          ],
        },
      ],
      generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
    });
    const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p: any) => typeof p?.text === "string");
    if (!textPart) {
      focusLog("STAGE2_ANCHOR_LOCKED", "[anchorLockedStaging] zoning: no text returned", { jobId: ctx.jobId, imageId: ctx.imageId });
      return null;
    }
    const parsed = extractJsonFromModelText(textPart.text);
    if (!Array.isArray(parsed?.zones) || parsed.zones.length === 0) {
      focusLog("STAGE2_ANCHOR_LOCKED", "[anchorLockedStaging] zoning: no zones in response", { jobId: ctx.jobId, imageId: ctx.imageId });
      return null;
    }
    return { zones: parsed.zones as LivingDiningZone[], kitchenSignal: parsed.kitchenSignal || null };
  } catch (e) {
    focusLog("STAGE2_ANCHOR_LOCKED", "[anchorLockedStaging] zoning extraction failed", { jobId: ctx.jobId, imageId: ctx.imageId, error: String(e) });
    return null;
  }
}

function polygonBBox(polygon: Point[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function polygonCentroid(polygon: Point[]): Point {
  const n = polygon.length;
  return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
}

const TV_MIN_USABLE_FRACTION = 0.2;
const MIN_ZONE_DEPTH_FOR_TV_FACING = 0.25;
// Kept for diagnostic reasoning only — see the removed-override note above.
const WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO = 0.3;

type DiningPlan = { center: Point; footprint: { halfWidth: number; halfHeight: number }; reasoning: string };
type TvPlan = { wallId: string; wallLabel: string; segmentDescription: string; largestSegment: number; depthCheckFlaggedSuspect: boolean; reasoning: string };
type SofaPlan = { wallId: string | null; wallLabel?: string; floorCentered?: boolean; facingWallId: string | null; orientationInstruction?: string; reasoning: string };
type MultiAnchorPlan = {
  diningPlan: DiningPlan | null;
  tvPlan: TvPlan | null;
  noTvReason: string | null;
  sofaPlan: SofaPlan | null;
  reasoning: string[];
  livingZone: LivingDiningZone | undefined;
  diningZone: LivingDiningZone | undefined;
  depthCheckFlaggedSuspect: boolean;
};

function planMultiAnchor(baseline: StructuralBaseline, walls: WallVisibilityWall[], zones: LivingDiningZone[]): MultiAnchorPlan {
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");
  const reasoning: string[] = [];
  let depthCheckFlaggedSuspect = false;

  let diningPlan: DiningPlan | null = null;
  if (diningZone && diningZone.floorRegion?.polygon && diningZone.floorRegion.polygon.length >= 3) {
    const centroid = polygonCentroid(diningZone.floorRegion.polygon);
    const bbox = polygonBBox(diningZone.floorRegion.polygon);
    diningPlan = {
      center: centroid,
      footprint: { halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35), halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3) },
      reasoning: `Table centered within zone_dining (centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]).`,
    };
  }

  let tvPlan: TvPlan | null = null;
  let noTvReason: string | null = null;
  let sofaPlan: SofaPlan | null = null;

  if (livingZone) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const otherZonesWallIndices = new Set<number>(zones.filter((z) => z.id !== livingZone.id).flatMap((z) => z.borderingWallIndices || []));
    const exclusiveLivingWallIndices = livingWallIndices.filter((idx) => !otherZonesWallIndices.has(idx));
    const wallByIndex = (idx: number) => walls.find((w) => Number(String(w.id).replace("wall_", "")) === idx);

    const zoneBBox = livingZone.floorRegion?.polygon ? polygonBBox(livingZone.floorRegion.polygon) : null;
    const zoneDepthProxy = zoneBBox ? zoneBBox.maxY - zoneBBox.minY : 0;
    const depthOk = zoneDepthProxy >= MIN_ZONE_DEPTH_FOR_TV_FACING;
    reasoning.push(`Living zone floor-region depth proxy: ${zoneDepthProxy.toFixed(3)} (threshold ${MIN_ZONE_DEPTH_FOR_TV_FACING}) — ${depthOk ? "sufficient" : "insufficient"}.`);

    const tvCandidatesRaw = exclusiveLivingWallIndices
      .map((idx) => wallByIndex(idx))
      .filter((w): w is WallVisibilityWall => !!w)
      .map((w) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m, s) => Math.max(m, s.widthFraction), 0) }))
      .filter((c) => c.largestSegment >= TV_MIN_USABLE_FRACTION)
      .sort((a, b) => b.largestSegment - a.largestSegment);

    // Diagnostic-only sanity check: when the primary depth check fails but
    // a zone-exclusive, width-qualified TV candidate exists, log whether
    // the depth reading looks implausible relative to that wall's own
    // frame-height — but this NO LONGER overrides the placement decision
    // (see the module-level comment on why the earlier override was
    // removed). depthOk stays whatever the primary check computed.
    if (!depthOk && tvCandidatesRaw[0]) {
      const wallBBoxTop = polygonBBox(tvCandidatesRaw[0].wall.extent.polygon);
      const wallHeightInFrame = wallBBoxTop.maxY - wallBBoxTop.minY;
      const implausible = zoneDepthProxy < WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO * wallHeightInFrame;
      reasoning.push(
        `Depth-proxy sanity check (diagnostic only, does not override the decision): candidate wall ${tvCandidatesRaw[0].wall.id} frame-height ${wallHeightInFrame.toFixed(3)}; zone depth (${zoneDepthProxy.toFixed(3)}) is ${implausible ? "BELOW" : "at/above"} ${WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO} x wall-height (${(WALL_HEIGHT_TO_ZONE_DEPTH_MIN_RATIO * wallHeightInFrame).toFixed(3)}).`
      );
      if (implausible) {
        depthCheckFlaggedSuspect = true;
      }
    }

    const tvCandidate = depthOk ? tvCandidatesRaw[0] : undefined;

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a, b) => b.widthFraction - a.widthFraction)[0];
      tvPlan = {
        wallId: tvCandidate.wall.id,
        wallLabel: tvCandidate.wall.wallLabel,
        segmentDescription: seg?.description || "",
        largestSegment: tvCandidate.largestSegment,
        depthCheckFlaggedSuspect,
        reasoning: `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) is zone-exclusive, clears TV width threshold (${tvCandidate.largestSegment.toFixed(3)} >= ${TV_MIN_USABLE_FRACTION}), zone depth sufficient.`,
      };
      reasoning.push(tvPlan.reasoning);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter((w): w is WallVisibilityWall => !!w)
        .filter((w) => w.id !== tvCandidate.wall.id)
        .map((w) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m, s) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);
      sofaPlan = sofaCandidates[0]
        ? { wallId: sofaCandidates[0].wall.id, wallLabel: sofaCandidates[0].wall.wallLabel, facingWallId: tvCandidate.wall.id, reasoning: `Sofa placed against ${sofaCandidates[0].wall.id}, facing ${tvCandidate.wall.id}.` }
        : { wallId: null, floorCentered: true, facingWallId: tvCandidate.wall.id, reasoning: `No other living-zone wall qualified; sofa floor-centered, facing ${tvCandidate.wall.id}.` };
      reasoning.push(sofaPlan.reasoning);
    } else {
      noTvReason = exclusiveLivingWallIndices.length === 0
        ? "no TV placed — no wall is exclusive to the living zone (all bordering walls are shared with another zone)"
        : tvCandidatesRaw.length === 0
        ? "no TV placed — no zone-exclusive wall clears the minimum usable-width threshold for a TV"
        : "no TV placed — living zone floor depth is insufficient for a sofa to face a TV at a plausible distance";
      reasoning.push(noTvReason);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter((w): w is WallVisibilityWall => !!w)
        .map((w) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m, s) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);
      const sofaWall = sofaCandidates[0]?.wall || null;
      const sofaWallIndex = sofaWall ? Number(String(sofaWall.id).replace("wall_", "")) : null;
      let focalFeatureId: string | null = null;
      let focalFeatureType: string | null = null;
      let focalFeatureWallIndex: number | null = null;
      for (const focalType of FOCAL_OPENING_TYPE_PRIORITY) {
        const candidates = baseline.openings.filter((o) => o.type === focalType && livingWallIndices.includes(o.wallIndex));
        const offSofaWall = candidates.filter((o) => o.wallIndex !== sofaWallIndex);
        const pick = offSofaWall[0] || candidates[0];
        if (pick) {
          focalFeatureId = pick.id;
          focalFeatureType = pick.type;
          focalFeatureWallIndex = pick.wallIndex;
          break;
        }
      }
      const orientationInstruction = focalFeatureId
        ? `Orient the sofa to face toward ${focalFeatureId} (the ${focalFeatureType} on wall_${focalFeatureWallIndex}).`
        : `No focal opening identified; orient the sofa facing into the open floor area of the room.`;
      sofaPlan = sofaWall
        ? { wallId: sofaWall.id, wallLabel: sofaWall.wallLabel, facingWallId: null, orientationInstruction, reasoning: `Sofa placed against ${sofaWall.id} — no TV to face. ${orientationInstruction}` }
        : { wallId: null, floorCentered: true, facingWallId: null, orientationInstruction, reasoning: `No living-zone wall qualified; floor-centered. ${orientationInstruction}` };
      reasoning.push(sofaPlan.reasoning);
    }
  }

  return { diningPlan, tvPlan, noTvReason, sofaPlan, reasoning, livingZone, diningZone, depthCheckFlaggedSuspect };
}

// Circulation path = the direct line from any door/walkthrough opening
// bordering the living zone into the room. Grounded entirely in existing
// baseline (opening bboxes/wallIndex) and zoning (floorRegion polygon)
// data — no new extraction.
function findLivingZoneEntryOpenings(baseline: StructuralBaseline, livingWallIndices: number[]) {
  return baseline.openings.filter((o) => livingWallIndices.includes(o.wallIndex) && (o.type === "door" || o.type === "walkthrough"));
}

const CLEARANCE_RADIUS = 0.12; // normalized frame-x distance a floating sofa must keep from an entry opening's x-center

function computeFloatingSofaPosition(livingZone: LivingDiningZone, entryOpenings: StructuralBaseline["openings"]) {
  const zoneBBox = polygonBBox(livingZone.floorRegion.polygon);
  const zoneWidth = zoneBBox.maxX - zoneBBox.minX;
  const zoneDepth = zoneBBox.maxY - zoneBBox.minY;
  const zoneCenterX = zoneBBox.minX + zoneWidth / 2;

  let sofaX = zoneCenterX;
  if (entryOpenings.length > 0) {
    const entryXs = entryOpenings.map((o) => (o.bbox[0] + o.bbox[2]) / 2);
    const avgEntryX = entryXs.reduce((a, b) => a + b, 0) / entryXs.length;
    sofaX = avgEntryX < zoneCenterX ? zoneBBox.minX + zoneWidth * 0.68 : zoneBBox.minX + zoneWidth * 0.32;
  }
  // Set back from the TV wall (zone's minY, the "far" edge nearest the TV
  // wall) by ~60% of zone depth — leaves TV-viewing distance in front, and
  // walking space behind the sofa toward the entry/dining side.
  const sofaY = zoneBBox.minY + zoneDepth * 0.6;
  return { x: sofaX, y: sofaY };
}

function checkClearance(sofaPos: { x: number; y: number }, entryOpenings: StructuralBaseline["openings"]): { clear: boolean; reason: string } {
  for (const o of entryOpenings) {
    const entryX = (o.bbox[0] + o.bbox[2]) / 2;
    const dx = Math.abs(sofaPos.x - entryX);
    if (dx < CLEARANCE_RADIUS) {
      return { clear: false, reason: `Sofa x (${sofaPos.x.toFixed(3)}) is within the ${CLEARANCE_RADIUS} clearance radius of entry opening ${o.id}'s x-center (${entryX.toFixed(3)}), dx=${dx.toFixed(3)}.` };
    }
  }
  return { clear: true, reason: entryOpenings.length > 0 ? `Sofa clears all entry openings by >= ${CLEARANCE_RADIUS}.` : "No entry openings on the living zone's bordering walls." };
}

function buildLivingDiningAnchorSection(plan: MultiAnchorPlan, sofaInstructionOverride?: string): string {
  const livingLines: string[] = [];
  if (plan.tvPlan && sofaInstructionOverride) {
    livingLines.push(`* Place a TV and low TV console/unit against ${plan.tvPlan.wallId} (${plan.tvPlan.wallLabel}), within the segment described as "${plan.tvPlan.segmentDescription}".`);
    livingLines.push(`* ${sofaInstructionOverride}`);
  } else if (plan.sofaPlan) {
    const where = plan.sofaPlan.wallId ? `against ${plan.sofaPlan.wallId} (${plan.sofaPlan.wallLabel})` : `floor-centered within the living zone (no wall in this zone is suitable for large furniture)`;
    livingLines.push(`* Place a sofa ${where}. ${plan.sofaPlan.orientationInstruction || ""}`.trim());
  }
  const diningLines: string[] = [];
  if (plan.diningPlan) {
    diningLines.push(
      `* Place a dining table with seating for 4-6 chairs, freestanding within the dining zone, centered roughly at normalized position [${plan.diningPlan.center[0].toFixed(3)}, ${plan.diningPlan.center[1].toFixed(3)}] of the full photo. The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out.`
    );
  }
  return `ANCHOR ITEMS — LIVING ZONE (must be followed exactly)\n\n${livingLines.join("\n")}\n\nANCHOR ITEM — DINING ZONE (must be followed exactly)\n\n${diningLines.join("\n")}\n\nZONING CONTEXT: this is a single open-plan room combining two functional zones — a living/seating zone and a dining zone. Stage each zone according to its function as instructed above, so the two areas read as distinct, intentional zones within the same open room, not one undifferentiated furniture arrangement.`;
}

// ── Orchestrator ──
export type AnchorLockedPromptResult = {
  prompt: string | null;
  fallbackReason: string | null;
  diagnostics: {
    roomType: string;
    baselineExtracted: boolean;
    wallVisibilityExtracted: boolean;
    anchorWallId: string | null;
    anchorConfidence: number | null;
    protectedFeatureCount: number;
    protectedFeatureSentences: string[];
    wallPartiallyVisible: boolean;
    zoningExtracted?: boolean;
    tvPlaced?: boolean;
    sofaFloating?: boolean;
  };
};

// "living_dining" is the real room-type identifier used by job intake —
// confirmed against worker/src/ai/roomTypeDetector.ts, shared/src/types.ts,
// and server/src/routes/upload.ts, not assumed.
const SUPPORTED_ROOM_TYPES = new Set(["bedroom", "living_dining"]);

function buildBedroomPrompt(
  baseline: StructuralBaseline,
  walls: WallVisibilityWall[],
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  const plan = planBedroomAnchor(baseline, walls);
  if (!plan) {
    return { prompt: null, fallbackReason: "no_wall_meets_anchor_threshold", extra: {} };
  }

  const framingLine = plan.anchorFramingNote ? ` ${plan.anchorFramingNote}` : "";
  const noDecorLine = plan.noDecorAboveBedNote ? `\n* ${plan.noDecorAboveBedNote}` : "";

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against ${plan.anchorWallId} in the room analysis, referred to as "${plan.anchorWallLabel}", within the clear segment described as "${plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}${framingLine}${noDecorLine}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the protected features named above and the no-decor-above-bed rule if it applies. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  return {
    prompt,
    fallbackReason: null,
    extra: {
      anchorWallId: plan.anchorWallId,
      anchorConfidence: plan.confidence,
      wallPartiallyVisible: plan.wallPartiallyVisible,
    },
  };
}

async function buildLivingDiningPrompt(
  imagePath: string,
  baseline: StructuralBaseline,
  walls: WallVisibilityWall[],
  protectedFeatureSection: string,
  ctx: { jobId: string; imageId: string }
): Promise<{ prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> }> {
  const zoningResult = await extractZoning(imagePath, baseline, ctx);
  if (!zoningResult) {
    return { prompt: null, fallbackReason: "zoning_extraction_failed", extra: {} };
  }
  const { zones } = zoningResult;
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");
  if (!livingZone || !diningZone || !livingZone.floorRegion?.polygon || !diningZone.floorRegion?.polygon) {
    return { prompt: null, fallbackReason: "zoning_incomplete", extra: { zoningExtracted: true } };
  }

  const plan = planMultiAnchor(baseline, walls, zones);
  if (!plan.diningPlan) {
    return { prompt: null, fallbackReason: "no_valid_dining_anchor", extra: { zoningExtracted: true } };
  }
  if (!plan.sofaPlan) {
    return { prompt: null, fallbackReason: "no_valid_living_anchor", extra: { zoningExtracted: true } };
  }

  let sofaInstructionOverride: string | undefined;
  if (plan.tvPlan) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const entryOpenings = findLivingZoneEntryOpenings(baseline, livingWallIndices);
    const sofaPos = computeFloatingSofaPosition(livingZone, entryOpenings);
    const clearance = checkClearance(sofaPos, entryOpenings);
    if (!clearance.clear) {
      return { prompt: null, fallbackReason: `sofa_clearance_check_failed:${clearance.reason}`, extra: { zoningExtracted: true, tvPlaced: true } };
    }
    const clearanceClause =
      entryOpenings.length > 0
        ? ` This position is deliberately clear of the direct path from ${entryOpenings.map((o) => o.id).join("/")} into the room — do not place the sofa against a side or adjacent wall, and do not place it so it blocks the walking path from that opening into the rest of the room.`
        : ` Do not place the sofa against a side or adjacent wall.`;
    sofaInstructionOverride = `Place the sofa floating in the room (not against any wall), facing directly toward ${plan.tvPlan.wallId} (the TV wall), positioned at approximately normalized coordinates [${sofaPos.x.toFixed(3)}, ${sofaPos.y.toFixed(3)}] of the full photo.${clearanceClause}`;
  }

  const anchorSection = buildLivingDiningAnchorSection(plan, sofaInstructionOverride);

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

${anchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a combined living/dining space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  return {
    prompt,
    fallbackReason: null,
    extra: {
      zoningExtracted: true,
      tvPlaced: !!plan.tvPlan,
      sofaFloating: !!sofaInstructionOverride,
      anchorWallId: plan.tvPlan?.wallId ?? plan.sofaPlan.wallId ?? null,
    },
  };
}

export async function buildAnchorLockedStage2Prompt(opts: {
  imagePath: string;
  roomType: string;
  jobId: string;
  imageId: string;
}): Promise<AnchorLockedPromptResult> {
  const baseDiagnostics: AnchorLockedPromptResult["diagnostics"] = {
    roomType: opts.roomType,
    baselineExtracted: false,
    wallVisibilityExtracted: false,
    anchorWallId: null,
    anchorConfidence: null,
    protectedFeatureCount: 0,
    protectedFeatureSentences: [],
    wallPartiallyVisible: false,
  };

  const fallback = (reason: string, diagnostics = baseDiagnostics): AnchorLockedPromptResult => {
    nLog("[STAGE2_ANCHOR_LOCKED_FALLBACK]", { jobId: opts.jobId, imageId: opts.imageId, roomType: opts.roomType, reason });
    return { prompt: null, fallbackReason: reason, diagnostics };
  };

  // Cheap early-exit: don't spend any API calls on a room type this
  // planner doesn't have validated anchor-item logic for yet.
  if (!SUPPORTED_ROOM_TYPES.has(opts.roomType)) {
    return fallback(`room_type_not_supported:${opts.roomType}`);
  }

  let baseline: StructuralBaseline;
  try {
    baseline = await extractStructuralBaseline(opts.imagePath, { jobId: opts.jobId, imageId: opts.imageId });
  } catch (e) {
    return fallback(`baseline_extraction_failed:${String(e)}`);
  }
  baseDiagnostics.baselineExtracted = true;

  const walls = await extractWallVisibility(opts.imagePath, baseline, { jobId: opts.jobId, imageId: opts.imageId });
  if (!walls) {
    return fallback("wall_visibility_extraction_failed", baseDiagnostics);
  }
  baseDiagnostics.wallVisibilityExtracted = true;

  const { section: protectedFeatureSection, itemCount, sentences } = buildUniversalFeatureProtectionSection(baseline, walls);
  baseDiagnostics.protectedFeatureCount = itemCount;
  baseDiagnostics.protectedFeatureSentences = sentences;

  const roomResult =
    opts.roomType === "bedroom"
      ? buildBedroomPrompt(baseline, walls, protectedFeatureSection)
      : await buildLivingDiningPrompt(opts.imagePath, baseline, walls, protectedFeatureSection, { jobId: opts.jobId, imageId: opts.imageId });

  const diagnostics: AnchorLockedPromptResult["diagnostics"] = { ...baseDiagnostics, ...roomResult.extra };

  if (!roomResult.prompt) {
    return fallback(roomResult.fallbackReason || "unknown_planning_failure", diagnostics);
  }

  nLog("[STAGE2_ANCHOR_LOCKED_PLAN]", {
    jobId: opts.jobId,
    imageId: opts.imageId,
    ...diagnostics,
    fallbackTriggered: false,
  });

  return { prompt: roomResult.prompt, fallbackReason: null, diagnostics };
}
