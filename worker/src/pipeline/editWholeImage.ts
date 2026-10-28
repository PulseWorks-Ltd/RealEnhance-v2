// Remove, Add and Replace edits on the WHOLE photo (Oct 2026).
//
// The region edit sent Gemini a small cut-out of the area (padded to a square)
// plus the whole Stage 1A photo as a reference. With no room around it to go
// on, Gemini sometimes redrew the reference room instead, and that answer was
// cropped into the cut-out (demo, job_39c3b786: a slice of an empty room over
// the wall where a painting was).
//
// Here Gemini gets the whole photo plus a copy with the area marked, and
// returns the whole photo (the Stage 2 image model, which honours the shape
// and 2K size, so the patch is as sharp as the photo). Only the marked area is
// pasted back, colour-matched and with a soft edge; nothing outside it can
// change. The answer is checked first and retried if:
//  - the room moved (zoom/shift lined up when it is only that; otherwise retry);
//  - the wall/floor around the area changed (Gemini redrew the scene);
//  - nothing changed inside the area (the item wasn't removed / added).
// Add and Replace: users often mark too small an area for the piece they ask
// for (a chair, a TV unit), so the new piece may reach well past the marked
// area, up to REACH, as long as most of it (MIN_INSIDE_SHARE) lies inside the
// area. The whole piece and its shadow are pasted, never cut at the outline
// (Oct 2026: a TV-on-a-unit Add failed both attempts on a narrow 3.5% band).
// A piece mostly outside the area, or running past REACH, is retried and asked
// to fit inside. The surroundings are checked around the piece as drawn.
// Two attempts; if both fail the edit fails (nothing published, refunded).
//
// One Gemini image call per attempt; the checks and paste are code only.
// EDIT_WHOLE_IMAGE_MODES (default "Remove,Add,Replace") picks the modes;
// EDIT_REMOVE_WHOLE_IMAGE=off also takes Remove back to the region edit.
import sharp from "sharp";
import { closestGeminiAspectRatio } from "../ai/gemini";
import {
  callGeminiImage,
  imagePart,
  approxOutputCost,
  checkFraming,
  checkCameraAlignment,
  alignStagedToOriginal,
  canRealign,
  dilate,
  labelComponents,
  REALIGN_MAX_EMPTY_PCT,
} from "./stage2Masked/core";

export type WholeImageMode = "Remove" | "Add" | "Replace";

export function wholeImageEditEnabled(mode: string): boolean {
  if (mode !== "Remove" && mode !== "Add" && mode !== "Replace") return false;
  if (mode === "Remove" && String(process.env.EDIT_REMOVE_WHOLE_IMAGE ?? "on").trim().toLowerCase() === "off") return false;
  const modes = String(process.env.EDIT_WHOLE_IMAGE_MODES ?? "Remove,Add,Replace").split(",").map((m) => m.trim().toLowerCase());
  return modes.includes(mode.toLowerCase());
}
export function wholeImageRemoveEnabled(): boolean {
  return wholeImageEditEnabled("Remove");
}

const MODEL = process.env.EDIT_WHOLE_IMAGE_MODEL || "gemini-3.1-flash-image";
const IMAGE_SIZE = (process.env.EDIT_WHOLE_IMAGE_SIZE || "2K").toUpperCase();
const MAX_ATTEMPTS = 2;
const PASTE_GROW = 0.006;     // paste a little beyond the marked area (share of width): item edges, its shadow
const FEATHER = 0.004;        // soft edge (share of width)
const RING_INNER = 0.012;     // surroundings checked from here...
const RING_OUTER = 0.05;      // ...to here around the area (share of width)
const RING_DIFF = 30;         // per-pixel difference that counts as changed (0-255)
const RING_MAX_CHANGED = 0.3; // share of the surroundings that may change
const MIN_INSIDE_CHANGE = 6;  // average difference inside the area: below this nothing was removed
const REACH = Number(process.env.EDIT_ADD_REACH || 0.15);              // Add/Replace: how far past the area the new piece may reach (share of width)
const MIN_INSIDE_SHARE = Number(process.env.EDIT_ADD_MIN_INSIDE || 0.5); // share of the new piece that must lie inside the marked area
const SPILL_DIFF = 18;        // difference that counts as part of the new piece / its shadow
const SPILL_MAX_EDGE = 0.15;  // share of the reach band's outer edge the piece may touch before it counts as running past it

