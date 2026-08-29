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
// SCOPE (as of the room-type coverage extension — see git history for the
// order these were added in):
// - "bedroom": single anchor item (bed), real wall selection via
//   planBedroomAnchor.
// - "study": same single-anchor mechanism as bedroom (planDeskAnchor,
//   sharing planSingleAnchorWall with planBedroomAnchor), desk instead of
//   bed. Distinct from, and does not cover, "office".
// - "living_dining": real zoning split (extractZoning) + multi-anchor
//   (TV/sofa + dining table) via planMultiAnchor.
// - "living_room" / "living" (standalone living): reuses planMultiAnchor
//   and the same circulation-aware floating-sofa logic as living_dining,
//   UNCHANGED, applied to a synthetic whole-room zone instead of a real
//   zoning-extraction result — no second zone exists to split against, so
//   extractZoning is skipped entirely for this room type.
// - "kitchen" / "kitchen_dining" / "kitchen_living": deliberately simple,
//   non-anchor light-staging path (countertop items only) — no zoning
//   extraction, no geometric anchor selection, because a kitchen doesn't
//   need spatial planning the same way a bed or sofa does.
// - "bathroom" / "bathroom_1" / "bathroom_2", "hallway", "garage": same
//   no-anchor, light-staging shape as kitchen, each with its own
//   type-appropriate rule (bathroom: towels/toiletries; hallway: runner
//   rug + conditional console/mirror; garage: structural-protection-only,
//   no staging — a deliberate, time-boxed scope default, see this
//   function's git history / the task report for reasoning).
// Any other room type — and any failure at any stage of baseline
// extraction, wall-visibility extraction, or planning — falls back to
// null (caller uses the existing default prompt path). This module never
// throws; every failure mode returns an explicit, logged fallback reason
// instead.
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

Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing must remain exactly as in the original photo — do not zoom, crop, rotate, widen, narrow, or otherwise shift camera position or perspective. The final image must look like the same photo with furniture simply placed into the scene.`;

// ── Experimental alternate structural-lock text, for the
// STAGE2_PROMPT_VARIANT=grok_skill test branch only (feature/grok-skill-
// prompt-test). Derived from a user-authored Grok skill (nz-property-
// image-staging/SKILL.md) that reportedly produced strong structural-
// preservation results in Grok from a bare "stage this room" request,
// using much terser, legally-grounded phrasing than CATEGORY_A_LOCKS's
// exhaustive bulleted enumeration. This is NOT a replacement for
// CATEGORY_A_LOCKS — it's a like-for-like swap-in used ONLY by
// buildGrokSkillStage2Prompt below, so the existing anchor_locked/grok
// variants are completely unaffected.
//
// Kept from the skill: the concise "never alter" list style and the
// explicit NZ legal grounding (Fair Trading Act / REA Act) — the skill's
// own author's hypothesis is that grounding rules in real misrepresentation
// consequences, not just technical authority language, improves adherence.
// Dropped from the skill: the disclosure/watermark and "refuse if uncertain"
// workflow steps — those are conversational-agent behaviors with no
// analog in a one-shot image-generation prompt; "if uncertain, treat as
// permanent" below is the generation-prompt equivalent of the same
// principle. Kept from CATEGORY_A_LOCKS despite not being in the skill at
// all: the flooring multi-material-boundary/seam clause, and the
// GEOMETRIC ENVELOPE LOCK + camera-perspective constraint blocks — both
// are fixes for real, previously-confirmed production incidents (a lost
// carpet/tile seam; a room's depth silently redrawn without registering as
// camera movement) that the skill's text has no coverage for at all;
// dropping them here would just reintroduce already-fixed bugs for the
// sake of purity to the source text.
// Shared, deliberately compact structural-lock text — reused verbatim by
// both STAGE2_PROMPT_VARIANT=grok_skill (see buildGrokSkillStage2Prompt)
// and STAGE2_PROMPT_VARIANT=combined (see stage2.ts). Named generically
// (not "skill") because it's no longer tied to the Grok-skill experiment
// specifically — it's the one shared "locks" section either variant grafts
// its own layout/staging text around.
export const COMPACT_STRUCTURAL_LOCKS = `STRUCTURAL PRESERVATION — NON-NEGOTIABLE, ZERO TOLERANCE

Strictly preserve every structural and permanent feature of this photograph exactly as it is. You are explicitly and completely prohibited from making ANY change — moving, removing, resizing, reshaping, recoloring, or hiding — to any of the following. Under NZ law (Fair Trading Act 1986, Real Estate Agents Act 2008), a listing photo that misrepresents the property is illegal — every rule below is a legal requirement, not a style preference, and breaking any of them is exactly as serious as fabricating a room that does not exist.

Do not alter, in any way:
- Walls, windows, doors, doorways, archways, and skylights, including their frames, glass, hardware, and the view through them. Keep the floor area in front of and within the swing-path of any door completely clear (minimum 80cm). If a bed or other large item must sit near a window due to room size, keep the full window frame, sill height, and visible glass unchanged behind and around it — never raise the sill or shorten the window to fit furniture.
- Floor material (e.g. hardwood, carpet, tile) and ceiling finish. If two or more distinct flooring materials are visible, each must stay exactly in its original location and boundary — do not blend, unify, or extend one material over another, or smooth over a visible seam. Only place rugs and furniture on top of the existing floor.
- Fireplaces, built-in joinery/cabinetry, stairs, beams, columns, HVAC vents, thermostats, switches, outlets, wall-mounted AC units, baseboards, crown molding, railings, and any other fixed fitting or built-in feature — even if not individually named here.
- Existing ceiling- or wall-mounted light fixtures — these must be preserved exactly as-is.

Do not add any new ceiling-mounted or wall-mounted light fixture as staging decor (no chandeliers, pendant lights, hanging fixtures, or wall sconces). Free-standing or table/floor lamps are permitted as movable decor.

GEOMETRIC ENVELOPE LOCK — NON-NEGOTIABLE, ZERO TOLERANCE, same weight as the list above:
The architectural envelope — every wall's position, length, and angle; every corner; the room's overall shape — must stay geometrically IDENTICAL to the original, independent of camera movement. A redrawn room is just as much a misrepresentation as a removed wall or window, even if nothing was technically deleted. Explicitly and completely prohibited:
* changing wall positions, lengths, angles, or corner locations
* modifying ceiling height or plane geometry, or changing window/door-to-wall ratio
* adjusting depth perspective, compression, or vanishing point alignment
* moving any window, door, or fixture to a different wall than it appears on originally
* mirroring, rotating, or reorganizing the room's layout, even if every object is still present somewhere
Perspective lines, wall intersections, and opening proportions must align exactly with the original. Do NOT "improve" proportions or reinterpret spatial depth, even subtly — the camera may stay still while the geometry is redrawn, and that is equally prohibited.

Camera & Perspective Constraint — NON-NEGOTIABLE:
Camera viewpoint, lens perspective, and framing stay exactly as in the original — no zoom, crop, rotate, or shift. The result must be immediately recognizable as the same room from the same vantage point, not a reconstruction or mirrored/rotated version of it.

Only place wall art, mirrors, or shelving on uninterrupted wall segments with no opening behind or directly adjacent — if wall availability for an item is uncertain, omit that item rather than risk covering a protected feature. If uncertain whether something is permanent, or whether a change alters the room's geometry, treat it as unchanged.`;

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
    if (opening.id.startsWith("W_curtain_")) {
      // Curtain-concealed windows (augmentBaselineWithCurtainConcealedWindows)
      // are, by construction, fabric that shows no glass/frame/sill — visually
      // indistinguishable from a hung textile or wall art. Real production
      // failures (2 Valentine St, Kitchen 01) confirmed the generic sentence
      // below isn't enough: generation-time Gemini doesn't self-classify this
      // ambiguous fabric as "a curtain" in the first place, so an instruction
      // phrased as "protect this window/curtain" never gets applied to it —
      // it just sees replaceable decor. Naming the exact failure mode here
      // (it may look like decor; it isn't) is the fix, not a stronger version
      // of the same generic wording.
      sentences.push(
        `This room has a window that is completely concealed by existing curtain/fabric — ${description}, located at/on ${position}. Even though this fabric may look like a piece of hanging wall art, a valance, or a decorative textile rather than an obvious window curtain, it is concealing a real window and must remain completely unchanged: identical fabric, pattern, shape, and position as shown in the original photo. Do NOT reinterpret, restyle, or replace it as wall art or decor, and do NOT place new artwork over it — misreading this exact kind of fabric as replaceable decor is the single most common real mistake on this feature.`
      );
    } else {
      sentences.push(
        `This room has ${description}, located at/on ${position}. Do not remove, relocate, obstruct, or place new furniture, decor, or artwork over or directly in front of this feature. It must remain exactly as shown in the original photo.`
      );
    }
  }
  for (const fixture of baseline.anchorFixtures || []) {
    const description = fixture.description || fallbackItemDescription(fixture.type);
    const position = describeItemPosition(walls, fixture.wallIndex, fixture.horizontalBand);
    if (fixture.type === "tv_mount") {
      // A TV bracket's purpose is to have a TV mounted on it — the blanket
      // "keep unobstructed, nothing placed over it" wording below directly
      // contradicts planMultiAnchor's bracket-priority TV placement (which
      // reuses this same fixture's description as the TV's target segment),
      // making the model treat "mount a TV here" as violating "protect this
      // fixture" and leave the bracket empty. Carve out the exception at the
      // source so every caller of this shared section gets consistent text.
      sentences.push(
        `This room has ${description}, located at/on ${position}. This is an existing TV wall-mount bracket. Do not remove, relocate, or alter the physical bracket hardware itself — but mounting a TV and a low TV console/unit at this location is expected and correct, not a violation of this rule. Only removing, relocating, or covering the bracket hardware itself is prohibited.`
      );
    } else {
      sentences.push(
        `This room has ${description}, located at/on ${position}. Do not remove, relocate, obstruct, or place new furniture, decor, or artwork over or directly in front of this feature. It must remain exactly as shown in the original photo.`
      );
    }
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
  FLOOR-CLEARANCE RULE — only subtract an opening/fixture's full horizontal span as unusable if it
  touches the floor (touchesFloor: true in the baseline below — e.g. doors, sliding doors,
  walkthroughs, and full-height windows genuinely block furniture placement in front of them). An
  opening with touchesFloor: false (e.g. a half-height or high window with a sill well above floor
  level) does NOT block furniture below it — a bed, headboard, or other furniture can legitimately sit
  against the wall beneath it. Do not subtract a non-floor-touching opening's horizontal span from
  usableWidthFraction or usableSegments; count that span as clear, usable width, exactly as if the
  opening were not there for this purpose. A wall with a real floor-touching door must score lower
  usable width than a wall with a similarly-sized non-floor-touching window — they are not
  interchangeable for this estimate.
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
  // Purely descriptive, model-facing reference to the anchor wall (e.g.
  // "the blank wall on the right side of the image") — built from this
  // same wall's own verified tier data (isBlank/hasAnyWindow/etc, computed
  // from baseline.openings), never from anchorWallLabel or the numeric
  // wall_X id. See the comment on describeWallForPrompt for why: the
  // "wall_0"/"wall_3" index is meaningless to the generation model, and
  // wallLabel comes from a SEPARATE extraction call (extractWallVisibility)
  // that isn't guaranteed to number/describe walls consistently with the
  // structural baseline call that isBlank/openings are computed from — a
  // real production case had wall_0 correctly identified as blank (zero
  // openings on it) but its own wallLabel text still said "Left wall with
  // window", which misled the generation model onto the wrong wall. This
  // field is what the actual prompt text uses instead.
  anchorWallDescription: string;
  anchorSegmentDescription: string;
  anchorOrientationInstruction: string;
  anchorFramingNote: string | null;
  wallPartiallyVisible: boolean;
  noDecorAboveBedNote: string | null;
  confidence: number;
  selectionReason: string;
  // True when tier 4 fired — the anchor wall itself has a door or
  // walkthrough opening on it (used only because no blank/window/return
  // wall qualified). Real production case (Bedroom 12): the anchor plan
  // correctly picked the room's own genuine last-resort wall per this
  // exact tier, but the generated image still placed the bed's footprint
  // across the doorway — nothing in the prompt told the model a doorway
  // needs a clear swing path independent of where the bed itself sits.
  anchorWallHasDoorOrWalkthrough: boolean;
  // The real door/walkthrough id(s) on the anchor wall, when
  // anchorWallHasDoorOrWalkthrough is true — null otherwise. Used to
  // generate the dynamic "ANCHOR WALL — DOOR ACCESS REQUIREMENT" prompt
  // block with the actual detected door id rather than a generic warning.
  doorAccessDoorIds: string[] | null;
};

