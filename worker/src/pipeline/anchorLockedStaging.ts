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
  type AnchorFixtureType,
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
export const CATEGORY_A_LOCKS = `As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement.

You must preserve all architectural elements exactly:

* walls, ceilings, floors, doors, windows, openings, built-ins, and camera geometry.

If staging conflicts with structure:

* structure always takes priority,
* but you must still produce a high-quality, fully staged, listing-ready result.

Do not default to sparse or minimal staging.
Instead, adapt placement, scale, and composition to resolve conflicts.

All added items must be rendered with realistic lighting and shadows that match the room, and must be in the correct perspective for the photo. All items must be to-scale.

Strict Prohibitions (Negative Constraints):
You are explicitly and completely prohibited from making ANY changes, of any kind, to the core structure, appearance, or built-in elements of the room itself. You must not add, remove, resize, extend, re-color, or alter in ANY way, the following:

Walls: No changes to their location, dimension, surface texture, or existing finish. (Do not repaint or apply wallpaper, as that is not virtual staging). No adding or removing walls.

Openings: Do not alter the existence, size, or shape of any windows, doors, doorways, archways, or skylights. Do not paint or change frames, glass, or hardware. Do not cover them. This includes keeping the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor.

Floors & Ceilings: Do not alter the floor material (e.g., hardwood, carpet, tile) or the ceiling (e.g., paint, texture, tray ceilings). Only place rugs and furniture on top of the existing floor.

Fixtures & Features: Do not change, remove, or alter existing:
HVAC vents, thermostats, switches, or outlets.
Baseboards, crown molding, and railings.
Wall-mounted air conditioning units, split-system units, and any other visible HVAC equipment: do not remove, relocate, resize, or alter their appearance, and do not cover or obstruct them with furniture, artwork, or decor.
Ceiling-mounted light fixtures (including flush-mount, semi-flush, pendant, and any other ceiling-mounted lighting) and ceiling-mounted safety devices (smoke detectors, heat detectors): do not remove, relocate, resize, or alter their appearance.

View: Do not change the existing view through windows or doors.

Do not alter, remove, or add any other fixed fixture, fitting, appliance, or built-in feature visible in the original photo, even if not individually named above.

GEOMETRIC ENVELOPE LOCK — ZERO TOLERANCE:
The architectural envelope must remain visually and geometrically identical to the original photo. You must NOT:
* change wall positions, lengths, or angles
* alter corner locations
* modify ceiling height or plane geometry
* change window-to-wall ratio or door-to-wall ratio
* alter visible wall spacing
* adjust depth perspective or compression
* modify vanishing point alignment
Perspective lines, wall intersections, and opening proportions must align with the original image. Do NOT "improve" room proportions, straighten perspective, extend wall planes for compositional symmetry, or reinterpret spatial depth in any way — even subtly, even if it would make the room look larger or more spacious. This is a separate, additional requirement to the Camera & Perspective Constraint below, not covered by it: the camera may stay perfectly still while the room's geometry is redrawn, and that is equally prohibited.

Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;

// ── Category B: room-specific clauses, included only when the real
// baseline extraction detects the corresponding item for this image.
// Keyed by a matcher against the real StructuralBaseline rather than a
// flat type->string map, since "Closets and their doors" depends on an
// OPENING type (closet_door) while the rest depend on anchorFixture types —
// a flat lookup on AnchorFixtureType alone can't express that. ──
type CategoryBRule = { id: string; clause: string; matches: (baseline: StructuralBaseline) => boolean };

const hasFixtureType = (baseline: StructuralBaseline, ...types: AnchorFixtureType[]) =>
  (baseline.anchorFixtures || []).some((f) => types.includes(f.type));

export const CATEGORY_B_RULES: CategoryBRule[] = [
  {
    id: "kitchen_built_ins",
    clause: "Kitchen islands, cabinetry, and countertops.",
    matches: (b) => hasFixtureType(b, "kitchen_island", "built_in_cabinet"),
  },
  {
    id: "fireplace",
    clause: "Fireplaces, mantels, and hearths.",
    matches: (b) => hasFixtureType(b, "fireplace"),
  },
  {
    id: "closets",
    clause: "Closets and their doors.",
    matches: (b) => b.openings.some((o) => o.type === "closet_door"),
  },
  {
    id: "plumbing",
    clause: "Faucets, sinks, tubs, and showers.",
    matches: (b) => hasFixtureType(b, "plumbing_fixture"),
  },
  {
    id: "pendant_ceiling_lighting",
    clause: "Pendant lights, chandeliers, recessed lighting, or ceiling fans.",
    matches: (b) => hasFixtureType(b, "light_fixture"),
  },
];

function selectCategoryBClauses(baseline: StructuralBaseline): { included: CategoryBRule[]; excluded: CategoryBRule[] } {
  const included: CategoryBRule[] = [];
  const excluded: CategoryBRule[] = [];
  for (const rule of CATEGORY_B_RULES) {
    (rule.matches(baseline) ? included : excluded).push(rule);
  }
  return { included, excluded };
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

export function describeCoLocatedFeatures(baseline: StructuralBaseline, anchorWallIndex: number): string[] {
  const openingLines = baseline.openings
    .filter((o) => o.wallIndex === anchorWallIndex)
    .map(
      (o) =>
        `* ${o.id} (${o.type}), in the ${describeVerticalBand(o.verticalBand)} area, ${describeHorizontalBand(o.horizontalBand)} of this wall: must remain fully visible. Do not place artwork, mirrors, shelving, or any wall-mounted decor over it, and do not obstruct it with furniture.`
    );
  const fixtureLines = (baseline.anchorFixtures || [])
    .filter((f) => f.wallIndex === anchorWallIndex)
    .map(
      (f) =>
        `* ${f.id} (${f.type}), in the ${describeHorizontalBand(f.horizontalBand)} of this wall: must remain fully visible and unobstructed. Do not place artwork, mirrors, shelving, or any wall-mounted decor over it.`
    );
  return [...openingLines, ...fixtureLines];
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
    categoryBIncluded: string[];
    categoryBExcluded: string[];
    coLocatedFeatures: string[];
    wallPartiallyVisible: boolean;
  };
};

const SUPPORTED_ROOM_TYPES = new Set(["bedroom"]);

export async function buildAnchorLockedStage2Prompt(opts: {
  imagePath: string;
  roomType: string;
  jobId: string;
  imageId: string;
}): Promise<AnchorLockedPromptResult> {
  const baseDiagnostics = {
    roomType: opts.roomType,
    baselineExtracted: false,
    wallVisibilityExtracted: false,
    anchorWallId: null as string | null,
    anchorConfidence: null as number | null,
    categoryBIncluded: [] as string[],
    categoryBExcluded: [] as string[],
    coLocatedFeatures: [] as string[],
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

  const plan = planBedroomAnchor(baseline, walls);
  if (!plan) {
    return fallback("no_wall_meets_anchor_threshold", baseDiagnostics);
  }
  baseDiagnostics.anchorWallId = plan.anchorWallId;
  baseDiagnostics.anchorConfidence = plan.confidence;
  baseDiagnostics.wallPartiallyVisible = plan.wallPartiallyVisible;

  const { included, excluded } = selectCategoryBClauses(baseline);
  baseDiagnostics.categoryBIncluded = included.map((r) => r.id);
  baseDiagnostics.categoryBExcluded = excluded.map((r) => r.id);

  const categoryBSection =
    included.length > 0
      ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, also do not alter, remove, or obstruct:\n${included.map((r) => `* ${r.clause}`).join("\n")}`
      : "";

  const framingLine = plan.anchorFramingNote ? ` ${plan.anchorFramingNote}` : "";
  const noDecorLine = plan.noDecorAboveBedNote ? `\n* ${plan.noDecorAboveBedNote}` : "";

  const coLocatedFeatures = describeCoLocatedFeatures(baseline, plan.anchorWallIndex);
  baseDiagnostics.coLocatedFeatures = coLocatedFeatures;
  const anchorWallFeaturesSection =
    coLocatedFeatures.length > 0
      ? `\n\nANCHOR WALL — CO-LOCATED FEATURES (must stay fully visible; nothing may cover or obstruct them, including the bed)\n\nThe wall selected for the bed also has the following existing feature(s) on it. Position the bed within the clear segment described above so that it does NOT overlap or obstruct any of these — the bed must be positioned to avoid them, even if that means it does not span the entire wall. No new item (artwork, mirrors, shelving, or any other wall-mounted decor) may be placed over them either, even though it may look conventional to decorate that spot:\n${coLocatedFeatures.join("\n")}`
      : "";

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${categoryBSection}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against ${plan.anchorWallId} in the room analysis, referred to as "${plan.anchorWallLabel}", within the clear segment described as "${plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}${framingLine}${noDecorLine}${anchorWallFeaturesSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the co-located features named above and the no-decor-above-bed rule if it applies. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  nLog("[STAGE2_ANCHOR_LOCKED_PLAN]", {
    jobId: opts.jobId,
    imageId: opts.imageId,
    roomType: opts.roomType,
    anchorWallId: plan.anchorWallId,
    anchorWallLabel: plan.anchorWallLabel,
    anchorWallIndex: plan.anchorWallIndex,
    anchorConfidence: plan.confidence,
    selectionReason: plan.selectionReason,
    categoryBIncluded: baseDiagnostics.categoryBIncluded,
    categoryBExcluded: baseDiagnostics.categoryBExcluded,
    coLocatedFeatures,
    wallPartiallyVisible: plan.wallPartiallyVisible,
    noDecorAboveBedRuleApplied: !!plan.noDecorAboveBedNote,
    fallbackTriggered: false,
  });

  return { prompt, fallbackReason: null, diagnostics: baseDiagnostics };
}