// box: the marked area's bounds, 0-1 [x1, y1, x2, y2]; given to Gemini as
// [ymin, xmin, ymax, xmax] on 0-1000 (its native box order).
export function buildWholeImageEditPrompt(mode: WholeImageMode, instruction: string, opts: { roomType?: string; fitInside?: boolean; box?: number[] } = {}): string {
  const request = instruction.replace(/"/g, "'").slice(0, 300);
  const room = opts.roomType ? ` (a ${String(opts.roomType).replace(/_/g, " ")})` : "";
  const change =
    mode === "Remove"
      ? ["remove the item inside the red-marked area, and fill that area with what is naturally behind it: continue the wall, ceiling, floor, skirting board, window, door or whatever surrounds it, matching its colour, texture, lighting and shadows exactly."]
      : mode === "Add"
      ? [
          `add what the user asks for (below) inside the red-marked area of this room${room}.`,
          "It must fit inside the marked area, at the correct size and perspective for the room, standing on the floor or hanging on the wall as a real piece would, lit like the rest of the room, with a soft natural contact shadow right beside it.",
          "Keep the style in keeping with the furniture already in the room.",
        ]
      : [
          `replace the item inside the red-marked area with what the user asks for (below), in this room${room}.`,
          "Remove the old item completely, and put the new one exactly where the old one stood — inside the red-marked area, not beside it — at the correct size and perspective, lit like the rest of the room, with a soft natural contact shadow.",
          "Where the new piece is smaller, continue the wall, floor or skirting behind it exactly as around it.",
        ];
  return [
    "You are given two images of the same real-estate photo.",
    "IMAGE 1 is the photo. IMAGE 2 is the same photo with one area marked in red.",
    "",
    "Return IMAGE 1 exactly as it is — the same camera position, framing, image size, lighting, colours and every detail — with ONE change:",
    ...change,
    ...(opts.box && opts.box.length === 4
      ? [`The red-marked area's bounding box is [${[opts.box[1], opts.box[0], opts.box[3], opts.box[2]].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1000)).join(", ")}] ([ymin, xmin, ymax, xmax] on a 0-1000 scale of the photo).`]
      : []),
    "",
    "Rules:",
    mode === "Remove" ? "- Change nothing outside the red-marked area." : "- Change nothing outside the red-marked area, apart from the new piece's own soft shadow right beside it.",
    mode === "Remove" ? "- Do not add any new object, decoration or furniture." : "- Add nothing else, and do not move, remove or restyle anything else in the room.",
    ...(opts.fitInside && mode !== "Remove" ? ["- Your previous answer ran past the marked area: make the piece smaller or reposition it so it fits entirely inside the marked area."] : []),
    "- Keep every window, door, wall and the floor exactly as they are.",
    "- Do not draw any red, outline or marking in your answer.",
    "- Do not zoom, crop, straighten, re-light or re-colour the photo.",
    "- Return the whole photo, not a close-up of the area.",
    "",
    `The user's request: "${request}"`,
  ].join("\n");
}
export function buildWholeImageRemovePrompt(instruction: string): string {
  return buildWholeImageEditPrompt("Remove", instruction);
}

/** The photo with the area tinted red and outlined, for Gemini to see what to remove. */
async function markedCopy(photo: Buffer, mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const edgeR = Math.max(2, Math.round(w * 0.003));
  const grown = dilate(mask, w, h, edgeR);
  const overlay = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (grown[i] && !mask[i]) { overlay[i * 4] = 255; overlay[i * 4 + 3] = 255; }      // outline
    else if (mask[i]) { overlay[i * 4] = 255; overlay[i * 4 + 3] = 90; }               // tint
  }
  return sharp(photo).removeAlpha().composite([{ input: overlay, raw: { width: w, height: h, channels: 4 } }]).jpeg({ quality: 92 }).toBuffer();
}