// Position phrase from the wall's own bounding box in frame — independent
// of any other wall's index/label. Thresholds are deliberately wide
// (roughly thirds of the frame) since this only needs to be unambiguous
// enough for Gemini to pick out the right wall by eye, not pixel-precise.
function describeWallFramePosition(wall: WallVisibilityWall): string {
  const { minX, maxX } = wallBBox(wall);
  const centerX = (minX + maxX) / 2;
  if (centerX < 0.35) return "on the left side of the image";
  if (centerX > 0.65) return "on the right side of the image";
  return "directly ahead, facing the camera";
}

// Builds the model-facing wall reference from this wall's own verified
// tier data — never from wallLabel (a separate, potentially inconsistent
// extraction call's free-form text) or the numeric wall_X id (meaningless
// to an image-generation model). Mirrors selectAnchorWallByTier's own tier
// order so the description always matches the real reason this wall won.
function describeWallForPrompt(tierInfo: WallTierInfo): string {
  const position = describeWallFramePosition(tierInfo.wall);
  if (tierInfo.isBlank) return `the blank wall ${position}`;
  if (tierInfo.hasAnyWindow) return `the wall with the window ${position}`;
  if (tierInfo.hasDoorOrWalkthrough) return `the wall with the door ${position}`;
  return `the wall ${position}`;
}

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

// INCIDENT RESTORATION (see git history around commit 0ba68803): this
// anchor-wall-proximate, position-adjacent protection was removed when
// buildUniversalFeatureProtectionSection was introduced, on the theory
// that the general section already covers every detected item. It does —
// but it lost two properties that made this specific mechanism work for
// the Bedroom 11 (window-walled-over) and Bedroom 14 (door-walled-over)
// incidents it was built for: (1) proximity — this text sits directly
// next to the ANCHOR ITEM — BED instruction, in the same breath as the
// placement decision, not a distant top-of-prompt list; (2) an explicit
// "the bed must be positioned to avoid them" + "even though it may look
// conventional to decorate that spot" framing that the generic section's
// wording doesn't carry. Restored as an ADDITION alongside the universal
// section, not a replacement for it — the universal section still adds
// real value for items the taxonomy can't name (Diningroom 01's bracket).
function describeCoLocatedFeatures(baseline: StructuralBaseline, anchorWallIndex: number): string[] {
  const openingLines = baseline.openings
    .filter((o) => o.wallIndex === anchorWallIndex)
    .map(
      (o) =>
        `* ${o.id} (${o.description || o.type}), in the ${describeVerticalBand(o.verticalBand)} area, ${describeHorizontalBand(o.horizontalBand)} of this wall: must remain fully visible. Do not place artwork, mirrors, shelving, or any wall-mounted decor over it, and do not obstruct it with furniture.`
    );
  const fixtureLines = (baseline.anchorFixtures || [])
    .filter((f) => f.wallIndex === anchorWallIndex)
    .map(
      (f) =>
        `* ${f.id} (${f.description || f.type}), in the ${describeHorizontalBand(f.horizontalBand)} of this wall: must remain fully visible and unobstructed. Do not place artwork, mirrors, shelving, or any wall-mounted decor over it.`
    );
  return [...openingLines, ...fixtureLines];
}

