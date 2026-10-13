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
  BLEND_MAX_REPAIR_PCT,
  DOOR_CHECK,
  callGeminiImage,
  imagePart,
  approxOutputCost,
  tracePassesFor,
  buildTracePrompt,
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
  erode,
  growDown,
  ratioOf,
  layersOverlay,
  measureOutsideDrift,
  checkFraming,
  checkCameraAlignment,
  checkFloatingFurniture,
  planFloorPatches,
  applyFloorPatches,
  canRealign,
  shouldPrealign,
  alignStagedToOriginal,
  furnitureCutAtEmptyEdge,
  cutPieceCompletionZone,
  applyCutPieceCompletion,
  REALIGN_MAX_EMPTY_PCT,
  undoneOverlay,
  compositeLayers,
  removeSunPatches,
  compositeHarmonise,
  checkStructureRetained,
  checkBlend,
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
  dir: string; // folder for door-check input images
  io: MaskedIO;
  row: any; // report, filled in step by step
  // After a line-up: the strip next to furniture that runs into the edge
  // Gemini's picture no longer covers; the blend continues the pieces there.
  completionZone?: Uint8Array | null;
  completionBand?: Uint8Array | null;
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

export type TraceLayers = Awaited<ReturnType<typeof traceLayers>>;

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
const CUT_UNDER_MIN_PCT = Number(process.env.CUT_UNDER_MIN_PCT || 40);              // ...with this much furniture right above it
const CLOSEUP_MAX_ADD_FACTOR = 3;     // may add at most 3x the flagged area...
const CLOSEUP_MAX_ADD_FLOOR_PCT = 2;  // ...or 2% of the photo, whichever is larger
const CLOSEUP_MAX_CUT_EDGE = 0.25;    // marking along >25% of a crop cut edge = a block
const CLOSEUP_TARGETS =
  "every piece of furniture and decor that was added in the staged image — beds, sofas, chairs, tables, bedside tables, dressers, lamps, rugs, plants, cushions and items on furniture — including pieces only partly in view at the edge of the photo";

