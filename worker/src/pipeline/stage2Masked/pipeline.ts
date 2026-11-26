// Stage 2 "masked" staging — the pipeline steps, shared by the app (see
// runMaskedStage2Job below, called from worker.ts) and the test script
// (scripts/stage2-mask-pasteback-test.ts), so both run exactly the same code.
//
//   traceLayers      Gemini traces the furniture it added (plus wall art,
//                    mirror reflections, kitchen appliances); each layer is
//                    checked; the framing check spots a reshaped room.
//   harmonise        Furniture pasted onto the real photo (safe composite),
//                    Gemini adds shadows/lighting (blend), the app builds its
//                    own final from it, then the blend itself is checked patch
//                    by patch and repaired (checked blend = the final).
//   finalDoorCheck   Code check, then (only if a doorway looks covered) an AI
//                    review of the final image: can people still walk through
//                    the real doorways?

import { RELIGHT_FINAL, compositeRelight } from "./relight";
import { roomAllowsEmptyLayout, roomIsLightStaging } from "../roomBrief";

// Pieces that stand on the floor. A plain kitchen whose plan has none of
// these is styled on its benches only.
const FLOOR_STANDING_ITEM = /stool|chair|table|sofa|couch|armchair|bench seat|ottoman|rug|mat|plant stand|floor plant|potted plant on the floor|trolley|cart|bed|desk|shelf unit|bookcase/i;

/** True when nothing in the plan is meant to stand on the floor. */
export function surfaceStylingOnly(roomType: string, brief: any): boolean {
  if (roomIsLightStaging(roomType)) return true;
  const key = String(roomType || "").toLowerCase().replace(/-/g, "_");
  if (key !== "kitchen") return false;
  const layout = Array.isArray(brief?.layout) ? brief.layout : null;
  if (!layout) return false; // no plan: stools may have been added — keep the checks
  return !layout.some((it: any) => FLOOR_STANDING_ITEM.test(`${it?.item || ""}`));
}
import { NEAR_WALL_CROP_ENABLED, detectNearWallStrip, writeCroppedInput, remapBoxedItems, pasteBackIntoFullPhoto, type NearWallCrop } from "./nearWallStrip";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { closestGeminiAspectRatio } from "../../ai/gemini";
import {
  TRACE_MODEL,
  TRACE_IMAGE_SIZE,
  SOLID_GROW_PCT,
  CORE_ERODE_PCT,
  ZONE_GROW_PCT,
  ZONE_DOWN_PCT,
  HARMONISE_MODEL,
  HARMONISE_IMAGE_SIZE,
  HARM_ZONE_GROW_PCT,
  HARM_ZONE_DOWN_PCT,
  WALL_SHADOW_REACH_PCT,
  trimWallShadowZone,
  BLEND_MAX_REPAIR_PCT,
  DOOR_CHECK,
  callGeminiImage,
  imagePart,
  approxOutputCost,
  tracePassesFor,
  lightTracePassesFor,
  buildTracePrompt,
  buildBareRoomTracePrompt,
  buildMirrorPrompt,
  buildApplianceSpacePrompt,
  buildHarmonisePrompt,
  binarizeTraceResponse,
  removeSmallComponents,
  labelComponents,
  evaluateReflections,
  fillChangedGaps,
  fillFurnitureColumns,
  maskToPng,
  evaluateWallArt,
  refineArtRegion,
  dilate,
  invert,
  erode,
  growDown,
  ratioOf,
  layersOverlay,
  measureOutsideDrift,
  checkFraming,
  checkCameraAlignment,
  checkFloatingFurniture,
  realFloorLine,
  checkFloorMoved,
  measureSkirtingOffsets,
  planSkirtingLineUp,
  seamUnderFurniture,
  planGroupForward,
  carryPlacementMatch,
  retryPriorityHint,
  RETRY_PRIORITY,
  skirtingOffsetsInMoved,
  fitSkirtingNudge,
  applySkirtingNudge,
  SKIRTING_FIT,
  geminiLineUnderColumns,
  GROUP_SHIFT,
  applySkirtingLineUp,
  lineUpLeftoverPct,
  LINEUP_MAX_RESIDUAL_PCT,
  type SkirtingLineUp,
  SKIRTING_LINE_UP,
  FLOOR_MOVED_RISE_PCT,
  type SkirtingRun,
  FLOOR_MOVED_CHECK,
  FLOOR_OVER_WALL_GUARD,
  floorOverRealWall,
  planFloorPatches,
  applyFloorPatches,
  canRealign,
  shouldPrealign,
  BED_WALL_CHECK,
  askBedWall,
  plannedBedWallFromBrief,
  REFLECTION_GATE,
  askReflectiveSurfaces,
  askDeskDoor,
  askLivingDoor,
  livingPlanFromBrief,
  floorMovedHint,
  LIVING_DOOR_CHECK,
  alignStagedToOriginal,
  furnitureCutAtEmptyEdge,
  cutPieceCompletionZone,
  applyCutPieceCompletion,
  REALIGN_MAX_EMPTY_PCT,
  EDGE_CROP_ENABLED,
  LEG_POCKET_FILL,
  dropRoomColouredGaps,
  findLegPockets,
  BAND_LEG_KEEP,
  findBandLegs,
  PLAIN_FLOOR_MAX_STD,
  planEdgeCrop,
  applyEdgeCrop,
  undoneOverlay,
  compositeLayers,
  removeSunPatches,
  compositeHarmonise,
  checkStructureRetained,
  checkBlend,
  blendHasObjectChange,
  doorwayAppearsBlocked,
  askDoorAccess,
  type DoorOpening,
  type Mask,
} from "./core";

// Where intermediate images go (debug files, test output) and where saved
// Gemini outputs come from in offline replays. Both optional.
export type MaskedIO = {
  save?: (name: string, data: Buffer | string) => void;
  load?: (name: string) => Buffer | null;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type MaskedContext = {
  name: string; // label for logs
  original: Buffer; // the Stage 2 input (the real room)
  originalPath: string;
  originalMime: string;
  staged: Buffer; // Gemini's staged image
  roomType: string;
  aspectRatio: string;
  w: number;
  h: number;
  // Trace tightly, without shadows (harmonise). The test script's older merge
  // modes use the wider "silhouette and footprint" wording.
  tight: boolean;
  // Offline replay: no Gemini calls; saved outputs are read through io.load.
  offline: boolean;
  // Carry-over round: lighter tracing (see lightTracePassesFor), no close-up.
  lightTrace?: boolean;
  // Fallback round: the traces of the same staged picture are read from the
  // earlier round instead of asking Gemini again (no cost).
  traceReplay?: (name: string) => Buffer | null;
  // Carry-over round: Gemini's carried-over picture already has the lighting
  // and shadows, so the blend borrows from it instead of a new Gemini call.
  blendFrom?: Buffer | null;
  dir: string; // folder for door-check input images
  io: MaskedIO;
  row: any; // report, filled in step by step
  // After a line-up: the strip next to furniture that runs into the edge
  // Gemini's picture no longer covers; the blend continues the pieces there.
  completionZone?: Uint8Array | null;
  completionBand?: Uint8Array | null;
  // The line-up's empty area (photo size), for the last-resort edge crop.
  emptyStrip?: Uint8Array | null;
  // The empty room has no mirror, glass panel or glossy floor: the
  // reflections trace pass is skipped (one Gemini image call saved).
  skipReflections?: boolean;
  // Last attempt: areas under furniture the trace missed are taken from
  // Gemini's picture (see isCutUnder) instead of failing the job.
  fillMissedUnder?: boolean;
};

function save(ctx: MaskedContext, name: string, data: Buffer | string) {
  ctx.io.save?.(name, data);
}
function log(ctx: MaskedContext, msg: string) {
  (ctx.io.log || console.log)(msg);
}
function warn(ctx: MaskedContext, msg: string) {
  (ctx.io.warn || console.warn)(msg);
}

// Holes in furniture that show Gemini's room are left to the real photo.
// STAGE2_GAP_ROOM_CHECK=off goes back to filling every hole from Gemini.
export const GAP_ROOM_CHECK = String(process.env.STAGE2_GAP_ROOM_CHECK ?? "on").trim().toLowerCase() !== "off";

/**
 * Final skirting fit after a move (see fitSkirtingNudge): nudges each column
 * of the moved furniture so Gemini's floor line meets the real one all along.
 * Returned only when it brings the skirting closer and nothing floats.
 */
async function finalSkirtingFit(original: Buffer, staged: Buffer, layers: any, movedArea: Uint8Array, w: number, h: number) {
  if (!SKIRTING_FIT) return null;
  const offs = await skirtingOffsetsInMoved(original, staged, layers.floor, movedArea, w, h).catch(() => null);
  if (!offs) return null;
  const fit = fitSkirtingNudge(offs, w, h);
  if (!fit) return { applied: false as const, why: "too little of Gemini's skirting to fit" };
  if (fit.beforePct < 0.4) return { applied: false as const, why: `skirting already within ${fit.beforePct}%`, beforePct: fit.beforePct };
  const r = await applySkirtingNudge(original, staged, {
    floor: layers.floor, tightFloor: layers.tightFloor, artRegion: layers.artRegion, solid: layers.solid, zone: layers.zone, core: layers.core, legPocket: layers.legPocket,
  }, movedArea, fit.nudge, w, h);
  const fl = r.masks.floor as Uint8Array;
  const after = await skirtingOffsetsInMoved(original, r.staged, fl, movedArea, w, h).catch(() => null);
  let floating: any = await checkFloatingFurniture(original, fl, w, h).catch(() => ({ floating: true, runs: [] }));
  // A stretch whose back legs now sit right on the real floor line reads as
  // "hanging" to the floating check (it wants 1% below the line); where
  // Gemini's floor line under it has been fitted onto the real one, the
  // furniture stands on the real floor.
  if (floating.floating && after) {
    const L = after.length;
    const left = (floating.runs || []).filter((run: any) => {
      const v: number[] = [];
      for (let c = Math.floor((run.x1Pct / 100) * (L - 1)); c <= Math.ceil((run.x2Pct / 100) * (L - 1)); c++) if (!Number.isNaN(after[c])) v.push(Math.abs(after[c]));
      if (v.length < 4) return true;
      v.sort((a, b) => a - b);
      return v[v.length >> 1] > 0.8;
    });
    floating = { ...floating, floating: left.length > 0, runs: left };
  }
  const under = floating.floating ? [] : await seamUnderFurniture(original, r.staged, fl, w, h).catch(() => [] as any[]);
  if (floating.floating || under.length) return { applied: false as const, why: "the furniture would float after the fit", beforePct: fit.beforePct };
  const vals = after ? Array.from(after).filter((v) => !Number.isNaN(v)).map(Math.abs).sort((a, b) => a - b) : [];
  const afterPct = vals.length ? +vals[Math.floor(vals.length * 0.8)].toFixed(2) : null;
  if (afterPct !== null && afterPct >= fit.beforePct) return { applied: false as const, why: `no better (${fit.beforePct}% → ${afterPct}%)`, beforePct: fit.beforePct, afterPct };
  let maxNudge = 0; for (const v of fit.nudge) maxNudge = Math.max(maxNudge, Math.abs(v));
  return { applied: true as const, staged: r.staged, masks: r.masks, beforePct: fit.beforePct, afterPct, cols: fit.cols, maxNudgePct: +((maxNudge / h) * 100).toFixed(2) };
}

export type TraceLayers = Awaited<ReturnType<typeof traceLayers>>;

// Masks after a skirting line-up. The gaps between a moved piece's legs show
// the real room: Gemini's floor and skirting there carry its own floor line,
// and any error in the move shows up as a step beside the furniture.
export function layersAfterLineUp(layers: TraceLayers, moved: Record<string, Uint8Array | null | undefined>): TraceLayers {
  const floor = Uint8Array.from(moved.floor!);
  const tightFloor = layers.tightFloor ? Uint8Array.from(moved.tightFloor!) : layers.tightFloor;
  const solid = Uint8Array.from(moved.solid!);
  const core = Uint8Array.from(moved.core!);
  const zone = Uint8Array.from(moved.zone!);
  const pocket = moved.legPocket || null;
  if (pocket) {
    for (let i = 0; i < floor.length; i++) {
      if (!pocket[i]) continue;
      floor[i] = 0; core[i] = 0; solid[i] = 0; zone[i] = 1;
      if (tightFloor) tightFloor[i] = 0;
    }
  }
  return { ...layers, floor, tightFloor, artRegion: moved.artRegion!, solid, zone, core, legPocket: pocket ? Uint8Array.from(pocket) : null } as TraceLayers;
}

// Close-up re-trace. The full-image trace sometimes misses a piece — Bedroom
// 12's bedside table and lamp, cut off by the photo's right edge, were left
// out, so the final showed a ghost of them. The changed-area check already
// spots such places (staged image differs from the room, right next to the
// traced furniture). Here a crop around them is traced again, close up, and
// new pieces it finds there are added. Only pieces the trace model marks as
// furniture are added, and only where they reach a flagged area — never the
// changed area itself by rule (that could be a door Gemini moved).
const CLOSEUP_RETRACE = String(process.env.STAGE2_CLOSEUP_RETRACE ?? "1").trim() !== "0";
const CLOSEUP_MIN_AREA_PCT = 0.3;
const CLOSEUP_MIN_TOUCHING_PCT = 10;
const CUT_UNDER_MIN_AREA_PCT = Number(process.env.CUT_UNDER_MIN_AREA_PCT || 0.8); // missed area under furniture...
const CUT_UNDER_MIN_PCT = Number(process.env.CUT_UNDER_MIN_PCT || 40);              // ...with this much furniture right above it...
// Share of a "missed" area that is Gemini's floor over the real wall above
// which it counts as a moved floor line, not furniture the trace missed.
const FLOOR_OVER_WALL_SHARE = Number(process.env.STAGE2_FLOOR_OVER_WALL_SHARE || 0.4);
// A changed area under traced furniture that the trace left out (legs, a
// base, or the piece's shadow/reflection on the floor).
// A small piece of furniture missed by the trace (a bedside table's base or
// legs) is taken from Gemini's picture on EVERY attempt, not just the last
// (owner, Nov 2026: Harcourts job_a900475d failed three good bedrooms on ~1%
// gaps; six extra stagings in one day's logs). Larger gaps still re-stage.
// STAGE2_FILL_CUT_ANY_ATTEMPT_MAX_PCT=0 turns this off.
const FILL_CUT_ANY_ATTEMPT_MAX_PCT = Number(process.env.STAGE2_FILL_CUT_ANY_ATTEMPT_MAX_PCT ?? 2);
// Disputed door verdicts (owner, Nov 2026): when the early placement check's
// votes are split (two of three say a door is blocked, one says it is
// passable), the attempt is not rejected on the spot. The same check runs
// again on the finished image and decides (Harcourts job_0a1ff9bf: a dining
// set by wide patio doors, 2 to 1 against, while the owner saw the doors
// clear). A unanimous "blocked" still re-stages straight away.
// STAGE2_DEFER_DISPUTED_DOOR=off turns this off.
const DEFER_DISPUTED_DOOR = String(process.env.STAGE2_DEFER_DISPUTED_DOOR ?? "on").trim().toLowerCase() !== "off";
/** Split vote: the checkers disagreed and at least one said the door is passable. */
export function isDisputedVote(r: any): boolean {
  const v = r?.consensus?.votes;
  return Array.isArray(v) && v.length >= 3 && v.some((x: any) => x === false) && v.some((x: any) => x === true);
}
export function isFillableCutAnyAttempt(m: any): boolean {
  return FILL_CUT_ANY_ATTEMPT_MAX_PCT > 0 && isCutUnder(m) && m.areaPct <= FILL_CUT_ANY_ATTEMPT_MAX_PCT;
}
function isCutUnder(m: any): boolean {
  return m.areaPct >= CUT_UNDER_MIN_AREA_PCT && (m.underFurniturePct || 0) >= CUT_UNDER_MIN_PCT && (m.shadowPct || 0) < CUT_UNDER_MAX_SHADOW_PCT;
}
// A SMALL changed area under traced furniture (below the re-stage size): the
// piece's own shadow or a leg the trace left out. Pasting the real floor there
// left a hard-edged rectangle of bare carpet under a bedside table (Oct 2026,
// production: Bedroom_09, 0.44% of the photo, 71% under the table), so on every
// attempt Gemini's own pixels are kept there instead.
const THIN_PARTS_SOLID = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_THIN_PARTS_SOLID || "").trim().toLowerCase());
const FILL_SMALL_MISSED_UNDER = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_FILL_SMALL_MISSED_UNDER || "").trim().toLowerCase());
// Only where the real photo is plain floor there (see PLAIN_FLOOR_MAX_STD):
// never over a wall corner, skirting, a real sun patch or a hearth.
function isSmallMissedUnder(m: any): boolean {
  return FILL_SMALL_MISSED_UNDER && m.areaPct < CUT_UNDER_MIN_AREA_PCT && (m.underFurniturePct || 0) >= CUT_UNDER_MIN_PCT
    && typeof m.floorStd === "number" && m.floorStd <= PLAIN_FLOOR_MAX_STD;
}
// Largest gap (percent of photo height) under a "floating" piece that is
// still published on the last attempt. STAGE2_FLOAT_ACCEPT_LAST_GAP_PCT=0 turns it off.
const FLOAT_ACCEPT_LAST_GAP_PCT = Number(process.env.STAGE2_FLOAT_ACCEPT_LAST_GAP_PCT ?? 1.5);
// After all the furniture was brought forward, a piece still this little above
// the floor is accepted on any attempt (STAGE2_FLOAT_ACCEPT_AFTER_MOVE_PCT=0: off).
const FLOAT_ACCEPT_AFTER_MOVE_PCT = Number(process.env.STAGE2_FLOAT_ACCEPT_AFTER_MOVE_PCT ?? 1.5);
// Extra staging attempts after the normal re-stage budget, only when the last
// attempt failed on how the furniture fitted the room or a processing error.
export const EXTRA_RESTAGES = Math.max(0, Math.round(Number(process.env.STAGE2_MASKED_EXTRA_RESTAGES ?? 1)));
/**
 * Gemini changed the room the same way, in the same place, on two attempts
 * in a row: a further staging is very unlikely to differ, so the extra
 * re-stage is skipped (Nov 2026, job_2575a584: the right-hand wall's floor
 * line redrawn ~7% flatter on all three attempts, at x 79-95% each time).
 */