function wallBBox(wall: WallVisibilityWall) {
  const xs = wall.extent.polygon.map((p) => p[0]);
  const ys = wall.extent.polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Shared single-item, single-wall selection mechanism — used by both
// planBedroomAnchor (bed) and planDeskAnchor (desk), and conceptually
// applicable to any future single-anchor room type. planBedroomAnchor
// below is a thin wrapper that passes bed's exact original orientation/
// no-decor text; this function owns wall SELECTION only.
type SingleAnchorItemConfig = {
  buildOrientationInstruction: (focalFeatureId: string | null, focalFeatureType: string | null, focalFeatureWallDescription: string | null) => string;
  buildNoDecorNote?: (wallDescription: string) => string;
};

// ── Four-tier wall-selection decision tree (replaces the old single
// continuous "largest usable segment wins" score). Rebuilt because the
// old scoring treated every wall's clear space as fungible — a wall with
// a big blank stretch next to a small window scored the same as an
// equally-sized wall with no window at all, when a real stager would
// always prefer the genuinely blank wall; and a wall with a door scored
// on size alone even though a door implies foot traffic through it. The
// four tiers below are a strict priority order, not a weighted blend:
// tier 1 always beats tier 2 regardless of any tier-2 wall's size
// advantage, and so on. Size sufficiency (largestSegment >=
// MIN_USABLE_FRACTION_FOR_ANCHOR, the same 0.35 threshold and the same
// wall.usableSegments data as before) is evaluated FIRST, as a floor that
// applies uniformly across all four tiers — a wall that fails it is never
// a candidate at any tier, not just excluded from being "the biggest." ──

const WINDOW_COVERAGE_TIER2_THRESHOLD = 0.5;
// Universal frame-visibility eligibility floor, applied to every tier via
// the shared sizeQualifying pre-filter — the wall's OWN bounding-box span
// as a fraction of the total frame width (wallBBox(wall).maxX - minX), a
// different quantity from usableWidthFraction (a fraction of the WALL's
// own width, not the frame's). A wall that only occupies a thin sliver of
// the frame can't be reasoned about with any confidence, and a bed placed
// against it wouldn't realistically fit or read as staged in the final
// image, regardless of whether that sliver happens to be blank.
//
// Originally 0.15 and scoped to tier 3 ("return wall") only. Raised to
// 0.25 and promoted to a universal floor after a real regression: a
// genuinely blank return-wall sliver at 9.1% of frame width — and,
// separately, another wall at exactly 15% — both cleared the old
// tier-3-only 0.15 bar (one narrowly, one exactly), and because they were
// also blank, tier 1's total absence of any width check let them win
// outright over a substantially visible (36% of frame) wall with only a
// small, high-set window that was clearly the better real bed wall. 0.25
// is a deliberate, documented judgment call — "at least a quarter of the
// frame" — not derived from a larger calibration set; revisit if it proves
// too strict or too lenient against more real cases. See
// tests/bedAnchorWallSelection.test.ts for the preserved regression case.
const MIN_WALL_FRAME_VISIBLE_WIDTH = 0.25;

// Upper-bound numeric estimate for a WallCoverageBand ("5-10" | "10-20" |
// "20-40" | "40-60" | "60+"), used for the tier-2 <50% gate and for
// ranking among qualifying window walls. Deliberately uses each band's
// upper bound rather than its midpoint — a "40-60" window is treated as
// up to 60% for this check, not a hopeful 50% — consistent with this
// file's established pattern of resolving ambiguous extraction data
// toward the safer, more protective reading (e.g. materiality defaults
// elsewhere in this pipeline). An unrecognized/missing band is treated as
// the worst case (1.0) so it fails the gate rather than silently
// qualifying.
function wallCoverageBandUpperBound(band: string): number {
  if (band === "5-10") return 0.1;
  if (band === "10-20") return 0.2;
  if (band === "20-40") return 0.4;
  if (band === "40-60") return 0.6;
  if (band === "60+") return 1.0;
  return 1.0;
}

type WallTierInfo = {
  wall: WallVisibilityWall;
  wallIndex: number;
  largestSegment: number;
  isBlank: boolean;
  hasAnyWindow: boolean;
  windowCoverage: number;
  hasNonFloorWindow: boolean;
  hasDoorOrWalkthrough: boolean;
  hasSlidingDoor: boolean;
  frameVisibleWidth: number;
};

function analyzeWallForTiers(baseline: StructuralBaseline, wall: WallVisibilityWall): WallTierInfo {
  const wallIndex = Number(String(wall.id).replace("wall_", ""));
  const openingsOnWall = baseline.openings.filter((o) => o.wallIndex === wallIndex);
  const fixturesOnWall = (baseline.anchorFixtures || []).filter((f) => f.wallIndex === wallIndex);
  const isBlank = openingsOnWall.length === 0 && fixturesOnWall.length === 0;

  const windowsOnWall = openingsOnWall.filter((o) => o.type === "window");
  const hasAnyWindow = windowsOnWall.length > 0;
  const windowCoverage = windowsOnWall.reduce((sum, w) => sum + wallCoverageBandUpperBound(w.wallCoverageBand), 0);
  // Conservative aggregate: ALL windows on this wall must be non-floor-
  // touching / non-full-height for the wall to earn the "higher-
  // positioned" preference — one floor-length window is enough to treat
  // the wall as floor-touching for ranking purposes, the safer reading.
  const hasNonFloorWindow = hasAnyWindow && windowsOnWall.every((w) => !w.touchesFloor && w.verticalBand !== "full_height");

  // Circulation-implying openings only: real doors and walkthroughs create
  // foot traffic through the wall into another space. Closet doors are
  // deliberately excluded from this category — a closet door doesn't lead
  // anywhere a person walks, so it doesn't carry the same "don't block
  // this path" reasoning tier 4 exists for. A wall with only a closet
  // door on it is not blank, not a window wall, and not a door wall in
  // this scheme — it falls to tier 3, gated by the same visibility
  // threshold as any other non-door wall. Documented judgment call, not
  // an oversight.
  const circulationOpenings = openingsOnWall.filter((o) => o.type === "door" || o.type === "walkthrough");
  const hasDoorOrWalkthrough = circulationOpenings.length > 0;
  const hasSlidingDoor = circulationOpenings.some((o) => o.paneStructure === "sliding_panel");

  const largestSegment = wall.usableSegments.reduce((max, s) => Math.max(max, s.widthFraction), 0);
  const { minX, maxX } = wallBBox(wall);

  return { wall, wallIndex, largestSegment, isBlank, hasAnyWindow, windowCoverage, hasNonFloorWindow, hasDoorOrWalkthrough, hasSlidingDoor, frameVisibleWidth: maxX - minX };
}

function selectAnchorWallByTier(baseline: StructuralBaseline, walls: WallVisibilityWall[]): { info: WallTierInfo; reason: string } | null {
  const analyzed = walls.map((w) => analyzeWallForTiers(baseline, w));

  // Floor requirement, applied before any tier is evaluated: no wall is a
  // candidate anywhere below unless it clears BOTH of these bars first.
  //
  // largestSegment is WALL-RELATIVE (what fraction of THIS wall's own
  // visible span is clear) — it says nothing about how large the wall
  // actually is in the photo. frameVisibleWidth is the missing FRAME-
  // RELATIVE half of that picture. Real production regression: a tiny
  // return-wall sliver occupying just 9% of the frame width, where that
  // entire 9% happened to be unobstructed, scored a perfect 1.000 on
  // largestSegment alone and — being also genuinely blank — won tier 1
  // outright, ahead of a substantially visible (36% of frame) wall with
  // only a small, high-set window that was clearly the better real bed
  // wall. frameVisibleWidth was already being computed and already used
  // to gate tier 3 specifically (MIN_WALL_FRAME_VISIBLE_WIDTH) —
  // this wall's own 9% didn't even clear THAT bar, which would have
  // rejected it outright had it not been blank. The fix is to apply the
  // same visibility floor uniformly to every tier via this shared
  // pre-filter, not just tier 3: a wall has to actually be a credible,
  // substantially-visible staging surface before "blank" or "narrowest
  // window" gets to decide anything. See tests/bedAnchorWallSelection.test.ts
  // for this exact case preserved as a regression test.
  const sizeQualifying = analyzed.filter(
    (w) => w.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR && w.frameVisibleWidth >= MIN_WALL_FRAME_VISIBLE_WIDTH
  );
  if (sizeQualifying.length === 0) return null;

  // Tier 1 — genuinely blank wall wins outright, regardless of any other
  // wall's size advantage. Ties broken by largest usable segment.
  const blankWalls = sizeQualifying.filter((w) => w.isBlank);
  if (blankWalls.length > 0) {
    const picked = [...blankWalls].sort((a, b) => b.largestSegment - a.largestSegment)[0];
    return { info: picked, reason: `tier 1: ${picked.wall.id} (${picked.wall.wallLabel}) — zero openings or fixtures detected on this wall, blank wall takes outright priority over every other candidate.` };
  }

  // Tier 2 — sub-50% window wall, least coverage first, higher-positioned
  // window preferred over floor-touching/full-height as the tiebreak.
  // This is an ADDITIVE signal computed directly from baseline.openings'
  // own wallCoverageBand/touchesFloor fields — it does not read or
  // override wall.usableWidthFraction (which still comes from the
  // existing floor-clearance mechanism in the wall-visibility extraction
  // prompt and still gates the size floor above). The two mechanisms
  // COMBINE rather than one superseding the other: floor-clearance
  // continues to ensure a high, non-floor-touching window doesn't get
  // unfairly zeroed out of size eligibility; tier 2 separately uses the
  // baseline's own coverage/position data to rank window-walls against
  // each other and against every other tier. Deliberately not merged
  // into one mechanism — they read different raw data for different
  // purposes, and combining them keeps the size floor's meaning
  // unchanged for every existing caller.
  // hasDoorOrWalkthrough excluded here too, not just at tier 3: a wall
  // with both a window and a door is still a door wall for circulation
  // purposes — the window doesn't cancel the "foot traffic through this
  // wall" reasoning tier 4 exists for. Reserving every door-having wall
  // for tier 4 (and its dedicated clear-segment calculation below) means
  // hasDoorOrWalkthrough on the wall selectAnchorWallByTier ultimately
  // returns is now a reliable signal that tier 4 fired, not something a
  // caller has to infer from the reason string.
  const windowWalls = sizeQualifying.filter((w) => w.hasAnyWindow && !w.hasDoorOrWalkthrough && w.windowCoverage < WINDOW_COVERAGE_TIER2_THRESHOLD);
  if (windowWalls.length > 0) {
    const picked = [...windowWalls].sort((a, b) => {
      if (a.windowCoverage !== b.windowCoverage) return a.windowCoverage - b.windowCoverage;
      if (a.hasNonFloorWindow !== b.hasNonFloorWindow) return a.hasNonFloorWindow ? -1 : 1;
      return b.largestSegment - a.largestSegment;
    })[0];
    return {
      info: picked,
      reason: `tier 2: ${picked.wall.id} (${picked.wall.wallLabel}) — window coverage ${picked.windowCoverage.toFixed(2)} (< ${WINDOW_COVERAGE_TIER2_THRESHOLD} threshold), ${picked.hasNonFloorWindow ? "higher-positioned (non-floor-touching)" : "includes a floor-touching/full-height window"}. Combines with (does not supersede) the existing floor-clearance usable-width mechanism — see reconciliation note above.`,
    };
  }

  // Tier 3 — return wall, gated by a real frame-visibility threshold, not
  // a qualitative judgment. Door/walkthrough walls are excluded entirely
  // here (reserved for tier 4) so a door-wall can never sneak into tier 3
  // on visibility alone. Ties broken by the most substantially visible.
  const nonDoorWalls = sizeQualifying.filter((w) => !w.hasDoorOrWalkthrough);
  const returnWalls = nonDoorWalls.filter((w) => w.frameVisibleWidth >= MIN_WALL_FRAME_VISIBLE_WIDTH);
  if (returnWalls.length > 0) {
    const picked = [...returnWalls].sort((a, b) => b.frameVisibleWidth - a.frameVisibleWidth)[0];
    return {
      info: picked,
      reason: `tier 3: ${picked.wall.id} (${picked.wall.wallLabel}) — return wall, frame-visible width ${picked.frameVisibleWidth.toFixed(3)} >= ${MIN_WALL_FRAME_VISIBLE_WIDTH} threshold.`,
    };
  }

  // Tier 4 — wall containing a door, lowest priority, reached only when
  // nothing above qualified at all: a door implies an active circulation
  // path through that wall, so placing a large anchor item there is more
  // disruptive than any alternative, even when the wall itself is large
  // enough. Within this tier, a sliding/glass door wall is preferred over
  // a hinged/walkthrough interior door wall — a sliding/glass door
  // typically retains genuine usable floor area directly in front of it,
  // while an interior walkthrough implies a narrower, more direct travel
  // path that's worse to place furniture near.
  const doorWalls = sizeQualifying.filter((w) => w.hasDoorOrWalkthrough);
  if (doorWalls.length > 0) {
    const picked = [...doorWalls].sort((a, b) => {
      if (a.hasSlidingDoor !== b.hasSlidingDoor) return a.hasSlidingDoor ? -1 : 1;
      return b.largestSegment - a.largestSegment;
    })[0];
    const failedReturnWalls = nonDoorWalls.filter((w) => w.wall.id !== picked.wall.id);
    const failedReturnWallsNote =
      failedReturnWalls.length > 0
        ? failedReturnWalls.map((w) => `${w.wall.id} visible width ${w.frameVisibleWidth.toFixed(3)} below ${MIN_WALL_FRAME_VISIBLE_WIDTH} threshold`).join(", ")
        : "no other non-door wall was size-qualifying";
    return {
      info: picked,
      reason: `tier 4: ${picked.wall.id} (${picked.wall.wallLabel}) — ${picked.hasSlidingDoor ? "sliding/glass door" : "hinged/walkthrough interior door"}. No blank wall, no qualifying sub-50% window wall, no return wall met the ${MIN_WALL_FRAME_VISIBLE_WIDTH} visibility threshold (${failedReturnWallsNote}).`,
    };
  }

  // Defensive fallback beyond the four described tiers: a wall that is
  // not blank, has no qualifying window, has no door/walkthrough, AND
  // fails the tier-3 visibility threshold (e.g. a wall with only a
  // closet door or a fixture, that's also a thin frame sliver) isn't
  // covered by any of tiers 1-4 as specified. Rather than silently
  // returning null and forcing an unnecessary fallback to the legacy
  // prompt when a real, size-qualifying wall does exist, pick the largest
  // remaining size-qualifying wall and log it plainly as outside the
  // four-tier scheme, so this is honestly distinguishable from a real
  // tier 1-4 selection if it ever fires.
  const picked = [...sizeQualifying].sort((a, b) => b.largestSegment - a.largestSegment)[0];
  return {
    info: picked,
    reason: `tier 5 (defensive fallback, outside the four described tiers): ${picked.wall.id} (${picked.wall.wallLabel}) — not blank, no qualifying window, no door/walkthrough, and below the tier-3 visibility threshold (frame-visible width ${picked.frameVisibleWidth.toFixed(3)}); picked as the largest remaining size-qualifying wall rather than discarding a viable anchor plan.`,
  };
}

// Extends the door's own bbox by this fraction of its own width on each
// side as a swing/circulation allowance — the floor area a person actually
// needs to pass through a doorway is wider than the bare opening itself.
// No real-world measurement backs the exact 0.5 — it's a documented,
// conservative default (half the door's own width added on each side)
// pending real feedback on whether it's too generous or too tight.
const DOOR_CLEARANCE_BUFFER_FRACTION = 0.5;
// Reuses the same wall-relative "big enough for a bed" bar as every other
// tier (MIN_USABLE_FRACTION_FOR_ANCHOR) — a clear segment on a door wall
// isn't held to a different standard than a clear segment anywhere else.
const MIN_DOOR_WALL_CLEAR_SEGMENT = MIN_USABLE_FRACTION_FOR_ANCHOR;

type DoorClearSegment = { doorIds: string[]; segmentDescription: string; clearFraction: number };

// Real requirement, not a detect-and-hope: when a door wall is the anchor
// (tier 4 — reached only when nothing else qualified), the bed must be
// placed in a segment of that wall that deterministically excludes the
// doorway and its circulation allowance, not just "somewhere on this wall,
// please don't touch the door." Computed entirely from this wall's own
// bbox and the door's own bbox (both already-detected baseline data) — no
// new extraction call. Returns null (caller falls back to the wall's own
// reported usableSegments) when no door is on this wall, or when neither
// side of the door leaves enough clear width for a bed.
function computeDoorClearSegment(
  baseline: StructuralBaseline,
  wall: WallVisibilityWall,
  wallIndex: number
): DoorClearSegment | null {
  const doorsOnWall = baseline.openings.filter(
    (o) => o.wallIndex === wallIndex && (o.type === "door" || o.type === "walkthrough")
  );
  if (doorsOnWall.length === 0) return null;

  const { minX, maxX } = wallBBox(wall);
  const wallWidth = maxX - minX;
  if (wallWidth <= 0) return null;

  // Each door's own bbox, converted from frame-relative to wall-relative
  // [0,1], then padded by DOOR_CLEARANCE_BUFFER_FRACTION of its own width
  // on both sides.
  const exclusions = doorsOnWall
    .map((o) => {
      const rawStart = (o.bbox[0] - minX) / wallWidth;
      const rawEnd = (o.bbox[2] - minX) / wallWidth;
      const doorWidth = Math.max(0, rawEnd - rawStart);
      const buffer = doorWidth * DOOR_CLEARANCE_BUFFER_FRACTION;
      return { start: Math.max(0, rawStart - buffer), end: Math.min(1, rawEnd + buffer) };
    })
    .sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent exclusion ranges (more than one door on the
  // same wall) into one continuous list before finding the gaps between
  // them.
  const merged: { start: number; end: number }[] = [];
  for (const r of exclusions) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  const gaps: { start: number; end: number }[] = [{ start: 0, end: merged[0].start }];
  for (let i = 0; i < merged.length - 1; i++) {
    gaps.push({ start: merged[i].end, end: merged[i + 1].start });
  }
  gaps.push({ start: merged[merged.length - 1].end, end: 1 });

  let bestIdx = 0;
  let bestWidth = -1;
  gaps.forEach((g, i) => {
    const width = Math.max(0, g.end - g.start);
    if (width > bestWidth) {
      bestWidth = width;
      bestIdx = i;
    }
  });
  if (bestWidth < MIN_DOOR_WALL_CLEAR_SEGMENT) return null;

  const best = gaps[bestIdx];
  const doorIds = doorsOnWall.map((o) => o.id);
  const doorList = doorIds.length === 1 ? doorIds[0] : doorIds.join(" and ");
  const positionPhrase =
    bestIdx === 0
      ? `the portion of this wall to the left of ${doorList}`
      : bestIdx === gaps.length - 1
        ? `the portion of this wall to the right of ${doorList}`
        : `the clear portion of this wall between ${doorList}`;

  return {
    doorIds,
    clearFraction: bestWidth,
    segmentDescription: `${positionPhrase} (roughly ${(best.start * 100).toFixed(0)}%–${(best.end * 100).toFixed(0)}% along the wall)`,
  };
}

// Dynamic, door-id-specific instruction block appended when the anchor
// wall itself contains a door/walkthrough (tier 4 — last resort). This is
// deliberately more than the protected-feature section's generic "don't
// remove this opening" line: it explicitly frames the doorway as an
// active circulation route that staged furniture must not block, since a
// bed or desk placed carelessly on a door wall is a materially worse
// failure (blocked access, obstructed swing, an unusable room) than the
// same misjudgment on a blank wall. Real production case: Bedroom 12's
// bed ended up placed across the doorway despite the door being correctly
// listed as a protected opening — that section protects the opening
// itself from being altered, it never told the model the floor space in
// front of it has to stay clear too.
function buildDoorAccessRequirementSection(plan: AnchorPlan, itemLabel: string, companionItems: string[] = []): string {
  if (!plan.anchorWallHasDoorOrWalkthrough || !plan.doorAccessDoorIds || plan.doorAccessDoorIds.length === 0) {
    return "";
  }
  const doorIds = plan.doorAccessDoorIds;
  const doorList = doorIds.length === 1 ? doorIds[0] : doorIds.join(" and ");
  const isPlural = doorIds.length > 1;
  const otherItemsPhrase = companionItems.length > 0 ? `${companionItems.join(", ")}, or any other staged furniture` : "any other staged furniture";
  return `

ANCHOR WALL — DOOR ACCESS REQUIREMENT (must be followed exactly)

The selected ${itemLabel} wall contains existing doorway ${doorList}.

${doorList} ${isPlural ? "are protected circulation routes" : "is a protected circulation route"} and MUST remain completely open and usable.

Do NOT place the ${itemLabel}, ${otherItemsPhrase}, across, in front of, or immediately obstructing the doorway.

Maintain clear, unobstructed movement through the doorway into and out of the room.

Place the ${itemLabel} only within the calculated clear wall segment described above, which already excludes ${doorList} and its required access/circulation space.

Preserve the existing doorway position, opening, width, swing, and surrounding wall geometry.`;
}

function planSingleAnchorWall(baseline: StructuralBaseline, walls: WallVisibilityWall[], config: SingleAnchorItemConfig): AnchorPlan | null {
  const selection = selectAnchorWallByTier(baseline, walls);

  // Production behavior differs from the tmp/ exploratory scripts here:
  // those always returned a plan (with a low-confidence fallback wall) so
  // the reasoning could be inspected. In production, "no wall confidently
  // qualifies" is itself a fallback trigger — callers should use the
  // existing prompt path rather than stage the anchor item against a wall
  // that doesn't have enough clear space, however plausible-looking.
  if (!selection) {
    return null;
  }

  const selectedWall = selection.info.wall;
  const bestSegment = [...selectedWall.usableSegments].sort((a, b) => b.widthFraction - a.widthFraction)[0];
  const selectedWallIndex = selection.info.wallIndex;

  // hasDoorOrWalkthrough is now reliable as "tier 4 fired" (tiers 1-3 all
  // exclude door-having walls — see their own comments) — when true,
  // prefer a deterministically-computed, door-clearance-aware segment over
  // the wall-visibility extraction's own generic usableSegments guess.
  // Falls back to bestSegment when no viable segment exists on either side
  // of the door (rather than blocking the whole plan over it).
  const doorClearSegment = selection.info.hasDoorOrWalkthrough
    ? computeDoorClearSegment(baseline, selectedWall, selectedWallIndex)
    : null;
  const anchorSegmentDescription = doorClearSegment?.segmentDescription ?? bestSegment.description;

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
  // Same principle as anchorWallDescription below: describe the focal
  // feature's wall by its own frame position, never by its numeric wall_X
  // id, which is meaningless to the generation model.
  const focalFeatureWall = focalFeatureWallIndex !== null ? walls.find((w) => w.id === `wall_${focalFeatureWallIndex}`) : undefined;
  const focalFeatureWallDescription = focalFeatureWall ? describeWallFramePosition(focalFeatureWall) : null;
  const anchorOrientationInstruction = config.buildOrientationInstruction(focalFeatureId, focalFeatureType, focalFeatureWallDescription);

  const anchorWallDescription = describeWallForPrompt(selection.info);

  const { minX, maxX } = wallBBox(selectedWall);
  const touchesRight = maxX >= 1 - FRAME_EDGE_EPSILON;
  const touchesLeft = minX <= FRAME_EDGE_EPSILON;
  const wallPartiallyVisible = touchesLeft || touchesRight;
  const anchorFramingNote = wallPartiallyVisible
    ? `${anchorWallDescription} is only partially visible in the frame (truncated at the ${touchesRight ? "right" : "left"} edge). Edge-cropped placement is acceptable.`
    : null;

  // A wall that's cropped by the frame edge can't be fully verified —
  // whatever's just off-frame (another opening, a fixture) isn't visible
  // to the baseline extraction at all, so co-located-feature protection
  // can't cover it either. Bedroom 11/14 both involved decor or the bed
  // itself landing on an opening that undermined a "should be fine"
  // assumption about the wall; an edge-cropped wall is exactly the case
  // where that assumption is least trustworthy. Conservative backstop:
  // no wall-mounted decor above the anchor item at all on a wall we can't
  // fully see, where the caller opts into this note at all.
  const noDecorAboveBedNote = wallPartiallyVisible && config.buildNoDecorNote ? config.buildNoDecorNote(anchorWallDescription) : null;

  return {
    anchorWallId: selectedWall.id,
    anchorWallLabel: selectedWall.wallLabel,
    anchorWallIndex: selectedWallIndex,
    anchorWallDescription,
    anchorSegmentDescription,
    anchorOrientationInstruction,
    anchorFramingNote,
    wallPartiallyVisible,
    noDecorAboveBedNote,
    confidence: Math.min(selectedWall.confidence, 0.9),
    selectionReason: `${selection.reason} (clear segment: "${anchorSegmentDescription}", ${selection.info.largestSegment.toFixed(3)} >= ${MIN_USABLE_FRACTION_FOR_ANCHOR} size floor.)${doorClearSegment ? ` [door-clearance-computed segment, excludes ${doorClearSegment.doorIds.join("/")} plus circulation buffer]` : ""}`,
    anchorWallHasDoorOrWalkthrough: selection.info.hasDoorOrWalkthrough,
    doorAccessDoorIds: doorClearSegment?.doorIds ?? (selection.info.hasDoorOrWalkthrough ? baseline.openings.filter((o) => o.wallIndex === selectedWallIndex && (o.type === "door" || o.type === "walkthrough")).map((o) => o.id) : null),
  };
}

export function planBedroomAnchor(baseline: StructuralBaseline, walls: WallVisibilityWall[]): AnchorPlan | null {
  return planSingleAnchorWall(baseline, walls, {
    buildOrientationInstruction: (focalFeatureId, focalFeatureType, focalFeatureWallDescription) =>
      focalFeatureId
        ? `Orient the bed so its foot end points toward ${focalFeatureId} (the ${focalFeatureType} ${focalFeatureWallDescription || "on the opposite wall"}) — NOT toward the camera. The camera should see the long side profile of the bed, not the headboard/footboard face-on.`
        : `No focal opening identified; orient the bed facing into the open floor area of the room.`,
    buildNoDecorNote: (wallDescription) =>
      `${wallDescription} is only partially visible in this photo, so its full extent cannot be verified. Do NOT place any wall-mounted artwork, mirrors, shelving, or other decor above the bed on this wall, even if it looks like there is room for it — leave the wall above the headboard bare.`,
  });
}

// Study's desk anchor — same wall-selection mechanism as bedroom's bed
// anchor (largest-qualifying-usable-segment wall, off-anchor-wall focal
// opening for orientation), per the task's explicit instruction to reuse
// bedroom's mechanism rather than invent a new one. No noDecorNote: the
// bed's version exists because headboard-adjacent decor was a real
// incident category (Bedroom 11); no equivalent incident exists for
// desks, so this deliberately doesn't invent a defensive rule that has no
// grounding.
function planDeskAnchor(baseline: StructuralBaseline, walls: WallVisibilityWall[]): AnchorPlan | null {
  return planSingleAnchorWall(baseline, walls, {
    buildOrientationInstruction: (focalFeatureId, focalFeatureType, focalFeatureWallDescription) =>
      focalFeatureId
        ? `Orient the desk so a person sitting at it would face toward ${focalFeatureId} (the ${focalFeatureType} ${focalFeatureWallDescription || "on the opposite wall"}) for natural light and an outward view — do not place the desk facing directly into the wall with its back to the room.`
        : `No focal opening identified; orient the desk facing into the open floor area of the room, not directly facing the wall.`,
  });
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

type DiningPlan = { center: Point; footprint: { halfWidth: number; halfHeight: number }; reasoning: string; nearKitchen?: boolean };
// wallDescription on both plans below is the same model-facing, position-
// based reference used for the bedroom/study anchor (see
// describeWallForPrompt's comment) — wallId/wallLabel are kept for
// diagnostics/logging only and must not be placed in prompt text.
type TvPlan = { wallId: string; wallLabel: string; wallDescription: string; segmentDescription: string; largestSegment: number; depthCheckFlaggedSuspect: boolean; reasoning: string; usedBracket: boolean };
type SofaPlan = { wallId: string | null; wallLabel?: string; wallDescription?: string; floorCentered?: boolean; facingWallId: string | null; orientationInstruction?: string; facingDescription?: string; reasoning: string; hasDoorOrWalkthrough?: boolean };
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

// Prefer a candidate wall with no door/walkthrough opening on it; only fall
// back to a door/walkthrough wall when it's the only qualifying candidate.
// Mirrors the bedroom/study anchor tier system's own "door wall is last
// resort" principle (selectAnchorWallByTier's tier 4), applied here to the
// living-zone sofa's wall-anchored placement, which previously had no such
// preference at all and could freely land on a wall with an active door or
// walkthrough on it, blocking circulation.
function pickSofaWallCandidate(
  candidates: { wall: WallVisibilityWall; largestSegment: number }[],
  baseline: StructuralBaseline
): { wall: WallVisibilityWall; largestSegment: number; hasDoorOrWalkthrough: boolean } | undefined {
  const wallHasDoorOrWalkthrough = (wallIndex: number) =>
    baseline.openings.some((o) => o.wallIndex === wallIndex && (o.type === "door" || o.type === "walkthrough"));
  const withDoorFlag = candidates.map((c) => ({
    ...c,
    hasDoorOrWalkthrough: wallHasDoorOrWalkthrough(Number(String(c.wall.id).replace("wall_", ""))),
  }));
  const nonDoorCandidates = withDoorFlag.filter((c) => !c.hasDoorOrWalkthrough);
  return nonDoorCandidates[0] || withDoorFlag[0];
}

function planMultiAnchor(
  baseline: StructuralBaseline,
  walls: WallVisibilityWall[],
  zones: LivingDiningZone[],
  kitchenSignal?: KitchenSignal | null
): MultiAnchorPlan {
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");
  const reasoning: string[] = [];
  let depthCheckFlaggedSuspect = false;
  const wallByIndex = (idx: number) => walls.find((w) => Number(String(w.id).replace("wall_", "")) === idx);

  let diningPlan: DiningPlan | null = null;
  if (diningZone && diningZone.floorRegion?.polygon && diningZone.floorRegion.polygon.length >= 3) {
    const centroid = polygonCentroid(diningZone.floorRegion.polygon);
    const bbox = polygonBBox(diningZone.floorRegion.polygon);

    // Real-world request: the dining table should land near the kitchen,
    // not just at the raw centroid of whatever floor area the zoning call
    // drew for the dining zone. Two possible signals for "where the
    // kitchen is," checked in order of directness: (1) a kitchen_island
    // (or similar) anchor fixture actually bordering this dining zone —
    // direct visual evidence; (2) extractZoning's own kitchenSignal, which
    // names an opening believed to lead toward/give sightline into a
    // kitchen — indirect, but still real evidence when no island fixture
    // is in frame. Neither field was previously consulted anywhere; the
    // centroid alone was standing in for "near the kitchen" purely by
    // chance whenever the zoning call's own polygon happened to lean that
    // way.
    const diningBorderingWalls = new Set(diningZone.borderingWallIndices || []);
    const kitchenIslandFixture = (baseline.anchorFixtures || []).find(
      (f) => f.type === "kitchen_island" && diningBorderingWalls.has(f.wallIndex)
    );
    const kitchenOpeningWallIndex = !kitchenIslandFixture && kitchenSignal?.present && kitchenSignal.openingId
      ? baseline.openings.find((o) => o.id === kitchenSignal.openingId)?.wallIndex
      : undefined;
    const kitchenWallIndex = kitchenIslandFixture?.wallIndex
      ?? (kitchenOpeningWallIndex !== undefined && diningBorderingWalls.has(kitchenOpeningWallIndex) ? kitchenOpeningWallIndex : undefined);
    const kitchenWall = kitchenWallIndex !== undefined ? wallByIndex(kitchenWallIndex) : undefined;

    let center = centroid;
    let nearKitchen = false;
    let kitchenReasoning = "";
    if (kitchenWall) {
      const kitchenWallBBox = polygonBBox(kitchenWall.extent.polygon);
      const kitchenWallMidX = (kitchenWallBBox.minX + kitchenWallBBox.maxX) / 2;
      // Blend 45% of the way from the zone's own centroid toward the
      // kitchen wall's midpoint — meaningfully pulls the table toward the
      // kitchen side without abandoning the zoning call's own read of the
      // dining zone's real floor extent.
      const blended: Point = [centroid[0] * 0.55 + kitchenWallMidX * 0.45, centroid[1]];
      center = blended;
      nearKitchen = true;
      kitchenReasoning = kitchenIslandFixture
        ? ` Biased toward ${kitchenWall.id} (${kitchenWall.wallLabel}) — kitchen island/peninsula ${kitchenIslandFixture.id} detected on this wall.`
        : ` Biased toward ${kitchenWall.id} (${kitchenWall.wallLabel}) — kitchenSignal indicates opening ${kitchenSignal?.openingId} on this wall leads toward the kitchen.`;
    }

    diningPlan = {
      center,
      footprint: { halfWidth: Math.min(0.12, (bbox.maxX - bbox.minX) * 0.35), halfHeight: Math.min(0.08, (bbox.maxY - bbox.minY) * 0.3) },
      reasoning: `Table centered within zone_dining (raw centroid [${centroid[0].toFixed(3)}, ${centroid[1].toFixed(3)}]).${kitchenReasoning}`,
      nearKitchen,
    };
  }

  let tvPlan: TvPlan | null = null;
  let noTvReason: string | null = null;
  let sofaPlan: SofaPlan | null = null;

  if (livingZone) {
    const livingWallIndices: number[] = livingZone.borderingWallIndices || [];
    const otherZonesWallIndices = new Set<number>(zones.filter((z) => z.id !== livingZone.id).flatMap((z) => z.borderingWallIndices || []));
    const exclusiveLivingWallIndices = livingWallIndices.filter((idx) => !otherZonesWallIndices.has(idx));

    const zoneBBox = livingZone.floorRegion?.polygon ? polygonBBox(livingZone.floorRegion.polygon) : null;
    const zoneDepthProxy = zoneBBox ? zoneBBox.maxY - zoneBBox.minY : 0;
    const depthOk = zoneDepthProxy >= MIN_ZONE_DEPTH_FOR_TV_FACING;
    reasoning.push(`Living zone floor-region depth proxy: ${zoneDepthProxy.toFixed(3)} (threshold ${MIN_ZONE_DEPTH_FOR_TV_FACING}) — ${depthOk ? "sufficient" : "insufficient"}.`);

    // Real-world incident: a room had an actual TV wall-mount bracket
    // (baseline.anchorFixtures, type tv_mount) on one wall, but the
    // geometric candidate search below picked a DIFFERENT wall (the window
    // wall) purely on usable-width/depth scoring, ignoring the bracket
    // entirely. An existing bracket is direct physical evidence of where
    // the room's own TV goes — it takes priority over geometric scoring
    // whenever one is detected on any wall bordering the living zone,
    // without needing to also clear the width/depth thresholds below
    // (those exist to guess a plausible wall in the ABSENCE of direct
    // evidence; they're moot once a real mount is found). Prefer a
    // zone-exclusive bracket wall if one exists, otherwise accept a
    // bracket on a wall shared with another zone.
    const bracketFixtures = (baseline.anchorFixtures || []).filter(
      (f) => f.type === "tv_mount" && livingWallIndices.includes(f.wallIndex)
    );
    const bracketFixture =
      bracketFixtures.find((f) => exclusiveLivingWallIndices.includes(f.wallIndex)) || bracketFixtures[0];
    const bracketWall = bracketFixture ? wallByIndex(bracketFixture.wallIndex) : undefined;

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
    if (!bracketWall && !depthOk && tvCandidatesRaw[0]) {
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

    const tvCandidate = bracketWall
      ? { wall: bracketWall, largestSegment: (bracketWall.usableSegments || []).reduce((m, s) => Math.max(m, s.widthFraction), 0) }
      : (depthOk ? tvCandidatesRaw[0] : undefined);

    if (tvCandidate) {
      const seg = [...(tvCandidate.wall.usableSegments || [])].sort((a, b) => b.widthFraction - a.widthFraction)[0];
      tvPlan = {
        wallId: tvCandidate.wall.id,
        wallLabel: tvCandidate.wall.wallLabel,
        wallDescription: `the wall ${describeWallFramePosition(tvCandidate.wall)}`,
        segmentDescription: bracketFixture
          ? (bracketFixture.description || seg?.description || "at the existing TV mount bracket's location")
          : (seg?.description || ""),
        largestSegment: tvCandidate.largestSegment,
        depthCheckFlaggedSuspect,
        usedBracket: !!bracketWall,
        reasoning: bracketWall
          ? `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) has an existing TV wall-mount bracket detected (${bracketFixture!.id}) — used directly, ahead of geometric wall scoring.`
          : `TV wall selected: ${tvCandidate.wall.id} (${tvCandidate.wall.wallLabel}) is zone-exclusive, clears TV width threshold (${tvCandidate.largestSegment.toFixed(3)} >= ${TV_MIN_USABLE_FRACTION}), zone depth sufficient.`,
      };
      reasoning.push(tvPlan.reasoning);

      const sofaCandidates = livingWallIndices
        .map((idx) => wallByIndex(idx))
        .filter((w): w is WallVisibilityWall => !!w)
        .filter((w) => w.id !== tvCandidate.wall.id)
        .map((w) => ({ wall: w, largestSegment: (w.usableSegments || []).reduce((m, s) => Math.max(m, s.widthFraction), 0) }))
        .filter((c) => c.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR)
        .sort((a, b) => b.largestSegment - a.largestSegment);
      const sofaPick = pickSofaWallCandidate(sofaCandidates, baseline);
      sofaPlan = sofaPick
        ? { wallId: sofaPick.wall.id, wallLabel: sofaPick.wall.wallLabel, wallDescription: `the wall ${describeWallFramePosition(sofaPick.wall)}`, facingWallId: tvCandidate.wall.id, hasDoorOrWalkthrough: sofaPick.hasDoorOrWalkthrough, reasoning: `Sofa placed against ${sofaPick.wall.id}, facing ${tvCandidate.wall.id}.${sofaPick.hasDoorOrWalkthrough ? " This wall has a door/walkthrough — used only because no other living-zone wall qualified." : ""}` }
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
      const sofaPick = pickSofaWallCandidate(sofaCandidates, baseline);
      const sofaWall = sofaPick?.wall || null;
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
      const focalFeatureWall = focalFeatureWallIndex !== null ? livingWallIndices.map((idx) => wallByIndex(idx)).find((w) => w?.id === `wall_${focalFeatureWallIndex}`) : undefined;
      const focalFeatureWallDescription = focalFeatureWall ? describeWallFramePosition(focalFeatureWall) : null;
      const facingDescription = focalFeatureId
        ? `toward ${focalFeatureId} (the ${focalFeatureType} ${focalFeatureWallDescription || "on the opposite wall"})`
        : `into the open floor area of the room`;
      const orientationInstruction = focalFeatureId
        ? `Orient the sofa to face toward ${focalFeatureId} (the ${focalFeatureType} ${focalFeatureWallDescription || "on the opposite wall"}).`
        : `No focal opening identified; orient the sofa facing into the open floor area of the room.`;
      sofaPlan = sofaWall
        ? { wallId: sofaWall.id, wallLabel: sofaWall.wallLabel, wallDescription: `the wall ${describeWallFramePosition(sofaWall)}`, facingWallId: null, orientationInstruction, facingDescription, hasDoorOrWalkthrough: sofaPick?.hasDoorOrWalkthrough, reasoning: `Sofa placed against ${sofaWall.id} — no TV to face. ${orientationInstruction}${sofaPick?.hasDoorOrWalkthrough ? " This wall has a door/walkthrough — used only because no other living-zone wall qualified." : ""}` }
        : { wallId: null, floorCentered: true, facingWallId: null, orientationInstruction, facingDescription, reasoning: `No living-zone wall qualified; floor-centered. ${orientationInstruction}` };
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

// Floating vs. wall-anchored is decided on its own merits — clear floor
// depth and circulation clearance — never on whether a TV happens to be
// present. A floating sofa facing the TV is one possible OUTCOME when a TV
// exists and floating is practical; it is not, and never was, a rule that
// floating only applies because of a TV. This always evaluates floating
// first and falls back to the (door-avoiding) wall-anchored plan already
// computed on plan.sofaPlan when floating isn't practical here.
function resolveSofaPlacement(
  baseline: StructuralBaseline,
  zone: LivingDiningZone,
  plan: MultiAnchorPlan
): { instruction: string; floating: boolean } | null {
  if (!plan.sofaPlan) return null;

  const livingWallIndices: number[] = zone.borderingWallIndices || [];
  const zoneBBox = polygonBBox(zone.floorRegion.polygon);
  const zoneDepth = zoneBBox.maxY - zoneBBox.minY;
  const depthOk = zoneDepth >= MIN_ZONE_DEPTH_FOR_TV_FACING;
  const entryOpenings = findLivingZoneEntryOpenings(baseline, livingWallIndices);
  const sofaPos = computeFloatingSofaPosition(zone, entryOpenings);
  const clearance = checkClearance(sofaPos, entryOpenings);

  if (depthOk && clearance.clear) {
    const facingClause = plan.tvPlan
      ? `facing directly toward ${plan.tvPlan.wallDescription} (the TV wall)`
      : `facing ${plan.sofaPlan.facingDescription || "into the open floor area of the room"}`;
    const clearanceClause =
      entryOpenings.length > 0
        ? ` This position is deliberately clear of the direct path from ${entryOpenings.map((o) => o.id).join("/")} into the room — do not place the sofa against a side or adjacent wall, and do not place it so it blocks the walking path from that opening into the rest of the room.`
        : ` Do not place the sofa against a side or adjacent wall.`;
    return {
      floating: true,
      instruction: `Place the sofa floating in the room (not against any wall), ${facingClause}, positioned at approximately normalized coordinates [${sofaPos.x.toFixed(3)}, ${sofaPos.y.toFixed(3)}] of the full photo.${clearanceClause}`,
    };
  }

  const doorGuidance = plan.sofaPlan.hasDoorOrWalkthrough
    ? " This wall has a door or walkthrough opening on it — arrange the sofa and any other furniture so the doorway's full swing path and a clear walking route through it remain completely unobstructed; do not let the sofa or its footprint block the doorway."
    : "";
  const where = plan.sofaPlan.wallId
    ? `against ${plan.sofaPlan.wallDescription || "the wall selected by the room's own layout analysis"}`
    : `floor-centered within the zone (no wall is suitable for large furniture)`;
  return {
    floating: false,
    instruction: `Place a sofa ${where}. ${plan.sofaPlan.orientationInstruction || ""}${doorGuidance}`.trim(),
  };
}

function buildLivingDiningAnchorSection(plan: MultiAnchorPlan, sofaInstruction?: string): string {
  const livingLines: string[] = [];
  if (plan.tvPlan) {
    livingLines.push(`* Place a TV and low TV console/unit against ${plan.tvPlan.wallDescription}, within the segment described as "${plan.tvPlan.segmentDescription}".`);
  }
  if (sofaInstruction) {
    livingLines.push(`* ${sofaInstruction}`);
  }
  const diningLines: string[] = [];
  if (plan.diningPlan) {
    diningLines.push(
      `* Place a dining table with seating for 4-6 chairs, freestanding within the dining zone, centered roughly at normalized position [${plan.diningPlan.center[0].toFixed(3)}, ${plan.diningPlan.center[1].toFixed(3)}] of the full photo. The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out.`
    );
    if (plan.diningPlan.nearKitchen) {
      diningLines.push(
        `* This room's kitchen is on the same side of the room as this position — keep the dining table on this side, near the kitchen, rather than centering it purely within the dining zone's own floor area.`
      );
    }
  }
  return `ANCHOR ITEMS — LIVING ZONE (must be followed exactly)\n\n${livingLines.join("\n")}\n\nANCHOR ITEM — DINING ZONE (must be followed exactly)\n\n${diningLines.join("\n")}\n\nZONING CONTEXT: this is a single open-plan room combining two functional zones — a living/seating zone and a dining zone. Stage each zone according to its function as instructed above, so the two areas read as distinct, intentional zones within the same open room, not one undifferentiated furniture arrangement.`;
}

// ── Standalone living room — reuses living-dining's real TV-wall/sofa
// planner (planMultiAnchor) and circulation-aware floating-sofa logic
// (findLivingZoneEntryOpenings/computeFloatingSofaPosition/checkClearance)
// UNCHANGED, applied to the whole room as a single zone. No extractZoning
// call: there is no second zone to divide against, so a synthetic zone
// covering the full visible floor is built locally from data already in
// hand (walls), at zero extra API cost. planMultiAnchor itself is
// untouched — passing it a one-element zones array with no "dining"
// zone present is enough to make it skip all dining-anchor logic (its own
// `zones.find(z => z.purpose === "dining")` naturally returns undefined)
// and run its living-zone TV/sofa logic exactly as it already does for
// the living_dining path. ──
function buildSyntheticWholeRoomLivingZone(walls: WallVisibilityWall[]): LivingDiningZone {
  // Depth proxy: the shallowest (smallest-y, i.e. furthest from camera)
  // wall/floor junction across all visible walls approximates how deep
  // the visible floor extends — the same quantity a real zoning
  // extraction's floorRegion bbox would yield for a single full-room
  // zone. Full x-range [0,1] approximates the floor spanning the visible
  // frame width; only used as a fallback centering reference if no wall
  // qualifies for sofa placement.
  const floorMinY = walls.length > 0 ? Math.min(...walls.map((w) => wallBBox(w).maxY)) : 0;
  return {
    id: "zone_living_wholeroom",
    purpose: "living",
    floorRegion: {
      polygon: [
        [0, floorMinY],
        [1, floorMinY],
        [1, 1],
        [0, 1],
      ],
    },
    borderingWallIndices: walls.map((w) => Number(String(w.id).replace("wall_", ""))),
    reasoning: "Synthetic whole-room zone for a standalone living room (no zoning split needed — only one functional zone exists). Not model-inferred.",
  };
}

function buildLivingRoomOnlyAnchorSection(plan: MultiAnchorPlan, sofaInstruction?: string): string {
  const livingLines: string[] = [];
  if (plan.tvPlan) {
    livingLines.push(`* Place a TV and low TV console/unit against ${plan.tvPlan.wallDescription}, within the segment described as "${plan.tvPlan.segmentDescription}".`);
  }
  if (sofaInstruction) {
    livingLines.push(`* ${sofaInstruction}`);
  }
  return `ANCHOR ITEMS — LIVING ROOM (must be followed exactly)\n\n${livingLines.join("\n")}`;
}

function buildLivingRoomPrompt(
  baseline: StructuralBaseline,
  walls: WallVisibilityWall[],
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  const wholeRoomZone = buildSyntheticWholeRoomLivingZone(walls);
  const plan = planMultiAnchor(baseline, walls, [wholeRoomZone]);
  if (!plan.sofaPlan) {
    return { prompt: null, fallbackReason: "no_valid_living_anchor", extra: {} };
  }

  const sofaPlacement = resolveSofaPlacement(baseline, wholeRoomZone, plan);
  const anchorSection = buildLivingRoomOnlyAnchorSection(plan, sofaPlacement?.instruction);

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

${anchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a living room, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  return {
    prompt,
    fallbackReason: null,
    extra: {
      tvPlaced: !!plan.tvPlan,
      tvUsedBracket: !!plan.tvPlan?.usedBracket,
      sofaFloating: !!sofaPlacement?.floating,
      anchorWallId: plan.tvPlan?.wallId ?? plan.sofaPlan.wallId ?? null,
    },
  };
}

// ── No-anchor, light-staging room types (bathroom, hallway, garage) —
// kitchen's proven shape: full category-A locks + universal feature
// protection, no wall-selection/anchor-placement logic, just a
// type-appropriate light-decor instruction. ──
function buildBathroomPrompt(
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

BATHROOM — LIGHT STAGING ONLY (must be followed exactly)

* The bathroom's existing vanity, tub, shower, toilet, mirror, and any built-in cabinetry or shelving are permanent fixtures, already protected above. Do not add, remove, resize, relocate, or otherwise alter any of them.
* Do NOT add any large furniture or fixtures to the bathroom — no additional cabinetry, no benches, stools, or chairs, no freestanding storage units.
* You may add ONLY small, soft-good and surface-level items: fresh folded or hung towels (on an existing rail, hook, or vanity surface), a bath mat on the floor (clear of any door swing path), and up to 3 small decor/toiletry items (e.g. a soap dispenser, a small plant, a candle, neatly arranged toiletries) placed only on existing counter or shelf surfaces.
* Do not obstruct, cover, or place any new item in front of any detected window, opening, or fixture named in the protected-features section above.

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bathroom rules above and the structural constraints above, use your own professional staging judgment to complete the space appropriately, producing a realistic, market-ready real estate listing photo. Keep staging light and true to a real bathroom — do not overfill a small space.`;

  return { prompt, fallbackReason: null, extra: {} };
}

function buildHallwayPrompt(
  walls: WallVisibilityWall[],
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  // Reuses the same "largest usable wall segment" signal bedroom/study's
  // anchor selection is built on, but only as a conditional allowance —
  // a hallway with no qualifying wall still stages fine with decor alone,
  // so this never triggers a fallback the way bedroom/study's hard anchor
  // requirement does.
  const hasQualifyingWallSegment = walls.some((w) => (w.usableSegments || []).some((s) => s.widthFraction >= MIN_USABLE_FRACTION_FOR_ANCHOR));
  const consoleLine = hasQualifyingWallSegment
    ? "This hallway has at least one wall segment with genuinely clear width (confirmed by the room's own wall analysis) — you may optionally add ONE small console table or wall-mounted mirror there, sized appropriately for a hallway, only if it does not reduce the walking path width."
    : "No wall segment in this hallway has confirmed clear width for furniture — do not add a console table, mirror, or any other wall-mounted or floor-standing furniture item; decor-only staging (per below) is correct here.";

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

HALLWAY — LIGHT STAGING ONLY (must be followed exactly)

* Do NOT add any large furniture to the hallway — no benches, cabinets, or seating of any kind.
* You may add a runner rug along the walking path, sized to leave clear space on both sides and at both ends (doorways, stair edges) — do not let it bunch, overlap a threshold, or narrow the usable walking width.
* ${consoleLine}
* Do not obstruct, cover, or place any new item in front of any detected door, doorway, or fixture named in the protected-features section above, and do not reduce the clear walking width of the hallway at any point.

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the hallway rules above and the structural constraints above, use your own professional staging judgment to add light, tasteful decor (e.g. wall art, a small plant) appropriate for a hallway, producing a realistic, market-ready real estate listing photo. Keep staging minimal — a hallway is a transition space, not a room to furnish.`;

  return { prompt, fallbackReason: null, extra: {} };
}

// Garage — scope decision (see Task report): defaulted to the
// conservative option, structural-protection-only with an explicit
// "add nothing" instruction, since garages aren't typically staged with
// decor the way living spaces are and no time was available to confirm
// otherwise before this ships. If a lighter organizational-decor pass is
// wanted instead, this is the one function to change — nothing else in
// the room-type routing depends on which choice this makes.
function buildGaragePrompt(
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

GARAGE — STRUCTURAL PROTECTION ONLY, NO STAGING (must be followed exactly)

* Do NOT add any furniture, decor, storage items, vehicles, tools, or any other object to this photo. This is a decluttering/structural-protection-only pass, not a staging pass — garages are not staged with decor the way living spaces are.
* Do not add anything beyond what is already present in the photo. If the photo looks empty or sparse, leave it that way.
* All structural constraints above still apply in full: do not alter walls, flooring, the garage door, windows, built-in shelving/racking, or any other fixed element.

EVERYTHING ELSE

There is no "everything else" for this room type — add nothing beyond what is already in the photo.`;

  return { prompt, fallbackReason: null, extra: {} };
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
    tvUsedBracket?: boolean;
    sofaFloating?: boolean;
    // Full tier audit trail from planSingleAnchorWall's four-tier decision
    // (bedroom/study only) — which tier fired, the winning wall's stats,
    // and why higher-priority tiers didn't qualify. Logged here so it
    // flows through the same [STAGE2_ANCHOR_LOCKED_PLAN] log line every
    // other decision in this pipeline already does, rather than a
    // separate ad-hoc log call.
    anchorSelectionReason?: string;
  };
};

// "living_dining" is the real room-type identifier used by job intake —
// confirmed against worker/src/ai/roomTypeDetector.ts, shared/src/types.ts,
// and server/src/routes/upload.ts, not assumed. "kitchen" / "kitchen_dining"
// / "kitchen_living" are likewise real, distinct identifiers used elsewhere
// in the codebase (e.g. stage2.ts's legacy room-type switch), not a naming
// variant of anything already in this set.
//
// "living_room" (standalone living), "study" (confirmed distinct from
// "office" — both are separate real values, "office" is deliberately NOT
// added here since it wasn't in scope), "bathroom"/"bathroom_1"/
// "bathroom_2", "hallway", and "garage" are all confirmed real, canonical
// identifiers via shared/src/types.ts's RoomType union and both server
// intake allowlists (server/src/routes/upload.ts's and retrySingle.ts's
// CANONICAL_ROOM_TYPES), not assumed. "living" (bare) is included
// defensively alongside "living_room": upload.ts/retrySingle.ts both
// normalize "living" -> "living_room" at intake via an explicit alias, so
// "living_room" is what should actually reach this function in practice,
// but stage2.ts's own legacy switch still treats bare "living" as
// equivalent, so it's added here too at zero cost in case any intake path
// ever bypasses that normalization.
const SUPPORTED_ROOM_TYPES = new Set([
  "bedroom",
  "living_dining",
  "kitchen",
  "kitchen_dining",
  "kitchen_living",
  "living_room",
  "living",
  "study",
  "bathroom",
  "bathroom_1",
  "bathroom_2",
  "hallway",
  "garage",
]);
const KITCHEN_ROOM_TYPES = new Set(["kitchen", "kitchen_dining", "kitchen_living"]);
const LIVING_ROOM_ONLY_TYPES = new Set(["living_room", "living"]);
const STUDY_ROOM_TYPES = new Set(["study"]);
const BATHROOM_ROOM_TYPES = new Set(["bathroom", "bathroom_1", "bathroom_2"]);
const HALLWAY_ROOM_TYPES = new Set(["hallway"]);
const GARAGE_ROOM_TYPES = new Set(["garage"]);

// Kitchen path is deliberately the simple pattern, not the zoning/anchor
// pattern living-dining uses: no extractZoning call, no planMultiAnchor —
// a kitchen's cabinetry/counters/island are already-existing fixtures
// covered by CATEGORY_A_LOCKS and buildUniversalFeatureProtectionSection,
// so there's no wall to select or item to anchor, just a light-staging
// instruction layered on the same shared structural protections bedroom
// and living-dining use. kitchen_dining/kitchen_living get an additional
// natural-language (not geometric) instruction for the non-kitchen zone,
// same "your professional judgment" pattern bedroom already uses for its
// non-anchor furniture — reusing living-dining's real zoning mechanism
// (extractZoning + planMultiAnchor) isn't possible without also extending
// it past its hardcoded living/dining pair, which is out of scope for a
// same-day, minimal kitchen fix.
function buildKitchenPrompt(
  roomType: string,
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  const secondaryZoneInstruction =
    roomType === "kitchen_dining"
      ? `\n\nDINING ZONE — YOUR PROFESSIONAL JUDGMENT\n\nThis room also includes a dining area separate from the kitchen work area. Stage the dining area with a full, to-scale dining table and chairs appropriate for the space, positioned using your own professional judgment. Do not place dining furniture inside the kitchen work area — not on or against cabinetry or countertops, and not on the kitchen floor zone directly in front of them.`
      : roomType === "kitchen_living"
        ? `\n\nLIVING ZONE — YOUR PROFESSIONAL JUDGMENT\n\nThis room also includes a living/lounge area separate from the kitchen work area. Stage the living area with seating (sofa or armchairs) and supporting furniture appropriate for the space, positioned using your own professional judgment. Do not place living-room furniture inside the kitchen work area — not on or against cabinetry or countertops, and not on the kitchen floor zone directly in front of them.`
        : "";

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

KITCHEN ZONE — LIGHT STAGING ONLY (must be followed exactly)

* The kitchen's existing cabinetry, countertops, island, and appliances are permanent fixtures, already protected above. Do not add, remove, resize, relocate, or otherwise alter any of them.
* Do NOT add any large furniture to the kitchen area — no dining table, no chairs, stools, or bar stools (including at a kitchen island), no other floor-standing furniture of any kind.
* You may add ONLY small, countertop/surface-level items: up to 2 small appliances (e.g. kettle, toaster, coffee machine) and up to 3 small decor or accessory items (e.g. fruit bowl, cookbooks, a utensil holder, a knife block, a folded dish towel, a small plant). Place these only on existing countertops or open shelving — never on the floor, and never inside the sink.
* Do not obstruct, cover, or place any new item in front of any detected window, opening, or fixture named in the protected-features section above — including on a countertop or windowsill directly beneath a window.${secondaryZoneInstruction}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the kitchen rules above and the structural constraints above, use your own professional staging judgment to complete the space appropriately, producing a realistic, market-ready real estate listing photo. Do not leave the space sparse or under-furnished outside the kitchen zone; stage it as a professional would for a real listing.`;

  return { prompt, fallbackReason: null, extra: {} };
}

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
  const doorAccessSection = buildDoorAccessRequirementSection(plan, "bed", ["bedside tables"]);

  const coLocatedFeatures = describeCoLocatedFeatures(baseline, plan.anchorWallIndex);
  const anchorWallFeaturesSection =
    coLocatedFeatures.length > 0
      ? `\n\nANCHOR WALL — CO-LOCATED FEATURES (must stay fully visible; nothing may cover or obstruct them, including the bed)\n\nThe wall selected for the bed also has the following existing feature(s) on it. Position the bed within the clear segment described above so that it does NOT overlap or obstruct any of these — the bed must be positioned to avoid them, even if that means it does not span the entire wall. No new item (artwork, mirrors, shelving, or any other wall-mounted decor) may be placed over them either, even though it may look conventional to decorate that spot:\n${coLocatedFeatures.join("\n")}`
      : "";

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against ${plan.anchorWallDescription}, within the clear segment described as "${plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}${framingLine}${noDecorLine}${doorAccessSection}${anchorWallFeaturesSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the protected features named above and the no-decor-above-bed rule if it applies. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  return {
    prompt,
    fallbackReason: null,
    extra: {
      anchorWallId: plan.anchorWallId,
      anchorConfidence: plan.confidence,
      wallPartiallyVisible: plan.wallPartiallyVisible,
      anchorSelectionReason: plan.selectionReason,
    },
  };
}

// Study — bedroom's exact pattern (single anchor item, real wall
// selection via planDeskAnchor, which shares planSingleAnchorWall with
// planBedroomAnchor) with desk-specific prompt text.
function buildStudyPrompt(
  baseline: StructuralBaseline,
  walls: WallVisibilityWall[],
  protectedFeatureSection: string
): { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> } {
  const plan = planDeskAnchor(baseline, walls);
  if (!plan) {
    return { prompt: null, fallbackReason: "no_wall_meets_anchor_threshold", extra: {} };
  }

  const framingLine = plan.anchorFramingNote ? ` ${plan.anchorFramingNote}` : "";
  const doorAccessSection = buildDoorAccessRequirementSection(plan, "desk", ["the desk chair"]);

  const coLocatedFeatures = describeCoLocatedFeatures(baseline, plan.anchorWallIndex);
  const anchorWallFeaturesSection =
    coLocatedFeatures.length > 0
      ? `\n\nANCHOR WALL — CO-LOCATED FEATURES (must stay fully visible; nothing may cover or obstruct them, including the desk)\n\nThe wall selected for the desk also has the following existing feature(s) on it. Position the desk within the clear segment described above so that it does NOT overlap or obstruct any of these — the desk must be positioned to avoid them, even if that means it does not span the entire wall. No new item (artwork, mirrors, shelving, or any other wall-mounted decor) may be placed over them either, even though it may look conventional to decorate that spot:\n${coLocatedFeatures.join("\n")}`
      : "";

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

ANCHOR ITEM — DESK (must be followed exactly)

* Place a desk against ${plan.anchorWallDescription}, within the clear segment described as "${plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}${framingLine}${doorAccessSection}${anchorWallFeaturesSection}
* Include a desk chair at the desk, and keep the desk surface realistically tidy (e.g. a laptop or monitor, a small lamp, a few books or folders) — not empty, and not cluttered.

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the desk placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a home study/office, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the protected features named above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  return {
    prompt,
    fallbackReason: null,
    extra: {
      anchorWallId: plan.anchorWallId,
      anchorConfidence: plan.confidence,
      wallPartiallyVisible: plan.wallPartiallyVisible,
      anchorSelectionReason: plan.selectionReason,
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
  const { zones, kitchenSignal } = zoningResult;
  const livingZone = zones.find((z) => z.purpose === "living");
  const diningZone = zones.find((z) => z.purpose === "dining");
  if (!livingZone || !diningZone || !livingZone.floorRegion?.polygon || !diningZone.floorRegion?.polygon) {
    return { prompt: null, fallbackReason: "zoning_incomplete", extra: { zoningExtracted: true } };
  }

  const plan = planMultiAnchor(baseline, walls, zones, kitchenSignal);
  if (!plan.diningPlan) {
    return { prompt: null, fallbackReason: "no_valid_dining_anchor", extra: { zoningExtracted: true } };
  }
  if (!plan.sofaPlan) {
    return { prompt: null, fallbackReason: "no_valid_living_anchor", extra: { zoningExtracted: true } };
  }

  const sofaPlacement = resolveSofaPlacement(baseline, livingZone, plan);
  const anchorSection = buildLivingDiningAnchorSection(plan, sofaPlacement?.instruction);

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
      tvUsedBracket: !!plan.tvPlan?.usedBracket,
      sofaFloating: !!sofaPlacement?.floating,
      anchorWallId: plan.tvPlan?.wallId ?? plan.sofaPlan.wallId ?? null,
    },
  };
}

// Per-job wall-visibility cache. extractWallVisibility (below) has no other
// caller and no other cache anywhere in the codebase — unlike
// extractStructuralBaseline, which already had worker.ts's proper
// structuralBaseline/structuralBaselinePromise cache that this function was
// simply bypassing. Same underlying waste (a fresh Gemini call on the same
// unchanged baseline image, once per Stage 2 generation attempt), but
// there's no pre-existing cross-call-site cache to plug into here, so a
// small, self-contained, jobId-keyed cache is added directly in this
// module instead — same in-memory-Map, no-explicit-eviction pattern
// already used by worker.ts's own stage2LayoutPlanCache.
const wallVisibilityCache = new Map<string, WallVisibilityWall[] | null>();

export async function buildAnchorLockedStage2Prompt(opts: {
  imagePath: string;
  roomType: string;
  jobId: string;
  imageId: string;
  /**
   * Pre-resolved structural baseline, if the caller already has one
   * (worker.ts caches this per-job and reuses it across every Stage 2
   * generation attempt and every validator). When provided, this function
   * skips its own extractStructuralBaseline call entirely. When omitted
   * (e.g. a caller outside worker.ts's cached flow), falls back to
   * extracting it itself — preserves prior behavior as a safety net,
   * never a hard requirement.
   */
  structuralBaseline?: StructuralBaseline | null;
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
  if (opts.structuralBaseline) {
    baseline = opts.structuralBaseline;
  } else {
    try {
      baseline = await extractStructuralBaseline(opts.imagePath, { jobId: opts.jobId, imageId: opts.imageId });
    } catch (e) {
      return fallback(`baseline_extraction_failed:${String(e)}`);
    }
  }
  baseDiagnostics.baselineExtracted = true;

  let walls: WallVisibilityWall[] | null;
  if (wallVisibilityCache.has(opts.jobId)) {
    walls = wallVisibilityCache.get(opts.jobId)!;
  } else {
    walls = await extractWallVisibility(opts.imagePath, baseline, { jobId: opts.jobId, imageId: opts.imageId });
    wallVisibilityCache.set(opts.jobId, walls);
  }
  if (!walls) {
    return fallback("wall_visibility_extraction_failed", baseDiagnostics);
  }
  baseDiagnostics.wallVisibilityExtracted = true;

  const { section: protectedFeatureSection, itemCount, sentences } = buildUniversalFeatureProtectionSection(baseline, walls);
  baseDiagnostics.protectedFeatureCount = itemCount;
  baseDiagnostics.protectedFeatureSentences = sentences;

  let roomResult: { prompt: string | null; fallbackReason: string | null; extra: Partial<AnchorLockedPromptResult["diagnostics"]> };
  if (opts.roomType === "bedroom") {
    roomResult = buildBedroomPrompt(baseline, walls, protectedFeatureSection);
  } else if (STUDY_ROOM_TYPES.has(opts.roomType)) {
    roomResult = buildStudyPrompt(baseline, walls, protectedFeatureSection);
  } else if (KITCHEN_ROOM_TYPES.has(opts.roomType)) {
    roomResult = buildKitchenPrompt(opts.roomType, protectedFeatureSection);
  } else if (BATHROOM_ROOM_TYPES.has(opts.roomType)) {
    roomResult = buildBathroomPrompt(protectedFeatureSection);
  } else if (HALLWAY_ROOM_TYPES.has(opts.roomType)) {
    roomResult = buildHallwayPrompt(walls, protectedFeatureSection);
  } else if (GARAGE_ROOM_TYPES.has(opts.roomType)) {
    roomResult = buildGaragePrompt(protectedFeatureSection);
  } else if (LIVING_ROOM_ONLY_TYPES.has(opts.roomType)) {
    roomResult = buildLivingRoomPrompt(baseline, walls, protectedFeatureSection);
  } else {
    roomResult = await buildLivingDiningPrompt(opts.imagePath, baseline, walls, protectedFeatureSection, { jobId: opts.jobId, imageId: opts.imageId });
  }

  const diagnostics: AnchorLockedPromptResult["diagnostics"] = { ...baseDiagnostics, ...roomResult.extra };

  if (!roomResult.prompt) {
    return fallback(roomResult.fallbackReason || "unknown_planning_failure", diagnostics);
  }

  // Deliberately bypasses nLog — see the matching comment on
  // [STAGE2_PROMPT_VARIANT] in stage2.ts. Carries tvUsedBracket, the exact
  // fact needed to tell "bracket detected and used" apart from "bracket
  // missed, fell back to geometric wall scoring" from production logs
  // alone, without which this class of question can't be answered without
  // re-running the job outside production.
  console.log("[STAGE2_ANCHOR_LOCKED_PLAN]", {
    jobId: opts.jobId,
    imageId: opts.imageId,
    ...diagnostics,
    fallbackTriggered: false,
  });

  return { prompt: roomResult.prompt, fallbackReason: null, diagnostics };
}

// Experimental, test-branch-only variant (see COMPACT_STRUCTURAL_LOCKS
// above): runs the exact same planning pipeline as
// buildAnchorLockedStage2Prompt — same baseline extraction, same
// wall-visibility extraction, same real per-image anchor-wall selection,
// same buildUniversalFeatureProtectionSection output — then swaps only the
// CATEGORY_A_LOCKS text block for a staging-goal sentence plus
// COMPACT_STRUCTURAL_LOCKS in the finished prompt string. Every room
// builder interpolates CATEGORY_A_LOCKS verbatim and unmodified (confirmed
// by inspection of all eight builders above), so this substitution is
// exact and doesn't touch any planning logic or risk regressing the
// anchor_locked/grok variants, which call buildAnchorLockedStage2Prompt
// directly and never go through this function.
const GROK_SKILL_STAGING_GOAL = "As a virtual staging assistant, add only realistic, correctly-scaled furniture and decor to this room photo for New Zealand real-estate marketing. Produce a high-quality, fully staged, listing-ready result — do not default to sparse or minimal staging.\n\n";
export async function buildGrokSkillStage2Prompt(
  opts: Parameters<typeof buildAnchorLockedStage2Prompt>[0]
): Promise<AnchorLockedPromptResult> {
  const result = await buildAnchorLockedStage2Prompt(opts);
  if (!result.prompt) return result;
  if (!result.prompt.includes(CATEGORY_A_LOCKS)) {
    // Defensive: if this ever fires, some builder's template changed and
    // no longer interpolates CATEGORY_A_LOCKS verbatim — fall back to the
    // unmodified anchor-locked prompt rather than silently shipping a
    // prompt with no structural-lock section at all.
    nLog("[STAGE2_GROK_SKILL_SUBSTITUTION_MISS]", { jobId: opts.jobId, imageId: opts.imageId, roomType: opts.roomType });
    return result;
  }
  return { ...result, prompt: result.prompt.replace(CATEGORY_A_LOCKS, GROK_SKILL_STAGING_GOAL + COMPACT_STRUCTURAL_LOCKS) };
}

// Extracts the real per-photo planning output — universal feature
// protection sentences plus the room-specific anchor-placement or
// light-staging section — from a fully-assembled anchor_locked prompt,
// without either of its own bracketing text (the "Virtual Staging
// Instructions..." header, CATEGORY_A_LOCKS itself, and the trailing
// "EVERYTHING ELSE" epilogue). Used by STAGE2_PROMPT_VARIANT=combined
// (stage2.ts) to graft anchor_locked's real per-image data onto nano's
// prompt instead of anchor_locked's own structural-lock text — nano
// already has its own structural-lock section and its own room-program
// epilogue-equivalent (buildNanoRoomProgramGuidance), so only this middle
// chunk is actually new information nano doesn't already have.
//
// Deliberately implemented as string extraction on the assembled prompt
// rather than a refactor of the eight room builders above to also return
// this chunk as a separate field: every builder's template was directly
// inspected and confirmed to interpolate CATEGORY_A_LOCKS and
// "EVERYTHING ELSE" verbatim and unmodified, so this is exact — and it
// keeps zero risk to the already-shipped anchor_locked/grok/grok_skill
// variants, which never call this function.
export function extractAnchorLockedPlanningSection(fullPrompt: string): string | null {
  const startIdx = fullPrompt.indexOf(CATEGORY_A_LOCKS);
  if (startIdx === -1) return null;
  const afterLocks = fullPrompt.slice(startIdx + CATEGORY_A_LOCKS.length);
  const endMarker = "\n\nEVERYTHING ELSE";
  const endIdx = afterLocks.indexOf(endMarker);
  if (endIdx === -1) return null;
  const section = afterLocks.slice(0, endIdx).trim();
  return section.length > 0 ? section : null;
}

// Splits extractAnchorLockedPlanningSection's combined chunk into its two
// real components — the per-item protected-feature sentences (from
// buildUniversalFeatureProtectionSection) and the room-specific anchor-
// placement or light-staging text — using the feature section's own
// unique, stable header text as the split point (defined right there in
// buildUniversalFeatureProtectionSection above; if that header text is
// ever changed, update PROTECTED_FEATURES_MARKER to match). Used by
// STAGE2_PROMPT_VARIANT=combined (stage2.ts), which places these two
// pieces in different parts of a restructured prompt rather than adjacent
// to each other the way anchor_locked/grok_skill do.
const PROTECTED_FEATURES_MARKER = "ROOM-SPECIFIC PROTECTED FEATURES";
export function splitAnchorLockedPlanningSection(
  fullPrompt: string
): { protectedFeatureSection: string | null; roomSpecificSection: string | null } {
  const chunk = extractAnchorLockedPlanningSection(fullPrompt);
  if (!chunk) return { protectedFeatureSection: null, roomSpecificSection: null };
  const markerIdx = chunk.indexOf(PROTECTED_FEATURES_MARKER);
  if (markerIdx === -1) return { protectedFeatureSection: null, roomSpecificSection: chunk };
  const fromMarker = chunk.slice(markerIdx);
  const gapIdx = fromMarker.indexOf("\n\n");
  if (gapIdx === -1) return { protectedFeatureSection: fromMarker.trim(), roomSpecificSection: null };
  return {
    protectedFeatureSection: fromMarker.slice(0, gapIdx).trim(),
    roomSpecificSection: fromMarker.slice(gapIdx).trim() || null,
  };
}