async function closeUpRetrace(ctx: MaskedContext, floor: Mask, exclude: Uint8Array, minSpeck: number): Promise<Mask> {
  const { original, staged, w, h, row } = ctx;
  if (!CLOSEUP_RETRACE) return floor;
  const probe = await fillChangedGaps(floor, original, staged, w, h);
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
  if (ctx.offline) {
    raw = ctx.io.load?.("3_trace_closeup_raw.png") ?? null;
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
  const crop = cropBin.mask;
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

export async function traceLayers(ctx: MaskedContext) {
  const { original, staged, w, h, row } = ctx;
  const stagedMeta = await sharp(staged).metadata();
  const stagedMime = stagedMeta.format === "jpeg" ? "image/jpeg" : stagedMeta.format === "png" ? "image/png" : "image/webp";
  const passes = await Promise.all(
    tracePassesFor(ctx.roomType).map(async (pass) => {
      if (ctx.offline) {
        const saved = ctx.io.load?.(`3_trace_${pass.label}_raw.png`) ?? null;
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
    if (ctx.offline) {
      mirrorRaw = ctx.io.load?.("3_trace_mirrors_raw.png") ?? null;
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
    if (ctx.offline) {
      spaceRaw = ctx.io.load?.("3_trace_appliance_spaces_raw.png") ?? null;
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
  const tightFloor = ctx.tight ? await fillChangedGaps(floor, original, staged, w, h) : null;
  if (tightFloor) row.possiblyMissedByTrace = (tightFloor as any).possiblyMissedByTrace;
  floor = fillFurnitureColumns(floor, w, h);
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
  return { floor, tightFloor, artRegion, solid, zone, core, solidPng, traced, undone };
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
  const tCore = erode(tightFloor, w, h, Math.max(1, Math.round((w * CORE_ERODE_PCT) / 100)));
  for (let i = 0; i < tCore.length; i++) tCore[i] |= artRegion[i];
  const tSolidPng = await maskToPng(tSolid, w, h);
  const tCorePng = await maskToPng(tCore, w, h);
  save(ctx, "3_mask_tight.png", tSolidPng);
  const safeRes = await compositeLayers(original, staged, tSolidPng, tCorePng, await maskToPng(new Uint8Array(w * h), w, h), w, h, false, true);
  const edgeMattePctOfBand = safeRes.edgeMattePctOfBand;
  const safeFinal = safeRes.buffer;
  save(ctx, "9_safe_composite.webp", safeFinal);

  // Phase 2: Gemini adds shadows / blends lighting on the safe image.
  if (ctx.offline) {
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
  const affected = new Uint8Array(w * h);
  for (let i = 0; i < affected.length; i++) affected[i] = tSolid[i] | hZone[i];
  save(ctx, "3_mask_harmonise_shadow_zone.png", await maskToPng(hZone, w, h));
  row.harmonise = { tightFurniturePct: +(ratioOf(tightFloor) * 100).toFixed(1), shadowZonePct: +(ratioOf(hZone) * 100).toFixed(1), edgeMattePctOfBand };
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
    const hm = await compositeHarmonise(sun.buffer, harmRaw!, tSolidPng, furnPng, hZonePng);
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
    const cb = await checkBlend(harmFinal, harmRaw, tSolid, zoneAll, w, h);
    checkedBlendView = cb.repairedView;
    save(ctx, "11_checked_blend_repairs.jpg", cb.repairedView);
    row.checkedBlend = {
      patchesChecked: cb.patchesChecked,
      patchesRepaired: cb.patchesRepaired,
      repairPct: cb.repairPct,
      reasons: cb.reasons,
      furnitureRestyledAndRepaired: cb.furnitureChanged,
      usedAppBuiltInstead: cb.tooMuchChanged,
    };
    // Gemini's blend moved part of the room itself (a doorway or window edge
    // shifted). Patch repairs then mix moved and unmoved pieces, which shows
    // as broken lines (Bedroom 12's doorway), so the app-built final is used.
    const blendMovedRoom = (row.harmonise.blendFraming?.tilesChanged || 0) > 0;
    row.checkedBlend.blendMovedRoom = blendMovedRoom;
    if (blendMovedRoom) {
      warn(ctx, `[${ctx.name}] checked blend: Gemini's blend moved part of the room (${row.harmonise.blendFraming.tilesChanged} wall/ceiling patch(es)) — using the app-built final instead`);
      row.checkedBlend.usedAppBuiltInstead = true;
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
    row.doorAccess.blocked = ai.blocked;
    row.doorAccess.restageHints = ai.restageHints;
    row.doorAccess.result = ai.blocked ? "BLOCKED (AI)" : "clear (AI)";
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
  return `Your previous attempt ${what}, and it was rejected. The camera is locked: the result must have exactly the same framing, zoom, viewpoint and perspective as the input photo, with every wall edge, corner, window, door and the ceiling line in the same place. The furniture must fit the room, never the other way round — make pieces smaller, move them, let the edge of the photo cut them off, or leave pieces out. Do not crop, zoom, widen, rotate or redraw the room.`;
}

export type MaskedJobResult =
  | { ok: true; outputPath: string; attempts: number; reports: any[] }
  | { ok: false; reasons: string[]; attempts: number; reports: any[] };

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
  // the "keep this doorway clear" notes for a re-stage.
  stage: (attempt: number, hints: string[]) => Promise<string>;
  outputPathFor: (attempt: number) => string;
  workDir: string;
  // Optional: called with each attempt's work folder (debug uploads).
  onAttemptFiles?: (attempt: number, dir: string, files: string[]) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  // Offline replay for tests: saved Gemini outputs per attempt, no calls.
  replay?: (attempt: number, name: string) => Buffer | null;
}): Promise<MaskedJobResult> {
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
  for (let attempt = 1; ; attempt++) {
    const dir = path.join(p.workDir, `attempt${attempt}`);
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
    try {
      const stagedPath = await p.stage(attempt, hints);
      const staged = fs.readFileSync(stagedPath);
      io.save?.("2_staged_raw.webp", staged);
      // The exact staging prompt (and room brief, if used), saved by Stage 2.
      for (const [suffix, name] of [[".prompt.txt", "2_stage_prompt.txt"], [".room-brief.json", "2_room_brief.json"]] as const) {
        try {
          if (fs.existsSync(stagedPath + suffix)) io.save?.(name, fs.readFileSync(stagedPath + suffix));
        } catch {}
      }
      let ctx: MaskedContext = { name: `${p.jobId}#${attempt}`, original, originalPath: p.inputPath, originalMime, staged, roomType: p.roomType, aspectRatio, w, h, tight: true, offline: Boolean(p.replay), dir, io, row };
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
      let layers = await traceLayers(ctx);
      if (prealigned) {
        const cut = await furnitureCutAtEmptyEdge(layers.floor, prealigned.empty, prealigned.W, prealigned.H, w, h);
        if (cut.cutPct > 0) {
          const cz = await cutPieceCompletionZone(layers.floor, prealigned.empty, prealigned.W, prealigned.H, w, h);
          if (cz.zonePct > 0) ctx = { ...ctx, completionZone: cz.zone, completionBand: cz.band };
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
            if (cz.zonePct > 0) ctx = { ...ctx, completionZone: cz.zone, completionBand: cz.band };
          }
          row.realign = {
            scale: row.cameraAlignment.scale, shiftPct: row.cameraAlignment.shiftPct,
            emptyStripPct: al.emptyPct, firstRoomCheck: first,
            rescued: !row.framingCheck?.framingChanged, furnitureCutAtEdgePct: cut.cutPct,
          };
          p.log?.(`[${ctx.name}] line-up ${row.realign.rescued ? "RESCUED the staging" : "did not help"} (room check median ${first.medianDiff} -> ${row.framingCheck?.medianDiff}; empty strip ${al.emptyPct}%, furniture reaching it ${cut.cutPct}% of its edge)`);
        }
      }
      // Part of a piece missed by the trace: a sizeable changed area directly
      // UNDER traced furniture (where legs or a base should continue) that
      // the close-up re-trace didn't fill. Merging would publish the piece
      // cut off, with the real wall or skirting showing through (Oct 2026,
      // production: a bedside table's legs) — re-stage instead.
      const cutUnder = ((row.closeUpRetrace?.flaggedAreas || []) as any[]).filter(
        (m) => m.areaPct >= CUT_UNDER_MIN_AREA_PCT && (m.underFurniturePct || 0) >= CUT_UNDER_MIN_PCT
      );
      const closeUpFilled = !row.closeUpRetrace?.rejected && (row.closeUpRetrace?.addedPctOfImage || 0) >= 0.5 * cutUnder.reduce((s, m) => s + m.areaPct, 0);
      if (cutUnder.length && !closeUpFilled) {
        row.furnitureCutByTrace = cutUnder;
        p.warn?.(`[${ctx.name}] part of a piece missed by the trace (${cutUnder.map((m) => `${m.areaPct}% under furniture at x ${Math.round(m.box[0] * 100)}-${Math.round(m.box[2] * 100)}%`).join("; ")}) — re-staging`);
      }
      // Floating furniture: a piece whose legs stop short of the REAL floor
      // (Gemini drew the floor/wall line higher or lower). Where the join can
      // be hidden (a piece in front, a wall corner, the photo edge) we keep
      // Gemini's own floor and skirting under the piece ("floor patch");
      // otherwise re-stage. Planning needs no AI call, so a photo that must be
      // re-staged anyway skips the blend and door check.
      row.floatingCheck = await checkFloatingFurniture(original, layers.floor, w, h).catch((e: any) => ({ floating: false, runs: [], error: String(e?.message || e) }));
      let floorPlan: Awaited<ReturnType<typeof planFloorPatches>> | null = null;
      if (row.floatingCheck.floating) {
        p.warn?.(`[${ctx.name}] furniture floating above the real floor: ${row.floatingCheck.runs.map((r: any) => `x ${r.x1Pct}-${r.x2Pct}% ends ${r.gapPct}% above the floor line`).join("; ")}`);
        floorPlan = await planFloorPatches(original, ctx.staged, layers.floor, row.floatingCheck.runs, w, h)
          .catch((e: any) => ({ ok: false as const, patches: [], notes: [`plan error: ${String(e?.message || e)}`] }));
        row.floorPatch = { planned: floorPlan.ok, notes: floorPlan.notes };
        (floorPlan.ok ? p.log : p.warn)?.(`[${ctx.name}] floor patch ${floorPlan.ok ? "planned" : "not possible"}: ${floorPlan.notes.join("; ")}`);
      }
      if (row.furnitureCutByTrace) {
        reasons.push("furniture cut off by the trace");
      } else if (row.framingCheck?.framingChanged) {
        // Reshaped room: paste-back can't fix it, so skip the blend and door
        // check (time and cost) and go straight to the re-stage / fallback.
        reasons.push("room reshaped");
      } else if (row.floatingCheck.floating && !floorPlan?.ok) {
        reasons.push("furniture floating");
      } else {
        const hm = await harmonise(ctx, layers);
        final = hm.checkedBlend || hm.harmFinal;
        // A piece cut off by the line-up must have been continued by the blend.
        if (ctx.completionZone && !(row.realignCompletion?.applied && row.realignCompletion.filledPct >= 30)) {
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
        if (reasons.length === 0) {
          if (typeof p.doors === "function") {
            const getDoors = p.doors;
            p.doors = await getDoors().catch(() => null);
          }
          await finalDoorCheck(ctx, final, p.doors as DoorOpening[] | null);
          if (row.doorAccess?.blocked) reasons.push("doorway blocked");
          if (row.harmonise?.structureCheck && !row.harmonise.structureCheck.retained) reasons.push("structure check failed");
        }
      }
    } catch (e: any) {
      row.error = String(e?.message || e).slice(0, 400);
      reasons.push(`processing error: ${row.error}`);
    }
    if (p.onAttemptFiles) pendingUploads.push(p.onAttemptFiles(attempt, dir, [...files]).catch(() => {}));
    if (reasons.length === 0 && final) {
      const outputPath = p.outputPathFor(attempt);
      await sharp(final).webp({ quality: 95 }).toFile(outputPath);
      row.outcome = "publish";
      await finishUploads();
      return { ok: true, outputPath, attempts: attempt, reports };
    }
    if (attempt > p.maxRestages) {
      row.outcome = `FAILED after re-stage (${reasons.join(", ")})`;
      await finishUploads();
      return { ok: false, reasons, attempts: attempt, reports };
    }
    row.outcome = `re-stage (${reasons.join(", ")})`;
    p.warn?.(`[${p.jobId}] masked Stage 2: re-staging (attempt ${attempt + 1}): ${reasons.join(", ")}`);
    hints = [
      ...(row.doorAccess?.blocked ? row.doorAccess.restageHints || [] : []),
      ...(row.floatingCheck?.floating || row.furnitureCutByTrace
        ? ["Stand every piece of furniture firmly on the floor: legs and bases must touch the floor, never end on the wall or skirting board. Keep the line where the floor meets each wall exactly where it is in the input photo."]
        : []),
      ...(row.framingCheck?.framingChanged ? [reshapeHint(row.cameraAlignment)] : []),
    ];
  }
}