export function sameRoomChangeAgain(prev: any, cur: any): boolean {
  const changed = (r: any) => Array.isArray(r?.reasonsList) && r.reasonsList.includes("room changed to fit the furniture");
  if (!changed(prev) || !changed(cur)) return false;
  const spans = (r: any): [number, number][] => [
    ...((r?.skirtingBeside?.runs || []) as any[]).map((x) => [Number(x.x1Pct), Number(x.x2Pct)] as [number, number]),
    ...(Array.isArray(r?.floorMovedCheck?.atXPct) ? [r.floorMovedCheck.atXPct as [number, number]] : []),
  ].filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
  const A = spans(prev), B = spans(cur);
  return A.some(([a1, a2]) => B.some(([b1, b2]) => Math.min(a2, b2) - Math.max(a1, b1) >= 0.5 * Math.min(a2 - a1, b2 - b1)));
}

export function isLayoutOrTransientFailure(reason: string): boolean {
  const r = String(reason || "");
  return r === "furniture cut off by the trace"
    || r === "furniture floating"
    || r === "room changed to fit the furniture"
    || r === "room changed to fit the bed"
    || r === "bed not where the plan put it"
    || r === "room reshaped"
    || r.startsWith("processing error:");
}
// Use the relit final (real room + blend lighting) even when Gemini's checked
// blend passes. Off by default: photos that pass today keep their result.
const FINAL_RELIT_ALWAYS = ["on", "1", "true", "yes"].includes(String(process.env.STAGE2_FINAL_RELIT_ALWAYS || "").trim().toLowerCase());
// Floating furniture: try lining the pieces up with the real floor (see the
// skirting line-up) before re-staging. STAGE2_FLOAT_LINE_UP=off turns it off.
const FLOAT_LINE_UP = String(process.env.STAGE2_FLOAT_LINE_UP ?? "on").trim().toLowerCase() !== "off";
// Gemini's floor line under furniture vs the real one (STAGE2_SEAM_UNDER_CHECK=off: off).
const SEAM_UNDER_CHECK = String(process.env.STAGE2_SEAM_UNDER_CHECK ?? "on").trim().toLowerCase() !== "off";
const PUBLISH_CUT_ON_LAST_ATTEMPT = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_PUBLISH_CUT_ON_LAST_ATTEMPT || "").trim().toLowerCase());
const CUT_UNDER_MAX_SHADOW_PCT = Number(process.env.CUT_UNDER_MAX_SHADOW_PCT || 80); // ...unless it is mostly the floor in shade
const CLOSEUP_MAX_ADD_FACTOR = 3;     // may add at most 3x the flagged area...
const CLOSEUP_MAX_ADD_FLOOR_PCT = 2;  // ...or 2% of the photo, whichever is larger
const CLOSEUP_MAX_CUT_EDGE = 0.25;    // marking along >25% of a crop cut edge = a block
const CLOSEUP_TARGETS =
  "every piece of furniture and decor that was added in the staged image — beds, sofas, chairs, tables, bedside tables, dressers, lamps, rugs, plants, cushions and items on furniture — including pieces only partly in view at the edge of the photo";

async function closeUpRetrace(ctx: MaskedContext, floor: Mask, exclude: Uint8Array, minSpeck: number): Promise<Mask> {
  if (!CLOSEUP_RETRACE || ctx.lightTrace) return floor;
  const probe = await fillChangedGaps(floor, ctx.original, ctx.staged, ctx.w, ctx.h);
  const out = await closeUpCropRetrace(ctx, floor, exclude, minSpeck, probe);
  return BARE_ROOM_RETRACE ? bareRoomRetrace(ctx, out, exclude, minSpeck, probe) : out;
}

async function closeUpCropRetrace(ctx: MaskedContext, floor: Mask, exclude: Uint8Array, minSpeck: number, probe: Mask): Promise<Mask> {
  const { original, staged, w, h, row } = ctx;
  const missed: Array<{ areaPct: number; touchingFurniturePct: number; box: number[] }> = ((probe as any).possiblyMissedByTrace || []).filter(
    (m: any) => m.areaPct >= CLOSEUP_MIN_AREA_PCT && m.touchingFurniturePct >= CLOSEUP_MIN_TOUCHING_PCT
  );
  if (missed.length === 0) return floor;
  // Crop: all flagged areas, padded, at least 30% of the photo each way.
  let bx1 = 1, by1 = 1, bx2 = 0, by2 = 0;
  for (const m of missed) {
    bx1 = Math.min(bx1, m.box[0]); by1 = Math.min(by1, m.box[1]);
    bx2 = Math.max(bx2, m.box[2]); by2 = Math.max(by2, m.box[3]);
  }
  const PAD = 0.06, MIN = 0.3;
  const span = (a: number, b: number): [number, number] => {
    a = Math.max(0, a - PAD); b = Math.min(1, b + PAD);
    if (b - a < MIN) {
      const c = (a + b) / 2;
      a = Math.max(0, Math.min(1 - MIN, c - MIN / 2));
      b = a + MIN;
    }
    return [a, b];
  };
  const [cx1, cx2] = span(bx1, bx2), [cy1, cy2] = span(by1, by2);
  const left = Math.floor(cx1 * w), top = Math.floor(cy1 * h);
  const cw = Math.max(1, Math.min(w - left, Math.round((cx2 - cx1) * w)));
  const ch = Math.max(1, Math.min(h - top, Math.round((cy2 - cy1) * h)));
  row.closeUpRetrace = { flaggedAreas: missed, crop: [+cx1.toFixed(2), +cy1.toFixed(2), +cx2.toFixed(2), +cy2.toFixed(2)] };

  let raw: Buffer | null = null;
  if (ctx.offline || ctx.traceReplay) {
    raw = (ctx.traceReplay || ctx.io.load)?.("3_trace_closeup_raw.png") ?? null;
    if (!raw) warn(ctx, `[${ctx.name}] FROM_RUN: no saved close-up trace — skipping it`);
  } else {
    const cropOf = (b: Buffer) =>
      sharp(b).removeAlpha().resize(w, h, { fit: "fill" }).extract({ left, top, width: cw, height: ch }).png().toBuffer();
    const [sCrop, oCrop] = await Promise.all([cropOf(staged), cropOf(original)]);
    save(ctx, "3_trace_closeup_input.png", sCrop);
    raw = await callGeminiImage({
      model: TRACE_MODEL,
      parts: [
        { text: buildTracePrompt(ctx.roomType, CLOSEUP_TARGETS, "floor", ctx.tight) },
        { text: "STAGED_IMAGE" }, imagePart(sCrop, "image/png"),
        { text: "EMPTY_IMAGE" }, imagePart(oCrop, "image/png"),
      ],
      imageSize: TRACE_IMAGE_SIZE,
      aspectRatio: closestGeminiAspectRatio(cw, ch),
    })
      .then((res) => {
        row.closeUpRetrace.costUsd = approxOutputCost(res.usage);
        row.traceCostUsd = Number(((row.traceCostUsd || 0) + (row.closeUpRetrace.costUsd || 0)).toFixed(4));
        return res.image;
      })
      .catch((e) => {
        warn(ctx, `[${ctx.name}] close-up re-trace failed: ${String(e?.message || e).slice(0, 200)}`);
        return null;
      });
  }
  if (!raw) return floor;
  save(ctx, "3_trace_closeup_raw.png", raw);
  const cropBin = await binarizeTraceResponse(raw, cw, ch);
  if (cropBin.invalid) {
    warn(ctx, `[${ctx.name}] close-up trace REJECTED: not a mask (${cropBin.midtonePct}% mid-tones)`);
    row.closeUpRetrace.rejected = true;
    return floor;
  }
  // Which way round is the close-up mask? The whole-photo rule ("more than
  // 60% white = colours flipped") is wrong for a tight crop, where furniture
  // can fill most of the picture (Oct 2026, production: the close-up marked
  // the bed and a bedside table, was flipped to "just the plant", and the
  // table was published made of carpet). Pick the way round that agrees best
  // with the furniture the main trace already found inside the crop.
  let crop = cropBin.mask;
  {
    const asIs = cropBin.inverted ? invert(cropBin.mask) : cropBin.mask;
    const flipped = invert(asIs);
    const agree = (m: Uint8Array) => {
      let inter = 0, uni = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const a = m[y * cw + x], b = floor[(top + y) * w + left + x];
        if (a && b) inter++;
        if (a || b) uni++;
      }
      return uni ? inter / uni : 0;
    };
    const aAsIs = agree(asIs), aFlip = agree(flipped);
    crop = aAsIs >= aFlip ? asIs : flipped;
    row.closeUpRetrace.orientation = { whiteIsFurniture: aAsIs >= aFlip, agreeAsIs: +aAsIs.toFixed(2), agreeFlipped: +aFlip.toFixed(2) };
  }
  const added = new Uint8Array(w * h);
  let rawAdded = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const gi = (top + y) * w + left + x;
    if (crop[y * cw + x] && !exclude[gi] && !floor[gi]) { added[gi] = 1; rawAdded++; }
  }
  // Sanity checks (Oct 2026, production: a close-up trace came back as a
  // big block over doors and walls Gemini had redrawn; pasting it made a
  // patchwork room and hid the reshape from the room check):
  //  - it may add at most a few times the area that was flagged as missed;
  //  - nothing it adds may run along the crop's cut edge (inside the photo):
  //    a straight cut there is the crop boundary, not a furniture outline.
  const flaggedPx = missed.reduce((s, m) => s + (m.areaPct / 100) * w * h, 0);
  const maxAdd = Math.max(CLOSEUP_MAX_ADD_FACTOR * flaggedPx, w * h * (CLOSEUP_MAX_ADD_FLOOR_PCT / 100));
  const edgeRun = (fixed: "x" | "y", at: number, from: number, to: number) => {
    let run = 0, best = 0;
    for (let k = from; k < to; k++) {
      const i = fixed === "x" ? k * w + at : at * w + k;
      if (added[i]) { run++; if (run > best) best = run; } else run = 0;
    }
    return best;
  };
  const inset = 2;
  const cutEdges: Array<[number, number]> = [];
  if (left > 0) cutEdges.push([edgeRun("x", left + inset, top, top + ch), ch]);
  if (left + cw < w) cutEdges.push([edgeRun("x", left + cw - 1 - inset, top, top + ch), ch]);
  if (top > 0) cutEdges.push([edgeRun("y", top + inset, left, left + cw), cw]);
  if (top + ch < h) cutEdges.push([edgeRun("y", top + ch - 1 - inset, left, left + cw), cw]);
  const worstEdge = cutEdges.reduce((m, [run, len]) => Math.max(m, run / Math.max(1, len)), 0);
  if (rawAdded > maxAdd || worstEdge > CLOSEUP_MAX_CUT_EDGE) {
    const why = rawAdded > maxAdd
      ? `marked ${((rawAdded / (w * h)) * 100).toFixed(1)}% of the photo, far more than the ${((flaggedPx / (w * h)) * 100).toFixed(1)}% flagged`
      : `its marking runs along the crop's cut edge (${Math.round(worstEdge * 100)}% of it) — a block, not furniture`;
    warn(ctx, `[${ctx.name}] close-up trace REJECTED: ${why}`);
    row.closeUpRetrace.rejected = true;
    row.closeUpRetrace.rejectedWhy = why;
    return floor;
  }
  // Only where the staged image actually changed (new furniture is new
  // content; an unchanged wall or floor is never furniture).
  const changedMap: Uint8Array | undefined = (probe as any).changedMap;
  if (changedMap) {
    const near = dilate(changedMap, w, h, Math.max(1, Math.round(w * 0.004)));
    for (let i = 0; i < w * h; i++) if (added[i] && !near[i]) added[i] = 0;
  }
  const near = 0.02;
  const reaches = (p: { x1: number; y1: number; x2: number; y2: number }) =>
    missed.some((m) => p.x2 / w >= m.box[0] - near && p.x1 / w <= m.box[2] + near && p.y2 / h >= m.box[1] - near && p.y1 / h <= m.box[3] + near);
  const out = Uint8Array.from(floor);
  let addedPx = 0;
  for (const piece of labelComponents(added, w, h)) {
    if (piece.pixels.length < minSpeck || !reaches(piece)) continue;
    for (const i of piece.pixels) out[i] = 1;
    addedPx += piece.pixels.length;
  }
  row.closeUpRetrace.addedPctOfImage = +((addedPx / (w * h)) * 100).toFixed(2);
  log(ctx, `[${ctx.name}] close-up re-trace: ${missed.length} possibly-missed area(s); added ${row.closeUpRetrace.addedPctOfImage}% of image as furniture`);
  return out;
}

// Back-up trace: the bare room (see buildBareRoomTracePrompt). Runs only when,
// after the main and close-up traces, a furniture-sized changed area next to
// the furniture is still mostly untraced — so it costs one extra trace call
// on those photos only, and changes nothing on any other. What it may add is
// held to the same limits as the close-up: only where Gemini's picture really
// differs from the empty room, never wall art or reflections, only pieces
// that cover the flagged area, and a size cap. Wall, floor, doors and windows
// are WHITE in this trace, so a wall Gemini moved is never taken as furniture.
// What it adds is kept apart for the room-shape check like the close-up's.
// STAGE2_BARE_ROOM_RETRACE=off turns it off.
const BARE_ROOM_RETRACE = String(process.env.STAGE2_BARE_ROOM_RETRACE ?? "on").trim().toLowerCase() !== "off";
const BARE_ROOM_MIN_MISSED_PCT = 0.5;   // untraced area left (percent of photo) that triggers it
const BARE_ROOM_MAX_SHADOW_PCT = 60;   // a flagged area that is mostly shadow doesn't count
const BARE_ROOM_PIECE_COVER = 0.25;     // a piece must cover this share of a flagged area
const BARE_ROOM_MIN_CHANGED_SHARE = 0.5; // ...and be at least half new content (not the real room)
const BARE_ROOM_MAX_ADD_FACTOR = 4;     // may add at most 4x the flagged area...
const BARE_ROOM_MAX_ADD_FLOOR_PCT = 6;  // ...or 6% of the photo, whichever is larger (the flagged
                                        // area can be a sliver of the piece: job_1268d850's table,
                                        // both lamps and headboard were 5.4% for a 0.9% flag)

async function bareRoomRetrace(ctx: MaskedContext, floor: Mask, exclude: Uint8Array, minSpeck: number, probe: Mask): Promise<Mask> {
  const { original, staged, w, h, row } = ctx;
  const list: any[] = (probe as any).possiblyMissedByTrace || [];
  const px: ArrayLike<number>[] = (probe as any).missedPixels || [];
  const still: number[] = [];
  list.forEach((m, k) => {
    if (!px[k] || m.areaPct < CLOSEUP_MIN_AREA_PCT || m.touchingFurniturePct < CLOSEUP_MIN_TOUCHING_PCT) return;
    // Only a piece standing BESIDE the furniture: areas under it (legs, a
    // base) are already taken from Gemini's picture by the missed-area fill,
    // and areas that are mostly shadow are not furniture. (Tested on five
    // other Nov 2026 attempts: all of their flagged areas were one or the
    // other, and the back-up trace found nothing to add — a wasted call.)
    if ((m.shadowPct ?? 0) >= BARE_ROOM_MAX_SHADOW_PCT || (m.underFurniturePct ?? 0) >= CUT_UNDER_MIN_PCT) return;
    let covered = 0;
    for (let j = 0; j < px[k].length; j++) covered += floor[px[k][j]];
    if (covered < 0.5 * px[k].length) still.push(k);
  });
  const stillPct = still.reduce((s, k) => s + list[k].areaPct, 0);
  if (stillPct < BARE_ROOM_MIN_MISSED_PCT) return floor;
  row.bareRoomRetrace = { missedPct: +stillPct.toFixed(2) };

  let raw: Buffer | null = null;
  if (ctx.offline || ctx.traceReplay) {
    raw = (ctx.traceReplay || ctx.io.load)?.("3_trace_bareroom_raw.png") ?? null;
    if (!raw) log(ctx, `[${ctx.name}] FROM_RUN: no saved bare-room trace — skipping it`);
  } else {
    const meta = await sharp(staged).metadata();
    const stagedMime = meta.format === "jpeg" ? "image/jpeg" : meta.format === "png" ? "image/png" : "image/webp";
    raw = await callGeminiImage({
      model: TRACE_MODEL,
      parts: [
        { text: buildBareRoomTracePrompt(ctx.roomType) },
        { text: "STAGED_IMAGE" }, imagePart(staged, stagedMime),
        { text: "EMPTY_IMAGE" }, imagePart(original, ctx.originalMime),
      ],
      imageSize: TRACE_IMAGE_SIZE,
      aspectRatio: ctx.aspectRatio,
    })
      .then((res) => {
        row.bareRoomRetrace.costUsd = approxOutputCost(res.usage);
        row.traceCostUsd = Number(((row.traceCostUsd || 0) + (row.bareRoomRetrace.costUsd || 0)).toFixed(4));
        return res.image;
      })
      .catch((e) => {
        warn(ctx, `[${ctx.name}] bare-room re-trace failed: ${String(e?.message || e).slice(0, 200)}`);
        return null;
      });
  }
  if (!raw) return floor;
  save(ctx, "3_trace_bareroom_raw.png", raw);
  const bin = await binarizeTraceResponse(raw, w, h);
  if (bin.invalid) {
    warn(ctx, `[${ctx.name}] bare-room trace REJECTED: not a mask (${bin.midtonePct}% mid-tones)`);
    row.bareRoomRetrace.rejected = "not a mask";
    return floor;
  }
  // Which way round: the one that agrees best with the furniture already traced.
  const asIs = bin.mask, flipped = invert(bin.mask);
  const agree = (m: Uint8Array) => {
    let inter = 0, uni = 0;
    for (let i = 0; i < w * h; i++) { if (m[i] && floor[i]) inter++; if (m[i] || floor[i]) uni++; }
    return uni ? inter / uni : 0;
  };
  const aAsIs = agree(asIs), aFlip = agree(flipped);
  const furniture = aAsIs >= aFlip ? asIs : flipped;
  row.bareRoomRetrace.agreesWithTrace = +Math.max(aAsIs, aFlip).toFixed(2);
  if (Math.max(aAsIs, aFlip) < 0.5) {
    // It doesn't match the furniture the main trace found: not trusted.
    warn(ctx, `[${ctx.name}] bare-room trace REJECTED: it matches the traced furniture only ${Math.round(Math.max(aAsIs, aFlip) * 100)}%`);
    row.bareRoomRetrace.rejected = "does not match the traced furniture";
    return floor;
  }
  const changedMap: Uint8Array | undefined = (probe as any).changedMap;
  const nearChanged = changedMap ? dilate(changedMap, w, h, Math.max(1, Math.round(w * 0.004))) : null;
  const added = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (furniture[i] && !floor[i] && !exclude[i]) added[i] = 1;
  const flagged = new Int32Array(w * h).fill(-1);
  for (const k of still) for (let j = 0; j < px[k].length; j++) flagged[px[k][j]] = k;
  // "Changed" is judged per piece, not per pixel: after the lighting match a
  // light timber table can read close to the carpet in places, and cutting
  // those pixels out left the table's front as carpet (job_1268d850 replay).
  // A piece must still be mostly new content to be taken.
  const keep: number[][] = [];
  const pieces: Array<{ pct: number; changedPct: number; kept: boolean }> = [];
  for (const piece of labelComponents(added, w, h)) {
    if (piece.pixels.length < minSpeck) continue;
    const hits = new Map<number, number>();
    let changed = 0;
    for (const i of piece.pixels) {
      if (flagged[i] >= 0) hits.set(flagged[i], (hits.get(flagged[i]) || 0) + 1);
      if (!nearChanged || nearChanged[i]) changed++;
    }
    if (![...hits].some(([k, n]) => n >= BARE_ROOM_PIECE_COVER * px[k].length)) continue;
    const changedShare = changed / piece.pixels.length;
    const kept = changedShare >= BARE_ROOM_MIN_CHANGED_SHARE;
    pieces.push({ pct: +((piece.pixels.length / (w * h)) * 100).toFixed(2), changedPct: Math.round(changedShare * 100), kept });
    if (kept) keep.push(piece.pixels);
  }
  row.bareRoomRetrace.pieces = pieces;
  const addPx = keep.reduce((s, p) => s + p.length, 0);
  const maxAdd = Math.max(BARE_ROOM_MAX_ADD_FACTOR * (stillPct / 100) * w * h, w * h * (BARE_ROOM_MAX_ADD_FLOOR_PCT / 100));
  if (addPx > maxAdd) {
    const why = `would add ${((addPx / (w * h)) * 100).toFixed(1)}% of the photo, more than the ${((maxAdd / (w * h)) * 100).toFixed(1)}% allowed`;
    warn(ctx, `[${ctx.name}] bare-room trace REJECTED: ${why}`);
    row.bareRoomRetrace.rejected = why;
    return floor;
  }
  const out = Uint8Array.from(floor);
  for (const p of keep) for (const i of p) out[i] = 1;
  row.bareRoomRetrace.addedPctOfImage = +((addPx / (w * h)) * 100).toFixed(2);
  log(ctx, `[${ctx.name}] bare-room re-trace: ${stillPct.toFixed(2)}% still untraced next to the furniture; added ${row.bareRoomRetrace.addedPctOfImage}% of image as furniture`);
  return out;
}

