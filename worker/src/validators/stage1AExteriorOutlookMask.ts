// Stage 1A "Enhance Exterior Outlook" — the exact outline of the outside view.
//
// The survey's boxes are straight-sided, but a window seen at an angle is a
// slanted shape, and Gemini's boxes run a few percent past the glass. So the
// boxes took in wedges of wall, frame, sill and floor, and the code lifted
// those too (Oct 2026: brightened wall patches beside kitchen and bedroom
// windows, a strip of floor below a sliding door).
//
// Same method as Stage 2's furniture tracing: Gemini's image model paints the
// glass that shows the outside white and everything else black, on the very
// image that gets adjusted (the Stage 1A result). The answer is checked like a
// furniture trace (a photo instead of a mask is rejected, specks removed) and
// kept only near the survey's views, so stray white elsewhere can't be lifted.
// Anything doubtful returns null and the caller falls back to the boxes.
//
// One image call, only for photos the survey found eligible.
// STAGE1A_OUTLOOK_MASK=off turns it off (boxes only).
import sharp from "sharp";
import { closestGeminiAspectRatio } from "../ai/gemini";
import {
  callGeminiImage,
  imagePart,
  binarizeTraceResponse,
  removeSmallComponents,
  labelComponents,
  dilate,
  approxOutputCost,
  TRACE_MODEL,
} from "../pipeline/stage2Masked/core";
import type { OutlookView } from "./stage1AExteriorOutlookSurvey";

export function outlookMaskEnabled(): boolean {
  return String(process.env.STAGE1A_OUTLOOK_MASK || "on").trim().toLowerCase() !== "off";
}

const OUTLOOK_MASK_MODEL = process.env.STAGE1A_OUTLOOK_MASK_MODEL || TRACE_MODEL;
const OUTLOOK_MASK_IMAGE_SIZE = (process.env.STAGE1A_OUTLOOK_MASK_IMAGE_SIZE || "1K").toUpperCase();
// White parts must sit within this distance of a surveyed view (share of the width).
const NEAR_VIEW_FRAC = 0.03;
// Sanity limits against the survey's boxes (which are already generous).
const MIN_COVER_OF_BOXES = 0.15; // the outline must fill at least this share of the boxes
const MAX_OF_BOXES = 1.6;        // and be no bigger than this many times their area

export function buildOutlookMaskPrompt(): string {
  return [
    "Generate a binary mask IMAGE of this interior photograph.",
    "Output the mask as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Mask rule: WHITE = the glass of windows and glass doors where the OUTSIDE can be seen through it (sky, trees, garden, lawn, fences, buildings, street). BLACK = everything else.",
    "",
    "Rules:",
    "- Trace each pane of glass tightly along the inner edge of its frame, following the exact shape and perspective of the glass (a window seen at an angle is a slanted shape, not a rectangle)",
    "- BLACK: window frames, mullions, sashes, sills, door tracks and handles",
    "- BLACK: the walls around the windows, the ceiling, and the floor inside the room (including the floor in front of a glass door)",
    "- BLACK: blinds, curtains, sheer curtains, curtain rods, light fittings, furniture, and anything inside the room seen in front of the glass",
    "- BLACK: glass covered by a blind or curtain, frosted glass, mirrors, artwork and screens",
    "- If no window or glass door shows the outside, return a completely black image",
    "- Output ONLY the mask — do NOT return the photograph",
    "- Match the perspective and dimensions of the input image",
  ].join("\n");
}

export type OutlookMaskResult = {
  mask: Uint8Array | null; // 0/1 at the image's size, or null = use the boxes
  reason: string;
  stats: { maskPctOfImage?: number; boxesPctOfImage?: number; coverOfBoxes?: number; droppedPct?: number; midtonePct?: number; inverted?: boolean; costUsd?: number | null };
};

/** Pure part: turns a binarized trace into the outlook mask, or rejects it. */
export function refineOutlookMask(raw: Uint8Array, views: OutlookView[], W: number, H: number): OutlookMaskResult {
  const boxes = new Uint8Array(W * H);
  for (const v of views) {
    const x1 = Math.max(0, Math.floor(v.box[0] * W)), y1 = Math.max(0, Math.floor(v.box[1] * H));
    const x2 = Math.min(W - 1, Math.ceil(v.box[2] * W)), y2 = Math.min(H - 1, Math.ceil(v.box[3] * H));
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) boxes[y * W + x] = 1;
  }
  const near = dilate(boxes, W, H, Math.max(2, Math.round(W * NEAR_VIEW_FRAC)));
  const clean = removeSmallComponents(raw, W, H, Math.max(16, Math.round(W * H * 0.0004)));
  // Keep whole pieces that touch a surveyed view; drop the rest.
  const mask = new Uint8Array(W * H);
  let kept = 0, total = 0;
  for (const piece of labelComponents(clean, W, H)) {
    total += piece.pixels.length;
    if (!piece.pixels.some((i) => near[i])) continue;
    for (const i of piece.pixels) if (near[i]) { mask[i] = 1; kept++; }
  }
  let boxArea = 0, inBoxes = 0;
  for (let i = 0; i < W * H; i++) { if (boxes[i]) { boxArea++; if (mask[i]) inBoxes++; } }
  const stats = {
    maskPctOfImage: +((kept / (W * H)) * 100).toFixed(2),
    boxesPctOfImage: +((boxArea / (W * H)) * 100).toFixed(2),
    coverOfBoxes: boxArea ? +(inBoxes / boxArea).toFixed(2) : 0,
    droppedPct: total ? +(((total - kept) / (W * H)) * 100).toFixed(2) : 0,
  };
  if (!kept) return { mask: null, reason: "outline found no glass near the views", stats };
  if (stats.coverOfBoxes < MIN_COVER_OF_BOXES) return { mask: null, reason: `outline covers only ${Math.round(stats.coverOfBoxes * 100)}% of the views`, stats };
  if (kept > boxArea * MAX_OF_BOXES) return { mask: null, reason: "outline much bigger than the views", stats };
  return { mask, reason: "ok", stats };
}

/** One Gemini image call on the image to be adjusted; null mask = fall back to the boxes. */
export async function traceOutlookMask(image: Buffer, views: OutlookView[]): Promise<OutlookMaskResult> {
  if (!views.length) return { mask: null, reason: "no views", stats: {} };
  const meta = await sharp(image).metadata();
  const W = meta.width || 0, H = meta.height || 0;
  if (!W || !H) return { mask: null, reason: "unreadable image", stats: {} };
  const jpeg = await sharp(image).removeAlpha().jpeg({ quality: 90 }).toBuffer();
  const res = await callGeminiImage({
    model: OUTLOOK_MASK_MODEL,
    parts: [{ text: buildOutlookMaskPrompt() }, imagePart(jpeg, "image/jpeg")],
    imageSize: OUTLOOK_MASK_IMAGE_SIZE,
    aspectRatio: closestGeminiAspectRatio(W, H),
  });
  const costUsd = approxOutputCost(res.usage);
  const bin = await binarizeTraceResponse(res.image, W, H);
  if (bin.invalid) return { mask: null, reason: `answer was a photo, not a mask (${bin.midtonePct}% mid-tones)`, stats: { midtonePct: bin.midtonePct, costUsd } };
  const out = refineOutlookMask(bin.mask, views, W, H);
  return { ...out, stats: { ...out.stats, midtonePct: bin.midtonePct, inverted: bin.inverted, costUsd } };
}