/** Blurred 0-255 alpha of a 0/1 mask. */
async function soften(mask: Uint8Array, w: number, h: number, sigma: number): Promise<Buffer> {
  return sharp(Buffer.from(mask.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
    .blur(Math.max(0.3, sigma)).extractChannel(0).raw().toBuffer();
}

export type WholeImageCheck = {
  ok: boolean;
  why?: string;
  ringChangedShare: number;
  insideMeanDiff: number;
  gains: number[];
};

/**
 * Pure checks on Gemini's answer (already at the photo's size and lined up):
 * surroundings kept, something removed. Also returns the colour gains
 * (answer -> photo) measured on the surroundings.
 */
export function checkWholeImageAnswer(o: Buffer, g: Buffer, mask: Uint8Array, w: number, h: number, opts: { ringFrom?: number } = {}): WholeImageCheck {
  const from = opts.ringFrom ?? 0; // Add/Replace: the surroundings start beyond the spill band
  const inner = dilate(mask, w, h, Math.max(2, Math.round(w * (from + RING_INNER))));
  const outer = dilate(mask, w, h, Math.max(4, Math.round(w * (from + RING_OUTER))));
  const sums = [0, 0, 0, 0, 0, 0];
  const ring: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!outer[i] || inner[i]) continue;
    ring.push(i);
    for (let c = 0; c < 3; c++) { sums[c] += o[i * 3 + c]; sums[c + 3] += g[i * 3 + c]; }
  }
  const gains = [0, 1, 2].map((c) => (sums[c + 3] > 0 ? Math.min(1.5, Math.max(0.67, sums[c] / sums[c + 3])) : 1));
  let changed = 0;
  for (const i of ring) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(o[i * 3 + c] - g[i * 3 + c] * gains[c]));
    if (d > RING_DIFF) changed++;
  }
  const ringChangedShare = ring.length ? changed / ring.length : 0;
  let inside = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(o[i * 3 + c] - g[i * 3 + c] * gains[c]);
    inside += d / 3; n++;
  }
  const insideMeanDiff = n ? inside / n : 0;
  const r = (v: number, k = 3) => Number(v.toFixed(k));
  if (ringChangedShare > RING_MAX_CHANGED) {
    return { ok: false, why: `${Math.round(ringChangedShare * 100)}% of the area around the item changed`, ringChangedShare: r(ringChangedShare), insideMeanDiff: r(insideMeanDiff, 1), gains: gains.map((v) => r(v)) };
  }
  if (insideMeanDiff < MIN_INSIDE_CHANGE) {
    return { ok: false, why: "nothing changed inside the marked area", ringChangedShare: r(ringChangedShare), insideMeanDiff: r(insideMeanDiff, 1), gains: gains.map((v) => r(v)) };
  }
  return { ok: true, ringChangedShare: r(ringChangedShare), insideMeanDiff: r(insideMeanDiff, 1), gains: gains.map((v) => r(v)) };
}

/**
 * Add/Replace: the new piece as Gemini drew it — every changed region (piece
 * and shadow) that overlaps the marked area, out to REACH past it. insideShare
 * is how much of it lies inside the area; edgeShare is how much of the reach
 * band's outer edge it touches (a piece running past REACH).
 */
