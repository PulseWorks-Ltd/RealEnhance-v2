// Remove edits on the WHOLE photo (Oct 2026).
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
//  - nothing changed inside the area (the item wasn't removed).
// Two attempts; if both fail the edit fails (nothing published, refunded).
//
// One Gemini image call per attempt; the checks and paste are code only.
// EDIT_REMOVE_WHOLE_IMAGE=off goes back to the region edit.
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
  REALIGN_MAX_EMPTY_PCT,
} from "./stage2Masked/core";

export function wholeImageRemoveEnabled(): boolean {
  return String(process.env.EDIT_REMOVE_WHOLE_IMAGE ?? "on").trim().toLowerCase() !== "off";
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

export function buildWholeImageRemovePrompt(instruction: string): string {
  return [
    "You are given two images of the same real-estate photo.",
    "IMAGE 1 is the photo. IMAGE 2 is the same photo with one area marked in red.",
    "",
    "Return IMAGE 1 exactly as it is — the same camera position, framing, image size, lighting, colours and every detail — with ONE change:",
    "remove the item inside the red-marked area, and fill that area with what is naturally behind it: continue the wall, ceiling, floor, skirting board, window, door or whatever surrounds it, matching its colour, texture, lighting and shadows exactly.",
    "",
    "Rules:",
    "- Change nothing outside the red-marked area.",
    "- Do not add any new object, decoration or furniture.",
    "- Do not draw any red, outline or marking in your answer.",
    "- Do not zoom, crop, straighten, re-light or re-colour the photo.",
    "- Return the whole photo, not a close-up of the area.",
    "",
    `The user's request: "${instruction.replace(/"/g, "'").slice(0, 300)}"`,
  ].join("\n");
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
export function checkWholeImageAnswer(o: Buffer, g: Buffer, mask: Uint8Array, w: number, h: number): WholeImageCheck {
  const inner = dilate(mask, w, h, Math.max(2, Math.round(w * RING_INNER)));
  const outer = dilate(mask, w, h, Math.max(4, Math.round(w * RING_OUTER)));
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
    return { ok: false, why: "nothing changed inside the marked area (item not removed)", ringChangedShare: r(ringChangedShare), insideMeanDiff: r(insideMeanDiff, 1), gains: gains.map((v) => r(v)) };
  }
  return { ok: true, ringChangedShare: r(ringChangedShare), insideMeanDiff: r(insideMeanDiff, 1), gains: gains.map((v) => r(v)) };
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
export function lineUpAroundArea(o: Buffer, g: Buffer, mask: Uint8Array, w: number, h: number): { shifted: Buffer; dx: number; dy: number } {
  const inner = dilate(mask, w, h, Math.max(2, Math.round(w * RING_INNER)));
  const outer = dilate(mask, w, h, Math.max(4, Math.round(w * RING_OUTER)));
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

/**
 * mask: 0/1 at the photo's size (the user's marked area, after the usual
 * object refinement). Throws when no attempt passes.
 */
export async function wholeImageRemove(params: {
  photoPath: string;
  mask: Uint8Array;
  instruction: string;
  jobId?: string;
  log?: (msg: string, data?: any) => void;
}): Promise<WholeImageRemoveResult> {
  const log = params.log || ((m: string, d?: any) => console.log(m, d ?? ""));
  const meta = await sharp(params.photoPath).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  if (!w || !h) throw new Error("whole-image remove: unreadable photo");
  const { mask } = params;
  let maskPx = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) maskPx++;
  if (!maskPx) throw new Error("whole-image remove: empty mask");
  const photoJpeg = await sharp(params.photoPath).removeAlpha().jpeg({ quality: 92 }).toBuffer();
  const photoRaw = await sharp(params.photoPath).removeAlpha().raw().toBuffer();
  const marked = await markedCopy(photoJpeg, mask, w, h);
  const aspectRatio = closestGeminiAspectRatio(w, h);
  const report: any[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const row: any = { attempt, model: MODEL, imageSize: IMAGE_SIZE, aspectRatio };
    report.push(row);
    try {
      const res = await callGeminiImage({
        model: MODEL,
        imageSize: IMAGE_SIZE,
        aspectRatio,
        parts: [
          { text: buildWholeImageRemovePrompt(params.instruction) },
          { text: "IMAGE 1 (the photo):" }, imagePart(photoJpeg, "image/jpeg"),
          { text: "IMAGE 2 (the area to remove, marked in red):" }, imagePart(marked, "image/jpeg"),
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
      const framing = await checkFraming(photoJpeg, answer, dilate(mask, w, h, Math.round(w * RING_OUTER)), w, h);
      row.framing = framing;
      if (framing.framingChanged) {
        row.outcome = `room reshaped (median ${framing.medianDiff})`;
        log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
        continue;
      }
      const lined = lineUpAroundArea(photoRaw, await sharp(answer).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(), mask, w, h);
      row.localShiftPx = [lined.dx, lined.dy];
      const answerRaw = lined.shifted;
      const chk = checkWholeImageAnswer(photoRaw, answerRaw, mask, w, h);
      row.check = chk;
      if (!chk.ok) {
        row.outcome = chk.why;
        log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`, chk);
        continue;
      }
      const image = await pasteMarkedArea(photoRaw, answerRaw, mask, chk.gains, w, h);
      row.outcome = "pasted";
      log(`[editWholeImage] attempt ${attempt}: pasted (surroundings changed ${Math.round(chk.ringChangedShare * 100)}%, inside diff ${chk.insideMeanDiff})`, row);
      return { image, attempts: attempt, report };
    } catch (e: any) {
      row.outcome = `error: ${String(e?.message || e).slice(0, 200)}`;
      log(`[editWholeImage] attempt ${attempt}: ${row.outcome}`);
    }
  }
  const err: any = new Error(`Whole-image remove failed after ${MAX_ATTEMPTS} attempts: ${report.map((r) => r.outcome).join("; ")}`);
  err.report = report;
  throw err;
}