export async function traceLayers(ctx: MaskedContext) {
  const { original, staged, w, h, row } = ctx;
  const stagedMeta = await sharp(staged).metadata();
  const stagedMime = stagedMeta.format === "jpeg" ? "image/jpeg" : stagedMeta.format === "png" ? "image/png" : "image/webp";
  const passes = await Promise.all(
    (ctx.lightTrace ? lightTracePassesFor(ctx.roomType) : tracePassesFor(ctx.roomType)).filter((pass) => !(ctx.skipReflections && pass.kind === "reflection")).map(async (pass) => {
      if (ctx.offline || ctx.traceReplay) {
        const saved = (ctx.traceReplay || ctx.io.load)?.(`3_trace_${pass.label}_raw.png`) ?? null;
        if (!saved) {
          warn(ctx, `[${ctx.name}] FROM_RUN: no saved "${pass.label}" trace — treating it as empty`);
          return { label: pass.label, kind: pass.kind, mask: new Uint8Array(w * h), inverted: false, cost: 0 };
        }
        save(ctx, `3_trace_${pass.label}_raw.png`, saved);
        return { label: pass.label, kind: pass.kind, ...(await binarizeTraceResponse(saved, w, h)), cost: 0 };
      }
      const res = await callGeminiImage({
        model: TRACE_MODEL,
        parts: [
          { text: buildTracePrompt(ctx.roomType, pass.targets, pass.kind, ctx.tight) },
          { text: "STAGED_IMAGE" }, imagePart(staged, stagedMime),
          { text: "EMPTY_IMAGE" }, imagePart(original, ctx.originalMime),
        ],
        imageSize: TRACE_IMAGE_SIZE,
        aspectRatio: ctx.aspectRatio,
      });
      save(ctx, `3_trace_${pass.label}_raw.png`, res.image);
      const bin = await binarizeTraceResponse(res.image, w, h);
      return { label: pass.label, kind: pass.kind, ...bin, cost: approxOutputCost(res.usage) };
    })
  );
  row.traceCostUsd = Number(passes.reduce((sum, p) => sum + (p.cost || 0), 0).toFixed(4));
  row.tracePasses = passes.map((p) => ({
    pass: p.label,
    coveragePct: +(ratioOf(p.mask) * 100).toFixed(1),
    coloursFlipped: p.inverted,
    ...((p as any).invalid ? { rejected: `not a mask (${(p as any).midtonePct}% mid-tones)` } : {}),
  }));
  for (const p of passes) {
    if ((p as any).invalid) warn(ctx, `[${ctx.name}] ${p.label} trace REJECTED: Gemini returned a photo, not a mask (${(p as any).midtonePct}% mid-tones) — treated as empty`);
  }

  // Floor furniture: merge the floor passes (OR), drop tiny specks only (thin
  // parts like lamp stems and chair legs must survive), then fill holes.
  const minSpeck = Math.max(24, Math.round(w * h * 0.0002));
  // The wall-art pass is the authority on wall items: Gemini sometimes also
  // marks art in the furniture passes, which would let it skip the wall-art
  // safety checks, so anything the art pass marks is taken out of the floor
  // layer first.
  let artAll = new Uint8Array(w * h);
  for (const p of passes) if (p.kind === "wall_art") for (let i = 0; i < artAll.length; i++) artAll[i] |= p.mask[i];
  artAll = removeSmallComponents(artAll, w, h, minSpeck);
  let floor = new Uint8Array(w * h);
  for (const p of passes) if (p.kind === "floor") for (let i = 0; i < floor.length; i++) floor[i] |= p.mask[i] & (artAll[i] ^ 1);
  floor = removeSmallComponents(floor, w, h, minSpeck);
  // Reflections: their own pass is the authority too (so a "reflection" can't
  // skip its checks by also being marked as furniture), except pieces that
  // turn out to be the furniture itself.
  let reflAll = new Uint8Array(w * h);
  for (const p of passes) if (p.kind === "reflection") for (let i = 0; i < reflAll.length; i++) reflAll[i] |= p.mask[i];
  reflAll = removeSmallComponents(reflAll, w, h, minSpeck);
  // Close-up re-trace of changed areas the trace may have missed (only when
  // there are some), e.g. a bedside table cut off by the photo's edge.
  // What the close-up adds is kept apart for the room-shape check below: it
  // must never be able to hide a reshaped room (Oct 2026, production).
  const closeUpAdded = new Uint8Array(w * h);
  if (ctx.tight) {
    const exclude = new Uint8Array(w * h);
    for (let i = 0; i < exclude.length; i++) exclude[i] = artAll[i] | reflAll[i];
    const before = floor;
    floor = await closeUpRetrace(ctx, floor, exclude, minSpeck);
    for (let i = 0; i < floor.length; i++) closeUpAdded[i] = floor[i] & (before[i] ^ 1);
  }
  // Mirrors in the empty room — only looked up when a reflection was found.
  let mirrorMask: Mask | null = null;
  if (labelComponents(reflAll, w, h).some((p) => p.pixels.length >= Math.max(64, Math.round(w * h * 0.0005)))) {
    let mirrorRaw: Buffer | null = null;
    if (ctx.offline || ctx.traceReplay) {
      mirrorRaw = (ctx.traceReplay || ctx.io.load)?.("3_trace_mirrors_raw.png") ?? null;
      if (!mirrorRaw) warn(ctx, `[${ctx.name}] FROM_RUN: no saved mirrors trace — reflections will be dropped`);
    } else {
      mirrorRaw = await callGeminiImage({
        model: TRACE_MODEL,
        parts: [{ text: buildMirrorPrompt(ctx.roomType) }, imagePart(original, ctx.originalMime)],
        imageSize: TRACE_IMAGE_SIZE,
        aspectRatio: ctx.aspectRatio,
      })
        .then((res) => {
          row.mirrorTraceCostUsd = approxOutputCost(res.usage);
          return res.image;
        })
        .catch((e) => {
          warn(ctx, `[${ctx.name}] mirror trace failed: ${String(e?.message || e).slice(0, 200)} — reflections will be dropped`);
          return null;
        });
    }
    if (mirrorRaw) {
      save(ctx, "3_trace_mirrors_raw.png", mirrorRaw);
      const mirrorBin = await binarizeTraceResponse(mirrorRaw, w, h);
      if (mirrorBin.invalid) warn(ctx, `[${ctx.name}] mirror trace REJECTED: not a mask — reflections will be dropped`);
      mirrorMask = mirrorBin.mask;
      row.mirrorPctOfImage = +(ratioOf(mirrorMask) * 100).toFixed(1);
    }
  }
  const refl = await evaluateReflections(original, staged, reflAll, floor, w, h, mirrorMask ?? new Uint8Array(w * h));
  row.reflections = refl.report;
  for (const piece of refl.report) {
    log(ctx, `[${ctx.name}] reflection ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
  }
  for (let i = 0; i < floor.length; i++) if (refl.keep[i] || refl.dropped[i]) floor[i] = 0;

  // Appliances (kitchens): their pass is the authority; each is kept only
  // inside an empty appliance space of the real room, then treated exactly
  // like furniture (shadows, edges, lighting).
  let appAll = new Uint8Array(w * h);
  for (const p of passes) if (p.kind === "appliance") for (let i = 0; i < appAll.length; i++) appAll[i] |= p.mask[i];
  appAll = removeSmallComponents(appAll, w, h, minSpeck);
  if (labelComponents(appAll, w, h).some((p) => p.pixels.length >= Math.max(64, Math.round(w * h * 0.0005)))) {
    let spaceRaw: Buffer | null = null;
    if (ctx.offline || ctx.traceReplay) {
      spaceRaw = (ctx.traceReplay || ctx.io.load)?.("3_trace_appliance_spaces_raw.png") ?? null;
    } else {
      spaceRaw = await callGeminiImage({
        model: TRACE_MODEL,
        parts: [{ text: buildApplianceSpacePrompt(ctx.roomType) }, imagePart(original, ctx.originalMime)],
        imageSize: TRACE_IMAGE_SIZE,
        aspectRatio: ctx.aspectRatio,
      })
        .then((res) => {
          row.applianceSpaceTraceCostUsd = approxOutputCost(res.usage);
          return res.image;
        })
        .catch((e) => {
          warn(ctx, `[${ctx.name}] appliance-space trace failed: ${String(e?.message || e).slice(0, 200)} — appliances will be dropped`);
          return null;
        });
    }
    let spaceMask = new Uint8Array(w * h);
    if (spaceRaw) {
      save(ctx, "3_trace_appliance_spaces_raw.png", spaceRaw);
      const spaceBin = await binarizeTraceResponse(spaceRaw, w, h);
      if (spaceBin.invalid) warn(ctx, `[${ctx.name}] appliance-space trace REJECTED: not a mask — appliances will be dropped`);
      spaceMask = spaceBin.mask;
      row.applianceSpacePctOfImage = +(ratioOf(spaceMask) * 100).toFixed(1);
    }
    const appl = await evaluateReflections(original, staged, appAll, floor, w, h, spaceMask, { what: "appliance", space: "an empty appliance space", maxAreaPct: 15 });
    row.appliances = appl.report;
    for (const piece of appl.report) log(ctx, `[${ctx.name}] appliance ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
    for (let i = 0; i < floor.length; i++) {
      if (appl.dropped[i]) floor[i] = 0;
      if (appl.keep[i]) floor[i] = 1;
    }
  }
  const tracedRatio = ratioOf(floor);
  // Harmonise keeps the tight outline (only small enclosed holes filled), so
  // no floor or shadow from the staged image comes along with the furniture.
  // Gaps inside a traced piece (a coffee table Gemini drew black on top of a
  // white rug) are filled too, but only where the staged image really
  // differs from the original — bare floor showing between chair legs stays.
  let tightFloor = ctx.tight ? await fillChangedGaps(floor, original, staged, w, h) : null;
  // Holes in a piece that show Gemini's room (wall/skirting/floor) go to the
  // real photo, in both outlines (see dropRoomColouredGaps).
  const tracedOnly = Uint8Array.from(floor);
  const stagedRgb = await sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).blur(1).raw().toBuffer();
  if (tightFloor && GAP_ROOM_CHECK) {
    const g = dropRoomColouredGaps(tightFloor, tracedOnly, stagedRgb, w, h);
    // Keep the areas the trace may have missed (and their pixels): the new
    // mask didn't carry them, so the small-gap fill below never ran (Nov 2026:
    // every "cut off by the trace" re-staged, even on the last attempt).
    for (const k of ["possiblyMissedByTrace", "missedPixels", "changedMap"]) (g.mask as any)[k] = (tightFloor as any)[k];
    tightFloor = g.mask;
    if (g.droppedPct > 0) { row.roomGapsDroppedPct = g.droppedPct; log(ctx, `[${ctx.name}] holes in furniture showing Gemini's room (not furniture) left to the real photo: ${g.droppedPct}% of image`); }
  }
  if (tightFloor) row.possiblyMissedByTrace = (tightFloor as any).possiblyMissedByTrace;
  // Where Gemini drew floor over the real wall (pushed a wall back). Such an
  // area is not furniture the trace missed: it is never taken from Gemini's
  // picture, and the re-stage decision treats it as a moved floor line.
  const floorOverWall = FLOOR_OVER_WALL_GUARD
    ? await floorOverRealWall(original, staged, floor, w, h).catch(() => null)
    : null;
  if (floorOverWall && floorOverWall.pctOfImage > 0) row.floorOverWall = { pctOfImage: floorOverWall.pctOfImage, maxRisePct: floorOverWall.maxRisePct };
  const overWallShare = (piece: ArrayLike<number>) => {
    if (!floorOverWall) return 0;
    let n = 0;
    for (let j = 0; j < piece.length; j++) if (floorOverWall.mask[piece[j]]) n++;
    return piece.length ? n / piece.length : 0;
  };
  if (tightFloor) {
    // Keep Gemini's own pixels in areas missed under furniture — the legs or
    // base when the trace really cut a piece off, or the piece's natural
    // shadow when that is all it was. Pasting the real photo there instead
    // broke up 007's bedside table (Oct 2026 replay). Small areas: every
    // attempt. Re-stage-sized areas: last attempt only (else re-stage).
    const list: any[] = (tightFloor as any).possiblyMissedByTrace || [];
    const px: ArrayLike<number>[] = (tightFloor as any).missedPixels || [];
    const filled: any[] = [];
    list.forEach((m, k) => {
      if (!px[k] || !((ctx.fillMissedUnder && isCutUnder(m)) || isFillableCutAnyAttempt(m) || isSmallMissedUnder(m))) {
        if (isCutUnder(m)) log(ctx, `[${ctx.name}] missed area ${m.areaPct}% at x ${Math.round(m.box[0] * 100)}-${Math.round(m.box[2] * 100)}% not filled: ${!px[k] ? "no pixels" : `over ${FILL_CUT_ANY_ATTEMPT_MAX_PCT}% (re-stage)`}`);
        return;
      }
      if (overWallShare(px[k]) >= FLOOR_OVER_WALL_SHARE) { // Gemini's floor over the real wall
        log(ctx, `[${ctx.name}] missed area ${m.areaPct}% at x ${Math.round(m.box[0] * 100)}-${Math.round(m.box[2] * 100)}% not filled: mostly Gemini's floor over the real wall`);
        return;
      }
      const piece = px[k];
      for (let j = 0; j < piece.length; j++) { floor[piece[j]] = 1; tightFloor[piece[j]] = 1; }
      filled.push(m);
    });
    if (filled.length) {
      const big = filled.filter(isCutUnder);
      if (big.length) row.missedUnderFilled = big;
      const small = filled.filter((m) => !isCutUnder(m));
      if (small.length) row.smallMissedUnderFilled = small;
      log(ctx, `[${ctx.name}] took ${filled.map((m) => `${m.areaPct}%`).join(", ")} under furniture from Gemini's picture (missed by the trace)`);
    }
  }
  {
    const beforeFill = Uint8Array.from(floor);
    floor = fillFurnitureColumns(floor, w, h);
    if (GAP_ROOM_CHECK) floor = dropRoomColouredGaps(floor, beforeFill, stagedRgb, w, h).mask;
  }
  // Floor under a piece, between its legs: keep Gemini's (its shadow there).
  // Kept as its own mask too: after a skirting line-up these gaps show the
  // real room instead (Gemini's skirting there would sit at the wrong height).
  let legPocket: Uint8Array | null = null;
  if (LEG_POCKET_FILL && ctx.tight) {
    const lp = await findLegPockets(floor, original, staged, w, h).catch(() => null);
    if (lp && lp.pockets.length) {
      row.legPockets = lp.pockets;
      legPocket = new Uint8Array(w * h);
      for (let i = 0; i < floor.length; i++) if (lp.fill[i] && !floor[i]) legPocket[i] = 1;
      for (let i = 0; i < floor.length; i++) if (lp.fill[i]) { floor[i] = 1; if (tightFloor) tightFloor[i] = 1; }
      const filled = lp.pockets.filter((pk) => pk.filled);
      if (filled.length) log(ctx, `[${ctx.name}] floor between furniture legs taken from Gemini's picture: ${filled.map((pk) => `${pk.areaPct}%`).join(", ")}`);
    }
  }
  const furnitureRatio = ratioOf(floor);
  save(ctx, "3_mask_traced.png", await maskToPng(floor, w, h));
  if (furnitureRatio < 0.01) throw new Error(`tracing found almost no furniture (${(furnitureRatio * 100).toFixed(2)}% of image)`);

  // Wall art: its own layer, kept piece by piece only where it is safe.
  const art = await evaluateWallArt(original, staged, artAll, floor, w, h);
  row.wallArt = art.report;
  for (const piece of art.report) {
    log(ctx, `[${ctx.name}] wall art ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
  }

  // Solid layer = furniture + kept art, with a thin margin. Shadow zone =
  // around and below floor furniture, outside the solid layer.
  const artOnly = await refineArtRegion(original, staged, art.keep, w, h);
  // Kept reflections are carried over exactly like kept art: refined to where
  // the staged image actually differs, taken per pixel, no shadow zone.
  const reflRegion = await refineArtRegion(original, staged, refl.keep, w, h);
  const artRegion = new Uint8Array(w * h);
  for (let i = 0; i < artRegion.length; i++) artRegion[i] = artOnly[i] | reflRegion[i];
  let solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i++) solid[i] = floor[i] | artRegion[i];
  solid = dilate(solid, w, h, Math.max(1, Math.round((w * SOLID_GROW_PCT) / 100)));
  let zone = dilate(floor, w, h, Math.round((w * ZONE_GROW_PCT) / 100));
  zone = growDown(zone, w, h, Math.round((h * ZONE_DOWN_PCT) / 100));
  for (let i = 0; i < zone.length; i++) if (solid[i]) zone[i] = 0;
  row.maskPct = {
    traced: +(tracedRatio * 100).toFixed(1),
    furniture: +(furnitureRatio * 100).toFixed(1),
    wallArtKept: +(ratioOf(art.keep) * 100).toFixed(1),
    wallArtDropped: +(ratioOf(art.dropped) * 100).toFixed(1),
    reflectionsKept: +(ratioOf(reflRegion) * 100).toFixed(1),
    reflectionsDropped: +(ratioOf(refl.dropped) * 100).toFixed(1),
    solid: +(ratioOf(solid) * 100).toFixed(1),
    shadowZone: +(ratioOf(zone) * 100).toFixed(1),
  };
  // Core = furniture shrunk inwards; wall art has no core (decided per pixel).
  const core = erode(floor, w, h, Math.max(1, Math.round((w * CORE_ERODE_PCT) / 100)));
  for (let i = 0; i < core.length; i++) core[i] |= artRegion[i];
  const solidPng = await maskToPng(solid, w, h);
  save(ctx, "3_mask_final.png", solidPng);
  save(ctx, "3_mask_shadow_zone.png", await maskToPng(zone, w, h));
  const droppedAll = new Uint8Array(w * h);
  for (let i = 0; i < droppedAll.length; i++) droppedAll[i] = art.dropped[i] | refl.dropped[i];
  const traced = await layersOverlay(staged, floor, artOnly, droppedAll, w, h, reflRegion);
  save(ctx, "3_mask_overlay.jpg", traced);

  // Room-change measurements ignore furniture and ALL traced art (kept or
  // dropped), so they reflect the room itself. Furniture found only by the
  // close-up re-trace is NOT ignored: the room check runs as if the close-up
  // had not happened, so it can't hide redrawn walls or doors.
  const measureMask = new Uint8Array(w * h);
  for (let i = 0; i < measureMask.length; i++) measureMask[i] = (solid[i] & (closeUpAdded[i] ^ 1)) | artAll[i] | reflAll[i];
  row.stagedChangesOutsideMask = await measureOutsideDrift(original, staged, measureMask, w, h);
  row.framingCheck = await checkFraming(original, staged, measureMask, w, h);
  if (row.framingCheck.framingChanged) {
    warn(ctx, `[${ctx.name}] Gemini reshaped/reframed the room (typical wall/ceiling patch differs by ${row.framingCheck.medianDiff}) — paste-back can't fix this; this photo would need re-staging`);
  }
  const undone = await undoneOverlay(original, staged, solid, w, h);
  save(ctx, "4_changes_removed_by_pasteback.jpg", undone);
  return { floor, tightFloor, artRegion, solid, zone, core, solidPng, traced, undone, floorOverWall: floorOverWall?.mask ?? null, legPocket };
}

// ── Carry-over (Nov 2026) ───────────────────────────────────────────────────
// When the furniture had to be moved to stand on the real floor (bring
// forward / skirting line-up), Gemini is given the empty photo and ONLY the
// moved furniture (cut out on grey, with the wall art) and asked to put it
// into the room exactly there. In tests it kept the furniture where our code
// put it and blended it in more naturally; given its own staged room instead,
// it copied that room's raised floor. The carried-over picture then goes
// through every check again (a lighter trace); if it fails, the moved result
// is used as before. On by default (owner, Nov 2026); STAGE2_CARRY_OVER=off turns it off.
const CARRY_ROUND_MAX_GROW = Number(process.env.STAGE2_CARRY_ROUND_MAX_GROW || 0.05);
export const CARRY_OVER = String(process.env.STAGE2_CARRY_OVER ?? "on").trim().toLowerCase() !== "off";
const CARRY_OVER_MODEL = process.env.STAGE2_CARRY_OVER_MODEL || HARMONISE_MODEL;
export const CARRY_OVER_PROMPT = `You are given two images.
IMAGE 1 is a real photo of an empty room.
IMAGE 2 shows furniture and decor cut out on a plain grey background — there is no room in it. Each piece is already shown in exactly the right place and at the right size for IMAGE 1's room.

Edit IMAGE 1: put these pieces into IMAGE 1 exactly where IMAGE 2 shows them — the same position, size and angle in the frame — and change nothing else.

IMAGE 1's room must stay exactly as it is: the same framing, camera position, zoom and perspective; every wall, corner, window, curtain, door, light fitting and the ceiling in the same place; the same floor and carpet; and the skirting boards and the line where each wall meets the floor exactly where IMAGE 1 shows them.

Make the furniture look naturally part of the room: match IMAGE 1's lighting and colour, finish any edge of a piece that the cut-out left rough, and add soft natural shadows where the furniture meets the floor and wall. Do not move, resize or redraw the pieces, do not add any other furniture or decor, and do not add any grey background.

Return only the edited IMAGE 1.`;

async function carryOverFurniture(ctx: MaskedContext, layers: TraceLayers): Promise<Buffer | null> {
  const { w, h, row } = ctx;
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < keep.length; i++) if (layers.floor[i] || (layers.tightFloor && layers.tightFloor[i]) || (layers.artRegion && layers.artRegion[i])) keep[i] = 1;
  const m = dilate(keep, w, h, 2);
  const st = await sharp(ctx.staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const cut = Buffer.alloc(w * h * 3, 128);
  for (let i = 0; i < w * h; i++) if (m[i]) { cut[i * 3] = st[i * 3]; cut[i * 3 + 1] = st[i * 3 + 1]; cut[i * 3 + 2] = st[i * 3 + 2]; }
  const cutJpg = await sharp(cut, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  save(ctx, "9_carry_over_cutout.jpg", cutJpg);
  if (ctx.offline) {
    const saved = ctx.io.load?.("9_carry_over_raw.png") ?? null;
    if (!saved) warn(ctx, `[${ctx.name}] FROM_RUN: no saved carry-over picture — keeping the moved result`);
    return saved;
  }
  const empty = await sharp(ctx.original).removeAlpha().resize(w, h, { fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const res = await callGeminiImage({
    model: CARRY_OVER_MODEL,
    parts: [{ text: CARRY_OVER_PROMPT }, { text: "IMAGE 1 (the real, empty room — edit this one):" }, imagePart(empty, "image/jpeg"), { text: "IMAGE 2 (the furniture, already in place, on grey):" }, imagePart(cutJpg, "image/jpeg")],
    imageSize: HARMONISE_IMAGE_SIZE,
    aspectRatio: ctx.aspectRatio,
  }).catch((e) => { warn(ctx, `[${ctx.name}] carry-over call failed: ${String(e?.message || e).slice(0, 200)}`); return null; });
  if (!res) return null;
  row.carryOver = { ...(row.carryOver || {}), costUsd: approxOutputCost(res.usage) };
  const img = await sharp(res.image).resize(w, h, { fit: "fill" }).png().toBuffer();
  save(ctx, "9_carry_over_raw.png", img);
  return img;
}

export async function harmonise(ctx: MaskedContext, layers: TraceLayers) {
  const { original, staged, w, h, row } = ctx;
  const { tightFloor, artRegion } = layers;
  if (!tightFloor) throw new Error("harmonise needs tight tracing (ctx.tight)");
  let harmRaw: Buffer | null = null;
  let checkedBlend: Buffer | null = null, checkedBlendView: Buffer | null = null;
  log(ctx, `[${ctx.name}] harmonise: safe composite -> Gemini blend -> borrow shadows/lighting only`);
  // Phase 1: original room + tightly traced furniture + kept art, no shadows.
  let tSolid = new Uint8Array(w * h);
  for (let i = 0; i < tSolid.length; i++) tSolid[i] = tightFloor[i] | artRegion[i];
  tSolid = dilate(tSolid, w, h, Math.max(1, Math.round((w * SOLID_GROW_PCT) / 100)));
  const coreR = Math.max(1, Math.round((w * CORE_ERODE_PCT) / 100));
  const tCore = erode(tightFloor, w, h, coreR);
  // Thin parts (legs, rails, thin frames) narrower than the edge band have no
  // core at all, so the edge matte decided them pixel by pixel by colour: dark
  // legs on dark carpet read as "floor" and were swapped for the real carpet
  // (Oct 2026, production Kitchen_01: a TV unit's legs came out broken). They
  // are made core here. A thin strip of staged floor along a big piece's edge
  // is not thin by this test (it survives the opening), so the matte still
  // trims it.
  // Only upright pieces (legs, posts: at least 2.5x taller than wide); flat
  // strips (under a seat, along a rail) are left to the matte.
  let thinPct = 0;
  if (THIN_PARTS_SOLID) {
    const opened = dilate(tCore, w, h, coreR);
    const residue = new Uint8Array(w * h);
    for (let i = 0; i < residue.length; i++) if (tightFloor[i] && !opened[i]) residue[i] = 1;
    let n = 0;
    for (const piece of labelComponents(residue, w, h)) {
      const pw = piece.x2 - piece.x1 + 1, ph = piece.y2 - piece.y1 + 1;
      if (piece.pixels.length < 12 || ph < 2.5 * pw) continue;
      for (const i of piece.pixels) tCore[i] = 1;
      n += piece.pixels.length;
    }
    thinPct = +((n / tCore.length) * 100).toFixed(2);
  }
  let bandLegPct = 0;
  if (BAND_LEG_KEEP) {
    const bl = await findBandLegs(staged, tSolid, tCore, w, h).catch(() => null);
    if (bl) {
      for (let i = 0; i < tCore.length; i++) if (bl.legs[i]) tCore[i] = 1;
      bandLegPct = bl.pctOfImage;
    }
  }
  for (let i = 0; i < tCore.length; i++) tCore[i] |= artRegion[i];
  const tSolidPng = await maskToPng(tSolid, w, h);
  const tCorePng = await maskToPng(tCore, w, h);
  save(ctx, "3_mask_tight.png", tSolidPng);
  const safeRes = await compositeLayers(original, staged, tSolidPng, tCorePng, await maskToPng(new Uint8Array(w * h), w, h), w, h, false, true);
  const edgeMattePctOfBand = safeRes.edgeMattePctOfBand;
  const safeFinal = safeRes.buffer;
  save(ctx, "9_safe_composite.webp", safeFinal);

  // Phase 2: Gemini adds shadows / blends lighting on the safe image.
  if (ctx.blendFrom) {
    harmRaw = ctx.blendFrom;
    save(ctx, "9_harmonise_raw.png", await sharp(harmRaw).png().toBuffer());
    log(ctx, `[${ctx.name}] harmonise: lighting and shadows taken from the carried-over picture (no extra Gemini call)`);
  } else if (ctx.offline) {
    harmRaw = ctx.io.load?.("9_harmonise_raw.png") ?? null;
    if (!harmRaw) warn(ctx, `[${ctx.name}] FROM_RUN: no saved 9_harmonise_raw.png — using the safe composite as the final`);
  } else {
    harmRaw = await callGeminiImage({
      model: HARMONISE_MODEL,
      parts: [{ text: buildHarmonisePrompt(ctx.roomType, { completeCutPieces: !!ctx.completionZone }) }, imagePart(safeFinal, "image/webp")],
      imageSize: HARMONISE_IMAGE_SIZE,
      aspectRatio: ctx.aspectRatio,
    })
      .then((res) => {
        row.harmoniseCostUsd = approxOutputCost(res.usage);
        return res.image;
      })
      .catch((e) => {
        warn(ctx, `[${ctx.name}] harmonise call failed: ${String(e?.message || e).slice(0, 200)}`);
        row.harmoniseError = String(e?.message || e).slice(0, 300);
        return null;
      });
  }
  if (harmRaw) save(ctx, "9_harmonise_raw.png", harmRaw);

  // Phase 3: borrow only shadows (near furniture) and furniture lighting.
  let hZone = dilate(tightFloor, w, h, Math.round((w * HARM_ZONE_GROW_PCT) / 100));
  hZone = growDown(hZone, w, h, Math.round((h * HARM_ZONE_DOWN_PCT) / 100));
  for (let i = 0; i < hZone.length; i++) if (tSolid[i]) hZone[i] = 0;
  // Walls: shadows only right beside a kept piece (see WALL_SHADOW_REACH_PCT).
  let wallShadowTrimmedPct = 0;
  if (WALL_SHADOW_REACH_PCT > 0) {
    const FW = Math.min(800, w), FH = Math.max(8, Math.round((FW * h) / w));
    const lo = await realFloorLine(await sharp(original).removeAlpha().resize(FW, FH, { fit: "fill" }).png().toBuffer(), FW, FH).catch(() => null);
    if (lo) {
      const floorY = new Int32Array(w);
      for (let x = 0; x < w; x++) { const v = lo[Math.min(FW - 1, Math.round((x / w) * (FW - 1)))]; floorY[x] = v < 0 ? -1 : Math.round((v / FH) * h); }
      const t = trimWallShadowZone(hZone, tightFloor, floorY, w, h, Math.round((w * WALL_SHADOW_REACH_PCT) / 100));
      hZone = t.zone;
      wallShadowTrimmedPct = t.trimmedPct;
    }
  }
  const affected = new Uint8Array(w * h);
  for (let i = 0; i < affected.length; i++) affected[i] = tSolid[i] | hZone[i];
  save(ctx, "3_mask_harmonise_shadow_zone.png", await maskToPng(hZone, w, h));
  row.harmonise = { tightFurniturePct: +(ratioOf(tightFloor) * 100).toFixed(1), shadowZonePct: +(ratioOf(hZone) * 100).toFixed(1), wallShadowTrimmedPctOfZone: wallShadowTrimmedPct, edgeMattePctOfBand, thinPartsPctOfImage: thinPct, bandLegsPctOfImage: bandLegPct };
  let blendUsable = !!harmRaw;
  if (harmRaw) {
    // Did Gemini keep the room's framing in its blend? If not, its shadows
    // won't line up, so none of it is used.
    const framing = await checkFraming(safeFinal, harmRaw, affected, w, h);
    row.harmonise.blendFraming = framing;
    // How much Gemini changed the rest of the room in its blend (ignored either way).
    row.harmonise.blendChangesElsewhere = await measureOutsideDrift(safeFinal, harmRaw, affected, w, h);
    if (framing.framingChanged) {
      blendUsable = false;
      warn(ctx, `[${ctx.name}] Gemini's blend reframed the room (median ${framing.medianDiff}) — using the safe composite without shadows`);
    }
  }
  let sunPatchMask: Mask | null = null;
  let noBorrow: Mask | null = null;
  let harmFinal: Buffer;
  if (blendUsable) {
    const hZonePng = await maskToPng(hZone, w, h);
    // The safe composite's own furniture alpha (exactly which pixels are
    // staged furniture) protects the furniture from floor shadow/sun steps.
    const furnPng = safeRes.furnitureAlphaPng;
    save(ctx, "9_furniture_alpha.png", furnPng);
    const sun = await removeSunPatches(safeFinal, harmRaw!, tSolidPng, furnPng, hZonePng);
    row.harmonise.sunPatchPctOfImage = sun.regionPctOfImage;
    if (sun.regionMask) {
      save(ctx, "9_sun_patch_region.png", sun.regionMask);
      const m = await sharp(sun.regionMask).resize(w, h, { fit: "fill" }).grayscale().raw().toBuffer();
      sunPatchMask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) sunPatchMask[i] = m[i] > 0 ? 1 : 0;
    }
    // Where Gemini's blend (or its staging) shows floor over the real wall,
    // its "darker" pixels are floor, not shadow: nothing is borrowed there
    // (Oct 2026, job_609fbe6a: a blurred grey panel on the real wall).
    let noShadowPng: Buffer | null = null;
    if (FLOOR_OVER_WALL_GUARD) {
      const fb = await floorOverRealWall(original, harmRaw!, tSolid, w, h, { fullColumns: true }).catch(() => null);
      const both = new Uint8Array(w * h);
      let any = false;
      for (let i = 0; i < both.length; i++) if ((fb && fb.mask[i]) || (layers.floorOverWall && layers.floorOverWall[i])) { both[i] = 1; any = true; }
      if (any) {
        noBorrow = dilate(both, w, h, Math.max(2, Math.round(w * 0.012)));
        for (let i = 0; i < noBorrow.length; i++) if (tSolid[i]) noBorrow[i] = 0;
        noShadowPng = await maskToPng(noBorrow, w, h);
        row.harmonise.floorOverWallPctOfImage = +(ratioOf(noBorrow) * 100).toFixed(2);
        save(ctx, "9_floor_over_wall.png", noShadowPng);
      }
    }
    if (RELIGHT_FINAL) {
      // Real room + furniture, with only the blend's lighting laid on top
      // (see relight.ts): lamp glow and shadows without any of Gemini's pixels.
      const rl = await compositeRelight(sun.buffer, harmRaw!, tSolidPng, furnPng, hZonePng, noShadowPng);
      harmFinal = rl.buffer;
      Object.assign(row.harmonise, {
        blendUsed: true,
        relit: true,
        colourGains: rl.colourGains,
        strongestShadowPct: rl.strongestShadowPct,
        strongestLightPct: rl.strongestLightPct,
        lightingTakenPctOfZone: rl.lightingTakenPctOfZone,
        furnitureDiffVsBlend: rl.furnitureDiffVsBlend,
        furnitureLightingUsed: rl.furnitureLightingUsed,
      });
    } else {
      const hm = await compositeHarmonise(sun.buffer, harmRaw!, tSolidPng, furnPng, hZonePng, noShadowPng);
      harmFinal = hm.buffer;
      Object.assign(row.harmonise, {
        blendUsed: true,
        colourGains: hm.colourGains,
        shadowPctOfZone: hm.shadowPctOfZone,
        strongestShadowPct: hm.strongestShadowPct,
        furnitureDiffVsBlend: hm.furnitureDiffVsBlend,
        furnitureLightingUsed: hm.furnitureLightingUsed,
        furnitureLightingChangedPctOfImage: hm.furnitureLightingChangedPctOfImage,
      });
    }
  } else {
    harmFinal = safeFinal;
    row.harmonise.blendUsed = false;
  }
  save(ctx, "10_final_harmonise.webp", harmFinal);
  // Structure check: outside the furniture and its shadow zone (plus the
  // soft fade at its edge) the final must be the original photo — only
  // resize/compression noise allowed.
  // Sun patches softened next to the furniture are lighting, not structure.
  if (sunPatchMask) for (let i = 0; i < affected.length; i++) affected[i] |= sunPatchMask[i];
  const structure = await checkStructureRetained(original, harmFinal, dilate(affected, w, h, Math.round(w * 0.03)), w, h);
  row.harmonise.structureCheck = structure;
  if (!row.harmonise.structureCheck.retained) warn(ctx, `[${ctx.name}] harmonise structure check FAILED: ${JSON.stringify(structure)}`);

  // Checked blend: Gemini's blend as the final, patch-checked and repaired.
  if (blendUsable && harmRaw) {
    const zoneAll = new Uint8Array(w * h);
    for (let i = 0; i < zoneAll.length; i++) zoneAll[i] = hZone[i] | (sunPatchMask ? sunPatchMask[i] : 0);
    // Checked against (and repaired from) the app-built final: same room
    // structure as the safe composite, but with sun patches already
    // softened and shadows in, so repairs near furniture match.
    const cb = await checkBlend(harmFinal, harmRaw, tSolid, zoneAll, w, h, noBorrow);
    checkedBlendView = cb.repairedView;
    save(ctx, "11_checked_blend_repairs.jpg", cb.repairedView);
    row.checkedBlend = {
      patchesChecked: cb.patchesChecked,
      patchesRepaired: cb.patchesRepaired,
      repairPct: cb.repairPct,
      reasons: cb.reasons,
      furnitureRestyledAndRepaired: cb.furnitureChanged,
      usedAppBuiltInstead: cb.tooMuchChanged,
      largestRepairCluster: cb.largestRepairCluster,
    };
    const objectChange = blendHasObjectChange(cb);
    // Gemini's blend moved part of the room itself (a doorway or window edge
    // shifted). Patch repairs then mix moved and unmoved pieces, which shows
    // as broken lines (Bedroom 12's doorway), so the app-built final is used.
    const blendMovedRoom = (row.harmonise.blendFraming?.tilesChanged || 0) > 0;
    row.checkedBlend.blendMovedRoom = blendMovedRoom;
    if (RELIGHT_FINAL && FINAL_RELIT_ALWAYS) {
      // Owner setting: never publish Gemini's own pixels, only its lighting.
      row.checkedBlend.usedAppBuiltInstead = true;
      row.checkedBlend.relitAlways = true;
      checkedBlend = harmFinal;
    } else if (blendMovedRoom) {
      warn(ctx, `[${ctx.name}] checked blend: Gemini's blend moved part of the room (${row.harmonise.blendFraming.tilesChanged} wall/ceiling patch(es)) — using the app-built final instead`);
      row.checkedBlend.usedAppBuiltInstead = true;
      checkedBlend = harmFinal;
    } else if (objectChange) {
      warn(ctx, `[${ctx.name}] checked blend: Gemini's blend added or removed an object (${objectChange}) — using the app-built final instead`);
      row.checkedBlend.usedAppBuiltInstead = true;
      row.checkedBlend.objectChange = objectChange;
      checkedBlend = harmFinal;
    } else if (cb.tooMuchChanged) {
      warn(ctx, `[${ctx.name}] checked blend: ${cb.repairPct}% of patches changed (limit ${BLEND_MAX_REPAIR_PCT}%) — using the app-built final instead`);
      checkedBlend = harmFinal;
    } else {
      checkedBlend = cb.buffer;
    }
    save(ctx, "11_final_checked_blend.webp", checkedBlend);
  }
  // Line-up completion: continue the pieces cut off by the empty strip, from
  // Gemini's blend, inside that strip only.
  if (ctx.completionZone) {
    row.realignCompletion = { applied: false, filledPct: 0 };
    if (blendUsable && harmRaw) {
      const base = checkedBlend || harmFinal;
      const done = await applyCutPieceCompletion(base, harmRaw, original, ctx.completionZone, ctx.completionBand || ctx.completionZone, w, h);
      row.realignCompletion = { applied: true, filledPct: done.filledPct };
      if (checkedBlend) checkedBlend = done.image; else harmFinal = done.image;
      save(ctx, "12_cut_pieces_completed.webp", await sharp(done.image).webp({ quality: 92 }).toBuffer());
    }
  }
  return { safeFinal, harmRaw, harmFinal, checkedBlend, checkedBlendView };
}

// Final check: can people still walk through the real doorways?
export async function finalDoorCheck(ctx: MaskedContext, finalImage: Buffer | null, doors: DoorOpening[] | null) {
  const { original, row } = ctx;
  row.doorAccess = { doorsFound: doors ? doors.length : "lookup failed", doors: doors ?? [] };
  if (!(DOOR_CHECK && doors && doors.length > 0 && finalImage)) return;
  const pre = await doorwayAppearsBlocked(original, finalImage, doors);
  const flagged = pre.filter((d) => d.appearsBlocked);
  row.doorAccess.codeCheck = Object.fromEntries(pre.map((d) => [d.id, { openingCoveredPct: d.openingCoveredPct, longestClearPct: d.longestClearPct }]));
  if (flagged.length === 0) {
    row.doorAccess.result = "clear (code check, no AI call)";
  } else if (ctx.offline) {
    row.doorAccess.result = "appears blocked (AI check skipped in FROM_RUN)";
  } else {
    log(ctx, `[${ctx.name}] doorway may be blocked (${flagged.map((d) => `${d.id}: clear stretch only ${d.longestClearPct}% of its width`).join(", ")}) — asking the AI to review the final image`);
    const ai = await askDoorAccess(ctx.originalPath, finalImage, flagged, ctx.roomType, ctx.dir, ctx.name);
    row.doorAccess.ai = ai;
    if ((ai as any).error) {
      // The code check says a doorway looks blocked and the AI could not be
      // asked: don't publish on a guess — re-stage with a plain hint.
      row.doorAccess.blocked = true;
      row.doorAccess.restageHints = flagged.map((d) => `Keep ${d.description ? (/^(the|a|an)\s/i.test(d.description) ? d.description : `the ${d.description}`) : "the doorway"} completely clear: no bed, bedside table, sofa, table or other furniture in front of it or in the space its door swings through.`);
      row.doorAccess.result = "appears blocked (AI check failed — re-staging)";
      warn(ctx, `[${ctx.name}] door AI check failed (${String((ai as any).error).slice(0, 160)}) — treating the flagged doorway as blocked`);
    } else {
      row.doorAccess.blocked = ai.blocked;
      row.doorAccess.restageHints = ai.restageHints;
      row.doorAccess.result = ai.blocked ? "BLOCKED (AI)" : "clear (AI)";
    }
    if (ai.blocked) warn(ctx, `[${ctx.name}] DOORWAY BLOCKED in the final image: ${ai.items.filter((o: any) => o.accessBlocked === "yes").map((o: any) => `${o.description} — ${o.blockingFurniture}`).join(" | ")}`);
  }
}

// ── App entry point ──────────────────────────────────────────────────────────

// Switches the app's main Stage 2 to this pipeline (interior rooms only).
// Off by default. Either:
//   STAGE2_SPECIALIST_VALIDATORS=merged — the production switch. "on" and
//     "off" keep their existing behaviour; jobs that don't take this path
//     (refresh staging) treat "merged" exactly like "on".
//   STAGE2_MASKED_HARMONISE=on / 1 / true / yes — the original test switch.
export function maskedStage2Enabled(): boolean {
  if (String(process.env.STAGE2_SPECIALIST_VALIDATORS || "").trim().toLowerCase() === "merged") return true;
  return ["on", "1", "true", "yes"].includes(String(process.env.STAGE2_MASKED_HARMONISE || "").trim().toLowerCase());
}

// STAGE2_MASKED_DEBUG_UPLOAD=1: upload each attempt's in-between images to S3
// (debug-attempts/<jobId>/masked/...) and log signed links.
export function maskedStage2DebugUploadEnabled(): boolean {
  return ["on", "1", "true", "yes"].includes(String(process.env.STAGE2_MASKED_DEBUG_UPLOAD || "").trim().toLowerCase());
}

// Doors and walkthroughs from the app's structural baseline (extracted in
// parallel with Stage 1A). Closet doors and windows are not walked through.
export function doorsFromStructuralBaseline(baseline: any): DoorOpening[] | null {
  const openings: any[] = Array.isArray(baseline?.openings) ? baseline.openings : [];
  if (!baseline) return null;
  return openings
    .filter((o) => (o?.type === "door" || o?.type === "walkthrough") && Array.isArray(o?.bbox) && o.bbox.length === 4)
    .map((o, i) => ({
      id: String(o.id || `door_${i + 1}`),
      type: String(o.type),
      description: String(o.description || (o.type === "walkthrough" ? "walkthrough opening" : "door")),
      bbox: o.bbox.map((v: any) => Math.min(1, Math.max(0, Number(v)))) as [number, number, number, number],
    }));
}

// Re-stage instruction after a reshaped room: say what went wrong (zoomed in,
// zoomed out, or redrawn from another viewpoint) and that the furniture must
// give way to the room, never the other way round.
export function reshapeHint(cam: { scale?: number } | null | undefined): string {
  const scale = Number(cam?.scale);
  const pct = Number.isFinite(scale) ? Math.round(Math.abs(scale - 1) * 100) : 0;
  const what = Number.isFinite(scale) && scale >= 1.03
    ? `zoomed in on the room by about ${pct}%, cutting off parts of the walls, ceiling and floor`
    : Number.isFinite(scale) && scale <= 0.97
      ? `zoomed out by about ${pct}%, showing more of the room than the photo does`
      : "redrew the room from a different viewpoint, so the walls, corners and windows moved";
  return `Your previous attempt ${what}, and it was rejected. The camera is locked: the result must have exactly the same framing, zoom, viewpoint and perspective as the input photo, with every wall edge, corner, window, door and the ceiling line in the same place. The furniture must fit the room, never the other way round — use a smaller kind of piece, move pieces, let the edge of the photo cut them off, or leave pieces out; every piece stays at its true real-world size. Do not crop, zoom, widen, rotate or redraw the room.`;
}

export type MaskedJobResult =
  | { ok: true; outputPath: string; attempts: number; reports: any[] }
  // nothingToStage: Gemini added nothing, in a room that may stay empty
  // (hallway, pantry, laundry...). Not a failure: no re-stage.
  | { ok: false; reasons: string[]; attempts: number; reports: any[]; nothingToStage?: boolean };

// One photo through the masked Stage 2: stage -> trace -> harmonise ->
// checked blend -> final door check. A photo is re-staged ONCE (for any
// reason: blocked doorway, reshaped room, structure check or processing
// failure); if the re-staged result also fails, the caller falls back to the
// last good output (the Stage 2 input).
export async function runMaskedStage2Job(p: {
  inputPath: string; // Stage 2 input (Stage 1A, or 1B if decluttered)
  roomType: string;
  jobId: string;
  // The doors, or a function that fetches them (the window/door survey may
  // still be running when staging starts; it's only needed for the door check).
  doors: DoorOpening[] | null | (() => Promise<DoorOpening[] | null>);
  maxRestages: number;
  // Runs one Gemini staging and returns the staged image's path. Hints are
  // the "keep this doorway clear" notes for a re-stage. `input` is the picture
  // to stage when it isn't inputPath (a near-wall strip was cut off): stage
  // that file, with window/door positions moved by input.crop.
  stage: (attempt: number, hints: string[], input?: { path: string; crop: NearWallCrop }) => Promise<string>;
  outputPathFor: (attempt: number) => string;
  workDir: string;
  // Optional: called with each attempt's work folder (debug uploads).
  onAttemptFiles?: (attempt: number, dir: string, files: string[]) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  // Offline replay for tests: saved Gemini outputs per attempt, no calls.
  replay?: (attempt: number, name: string) => Buffer | null;
  // Internal: set on the inner run once the near-wall strip check is done.
  nearWallChecked?: boolean;
}): Promise<MaskedJobResult> {
  if (NEAR_WALL_CROP_ENABLED && !p.replay && !p.nearWallChecked) {
    const viaStrip = await runWithoutNearWallStrip(p).catch((e: any) => {
      p.warn?.(`[${p.jobId}] near-wall strip check failed (${String(e?.message || e).slice(0, 160)}) — staging the whole photo`);
      return null;
    });
    if (viaStrip) return viaStrip;
  }
  const original = fs.readFileSync(p.inputPath);
  const meta = await sharp(original).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  const aspectRatio = closestGeminiAspectRatio(w, h);
  const originalMime = meta.format === "png" ? "image/png" : meta.format === "webp" ? "image/webp" : "image/jpeg";
  const reports: any[] = [];
  let hints: string[] = [];
  // Debug uploads run in the background so they never hold up a re-stage or
  // publish; all of them are awaited once before returning.
  const pendingUploads: Promise<void>[] = [];
  const finishUploads = async () => { await Promise.all(pendingUploads); };
  // The survey may still be running: look the doors up once, when first needed.
  let doorsPromise: Promise<DoorOpening[] | null> | null = null;
  const getDoors = () => {
    if (!doorsPromise) doorsPromise = typeof p.doors === "function" ? p.doors().catch(() => null) : Promise.resolve(p.doors);
    return doorsPromise;
  };
  // Once per job, while Gemini stages: does the empty room have anything
  // that would show reflections of the furniture? If not, the reflections
  // trace pass is skipped on every attempt. Unsure or failed -> keep it.
  const reflectiveP = REFLECTION_GATE && !p.replay
    ? askReflectiveSurfaces(p.inputPath, p.jobId).catch(() => null)
    : Promise.resolve(null);
  let extraRestagesUsed = 0;
  // "Last attempt" leniencies (keep Gemini's pixels where the trace missed
  // part of a piece; accept a hair of floating) only when no further staging
  // can follow — not on attempt 2 while the extra re-stage is still unused
  // (Nov 2026, job_0ed1adf2: attempt 2 took Gemini's floor and skirting under
  // the near bedside table — a step in the skirting and a lighter carpet patch).
  const finalAttempt = (attempt: number) => attempt > p.maxRestages + Math.max(0, EXTRA_RESTAGES - extraRestagesUsed);
  // Carry-over rounds (see CARRY_OVER): internal re-runs of the same staging,
  // never counted as a re-stage.
  let carry: null | { mode: "carry" | "fallback"; imagePath: string; stagedPath: string; fromDir: string; placed?: Uint8Array } = null;
  let internalRounds = 0;
  for (let attempt = 1; ; attempt++) {
    const dir = path.join(p.workDir, `attempt${attempt}`);
    // The attempt number as far as re-staging goes (internal rounds aside).
    const eff = attempt - internalRounds;
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const io: MaskedIO = {
      save: (name, data) => {
        try {
          fs.writeFileSync(path.join(dir, name), data);
          files.push(name);
        } catch {}
      },
      log: p.log,
      warn: p.warn,
      ...(p.replay ? { load: (name: string) => p.replay!(attempt, name) } : {}),
    };
    const row: any = { attempt, roomType: p.roomType, input: `${w}x${h}`, aspectRatio, ...(attempt > 1 ? { restageHints: hints } : {}) };
    reports.push(row);
    const reasons: string[] = [];
    let final: Buffer | null = null;
    let goRound = false; // a carry-over round follows (see CARRY_OVER)
    // The room plan Stage 2 used for this attempt (if any).
    let attemptBrief: any = null;
    try {
      const stagedPath = carry?.mode === "carry" ? carry.imagePath : carry?.mode === "fallback" ? carry.stagedPath : await p.stage(eff, hints);
      if (carry) row.carryRound = carry.mode;
      const staged = fs.readFileSync(stagedPath);
      io.save?.("2_staged_raw.webp", staged);
      // The exact staging prompt (and room brief, if used), saved by Stage 2.
      for (const [suffix, name] of [[".prompt.txt", "2_stage_prompt.txt"], [".room-brief.json", "2_room_brief.json"], [".floor-guide.jpg", "2_floor_guide.jpg"]] as const) {
        try {
          if (fs.existsSync(stagedPath + suffix)) io.save?.(name, fs.readFileSync(stagedPath + suffix));
        } catch {}
      }
      let ctx: MaskedContext = {
        name: `${p.jobId}#${attempt}`, original, originalPath: p.inputPath, originalMime, staged, roomType: p.roomType, aspectRatio, w, h, tight: true, offline: Boolean(p.replay), dir, io, row,
        fillMissedUnder: finalAttempt(eff) && PUBLISH_CUT_ON_LAST_ATTEMPT,
        ...(carry?.mode === "carry" ? { lightTrace: true } : {}),
        ...(carry?.mode === "fallback" ? { traceReplay: ((from: string) => (name: string) => { try { const f = path.join(from, name); return fs.existsSync(f) ? fs.readFileSync(f) : null; } catch { return null; } })(carry.fromDir) } : {}),
      };
      // Bed placement (bedrooms) needs only the staged picture, so it runs now,
      // alongside the line-up, and a rejected placement skips the trace and blend
      // (~US$0.50 of Gemini calls) and goes straight to the re-stage.
      try {
        if (fs.existsSync(stagedPath + ".room-brief.json")) attemptBrief = JSON.parse(fs.readFileSync(stagedPath + ".room-brief.json", "utf8"));
      } catch {}
      const plannedBedWall = plannedBedWallFromBrief(attemptBrief);
      const bedWallP = BED_WALL_CHECK && !ctx.offline && !carry && /bed/i.test(p.roomType)
        ? getDoors().then((doors) => askBedWall(ctx.originalPath, staged, doors || [], dir, ctx.name, plannedBedWall)).catch(() => null)
        : Promise.resolve(null);
      // Same for the desk in a study / office.
      const deskDoorP = BED_WALL_CHECK && !ctx.offline && !carry && /study|office/i.test(p.roomType)
        ? getDoors().then((doors) => askDeskDoor(ctx.originalPath, staged, doors || [], dir, ctx.name)).catch(() => null)
        : Promise.resolve(null);
      // And for sofas, TV units and dining sets in living / dining rooms. The
      // room plan (if Stage 2 used one) shapes the re-stage hint.
      const livingPlan = livingPlanFromBrief(attemptBrief);
      const livingDoorP = LIVING_DOOR_CHECK && !ctx.offline && !carry && /living|dining/i.test(p.roomType) && !/bed/i.test(p.roomType)
        ? getDoors().then((doors) => askLivingDoor(ctx.originalPath, staged, doors || [], dir, ctx.name, livingPlan)).catch(() => null)
        : Promise.resolve(null);
      const reflective = await reflectiveP;
      if (reflective) {
        row.reflectionGate = { reflective: reflective.reflective, what: reflective.what, model: reflective.model };
        if (!reflective.reflective) ctx = { ...ctx, skipReflections: true };
      }
      // Camera-movement check: logged only. An early (untraced) reshape screen
      // was removed: on owner-labelled merge tests it rejected photos the
      // merge saves (furniture can't be told from room before tracing), while
      // the traced framing check below matched the merged results on all 6.
      row.cameraAlignment = await checkCameraAlignment(original, staged).catch(() => null);
      // Zoomed/shifted noticeably: line up first, then trace once.
      let prealigned: { empty: Uint8Array; W: number; H: number; emptyPct: number } | null = null;
      if (!ctx.offline && shouldPrealign(row.cameraAlignment)) {
        const al = await alignStagedToOriginal(original, staged, row.cameraAlignment).catch(() => null);
        if (al && al.emptyPct <= REALIGN_MAX_EMPTY_PCT) {
          io.save?.("2_staged_aligned.webp", await sharp(al.aligned).webp({ quality: 92 }).toBuffer());
          p.log?.(`[${ctx.name}] Gemini's picture is zoomed/shifted (zoom ${row.cameraAlignment.scale}, shift ${row.cameraAlignment.shiftPct}%) — lining it up with the real photo before tracing`);
          ctx = { ...ctx, staged: al.aligned };
          prealigned = { empty: al.empty, W: al.W, H: al.H, emptyPct: al.emptyPct };
        } else {
          row.prealign = { lined: false, emptyStripPct: al?.emptyPct ?? null };
        }
      }
      const bedWall = await bedWallP;
      let placementRejected = false;
      const deferredDoor: Array<"bed" | "desk" | "living"> = [];
      if (bedWall) {
        row.bedWall = { consensus: (bedWall as any).consensus, model: bedWall.model, plannedWall: plannedBedWall, wrongWall: (bedWall as any).wrongWall, bedOnDoorWall: bedWall.bedOnDoorWall, coversWindow: bedWall.coversWindow, ...((bedWall as any).underWindowAccepted ? { underWindowAccepted: true } : {}), coversDoor: bedWall.coversDoor, answer: bedWall.answer, ...(bedWall as any).error ? { error: (bedWall as any).error } : {} };
        if ((bedWall as any).offPlanAccepted) {
          row.bedWall.offPlanAccepted = true;
          p.log?.(`[${ctx.name}] bed is on a different wall from the plan (${String(bedWall.answer?.headboardWall || "").slice(0, 80)}) but that wall has no door, no window is badly covered and the room is unchanged — accepted`);
        }
        const bedDoorOnly = bedWall.failed && bedWall.coversDoor && !bedWall.bedOnDoorWall && !bedWall.coversWindow && !(bedWall as any).roomWidened && !((bedWall as any).wrongWall && !(bedWall as any).offPlanAccepted);
        if (DEFER_DISPUTED_DOOR && bedDoorOnly && isDisputedVote(bedWall)) {
          deferredDoor.push("bed");
          row.bedWall.deferred = true;
          p.log?.(`[${ctx.name}] door verdict disputed (votes ${JSON.stringify((bedWall as any).consensus?.votes)}): bed by a door — carrying on; the check runs again on the finished image`);
        } else if (bedWall.failed) {
          const what = [bedWall.coversDoor && "bed covers a door", bedWall.bedOnDoorWall && "headboard on a wall with a door", bedWall.coversWindow && "bed covers a window", (bedWall as any).roomWidened && "room widened to fit the furniture", (bedWall as any).wrongWall && `bed not on the planned wall (${plannedBedWall})`].filter(Boolean).join("; ");
          p.warn?.(`[${ctx.name}] bed placement rejected: ${what} — ${String(bedWall.answer?.reason || "").slice(0, 200)} (trace and blend skipped)`);
          reasons.push((bedWall as any).roomWidened ? "room changed to fit the bed" : (bedWall as any).wrongWall && !bedWall.bedOnDoorWall && !bedWall.coversWindow && !bedWall.coversDoor ? "bed not where the plan put it" : "bed against a door wall or window");
          row.bedWall.restageHints = bedWall.restageHints;
          placementRejected = true;
        }
      }
      const deskDoor = await deskDoorP;
      if (deskDoor) {
        row.deskDoor = { consensus: (deskDoor as any).consensus, model: deskDoor.model, coversDoor: deskDoor.coversDoor, deskOnDoorWall: deskDoor.deskOnDoorWall, roomWidened: deskDoor.roomWidened, answer: deskDoor.answer, ...(deskDoor as any).error ? { error: (deskDoor as any).error } : {} };
        if (DEFER_DISPUTED_DOOR && deskDoor.failed && deskDoor.coversDoor && !deskDoor.deskOnDoorWall && !deskDoor.roomWidened && isDisputedVote(deskDoor)) {
          deferredDoor.push("desk");
          row.deskDoor.deferred = true;
          p.log?.(`[${ctx.name}] door verdict disputed (votes ${JSON.stringify((deskDoor as any).consensus?.votes)}): desk by a door — carrying on; the check runs again on the finished image`);
        } else if (deskDoor.failed) {
          const what = [deskDoor.coversDoor && "desk setup covers a door", deskDoor.deskOnDoorWall && "desk on a wall with a door", deskDoor.roomWidened && "room widened to fit the furniture"].filter(Boolean).join("; ");
          p.warn?.(`[${ctx.name}] desk placement rejected: ${what} — ${String(deskDoor.answer?.reason || "").slice(0, 200)} (trace and blend skipped)`);
          reasons.push(deskDoor.roomWidened ? "room changed to fit the desk" : "desk blocking a door");
          row.deskDoor.restageHints = deskDoor.restageHints;
          placementRejected = true;
        }
      }
      const livingDoor = await livingDoorP;
      if (livingDoor) {
        row.livingDoor = { consensus: (livingDoor as any).consensus, model: livingDoor.model, blocksDoor: livingDoor.blocksDoor, roomWidened: livingDoor.roomWidened, answer: livingDoor.answer, ...(livingDoor as any).error ? { error: (livingDoor as any).error } : {} };
        if (DEFER_DISPUTED_DOOR && livingDoor.failed && livingDoor.blocksDoor && !livingDoor.roomWidened && isDisputedVote(livingDoor)) {
          deferredDoor.push("living");
          row.livingDoor.deferred = true;
          p.log?.(`[${ctx.name}] door verdict disputed (votes ${JSON.stringify((livingDoor as any).consensus?.votes)}): ${String(livingDoor.answer?.blockedWhat || "furniture by a door").slice(0, 100)} — carrying on; the check runs again on the finished image`);
        } else if (livingDoor.failed) {
          const what = [livingDoor.blocksDoor && `furniture blocks a door (${String(livingDoor.answer?.blockedWhat || "").slice(0, 80)})`, livingDoor.roomWidened && "room widened to fit the furniture"].filter(Boolean).join("; ");
          p.warn?.(`[${ctx.name}] living/dining placement rejected: ${what} — ${String(livingDoor.answer?.reason || "").slice(0, 200)} (trace and blend skipped)`);
          reasons.push(livingDoor.roomWidened ? "room changed to fit the furniture" : "furniture blocking a door");
          row.livingDoor.restageHints = livingDoor.restageHints;
          placementRejected = true;
        }
      }
      if (!placementRejected) {
        let layers = await traceLayers(ctx);
        if (prealigned) {
          const cut = await furnitureCutAtEmptyEdge(layers.floor, prealigned.empty, prealigned.W, prealigned.H, w, h);
          if (cut.cutPct > 0) {
            const cz = await cutPieceCompletionZone(layers.floor, prealigned.empty, prealigned.W, prealigned.H, w, h);
            if (cz.zonePct > 0) ctx = { ...ctx, completionZone: cz.zone, completionBand: cz.band, emptyStrip: prealigned.empty };
          }
          row.prealign = { lined: true, scale: row.cameraAlignment.scale, shiftPct: row.cameraAlignment.shiftPct, emptyStripPct: prealigned.emptyPct, furnitureCutAtEdgePct: cut.cutPct };
        } else if (row.prealign && row.prealign.lined === false) {
          // Moved too far to line up safely: don't merge pieces of a shifted picture.
          p.warn?.(`[${ctx.name}] Gemini's picture moved too far to line up (empty strip ${row.prealign.emptyStripPct}%) — re-staging`);
          row.framingCheck = { ...(row.framingCheck || {}), framingChanged: true, reason: "camera moved too far to line up" };
        }
        // Line-up: the room check failed, but Gemini only moved or zoomed the
        // room (not a new viewpoint). Move its picture back onto the real
        // photo's frame and trace again; the room check then decides. The second
        // trace only runs on photos that would otherwise be re-staged.
        if (row.framingCheck?.framingChanged && !prealigned && !ctx.offline && canRealign(row.cameraAlignment)) {
          const al = await alignStagedToOriginal(original, staged, row.cameraAlignment).catch(() => null);
          if (al && al.emptyPct <= REALIGN_MAX_EMPTY_PCT) {
            const first = row.framingCheck;
            io.save?.("2_staged_aligned.webp", await sharp(al.aligned).webp({ quality: 92 }).toBuffer());
            p.log?.(`[${ctx.name}] room moved (zoom ${row.cameraAlignment.scale}, shift ${row.cameraAlignment.shiftPct}%) — lining Gemini's picture up with the real photo and tracing again`);
            ctx = { ...ctx, staged: al.aligned };
            layers = await traceLayers(ctx);
            const cut = await furnitureCutAtEmptyEdge(layers.floor, al.empty, al.W, al.H, w, h);
            if (cut.cutPct > 0) {
              const cz = await cutPieceCompletionZone(layers.floor, al.empty, al.W, al.H, w, h);
              if (cz.zonePct > 0) ctx = { ...ctx, completionZone: cz.zone, completionBand: cz.band, emptyStrip: al.empty };
            }
            row.realign = {
              scale: row.cameraAlignment.scale, shiftPct: row.cameraAlignment.shiftPct,
              emptyStripPct: al.emptyPct, firstRoomCheck: first,
              rescued: !row.framingCheck?.framingChanged, furnitureCutAtEdgePct: cut.cutPct,
            };
            p.log?.(`[${ctx.name}] line-up ${row.realign.rescued ? "RESCUED the staging" : "did not help"} (room check median ${first.medianDiff} -> ${row.framingCheck?.medianDiff}; empty strip ${al.emptyPct}%, furniture reaching it ${cut.cutPct}% of its edge)`);
          }
        }
        // Carry-over round: did Gemini keep the furniture where it was placed?
        // If so the picture is trusted — a small shift that fits the room
        // better is no reason to reject it; if not (resized, moved elsewhere,
        // turned) it is not used (owner, Nov 2026).
        let carryTrusted = false, carryMismatch = false;
        if ((carry as any)?.mode === "carry" && (carry as any).placed) {
          const m = carryPlacementMatch((carry as any).placed, layers.floor, w, h);
          row.carryMatch = m;
          if (m.ok) {
            carryTrusted = true;
            p.log?.(`[${ctx.name}] carried-over furniture is where it was placed (main piece ${m.widthRatio}x wide, ${m.shiftPct}% across, top ${m.topPct}%) — trusted`);
          } else {
            carryMismatch = true;
            reasons.push("carried-over furniture moved or resized");
            p.warn?.(`[${ctx.name}] carried-over furniture is not where it was placed: ${m.why}`);
          }
        }
        // Part of a piece missed by the trace: a sizeable changed area directly
        // UNDER traced furniture (where legs or a base should continue) that
        // the close-up re-trace didn't fill. Merging would publish the piece
        // cut off, with the real wall or skirting showing through (Oct 2026,
        // production: a bedside table's legs) — re-stage instead.
        // An area that is mostly Gemini's floor drawn over the real wall is
        // not a tracing miss: Gemini pushed the wall back so the piece stands
        // on floor that doesn't exist (Oct 2026, job_609fbe6a: a bedside
        // table). It re-stages as a moved floor line (below), whose hint tells
        // Gemini to keep the wall where it is.
        const fowMask = layers.floorOverWall;
        const boxShare = (m: any) => {
          if (!fowMask || !Array.isArray(m.box)) return 0;
          const x1 = Math.max(0, Math.floor(m.box[0] * w)), y1 = Math.max(0, Math.floor(m.box[1] * h));
          const x2 = Math.min(w - 1, Math.ceil(m.box[2] * w)), y2 = Math.min(h - 1, Math.ceil(m.box[3] * h));
          let n = 0;
          for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) if (fowMask[y * w + x]) n++;
          return Math.min(1, n / Math.max(1, (m.areaPct / 100) * w * h));
        };
        const cutUnderAll = ((row.closeUpRetrace?.flaggedAreas || []) as any[]).filter(isCutUnder);
        const floorUnder = cutUnderAll.filter((m) => boxShare(m) >= FLOOR_OVER_WALL_SHARE);
        const cutUnder = cutUnderAll.filter((m) => !floorUnder.includes(m));
        if (floorUnder.length) {
          row.floorOverWallUnderFurniture = floorUnder.map((m) => ({ ...m, floorOverWallShare: +boxShare(m).toFixed(2) }));
          p.warn?.(`[${ctx.name}] Gemini drew floor over the real wall under/beside furniture (${floorUnder.map((m) => `${m.areaPct}% at x ${Math.round(m.box[0] * 100)}-${Math.round(m.box[2] * 100)}%`).join("; ")}) — not a tracing miss`);
        }
        const closeUpFilled = !row.closeUpRetrace?.rejected && (row.closeUpRetrace?.addedPctOfImage || 0) >= 0.5 * cutUnder.reduce((s, m) => s + m.areaPct, 0);
        if (cutUnder.length && !closeUpFilled) {
          row.furnitureCutByTrace = cutUnder;
          p.warn?.(`[${ctx.name}] part of a piece missed by the trace (${cutUnder.map((m) => `${m.areaPct}% under furniture at x ${Math.round(m.box[0] * 100)}-${Math.round(m.box[2] * 100)}%`).join("; ")}) — re-staging unless it can be filled from Gemini's picture`);
        }
        // Floating furniture: a piece whose legs stop short of the REAL floor
        // (Gemini drew the floor/wall line higher or lower). Where the join can
        // be hidden (a piece in front, a wall corner, the photo edge) we keep
        // Gemini's own floor and skirting under the piece ("floor patch");
        // otherwise re-stage. Planning needs no AI call, so a photo that must be
        // re-staged anyway skips the blend and door check.
        // Skirting beside furniture: Gemini drew a wall's floor line higher or
        // lower right next to a piece standing against it. Line the piece up
        // with the real skirting when that is safe (no AI call); otherwise the
        // floor-moved check below re-stages.
        let skirtingLeft: SkirtingRun[] = [];
        let realLineForLineUp: number[] = [];
        let colOffsetsForLineUp: Array<number | null> | null = null;
        let lineUpApplied = false;
        if (FLOOR_MOVED_CHECK) {
          const sk = await measureSkirtingOffsets(original, ctx.staged, layers.solid, w, h).catch((e: any) => ({ runs: [] as SkirtingRun[], checkedColsPct: 0, error: String(e?.message || e) }));
          realLineForLineUp = (sk as any).realLine || [];
          colOffsetsForLineUp = (sk as any).colOffsets || null;
          row.skirtingBeside = { runs: sk.runs, checkedColsPct: sk.checkedColsPct }; // (not the floor line itself: it would bloat the logged report)
          skirtingLeft = sk.runs;
          if (sk.runs.length) {
            const plan: SkirtingLineUp = (carry as any)?.mode === "carry"
              ? { ok: false, why: "carry-over round: the furniture was already lined up" }
              : SKIRTING_LINE_UP ? planSkirtingLineUp(sk.runs, layers.floor, w, h, (sk as any).realLine || [], (sk as any).colOffsets || null) : { ok: false, why: "line-up switched off" };
            row.skirtingLineUp = { ok: plan.ok, why: plan.why, ...(plan.fit ? { fit: plan.fit } : {}), ...(plan.ok ? { wallPct: plan.wallPct, movedDownPct: plan.movedDownPct, growPct: plan.growPct, tiltDeg: plan.tiltDeg || 0 } : {}) };
            let ap: Awaited<ReturnType<typeof applySkirtingLineUp>> | null = null;
            if (plan.ok) {
              ap = await applySkirtingLineUp(ctx.staged, {
                floor: layers.floor, tightFloor: layers.tightFloor, artRegion: layers.artRegion, solid: layers.solid, zone: layers.zone, core: layers.core, legPocket: layers.legPocket,
              }, layers.floor, plan, w, h);
              // Check the moved picture: Gemini's skirting beside the moved
              // furniture must now sit on the real one. A visible step means
              // the move didn't work — don't use it (the floor-moved check
              // below then decides, usually a re-stage).
              const left = await lineUpLeftoverPct(original, ap.staged, ap.movedArea, ap.masks.floor!, w, h).catch(() => null);
              row.skirtingLineUp.leftoverPct = left?.pct ?? null;
              if (left && left.pct > LINEUP_MAX_RESIDUAL_PCT) {
                row.skirtingLineUp.ok = false;
                row.skirtingLineUp.why = `after the move the skirting would still be ${left.pct}% off beside the furniture — not used`;
                p.warn?.(`[${ctx.name}] skirting line-up not used: the skirting beside the moved furniture would still be ${left.pct}% off (a visible step)`);
                ap = null;
              }
            }
            if (plan.ok && ap) {
              ctx = { ...ctx, staged: ap.staged };
              layers = layersAfterLineUp(layers, ap.masks);
              layers = { ...layers, solidPng: await maskToPng(layers.solid, w, h) };
              lineUpApplied = true;
              io.save?.("3b_skirting_lined_up.webp", await sharp(ctx.staged).webp({ quality: 90 }).toBuffer());
              {
                const sf = await finalSkirtingFit(original, ctx.staged, layers, ap.movedArea, w, h).catch(() => null);
                if (sf) {
                  row.skirtingFit = { applied: sf.applied, ...(sf.applied ? { beforePct: sf.beforePct, afterPct: sf.afterPct, maxNudgePct: sf.maxNudgePct } : { why: sf.why }) };
                  if (sf.applied) {
                    ctx = { ...ctx, staged: sf.staged };
                    layers = layersAfterLineUp(layers, sf.masks as any);
                    layers = { ...layers, solidPng: await maskToPng(layers.solid, w, h) };
                    io.save?.("3e_skirting_fitted.webp", await sharp(ctx.staged).webp({ quality: 88 }).toBuffer());
                    p.log?.(`[${ctx.name}] skirting fitted along the furniture: Gemini's floor line ${sf.beforePct}% → ${sf.afterPct ?? "?"}% from the real one (columns nudged up to ${sf.maxNudgePct}%)`);
                  }
                }
              }
              const after = await measureSkirtingOffsets(original, ctx.staged, layers.solid, w, h).catch(() => ({ runs: [] as SkirtingRun[], checkedColsPct: 0 }));
              row.skirtingLineUp.after = after.runs;
              // Gemini's own skirting beyond the moved furniture is never shown
              // (the real photo is), and the furniture now meets the real
              // skirting (leftover check above), so what's still "off" there
              // is no reason to re-stage (Nov 2026, Bedroom_02: a good line-up
              // thrown away for Gemini's skirting beside the table). The
              // floating check below still checks the moved furniture.
              skirtingLeft = [];
              // A second (floating) line-up below starts from the moved picture.
              if ((after as any).colOffsets) colOffsetsForLineUp = (after as any).colOffsets;
              p.log?.(`[${ctx.name}] skirting beside furniture was ${Math.abs(plan.run!.dyPct)}% ${plan.run!.dyPct < 0 ? "higher" : "lower"} in Gemini's picture (x ${plan.run!.x1Pct}-${plan.run!.x2Pct}%) — pulled the furniture against that wall (x ${plan.wallPct![0]}-${plan.wallPct![1]}%) ${plan.k! >= 1 ? "forward" : "back"}: ${plan.k! >= 1 ? "down" : "up"} ${Math.abs(plan.movedDownPct!)}% and ${Math.abs(plan.growPct!)}% ${plan.k! >= 1 ? "bigger" : "smaller"}${plan.tiltDeg ? `, tilted ${plan.tiltDeg}° to follow the real wall` : ""}; fitted on ${plan.fit?.method === "wall" ? `${plan.fit.cols} columns, ${plan.fit.sides}` : "one stretch"}, skirting left ${row.skirtingLineUp.leftoverPct ?? "?"}% off${layers.legPocket ? "; gaps between legs from the real photo" : ""}${after.runs.length ? ` (still off: ${after.runs.map((r) => `${r.dyPct}% at x ${r.x1Pct}-${r.x2Pct}%`).join("; ")})` : ""}`);
            } else if (!plan.ok) {
              p.warn?.(`[${ctx.name}] skirting beside furniture off by ${sk.runs.map((r) => `${r.dyPct}% at x ${r.x1Pct}-${r.x2Pct}%`).join("; ")} — not lined up: ${plan.why}`);
            }
          }
        }
        row.floatingCheck = await checkFloatingFurniture(original, layers.floor, w, h).catch((e: any) => ({ floating: false, runs: [], error: String(e?.message || e) }));
        // Furniture standing on Gemini's floor where Gemini drew it higher
        // than the real one, read from Gemini's floor line under it (see
        // seamUnderFurniture) — the leg-bottom check can be fooled.
        if (!row.floatingCheck.floating && SEAM_UNDER_CHECK) {
          const under = await seamUnderFurniture(original, ctx.staged, layers.floor, w, h).catch(() => [] as any[]);
          if (under.length) {
            row.floatingCheck = { floating: true, runs: under, fromGeminiFloorLine: true };
            p.warn?.(`[${ctx.name}] Gemini's floor line under furniture is higher than the real one: ${under.map((r: any) => `x ${r.x1Pct}-${r.x2Pct}% by ${r.gapPct}%`).join("; ")} — the furniture there would float`);
          }
        }
        let floorPlan: Awaited<ReturnType<typeof planFloorPatches>> | null = null;
        if (row.floatingCheck.floating) {
          p.warn?.(`[${ctx.name}] furniture floating above the real floor: ${row.floatingCheck.runs.map((r: any) => `x ${r.x1Pct}-${r.x2Pct}% ends ${r.gapPct}% above the floor line`).join("; ")}`);
          floorPlan = await planFloorPatches(original, ctx.staged, layers.floor, row.floatingCheck.runs, w, h)
            .catch((e: any) => ({ ok: false as const, patches: [], notes: [`plan error: ${String(e?.message || e)}`] }));
          row.floorPatch = { planned: floorPlan.ok, notes: floorPlan.notes };
          (floorPlan.ok ? p.log : p.warn)?.(`[${ctx.name}] floor patch ${floorPlan.ok ? "planned" : "not possible"}: ${floorPlan.notes.join("; ")}`);
        }
        // Floating furniture the skirting line-up couldn't see: the furniture
        // itself hides the skirting beside it, so the offset was never measured
        // there (Nov 2026 test run, Bedroom_05: the bedside table 3% above the
        // floor, the only measured offset on an empty wall). The floating
        // check's own gap is that offset: line the pieces on that wall up with
        // the real floor (lower and bigger, no AI call). Kept only if the
        // floating check then passes.
        // Also after a skirting line-up that didn't go far enough (Nov 2026,
        // Harcourts 07: a bedside table's legs still 6% above the real floor —
        // hidden until the holes under it stopped showing Gemini's wall).
        if (row.floatingCheck.floating && !floorPlan?.ok && SKIRTING_LINE_UP && FLOAT_LINE_UP && (carry as any)?.mode !== "carry") {
          const floatRuns: SkirtingRun[] = row.floatingCheck.runs.map((r: any) => ({ x1Pct: r.x1Pct, x2Pct: r.x2Pct, widthPct: +(r.x2Pct - r.x1Pct).toFixed(1), dyPct: -r.gapPct }));
          if (!realLineForLineUp.length) {
            const W = 800, H = Math.max(8, Math.round((W * h) / w));
            const lo = await realFloorLine(await sharp(original).removeAlpha().resize(W, H, { fit: "fill" }).png().toBuffer(), W, H).catch(() => null);
            realLineForLineUp = lo ? Array.from(lo as Int32Array, (v: number) => (v < 0 ? -1 : v / H)) : [];
          }
          const plan: SkirtingLineUp = planSkirtingLineUp(floatRuns, layers.floor, w, h, realLineForLineUp, colOffsetsForLineUp);
          if (plan.ok) {
            const ap = await applySkirtingLineUp(ctx.staged, {
              floor: layers.floor, tightFloor: layers.tightFloor, artRegion: layers.artRegion, solid: layers.solid, zone: layers.zone, core: layers.core, legPocket: layers.legPocket,
            }, layers.floor, plan, w, h);
            const recheck = await checkFloatingFurniture(original, ap.masks.floor!, w, h).catch((e: any) => ({ floating: true, runs: [], error: String(e?.message || e) }));
            const leftover = await lineUpLeftoverPct(original, ap.staged, ap.movedArea, ap.masks.floor!, w, h).catch(() => null);
            const stepLeft = Boolean(leftover && leftover.pct > LINEUP_MAX_RESIDUAL_PCT);
            row.floatingLineUp = { applied: !recheck.floating && !stepLeft, wallPct: plan.wallPct, movedDownPct: plan.movedDownPct, growPct: plan.growPct, ...(plan.fit ? { fit: plan.fit } : {}), leftoverPct: leftover?.pct ?? null, ...(recheck.floating ? { stillFloating: recheck.runs } : {}) };
            if (stepLeft && !recheck.floating) p.warn?.(`[${ctx.name}] floating furniture line-up not used: the skirting beside it would still be ${leftover!.pct}% off (a visible step)`);
            if (!recheck.floating && !stepLeft) {
              ctx = { ...ctx, staged: ap.staged };
              layers = layersAfterLineUp(layers, ap.masks);
              layers = { ...layers, solidPng: await maskToPng(layers.solid, w, h) };
              row.floatingCheck = { ...recheck, linedUpFrom: row.floatingCheck.runs };
              io.save?.("3c_floating_lined_up.webp", await sharp(ctx.staged).webp({ quality: 90 }).toBuffer());
              p.log?.(`[${ctx.name}] floating furniture lined up with the real floor: the pieces against that wall (x ${plan.wallPct![0]}-${plan.wallPct![1]}%) moved down ${plan.movedDownPct}% and ${plan.growPct}% bigger — no re-stage needed`);
            } else if (recheck.floating) {
              p.warn?.(`[${ctx.name}] floating furniture line-up tried (down ${plan.movedDownPct}%, ${plan.growPct}% bigger) but still floating — not used`);
            }
          } else {
            row.floatingLineUp = { applied: false, why: plan.why };
            p.warn?.(`[${ctx.name}] floating furniture can't be lined up: ${plan.why}`);
          }
        }
        // Still floating, or the skirting beside furniture still higher in
        // Gemini's picture: bring ALL the furniture forward together, in
        // perspective, until the place that needs it most stands just below
        // the real skirting (see planGroupForward). Kept when nothing floats
        // afterwards.
        let groupShifted = false;
        const needDown: Array<{ x1Pct: number; x2Pct: number; needPct: number }> = [];
        if (row.floatingCheck.floating && !floorPlan?.ok) {
          // How far: Gemini's floor line under the furniture vs the real one
          // where it can be read (the floating check's own gap runs from a
          // table's raised body, not its feet, and overstates it).
          const under = row.floatingCheck.fromGeminiFloorLine ? row.floatingCheck.runs : await seamUnderFurniture(original, ctx.staged, layers.floor, w, h).catch(() => [] as any[]);
          for (const r of (under.length ? under : row.floatingCheck.runs)) needDown.push({ x1Pct: r.x1Pct, x2Pct: r.x2Pct, needPct: Number(r.gapPct) });
        }
        if (!lineUpApplied) for (const r of skirtingLeft) if (r.dyPct < 0 && Math.abs(r.dyPct) >= FLOOR_MOVED_RISE_PCT) needDown.push({ x1Pct: r.x1Pct, x2Pct: r.x2Pct, needPct: -r.dyPct });
        if (needDown.length && GROUP_SHIFT) {
          // Gemini's floor line along the furniture (under it, and the
          // skirting just beside it), so a slight tilt can follow the real wall.
          const extra: Array<{ xPct: number; needPct: number }> = [];
          const under = await geminiLineUnderColumns(original, ctx.staged, layers.floor, w, h).catch(() => null);
          if (under) for (let c = 0; c < under.length; c += 4) if (!Number.isNaN(under[c])) extra.push({ xPct: (c / (under.length - 1)) * 100, needPct: under[c] });
          if (colOffsetsForLineUp) {
            let fx1 = 101, fx2 = -1;
            for (let i = 0; i < layers.floor.length; i++) if (layers.floor[i]) { const xp = ((i % w) / w) * 100; if (xp < fx1) fx1 = xp; if (xp > fx2) fx2 = xp; }
            const L = colOffsetsForLineUp.length;
            for (let c = 0; c < L; c += 4) { const v = colOffsetsForLineUp[c]; const xp = (c / (L - 1)) * 100; if (v != null && xp >= fx1 - 5 && xp <= fx2 + 5) extra.push({ xPct: xp, needPct: -v }); }
          }
          // In the carry-over round only a small correction: the furniture was
          // already placed; a big one means Gemini drifted (use the moved result).
          const plan = await planGroupForward(original, needDown, layers.floor, w, h, extra, (carry as any)?.mode === "carry" ? CARRY_ROUND_MAX_GROW : undefined).catch((e: any) => ({ ok: false, why: `plan error: ${String(e?.message || e)}` } as any));
          row.groupShift = { applied: false, needed: needDown, why: plan.why, ...(plan.ok ? { shiftPct: plan.shiftPct, growPct: plan.growPct, tiltDeg: plan.tiltDeg } : {}) };
          if (plan.ok) {
            const ap = await applySkirtingLineUp(ctx.staged, {
              floor: layers.floor, tightFloor: layers.tightFloor, artRegion: layers.artRegion, solid: layers.solid, zone: layers.zone, core: layers.core, legPocket: layers.legPocket,
            }, layers.floor, plan, w, h);
            const fl = ap.masks.floor as Uint8Array;
            let recheck: any = await checkFloatingFurniture(original, fl, w, h).catch((e: any) => ({ floating: true, runs: [], error: String(e?.message || e) }));
            // A hair above the floor after the move is not visible: the same
            // allowance the last attempt already has (Nov 2026 test: a piece
            // at the far edge 1.4% up threw a good move away).
            if (recheck.floating && recheck.runs?.length && recheck.runs.every((r: any) => Number(r.gapPct) <= FLOAT_ACCEPT_AFTER_MOVE_PCT)) {
              recheck = { ...recheck, floating: false, acceptedAfterMove: recheck.runs, runs: [] };
            }
            const under = recheck.floating ? [] : await seamUnderFurniture(original, ap.staged, fl, w, h).catch(() => [] as any[]);
            io.save?.("3d_brought_forward.webp", await sharp(ap.staged).webp({ quality: 88 }).toBuffer());
            io.save?.("3d_brought_forward_mask.png", await maskToPng(fl, w, h));
            if (!recheck.floating && !under.length) {
              ctx = { ...ctx, staged: ap.staged };
              layers = layersAfterLineUp(layers, ap.masks);
              layers = { ...layers, solidPng: await maskToPng(layers.solid, w, h) };
              row.groupShift.applied = true;
              row.floatingCheck = { ...recheck, linedUpFrom: row.floatingCheck.runs };
              skirtingLeft = [];
              groupShifted = true;
              const sf = await finalSkirtingFit(original, ctx.staged, layers, ap.movedArea, w, h).catch(() => null);
              if (sf) {
                row.skirtingFit = { applied: sf.applied, ...(sf.applied ? { beforePct: sf.beforePct, afterPct: sf.afterPct, maxNudgePct: sf.maxNudgePct } : { why: sf.why }) };
                if (sf.applied) {
                  ctx = { ...ctx, staged: sf.staged };
                  layers = layersAfterLineUp(layers, sf.masks as any);
                  layers = { ...layers, solidPng: await maskToPng(layers.solid, w, h) };
                  io.save?.("3e_skirting_fitted.webp", await sharp(ctx.staged).webp({ quality: 88 }).toBuffer());
                  p.log?.(`[${ctx.name}] skirting fitted along the furniture: Gemini's floor line ${sf.beforePct}% → ${sf.afterPct ?? "?"}% from the real one (columns nudged up to ${sf.maxNudgePct}%)`);
                }
              }
              p.log?.(`[${ctx.name}] all furniture brought forward together: down ${plan.shiftPct}% and ${plan.growPct}% bigger${plan.tiltDeg ? `, tilted ${plan.tiltDeg}° to follow the real wall` : ""} (Gemini's floor was up to ${Math.max(...needDown.map((n) => n.needPct)).toFixed(1)}% higher than the real one) — it now stands just below the real skirting; no re-stage needed`);
            } else {
              row.groupShift.stillFloating = recheck.floating ? recheck.runs : under;
              p.warn?.(`[${ctx.name}] bringing all furniture forward (down ${plan.shiftPct}%, ${plan.growPct}% bigger) tried but something still floats (${(recheck.floating ? recheck.runs : under).map((r: any) => `x ${r.x1Pct}-${r.x2Pct}% ${r.gapPct}%`).join("; ")}) — not used`);
            }
          } else {
            p.warn?.(`[${ctx.name}] furniture not brought forward: ${plan.why}`);
          }
        }
        // Floor moved: Gemini raised the floor / pushed a wall back to fit the
        // furniture (walls and windows unchanged, so the room check passes).
        // Merging would paste a rug or bed onto the real wall.
        // (Not after the group shift: the furniture now stands at or below the
        // real floor line wherever Gemini's was higher.)
        // Nothing planned to stand on the floor (a fitted kitchen styled with
        // a bowl, a plant and a board on the bench; light-staging rooms):
        // the pieces sit on benches, rails and shelves, so the floor checks
        // read them as "floating" and measure the bench edge as a moved
        // skirting (Nov 2026, Harcourts: two kitchens failed 3 attempts each
        // and their retries too, with good Gemini pictures). The room-shape
        // and the general floor-line check below still apply.
        const surfaceOnly = surfaceStylingOnly(p.roomType, attemptBrief);
        if (FLOOR_MOVED_CHECK && !groupShifted) {
          row.floorMovedCheck = await checkFloorMoved(original, ctx.staged, layers.solid, w, h).catch((e: any) => ({ moved: false, error: String(e?.message || e) }));
          // A clear offset beside furniture that wasn't lined up counts too
          // (not for bench-top styling: "beside" it is the bench, not a skirting).
          const besides = surfaceOnly ? [] : skirtingLeft.filter((r) => Math.abs(r.dyPct) >= FLOOR_MOVED_RISE_PCT);
          if (!row.floorMovedCheck.moved && besides.length) {
            const r = [...besides].sort((a, b) => b.widthPct - a.widthPct)[0];
            row.floorMovedCheck = { ...row.floorMovedCheck, moved: true, besideFurniture: besides, longestRunPct: r.widthPct, maxRisePct: Math.abs(r.dyPct), atXPct: [Math.round(r.x1Pct), Math.round(r.x2Pct)] };
          }
          // Furniture standing on floor Gemini drew over the real wall (found
          // above, from the "missed" areas): the same fault.
          if (!row.floorMovedCheck.moved && row.floorOverWallUnderFurniture?.length) {
            const list = row.floorOverWallUnderFurniture as any[];
            row.floorMovedCheck = {
              ...row.floorMovedCheck, moved: true, underFurniture: true,
              maxRisePct: Math.max(row.floorMovedCheck.maxRisePct || 0, row.floorOverWall?.maxRisePct || 0),
              longestRunPct: +Math.max(...list.map((m) => (m.box[2] - m.box[0]) * 100)).toFixed(1),
              atXPct: [Math.round(Math.min(...list.map((m) => m.box[0])) * 100), Math.round(Math.max(...list.map((m) => m.box[2])) * 100)],
            };
          }
          if (row.floorMovedCheck.moved) {
            p.warn?.(`[${ctx.name}] Gemini moved the floor line to fit the furniture (its floor reaches up to ${row.floorMovedCheck.maxRisePct}% of the photo's height over the real wall, across ${row.floorMovedCheck.longestRunPct}% of the width) — re-staging`);
          }
        }
        // Last attempt: a piece "missed by the trace" alone no longer fails
        // the job. Most are a shadow or reflection on the floor (Oct 2026:
        // DSC07855 failed 3 jobs on a glossy floor's reflection); the area was
        // taken from Gemini's picture in traceLayers. Every other check still
        // applies.
        if (row.furnitureCutByTrace && row.missedUnderFilled?.length
          && (finalAttempt(eff) || (row.furnitureCutByTrace as any[]).every(isFillableCutAnyAttempt))) {
          row.furnitureCutByTraceAccepted = true;
          p.log?.(`[${ctx.name}] publishing, with the area missed by the trace (${(row.furnitureCutByTrace as any[]).map((m) => `${m.areaPct}%`).join(", ")}) taken from Gemini's picture${finalAttempt(eff) ? " (last attempt)" : ""}`);
        }
        // Last attempt: a piece that hangs only a hair above the real floor
        // line is published. The check can't tell a sofa's back leg (rightly
        // on the wall line, arm overhanging beside it) from a front leg on
        // the skirting; at this size it is not visible (Oct 2026, Bendale 011:
        // sofa against a wall in front of a floor-level window, gaps 1.2% and
        // 1.4%, both attempts visual passes, job fell back to 1A).
        if (
          row.floatingCheck.floating && !floorPlan?.ok && finalAttempt(eff) &&
          row.floatingCheck.runs.every((r: any) => r.gapPct <= FLOAT_ACCEPT_LAST_GAP_PCT)
        ) {
          row.floatingAccepted = true;
          p.warn?.(`[${ctx.name}] last attempt: publishing — furniture ends only ${Math.max(...row.floatingCheck.runs.map((r: any) => r.gapPct))}% above the floor line (at most ${FLOAT_ACCEPT_LAST_GAP_PCT}% accepted)`);
        }
        if (row.floatingCheck.floating && !floorPlan?.ok && !row.floatingAccepted && surfaceOnly) {
          row.floatingAccepted = true;
          p.log?.(`[${ctx.name}] ${p.roomType}: nothing planned on the floor — "floating" pieces not treated as a failure (items on benches, rails and shelves sit above the floor)`);
        }
        if (carryMismatch) {
          // (reason already given; the moved result is used instead)
        } else if (row.furnitureCutByTrace && !row.furnitureCutByTraceAccepted) {
          reasons.push("furniture cut off by the trace");
        } else if (row.framingCheck?.framingChanged) {
          // Reshaped room: paste-back can't fix it, so skip the blend and door
          // check (time and cost) and go straight to the re-stage / fallback.
          reasons.push("room reshaped");
        } else if (row.floorMovedCheck?.moved && !carryTrusted) {
          reasons.push("room changed to fit the furniture");
        } else if (row.floatingCheck.floating && !floorPlan?.ok && !row.floatingAccepted && !carryTrusted) {
          reasons.push("furniture floating");
        } else if (CARRY_OVER && !carry && (groupShifted || lineUpApplied) && await (async () => {
          // The furniture was moved onto the real floor: let Gemini carry it
          // over onto the empty photo, then check that picture (next round).
          const img = await carryOverFurniture(ctx, layers).catch(() => null);
          if (!img) return false;
          const imagePath = path.join(dir, "9_carry_over_staged.png");
          fs.writeFileSync(imagePath, img);
          carry = { mode: "carry", imagePath, stagedPath, fromDir: dir, placed: Uint8Array.from(layers.floor) };
          io.save?.("9_carry_over_placed_mask.png", await maskToPng(layers.floor, w, h));
          p.log?.(`[${ctx.name}] furniture moved onto the real floor — Gemini carried it over onto the empty photo; checking that picture next`);
          return true;
        })()) {
          goRound = true;
        } else {
          const hm = await harmonise((carry as any)?.mode === "carry" ? { ...ctx, blendFrom: ctx.staged } : ctx, layers);
          final = hm.checkedBlend || hm.harmFinal;
          // A piece cut off by the line-up must have been continued by the blend.
          // If not, a small edge crop (below) may still save the photo.
          const cutAtEdge = Boolean(ctx.completionZone && !(row.realignCompletion?.applied && row.realignCompletion.filledPct >= 30));
          const edgeCrop = cutAtEdge && EDGE_CROP_ENABLED && ctx.emptyStrip ? planEdgeCrop(ctx.emptyStrip, w, h) : null;
          if (cutAtEdge && !edgeCrop?.ok) {
            if (edgeCrop) {
              row.edgeCrop = { applied: false, reason: edgeCrop.reason, trimPct: edgeCrop.trimPct };
              p.warn?.(`[${ctx.name}] edge crop not possible: ${edgeCrop.reason}`);
            }
            reasons.push("furniture cut off at the photo edge");
          }
          if (floorPlan?.ok && final) {
            const fp = await applyFloorPatches(original, final, ctx.staged, layers.floor, floorPlan.patches, w, h)
              .catch((e: any) => ({ image: null, notes: [`apply error: ${String(e?.message || e)}`] }));
            row.floorPatch.applied = Boolean(fp.image);
            row.floorPatch.notes.push(...fp.notes);
            if (fp.image) {
              final = fp.image;
              io.save?.("12_floor_patched.webp", await sharp(fp.image).webp({ quality: 92 }).toBuffer());
              p.log?.(`[${ctx.name}] floor patch applied: ${fp.notes.join("; ") || "ok"}`);
            } else {
              p.warn?.(`[${ctx.name}] floor patch rejected: ${fp.notes.join("; ")}`);
              reasons.push("furniture floating");
            }
          }
          // Disputed early door verdicts: the same check, on the finished image, decides.
          if (reasons.length === 0 && deferredDoor.length && final) {
            const doorsNow = (await getDoors()) || [];
            for (const kind of deferredDoor) {
              const re: any = kind === "living"
                ? await askLivingDoor(ctx.originalPath, final, doorsNow, dir, `${ctx.name}-final`, livingPlan)
                : kind === "bed"
                  ? await askBedWall(ctx.originalPath, final, doorsNow, dir, `${ctx.name}-final`, plannedBedWall)
                  : await askDeskDoor(ctx.originalPath, final, doorsNow, dir, `${ctx.name}-final`);
              const failed = kind === "bed" ? Boolean(re.coversDoor && re.failed) : Boolean(re.failed);
              const slot = kind === "living" ? "livingDoor" : kind === "bed" ? "bedWall" : "deskDoor";
              row[slot].finalRecheck = { votes: re.consensus?.votes, failed, answer: re.answer };
              if (failed) {
                row[slot].restageHints = re.restageHints;
                reasons.push(kind === "living" ? "furniture blocking a door" : kind === "bed" ? "bed against a door wall or window" : "desk blocking a door");
                p.warn?.(`[${ctx.name}] disputed door verdict confirmed on the finished image (votes ${JSON.stringify(re.consensus?.votes)}) — re-staging`);
              } else {
                p.log?.(`[${ctx.name}] disputed door verdict cleared on the finished image (votes ${JSON.stringify(re.consensus?.votes)}) — the door is passable`);
              }
            }
          }
          if (reasons.length === 0) {
            await finalDoorCheck(ctx, final, await getDoors());
            if (row.doorAccess?.blocked) reasons.push("doorway blocked");
            if (row.harmonise?.structureCheck && !row.harmonise.structureCheck.retained) reasons.push("structure check failed");
          }
          // Last step, after every check has passed on the full-size image:
          // trim the empty strip so the cut pieces run off the photo's edge.
          if (edgeCrop?.ok && final) {
            if (reasons.length === 0) {
              try {
                final = await applyEdgeCrop(final, edgeCrop, w, h);
                row.edgeCrop = { applied: true, trimPct: edgeCrop.trimPct, zoomPct: edgeCrop.zoomPct };
                io.save?.("13_edge_cropped.webp", await sharp(final).webp({ quality: 92 }).toBuffer());
                p.log?.(`[${ctx.name}] furniture cut off at the photo edge — saved by a ${edgeCrop.zoomPct}% edge crop (trim top ${edgeCrop.trimPct.top}%, bottom ${edgeCrop.trimPct.bottom}%, left ${edgeCrop.trimPct.left}%, right ${edgeCrop.trimPct.right}%)`);
              } catch (e: any) {
                row.edgeCrop = { applied: false, reason: `crop error: ${String(e?.message || e).slice(0, 200)}` };
                reasons.push("furniture cut off at the photo edge");
              }
            } else {
              row.edgeCrop = { applied: false, reason: "other checks failed", trimPct: edgeCrop.trimPct };
              reasons.push("furniture cut off at the photo edge");
            }
          }
        }
      }
    } catch (e: any) {
      row.error = String(e?.message || e).slice(0, 400);
      reasons.push(`processing error: ${row.error}`);
    }
    if (p.onAttemptFiles) pendingUploads.push(p.onAttemptFiles(attempt, dir, [...files]).catch(() => {}));
    if (goRound) {
      row.outcome = "moved — carry-over round next";
      internalRounds++;
      continue;
    }
    // Gemini added nothing, in a room that may stay empty: nothing to stage.
    // Re-staging can't help (Nov 2026, Harcourts batch: garages failed 4x).
    if (/tracing found almost no furniture/.test(String(row.error || "")) && roomAllowsEmptyLayout(p.roomType)) {
      row.outcome = "nothing to stage (room may stay empty)";
      p.log?.(`[${p.jobId}] masked Stage 2: nothing was added to this ${p.roomType} — delivering the enhanced photo, no re-stage`);
      await finishUploads();
      return { ok: false, reasons: ["nothing to stage"], attempts: eff, reports, nothingToStage: true };
    }
    if (reasons.length === 0 && final) {
      const outputPath = p.outputPathFor(attempt);
      await sharp(final).webp({ quality: 95 }).toFile(outputPath);
      row.outcome = (carry as any)?.mode === "carry" ? "publish (carried over)" : "publish";
      await finishUploads();
      return { ok: true, outputPath, attempts: eff, reports };
    }
    // The carried-over picture failed a check: use the moved result as before
    // (same staging, its saved traces — no new Gemini staging or tracing).
    if ((carry as any)?.mode === "carry") {
      row.outcome = `carry-over not used (${reasons.join(", ")}) — back to the moved result`;
      p.warn?.(`[${p.jobId}] masked Stage 2: carried-over picture failed (${reasons.join(", ")}) — using the moved result`);
      const c = carry as unknown as { mode: "carry" | "fallback"; imagePath: string; stagedPath: string; fromDir: string; placed?: Uint8Array };
      carry = { ...c, mode: "fallback" };
      internalRounds++;
      continue;
    }
    carry = null;
    if (eff > p.maxRestages) {
      // One more staging when the last attempt failed only on how the
      // furniture fitted the room (or a processing error): Gemini varies a lot
      // between stagings, and these are usually fine on a fresh try (Nov 2026
      // test run, Bedroom_05: 4 of 4 new stagings kept the wall Gemini had
      // removed in both attempts). Any other reason fails as before.
      row.reasonsList = [...reasons];
      // Compare with the previous STAGING (carry-over rounds are the same staging).
      const stagingRows = reports.filter((r: any) => !r.carryRound);
      const prior = stagingRows.length >= 2 ? stagingRows[stagingRows.length - 2] : null;
      const repeat = Boolean(prior) && sameRoomChangeAgain(prior, row);
      if (repeat) {
        row.extraRestageSkipped = "same room change in the same place as the last attempt";
        p.warn?.(`[${p.jobId}] masked Stage 2: Gemini changed the room the same way, in the same place, as the last attempt — no extra staging`);
      }
      const extraOk = !repeat && extraRestagesUsed < EXTRA_RESTAGES && reasons.length > 0 && reasons.every(isLayoutOrTransientFailure);
      if (!extraOk) {
        row.outcome = `FAILED after re-stage (${reasons.join(", ")})`;
        await finishUploads();
        return { ok: false, reasons, attempts: eff, reports };
      }
      extraRestagesUsed++;
      row.extraRestage = true;
    }
    row.reasonsList = [...reasons];
    row.outcome = `re-stage (${reasons.join(", ")})`;
    p.warn?.(`[${p.jobId}] masked Stage 2: re-staging (attempt ${eff + 1}): ${reasons.join(", ")}`);
    // Pushed a wall back / raised the floor / left furniture floating: a
    // short instruction at the TOP of the next prompt (see retryPriorityHint).
    const movedRoom = Boolean(row.floorMovedCheck?.moved || row.floatingCheck?.floating);
    const movedAt: number[] | null = row.floorMovedCheck?.moved && Array.isArray(row.floorMovedCheck.atXPct)
      ? row.floorMovedCheck.atXPct
      : row.floatingCheck?.floating && row.floatingCheck.runs?.length
        ? [Math.min(...row.floatingCheck.runs.map((r: any) => r.x1Pct)), Math.max(...row.floatingCheck.runs.map((r: any) => r.x2Pct))]
        : null;
    hints = [
      ...(movedRoom && RETRY_PRIORITY ? [retryPriorityHint(movedAt)] : []),
      ...(row.doorAccess?.blocked ? row.doorAccess.restageHints || [] : []),
      ...(row.bedWall?.restageHints || []),
      ...(row.deskDoor?.restageHints || []),
      ...(row.livingDoor?.restageHints || []),
      // Floating furniture: Gemini's pieces ended above the real floor. Say so
      // in terms of the furniture only — "touch the floor" alone made Gemini
      // move the floor line or change the flooring. A piece the TRACE cut off
      // is our tracing error, not Gemini's, so it gets no correction at all.
      ...(row.floatingCheck?.floating
        ? ["Some furniture legs ended above the floor. Place and size each piece so its legs or base rest on the existing floor exactly as the input photo shows it — move or resize the furniture, never the floor line, skirting boards, walls or flooring."]
        : []),
      ...(row.framingCheck?.framingChanged ? [reshapeHint(row.cameraAlignment)] : []),
      ...(row.floorMovedCheck?.moved
        ? [floorMovedHint(row.floorMovedCheck, { tightShot: Boolean(attemptBrief?.tightShot) })]
        : []),
    ];
  }
}

// A near-wall strip (wall return / door frame close to the camera, running
// out of the photo at the top and bottom — see nearWallStrip.ts): stage the
// photo without it, then paste the result back next to the untouched strip.
// Returns null when there is no strip (the caller stages the whole photo).
async function runWithoutNearWallStrip(p: Parameters<typeof runMaskedStage2Job>[0]): Promise<MaskedJobResult | null> {
  const det = await detectNearWallStrip(p.inputPath);
  if (!det.crop) {
    p.log?.(`[${p.jobId}] near-wall strip: none (${det.reason})`);
    return null;
  }
  const crop = det.crop;
  const workDir = path.join(p.workDir, "near_wall");
  const cropPath = await writeCroppedInput(p.inputPath, crop, workDir);
  p.log?.(`[${p.jobId}] near-wall strip on the ${crop.side} (${crop.strips.map((s) => `${s.side} ${s.stripPct}%`).join(", ")}; staged x=${crop.left}-${crop.right}px) — staging the photo without it and pasting it back unchanged`);
  const inner = await runMaskedStage2Job({
    ...p,
    nearWallChecked: true,
    inputPath: cropPath,
    doors: typeof p.doors === "function"
      ? async () => {
          const d = await (p.doors as () => Promise<DoorOpening[] | null>)();
          return d ? remapBoxedItems(d, crop) : d;
        }
      : p.doors ? remapBoxedItems(p.doors, crop) : p.doors,
    stage: (attempt, hints) => p.stage(attempt, hints, { path: cropPath, crop }),
    outputPathFor: (attempt) => path.join(workDir, `final_cropped_attempt${attempt}.webp`),
    workDir,
  });
  const info = { side: crop.side, stripPct: crop.stripPct, keptX: [crop.left, crop.right], strips: crop.strips.map((s) => ({ side: s.side, stripPct: s.stripPct, score: s.score, busyPct: s.busyPct })) };
  for (const r of inner.reports) r.nearWallStrip = info;
  if (!inner.ok) return inner;
  const full = await pasteBackIntoFullPhoto(p.inputPath, fs.readFileSync(inner.outputPath), crop);
  const outputPath = p.outputPathFor(inner.attempts);
  await sharp(full).webp({ quality: 95 }).toFile(outputPath);
  p.log?.(`[${p.jobId}] near-wall strip pasted back (${crop.side}, ${crop.stripPct}%)`);
  return { ok: true, outputPath, attempts: inner.attempts, reports: inner.reports };
}