export function findNewPiece(o: Buffer, g: Buffer, mask: Uint8Array, gains: number[], w: number, h: number): { piece: Uint8Array; insideShare: number; edgeShare: number; pctOfImage: number } {
  const bandR = Math.max(3, Math.round(w * REACH));
  const band = dilate(mask, w, h, bandR);
  const changed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!band[i]) continue;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(o[i * 3 + c] - g[i * 3 + c] * gains[c]));
    if (d > SPILL_DIFF) changed[i] = 1;
  }
  const piece = new Uint8Array(w * h);
  let inside = 0, outside = 0;
  for (const comp of labelComponents(changed, w, h)) {
    if (comp.pixels.length < w * h * 0.0002) continue;
    if (!comp.pixels.some((i) => mask[i])) continue;
    for (const i of comp.pixels) { piece[i] = 1; if (mask[i]) inside++; else outside++; }
  }
  const inner = dilate(mask, w, h, Math.max(1, bandR - 2));
  let edge = 0, hit = 0;
  for (let i = 0; i < w * h; i++) {
    if (!band[i] || inner[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue; // the photo's own edge is not "running past"
    edge++;
    if (piece[i]) hit++;
  }
  const total = inside + outside;
  return {
    piece,
    insideShare: total ? Number((inside / total).toFixed(3)) : 1,
    edgeShare: edge ? Number((hit / edge).toFixed(3)) : 0,
    pctOfImage: Number(((total / (w * h)) * 100).toFixed(2)),
  };
}

/** The photo with only the marked area taken from the answer (colour-matched, soft edge). */
export async function pasteMarkedArea(photo: Buffer, answer: Buffer, mask: Uint8Array, gains: number[], w: number, h: number): Promise<Buffer> {
  const grown = dilate(mask, w, h, Math.max(1, Math.round(w * PASTE_GROW)));
  const alpha = await soften(grown, w, h, w * FEATHER);
  const out = Buffer.from(photo);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i] / 255;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const v = Math.min(255, answer[i * 3 + c] * gains[c]);
      out[i * 3 + c] = Math.round(photo[i * 3 + c] * (1 - a) + v * a);
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/**
 * Fine line-up around the area: the integer shift (up to +-LOCAL_SHIFT px)
 * that best matches the answer to the photo on the surroundings, so the
 * patch's edges meet the photo exactly. Returns the shifted answer.
 */
const LOCAL_SHIFT = 6;
export function lineUpAroundArea(o: Buffer, g: Buffer, mask: Uint8Array, w: number, h: number, ringFrom = 0): { shifted: Buffer; dx: number; dy: number } {
  const inner = dilate(mask, w, h, Math.max(2, Math.round(w * (ringFrom + RING_INNER))));
  const outer = dilate(mask, w, h, Math.max(4, Math.round(w * (ringFrom + RING_OUTER))));
  const ring: number[] = [];
  for (let i = 0; i < w * h; i += 2) if (outer[i] && !inner[i]) ring.push(i);
  const lum = (b: Buffer, i: number) => b[i * 3] * 0.299 + b[i * 3 + 1] * 0.587 + b[i * 3 + 2] * 0.114;
  // Brightness-independent: compare each pixel with its ring average.
  let mo = 0, mg = 0;
  for (const i of ring) { mo += lum(o, i); mg += lum(g, i); }
  mo /= Math.max(1, ring.length); mg /= Math.max(1, ring.length);
  let best = { dx: 0, dy: 0, score: Infinity };
  for (let dy = -LOCAL_SHIFT; dy <= LOCAL_SHIFT; dy++) for (let dx = -LOCAL_SHIFT; dx <= LOCAL_SHIFT; dx++) {
    let sum = 0, n = 0;
    for (const i of ring) {
      const x = (i % w) + dx, y = Math.floor(i / w) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      sum += Math.abs(lum(o, i) - mo - (lum(g, y * w + x) - mg)); n++;
    }
    const score = n ? sum / n : Infinity;
    // Prefer no shift unless a shift is clearly better.
    if (score < best.score - (dx || dy ? 0.05 : 0)) best = { dx, dy, score };
  }
  if (!best.dx && !best.dy) return { shifted: g, dx: 0, dy: 0 };
  const shifted = Buffer.alloc(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(w - 1, Math.max(0, x + best.dx)), sy = Math.min(h - 1, Math.max(0, y + best.dy));
    const d = (y * w + x) * 3, s2 = (sy * w + sx) * 3;
    shifted[d] = g[s2]; shifted[d + 1] = g[s2 + 1]; shifted[d + 2] = g[s2 + 2];
  }
  return { shifted, dx: best.dx, dy: best.dy };
}

export type WholeImageRemoveResult = { image: Buffer; attempts: number; report: any[] };
export type WholeImageEditResult = WholeImageRemoveResult;

export function wholeImageRemove(params: {
  photoPath: string;
  mask: Uint8Array;
  instruction: string;
  jobId?: string;
  log?: (msg: string, data?: any) => void;
}): Promise<WholeImageRemoveResult> {
  return wholeImageEdit({ ...params, mode: "Remove" });
}

/**
 * mask: 0/1 at the photo's size (the user's marked area, after the usual
 * object refinement for Remove). Throws when no attempt passes.
 */
export async function wholeImageEdit(params: {
  mode: WholeImageMode;
  photoPath: string;
  mask: Uint8Array;
  instruction: string;
  roomType?: string;
  jobId?: string;
  log?: (msg: string, data?: any) => void;
  // Optional: each attempt's answer, lined up with the photo (debug uploads).
  onAnswer?: (attempt: number, answer: Buffer) => void;
}): Promise<WholeImageEditResult> {
  const { mode } = params;
  // Add/Replace: line-up, framing and colour are measured beyond the reach band.
  const ringFrom = mode === "Remove" ? 0 : REACH;
  let fitInside = false;
  const log = params.log || ((m: string, d?: any) => console.log(m, d ?? ""));
  const meta = await sharp(params.photoPath).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  if (!w || !h) throw new Error(`whole-image ${mode}: unreadable photo`);
  const { mask } = params;
  let maskPx = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) maskPx++;
  if (!maskPx) throw new Error(`whole-image ${mode}: empty mask`);
  const photoJpeg = await sharp(params.photoPath).removeAlpha().jpeg({ quality: 92 }).toBuffer();
  const photoRaw = await sharp(params.photoPath).removeAlpha().raw().toBuffer();
  const marked = await markedCopy(photoJpeg, mask, w, h);
  let bx1 = w, by1 = h, bx2 = 0, by2 = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { const x = i % w, y = (i / w) | 0; if (x < bx1) bx1 = x; if (x > bx2) bx2 = x; if (y < by1) by1 = y; if (y > by2) by2 = y; }
  const box = [bx1 / w, by1 / h, (bx2 + 1) / w, (by2 + 1) / h];
  const aspectRatio = closestGeminiAspectRatio(w, h);
  const report: any[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const row: any = { attempt, mode, model: MODEL, imageSize: IMAGE_SIZE, aspectRatio, ...(fitInside ? { askedToFitInside: true } : {}) };
    report.push(row);
    try {
      const res = await callGeminiImage({
        model: MODEL,
        imageSize: IMAGE_SIZE,
        aspectRatio,
        parts: [
          { text: buildWholeImageEditPrompt(mode, params.instruction, { roomType: params.roomType, fitInside, box }) },
          { text: "IMAGE 1 (the photo):" }, imagePart(photoJpeg, "image/jpeg"),
          { text: `IMAGE 2 (the area to ${mode === "Remove" ? "remove" : mode === "Add" ? "add to" : "replace"}, marked in red):` }, imagePart(marked, "image/jpeg"),
        ],
      });
      row.costUsd = approxOutputCost(res.usage);
      const am = await sharp(res.image).metadata();
      row.answer = `${am.width}x${am.height}`;
      // Same shape as the photo (Gemini's nearest supported ratio): resize.
      const answerShape = (am.width || 1) / (am.height || 1), photoShape = w / h;
      if (Math.abs(Math.log(answerShape / photoShape)) > 0.06) {
        row.outcome = `wrong shape (${row.answer} for a ${w}x${h} photo)`;
        log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
        continue;
      }
      let answer = await sharp(res.image).removeAlpha().resize(w, h, { fit: "fill" }).png().toBuffer();
      // Did the room move? A plain zoom/shift is lined up; anything else is retried.
      const cam = await checkCameraAlignment(photoJpeg, answer).catch(() => null);
      row.cameraAlignment = cam;
      if (cam && canRealign(cam)) {
        const al = await alignStagedToOriginal(photoJpeg, answer, cam);
        if (al.emptyPct > Math.min(3, REALIGN_MAX_EMPTY_PCT)) {
          row.outcome = `room moved too far to line up (${al.emptyPct}% empty edge)`;
          log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
          continue;
        }
        answer = al.aligned;
        row.linedUp = true;
      }
      const framing = await checkFraming(photoJpeg, answer, dilate(mask, w, h, Math.round(w * (ringFrom + RING_OUTER))), w, h);
      row.framing = framing;
      if (framing.framingChanged) {
        row.outcome = `room reshaped (median ${framing.medianDiff})`;
        log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
        continue;
      }
      const lined = lineUpAroundArea(photoRaw, await sharp(answer).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(), mask, w, h, ringFrom);
      row.localShiftPx = [lined.dx, lined.dy];
      const answerRaw = lined.shifted;
      if (params.onAnswer) {
        try { params.onAnswer(attempt, await sharp(answerRaw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()); } catch {}
      }
      const chk = checkWholeImageAnswer(photoRaw, answerRaw, mask, w, h, { ringFrom });
      row.check = chk;
      if (!chk.ok) {
        row.outcome = chk.why;
        log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`, chk);
        continue;
      }
      let pasteArea: Uint8Array = mask;
      if (mode !== "Remove") {
        const np = findNewPiece(photoRaw, answerRaw, mask, chk.gains, w, h);
        row.newPiece = { pctOfImage: np.pctOfImage, insideShare: np.insideShare, edgeShare: np.edgeShare };
        if (np.insideShare < MIN_INSIDE_SHARE || np.edgeShare > SPILL_MAX_EDGE) {
          row.outcome = np.insideShare < MIN_INSIDE_SHARE
            ? `the new piece is mostly outside the marked area (${Math.round(np.insideShare * 100)}% inside)`
            : `the new piece runs far past the marked area (${Math.round(np.edgeShare * 100)}% of the reach band's edge)`;
          log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
          fitInside = true;
          continue;
        }
        pasteArea = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) pasteArea[i] = mask[i] | np.piece[i];
        // The room right around the piece as drawn must be unchanged.
        const near = checkWholeImageAnswer(photoRaw, answerRaw, pasteArea, w, h);
        row.nearCheck = { ringChangedShare: near.ringChangedShare };
        if (near.ringChangedShare > RING_MAX_CHANGED) {
          row.outcome = `${Math.round(near.ringChangedShare * 100)}% of the room around the new piece changed`;
          log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
          continue;
        }
      }
      const image = await pasteMarkedArea(photoRaw, answerRaw, pasteArea, chk.gains, w, h);
      row.outcome = "pasted";
      log(`[editWholeImage] attempt ${attempt}: pasted (surroundings changed ${Math.round(chk.ringChangedShare * 100)}%, inside diff ${chk.insideMeanDiff})`, row);
      return { image, attempts: attempt, report };
    } catch (e: any) {
      row.outcome = `error: ${String(e?.message || e).slice(0, 200)}`;
      log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
    }
  }
  const err: any = new Error(`Whole-image ${mode} failed after ${MAX_ATTEMPTS} attempts: ${report.map((r) => r.outcome).join("; ")}`);
  err.report = report;
  throw err;
}
