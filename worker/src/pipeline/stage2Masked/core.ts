// Stage 2 "masked" staging — shared core.
//
// Stage, trace, paste back, harmonise: Gemini stages the room, the furniture it
// added is traced and pasted onto the real photo (so the room's structure can
// never change), Gemini then blends shadows/lighting, and the blend is
// checked patch by patch before use. Used by the app (pipeline/stage2Masked)
// and by scripts/stage2-mask-pasteback-test.ts, so tests and the app run the
// same code.
//
// Settings are read from environment variables when this module loads.

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { generateContentViaRest } from "../../ai/geminiRestClient";
import { realFloorLine } from "./floorLine";
export { realFloorLine };
import { callValidatorModel } from "../../validators/validatorModelCall";
import { runWithForcedValidatorModel } from "../../validators/occlusionVsRemovalCheck";

// Binary masks: one byte per pixel (0/1), row-major.
export type Mask = Uint8Array<ArrayBuffer>;

export const TRACE_MODEL = process.env.STAGE2_TRACE_MODEL || process.env.TRACE_MODEL || "gemini-3.1-flash-image";
export const TRACE_IMAGE_SIZE = (process.env.TRACE_IMAGE_SIZE || "1K").toUpperCase();
// Wall art is traced in its own pass and kept only where it is safe (see
// evaluateWallArt): on plain wall, with the wall around it unchanged. Art is
// where a removed fireplace or a new opening hides, so it is never kept
// blindly. TRACE_ARTWORK=0 leaves art out entirely.
export const TRACE_ARTWORK = process.env.TRACE_ARTWORK !== "0";
// Reflections of the added furniture in mirrors (mirrored wardrobe doors, wall
// mirrors, glass) are traced in their own pass and carried over like the
// furniture — otherwise paste-back removes them as "changed pixels", leaving a
// mirror that doesn't reflect the bed or bedside table next to it.
// TRACE_REFLECTIONS=0 leaves them out.
export const TRACE_REFLECTIONS = process.env.TRACE_REFLECTIONS !== "0";
// Layered merge settings.
// - Solid layer (furniture + kept art): staged pixels, with only a thin margin.
// - Shadow zone around floor furniture: only the DARKENING from the staged
//   image is transferred onto the original photo, and only where it looks like
//   a real shadow, so walls/doors/frames there always stay original.
export const SOLID_GROW_PCT = Number(process.env.SOLID_GROW_PCT || 0.25); // % of width
// Only the CORE of each piece of furniture (the traced shape shrunk by this
// much) is always taken from the staged image. In its thin outer band the
// staged pixel is used unless it is essentially identical to the original
// (trace overshoot onto unchanged wall/floor), in which case the original is
// kept. Shadows are only judged OUTSIDE the traced shape.
export const CORE_ERODE_PCT = Number(process.env.CORE_ERODE_PCT || 0.6); // % of width
export const ZONE_GROW_PCT = Number(process.env.ZONE_GROW_PCT || 2); // % of width, all round
export const ZONE_DOWN_PCT = Number(process.env.ZONE_DOWN_PCT || 4); // % of height, extra downwards
export const FEATHER_PX = Number(process.env.FEATHER_PX || 1.5); // at the 2K output size
export const HARMONISE_MODEL = process.env.HARMONISE_MODEL || "gemini-3.1-flash-image";
export const HARMONISE_IMAGE_SIZE = (process.env.HARMONISE_IMAGE_SIZE || "2K").toUpperCase();
// Where Gemini's shadows may be used: around the furniture (% of width) and
// extra downwards (% of height). Darkening is never stronger than MAX_SHADOW.
export const HARM_ZONE_GROW_PCT = Number(process.env.HARM_ZONE_GROW_PCT || 8);
export const HARM_ZONE_DOWN_PCT = Number(process.env.HARM_ZONE_DOWN_PCT || 10);
export const HARM_MAX_SHADOW = Number(process.env.HARM_MAX_SHADOW || 0.65);
// Wall-art safety checks, calibrated on the failed-pair and fresh-staging test
// images: bare wall scores 0 on the busiest patch, while windows, doors, a
// fireplace corbel, switches/power points and wall corners score 33-96; the
// wall around good art differs by ~17, around art on a removed wall by ~78.
export const ART_MAX_BUSY_PATCH = 20; // % strong-edge pixels in the busiest small patch underneath
export const ART_MAX_EDGE_PCT = 5; // % strong-edge pixels under the whole artwork
export const ART_MAX_WALL_STD = 25; // brightness variation underneath (plain wall is low)
export const ART_MAX_RING_DIFF = 30; // how much the wall around the art changed in staging
// Same "changed pixel" threshold as the outside-mask drift check on feature/vertex-mask-inpainting.
export const CHANGE_THRESHOLD = 18;
// Framing check. A wall/ceiling patch counts as changed above CHANGED_TILE_DIFF
// (average grey-level difference). The photo is flagged as reframed when the
// MEDIAN patch is above REFRAMED_MEDIAN_DIFF — a median ignores a few locally
// changed spots (a removed window) but not a moved/reshaped room. Calibrated
// on Test Images/Stage2_2K_Comparison: the two reframed results scored 28.9
// and 30.9, the ten good ones 10.2 or lower. Re-checked after fixing the mask
// read (furniture tiles are now properly skipped): reshaped Bedroom12 scores
// 20, the five good photos in Stage2_MaskPasteback 6.4 or lower.
export const CHANGED_TILE_DIFF = 12;
export const REFRAMED_MEDIAN_DIFF = Number(process.env.REFRAMED_MEDIAN_DIFF || 15);
// Gemini 3.1 Flash Image output tokens, USD per 1M (Google pricing page, Oct 2026).
export const OUTPUT_PRICE_PER_M = Number(process.env.OUTPUT_PRICE_PER_M || 60);
// Floor-furniture targets match the continuity branch's two extractor passes;
// wall art has its own pass so it can be checked separately.
export type TraceKind = "floor" | "wall_art" | "reflection" | "appliance";
// Kitchens only: freestanding appliances (a fridge in an empty fridge space).
// Kept only if they stand inside an EMPTY appliance space in the empty room —
// a fridge that replaced pantry doors is a change to the cabinetry and goes.
export const TRACE_APPLIANCES = process.env.TRACE_APPLIANCES !== "0";
export const APPLIANCE_PASS = { label: "appliances", kind: "appliance" as TraceKind, targets: "freestanding appliances added by staging" };
export function tracePassesFor(roomType: string) {
  return TRACE_APPLIANCES && /kitchen/i.test(roomType) ? [...TRACE_PASSES, APPLIANCE_PASS] : TRACE_PASSES;
}
export const TRACE_PASSES: Array<{ label: string; kind: TraceKind; targets: string }> = [
  { label: "primary", kind: "floor", targets: "beds, sofas, dining tables, major rugs, major seating" },
  { label: "secondary", kind: "floor", targets: "lamps, bedside tables, chairs, decor on furniture, plants, secondary furniture, and loose items placed on kitchen benches, islands, shelves and window sills (fruit bowls, plants, kettles, toasters, coffee machines, knife blocks, chopping boards, vases, books)" },
  ...(TRACE_ARTWORK
    ? [{ label: "wall_art", kind: "wall_art" as TraceKind, targets: "framed artwork, prints, paintings, canvases and mirrors hung on walls" }]
    : []),
  ...(TRACE_REFLECTIONS
    ? [{ label: "reflections", kind: "reflection" as TraceKind, targets: "reflections of the added furniture and decor in mirrors, mirrored wardrobe doors, glass and glossy surfaces" }]
    : []),
];


// ── Gemini tracing call ──────────────────────────────────────────────────────

export function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export function imagePart(buffer: Buffer, mimeType: string) {
  return { inlineData: { mimeType, data: buffer.toString("base64") } };
}

export async function callGeminiImage(params: {
  model: string;
  parts: any[];
  imageSize: string;
  aspectRatio: string;
}): Promise<{ image: Buffer; usage: any; text: string }> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.REALENHANCE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const resp = await generateContentViaRest({
    apiKey,
    model: params.model,
    timeoutMs: 180000,
    body: {
      contents: [{ role: "user", parts: params.parts }],
      generationConfig: {
        temperature: 0,
        topP: 0.1,
        imageConfig: { imageSize: params.imageSize, aspectRatio: params.aspectRatio },
      },
    },
  });
  const parts: any[] = resp?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p?.inlineData?.data);
  const text = parts.filter((p) => typeof p?.text === "string").map((p) => p.text).join(" ").trim();
  if (!img) {
    const reason = resp?.candidates?.[0]?.finishReason || resp?.promptFeedback?.blockReason || "no image returned";
    throw new Error(`${params.model} returned no image (${reason})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return { image: Buffer.from(img.inlineData.data, "base64"), usage: resp?.usageMetadata || null, text };
}

// Adapted from the continuity branch's buildOriginalExtractorPassPrompt: same
// structure and rules, but both images share one camera position, and changes
// to the room itself are explicitly excluded from the mask.
export function buildReflectionPrompt(roomType: string): string {
  return [
    "Generate a binary mask IMAGE.",
    "Output the mask as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Mask rule: WHITE = reflections of the ADDED furniture and decor, BLACK = everything else.",
    "",
    "You are given two images of the same room from the same camera position:",
    "1. STAGED_IMAGE — the room after virtual staging, with furniture added.",
    "2. EMPTY_IMAGE — the same room before staging.",
    "",
    "Task: in the STAGED_IMAGE, mark ONLY the reflections of the newly added furniture and decor",
    "that appear in mirrors, mirrored wardrobe or closet doors, glass, or other reflective surfaces.",
    "Rules:",
    "- Mark the reflected image of the added items only (for example a bedside table or lamp seen in a mirror) — white",
    "- Do NOT mark the furniture itself, only its reflection — black",
    "- Do NOT mark mirror frames, door tracks, or anything the mirror also shows in the EMPTY_IMAGE (reflected walls, windows, doors, ceiling, floor) — black",
    "- Do NOT mark windows, doors, openings, walls or fixtures — black",
    "- If there are no mirrors or no reflections of added items, return a completely black image",
    "- Match the perspective and dimensions of the STAGED_IMAGE",
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Mirrors in the EMPTY room. Only asked for when the reflection pass found
// something. The empty photo is the real room, so this can't be fooled by a
// staging mistake: a "reflection" outside a real mirror is rejected.
export function buildMirrorPrompt(roomType: string): string {
  return [
    "Generate a binary mask IMAGE of this photograph of an empty room.",
    "Output the mask as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Mask rule: WHITE = mirror surfaces, BLACK = everything else.",
    "- Mark mirrors: wall mirrors, mirrored wardrobe or closet doors, mirrored splashbacks — the reflective glass area only",
    "- Do NOT mark windows, glass doors to the outside, frames, walls, floor, ceiling or anything else — black",
    "- If there are no mirrors, return a completely black image",
    "- Keep exactly the same framing and dimensions as the photograph",
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Decides, piece by piece, whether a traced reflection is safe to carry over.
// A real reflection is small, separate from the furniture itself, and the
// mirror around it still shows the same room as before (only the reflected
// item is new). A "reflection" that is really a new doorway or a removed wall
// fails the last check, because the area around it changed too.
export async function evaluateReflections(
  original: Buffer,
  staged: Buffer,
  reflMask: Uint8Array,
  floorMask: Uint8Array,
  w: number,
  h: number,
  mirrorMask: Uint8Array | null,
  // Shared with appliances: the same checks against a different "space".
  opts: { what: string; space: string; maxAreaPct: number } = { what: "reflection", space: "a mirror", maxAreaPct: 6 }
) {
  const mirrorNear = mirrorMask ? dilate(mirrorMask, w, h, Math.max(1, Math.round(w * 0.01))) : null;
  const A = 640;
  const AH = Math.max(1, Math.round((A * h) / w));
  const [oRgb, sRgb] = await Promise.all([
    sharp(original).removeAlpha().resize(A, AH, { fit: "fill" }).blur(1.5).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(A, AH, { fit: "fill" }).blur(1.5).raw().toBuffer(),
  ]);
  const keep = new Uint8Array(w * h);
  const dropped = new Uint8Array(w * h);
  const itself = new Uint8Array(w * h);
  const minArea = Math.max(64, Math.round(w * h * 0.0005));
  const report: any[] = [];
  for (const piece of labelComponents(reflMask, w, h)) {
    if (piece.pixels.length < minArea) continue;
    let onFurniture = 0, inMirror = 0;
    for (const i of piece.pixels) {
      onFurniture += floorMask[i];
      if (mirrorNear) inMirror += mirrorNear[i];
    }
    const sx = A / w, sy = AH / h;
    const x1 = Math.max(0, Math.floor(piece.x1 * sx)), x2 = Math.min(A - 1, Math.ceil(piece.x2 * sx));
    const y1 = Math.max(0, Math.floor(piece.y1 * sy)), y2 = Math.min(AH - 1, Math.ceil(piece.y2 * sy));
    const pad = Math.round(A * 0.02);
    let rn = 0, rd = 0;
    for (let y = Math.max(0, y1 - pad); y <= Math.min(AH - 1, y2 + pad); y++) for (let x = Math.max(0, x1 - pad); x <= Math.min(A - 1, x2 + pad); x++) {
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) continue;
      const i = (y * A + x) * 3;
      rd += (Math.abs(oRgb[i] - sRgb[i]) + Math.abs(oRgb[i + 1] - sRgb[i + 1]) + Math.abs(oRgb[i + 2] - sRgb[i + 2])) / 3;
      rn++;
    }
    const stats = {
      areaPct: +((piece.pixels.length / (w * h)) * 100).toFixed(2),
      onFurniturePct: Math.round((onFurniture / piece.pixels.length) * 100),
      inMirrorPct: Math.round((inMirror / piece.pixels.length) * 100),
      ringDiff: +(rd / Math.max(1, rn)).toFixed(1),
    };
    let reason: string | null = null;
    const itselfReason = `is the furniture itself, not a ${opts.what}`;
    if (stats.onFurniturePct > 50) reason = itselfReason;
    else if (stats.inMirrorPct < 80) reason = `not inside ${opts.space} in the empty room`;
    else if (stats.areaPct > opts.maxAreaPct) reason = `too large to be a ${opts.what}`;
    else if (stats.ringDiff > ART_MAX_RING_DIFF) reason = "the area around it changed in staging";
    const target = reason === itselfReason ? itself : reason ? dropped : keep;
    for (const i of piece.pixels) target[i] = 1;
    report.push({ ...stats, kept: !reason, reason: reason || `${opts.what}, surroundings unchanged` });
  }
  return { keep, dropped, itself, report };
}

export function buildAppliancePrompt(roomType: string): string {
  return [
    "Generate a binary mask IMAGE.",
    "Output the mask as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Mask rule: WHITE = freestanding appliances ADDED by staging, BLACK = everything else.",
    "",
    "You are given two images of the same room from the same camera position:",
    "1. STAGED_IMAGE — the room after virtual staging.",
    "2. EMPTY_IMAGE — the same room before staging.",
    "",
    "Task: in the STAGED_IMAGE, mark ONLY freestanding appliances that are not in the EMPTY_IMAGE: fridges, freezers, wine fridges, washing machines, dryers.",
    "Rules:",
    "- Mark the whole appliance, white",
    "- Do NOT mark cabinetry, cupboard or pantry doors, benches, ovens, cooktops, rangehoods, dishwashers or anything built in — black",
    "- Do NOT mark appliances that are already in the EMPTY_IMAGE — black",
    "- Do NOT mark furniture, decor or small benchtop items — black",
    "- If no freestanding appliance was added, return a completely black image",
    "- Match the perspective and dimensions of the STAGED_IMAGE",
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Empty appliance spaces in the EMPTY room (only asked for when an appliance
// was traced): the real room decides where an appliance may stand.
export function buildApplianceSpacePrompt(roomType: string): string {
  return [
    "Generate a binary mask IMAGE of this photograph of an empty room.",
    "Output the mask as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Mask rule: WHITE = empty appliance spaces, BLACK = everything else.",
    "- Mark open, empty spaces built to take a freestanding appliance: an empty fridge space or recess in the cabinetry, an empty laundry space for a washing machine or dryer — the open space itself, from the floor to the top of the opening",
    "- Do NOT mark cupboard doors, pantry doors, drawers, closed cabinetry, benches, walls, windows or doors — black",
    "- If there is no empty appliance space, return a completely black image",
    "- Keep exactly the same framing and dimensions as the photograph",
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

export function buildTracePrompt(roomType: string, targets: string, kind: TraceKind = "floor", tight = true): string {
  if (kind === "reflection") return buildReflectionPrompt(roomType);
  if (kind === "appliance") return buildAppliancePrompt(roomType);
  const kindRules =
    kind === "wall_art"
      ? ["- Mark ONLY items hung on walls. Do NOT mark furniture, lamps, plants, rugs, TVs, shelves, curtains, blinds or light fittings — they stay black"]
      : [
          "- Do NOT mark anything hung on or attached to walls (artwork, mirrors, shelves, TVs) — it stays black",
          "- Furniture standing ON a rug is white too — never leave a coffee table, chair or other item black where it sits on a rug",
          "- Loose items placed ON benches, islands, shelves or window sills (a kettle, fruit bowl or plant on a kitchen bench) ARE added decor: mark them white, even though the bench or shelf itself stays black",
          "- Do NOT mark freestanding appliances (fridges, washing machines) — they stay black",
        ];
  return [
    "Generate a binary furniture mask IMAGE.",
    "Output the mask as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Mask rule: WHITE = pixels showing the added furniture in the STAGED_IMAGE, BLACK = everything else.",
    "",
    "You are given two images of the same room from the same camera position:",
    "1. STAGED_IMAGE — the room after virtual staging, with furniture added.",
    "2. EMPTY_IMAGE — the same room before staging.",
    "",
    "Task: mark where the added furniture appears in the STAGED_IMAGE.",
    "Generate a single black-and-white mask image that:",
    `- Targets these object types: ${targets}`,
    "- Matches the perspective and dimensions of the STAGED_IMAGE",
    "- Shows WHITE where those furniture objects appear",
    "- Shows BLACK everywhere else (walls, ceiling, floor outside furniture areas, windows, doors)",
    "",
    "Critical rules:",
    "- Output ONLY the binary mask — do NOT return the staged image or the empty image",
    kind === "wall_art"
      ? "- Mark the full outline of each hung item, including its frame, as white"
      : tight
      ? "- Trace each furniture object tightly along its own visible edges, including rugs on the floor"
      : "- Mark the furniture silhouette and footprint regions as white, including rugs on the floor",
    ...(tight ? ["- Do NOT include shadows the objects cast on the floor or walls — shadows stay black"] : []),
    "- Do NOT mark changes to the room itself, even if the two images differ there: windows, doors, openings, walls, ceilings, light fittings, curtains, blinds and built-in fixtures stay black",
    ...kindRules,
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Turns Gemini's mask image into a 0/1 mask at the original photo size.
// Transparent pixels count as black; if most of the frame comes back white the
// model has flipped the colours, so it is inverted (the continuity branch
// handled the same polarity problem).
// A trace must come back as a black-and-white mask. Gemini sometimes returns
// a darkened copy of the photo instead (Kitchen 01, 2026-10-12: the
// appliance trace was the room itself; its brighter parts — sofa, lamp,
// table — were read as "appliances" and then removed from the furniture,
// leaving a see-through sofa). Masks are almost all pure black or white
// (only edges are grey); a photo has lots of mid-tones. Such a response is
// rejected and treated as an empty trace.
export const TRACE_MAX_MIDTONE_PCT = Number(process.env.TRACE_MAX_MIDTONE_PCT || 20);
export async function binarizeTraceResponse(image: Buffer, w: number, h: number) {
  const gray = await sharp(image)
    .flatten({ background: "#000000" })
    .resize(w, h, { fit: "fill", kernel: sharp.kernel.nearest })
    .grayscale()
    .raw()
    .toBuffer();
  let mid = 0;
  for (let i = 0; i < w * h; i++) if (gray[i] > 40 && gray[i] < 215) mid++;
  const midtonePct = Number(((mid / Math.max(1, w * h)) * 100).toFixed(1));
  if (midtonePct > TRACE_MAX_MIDTONE_PCT) {
    return { mask: new Uint8Array(w * h) as Mask, inverted: false, invalid: true, midtonePct };
  }
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] >= 128 ? 1 : 0;
  let inverted = false;
  if (ratioOf(mask) > 0.6) {
    mask = invert(mask);
    inverted = true;
  }
  return { mask, inverted, invalid: false, midtonePct };
}

// ── Mask helpers (binary masks: Uint8Array of 0/1, row-major) ────────────────

export function dilate(src: Uint8Array, w: number, h: number, r: number): Mask {
  if (r <= 0) return src.slice();
  const horiz = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[y * w + x];
    for (let x = 0; x < w; x++) {
      horiz[y * w + x] = pre[Math.min(w, x + r + 1)] - pre[Math.max(0, x - r)] > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + horiz[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = pre[Math.min(h, y + r + 1)] - pre[Math.max(0, y - r)] > 0 ? 1 : 0;
    }
  }
  return out;
}

export function invert(src: Uint8Array): Mask {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] ? 0 : 1;
  return out;
}

export function erode(src: Uint8Array, w: number, h: number, r: number): Mask {
  return invert(dilate(invert(src), w, h, r));
}

// Extends every masked pixel straight down by n pixels, so floor shadows
// cast below furniture land inside the editable area.
export function growDown(src: Uint8Array, w: number, h: number, n: number): Mask {
  const out = src.slice();
  for (let x = 0; x < w; x++) {
    let remaining = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (src[i]) remaining = n;
      else if (remaining > 0) {
        out[i] = 1;
        remaining--;
      }
    }
  }
  return out;
}

// Gemini traces outlines, but often leaves holes: a coffee table drawn black
// on top of a white rug, or the floor (and shadows) between table and chair
// legs. For each separate piece of furniture, fill every column from its top
// edge to its bottom edge. This only fills between parts of the same piece,
// so it cannot spread up onto walls, windows or doors above the furniture.
export function fillFurnitureColumns(src: Uint8Array, w: number, h: number): Mask {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const tops: Int32Array[] = [];
  const bottoms: Int32Array[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!src[start] || labels[start]) continue;
    const id = tops.length + 1;
    const top = new Int32Array(w).fill(-1);
    const bottom = new Int32Array(w).fill(-1);
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      if (top[x] === -1 || y < top[x]) top[x] = y;
      if (y > bottom[x]) bottom[x] = y;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const n of neighbours) {
        if (n < 0 || n >= w * h || labels[n] || !src[n]) continue;
        labels[n] = id;
        stack[sp++] = n;
      }
    }
    tops.push(top);
    bottoms.push(bottom);
  }
  const out = src.slice();
  for (let c = 0; c < tops.length; c++) {
    for (let x = 0; x < w; x++) {
      if (tops[c][x] < 0) continue;
      for (let y = tops[c][x]; y <= bottoms[c][x]; y++) out[y * w + x] = 1;
    }
  }
  return out;
}

// Floor pockets under a piece, between its legs: columns where the piece ends
// higher (a shelf or rail) than the legs on both sides of them. The column
// fill stops at the shelf, so the real floor was pasted back there, while
// Gemini drew the piece's shadow in that spot — a hard-edged rectangle of bare
// carpet under bedside tables (Oct 2026, production: Bedroom_09, Bedroom_16).
// A pocket is taken from Gemini's picture only when it is small and Gemini
// really drew something different there (else the real floor matches anyway).
export const LEG_POCKET_FILL = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_FILL_LEG_POCKETS || "").trim().toLowerCase());
const LEG_POCKET_MAX_PCT = 1.0;      // a pocket bigger than this (open space under a dining table) is left alone
const LEG_POCKET_MIN_MEAN_DIFF = 15; // average colour difference (0-255) between Gemini's and the real floor there

export async function findLegPockets(floor: Uint8Array, original: Buffer, staged: Buffer, w: number, h: number) {
  const cand = new Uint8Array(w * h);
  const drop = Math.max(3, Math.round(h * 0.006));
  for (const comp of labelComponents(floor, w, h)) {
    if (comp.pixels.length < w * h * 0.002) continue;
    const bottom = new Int32Array(w).fill(-1);
    for (const i of comp.pixels) { const x = i % w, y = (i - x) / w; if (y > bottom[x]) bottom[x] = y; }
    for (let x = comp.x1; x <= comp.x2; x++) {
      if (bottom[x] < 0) continue;
      let xl = -1, xr = -1;
      for (let k = x - 1; k >= comp.x1; k--) if (bottom[k] > bottom[x] + drop) { xl = k; break; }
      for (let k = x + 1; k <= comp.x2; k++) if (bottom[k] > bottom[x] + drop) { xr = k; break; }
      if (xl < 0 || xr < 0 || xr - xl > w * 0.3) continue;
      // down to the line joining the two leg bottoms (follows the perspective)
      const line = Math.round(bottom[xl] + ((bottom[xr] - bottom[xl]) * (x - xl)) / (xr - xl));
      for (let y = bottom[x] + 1; y <= line && y < h; y++) if (!floor[y * w + x]) cand[y * w + x] = 1;
    }
  }
  const [a, b] = await Promise.all([
    sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(),
  ]);
  const grey = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).greyscale().blur(1.2).raw().toBuffer();
  const fill = new Uint8Array(w * h);
  const pockets: Array<{ areaPct: number; meanDiff: number; floorStd: number; filled: boolean; box: number[] }> = [];
  for (const piece of labelComponents(cand, w, h)) {
    if (piece.pixels.length < w * h * 0.0002) continue;
    let d = 0;
    for (const i of piece.pixels) d += (Math.abs(a[i * 3] - b[i * 3]) + Math.abs(a[i * 3 + 1] - b[i * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[i * 3 + 2])) / 3;
    const areaPct = +((piece.pixels.length / (w * h)) * 100).toFixed(2);
    const meanDiff = +(d / piece.pixels.length).toFixed(1);
    // Only plain floor in the real photo: a rug edge, or the line where carpet
    // meets boards, inside the pocket means it is not just the space under a piece.
    const floorStd = greyStd(grey, piece.pixels);
    const filled = areaPct <= LEG_POCKET_MAX_PCT && meanDiff >= LEG_POCKET_MIN_MEAN_DIFF && floorStd <= PLAIN_FLOOR_MAX_STD;
    if (filled) for (const i of piece.pixels) fill[i] = 1;
    pockets.push({ areaPct, meanDiff, floorStd, filled, box: [+(piece.x1 / w).toFixed(2), +(piece.y1 / h).toFixed(2), +(piece.x2 / w).toFixed(2), +(piece.y2 / h).toFixed(2)] });
  }
  return { fill, pockets };
}

// Legs in the edge band. A leg near the traced outline sits in the band,
// where the matte decides by colour; a walnut chair leg over timber reads as
// floor and was swapped for the real floor (Oct 2026, production Kitchen_06).
// Shape tells them apart: a leg is a long, upright stripe darker than what is
// on both sides of it, while floorboards and carpet edges run across. Returns
// the leg pixels (inside the traced shape only) to treat as solid furniture.
export const BAND_LEG_KEEP = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_BAND_LEG_KEEP || "").trim().toLowerCase());
export async function findBandLegs(staged: Buffer, solid: Uint8Array, core: Uint8Array, w: number, h: number) {
  const lum = await sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).greyscale().blur(1.2).raw().toBuffer();
  const k = Math.max(3, Math.round(w * 0.006)); // look this far left and right (about a leg's width)
  const valley = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = k; x < w - k; x++) {
      const i = y * w + x;
      if (!solid[i] || core[i]) continue; // band only
      const v = lum[i];
      if (v + 14 < lum[i - k] && v + 14 < lum[i + k]) valley[i] = 1;
    }
  }
  // join the stripe vertically, then keep long upright pieces
  const joined = dilate(valley, w, h, 1);
  const out = new Uint8Array(w * h);
  let n = 0;
  for (const piece of labelComponents(joined, w, h)) {
    const pw = piece.x2 - piece.x1 + 1, ph = piece.y2 - piece.y1 + 1;
    if (ph < h * 0.03 || ph < 4 * pw) continue;
    // the stripe itself plus its own width, inside the traced shape
    for (const i of piece.pixels) {
      const x = i % w;
      for (let d = -Math.round(k / 2); d <= Math.round(k / 2); d++) {
        const j = i + d;
        if (x + d < 0 || x + d >= w || !solid[j]) continue;
        if (lum[j] <= lum[i] + 12 && !out[j]) { out[j] = 1; n++; }
      }
    }
  }
  return { legs: out, pctOfImage: +((n / (w * h)) * 100).toFixed(2) };
}

export function removeSmallComponents(src: Uint8Array, w: number, h: number, minArea: number): Mask {
  const out = src.slice();
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!out[start] || seen[start]) continue;
    let top = 0;
    const members: number[] = [];
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      members.push(i);
      const x = i % w;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const n of neighbours) {
        if (n < 0 || n >= w * h || seen[n] || !out[n]) continue;
        seen[n] = 1;
        stack[top++] = n;
      }
    }
    if (members.length < minArea) for (const i of members) out[i] = 0;
  }
  return out;
}

// Fills holes that are completely enclosed by the mask (a coffee table traced
// black on top of a white rug, the gap inside a chair outline), but only small
// ones, so a large area of room surrounded by furniture is never swallowed.
export function fillEnclosedHoles(src: Uint8Array, w: number, h: number, maxHoleArea: number): Mask {
  const out = src.slice();
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (src[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const members: number[] = [];
    let touchesBorder = false;
    while (sp > 0) {
      const i = stack[--sp];
      members.push(i);
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const n of neighbours) {
        if (n < 0 || n >= w * h || seen[n] || src[n]) continue;
        seen[n] = 1;
        stack[sp++] = n;
      }
    }
    if (!touchesBorder && members.length <= maxHoleArea) for (const i of members) out[i] = 1;
  }
  return out;
}

// A changed pixel that is just the original surface in shade: darker by a
// shadow's amount (not near-black, like a dark furniture leg on a light wall)
// with the same colour balance. Gemini darkens the carpet under and beside a
// bed; that is a shadow, not part of the bed the trace missed (Oct 2026,
// production marketing job: both attempts failed on a bed's carpet shadow).
function isShadowPixel(orig: Buffer, staged: Buffer, i: number): boolean {
  const r0 = orig[i * 3], g0 = orig[i * 3 + 1], b0 = orig[i * 3 + 2];
  const r1 = staged[i * 3], g1 = staged[i * 3 + 1], b1 = staged[i * 3 + 2];
  const s0 = r0 + g0 + b0, s1 = r1 + g1 + b1;
  if (s0 < 30 || s1 >= s0) return false;
  const ratio = s1 / s0;
  if (ratio < SHADOW_MIN_RATIO || ratio > 0.95) return false;
  const chroma = Math.max(Math.abs(r0 / s0 - r1 / s1), Math.abs(g0 / s0 - g1 / s1), Math.abs(b0 / s0 - b1 / s1));
  return chroma < 0.035;
}
const SHADOW_MIN_RATIO = 0.4;

// How much the REAL photo varies inside an area (brightness standard
// deviation, 0-255). Plain floor is low; a wall corner, skirting, a sun patch
// or a hearth is high. Gemini's pixels may only replace plain floor: on saved
// rooms, every wrong fill (a wall corner, a real sun patch, a fireplace hearth)
// measured 23+, every right one (shadows under beds and tables) 3-14.
export const PLAIN_FLOOR_MAX_STD = Number(process.env.STAGE2_PLAIN_FLOOR_MAX_STD || 20);
function greyStd(grey: Buffer, pixels: ArrayLike<number>): number {
  let sum = 0, sum2 = 0;
  for (let k = 0; k < pixels.length; k++) { const v = grey[pixels[k]]; sum += v; sum2 += v * v; }
  const n = Math.max(1, pixels.length), mean = sum / n;
  return +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1);
}

export async function fillChangedGaps(floor: Uint8Array, original: Buffer, staged: Buffer, w: number, h: number): Promise<Mask> {
  const out = fillEnclosedHoles(floor, w, h, Math.round(w * h * 0.02));
  const cols = fillFurnitureColumns(floor, w, h);
  const [a, b] = await Promise.all([
    sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).blur(2).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).blur(2).raw().toBuffer(),
  ]);
  const sums = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    if (cols[i]) continue;
    for (let c = 0; c < 3; c++) { sums[c] += a[i * 3 + c]; sums[c + 3] += b[i * 3 + c]; }
  }
  const gains = [0, 1, 2].map((c) => (sums[c + 3] > 0 ? sums[c] / sums[c + 3] : 1));
  // Staged brought to the original's lighting, globally and then area by
  // area (see matchLocalLighting): Gemini's relit wall beside a piece is not
  // a "change", only real new content is.
  const bAdj = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h * 3; i++) bAdj[i] = Math.min(255, Math.round(b[i] * gains[i % 3]));
  if (LOCAL_LIGHT_MATCH) {
    const furn = dilate(floor, w, h, Math.max(1, Math.round(w * 0.01)));
    const solidMask = Buffer.alloc(w * h, 0);
    for (let i = 0; i < w * h; i++) if (furn[i]) solidMask[i] = 255;
    await matchLocalLighting(a, bAdj, solidMask, Buffer.alloc(w * h, 0), w, h);
  }
  let added = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!cols[i] || out[i]) continue;
    const d = Math.max(Math.abs(a[i * 3] - bAdj[i * 3]), Math.abs(a[i * 3 + 1] - bAdj[i * 3 + 1]), Math.abs(a[i * 3 + 2] - bAdj[i * 3 + 2]));
    if (d > 35) added[i] = 1;
  }
  const r = Math.max(1, Math.round(w * 0.002));
  added = erode(dilate(added, w, h, r), w, h, r);
  added = removeSmallComponents(added, w, h, Math.round(w * h * 0.0005));
  for (let i = 0; i < w * h; i++) out[i] |= added[i] & cols[i];
  // Report only (not filled): changed areas next to traced furniture that
  // the trace left out. Filling them by rule isn't safe — the back of a
  // coffee table the trace missed and a door Gemini moved behind a bed both
  // touch the furniture on only part of their edge — so they are listed in
  // the results to show whether the tracing missed furniture.
  const changed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.max(Math.abs(a[i * 3] - bAdj[i * 3]), Math.abs(a[i * 3 + 1] - bAdj[i * 3 + 1]), Math.abs(a[i * 3 + 2] - bAdj[i * 3 + 2]));
    changed[i] = d > 35 ? 1 : 0;
  }
  const near = dilate(out, w, h, Math.round(w * 0.03));
  let cand = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) cand[i] = changed[i] && near[i] && !out[i] ? 1 : 0;
  cand = erode(dilate(cand, w, h, r), w, h, r);
  const missed: Array<{ areaPct: number; touchingFurniturePct: number; underFurniturePct: number; shadowPct: number; floorStd: number; box: number[] }> = [];
  const missedPixels: ArrayLike<number>[] = [];
  const grey = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).greyscale().blur(1.2).raw().toBuffer();
  for (const piece of labelComponents(cand, w, h)) {
    if (piece.pixels.length < w * h * 0.002) continue;
    let edge = 0, touching = 0, topEdge = 0, under = 0, shadow = 0;
    for (const i of piece.pixels) {
      if (isShadowPixel(a, bAdj, i)) shadow++;
      const x = i % w;
      let isEdge = false, touches = false;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (n < 0 || n >= w * h) { isEdge = true; continue; }
        if (!cand[n]) { isEdge = true; if (out[n]) touches = true; }
      }
      if (isEdge) { edge++; if (touches) touching++; }
      // Top edge: is furniture directly above (the piece continues down here)?
      if (i - w >= 0 && !cand[i - w]) { topEdge++; if (out[i - w]) under++; }
    }
    missedPixels.push(piece.pixels);
    missed.push({
      areaPct: +((piece.pixels.length / (w * h)) * 100).toFixed(2),
      touchingFurniturePct: Math.round((touching / Math.max(1, edge)) * 100),
      underFurniturePct: Math.round((under / Math.max(1, topEdge)) * 100),
      shadowPct: Math.round((shadow / piece.pixels.length) * 100),
      floorStd: greyStd(grey, piece.pixels),
      box: [+(piece.x1 / w).toFixed(2), +(piece.y1 / h).toFixed(2), +(piece.x2 / w).toFixed(2), +(piece.y2 / h).toFixed(2)],
    });
  }
  (out as any).possiblyMissedByTrace = missed;
  // Pixels of each listed area (same order), kept off the report so they are
  // never logged: the last attempt may take these areas from Gemini's picture.
  (out as any).missedPixels = missedPixels;
  // Where the staged image really differs from the original (after lighting
  // match): the close-up re-trace may only add furniture there.
  (out as any).changedMap = changed;
  return out;
}

export function ratioOf(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count / mask.length;
}

export function maskToPng(mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const px = Buffer.alloc(w * h);
  for (let i = 0; i < mask.length; i++) px[i] = mask[i] ? 255 : 0;
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

// Splits a mask into separate pieces (4-connected). Returns each piece's pixel
// indices and bounding box.
export function labelComponents(src: Uint8Array, w: number, h: number) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const pieces: Array<{ pixels: number[]; x1: number; y1: number; x2: number; y2: number }> = [];
  for (let start = 0; start < w * h; start++) {
    if (!src[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const piece = { pixels: [] as number[], x1: w, y1: h, x2: 0, y2: 0 };
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      piece.pixels.push(i);
      if (x < piece.x1) piece.x1 = x;
      if (x > piece.x2) piece.x2 = x;
      if (y < piece.y1) piece.y1 = y;
      if (y > piece.y2) piece.y2 = y;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const n of neighbours) {
        if (n < 0 || n >= w * h || seen[n] || !src[n]) continue;
        seen[n] = 1;
        stack[sp++] = n;
      }
    }
    pieces.push(piece);
  }
  return pieces;
}

// ── Wall art ─────────────────────────────────────────────────────────────────

// Decides, piece by piece, whether traced wall art is safe to carry over:
//  1. What the ORIGINAL photo shows underneath must be plain wall. Windows,
//     doors, a fireplace, switches/power points and wall corners all have
//     strong edges; plain wall has almost none.
//  2. The wall AROUND the art must be unchanged in the staged image. If staging
//     changed the wall there (e.g. removed a return wall), the art was drawn on
//     a wall that doesn't exist.
// Measured at a fixed 640px width so the thresholds don't depend on image size.
export async function evaluateWallArt(original: Buffer, staged: Buffer, artMask: Uint8Array, floorMask: Uint8Array, w: number, h: number) {
  const A = 640;
  const AH = Math.max(1, Math.round((A * h) / w));
  const [g, oRgb, sRgb] = await Promise.all([
    sharp(original).removeAlpha().resize(A, AH, { fit: "fill" }).grayscale().blur(1.2).raw().toBuffer(),
    sharp(original).removeAlpha().resize(A, AH, { fit: "fill" }).blur(1.5).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(A, AH, { fit: "fill" }).blur(1.5).raw().toBuffer(),
  ]);
  const edgeAt = (x: number, y: number) => {
    const i = y * A + x;
    const gx = -g[i - A - 1] - 2 * g[i - 1] - g[i + A - 1] + g[i - A + 1] + 2 * g[i + 1] + g[i + A + 1];
    const gy = -g[i - A - 1] - 2 * g[i - A] - g[i - A + 1] + g[i + A - 1] + 2 * g[i + A] + g[i + A + 1];
    return Math.hypot(gx, gy) / 4 > 12;
  };
  const keep = new Uint8Array(w * h);
  const dropped = new Uint8Array(w * h);
  const minArea = Math.max(64, Math.round(w * h * 0.001));
  const pieces = labelComponents(artMask, w, h).filter((p) => p.pixels.length >= minArea);
  const report: any[] = [];
  for (const piece of pieces) {
    let onFurniture = 0;
    for (const i of piece.pixels) onFurniture += floorMask[i];
    const sx = A / w, sy = AH / h;
    const x1 = Math.max(1, Math.floor(piece.x1 * sx)), x2 = Math.min(A - 2, Math.ceil(piece.x2 * sx));
    const y1 = Math.max(1, Math.floor(piece.y1 * sy)), y2 = Math.min(AH - 2, Math.ceil(piece.y2 * sy));
    let n = 0, edges = 0, sum = 0, sq = 0;
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      n++;
      if (edgeAt(x, y)) edges++;
      sum += g[y * A + x];
      sq += g[y * A + x] ** 2;
    }
    const T = 12;
    let busiest = 0;
    for (let ty = y1; ty + T <= y2 + 1; ty += T / 2) for (let tx = x1; tx + T <= x2 + 1; tx += T / 2) {
      let e = 0;
      for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) if (edgeAt(x, y)) e++;
      busiest = Math.max(busiest, e / (T * T));
    }
    const pad = Math.round(A * 0.03);
    let rn = 0, rd = 0;
    for (let y = Math.max(0, y1 - pad); y < Math.min(AH, y2 + pad); y++) for (let x = Math.max(0, x1 - pad); x < Math.min(A, x2 + pad); x++) {
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) continue;
      const i = (y * A + x) * 3;
      rd += (Math.abs(oRgb[i] - sRgb[i]) + Math.abs(oRgb[i + 1] - sRgb[i + 1]) + Math.abs(oRgb[i + 2] - sRgb[i + 2])) / 3;
      rn++;
    }
    const stats = {
      areaPct: +((piece.pixels.length / (w * h)) * 100).toFixed(2),
      busiestPatchPct: Math.round(busiest * 100),
      edgePct: +((edges / Math.max(1, n)) * 100).toFixed(1),
      wallStd: +Math.sqrt(Math.max(0, sq / Math.max(1, n) - (sum / Math.max(1, n)) ** 2)).toFixed(1),
      ringDiff: +(rd / Math.max(1, rn)).toFixed(1),
    };
    let reason: string | null = null;
    if (onFurniture / piece.pixels.length > 0.9) reason = "hidden behind furniture";
    else if (stats.busiestPatchPct > ART_MAX_BUSY_PATCH || stats.edgePct > ART_MAX_EDGE_PCT || stats.wallStd > ART_MAX_WALL_STD)
      reason = "not plain wall underneath (window, door, fireplace, fixture or wall corner)";
    else if (stats.ringDiff > ART_MAX_RING_DIFF) reason = "wall around it was changed by staging";
    const target = reason ? dropped : keep;
    for (const i of piece.pixels) target[i] = 1;
    report.push({ ...stats, kept: !reason, reason: reason || "plain wall, unchanged around it" });
  }
  return { keep, dropped, report };
}

// Gemini's art traces can overshoot onto the wall. The artwork's real extent is
// where the staged image differs from the original wall, with everything
// enclosed by the frame filled in (so a white mat that matches the wall is
// kept), limited to near the traced piece.
export async function refineArtRegion(original: Buffer, staged: Buffer, artKeep: Mask, w: number, h: number): Promise<Mask> {
  if (ratioOf(artKeep) === 0) return artKeep;
  const [o, t] = await Promise.all([
    sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).blur(1).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).blur(1).raw().toBuffer(),
  ]);
  const near = dilate(artKeep, w, h, Math.max(2, Math.round(w * 0.01)));
  let differs = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!near[i]) continue;
    const d = Math.max(Math.abs(o[i * 3] - t[i * 3]), Math.abs(o[i * 3 + 1] - t[i * 3 + 1]), Math.abs(o[i * 3 + 2] - t[i * 3 + 2]));
    differs[i] = d > 14 ? 1 : 0;
  }
  const r = Math.max(1, Math.round(w * 0.004));
  differs = erode(dilate(differs, w, h, r), w, h, r);
  differs = removeSmallComponents(differs, w, h, Math.max(24, Math.round(w * h * 0.0003)));
  const filled = fillFurnitureColumns(differs, w, h);
  for (let i = 0; i < w * h; i++) filled[i] &= near[i];
  // If the difference test finds almost nothing (e.g. art very close to the
  // wall colour), fall back to the traced piece itself.
  return ratioOf(filled) < ratioOf(artKeep) * 0.3 ? artKeep : filled;
}

// ── Layered merge ────────────────────────────────────────────────────────────

// Builds the final image at the staged (2K) resolution, starting from the
// original photo (scaled to match):
//  - CORE of the furniture: staged pixels;
//  - EDGE BAND of the furniture: staged, unless the staged pixel is
//    essentially the original (trace overshoot) -> original;
//  - kept wall art (refined to the artwork's real extent): staged;
//  - SHADOW ZONE around/below furniture: shadows only (original darkened).
// A removed wall, a new doorway or a changed frame is neither "the same" nor
// "the same but darker", so it can only come through inside the furniture
// core itself.
// Local lighting match. Gemini often relights the room unevenly (a wall it
// paints brighter beside the furniture than the real photo is), so one
// whole-image colour correction leaves a strip of Gemini's own wall around
// each piece that doesn't match the photo — a pale or dark halo (Bedroom 12).
// Here the staged image is corrected area by area to the original's lighting,
// measured on the room around the furniture and spread smoothly underneath
// it. The strip of Gemini wall then matches the photo (the edge test hands it
// back to the original), and the furniture takes on the photo's local light.
// Shadows in the shadow zone are not measured, so they are kept.
export const LOCAL_LIGHT_MATCH = String(process.env.STAGE2_LOCAL_LIGHT_MATCH ?? "1").trim() !== "0";
export async function matchLocalLighting(
  orig: Buffer,
  stgAdj: Buffer,
  solidA: Buffer,
  zoneA: Buffer,
  fw: number,
  fh: number
): Promise<{ meanGain: number[] }> {
  const N = fw * fh;
  const oM = Buffer.alloc(N * 3, 0), sM = Buffer.alloc(N * 3, 0), m = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) {
    if (solidA[i] > 12 || zoneA[i] > 12) continue;
    m[i] = 255;
    for (let c = 0; c < 3; c++) {
      oM[i * 3 + c] = orig[i * 3 + c];
      sM[i * 3 + c] = stgAdj[i * 3 + c];
    }
  }
  const sig = Math.max(4, fw * 0.02);
  const [oB, sB, mB] = await Promise.all([
    sharp(oM, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
    sharp(sM, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
    sharp(m, { raw: { width: fw, height: fh, channels: 1 } }).blur(sig).grayscale().raw().toBuffer(),
  ]);
  // Where little room is visible nearby (deep under a big piece), the
  // correction fades to none rather than guessing.
  // Brightness only, the same gain on all three channels: per-channel gains
  // also copied the FLOOR's colour difference onto whatever sits on it (Oct
  // 2026, production Kitchen_06: Gemini drew the timber redder, so a grey
  // rug's edge turned pink, with a green fringe where the channels faded out
  // at different rates). The overall colour shift is already removed globally.
  const gainSum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < N; i++) {
    const w = Math.min(1, mB[i] / 255 / 0.15);
    if (w <= 0) continue;
    const sv = sB[i * 3] + sB[i * 3 + 1] + sB[i * 3 + 2];
    const ov = oB[i * 3] + oB[i * 3 + 1] + oB[i * 3 + 2];
    const r = sv > 18 ? Math.min(1.4, Math.max(0.7, ov / sv)) : 1;
    const g = 1 + (r - 1) * w;
    for (let c = 0; c < 3; c++) {
      stgAdj[i * 3 + c] = Math.min(255, Math.round(stgAdj[i * 3 + c] * g));
      gainSum[c] += g;
    }
    n++;
  }
  return { meanGain: gainSum.map((g) => Number((n ? g / n : 1).toFixed(3))) };
}

// Edge matte: staged pixels this different from the real photo (max channel
// difference, 0-255) are never handed back to the real photo by the matte.
const MATTE_KEEP_DIFF = Number(process.env.STAGE2_MATTE_KEEP_DIFF || 45);
// ...and the matte only runs where Gemini's surroundings differ from the real
// photo's by at least this much (max channel, 0-255, averaged nearby).
const MATTE_MIN_BG_CHANGE = Number(process.env.STAGE2_MATTE_MIN_BG_CHANGE || 12);

export async function compositeLayers(
  original: Buffer,
  staged: Buffer,
  solidPng: Buffer,
  corePng: Buffer,
  zonePng: Buffer,
  srcW: number,
  srcH: number,
  // hybrid: around the furniture, use Gemini's actual pixels (its natural
  // shadows and contact shading) wherever the neighbourhood is only shading on
  // the same surface, instead of transferring darkening onto the original.
  hybrid = false,
  // matte: decide the edge band by colour — furniture-coloured pixels keep the
  // staged pixel, floor-coloured ones get the original back (see below).
  matte = false
) {
  const stagedMeta = await sharp(staged).metadata();
  const fw = stagedMeta.width || srcW;
  const fh = Math.round((fw * srcH) / srcW);
  const scale = fw / srcW;
  const N = fw * fh;
  const [orig, stg, solidA, coreA, zoneA] = await Promise.all([
    sharp(original).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(solidPng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
    sharp(corePng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
    sharp(zonePng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, 4 * scale)).grayscale().raw().toBuffer(),
  ]);
  // Overall brightness/colour shift between staged and original, measured where
  // no layer applies, then removed from the staged pixels.
  const sums = [0, 0, 0, 0, 0, 0];
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (solidA[i] > 12 || zoneA[i] > 12) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] += orig[i * 3 + c];
      sums[c + 3] += stg[i * 3 + c];
    }
    count++;
  }
  const gains = [0, 1, 2].map((c) => (count > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));
  const stgAdj = Buffer.alloc(N * 3);
  for (let i = 0; i < N * 3; i++) stgAdj[i] = Math.min(255, Math.round(stg[i] * gains[i % 3]));
  const localLight = LOCAL_LIGHT_MATCH ? await matchLocalLighting(orig, stgAdj, solidA, zoneA, fw, fh) : null;

  // Decisions are made on lightly smoothed images so carpet/tile texture and
  // compression noise don't create speckle; the decision maps are smoothed again.
  const [oBlur, sBlur] = await Promise.all([
    sharp(orig, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(0.6, 1.5 * scale)).raw().toBuffer(),
    sharp(stgAdj, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(0.6, 1.5 * scale)).raw().toBuffer(),
  ]);
  // Fine texture (luminance minus a blurred copy) of each image. A real shadow
  // darkens the original but keeps its texture; a rug, mat or new object has
  // different texture, so it is not treated as shadow.
  const lum = (buf: Buffer) => {
    const out = Buffer.alloc(N);
    for (let i = 0; i < N; i++) out[i] = Math.round((buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3);
    return out;
  };
  const oLum = lum(orig), sLum = lum(stgAdj);
  const [oLumBlur, sLumBlur] = await Promise.all([
    sharp(oLum, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer(),
    sharp(sLum, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer(),
  ]);
  const texDiffRaw = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const ho = oLum[i] - oLumBlur[i];
    const hs = sLum[i] - sLumBlur[i];
    // Compare texture relative to brightness, since a shadow also scales texture down.
    const scaleRatio = oLumBlur[i] > 0 ? sLumBlur[i] / oLumBlur[i] : 1;
    texDiffRaw[i] = Math.min(255, Math.round(Math.abs(hs - ho * scaleRatio) * 4));
  }
  const texDiff = await sharp(texDiffRaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer();

  // Edge matte. The traced shape includes a thin strip of the STAGED floor
  // around the furniture (darker, smoother carpet), which shows as a cut-out
  // outline. For each band pixel, compare it with the furniture colour just
  // inside and the staged floor colour just outside: furniture-like -> staged,
  // floor-like -> original, in between -> blended (a natural soft edge).
  let matteF: Buffer | null = null, matteFd: Buffer | null = null, matteB: Buffer | null = null, matteBd: Buffer | null = null;
  let matteBo: Buffer | null = null; // the REAL photo's colour just outside, same weighting as matteB
  if (matte) {
    const inF = Buffer.alloc(N, 0), inB = Buffer.alloc(N, 0);
    const rgbF = Buffer.alloc(N * 3, 0), rgbB = Buffer.alloc(N * 3, 0), rgbBo = Buffer.alloc(N * 3, 0);
    for (let i = 0; i < N; i++) {
      if (coreA[i] > 200) {
        inF[i] = 255;
        for (let c = 0; c < 3; c++) rgbF[i * 3 + c] = sBlur[i * 3 + c];
      } else if (solidA[i] < 20) {
        inB[i] = 255;
        for (let c = 0; c < 3; c++) { rgbB[i * 3 + c] = sBlur[i * 3 + c]; rgbBo[i * 3 + c] = oBlur[i * 3 + c]; }
      }
    }
    // Wide enough to reach across the whole band from both sides.
    const bandPx = ((srcW * (CORE_ERODE_PCT + SOLID_GROW_PCT)) / 100) * scale;
    const sig = Math.max(2, bandPx * 0.8);
    [matteF, matteFd, matteB, matteBd, matteBo] = await Promise.all([
      sharp(rgbF, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
      sharp(inF, { raw: { width: fw, height: fh, channels: 1 } }).blur(sig).grayscale().raw().toBuffer(),
      sharp(rgbB, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
      sharp(inB, { raw: { width: fw, height: fh, channels: 1 } }).blur(sig).grayscale().raw().toBuffer(),
      sharp(rgbBo, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
    ]);
  }
  let matteUsed = 0;

  const factor = Buffer.alloc(N, 255); // darkening to apply to the original (255 = none)
  const known = Buffer.alloc(N, 0); // 255 where the pixel passed the shadow test
  const take = Buffer.alloc(N, 0); // 255 = use the staged pixel (edge band only)
  const safe = Buffer.alloc(N, 0); // 255 = only shading/lighting differs here (hybrid)
  let zonePixels = 0, shadowPixels = 0, bandPixels = 0, bandStaged = 0;
  for (let i = 0; i < N; i++) {
    const inZone = zoneA[i] >= 8;
    const inBand = solidA[i] >= 8 && coreA[i] < 247;
    if (!inZone && !inBand) continue;
    const o0 = oBlur[i * 3], o1 = oBlur[i * 3 + 1], o2 = oBlur[i * 3 + 2];
    const t0 = sBlur[i * 3], t1 = sBlur[i * 3 + 1], t2 = sBlur[i * 3 + 2];
    const diff = Math.max(Math.abs(o0 - t0), Math.abs(o1 - t1), Math.abs(o2 - t2));
    if (inBand) {
      // Inside the traced shape the object wins, unless the staged pixel is
      // essentially the original (trace overshoot onto unchanged wall/floor).
      bandPixels++;
      take[i] = Math.round(Math.min(1, Math.max(0, (diff - 6) / 10)) * 255);
      if (matteF && matteFd && matteB && matteBd && matteFd[i] > 6 && matteBd[i] > 6) {
        // Average furniture (F) and staged-floor (B) colours nearby; project
        // this pixel onto the line between them to get how "furniture" it is.
        let fb2 = 0, pf = 0, bgChanged = 0;
        for (let c = 0; c < 3; c++) {
          const F = (matteF[i * 3 + c] * 255) / matteFd[i];
          const B = (matteB[i * 3 + c] * 255) / matteBd[i];
          const S = sBlur[i * 3 + c];
          fb2 += (F - B) ** 2;
          pf += (S - B) * (F - B);
          if (matteBo) bgChanged = Math.max(bgChanged, Math.abs(B - (matteBo[i * 3 + c] * 255) / matteBd[i]));
        }
        // Only when furniture and floor clearly differ in colour, and only
        // where Gemini changed the surroundings (its redrawn floor strip is what
        // the matte trims). Where the staged surroundings match the real photo
        // (a wall behind a table) there is nothing to trim, and light glossy
        // wood near the wall read as wall and was hazed with it (Oct 2026,
        // production Kitchen_06: pale patch on the table top).
        if (fb2 > 25 * 25 && bgChanged >= MATTE_MIN_BG_CHANGE) {
          const alpha = Math.min(1, Math.max(0, pf / fb2));
          const diffTake = take[i] / 255;
          let t = Math.min(diffTake, Math.min(1, Math.max(0, (alpha - 0.2) / 0.6)));
          // The matte trims Gemini's floor strip back to the real floor, which
          // only looks right where the two are alike. Where the staged pixel is
          // far from the real photo it is the piece itself, kept even if its
          // colour is close to the staged surroundings: a brown TV unit against
          // a white wall, dark legs on dark carpet (Oct 2026, production
          // Kitchen_01: white streaks down the unit's end, broken legs).
          const keep = Math.min(1, Math.max(0, (diff - MATTE_KEEP_DIFF) / 25));
          t = Math.max(t, keep * diffTake);
          take[i] = Math.round(t * 255);
          matteUsed++;
        }
      }
      if (take[i] > 127) bandStaged++;
    }
    // Shadow test (used outside the traced shape; computed in the band too so
    // smoothing doesn't brighten the zone right at the furniture's edge).
    const lo = (o0 + o1 + o2) / 3, ls = (t0 + t1 + t2) / 3;
    const so = o0 + o1 + o2 || 1, st = t0 + t1 + t2 || 1;
    const chroma = Math.max(Math.abs(o0 / so - t0 / st), Math.abs(o1 / so - t1 / st), Math.abs(o2 / so - t2 / st));
    const ratio = ls / Math.max(1, lo);
    // Direct sunlight is warmer than shade, so where furniture blocks a sunlit
    // patch (the original is much brighter) allow a bigger colour difference.
    const chromaLimit = ratio < 0.65 ? 0.09 : 0.05;
    if (diff <= 14 || (lo >= 15 && ratio >= 0.15 && ratio <= 1.12 && chroma <= chromaLimit && texDiff[i] <= 20)) safe[i] = 255;
    if (lo >= 15 && ratio >= 0.15 && ratio <= 0.97 && chroma <= chromaLimit && texDiff[i] <= 20) {
      factor[i] = Math.round(ratio * 255);
      known[i] = 255;
      if (inZone) shadowPixels++;
    }
    if (inZone) zonePixels++;
  }
  const [factorSmooth, takeSmooth] = await Promise.all([
    // .grayscale() keeps these one-channel: sharp's blur returns 3 channels otherwise.
    sharp(factor, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(0.6, 1.5 * scale)).grayscale().raw().toBuffer(),
    sharp(take, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(0.6, 1 * scale)).grayscale().raw().toBuffer(),
  ]);

  // Shadows are decided by neighbourhood, not pixel by pixel: where most nearby
  // pixels pass the shadow test (e.g. carpet, even though Gemini redraws its
  // texture slightly) a smooth average shadow is applied; where most fail (a
  // patterned rug, a new object) none is. The same average fills the edge band
  // right at the furniture so no pale ring is left.
  const knownFactor = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) if (known[i]) knownFactor[i] = factor[i];
  const [numBlur, denBlur] = await Promise.all([
    sharp(knownFactor, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 5 * scale)).grayscale().raw().toBuffer(),
    sharp(known, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 5 * scale)).grayscale().raw().toBuffer(),
  ]);

  // Hybrid: how much of the neighbourhood is "same surface, only shading", and
  // a wide soft fade of the zone so there's no visible seam where Gemini's
  // pixels meet the original photo.
  const [safeBlur, zoneWide] = hybrid
    ? await Promise.all([
        sharp(safe, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 5 * scale)).grayscale().raw().toBuffer(),
        sharp(zonePng).resize(fw, fh, { fit: "fill" }).blur(Math.max(1, 10 * scale)).grayscale().raw().toBuffer(),
      ])
    : [null, null];
  let hybridStagedPixels = 0;

  if (process.env.DEBUG_LAYERS_DIR) {
    const dbg = (name: string, buf: Buffer) =>
      sharp(buf, { raw: { width: fw, height: fh, channels: 1 } }).png().toFile(path.join(process.env.DEBUG_LAYERS_DIR!, name));
    await Promise.all([dbg("dbg_solid.png", solidA), dbg("dbg_core.png", coreA), dbg("dbg_zone.png", zoneA), dbg("dbg_take.png", takeSmooth), dbg("dbg_factor.png", factorSmooth)]);
  }
  const out = Buffer.alloc(N * 3);
  // How much of each output pixel is staged furniture (used by harmonise so
  // shadows land only on floor pixels and lighting only on furniture pixels).
  const furnitureAlpha = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) {
    const sa = solidA[i] / 255, ca = coreA[i] / 255, za = zoneA[i] / 255;
    // How strongly the staged pixel is used: always in the core, per-pixel in the band.
    const bandTake = takeSmooth[i] / 255;
    const a = Math.min(1, ca + sa * (1 - ca) * bandTake);
    furnitureAlpha[i] = Math.round(a * 255);
    // Shadows darken the original in the zone, and in the edge band wherever the
    // original is shown there (otherwise a pale ring appears around furniture).
    // Average shadow strength nearby, weighted by how many nearby pixels are
    // shadow-like (ramps in between 35% and 65% agreement).
    const avgFactor = denBlur[i] > 4 ? Math.min(1, numBlur[i] / denBlur[i]) : 1;
    const agreement = Math.min(1, Math.max(0, (denBlur[i] / 255 - 0.35) / 0.3));
    const shadowAmount = (1 - avgFactor) * agreement;
    if (hybrid && safeBlur && zoneWide) {
      // Use Gemini's pixels around the furniture where the area agrees it is
      // only shading on the same surface (ramps in between 60% and 85%).
      const agreeSafe = Math.min(1, Math.max(0, (safeBlur[i] / 255 - 0.6) / 0.25));
      const zs = agreeSafe * Math.max(zoneWide[i] / 255, sa * (1 - ca) * (1 - bandTake));
      if (zs > 0.5) hybridStagedPixels++;
      for (let c = 0; c < 3; c++) {
        const base = orig[i * 3 + c] * (1 - zs) + stgAdj[i * 3 + c] * zs;
        out[i * 3 + c] = Math.round(stgAdj[i * 3 + c] * a + base * (1 - a));
      }
      continue;
    }
    const darkening = shadowAmount * Math.max(za, sa * (1 - ca) * (1 - bandTake));
    const f = 1 - darkening;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(stgAdj[i * 3 + c] * a + orig[i * 3 + c] * f * (1 - a));
    }
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    width: fw,
    height: fh,
    colourGains: gains.map((g2) => Number(g2.toFixed(3))),
    localLightMatch: localLight ? localLight.meanGain : undefined,
    shadowPctOfZone: zonePixels ? Number(((shadowPixels / zonePixels) * 100).toFixed(1)) : 0,
    edgeBandStagedPct: bandPixels ? Number(((bandStaged / bandPixels) * 100).toFixed(1)) : 0,
    hybridStagedPctOfImage: hybrid ? Number(((hybridStagedPixels / N) * 100).toFixed(1)) : undefined,
    edgeMattePctOfBand: matte && bandPixels ? Number(((matteUsed / bandPixels) * 100).toFixed(1)) : undefined,
    furnitureAlphaPng: await sharp(furnitureAlpha, { raw: { width: fw, height: fh, channels: 1 } }).png().toBuffer(),
  };
}

// ── Structure map + surface merge ────────────────────────────────────────────

export const STRUCTURE_LABELS = { unknown: 0, floor: 1, wall: 2, ceiling: 3, opening: 4, fixture: 5 } as const;
export const STRUCTURE_PALETTE: Array<{ label: number; rgb: [number, number, number] }> = [
  { label: STRUCTURE_LABELS.floor, rgb: [0, 255, 0] },
  { label: STRUCTURE_LABELS.wall, rgb: [0, 0, 255] },
  { label: STRUCTURE_LABELS.ceiling, rgb: [255, 255, 0] },
  { label: STRUCTURE_LABELS.opening, rgb: [255, 0, 0] },
  { label: STRUCTURE_LABELS.fixture, rgb: [255, 0, 255] },
];

export function buildStructurePrompt(roomType: string): string {
  return [
    "Recolour this exact photograph as a flat colour-coded map of the room's structure.",
    "Output the map as an IMAGE ONLY. No text, no JSON, no explanation.",
    "Keep exactly the same framing, perspective and geometry as the photograph. Paint every pixel with ONE of these flat colours:",
    "- FLOOR (carpet, tiles, timber, any floor surface) = pure green #00FF00",
    "- WALLS (including skirting boards, wall corners, return walls, columns, beams) = pure blue #0000FF",
    "- CEILING = pure yellow #FFFF00",
    "- WINDOWS, DOORS, DOORWAYS, OPENINGS, PASS-THROUGHS and any glass, including their frames and anything visible through them = pure red #FF0000",
    "- FIXTURES AND BUILT-INS (fireplaces and hearths, kitchen benches and cabinetry, wardrobes, light fittings, heat pumps, switches and power points, curtains, blinds and rails) = pure magenta #FF00FF",
    "Rules:",
    "- Use only these five flat colours. No shading, gradients, outlines or other colours.",
    "- Follow the real edges precisely, especially where the floor meets the walls.",
    "- Do not add or remove anything; this is the empty room before staging.",
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Gemini's colour map -> one label per pixel at the original photo size.
export async function classifyStructure(raw: Buffer, w: number, h: number): Promise<Mask> {
  const px = await sharp(raw).removeAlpha().resize(w, h, { fit: "fill", kernel: sharp.kernel.nearest }).raw().toBuffer();
  const labels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let best = 0, bestD = 140 * 140;
    for (const p of STRUCTURE_PALETTE) {
      const d = (px[i * 3] - p.rgb[0]) ** 2 + (px[i * 3 + 1] - p.rgb[1]) ** 2 + (px[i * 3 + 2] - p.rgb[2]) ** 2;
      if (d < bestD) { bestD = d; best = p.label; }
    }
    labels[i] = best;
  }
  return labels;
}

// Moves the top edge of the floor (where floor meets wall/skirting) onto the
// strongest real edge in the photo near Gemini's boundary, column by column,
// then smooths it so the cut is a clean line rather than a wobbly one.
export async function snapFloorTop(floor: Uint8Array, original: Buffer, w: number, h: number): Promise<{ floor: Mask; snappedColumns: number }> {
  const g = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).grayscale().blur(1).raw().toBuffer();
  const R = Math.max(3, Math.round(h * 0.015));
  const tops = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h - 6; y++) {
      if (floor[y * w + x] && floor[(y + 3) * w + x] && floor[(y + 6) * w + x]) { tops[x] = y; break; }
    }
  }
  const snapped = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    const y0 = tops[x];
    if (y0 < 0) continue;
    let best = y0, bestE = -1;
    for (let y = Math.max(1, y0 - R); y <= Math.min(h - 2, y0 + R); y++) {
      const e = Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]);
      if (e > bestE) { bestE = e; best = y; }
    }
    snapped[x] = bestE >= 6 ? best : y0;
  }
  // Median smoothing along the line (ignoring columns without floor).
  const win = Math.max(3, Math.round(w * 0.006)) | 1;
  const smooth = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    if (snapped[x] < 0) continue;
    const vals: number[] = [];
    for (let k = -win; k <= win; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < w && snapped[xx] >= 0) vals.push(snapped[xx]);
    }
    vals.sort((a, b) => a - b);
    smooth[x] = vals[vals.length >> 1];
  }
  const out = floor.slice();
  let changed = 0;
  for (let x = 0; x < w; x++) {
    const y0 = tops[x], y1 = smooth[x];
    if (y0 < 0 || y1 < 0) continue;
    if (y1 !== y0) changed++;
    for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y++) out[y * w + x] = y1 < y0 ? 1 : 0;
  }
  return { floor: out, snappedColumns: changed };
}

export async function structureOverlay(original: Buffer, labels: Uint8Array, w: number, h: number): Promise<Buffer> {
  const raw = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const colours: Record<number, [number, number, number]> = { 1: [0, 200, 0], 2: [40, 80, 255], 3: [240, 220, 0], 4: [255, 0, 0], 5: [230, 0, 230] };
  for (let i = 0; i < w * h; i++) {
    const c = colours[labels[i]];
    if (!c) continue;
    for (let k = 0; k < 3; k++) raw[i * 3 + k] = Math.round(raw[i * 3 + k] * 0.5 + c[k] * 0.5);
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

// Surface merge: the whole floor + furniture + kept art from the staged image
// (colour-matched to the original), everything else from the original.
// Also checks whether Gemini changed the floor itself.
export async function compositeSurface(original: Buffer, staged: Buffer, floorSurface: Uint8Array, solid: Uint8Array, w: number, h: number) {
  const stagedMeta = await sharp(staged).metadata();
  const fw = stagedMeta.width || w;
  const fh = Math.round((fw * h) / w);
  const scale = fw / w;
  const N = fw * fh;
  const [floorPng, solidPng] = await Promise.all([maskToPng(floorSurface, w, h), maskToPng(solid, w, h)]);
  const [orig, stg, floorA, solidA] = await Promise.all([
    sharp(original).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(floorPng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.5, 0.8 * scale)).grayscale().raw().toBuffer(),
    sharp(solidPng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
  ]);
  // Colour-match the staged image to the original, measured on walls/ceiling
  // that look unchanged (big differences are ignored so a removed window or
  // new door doesn't skew it).
  const sums = [0, 0, 0, 0, 0, 0];
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (floorA[i] > 12 || solidA[i] > 12) continue;
    const d = Math.max(Math.abs(orig[i * 3] - stg[i * 3]), Math.abs(orig[i * 3 + 1] - stg[i * 3 + 1]), Math.abs(orig[i * 3 + 2] - stg[i * 3 + 2]));
    if (d > 40) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] += orig[i * 3 + c];
      sums[c + 3] += stg[i * 3 + c];
    }
    count++;
  }
  const gains = [0, 1, 2].map((c) => (count > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));

  // Floor check, on floor well away from furniture and its shadows: did
  // Gemini change the floor itself (material/colour), rather than just shade it?
  const nearFurniture = dilate(solid, w, h, Math.round(w * 0.06));
  const farFloor = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) farFloor[i] = floorSurface[i] && !nearFurniture[i] ? 1 : 0;
  const farFloorPng = await maskToPng(farFloor, w, h);
  const farA = await sharp(farFloorPng).resize(fw, fh, { fit: "fill" }).grayscale().raw().toBuffer();
  const [oB, sB] = await Promise.all([
    sharp(orig, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(1, 4 * scale)).raw().toBuffer(),
    sharp(stg, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(1, 4 * scale)).raw().toBuffer(),
  ]);
  let fn = 0, fsumO = [0, 0, 0], fsumS = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    if (farA[i] < 200) continue;
    fn++;
    for (let c = 0; c < 3; c++) { fsumO[c] += oB[i * 3 + c]; fsumS[c] += sB[i * 3 + c] * gains[c]; }
  }
  let floorColourDiff = 0, floorChromaDiff = 0;
  if (fn > 0) {
    const mo = fsumO.map((v) => v / fn), ms = fsumS.map((v) => v / fn);
    floorColourDiff = Math.max(...[0, 1, 2].map((c) => Math.abs(mo[c] - ms[c])));
    const so = mo[0] + mo[1] + mo[2] || 1, ss = ms[0] + ms[1] + ms[2] || 1;
    floorChromaDiff = Math.max(...[0, 1, 2].map((c) => Math.abs(mo[c] / so - ms[c] / ss)));
  }
  const floorChanged = fn > N * 0.01 && (floorChromaDiff > 0.04 || floorColourDiff > 45);

  const out = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const a = Math.max(floorA[i], solidA[i]) / 255;
    for (let c = 0; c < 3; c++) {
      const st = Math.min(255, stg[i * 3 + c] * gains[c]);
      out[i * 3 + c] = Math.round(st * a + orig[i * 3 + c] * (1 - a));
    }
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    colourGains: gains.map((g2) => Number(g2.toFixed(3))),
    floorCheck: {
      floorChanged,
      colourDiff: Number(floorColourDiff.toFixed(1)),
      chromaDiff: Number(floorChromaDiff.toFixed(3)),
      farFloorPctOfImage: Number(((fn / N) * 100).toFixed(1)),
    },
  };
}

// ── Door access (practical layout) check ────────────────────────────────────
// The paste-back guarantees the room's STRUCTURE, not a usable layout: when
// Gemini moved a door while staging, it planned the furniture around its moved
// door, so once the real door is put back a bed can end up across it.
// Runs as the FINAL check, on the finished image (real doors restored,
// furniture final) — so the AI judges exactly what would be published, with
// no outlines or coordinates to interpret. A blocked result re-stages the
// whole photo (rare, so the extra cost is accepted).
// Order:
//  1. Doors: the app already has them — extractStructuralBaseline() runs in
//     parallel with Stage 1A and returns doors/walkthroughs with boxes. This
//     test script doesn't run that, so it asks a cheap text model for the same
//     boxes, in parallel with staging (no added time).
//  2. Code pre-check on the final image: does furniture cover a doorway?
//     If not -> publish, no AI call.
//  3. If so -> wait for one vision question on the final image. It judges in
//     3D: furniture that only LOOKS in front of a doorway from the camera
//     angle but stands well forward in the room doesn't block it.
//  4. Blocked -> re-stage the photo with a note to keep that doorway clear and
//     run the whole pipeline again (one re-stage, STAGE2_MASKED_MAX_RESTAGES).
//     Still blocked -> the photo fails and the app delivers its last good
//     output (the Stage 2 input). Clear -> publish.
// Uses Grok when STAGE2_VALIDATOR_MODEL=grok (as production does), else Gemini.
export const DOOR_CHECK = process.env.DOOR_CHECK !== "0";
// Door and bed check models: Gemini by default, whatever STAGE2_VALIDATOR_MODEL
// says (Oct 2026, production: with STAGE2_VALIDATOR_MODEL=grok both checks went
// to Grok, timed out after 60 s and let blocked doors through). DOOR_CHECK_MODEL
// overrides the list (comma-separated, tried in order); "grok" may be listed
// explicitly and the Gemini defaults are still tried after it.
export const DOOR_CHECK_MODEL_SET = Boolean(String(process.env.DOOR_CHECK_MODEL || "").trim());
export const DOOR_CHECK_MODELS = (process.env.DOOR_CHECK_MODEL || "gemini-3.8-flash,gemini-3.1-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
// One re-stage budget per photo, for ANY reason (blocked doorway or a room
// Gemini reshaped). If the re-staged result also fails, the photo fails and
// the app falls back to its last good output (the Stage 2 input).
export const MAX_RESTAGES = Number(process.env.STAGE2_MASKED_MAX_RESTAGES || process.env.DOOR_MAX_RESTAGES || 1);
// Share of the floor area in front of a doorway that must have changed for
// the code to call it "appears blocked" and ask the AI.
export const DOOR_APPROACH_CHANGED = Number(process.env.DOOR_APPROACH_CHANGED || 0.3);

export type DoorOpening = { id: string; type: string; description: string; bbox: [number, number, number, number] };

export async function callJsonModel(images: { path: string; label: string }[], systemInstruction: string, userPrompt: string, name: string, label: string) {
  let lastError = "";
  const models = [...DOOR_CHECK_MODELS, ...(DOOR_CHECK_MODELS.some((m) => m.toLowerCase() === "grok") ? ["gemini-3.8-flash", "gemini-3.1-flash-lite"] : [])];
  for (const model of models) {
    const usingGrok = model.toLowerCase() === "grok";
    try {
      // Forced per call, so this check never follows STAGE2_VALIDATOR_MODEL
      // and no other validator is affected.
      const raw = await runWithForcedValidatorModel(usingGrok ? "grok" : "gemini", () =>
        callValidatorModel({
          images, systemInstruction, userPrompt, model,
          reasonPrefix: label, timeoutMs: 60000,
          // Newer Gemini Flash models "think" by default and thinking counts
          // toward this limit; too low a limit cuts the JSON answer off.
          maxOutputTokens: 8192,
          ctx: { jobId: `pasteback_${name}`, imageId: name, callLabel: label },
        })
      );
      return { raw, model: usingGrok ? `grok (${process.env.GROK_VISION_MODEL || "default"})` : model };
    } catch (e: any) {
      lastError = String(e?.message || e).slice(0, 200);
      console.warn(`[${name}] ${label} with ${model} failed: ${lastError}`);
    }
  }
  throw new Error(`${label}: all models failed (${lastError})`);
}

// Test stand-in for the app's structural baseline: doors and walkthroughs
// with boxes [x1, y1, x2, y2] as fractions of the image (same format).
export async function findDoors(emptyPath: string, roomType: string, name: string): Promise<DoorOpening[]> {
  const prompt = `List every door and walkthrough opening in this photo of an empty ${roomType.replace(/_/g, " ")} that a person would walk through: entry doors, doorways and openings to hallways or other rooms, sliding doors to outside. Only count real openings framed in a wall — with a door frame, architrave, or wall edges on both sides. Do NOT include open-plan areas, room corners, or places where the room simply continues into another area without a framed opening. Do NOT include wardrobe/closet doors, windows, or kitchen bench pass-through openings.
For each, give its bounding box [x1, y1, x2, y2] as fractions of the image width and height (0 = left/top, 1 = right/bottom), covering the whole opening down to the floor.
Respond with ONLY a single valid JSON object: { "openings": [ { "type": "door" | "walkthrough", "description": string, "bbox": [number, number, number, number] } ] }`;
  const { raw } = await callJsonModel([{ path: emptyPath, label: "Photo:" }], "You are a careful architectural surveyor.", prompt, name, "door_find");
  const list: any[] = Array.isArray(raw?.openings) ? raw.openings : [];
  return list
    .filter((o) => Array.isArray(o?.bbox) && o.bbox.length === 4 && o.bbox.every((v: any) => Number.isFinite(Number(v))))
    .map((o, i) => {
      const b = o.bbox.map((v: any) => Math.min(1, Math.max(0, Number(v)))) as [number, number, number, number];
      return { id: `door_${i + 1}`, type: String(o.type || "door"), description: String(o.description || `opening ${i + 1}`), bbox: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] };
    });
}

// Code pre-check: does furniture stand AGAINST the doorway? Looks inside the
// lower part of each opening (just above the floor line), column by column: a
// column is covered when most of it changed. A rug in front of a door only
// changes the floor, not the opening, so it doesn't count; furniture standing
// in front of the opening covers it. The doorway "appears blocked" when there
// is no clear stretch across at least DOOR_MIN_CLEAR of its width — only then
// is the AI asked (it judges depth: furniture that only LOOKS in front of a
// doorway from the camera angle passes). Changes are measured after removing
// any overall colour shift, on a softened 640px image.
export const DOOR_MIN_CLEAR = Number(process.env.DOOR_MIN_CLEAR || 0.5);
export async function doorwayAppearsBlocked(input: Buffer, staged: Buffer, doors: DoorOpening[]) {
  const W = 640;
  const m = await sharp(input).metadata();
  const H = Math.max(1, Math.round((W * (m.height || 1)) / (m.width || 1)));
  const [a, b] = await Promise.all([
    sharp(input).removeAlpha().resize(W, H, { fit: "fill" }).blur(2).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(W, H, { fit: "fill" }).blur(2).raw().toBuffer(),
  ]);
  const sums = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) { sums[c] += a[i * 3 + c]; sums[c + 3] += b[i * 3 + c]; }
  const gains = [0, 1, 2].map((c) => (sums[c + 3] > 0 ? sums[c] / sums[c + 3] : 1));
  return doors.map((d) => {
    const [x1, y1, x2, y2] = d.bbox;
    const dh = y2 - y1;
    const zx1 = Math.max(0, Math.floor(x1 * W)), zx2 = Math.min(W - 1, Math.ceil(x2 * W));
    const zy1 = Math.max(0, Math.floor((y2 - 0.4 * dh) * H)), zy2 = Math.min(H - 1, Math.ceil(y2 * H));
    // Threshold strip: the floor right at the door's floor line.
    const ty1 = Math.max(0, Math.floor((y2 - 0.01) * H)), ty2 = Math.min(H - 1, Math.ceil((y2 + 0.03) * H));
    const changedShare = (x: number, ya: number, yb: number) => {
      let n = 0, changed = 0;
      for (let y = ya; y <= yb; y++) {
        const i = (y * W + x) * 3;
        n++;
        const diff = Math.max(Math.abs(a[i] - b[i] * gains[0]), Math.abs(a[i + 1] - b[i + 1] * gains[1]), Math.abs(a[i + 2] - b[i + 2] * gains[2]));
        if (diff > 25) changed++;
      }
      return n > 0 ? changed / n : 0;
    };
    let longestClear = 0, run = 0, coveredCols = 0;
    const cols = Math.max(1, zx2 - zx1 + 1);
    for (let x = zx1; x <= zx2; x++) {
      // Covered only when furniture covers BOTH the lower part of the opening
      // and the floor at its threshold: furniture standing against the door.
      // Furniture standing forward in the room leaves the threshold floor
      // visible; a rug covers the threshold but not the opening.
      const covered = changedShare(x, zy1, zy2) >= 0.5 && changedShare(x, ty1, ty2) >= 0.5;
      if (covered) { coveredCols++; run = 0; } else { run++; longestClear = Math.max(longestClear, run); }
    }
    const clearShare = longestClear / cols;
    return {
      ...d,
      openingCoveredPct: Math.round((coveredCols / cols) * 100),
      longestClearPct: Math.round(clearShare * 100),
      appearsBlocked: clearShare < DOOR_MIN_CLEAR,
    };
  });
}

export function buildDoorAccessPrompt(roomType: string, doors: DoorOpening[]): string {
  const focus = doors.map((d) => `- ${d.description}`).join("\n");
  return `Image 1 is the EMPTY room before staging — use it only as a reference for where the room's doors and doorways are.
Image 2 is the FINISHED staged photo of the same room, from the same camera position — judge this one.

Look at every door, sliding door and open doorway in the room that a person would walk through (not wardrobe/closet doors and not windows).${focus ? ` Pay particular attention to:\n${focus}` : ""}

For each doorway: could a person walk into and out of the room through it without moving any furniture?
Judge this in 3D, not by the flat picture: furniture that only appears in front of a doorway from the camera's angle, but stands forward in the room with floor space between it and the doorway, does not block it. Small items beside the doorway, out of the walking path, don't block it either. For a sliding door, judge the part that slides open.

Answer for each doorway: "yes" (blocked — a person could not walk through without moving furniture), "no" (a person can walk through), or "cannot_tell" (not visible enough to judge).
If you answer "yes", you MUST name the furniture in the way in "blockingFurniture" (for example "the bed's headboard"). If you cannot name it, the answer is not "yes".

Respond with ONLY a single valid JSON object:
{
  "doorways": [
    { "description": string, "whatIsInFrontOfIt": string, "blockingFurniture": string, "accessBlocked": "yes" | "no" | "cannot_tell" }
  ]
}
Room type: ${roomType.replace(/_/g, " ")}`;
}

// Pure decision: blocked only on a clear "yes" that names the furniture
// ("cannot_tell" and an unnamed "yes" pass, as in doorAccessClearanceCheck.ts —
// an unclear read should never force a re-stage).
export function evaluateDoorAccess(raw: any) {
  const answers: any[] = Array.isArray(raw?.doorways) ? raw.doorways : [];
  const items = answers.map((o) => {
    const blockingFurniture = String(o?.blockingFurniture || "").trim();
    let accessBlocked = ["yes", "no", "cannot_tell"].includes(o?.accessBlocked) ? o.accessBlocked : "cannot_tell";
    if (accessBlocked === "yes" && (!blockingFurniture || /^(none|n\/a|unknown|nothing)$/i.test(blockingFurniture))) accessBlocked = "cannot_tell";
    return {
      description: String(o?.description || "").trim(),
      whatIsInFrontOfIt: String(o?.whatIsInFrontOfIt || ""),
      blockingFurniture,
      accessBlocked,
    };
  });
  const blocked = items.filter((o) => o.accessBlocked === "yes");
  return {
    blocked: blocked.length > 0,
    // Re-staging note built from the AI's own description of the doorway.
    restageHints: blocked.map(
      (o) => {
        const door = o.description ? (/^(the|a|an)\s/i.test(o.description) ? o.description : `the ${o.description}`) : "the doorway";
        return `Keep ${door} completely clear: last time ${o.blockingFurniture} blocked it. Do not place a bed, sofa, table, dresser or any other large furniture across it or directly in front of it. Leave a clear walking path through it.`;
      }
    ),
    items,
  };
}

async function askDoorAccessOnce(emptyPath: string, finalImage: Buffer, doors: DoorOpening[], roomType: string, dir: string, name: string, run = 0) {
  const finalPath = path.join(dir, `12_door_check_input${run ? `_${run}` : ""}.jpg`);
  fs.writeFileSync(finalPath, await sharp(finalImage).jpeg({ quality: 90 }).toBuffer());
  try {
    const { raw, model } = await callJsonModel(
      [{ path: emptyPath, label: "Image 1 (empty room, reference):" }, { path: finalPath, label: "Image 2 (finished staged photo):" }],
      "You are a careful visual inspector checking whether people can still walk in and out of a staged room through its doorways.",
      buildDoorAccessPrompt(roomType, doors),
      name,
      "door_access",
    );
    return { model, ...evaluateDoorAccess(raw) };
  } catch (e: any) {
    // A failed check never blocks (structure is protected regardless).
    return { model: "none", error: String(e?.message || e).slice(0, 200), blocked: false, restageHints: [] as string[], items: [] as any[] };
  }
}

// ── Bed wall check (bedrooms) ────────────────────────────────────────────────
// The bed's headboard belongs on a plain wall: never a wall with a door,
// doorway or wardrobe door on it (when a plain wall exists), and never across
// a window's glass. Carried over from the old layout planner, which scored
// walls from the window/door survey. Code can't tell which wall a bed stands
// against, so one small AI look at Gemini's staged image decides (runs
// alongside the blend; bedrooms with a surveyed door only).
// STAGE2_BED_WALL_CHECK=off disables it.
// STAGE2_BED_UNDER_WINDOW_OK=off goes back to rejecting any glass covered.
export const BED_UNDER_WINDOW_OK = String(process.env.STAGE2_BED_UNDER_WINDOW_OK ?? "on").trim().toLowerCase() !== "off";
export const BED_WALL_CHECK = String(process.env.STAGE2_BED_WALL_CHECK ?? "on").trim().toLowerCase() !== "off";

export function buildBedWallPrompt(doors: DoorOpening[]): string {
  const list = doors.length
    ? doors.map((d) => `- ${d.id}: ${d.description} (${d.type}), box [${d.bbox.map((v) => v.toFixed(2)).join(", ")}]`).join("\n")
    : "- none found by the survey (still check the photo yourself)";
  return `Image 1 is the empty room. Image 2 is the same room after virtual staging (same camera).
Doors and doorways found in the room (boxes are [x1, y1, x2, y2] as fractions of the image):
${list}

Look at the bed in Image 2 and the walls in Image 1, and answer:
1. bedPresent: is there a bed in Image 2?
2. headboardWall: which wall is the bed's headboard against (describe it)?
3. doorOnHeadboardWall: is there a door, doorway or wardrobe door anywhere on that same wall — including one beside the bed? Judge by the wall itself in Image 1, not by what the camera angle makes look close.
4. otherPlainWallAvailable: does the room show another wall, long enough for the bed, with no door, doorway, wardrobe door or window on it?
5. headboardCoversWindow: does the bed or its headboard cover any part of a window's glass?
5b. windowCoverage: if the bed, headboard, pillows or a bedside lamp cover window glass, how much? "bottom" = only the lower part of the glass, with most of the window (more than half its height) still clearly visible; "most" = half or more of the window hidden, or the window painted or walled over; "none" = no glass covered.
6. bedCoversDoor: does the bed, its headboard, a bedside table or a lamp stand in front of, touch, cover or hide any part of a door, an open door leaf, a door frame, a doorway, an opening or a wardrobe door that Image 1 shows (including one that is missing from Image 2 because it was painted over)? Also answer "yes" if any of them stands on the floor an open door sweeps when it closes, so the door could no longer close.
7. roomWidened: compare where each wall meets the floor (the skirting boards and the floor's edges) in Image 1 and Image 2. To make room for the furniture, was the floor extended, a wall pushed back, or a skirting line moved or re-angled — so that the bed, a bedside table or any other piece stands where Image 1 shows wall or skirting board? Answer "yes" only for a real change to the room, not for shadows or furniture covering things.
Respond with ONLY a JSON object: { "bedPresent": "yes" | "no", "headboardWall": string, "doorOnHeadboardWall": "yes" | "no", "doorDescription": string, "otherPlainWallAvailable": "yes" | "no", "headboardCoversWindow": "yes" | "no", "windowCoverage": "none" | "bottom" | "most", "bedCoversDoor": "yes" | "no", "roomWidened": "yes" | "no", "reason": string }`;
}

export function evaluateBedWall(raw: any) {
  const yes = (v: any) => String(v || "").trim().toLowerCase() === "yes";
  const bed = yes(raw?.bedPresent);
  const doorWall = bed && yes(raw?.doorOnHeadboardWall) && yes(raw?.otherPlainWallAvailable);
  // Covering the bottom of a window is fine; hiding most of it, or painting
  // or walling it over, is not (owner rule, Oct 2026 — first for 33 Golf Rd
  // Image 03, a corner room with windows on both walls, then for every room).
  const coverage = String(raw?.windowCoverage || "").trim().toLowerCase();
  const underWindowOk = BED_UNDER_WINDOW_OK && coverage === "bottom";
  const window = bed && yes(raw?.headboardCoversWindow) && !underWindowOk;
  const coversDoor = bed && yes(raw?.bedCoversDoor);
  const roomWidened = yes(raw?.roomWidened);
  const hints: string[] = [];
  if (roomWidened) hints.push("Your previous attempt changed the room to make the furniture fit: the floor was extended or a wall/skirting line was moved, so furniture stood where the photo shows wall. The room is smaller than that layout needs. Keep every wall, skirting board and floor edge exactly where it is, and fit the furniture to the room instead: use a smaller bed, fewer or no bedside tables, turn the bed so it runs along the room's longest direction (headboard against a shorter wall, below any window sill), or let the edge of the photo cut it off.");
  if (coversDoor) hints.push("Your previous attempt placed the bed setup in front of a door: the bed, headboard or a bedside table overlapped the door, its frame or the space it swings through, so the door could not close. Every door, door leaf, doorway and wardrobe door must stay fully visible and clear. If the plain wall is too short, in this order: keep only the bedside table on the side away from the door; use a smaller bed; or slide the bed further from the door and let the edge of the photo cut off its far side or foot. Never let any part of the bed, headboard or bedside tables reach the door.");
  if (doorWall) hints.push(`Your previous attempt put the bed's headboard against a wall with a door on it (${String(raw?.doorDescription || "a door").slice(0, 120)}). Put the headboard against a plain wall that has no door, doorway or wardrobe door anywhere on it.`);
  if (window) hints.push("Your previous attempt hid too much of a window with the bed. The bed may stand under a window, but use a low headboard and low pillows so they cover only the bottom of the glass; keep most of the window, its frame and the curtains visible, and never paint or wall over a window.");
  return { bedPresent: bed, bedOnDoorWall: doorWall, coversWindow: window, underWindowAccepted: bed && yes(raw?.headboardCoversWindow) && underWindowOk, coversDoor, roomWidened, failed: doorWall || window || coversDoor || roomWidened, restageHints: hints, answer: raw };
}

// ── Desk placement (studies / offices) ──────────────────────────────────────
// Same idea as the bed check. The code door check depends on the survey's
// door box reaching the right floor line; when it doesn't (Oct 2026: an
// alcove door whose box ran down onto the main room's floor) a desk standing
// in front of the door passes as "clear". This asks the AI directly.
export function buildDeskDoorPrompt(doors: DoorOpening[]): string {
  const list = doors.length
    ? doors.map((d) => `- ${d.id}: ${d.description} (${d.type}), box [${d.bbox.map((v) => v.toFixed(2)).join(", ")}]`).join("\n")
    : "- none found by the survey (still check the photo yourself)";
  return `Image 1 is the empty room. Image 2 is the same room after virtual staging (same camera).
Doors and doorways found in the room (boxes are [x1, y1, x2, y2] as fractions of the image):
${list}

Look at the desk in Image 2 and the walls in Image 1, and answer:
1. deskPresent: is there a desk or work table in Image 2?
2. deskWall: which wall does the desk stand against (describe it), or "none" if it stands out in the room?
3. doorOnDeskWall: is there a door, doorway or wardrobe door on that same wall, next to the desk? Judge by the wall itself in Image 1, not by what the camera angle makes look close.
4. otherPlainWallAvailable: does the room show another wall, long enough for a desk, with no door, doorway or wardrobe door on it?
5. deskCoversDoor: does the desk, its chair, a bookshelf, an armchair or a lamp stand in front of, touch, cover or hide any part of a door, an open door leaf, a door frame, a doorway, an opening or a wardrobe door that Image 1 shows (including one that is missing from Image 2 because it was painted over)? Also answer "yes" if any of them stands on the floor an open door sweeps when it closes, or in the walking path straight through a doorway.
6. roomWidened: compare where each wall meets the floor (the skirting boards and the floor's edges) in Image 1 and Image 2. To make room for the furniture, was the floor extended, a wall pushed back, or a skirting line moved or re-angled — so that a piece stands where Image 1 shows wall or skirting board? Answer "yes" only for a real change to the room, not for shadows or furniture covering things.
Respond with ONLY a JSON object: { "deskPresent": "yes" | "no", "deskWall": string, "doorOnDeskWall": "yes" | "no", "doorDescription": string, "otherPlainWallAvailable": "yes" | "no", "deskCoversDoor": "yes" | "no", "roomWidened": "yes" | "no", "reason": string }`;
}

export function evaluateDeskDoor(raw: any) {
  const yes = (v: any) => String(v || "").trim().toLowerCase() === "yes";
  const desk = yes(raw?.deskPresent);
  const coversDoor = desk && yes(raw?.deskCoversDoor);
  const doorWall = desk && yes(raw?.doorOnDeskWall) && yes(raw?.otherPlainWallAvailable);
  const roomWidened = yes(raw?.roomWidened);
  const hints: string[] = [];
  if (roomWidened) hints.push("Your previous attempt changed the room to make the furniture fit: the floor was extended or a wall/skirting line was moved. Keep every wall, skirting board and floor edge exactly where it is, and fit the furniture to the room instead: use a compact desk, leave out the bookshelf or armchair, or let the edge of the photo cut the desk off.");
  if (coversDoor) hints.push("Your previous attempt placed the desk setup in front of a door: the desk, chair or another piece overlapped the door, its frame, the space it swings through or the path through the doorway. Every door, door leaf and doorway must stay fully visible and clear. Put the desk with its back against a plain wall that has no door on it; if that wall is short, use a compact desk, leave out the bookshelf or armchair, or slide the desk to the far end of that wall and let the edge of the photo cut it off. Never let any part of the desk, chair or shelves reach a door.");
  if (doorWall) hints.push(`Your previous attempt put the desk against a wall with a door on it (${String(raw?.doorDescription || "a door").slice(0, 120)}). Put the desk against a plain wall that has no door, doorway or wardrobe door on it.`);
  return { deskPresent: desk, coversDoor, deskOnDoorWall: doorWall, roomWidened, failed: coversDoor || doorWall || roomWidened, restageHints: hints, answer: raw };
}

async function askDeskDoorOnce(emptyPath: string, stagedImage: Buffer, doors: DoorOpening[], dir: string, name: string, run = 0) {
  const stagedPath = path.join(dir, `12_desk_door_check_input${run ? `_${run}` : ""}.jpg`);
  fs.writeFileSync(stagedPath, await sharp(stagedImage).jpeg({ quality: 88 }).toBuffer());
  try {
    const { raw, model } = await callJsonModel(
      [{ path: emptyPath, label: "Image 1 (empty room):" }, { path: stagedPath, label: "Image 2 (staged):" }],
      "You are an experienced real-estate stager checking where the desk was placed.",
      buildDeskDoorPrompt(doors),
      name,
      "desk_door",
    );
    return { model, ...evaluateDeskDoor(raw) };
  } catch (e: any) {
    // Unanswered: don't block the job.
    return { model: "none", error: String(e?.message || e).slice(0, 200), ...evaluateDeskDoor(null) };
  }
}

// ── Living / dining placement ───────────────────────────────────────────────
// Same idea as the bed and desk checks, for sofas, armchairs, coffee tables,
// TV units and dining sets. STAGE2_LIVING_DOOR_CHECK=0 turns it off.
export const LIVING_DOOR_CHECK = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_LIVING_DOOR_CHECK || "").trim().toLowerCase());

export function buildLivingDoorPrompt(doors: DoorOpening[]): string {
  const list = doors.length
    ? doors.map((d) => `- ${d.id}: ${d.description} (${d.type}), box [${d.bbox.map((v) => v.toFixed(2)).join(", ")}]`).join("\n")
    : "- none found by the survey (still check the photo yourself)";
  return `Image 1 is the empty room. Image 2 is the same room after virtual staging (same camera).
Doors and doorways found in the room (boxes are [x1, y1, x2, y2] as fractions of the image):
${list}

Look at the furniture in Image 2 and the room in Image 1, and answer:
1. furniturePresent: did staging add a sofa, armchair, coffee table, TV unit or dining table?
2. doorAccess: for the door or doorway most affected by the sofa, armchair, coffee table, TV unit, sideboard, dining table or dining chairs in Image 2, judge it the way a buyer walking through the home would:
   - "blocked": a person could NOT walk through it normally — a piece stands right in the doorway or the walking path through it, an open door could not swing or close, the opening of a sliding door is covered, or a door/doorway was painted over or is missing in Image 2;
   - "passable": a piece stands in front of part of it or hides part of it in the photo, but there is still a clear walking path to it and through it (for example a free-standing sofa with room to walk around it);
   - "clear": nothing is near it.
   For a sliding door, only its OPENING counts; furniture in front of a FIXED glass panel beside the opening is fine. Furniture that only LOOKS close because of the camera angle, but stands well clear in the room, is "clear".
3. blockedWhat: which piece and which door, or "none". Describe the door in plain words and say where it is in the photo (for example "the armchair blocks the white door at the far right edge of the photo"), not only its id.
4. roomWidened: compare where each wall meets the floor (the skirting boards and the floor's edges) in Image 1 and Image 2. To make room for the furniture, was the floor extended, a wall pushed back, or a skirting line moved or re-angled — so that a piece stands where Image 1 shows wall or skirting board? Answer "yes" only for a real change to the room, not for shadows or furniture covering things.
Respond with ONLY a JSON object: { "furniturePresent": "yes" | "no", "doorAccess": "blocked" | "passable" | "clear", "blockedWhat": string, "roomWidened": "yes" | "no", "reason": string }`;
}

/**
 * Re-stage hint after Gemini moved a wall's floor line to fit furniture.
 * Says where in the photo it happened and asks for the same layout with the
 * line put back. The old fixed hint ("the photo shows only a little floor: let
 * the bed run off the edge") was wrong for roomy photos and pushed the bed in
 * front of the entry (Oct 2026, job_56b49ee9).
 */
export function floorMovedHint(check: { atXPct?: number[] } | null | undefined, opts: { tightShot?: boolean } = {}): string {
  const at = Array.isArray(check?.atXPct) && check!.atXPct!.length === 2 ? check!.atXPct! : null;
  let where = "";
  if (at) {
    const mid = (Number(at[0]) + Number(at[1])) / 2;
    const side = mid < 33 ? "on the left of the photo" : mid > 67 ? "on the right of the photo" : "in the middle of the photo";
    where = ` ${side} (about ${Math.round(Number(at[0]))}–${Math.round(Number(at[1]))}% of the way across)`;
  }
  const base = `Your previous attempt changed the room to make the furniture fit: the line where the wall meets the floor${where} was moved, so the wall or floor no longer matches the input photo. Keep the same layout described above — the same pieces in the same places — but draw that wall, its skirting board and the floor edge exactly where the input photo shows them. If a piece then no longer fits, make it a little smaller or let the edge of the photo cut it off; never change the wall or floor to make room.`;
  // Only for photos the room plan measured as tight shots (very little floor):
  // there the stronger "let it run off the edge, no rug" is right.
  return opts.tightShot
    ? `${base} This photo shows very little floor: let the bed or other large pieces run off the bottom or side edge of the photo, use smaller pieces, and leave out the rug.`
    : base;
}

// What the room plan (room brief) says, for the re-stage hint: which walls
// large furniture may stand against, and which pieces were planned.
export type LivingPlan = { usableWalls: string[]; items: string[] };
export function livingPlanFromBrief(brief: any): LivingPlan | null {
  if (!brief || typeof brief !== "object" || !Array.isArray(brief.layout)) return null;
  const items = brief.layout.map((l: any) => String(l?.item || "").trim().toLowerCase()).filter(Boolean);
  const usableWalls = (Array.isArray(brief.walls) ? brief.walls : [])
    .filter((w: any) => w?.usableForLargeFurniture === true)
    .map((w: any) => String(w?.name || "").trim())
    .filter(Boolean);
  return { usableWalls, items };
}

/** Where a door sits across the photo, in words. */
export function doorPlace(bbox: [number, number, number, number]): string {
  const cx = (bbox[0] + bbox[2]) / 2;
  if (bbox[2] >= 0.97 || cx >= 0.92) return "at the far right edge of the photo";
  if (bbox[0] <= 0.03 || cx <= 0.08) return "at the far left edge of the photo";
  if (cx < 0.38) return "on the left of the photo";
  if (cx > 0.62) return "on the right of the photo";
  return "in the middle of the photo";
}

/** Swap the door check's own ids (D1, S2...) for words: Gemini staging never sees that list. */
export function doorsInWords(text: string, doors: DoorOpening[]): string {
  const byId = new Map(doors.map((d) => [d.id.toUpperCase(), d]));
  // "(A1)" right after the check's own description of the door adds nothing: drop it.
  const dropped = text.replace(/\s*\(([A-Z]{1,2}\d{1,2})\)/g, (whole, id: string) => (byId.has(id.toUpperCase()) ? "" : whole));
  return dropped.replace(/\b(?:doors?\s+|doorways?\s+)?([A-Z]{1,2}\d{1,2})\b/g, (whole, id: string) => {
    const d = byId.get(id.toUpperCase());
    if (!d) return whole;
    const desc = String(d.description || d.type || "door").trim().replace(/^(the|a|an)\s+/i, "").replace(/[.;,\s]+$/, "");
    return `the ${desc} ${doorPlace(d.bbox)}`;
  });
}

// Pieces that are nice to have: leaving one out is the surest fix.
const SECONDARY_PIECE = /armchair|accent chair|lounge chair|side ?table|sideboard|console|ottoman|pouf|bench|bookcase|bookshelf|shelf|plant|lamp|cabinet|tv unit|tv stand|media unit|desk|stool/i;

function piecesIn(blockedWhat: string, plan: LivingPlan | null): string[] {
  const text = blockedWhat.toLowerCase();
  const items = plan?.items || [];
  const word = (w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i");
  // Full name ("coffee table"), then the head noun ("sofa" for "3-seater sofa")
  // when only one planned piece has it ("table" could be coffee or dining).
  const planned = items.filter((it) => word(it.replace(/s$/, "")).test(text));
  const head = (it: string) => (it.split(/\s+/).pop() || "").replace(/s$/, "");
  for (const it of items) {
    if (planned.includes(it)) continue;
    const h = head(it);
    if (h.length > 2 && items.filter((o) => head(o) === h).length === 1 && word(h).test(text)) planned.push(it);
  }
  if (planned.length) return planned;
  const generic = ["sofa", "armchair", "chair", "coffee table", "dining table", "tv unit", "sideboard", "side table", "ottoman", "bench"];
  return generic.filter((g) => text.includes(g)).slice(0, 2);
}

/**
 * The re-stage hint after furniture blocked a door. It names the door in words,
 * keeps the rest of the planned layout, changes only the piece that blocked,
 * and never contradicts the room plan by sending the sofa to a "plain wall"
 * when the plan has none (Oct 2026, job_0d2b0a4b: every wall had a door, the
 * old hint moved the free-standing sofa in front of the back-wall doors).
 */
export function livingDoorRestageHint(blockedWhatRaw: string, doors: DoorOpening[] = [], plan: LivingPlan | null = null): string {
  const blockedWhat = doorsInWords(String(blockedWhatRaw || "a piece by a door").slice(0, 160), doors);
  const clear = "Every door, door leaf, doorway and the opening side of every sliding door — and the walking path through it — must stay fully visible and clear (furniture may stand in front of a fixed glass panel beside a sliding door's opening).";
  if (!plan) {
    return `Your previous attempt placed furniture in front of a door: ${blockedWhat}. ${clear} Put the sofa with its back to a plain wall that has no door on it, keep the dining table and chairs clear of every doorway, use smaller pieces, leave out the armchair or sideboard, or slide a piece away from the door and let the edge of the photo cut it off.`;
  }
  const pieces = piecesIn(blockedWhat, plan);
  const others = plan.items.filter((it) => !pieces.includes(it));
  const parts = [`Your previous attempt placed furniture in front of a door: ${blockedWhat}. ${clear}`];
  if (pieces.length) {
    const list = pieces.join(" and ");
    parts.push(`Only the ${list} ${pieces.length > 1 ? "were" : "was"} the problem${others.length ? `: keep the ${others.join(", ")} exactly where the layout puts ${others.length > 1 ? "them" : "it"}` : ""}.`);
    for (const piece of pieces) {
      if (SECONDARY_PIECE.test(piece)) parts.push(`Leave the ${piece} out — or, only if it fits well clear of every door, use a smaller ${piece} placed so no part of it reaches a door, door frame, doorway or the path through it.`);
      else if (/dining/i.test(piece)) parts.push(`Use a smaller ${piece} with fewer chairs, placed so no table or chair reaches a doorway or the path through it.`);
      else parts.push(`Use a smaller ${piece} and move it further into the open room, away from that door, so no part of it reaches a door, door frame, doorway or the path through it.`);
    }
  } else {
    parts.push("Keep the planned layout and change only the piece that was in front of the door: leave it out, or make it smaller and move it away from the door.");
  }
  parts.push(plan.usableWalls.length
    ? `If a large piece must stand against a wall, use only: ${plan.usableWalls.join(", ")}.`
    : "No wall in this room is free for large furniture: keep the sofa and other large pieces free-standing in the open room as the layout says, and never move them toward a wall that has a door or doorway on it.");
  return parts.join(" ");
}

export function evaluateLivingDoor(raw: any, doors: DoorOpening[] = [], plan: LivingPlan | null = null) {
  const yes = (v: any) => String(v || "").trim().toLowerCase() === "yes";
  const present = yes(raw?.furniturePresent);
  // Only a door a person can't walk through fails (owner's standard, Oct 2026:
  // a free-standing sofa that hides the bottom of a doorway but leaves a clear
  // path is fine). Older answers without doorAccess: blocksDoor decides.
  const access = String(raw?.doorAccess || "").trim().toLowerCase();
  const blocksDoor = present && (access ? access === "blocked" : yes(raw?.blocksDoor));
  const roomWidened = yes(raw?.roomWidened);
  const hints: string[] = [];
  if (roomWidened) hints.push("Your previous attempt changed the room to make the furniture fit: the floor was extended or a wall/skirting line was moved. Keep every wall, skirting board and floor edge exactly where it is, and fit the furniture to the room instead: use a smaller sofa or table, leave out the armchair, or let the edge of the photo cut a piece off.");
  if (blocksDoor) hints.push(livingDoorRestageHint(String(raw?.blockedWhat || ""), doors, plan));
  return { furniturePresent: present, blocksDoor, roomWidened, failed: blocksDoor || roomWidened, restageHints: hints, answer: raw };
}

async function askLivingDoorOnce(emptyPath: string, stagedImage: Buffer, doors: DoorOpening[], dir: string, name: string, run = 0, plan: LivingPlan | null = null) {
  const stagedPath = path.join(dir, `12_living_door_check_input${run ? `_${run}` : ""}.jpg`);
  fs.writeFileSync(stagedPath, await sharp(stagedImage).jpeg({ quality: 88 }).toBuffer());
  try {
    const { raw, model } = await callJsonModel(
      [{ path: emptyPath, label: "Image 1 (empty room):" }, { path: stagedPath, label: "Image 2 (staged):" }],
      "You are an experienced real-estate stager checking that staged furniture keeps every door and walkway clear.",
      buildLivingDoorPrompt(doors),
      name,
      "living_door",
    );
    return { model, ...evaluateLivingDoor(raw, doors, plan) };
  } catch (e: any) {
    return { model: "none", error: String(e?.message || e).slice(0, 200), ...evaluateLivingDoor(null) };
  }
}

// ── Consensus for the cheap AI checks ────────────────────────────────────────
// One AI answer can flip on the same image (Oct 2026: the same bed check
// said yes then no). Each check that can reject an image asks twice; if the
// two agree, that decides; if not (or one call failed), a third call
// decides. Rejecting needs two "fail" votes, so an error or a tie never
// blocks. STAGE2_AI_CHECK_CONSENSUS=0 goes back to a single call.
export const AI_CHECK_CONSENSUS = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_AI_CHECK_CONSENSUS || "").trim().toLowerCase());
export async function withConsensus<T extends { error?: string }>(run: (k: number) => Promise<T>, fails: (r: T) => boolean): Promise<T & { consensus?: { votes: (boolean | null)[]; calls: number } }> {
  if (!AI_CHECK_CONSENSUS) return run(0);
  const vote = (r: T) => (r.error ? null : fails(r));
  const results: T[] = await Promise.all([run(1), run(2)]);
  const votes = results.map(vote);
  if (votes[0] !== null && votes[0] === votes[1]) return { ...results[0], consensus: { votes, calls: 2 } };
  const third = await run(3);
  results.push(third);
  votes.push(vote(third));
  const failVotes = votes.filter((v) => v === true).length;
  const decided = failVotes >= 2;
  // An answer that voted the way the majority decided; failing that (no clear
  // "pass" answer, only errors), a failed call's result, which never rejects.
  const pick = results.find((r, i) => votes[i] === decided) ?? (decided ? third : results.find((r) => r.error)) ?? third;
  return { ...pick, consensus: { votes, calls: 3 } };
}

export function askDoorAccess(emptyPath: string, finalImage: Buffer, doors: DoorOpening[], roomType: string, dir: string, name: string) {
  return withConsensus((k) => askDoorAccessOnce(emptyPath, finalImage, doors, roomType, dir, name, k), (r: any) => Boolean(r.blocked));
}
export function askBedWall(emptyPath: string, stagedImage: Buffer, doors: DoorOpening[], dir: string, name: string) {
  return withConsensus((k) => askBedWallOnce(emptyPath, stagedImage, doors, dir, name, k), (r: any) => Boolean(r.failed));
}
export function askDeskDoor(emptyPath: string, stagedImage: Buffer, doors: DoorOpening[], dir: string, name: string) {
  return withConsensus((k) => askDeskDoorOnce(emptyPath, stagedImage, doors, dir, name, k), (r: any) => Boolean(r.failed));
}
export function askLivingDoor(emptyPath: string, stagedImage: Buffer, doors: DoorOpening[], dir: string, name: string, plan: LivingPlan | null = null) {
  return withConsensus((k) => askLivingDoorOnce(emptyPath, stagedImage, doors, dir, name, k, plan), (r: any) => Boolean(r.failed));
}

// ── Reflective surfaces (once per job, on the empty room) ───────────────────
// The reflections trace pass (one Gemini image call per attempt) only finds
// anything when the room has a mirror, glass panel or glossy floor.
export const REFLECTION_GATE = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_REFLECTION_GATE || "").trim().toLowerCase());

export function buildReflectivePrompt(): string {
  return `Look at this photo of a room. Would furniture placed in this room show a visible reflection anywhere in the photo?
Answer "yes" if ANY of these is visible: a mirror or mirrored wardrobe door; a glass door, glass balustrade or glass panel that reaches down near the floor; a glossy or polished floor (polished timber, glossy tiles, polished concrete) showing reflections or bright light streaks; any other shiny surface at floor or furniture height.
Answer "no" only if every floor and low surface is matte (carpet, matte floorboards, matte tiles) and there is no mirror or low glass. Ordinary windows above sill height do not count.
If unsure, answer "yes".
Respond with ONLY a JSON object: { "reflective": "yes" | "no", "what": string }`;
}

export async function askReflectiveSurfaces(emptyPath: string, name: string) {
  const { raw, model } = await callJsonModel(
    [{ path: emptyPath, label: "Room photo:" }],
    "You are a real-estate photo retoucher.",
    buildReflectivePrompt(),
    name,
    "reflective_surfaces",
  );
  const ans = String(raw?.reflective ?? "").trim().toLowerCase();
  // Anything but a clear "no" keeps the reflections pass.
  return { reflective: ans !== "no", what: String(raw?.what || "").slice(0, 200), model };
}

async function askBedWallOnce(emptyPath: string, stagedImage: Buffer, doors: DoorOpening[], dir: string, name: string, run = 0) {
  const stagedPath = path.join(dir, `12_bed_wall_check_input${run ? `_${run}` : ""}.jpg`);
  fs.writeFileSync(stagedPath, await sharp(stagedImage).jpeg({ quality: 88 }).toBuffer());
  try {
    const { raw, model } = await callJsonModel(
      [{ path: emptyPath, label: "Image 1 (empty room):" }, { path: stagedPath, label: "Image 2 (staged):" }],
      "You are an experienced real-estate stager checking where the bed was placed.",
      buildBedWallPrompt(doors),
      name,
      "bed_wall",
    );
    return { model, ...evaluateBedWall(raw) };
  } catch (e: any) {
    // A failed check never blocks.
    return { model: "none", error: String(e?.message || e).slice(0, 200), bedPresent: false, bedOnDoorWall: false, coversWindow: false, coversDoor: false, roomWidened: false, failed: false, restageHints: [] as string[], answer: null };
  }
}

// ── Harmonise (phase 2 prompt + phase 3 merge) ──────────────────────────────

export function buildHarmonisePrompt(roomType: string, opts: { completeCutPieces?: boolean } = {}): string {
  return [
    "Edit this photograph. Return the edited photograph as an IMAGE ONLY. No text.",
    "",
    "This is a real estate photo of a room where furniture has just been placed into the empty room.",
    "The furniture currently looks pasted in: it casts no shadows and its lighting may not match the room.",
    "",
    "Task: make the furniture sit naturally in the room.",
    "- Add realistic contact shadows where the furniture touches the floor.",
    "- Add soft shadows cast by the furniture onto the floor and nearby walls, matching the direction, colour and softness of the room's existing light (windows, doors, lamps).",
    "- Gently adjust the lighting and shading on the furniture so it matches the light in the room.",
    ...(opts.completeCutPieces
      ? ["- Some furniture or rugs near the edge of the photo end in a straight, cut-off line a little before the edge of the picture. Continue each of them naturally out to the edge of the photo — the same shape, colour and material, including any legs or corners — as if the photo had been taken with them fully in place. This is the only place where you may add to the furniture."]
      : []),
    "",
    "Strict rules:",
    "- Do NOT add, remove, move, resize, replace or restyle anything. No new furniture, decor, rugs, plants, artwork, lamps, lights or fixtures.",
    "- Do NOT change the walls, ceiling, floor material or colour, windows, doors, doorways, openings, curtains, blinds, light fittings, switches or any built-in features.",
    "- Do NOT change the view through windows or doorways.",
    "- Keep exactly the same camera angle, framing, perspective and image proportions.",
    "- Do not brighten, darken or recolour the whole image; only add shadows and blend the furniture's lighting.",
    "- The result must look like one real, professional photograph.",
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Phase 3a. Sun patches. The original often has a bright patch of direct sun
// on the floor where the furniture now stands. Gemini's blend removes it (the
// furniture would block the sun), but the safe composite still shows it, which
// left half-darkened, blotchy patches. Where Gemini's blend is clearly darker
// over a bright area next to the furniture (same colour family, original
// bright), the broad lighting there is taken from the blend while the fine
// texture stays the original's — so the carpet stays crisp and Gemini's
// mottling doesn't come through. Darkening only, so nothing can appear.
export const SUN_PATCH_MIN_BRIGHTNESS = Number(process.env.SUN_PATCH_MIN_BRIGHTNESS || 1.25);
export async function removeSunPatches(safe: Buffer, harmonised: Buffer, solidPng: Buffer, corePng: Buffer, zonePng: Buffer) {
  const meta = await sharp(safe).metadata();
  const fw = meta.width || 0, fh = meta.height || 0;
  const N = fw * fh;
  const u = fw / 1000;
  const [A, H, solidA, coreA, zoneHard] = await Promise.all([
    sharp(safe).removeAlpha().raw().toBuffer(),
    sharp(harmonised).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(solidPng).resize(fw, fh, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(corePng).resize(fw, fh, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(zonePng).resize(fw, fh, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);
  const sums = [0, 0, 0, 0, 0, 0];
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (solidA[i] > 12 || zoneHard[i] > 12) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] += A[i * 3 + c];
      sums[c + 3] += H[i * 3 + c];
    }
    count++;
  }
  const gains = [0, 1, 2].map((c) => (count > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));
  const Hadj = Buffer.alloc(N * 3);
  for (let i = 0; i < N * 3; i++) Hadj[i] = Math.min(255, Math.round(H[i] * gains[i % 3]));
  // A real sun patch is (a) clearly brighter than the room around it in the
  // original and (b) only a lighting change in the blend — the blend adds no
  // new shapes there. Without these, a curtain Gemini nudged in its blend was
  // read as a "sun patch" and smeared onto the real curtain (Bedroom 12).
  const lumOf = (buf: Buffer) => {
    const out = Buffer.alloc(N);
    for (let i = 0; i < N; i++) out[i] = Math.round((buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3);
    return out;
  };
  const aL = lumOf(A), hL = lumOf(Hadj);
  const [aLB, hLB, aRoom] = await Promise.all([
    sharp(aL, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * u)).grayscale().raw().toBuffer(),
    sharp(hL, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * u)).grayscale().raw().toBuffer(),
    sharp(aL, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(4, 50 * u)).grayscale().raw().toBuffer(),
  ]);
  const dARaw = Buffer.alloc(N), dHRaw = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    dARaw[i] = Math.min(255, Math.abs(aL[i] - aLB[i]) * 4);
    dHRaw[i] = Math.min(255, Math.abs(hL[i] - hLB[i]) * 4);
  }
  const [dA, dH] = await Promise.all([
    sharp(dARaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 6 * u)).grayscale().raw().toBuffer(),
    sharp(dHRaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 6 * u)).grayscale().raw().toBuffer(),
  ]);
  const [aW, hW, aS] = await Promise.all([
    sharp(A, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(2, 10 * u)).raw().toBuffer(),
    sharp(Hadj, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(2, 10 * u)).raw().toBuffer(),
    // Median, not blur: it smooths the carpet grain but keeps the patch's
    // sharp edges, so no light/dark outline is left where the patch was.
    sharp(A, { raw: { width: fw, height: fh, channels: 3 } }).median(Math.max(3, 2 * Math.round(3 * u) + 1)).raw().toBuffer(),
  ]);
  // Candidate relit areas, found on a quarter-size grid.
  const q = 4, qw = Math.max(1, Math.floor(fw / q)), qh = Math.max(1, Math.floor(fh / q));
  let cand = new Uint8Array(qw * qh);
  const near = new Uint8Array(qw * qh);
  for (let qy = 0; qy < qh; qy++) for (let qx = 0; qx < qw; qx++) {
    const i = qy * q * fw + qx * q, k = qy * qw + qx;
    if (coreA[i] > 128) continue;
    if (zoneHard[i] >= 128 || solidA[i] >= 128) near[k] = 1;
    const a0 = aW[i * 3], a1 = aW[i * 3 + 1], a2 = aW[i * 3 + 2];
    const h0 = hW[i * 3], h1 = hW[i * 3 + 1], h2 = hW[i * 3 + 2];
    const la = (a0 + a1 + a2) / 3, lh = (h0 + h1 + h2) / 3;
    const sa = a0 + a1 + a2 || 1, sh = h0 + h1 + h2 || 1;
    const chroma = Math.max(Math.abs(a0 / sa - h0 / sh), Math.abs(a1 / sa - h1 / sh), Math.abs(a2 / sa - h2 / sh));
    const r = lh / Math.max(1, la);
    const brighterThanRoom = la >= aRoom[i] * SUN_PATCH_MIN_BRIGHTNESS;
    const lightingOnly = dH[i] <= dA[i] * 1.6 + 6;
    if (la >= 70 && r >= 0.45 && r <= 0.85 && chroma <= 0.1 && brighterThanRoom && lightingOnly) cand[k] = 1;
  }
  cand = erode(dilate(cand, qw, qh, 2), qw, qh, 2);
  const region = new Uint8Array(qw * qh);
  const minArea = Math.round(qw * qh * 0.002);
  for (const piece of labelComponents(cand, qw, qh)) {
    if (piece.pixels.length < minArea) continue;
    if (!piece.pixels.some((k) => near[k])) continue; // only patches next to the furniture
    // Not at the photo's side edges, where curtains and side walls are (a
    // curtain Gemini nudged at the edge read as a "patch" — Bedroom 12).
    const sideMargin = Math.max(2, Math.round(qw * 0.04));
    if (piece.x1 <= sideMargin || piece.x2 >= qw - 1 - sideMargin) continue;
    for (const k of piece.pixels) region[k] = 1;
  }
  const regionPct = ratioOf(region) * 100;
  if (regionPct === 0) return { buffer: safe, regionPctOfImage: 0, regionMask: null as Buffer | null };
  const grown = dilate(region, qw, qh, 3);
  const regionPx = Buffer.alloc(qw * qh);
  for (let k = 0; k < qw * qh; k++) regionPx[k] = grown[k] ? 255 : 0;
  const regionSoft = await sharp(regionPx, { raw: { width: qw, height: qh, channels: 1 } })
    .resize(fw, fh, { fit: "fill" })
    .blur(Math.max(1, 6 * u))
    .grayscale()
    .raw()
    .toBuffer();
  const out = Buffer.from(A);
  // The bright patch itself (original clearly brighter than the blend's light).
  const patch = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) {
    const m = (regionSoft[i] / 255) * (1 - coreA[i] / 255);
    if (m <= 0) continue;
    const la = aS[i * 3] + aS[i * 3 + 1] + aS[i * 3 + 2], lh = hW[i * 3] + hW[i * 3 + 1] + hW[i * 3 + 2];
    if (m > 0.5 && solidA[i] < 128 && la > lh * 1.15) patch[i] = 255;
    for (let c = 0; c < 3; c++) {
      // Broad light from the blend, fine texture from the original.
      const f = Math.min(1, Math.max(0.35, (hW[i * 3 + c] + 1) / (aS[i * 3 + c] + 1)));
      out[i * 3 + c] = Math.round(A[i * 3 + c] * (1 - m + m * f));
    }
  }
  // Second step: match the old patch to the real floor right around it (the
  // blend can leave it a touch lighter, showing a faint rectangle). The
  // surrounding floor's colour is spread into the patch (furniture and the
  // patch itself excluded) and the patch is scaled to match — darkening only.
  // Include the patch's soft edge and the thin shade lines inside it (window
  // frame shadows between sun squares), otherwise they show as faint outlines.
  let patchBin = new Uint8Array(N);
  for (let i = 0; i < N; i++) patchBin[i] = patch[i] ? 1 : 0;
  const rClose = Math.max(2, Math.round(8 * u));
  patchBin = erode(dilate(patchBin, fw, fh, rClose), fw, fh, rClose);
  patchBin = dilate(patchBin, fw, fh, Math.max(1, Math.round(2.5 * u)));
  for (let i = 0; i < N; i++) patch[i] = patchBin[i] && coreA[i] < 128 ? 255 : 0;
  const patchGrown = await sharp(patch, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 1.5 * u)).grayscale().raw().toBuffer();
  const known = Buffer.alloc(N, 0);
  const knownRgb = Buffer.alloc(N * 3, 0);
  for (let i = 0; i < N; i++) {
    if (patchGrown[i] > 8 || solidA[i] > 8) continue;
    known[i] = 255;
    for (let c = 0; c < 3; c++) knownRgb[i * 3 + c] = out[i * 3 + c];
  }
  const [num, den, oMed] = await Promise.all([
    sharp(knownRgb, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(2, 15 * u)).raw().toBuffer(),
    sharp(known, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(2, 15 * u)).grayscale().raw().toBuffer(),
    sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).median(Math.max(3, 2 * Math.round(3 * u) + 1)).raw().toBuffer(),
  ]);
  const patchSoft = await sharp(patch, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 2 * u)).grayscale().raw().toBuffer();
  for (let i = 0; i < N; i++) {
    const m = (patchSoft[i] / 255) * (1 - coreA[i] / 255);
    if (m <= 0 || den[i] < 20) continue;
    for (let c = 0; c < 3; c++) {
      // num/den = average surrounding floor colour (the known weight is 255).
      const target = (num[i * 3 + c] * 255) / den[i];
      const f = Math.min(1, Math.max(0.6, (target + 1) / (oMed[i * 3 + c] + 1)));
      out[i * 3 + c] = Math.round(out[i * 3 + c] * (1 - m + m * f));
    }
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    regionPctOfImage: Number(regionPct.toFixed(1)),
    regionMask: await sharp(regionPx, { raw: { width: qw, height: qh, channels: 1 } }).png().toBuffer(),
  };
}

// Checked blend. Uses Gemini's blend itself as the final (its shadows and
// lighting are the most natural), but first checks it against the safe
// composite, patch by patch, everywhere except the furniture:
//  - each small patch may shift a few pixels and change brightness/contrast
//    (Gemini redraws the whole picture and relights it) without failing;
//  - a patch fails when its content changed: a line/edge that isn't in the
//    safe composite, or one that has gone (window, door, downlight, power
//    point, corbel...). Near the furniture (shadow zone) Gemini may also
//    darken — that's a shadow — but not brighten or add shapes.
// Failed patches are repaired with the safe composite's pixels, relit to match
// the blend's light around them. If too much fails, the caller falls back.
export const BLEND_MAX_REPAIR_PCT = Number(process.env.BLEND_MAX_REPAIR_PCT || 8);
export async function checkBlend(safe: Buffer, blend: Buffer, furniture: Uint8Array, zone: Uint8Array, w: number, h: number) {
  const meta = await sharp(safe).metadata();
  const fw = meta.width || 0, fh = meta.height || 0;
  const N = fw * fh;
  // ── Analysis at 800px wide, lightly blurred (carpet grain etc. ignored).
  const AW = 800, AH = Math.max(1, Math.round((AW * fh) / fw));
  const [aGs, hGs, aC, hC, furnA, zoneA] = await Promise.all([
    sharp(safe).removeAlpha().resize(AW, AH, { fit: "fill" }).grayscale().blur(1.2).raw().toBuffer(),
    sharp(blend).removeAlpha().resize(AW, AH, { fit: "fill" }).grayscale().blur(1.2).raw().toBuffer(),
    sharp(safe).removeAlpha().resize(AW, AH, { fit: "fill" }).blur(1.2).raw().toBuffer(),
    sharp(blend).removeAlpha().resize(AW, AH, { fit: "fill" }).blur(1.2).raw().toBuffer(),
    sharp(await maskToPng(furniture, w, h)).resize(AW, AH, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(await maskToPng(zone, w, h)).resize(AW, AH, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);
  // Shapes and lines are compared on DETAIL images (image minus a blurred
  // copy), so smooth light changes — a lamp's glow, a soft shadow, Gemini's
  // general relighting — don't count; colour/brightness jumps are checked
  // separately below.
  const [aLow, hLow] = await Promise.all([
    sharp(aGs, { raw: { width: AW, height: AH, channels: 1 } }).blur(4).grayscale().raw().toBuffer(),
    sharp(hGs, { raw: { width: AW, height: AH, channels: 1 } }).blur(4).grayscale().raw().toBuffer(),
  ]);
  const aG = new Float32Array(AW * AH), hG = new Float32Array(AW * AH);
  for (let i = 0; i < AW * AH; i++) { aG[i] = aGs[i] - aLow[i]; hG[i] = hGs[i] - hLow[i]; }
  // Overall brightness change of the blend (for the "only darker" test).
  let sa = 0, sh = 0;
  for (let i = 0; i < AW * AH; i++) if (furnA[i] < 128 && zoneA[i] < 128) { sa += aGs[i]; sh += hGs[i]; }
  const gain = sa > 0 ? sh / sa : 1;
  const T = 24, STEP = 12, MAXS = 3;
  const suspect = new Uint8Array(AW * AH);
  let checked = 0, failed = 0;
  const reasons = { appeared_or_gone: 0, content_changed: 0, brightened_near_furniture: 0, colour_changed: 0 };
  // Per-patch average colour (safe and blend), for the colour-jump test.
  const GX = Math.floor((AW - T - 2 * MAXS) / STEP) + 1, GY = Math.floor((AH - T - 2 * MAXS) / STEP) + 1;
  const tileOk = new Uint8Array(GX * GY), tileZone = new Uint8Array(GX * GY), tileFailed = new Uint8Array(GX * GY);
  const tileRatio = new Float32Array(GX * GY * 3);
  // How far Gemini's blend is shifted at each patch (sub-pixel), so repairs
  // can be moved into line with it — otherwise repaired areas show doubled
  // edges where Gemini's redraw sits a pixel or two off.
  const shiftX = new Float32Array(GX * GY), shiftY = new Float32Array(GX * GY), shiftW = new Float32Array(GX * GY);
  for (let gy = 0, ty = MAXS; gy < GY; gy++, ty += STEP) {
    for (let gx = 0, tx = MAXS; gx < GX; gx++, tx += STEP) {
      let fCount = 0, zCount = 0, ma = 0, qa = 0;
      for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) {
        const i = y * AW + x;
        if (furnA[i] >= 128) fCount++;
        if (zoneA[i] >= 128) zCount++;
        ma += aG[i]; qa += aG[i] * aG[i];
      }
      const n = T * T;
      if (fCount > n * 0.3) continue; // furniture: Gemini may restyle it
      checked++;
      const inZone = zCount > n * 0.3;
      const g = gy * GX + gx;
      tileOk[g] = 1;
      tileZone[g] = inZone ? 1 : 0;
      {
        const sumA = [0, 0, 0], sumH = [0, 0, 0];
        for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) {
          const i = (y * AW + x) * 3;
          for (let c = 0; c < 3; c++) { sumA[c] += aC[i + c]; sumH[c] += hC[i + c]; }
        }
        for (let c = 0; c < 3; c++) tileRatio[g * 3 + c] = (sumH[c] / n + 2) / (sumA[c] / n + 2);
      }
      ma /= n;
      const stdA = Math.sqrt(Math.max(0, qa / n - ma * ma));
      // Best match over small shifts (normalised correlation: ignores brightness/contrast).
      let best = -2, bestStdH = 0, bestDx = 0, bestDy = 0;
      const nccAt = new Float32Array((2 * MAXS + 1) ** 2);
      for (let dy = -MAXS; dy <= MAXS; dy++) for (let dx = -MAXS; dx <= MAXS; dx++) {
        let mh = 0, qh = 0, cr = 0;
        for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) {
          const v = hG[(y + dy) * AW + x + dx];
          mh += v; qh += v * v; cr += v * aG[y * AW + x];
        }
        mh /= n;
        const stdH = Math.sqrt(Math.max(0, qh / n - mh * mh));
        const ncc = stdA > 0.5 && stdH > 0.5 ? (cr / n - ma * mh) / (stdA * stdH) : stdA <= 0.5 && stdH <= 0.5 ? 1 : 0;
        nccAt[(dy + MAXS) * (2 * MAXS + 1) + dx + MAXS] = ncc;
        if (ncc > best) { best = ncc; bestStdH = stdH; bestDx = dx; bestDy = dy; }
      }
      if (stdA >= 4 && best > 0.7) {
        // Parabola through the best match and its neighbours -> sub-pixel shift.
        const at = (dx: number, dy: number) => nccAt[(dy + MAXS) * (2 * MAXS + 1) + dx + MAXS];
        const refine = (m: number, c: number, p2: number) => {
          const den = m - 2 * c + p2;
          return Math.abs(den) > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p2)) / den)) : 0;
        };
        const fx = Math.abs(bestDx) < MAXS ? refine(at(bestDx - 1, bestDy), best, at(bestDx + 1, bestDy)) : 0;
        const fy = Math.abs(bestDy) < MAXS ? refine(at(bestDx, bestDy - 1), best, at(bestDx, bestDy + 1)) : 0;
        shiftX[g] = bestDx + fx;
        shiftY[g] = bestDy + fy;
        shiftW[g] = 1;
      }
      const hi = Math.max(stdA, bestStdH), lo = Math.min(stdA, bestStdH);
      let reason: keyof typeof reasons | null = null;
      if (hi < 2.5) reason = null; // both plain
      else if (lo / hi < 0.35 && hi > 4) reason = "appeared_or_gone";
      else if (lo >= 4 && best < (inZone ? 0.3 : 0.5)) reason = "content_changed";
      if (reason && inZone) {
        // Near furniture, a darker blend is a shadow, not a change.
        let brighter = 0;
        for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) {
          if (hGs[(y + bestDy) * AW + x + bestDx] > aGs[y * AW + x] * gain + 12) brighter++;
        }
        reason = brighter > n * 0.05 ? "brightened_near_furniture" : null;
      }
      if (!reason) continue;
      failed++;
      tileFailed[g] = 1;
      reasons[reason]++;
      for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) if (furnA[y * AW + x] < 128) suspect[y * AW + x] = 1;
    }
  }
  // Colour jump: a patch whose colour/brightness change differs sharply from
  // the patches around it (Gemini's relighting is smooth; a new door, a
  // painted-over window or a recoloured wall isn't). Near furniture, darker
  // than the surroundings is allowed (shadow).
  const RAD = 5;
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    const g = gy * GX + gx;
    if (!tileOk[g] || tileFailed[g]) continue;
    let worst = 0, darkerOnly = true;
    const devs: number[] = [];
    for (let c = 0; c < 3; c++) {
      const vals: number[] = [];
      for (let yy = Math.max(0, gy - RAD); yy <= Math.min(GY - 1, gy + RAD); yy++) for (let xx = Math.max(0, gx - RAD); xx <= Math.min(GX - 1, gx + RAD); xx++) {
        const k = yy * GX + xx;
        if (k !== g && tileOk[k]) vals.push(tileRatio[k * 3 + c]);
      }
      if (vals.length < 8) { worst = 0; break; }
      vals.sort((p, q) => p - q);
      const med = vals[Math.floor(vals.length / 2)];
      const dev = Math.log(tileRatio[g * 3 + c] / med);
      devs.push(dev);
      if (dev > 0) darkerOnly = false;
      worst = Math.max(worst, Math.abs(dev));
    }
    if (worst < Math.log(1.3)) continue;
    // A shadow darkens all colours about equally; a new brown door doesn't.
    const sameColour = devs.length === 3 && Math.max(...devs) - Math.min(...devs) < Math.log(1.12);
    if (tileZone[g] && darkerOnly && sameColour) continue;
    failed++;
    reasons.colour_changed++;
    const ty = MAXS + gy * STEP, tx = MAXS + gx * STEP;
    for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) if (furnA[y * AW + x] < 128) suspect[y * AW + x] = 1;
  }
  const repairPct = checked ? (failed / checked) * 100 : 0;
  // Furniture: the blend should only change its shading, not restyle it.
  // Checked patch by patch (furniture pieces often touch — a table on a rug
  // on a sofa is one traced shape): a furniture patch whose COLOUR changed (a
  // wooden table turned grey) is taken from the app-built final. Shading
  // keeps the colour; a lamp Gemini switched on gets warmer but also clearly
  // brighter, so that glow is allowed.
  let furnitureChangedPatches = 0, furniturePatches = 0;
  for (let ty = 0; ty + T <= AH; ty += STEP) {
    for (let tx = 0; tx + T <= AW; tx += STEP) {
      let fCount = 0;
      const sumA = [0, 0, 0], sumH = [0, 0, 0];
      for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) {
        const i = y * AW + x;
        if (furnA[i] < 128) continue;
        fCount++;
        for (let c = 0; c < 3; c++) { sumA[c] += aC[i * 3 + c]; sumH[c] += hC[i * 3 + c]; }
      }
      if (fCount < T * T * 0.6) continue;
      furniturePatches++;
      const tA = sumA[0] + sumA[1] + sumA[2] || 1, tH = sumH[0] + sumH[1] + sumH[2] || 1;
      const chromaShift = Math.max(...[0, 1, 2].map((c) => Math.abs(sumA[c] / tA - sumH[c] / tH)));
      const brighter = tH / tA / (gain || 1);
      if (chromaShift <= 0.05 || brighter > 1.15) continue;
      furnitureChangedPatches++;
      for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) if (furnA[y * AW + x] >= 128) suspect[y * AW + x] = 1;
    }
  }
  const furnitureChanged = { patches: furniturePatches, restyledPatches: furnitureChangedPatches };
  // Smooth shift map: average of reliable patch shifts nearby (failed patches
  // excluded), spread to fill gaps.
  const smoothShift = (src: Float32Array) => {
    let val = new Float32Array(GX * GY), wt = new Float32Array(GX * GY);
    for (let g = 0; g < GX * GY; g++) if (shiftW[g] && !tileFailed[g]) { val[g] = src[g]; wt[g] = 1; }
    for (let pass = 0; pass < 6; pass++) {
      const nv = new Float32Array(GX * GY), nw = new Float32Array(GX * GY);
      for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
        let sv = 0, sw = 0;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(GY - 1, gy + 2); yy++) for (let xx = Math.max(0, gx - 2); xx <= Math.min(GX - 1, gx + 2); xx++) {
          sv += val[yy * GX + xx] * wt[yy * GX + xx];
          sw += wt[yy * GX + xx];
        }
        nv[gy * GX + gx] = sw > 0 ? sv / sw : 0;
        nw[gy * GX + gx] = Math.min(1, sw);
      }
      val = nv; wt = nw;
    }
    return val;
  };
  const sxG = smoothShift(shiftX), syG = smoothShift(shiftY);

  // ── Repair at full size.
  const grown = dilate(suspect, AW, AH, Math.round(T / 3));
  const sPx = Buffer.alloc(AW * AH);
  for (let i = 0; i < AW * AH; i++) sPx[i] = grown[i] ? 255 : 0;
  const u = fw / 1000;
  const [A, H, rA, okA] = await Promise.all([
    sharp(safe).removeAlpha().raw().toBuffer(),
    sharp(blend).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(sPx, { raw: { width: AW, height: AH, channels: 1 } }).resize(fw, fh, { fit: "fill" }).blur(Math.max(1, 6 * u)).grayscale().raw().toBuffer(),
    sharp(sPx, { raw: { width: AW, height: AH, channels: 1 } }).resize(fw, fh, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);
  // Light of the blend around each repaired patch, measured only where the
  // two images agree, so the repaired pixels take on Gemini's lighting.
  const okMask = Buffer.alloc(N), aOk = Buffer.alloc(N * 3), hOk = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    if (okA[i] > 0) continue;
    okMask[i] = 255;
    for (let c = 0; c < 3; c++) { aOk[i * 3 + c] = A[i * 3 + c]; hOk[i * 3 + c] = H[i * 3 + c]; }
  }
  const sig = Math.max(3, 40 * u);
  const [aB, hB, wB] = await Promise.all([
    sharp(aOk, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
    sharp(hOk, { raw: { width: fw, height: fh, channels: 3 } }).blur(sig).raw().toBuffer(),
    sharp(okMask, { raw: { width: fw, height: fh, channels: 1 } }).blur(sig).grayscale().raw().toBuffer(),
  ]);
  // Whole-image lighting change, used deep inside large repairs where there
  // is too little agreeing area nearby to measure the local light.
  const gSum = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < N; i++) if (okMask[i]) for (let c = 0; c < 3; c++) { gSum[c] += A[i * 3 + c]; gSum[c + 3] += H[i * 3 + c]; }
  const gGlobal = [0, 1, 2].map((c) => (gSum[c] > 0 ? Math.min(1.6, Math.max(0.6, gSum[c + 3] / gSum[c])) : 1));
  const out = Buffer.from(H);
  const view = Buffer.from(H);
  const k = AW / fw; // full-size pixels -> analysis pixels
  const gridAt = (G: Float32Array, ax: number, ay: number) => {
    const fx = Math.max(0, Math.min(GX - 1, (ax - MAXS - T / 2) / STEP));
    const fy = Math.max(0, Math.min(GY - 1, (ay - MAXS - T / 2) / STEP));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(GX - 1, x0 + 1), y1 = Math.min(GY - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    return (G[y0 * GX + x0] * (1 - tx) + G[y0 * GX + x1] * tx) * (1 - ty) + (G[y1 * GX + x0] * (1 - tx) + G[y1 * GX + x1] * tx) * ty;
  };
  for (let i = 0; i < N; i++) {
    const r = rA[i] / 255;
    if (r <= 0) continue;
    // Safe-composite pixel moved into line with the blend (bilinear sample).
    const x = i % fw, y = (i - x) / fw;
    const sx = Math.max(0, Math.min(fw - 1.001, x - gridAt(sxG, x * k, y * k) / k));
    const sy = Math.max(0, Math.min(fh - 1.001, y - gridAt(syG, x * k, y * k) / k));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), ax = sx - x0, ay = sy - y0;
    const i00 = (y0 * fw + x0) * 3, i01 = i00 + 3, i10 = i00 + fw * 3, i11 = i10 + 3;
    for (let c = 0; c < 3; c++) {
      // Local light where enough agreeing area is nearby, else the global one.
      const conf = Math.min(1, wB[i] / 255 / 0.3);
      const gLocal = wB[i] > 2 ? Math.min(1.6, Math.max(0.6, (hB[i * 3 + c] + 1) / (aB[i * 3 + c] + 1))) : gGlobal[c];
      const g = gGlobal[c] + (gLocal - gGlobal[c]) * conf;
      const a = (A[i00 + c] * (1 - ax) + A[i01 + c] * ax) * (1 - ay) + (A[i10 + c] * (1 - ax) + A[i11 + c] * ax) * ay;
      out[i * 3 + c] = Math.round(Math.min(255, a * g) * r + H[i * 3 + c] * (1 - r));
    }
    if (okA[i] > 0) {
      view[i * 3] = Math.round(view[i * 3] * 0.45 + 255 * 0.55);
      view[i * 3 + 1] = Math.round(view[i * 3 + 1] * 0.45);
      view[i * 3 + 2] = Math.round(view[i * 3 + 2] * 0.45);
    }
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    repairedView: await sharp(view, { raw: { width: fw, height: fh, channels: 3 } }).jpeg({ quality: 88 }).toBuffer(),
    patchesChecked: checked,
    patchesRepaired: failed,
    repairPct: Number(repairPct.toFixed(1)),
    reasons,
    furnitureChanged,
    tooMuchChanged: repairPct > BLEND_MAX_REPAIR_PCT,
  };
}

// Phase 3. Starts from the SAFE composite (original room + furniture, no
// shadows) and only borrows from Gemini's blended image:
//  - around the furniture: DARKENING only, and only where Gemini's change
//    looks like a shadow on the same surface (same colour and texture, just
//    darker), decided by neighbourhood so it comes out smooth;
//  - on the furniture itself: Gemini's broad lighting (a soft brightness
//    change), never its pixels, so the furniture stays crisp and in place.
// Nothing outside the shadow zone and the furniture can change at all, so a
// window, door or wall Gemini altered in its blend can never come through.
export const HARM_MAX_FURNITURE_BRIGHTEN = Number(process.env.HARM_MAX_FURNITURE_BRIGHTEN || 1.03);
export const HARM_SHADOW_SOFTEN = Math.max(1, Number(process.env.HARM_SHADOW_SOFTEN || 12));
export async function compositeHarmonise(safe: Buffer, harmonised: Buffer, solidPng: Buffer, corePng: Buffer, zonePng: Buffer) {
  const meta = await sharp(safe).metadata();
  const fw = meta.width || 0, fh = meta.height || 0;
  const N = fw * fh;
  const u = fw / 1000; // blur sizes scale with the output width
  const [A, H, solidA, coreA, zoneHard, zoneSoft] = await Promise.all([
    sharp(safe).removeAlpha().raw().toBuffer(),
    sharp(harmonised).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(solidPng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
    sharp(corePng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
    sharp(zonePng).resize(fw, fh, { fit: "fill" }).grayscale().raw().toBuffer(),
    // Wide soft fade so the borrowed shadow has no visible edge.
    sharp(zonePng).resize(fw, fh, { fit: "fill" }).blur(Math.max(1, 12 * u)).grayscale().raw().toBuffer(),
  ]);
  // Overall colour/brightness shift of Gemini's blend, measured far from the
  // furniture, removed first so a general re-light is not mistaken for shadow.
  const sums = [0, 0, 0, 0, 0, 0];
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (solidA[i] > 12 || zoneHard[i] > 12) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] += A[i * 3 + c];
      sums[c + 3] += H[i * 3 + c];
    }
    count++;
  }
  const gains = [0, 1, 2].map((c) => (count > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));
  const Hadj = Buffer.alloc(N * 3);
  for (let i = 0; i < N * 3; i++) Hadj[i] = Math.min(255, Math.round(H[i] * gains[i % 3]));

  const [aB, hB] = await Promise.all([
    sharp(A, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(0.6, 1.5 * u)).raw().toBuffer(),
    sharp(Hadj, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(0.6, 1.5 * u)).raw().toBuffer(),
  ]);
  const lum = (buf: Buffer) => {
    const out = Buffer.alloc(N);
    for (let i = 0; i < N; i++) out[i] = Math.round((buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3);
    return out;
  };
  const aLum = lum(A), hLum = lum(Hadj);
  // Furniture lighting is measured from the furniture's own pixels only
  // (weighted by its alpha). Measured over the plain neighbourhood, Gemini's
  // brighter wall right beside a piece leaked in and brightened the piece's
  // soft edge, leaving a pale glow around it (Bedroom 12's plant).
  const aLumF = Buffer.alloc(N), hLumF = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const wgt = coreA[i] / 255;
    aLumF[i] = Math.round(aLum[i] * wgt);
    hLumF[i] = Math.round(hLum[i] * wgt);
  }
  const [aLumBlur, hLumBlur, aLumWide, hLumWide, fWide] = await Promise.all([
    sharp(aLum, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * u)).grayscale().raw().toBuffer(),
    sharp(hLum, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * u)).grayscale().raw().toBuffer(),
    sharp(aLumF, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(2, 10 * u)).grayscale().raw().toBuffer(),
    sharp(hLumF, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(2, 10 * u)).grayscale().raw().toBuffer(),
    sharp(coreA, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(2, 10 * u)).grayscale().raw().toBuffer(),
  ]);
  const texRaw = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const r = aLumBlur[i] > 0 ? hLumBlur[i] / aLumBlur[i] : 1;
    texRaw[i] = Math.min(255, Math.round(Math.abs(hLum[i] - hLumBlur[i] - (aLum[i] - aLumBlur[i]) * r) * 4));
  }
  const tex = await sharp(texRaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * u)).grayscale().raw().toBuffer();

  // Shadow test, outside the furniture core.
  const known = Buffer.alloc(N, 0);
  const knownFactor = Buffer.alloc(N, 0);
  let zonePixels = 0, shadowPixels = 0, coreN = 0, coreDiffSum = 0;
  for (let i = 0; i < N; i++) {
    const t0 = aB[i * 3], t1 = aB[i * 3 + 1], t2 = aB[i * 3 + 2];
    const h0 = hB[i * 3], h1 = hB[i * 3 + 1], h2 = hB[i * 3 + 2];
    if (coreA[i] > 200) {
      // How closely Gemini kept the furniture itself (if it redrew or moved
      // it, its lighting can't be borrowed safely).
      coreN++;
      coreDiffSum += Math.max(Math.abs(t0 - h0), Math.abs(t1 - h1), Math.abs(t2 - h2));
      continue;
    }
    if (zoneHard[i] < 8 && solidA[i] < 8) continue;
    if (zoneHard[i] >= 8) zonePixels++;
    const la = (t0 + t1 + t2) / 3, lh = (h0 + h1 + h2) / 3;
    const sa = t0 + t1 + t2 || 1, sh = h0 + h1 + h2 || 1;
    const chroma = Math.max(Math.abs(t0 / sa - h0 / sh), Math.abs(t1 / sa - h1 / sh), Math.abs(t2 / sa - h2 / sh));
    const ratio = lh / Math.max(1, la);
    const chromaLimit = ratio < 0.65 ? 0.09 : 0.05;
    if (la >= 15 && ratio >= 0.2 && ratio <= 0.98 && chroma <= chromaLimit && tex[i] <= 20) {
      known[i] = 255;
      knownFactor[i] = Math.round(Math.max(1 - HARM_MAX_SHADOW, ratio) * 255);
      if (zoneHard[i] >= 8) shadowPixels++;
    } else if (la >= 15 && Math.abs(ratio - 1) <= 0.02 && chroma <= 0.05) {
      // Unchanged surface: counts as "no shadow here" in the average.
      known[i] = 255;
      knownFactor[i] = 255;
    }
  }
  const [numBlur, denBlur, denWide] = await Promise.all([
    sharp(knownFactor, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 5 * u)).grayscale().raw().toBuffer(),
    sharp(known, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 5 * u)).grayscale().raw().toBuffer(),
    // Wide version of the agreement map, so the yes/no decision itself is soft
    // and can't flicker on and off across the carpet (patchy shadows).
    sharp(known, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(2, 12 * u)).grayscale().raw().toBuffer(),
  ]);
  const coreDiff = coreN ? coreDiffSum / coreN : 0;
  // Calibrate: at or below this average difference Gemini kept the furniture.
  const furnitureKept = coreN > 0 && coreDiff <= 25;

  // Shadow: neighbourhood-average darkening where most of the wider area
  // agrees it is a shadow (ramps in between 30% and 60% agreement), then the
  // whole shadow map is softened once more so it has no blotches or hard edges.
  // The map is softened enough that only gentle shading comes across (Gemini
  // redraws objects a few pixels off in its blend; a sharp map copied those
  // shifted shapes onto the wall). It is softened only from the area around
  // the furniture — the furniture itself doesn't count as "no shadow" — so
  // the shadow stays strongest right against the piece instead of leaving a
  // pale rim between the furniture and its shadow.
  const darkRaw = Buffer.alloc(N, 0);
  const darkW = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) {
    const ca = coreA[i] / 255, sa = solidA[i] / 255, za = zoneSoft[i] / 255;
    const avg = denBlur[i] > 4 ? Math.min(1, numBlur[i] / denBlur[i]) : 1;
    const agreement = Math.min(1, Math.max(0, (denWide[i] / 255 - 0.3) / 0.3));
    const where = Math.max(za, sa);
    const w = 1 - ca;
    darkW[i] = Math.round(w * 255);
    darkRaw[i] = Math.round(Math.min(HARM_MAX_SHADOW, (1 - avg) * agreement * where) * w * 255);
  }
  const darkSig = Math.max(1, HARM_SHADOW_SOFTEN * u);
  const [darkNum, darkDen] = await Promise.all([
    sharp(darkRaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(darkSig).grayscale().raw().toBuffer(),
    sharp(darkW, { raw: { width: fw, height: fh, channels: 1 } }).blur(darkSig).grayscale().raw().toBuffer(),
  ]);
  const darkMap = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) darkMap[i] = darkDen[i] > 4 ? Math.min(255, Math.round((darkNum[i] * 255) / darkDen[i])) : 0;

  const out = Buffer.alloc(N * 3);
  let maxDark = 0, lightingChangedPx = 0;
  for (let i = 0; i < N; i++) {
    const ca = coreA[i] / 255;
    // Keep the furniture's own pixels free of borrowed floor shadow.
    const dark = (darkMap[i] / 255) * (1 - ca);
    if (dark > maxDark) maxDark = dark;
    // Furniture lighting: Gemini's broad brightness change on the furniture.
    let light = 1;
    if (furnitureKept && ca > 0 && fWide[i] > 8) {
      // Darken freely (shading), brighten only a touch: where Gemini redrew a
      // piece a few pixels off (plant leaves), "brighter in the blend" is just
      // wall showing through, and brightening it left a pale glow.
      const r = Math.min(HARM_MAX_FURNITURE_BRIGHTEN, Math.max(0.8, (hLumWide[i] + 1) / (aLumWide[i] + 1)));
      light = 1 + (r - 1) * ca;
      if (Math.abs(light - 1) > 0.03) lightingChangedPx++;
    }
    const f = (1 - dark) * light;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, Math.round(A[i * 3 + c] * f));
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    colourGains: gains.map((g2) => Number(g2.toFixed(3))),
    shadowPctOfZone: zonePixels ? Number(((shadowPixels / zonePixels) * 100).toFixed(1)) : 0,
    strongestShadowPct: Math.round(maxDark * 100),
    furnitureDiffVsBlend: Number(coreDiff.toFixed(1)),
    furnitureLightingUsed: furnitureKept,
    furnitureLightingChangedPctOfImage: Number(((lightingChangedPx / N) * 100).toFixed(1)),
  };
}

// ── Staged-first merge ───────────────────────────────────────────────────────

// Starts from the STAGED image, so Gemini's shadows, contact shading and room
// lighting stay exactly as rendered. Then, outside the furniture/kept art,
// every area where the ROOM ITSELF changed is reverted to the original photo:
//   unchanged (only lighting/texture noise) -> keep staged
//   looks like a shadow (same colour/texture, darker) -> keep staged
//   anything else (removed wall, new door/opening, added light, changed
//   frame, dropped wall art) -> revert to the original
// Decided by neighbourhood so carpet/tile texture noise doesn't trigger it.
// Reverted pieces are colour-matched to the staged lighting so they blend.
export async function compositeStagedFirst(original: Buffer, staged: Buffer, solidPng: Buffer, srcW: number, srcH: number) {
  const stagedMeta = await sharp(staged).metadata();
  const fw = stagedMeta.width || srcW;
  const fh = Math.round((fw * srcH) / srcW);
  const scale = fw / srcW;
  const N = fw * fh;
  const [orig, stg, solidA] = await Promise.all([
    sharp(original).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(solidPng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
  ]);
  // Overall lighting difference (original vs staged) on non-furniture areas.
  const sums = [0, 0, 0, 0, 0, 0];
  let count = 0;
  for (let i = 0; i < N; i++) {
    if (solidA[i] > 12) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] += orig[i * 3 + c];
      sums[c + 3] += stg[i * 3 + c];
    }
    count++;
  }
  const gains = [0, 1, 2].map((c) => (count > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));
  // Staged brought to the original's lighting, for comparison only.
  const stgCmp = Buffer.alloc(N * 3);
  for (let i = 0; i < N * 3; i++) stgCmp[i] = Math.min(255, Math.round(stg[i] * gains[i % 3]));
  const [oBlur, sBlur] = await Promise.all([
    sharp(orig, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(0.6, 1.5 * scale)).raw().toBuffer(),
    sharp(stgCmp, { raw: { width: fw, height: fh, channels: 3 } }).blur(Math.max(0.6, 1.5 * scale)).raw().toBuffer(),
  ]);
  // Texture comparison (same idea as the shadow test in compositeLayers).
  const lum = (buf: Buffer) => {
    const out = Buffer.alloc(N);
    for (let i = 0; i < N; i++) out[i] = Math.round((buf[i * 3] + buf[i * 3 + 1] + buf[i * 3 + 2]) / 3);
    return out;
  };
  const oLum = lum(orig), sLum = lum(stgCmp);
  const [oLumBlur, sLumBlur] = await Promise.all([
    sharp(oLum, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer(),
    sharp(sLum, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer(),
  ]);
  const texRaw = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const r = oLumBlur[i] > 0 ? sLumBlur[i] / oLumBlur[i] : 1;
    texRaw[i] = Math.min(255, Math.round(Math.abs(sLum[i] - sLumBlur[i] - (oLum[i] - oLumBlur[i]) * r) * 4));
  }
  const tex = await sharp(texRaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer();

  const changedRaw = Buffer.alloc(N, 0);
  for (let i = 0; i < N; i++) {
    if (solidA[i] > 200) continue;
    const o0 = oBlur[i * 3], o1 = oBlur[i * 3 + 1], o2 = oBlur[i * 3 + 2];
    const t0 = sBlur[i * 3], t1 = sBlur[i * 3 + 1], t2 = sBlur[i * 3 + 2];
    const diff = Math.max(Math.abs(o0 - t0), Math.abs(o1 - t1), Math.abs(o2 - t2));
    if (diff <= 14) continue; // unchanged
    const lo = (o0 + o1 + o2) / 3, ls = (t0 + t1 + t2) / 3;
    const so = o0 + o1 + o2 || 1, st = t0 + t1 + t2 || 1;
    const chroma = Math.max(Math.abs(o0 / so - t0 / st), Math.abs(o1 / so - t1 / st), Math.abs(o2 / so - t2 / st));
    const ratio = ls / Math.max(1, lo);
    const sameSurface = chroma <= 0.05 && tex[i] <= 20;
    if (sameSurface && lo >= 15 && ratio >= 0.15 && ratio <= 1.12) continue; // shadow or lighting change on the same surface
    changedRaw[i] = 255;
  }
  // Neighbourhood decision, then clean up: drop specks, grow slightly so the
  // whole changed feature is covered, soften the edge.
  const score = await sharp(changedRaw, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 4 * scale)).grayscale().raw().toBuffer();
  let revert = new Uint8Array(N);
  for (let i = 0; i < N; i++) revert[i] = score[i] > 110 && solidA[i] < 128 ? 1 : 0;
  revert = removeSmallComponents(revert, fw, fh, Math.round(N * 0.0005));
  revert = dilate(revert, fw, fh, Math.max(1, Math.round(fw * 0.005)));
  const revertPx = Buffer.alloc(N);
  for (let i = 0; i < N; i++) revertPx[i] = revert[i] ? 255 : 0;
  const revertA = await sharp(revertPx, { raw: { width: fw, height: fh, channels: 1 } }).blur(Math.max(1, 3 * scale)).grayscale().raw().toBuffer();

  const out = Buffer.alloc(N * 3);
  let reverted = 0;
  for (let i = 0; i < N; i++) {
    const r = (revertA[i] / 255) * (1 - solidA[i] / 255);
    if (r > 0.5) reverted++;
    for (let c = 0; c < 3; c++) {
      // Original brought to the staged lighting so the reverted piece blends.
      const o = Math.min(255, orig[i * 3 + c] / gains[c]);
      out[i * 3 + c] = Math.round(stg[i * 3 + c] * (1 - r) + o * r);
    }
  }
  // Panel: what was reverted (red) on the staged image.
  const vis = Buffer.from(stg);
  for (let i = 0; i < N; i++) {
    const r = (revertA[i] / 255) * (1 - solidA[i] / 255);
    if (r < 0.5) continue;
    vis[i * 3] = Math.round(vis[i * 3] * 0.4 + 255 * 0.6);
    vis[i * 3 + 1] = Math.round(vis[i * 3 + 1] * 0.4);
    vis[i * 3 + 2] = Math.round(vis[i * 3 + 2] * 0.4 + 40 * 0.6);
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    revertedView: await sharp(vis, { raw: { width: fw, height: fh, channels: 3 } }).jpeg({ quality: 88 }).toBuffer(),
    width: fw,
    height: fh,
    revertedPct: Number(((reverted / N) * 100).toFixed(1)),
  };
}

// Panel 3: furniture red, kept wall art blue, kept reflections purple,
// dropped art/reflections orange.
export async function layersOverlay(staged: Buffer, floor: Uint8Array, artKept: Uint8Array, artDropped: Uint8Array, w: number, h: number, reflKept?: Uint8Array): Promise<Buffer> {
  const raw = await sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const tint = (i: number, r: number, g2: number, b: number) => {
    raw[i * 3] = Math.round(raw[i * 3] * 0.45 + r * 0.55);
    raw[i * 3 + 1] = Math.round(raw[i * 3 + 1] * 0.45 + g2 * 0.55);
    raw[i * 3 + 2] = Math.round(raw[i * 3 + 2] * 0.45 + b * 0.55);
  };
  for (let i = 0; i < w * h; i++) {
    if (artDropped[i]) tint(i, 255, 140, 0);
    else if (reflKept && reflKept[i]) tint(i, 170, 60, 255);
    else if (artKept[i]) tint(i, 40, 110, 255);
    else if (floor[i]) tint(i, 255, 0, 80);
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

// ── Measurements and output images ──────────────────────────────────────────

// How much the raw Gemini output changed OUTSIDE the mask, compared with the
// original. High numbers = Gemini altered windows/walls/etc. (or shifted the
// framing) on its own — the things paste-back is there to undo.
export async function measureOutsideDrift(original: Buffer, staged: Buffer, mask: Uint8Array, w: number, h: number) {
  const [a, b] = await Promise.all([
    sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(),
  ]);
  let outside = 0, changed = 0, deltaSum = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) continue;
    outside++;
    const dr = Math.abs(a[i * 3] - b[i * 3]);
    const dg = Math.abs(a[i * 3 + 1] - b[i * 3 + 1]);
    const db = Math.abs(a[i * 3 + 2] - b[i * 3 + 2]);
    deltaSum += (dr + dg + db) / 3;
    if (Math.max(dr, dg, db) >= CHANGE_THRESHOLD) changed++;
  }
  return {
    meanAbsoluteDelta: Number((deltaSum / Math.max(1, outside)).toFixed(2)),
    changedPixelPct: Number(((changed / Math.max(1, outside)) * 100).toFixed(2)),
  };
}

export async function maskOverlay(original: Buffer, mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const raw = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    raw[i * 3] = Math.round(raw[i * 3] * 0.5 + 255 * 0.5);
    raw[i * 3 + 1] = Math.round(raw[i * 3 + 1] * 0.5);
    raw[i * 3 + 2] = Math.round(raw[i * 3 + 2] * 0.5 + 80 * 0.5);
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

export async function contactSheet(panels: Array<{ label: string; image: Buffer | null }>, srcW: number, srcH: number): Promise<Buffer> {
  const pw = 560;
  const ph = Math.round((pw * srcH) / srcW);
  const labelH = 36;
  const gap = 8;
  const width = panels.length * pw + (panels.length - 1) * gap;
  const layers: sharp.OverlayOptions[] = [];
  for (let i = 0; i < panels.length; i++) {
    const left = i * (pw + gap);
    const label = panels[i].label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const svg = `<svg width="${pw}" height="${labelH}"><rect width="100%" height="100%" fill="#222"/><text x="10" y="24" font-family="sans-serif" font-size="18" fill="#fff">${label}</text></svg>`;
    layers.push({ input: Buffer.from(svg), left, top: 0 });
    const img = panels[i].image
      ? await sharp(panels[i].image!).resize(pw, ph, { fit: "fill" }).png().toBuffer()
      : await sharp({ create: { width: pw, height: ph, channels: 3, background: "#555" } }).png().toBuffer();
    layers.push({ input: img, left, top: labelH });
  }
  return sharp({ create: { width, height: labelH + ph, channels: 3, background: "#000" } })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
}

export function approxOutputCost(usage: any): number | null {
  const tokens = Number(usage?.candidatesTokenCount);
  return Number.isFinite(tokens) ? Number(((tokens * OUTPUT_PRICE_PER_M) / 1_000_000).toFixed(4)) : null;
}

// Checks whether Gemini kept the room's geometry. The area outside the mask is
// split into tiles and each textured tile is compared with the staged image.
// A removed window only spoils a few tiles, but a reframed or re-shaped room
// spoils many — and paste-back cannot repair that.
export async function checkFraming(original: Buffer, staged: Buffer, mask: Uint8Array, w: number, h: number) {
  const sw = 480;
  const sh = Math.round((sw * h) / w);
  const [a, b, m] = await Promise.all([
    sharp(original).removeAlpha().resize(sw, sh, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(staged).removeAlpha().resize(sw, sh, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(await maskToPng(mask, w, h)).resize(sw, sh, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);
  // Match the staged image's overall brightness and contrast to the original
  // first (over the room, not the furniture), so a brighter or darker staged
  // image is not mistaken for a moved room. Without this a +16% brightness
  // change alone scored 19-29 on good results.
  {
    let ma = 0, qa = 0, mb = 0, qb = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      if (m[i] > 127) continue;
      ma += a[i]; qa += a[i] * a[i]; mb += b[i]; qb += b[i] * b[i]; n++;
    }
    if (n > 0) {
      ma /= n; mb /= n;
      const sa = Math.sqrt(Math.max(1e-6, qa / n - ma * ma)), sb = Math.sqrt(Math.max(1e-6, qb / n - mb * mb));
      const gain = sa / sb;
      for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(255, Math.round((b[i] - mb) * gain + ma)));
    }
  }
  const tile = 40, maxShift = 2;
  const diffs: number[] = [];
  let checked = 0, changed = 0;
  for (let ty = maxShift; ty + tile + maxShift <= sh; ty += tile) {
    for (let tx = maxShift; tx + tile + maxShift <= sw; tx += tile) {
      let masked = 0, mean = 0, sq = 0;
      for (let y = ty; y < ty + tile; y++) for (let x = tx; x < tx + tile; x++) {
        const i = y * sw + x;
        if (m[i] > 127) masked++;
        mean += a[i];
        sq += a[i] * a[i];
      }
      const n = tile * tile;
      const std = Math.sqrt(Math.max(0, sq / n - (mean / n) ** 2));
      if (masked > n * 0.1 || std < 6) continue; // furniture area, or a flat patch with nothing to line up
      const samples = (tile / 2) ** 2;
      const diffAt = (dx: number, dy: number) => {
        let sum = 0;
        for (let y = ty; y < ty + tile; y += 2) for (let x = tx; x < tx + tile; x += 2) sum += Math.abs(a[y * sw + x] - b[(y + dy) * sw + x + dx]);
        return sum / samples;
      };
      checked++;
      // A patch counts as changed when it no longer matches the original in
      // place. Allow a tiny nudge (Gemini's output is rarely pixel-exact),
      // then measure the leftover difference in grey levels.
      let bestNearby = Infinity;
      for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) bestNearby = Math.min(bestNearby, diffAt(dx, dy));
      diffs.push(bestNearby);
      if (bestNearby > CHANGED_TILE_DIFF) changed++;
    }
  }
  const changedPct = checked > 0 ? Number(((changed / checked) * 100).toFixed(1)) : 0;
  const sorted = [...diffs].sort((x, y) => x - y);
  const medianDiff = sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)) : 0;
  return { tilesChecked: checked, tilesChanged: changed, changedPct, medianDiff, framingChanged: checked >= 6 && medianDiff > REFRAMED_MEDIAN_DIFF };
}

// Camera-movement check: did Gemini zoom the view? Both images are reduced to
// brightness-independent structure edges, then the staged image is zoomed
// (0.86-1.14) and shifted (up to ~7%) to find its best fit on the original.
// It only counts a CLEAR zoom (>= 5%) with a real improvement in fit: on 79
// eye-checked baseline/staged pairs in Test Images the shift estimate and
// small zooms were unreliable (Gemini often returns a slightly different
// shape). Together with the brightness-matched framing check it caught all
// 51 reshaped pairs with 2 false alarms (framing alone: 50 and 1; camera
// check with any zoom or shift: 5 false alarms). Detection only — a moved
// room is re-staged, never warped back (Bedroom 05 could not be lined up by
// any zoom + shift: the perspective itself changed).
export const CAMERA_MOVED_MIN_GAIN = Number(process.env.CAMERA_MOVED_MIN_GAIN || 0.05);
export const CAMERA_MOVED_MIN_ZOOM = Number(process.env.CAMERA_MOVED_MIN_ZOOM || 0.05);
const ALIGN_W = 240;
// Which tile score decides the fit: a low percentile lets the room's unchanged
// structure (windows, corners, ceiling lines) decide, so furniture and local
// repaints (a removed wall) can't pull the estimate around.
const ALIGN_PERCENTILE = Number(process.env.ALIGN_PERCENTILE || 0.3);

async function structureEdges(buf: Buffer, h: number): Promise<Float32Array> {
  const g = await sharp(buf).removeAlpha().resize(ALIGN_W, h, { fit: "fill" }).greyscale().raw().toBuffer();
  let mean = 0, sq = 0;
  for (const v of g) { mean += v; sq += v * v; }
  mean /= g.length;
  const sd = Math.sqrt(Math.max(1e-6, sq / g.length - mean * mean));
  const f = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) f[i] = (g[i] - mean) / sd;
  const e = new Float32Array(g.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < ALIGN_W - 1; x++) {
    const i = y * ALIGN_W + x;
    e[i] = Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + ALIGN_W] - f[i - ALIGN_W]);
  }
  return e;
}

function alignmentScore(a: Float32Array, b: Float32Array, h: number, scale: number, dx: number, dy: number, step = 2): number {
  const cx = ALIGN_W / 2, cy = h / 2, T = 20;
  const tiles: number[] = [];
  for (let ty = 4; ty + T <= h - 4; ty += T) for (let tx = 4; tx + T <= ALIGN_W - 4; tx += T) {
    let sum = 0, n = 0, tex = 0;
    for (let y = ty; y < ty + T; y += step) for (let x = tx; x < tx + T; x += step) {
      const bx = Math.round(cx + (x - cx) * scale + dx), by = Math.round(cy + (y - cy) * scale + dy);
      if (bx < 1 || by < 1 || bx >= ALIGN_W - 1 || by >= h - 1) continue;
      const va = a[y * ALIGN_W + x];
      sum += Math.abs(va - b[by * ALIGN_W + bx]);
      tex += va;
      n++;
    }
    if (n > ((T * T) / (step * step)) * 0.8 && tex / n > 0.15) tiles.push(sum / n);
  }
  tiles.sort((p, q) => p - q);
  return tiles.length ? tiles[Math.floor(tiles.length * ALIGN_PERCENTILE)] : 0;
}

export type CameraAlignment = {
  identity: number; best: number; gain: number;
  scale: number; dxPct: number; dyPct: number; shiftPct: number;
  moved: boolean;
};

export async function checkCameraAlignment(original: Buffer, staged: Buffer): Promise<CameraAlignment> {
  const meta = await sharp(original).metadata();
  const h = Math.max(8, Math.round((ALIGN_W * (meta.height || 1)) / (meta.width || 1)));
  const [a, b] = await Promise.all([structureEdges(original, h), structureEdges(staged, h)]);
  // Coarse search on every 2nd pixel, then a fine search around the best fit,
  // then both the identity and the best fit re-scored on every pixel.
  let best = { score: alignmentScore(a, b, h, 1, 0, 0), scale: 1, dx: 0, dy: 0 };
  for (let sc = 0.86; sc <= 1.141; sc += 0.02) for (let dx = -18; dx <= 18; dx += 3) for (let dy = -12; dy <= 12; dy += 4) {
    const v = alignmentScore(a, b, h, sc, dx, dy);
    if (v < best.score) best = { score: v, scale: sc, dx, dy };
  }
  const coarse = { ...best };
  for (let sc = coarse.scale - 0.02; sc <= coarse.scale + 0.021; sc += 0.005) for (let dx = coarse.dx - 3; dx <= coarse.dx + 3; dx++) for (let dy = coarse.dy - 4; dy <= coarse.dy + 4; dy++) {
    const v = alignmentScore(a, b, h, sc, dx, dy);
    if (v < best.score) best = { score: v, scale: sc, dx, dy };
  }
  const identity = alignmentScore(a, b, h, 1, 0, 0, 1);
  best.score = Math.min(identity, alignmentScore(a, b, h, best.scale, best.dx, best.dy, 1));
  if (best.score === identity) best = { score: identity, scale: 1, dx: 0, dy: 0 };
  const gain = identity - best.score;
  const dxPct = (best.dx / ALIGN_W) * 100, dyPct = (best.dy / h) * 100;
  const shiftPct = Math.hypot(dxPct, dyPct);
  // Only a clear zoom counts: on real results the shift estimate is unreliable
  // and small zooms come from Gemini returning a slightly different shape.
  const moved = gain >= CAMERA_MOVED_MIN_GAIN && Math.abs(best.scale - 1) >= CAMERA_MOVED_MIN_ZOOM;
  const r = (v: number, d = 3) => Number(v.toFixed(d));
  return { identity: r(identity), best: r(best.score), gain: r(gain), scale: r(best.scale), dxPct: r(dxPct, 2), dyPct: r(dyPct, 2), shiftPct: r(shiftPct, 2), moved };
}


// Harmonise structure check: outside the given mask, does the final still show
// the original room? Compared at 640px wide and lightly softened, so carpet
// grain and resize/compression noise don't count, but a moved or removed
// window, door, wall or fixture does.
export async function checkStructureRetained(original: Buffer, final: Buffer, mask: Uint8Array, w: number, h: number) {
  const sw = 640, sh = Math.max(1, Math.round((sw * h) / w));
  const [a, b, m] = await Promise.all([
    sharp(original).removeAlpha().resize(sw, sh, { fit: "fill" }).blur(1).raw().toBuffer(),
    sharp(final).removeAlpha().resize(sw, sh, { fit: "fill" }).blur(1).raw().toBuffer(),
    sharp(await maskToPng(mask, w, h)).resize(sw, sh, { fit: "fill" }).grayscale().raw().toBuffer(),
  ]);
  let outside = 0, changed = 0;
  for (let i = 0; i < sw * sh; i++) {
    if (m[i] > 0) continue;
    outside++;
    const d = Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
    if (d >= CHANGE_THRESHOLD) changed++;
  }
  const changedPixelPct = Number(((changed / Math.max(1, outside)) * 100).toFixed(2));
  return { checkedPctOfImage: Number(((outside / (sw * sh)) * 100).toFixed(1)), changedPixelPct, retained: changedPixelPct < 0.5 };
}

// Red where the raw staged image changed the room OUTSIDE the furniture mask —
// i.e. exactly what paste-back throws away.
export async function undoneOverlay(original: Buffer, staged: Buffer, mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const [a, b] = await Promise.all([
    sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer(),
  ]);
  const out = Buffer.from(a);
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) continue;
    const d = Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
    if (d < CHANGE_THRESHOLD * 2) continue;
    out[i * 3] = 255;
    out[i * 3 + 1] = Math.round(a[i * 3 + 1] * 0.3);
    out[i * 3 + 2] = Math.round(a[i * 3 + 2] * 0.3);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

// ── Floating-furniture check ────────────────────────────────────────────────
// Gemini sometimes draws the room's floor a little higher or lower than the
// real one. Pasted onto the real photo, a piece then hovers: its legs end on
// the real wall/skirting instead of the floor (Bedroom 05, Oct 2026: a
// bedside table with the power point showing underneath).
//
// 1) Real floor line: in the EMPTY original, each column is scanned upward
//    from the bottom to the first strong horizontal edge (where the floor
//    meets the skirting/wall/door), then median-smoothed.
// 2) For every column the furniture covers, its lowest pixel is "grounded"
//    when it reaches at least FLOAT_GROUND_MARGIN_PCT below that line.
// 3) A run of ungrounded columns is a floating piece when it is wide enough,
//    hangs close to the floor (not a wall shelf or pendant far above it), and
//    reaches a free edge of the furniture on at least one side — so the gap
//    between a table's grounded legs is not counted, but a table whose legs
//    all stop short of the floor is.
export const FLOAT_GROUND_MARGIN_PCT = Number(process.env.FLOAT_GROUND_MARGIN_PCT || 1);
export const FLOAT_MIN_WIDTH_PCT = Number(process.env.FLOAT_MIN_WIDTH_PCT || 3);
export const FLOAT_NEAR_FLOOR_PCT = Number(process.env.FLOAT_NEAR_FLOOR_PCT || 12);

export type FloatingRun = { x1Pct: number; x2Pct: number; gapPct: number; bottomPct: number; floorPct: number; gapVsFloor?: { ratio: number; chroma: number } };

export async function checkFloatingFurniture(original: Buffer, floorMask: Uint8Array, w: number, h: number) {
  // Work at a fixed, modest size: the check is about shapes, not detail.
  const W = 800, H = Math.max(8, Math.round((W * h) / w));
  const line = await realFloorLine(original, W, H);
  const m = await sharp(Buffer.from(floorMask.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
    .resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const rgb = await sharp(original).removeAlpha().resize(W, H, { fit: "fill" }).blur(1.5).raw().toBuffer();
  const margin = (FLOAT_GROUND_MARGIN_PCT / 100) * H;
  const near = (FLOAT_NEAR_FLOOR_PCT / 100) * H;
  // Per column: lowest furniture pixel (-1 = no furniture in this column).
  const bottom = new Int32Array(W).fill(-1);
  for (let x = 0; x < W; x++) for (let y = H - 1; y >= 0; y--) if (m[y * W + x] > 127) { bottom[x] = y; break; }
  // 0 = no furniture, 1 = grounded (or unknown floor), 2 = hanging near the floor
  const state = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    if (bottom[x] < 0) continue;
    const f = line[x];
    if (f < 0 || bottom[x] >= H - 2) { state[x] = 1; continue; }
    const gap = f - bottom[x];
    state[x] = bottom[x] >= f + margin ? 1 : gap <= near ? 2 : 1; // far above the floor: wall item, not checked
  }
  // Legged furniture (TV unit, sideboard): the body between and beyond the
  // legs is raised off the floor by design. A raised stretch is supported
  // when, right beside it, a narrow leg of the SAME piece drops lower, reaches
  // the floor, and the piece rises again past it (or ends). Judged on that
  // piece alone, so a rug in front can't hide a leg, and a neighbouring piece
  // that just keeps going lower (the corner of a bed beside a bedside table)
  // isn't a leg.
  const labels = new Int32Array(W * H).fill(-1);
  labelComponents(Uint8Array.from(m, (v: number) => (v > 127 ? 1 : 0)), W, H).forEach((pc, idx) => { for (const i of pc.pixels) labels[i] = idx; });
  const standsOnLegBeside = (x1: number, x2: number, freeLeft: boolean, freeRight: boolean) => {
    const votes = new Map<number, number>();
    for (let k = x1; k <= x2; k++) { const l = labels[bottom[k] * W + k]; if (l >= 0) votes.set(l, (votes.get(l) || 0) + 1); }
    let piece = -1, best = 0;
    for (const [l, n] of votes) if (n > best) { best = n; piece = l; }
    if (piece < 0) return false;
    const pb = (x: number) => { for (let y = H - 1; y >= 0; y--) if (labels[y * W + x] === piece) return y; return -1; };
    let bSum = 0;
    for (let k = x1; k <= x2; k++) bSum += pb(k);
    const runBottom = bSum / (x2 - x1 + 1);
    const grounded = (x: number, b: number) => line[x] >= 0 && b >= line[x] + margin;
    const maxLeg = Math.max(2, Math.round(W * 0.02)), tol = H * 0.015;
    for (const dir of [-1, 1] as const) {
      if ((dir < 0 && freeLeft) || (dir > 0 && freeRight)) continue;
      const start = dir < 0 ? x1 - 1 : x2 + 1;
      for (let k = 0; k <= Math.round(W * 0.01); k++) {
        const s0 = start + dir * k;
        if (s0 < 0 || s0 >= W) break;
        const b0 = pb(s0);
        if (b0 < 0 || !grounded(s0, b0) || b0 < runBottom + H * 0.015 || b0 > runBottom + H * 0.12) continue;
        let n = 0, e = s0;
        while (e >= 0 && e < W) { const be = pb(e); if (be < 0 || Math.abs(be - b0) > tol) break; n++; e += dir; }
        const after = e >= 0 && e < W ? pb(e) : -1;
        if (n <= maxLeg && (after < 0 || after < b0 - tol)) return true;
        break;
      }
    }
    return false;
  };
  const runs: FloatingRun[] = [];
  const standingOnFloor: FloatingRun[] = [];
  for (let x = 0; x < W; ) {
    if (state[x] !== 2) { x++; continue; }
    let x2 = x;
    while (x2 + 1 < W && state[x2 + 1] === 2) x2++;
    const freeLeft = x === 0 || state[x - 1] === 0;
    const freeRight = x2 === W - 1 || state[x2 + 1] === 0;
    const widthPct = ((x2 - x + 1) / W) * 100;
    if (widthPct >= FLOAT_MIN_WIDTH_PCT && (freeLeft || freeRight) && !standsOnLegBeside(x, x2, freeLeft, freeRight)) {
      let gapSum = 0, n = 0, bSum = 0, fSum = 0;
      for (let k = x; k <= x2; k++) { gapSum += line[k] - bottom[k]; bSum += bottom[k]; fSum += line[k]; n++; }
      // Is the "gap" under the piece really floor? The floor line is the
      // lowest strong edge in the empty room, which is usually the skirting
      // but can be something standing IN the room — the bottom of an open
      // door leaf, a carpet-to-timber threshold (Oct 2026, production: a bed
      // beside an open door failed both attempts). In the empty photo, a
      // piece that really floats has wall or skirting in the gap; one that
      // stands on the floor has the same floor in the gap as just below the
      // line.
      const gapCheck = gapVsFloor(rgb, line, bottom, x, x2, W, H);
      const run = {
        x1Pct: +((x / W) * 100).toFixed(1), x2Pct: +((x2 / W) * 100).toFixed(1),
        gapPct: +(((gapSum / n) / H) * 100).toFixed(1),
        bottomPct: +(((bSum / n) / H) * 100).toFixed(1), floorPct: +(((fSum / n) / H) * 100).toFixed(1),
        ...(gapCheck ? { gapVsFloor: { ratio: gapCheck.ratio, chroma: gapCheck.chroma } } : {}),
      };
      if (gapCheck?.isFloor) standingOnFloor.push(run);
      else runs.push(run);
    }
    x = x2 + 1;
  }
  return { floating: runs.length > 0, runs, ...(standingOnFloor.length ? { standingOnFloor } : {}) };
}

// Does the empty room show the same floor in the gap under a "floating" run as
// just below the floor line (same columns)? Same floor = similar brightness
// (shade allowed) and the same colour balance. On the labelled fixtures, real
// floats have wall or skirting in the gap (brightness 0.3x or 1.5-5.7x the
// floor); the open-door false alarms have carpet (0.85x and 1.2x, neutral).
// A sofa arm overhanging its legs against the wall under a window had floor
// in the gap, only a little darker in the shade by the wall (0.73x, Oct 2026
// production: a living room that fell back to 1A), so the lower bound is 0.65.
// null = too little of either to judge.
export const FLOAT_GAP_FLOOR_MIN_RATIO = Number(process.env.FLOAT_GAP_FLOOR_MIN_RATIO || 0.65);
export const FLOAT_GAP_FLOOR_MAX_RATIO = Number(process.env.FLOAT_GAP_FLOOR_MAX_RATIO || 1.3);
export function gapVsFloor(rgb: Buffer, line: Int32Array, bottom: Int32Array, x1: number, x2: number, W: number, H: number): { ratio: number; chroma: number; isFloor: boolean } | null {
  const g = [0, 0, 0], f = [0, 0, 0];
  let gn = 0, fn = 0;
  const band = Math.max(3, Math.round(H * 0.03));
  for (let x = x1; x <= x2; x++) {
    const fl = line[x], b = bottom[x];
    if (fl < 0 || b < 0) continue;
    for (let y = b + 2; y <= fl - 2; y++) { const i = (y * W + x) * 3; g[0] += rgb[i]; g[1] += rgb[i + 1]; g[2] += rgb[i + 2]; gn++; }
    for (let y = fl + 2; y <= Math.min(H - 1, fl + band); y++) { const i = (y * W + x) * 3; f[0] += rgb[i]; f[1] += rgb[i + 1]; f[2] += rgb[i + 2]; fn++; }
  }
  if (gn < 20 || fn < 20) return null;
  const gs = g[0] + g[1] + g[2], fs = f[0] + f[1] + f[2];
  if (fs <= 0 || gs <= 0) return null;
  const ratio = (gs / gn) / (fs / fn);
  const chroma = Math.max(...[0, 1, 2].map((c) => Math.abs(g[c] / gs - f[c] / fs)));
  return { ratio: +ratio.toFixed(2), chroma: +chroma.toFixed(3), isFloor: ratio >= FLOAT_GAP_FLOOR_MIN_RATIO && ratio <= FLOAT_GAP_FLOOR_MAX_RATIO && chroma < 0.03 };
}

// ── Floor-moved check ────────────────────────────────────────────────────────
// In a tight shot Gemini sometimes makes room by raising the floor / pushing
// the bottom of a wall back while keeping walls and windows in place, so the
// room check passes. The merge then pastes a rug or bed onto the real wall,
// floating above the real skirting (Oct 2026, 33 Golf Rd Image 05).
// For each column with no furniture near the floor line: does Gemini's floor
// reach up over pixels where the real photo shows wall? No AI call.
// STAGE2_FLOOR_MOVED_CHECK=off disables it.
export const FLOOR_MOVED_CHECK = String(process.env.STAGE2_FLOOR_MOVED_CHECK ?? "on").trim().toLowerCase() !== "off";
export const FLOOR_MOVED_RISE_PCT = Number(process.env.STAGE2_FLOOR_MOVED_RISE_PCT || 3);
export const FLOOR_MOVED_MIN_RUN_PCT = Number(process.env.STAGE2_FLOOR_MOVED_MIN_RUN_PCT || 4);

export async function checkFloorMoved(original: Buffer, staged: Buffer, furniture: Uint8Array, w: number, h: number) {
  const W = 800, H = Math.max(8, Math.round((W * h) / w));
  const ob = await sharp(original).removeAlpha().resize(W, H, { fit: "fill" }).png().toBuffer();
  const line = await realFloorLine(ob, W, H);
  const orgb = await sharp(ob).blur(1.2).raw().toBuffer();
  const srgb = await sharp(staged).removeAlpha().resize(W, H, { fit: "fill" }).blur(1.2).raw().toBuffer();
  const mk = await sharp(Buffer.from(furniture.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
    .resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const pad = Math.round(H * 0.08), side = Math.round(W * 0.012);
  const bandTop = Math.round(H * 0.07), bandBot = Math.round(H * 0.015), floorBand = Math.round(H * 0.04);
  const px = (b: Buffer, x: number, y: number) => { const i = (y * W + x) * 3; return [b[i], b[i + 1], b[i + 2]]; };
  // Brightness plus colour balance, so timber vs paint separates by hue too.
  const feat = (c: number[]) => { const s = c[0] + c[1] + c[2] + 1; return [s / 3, (c[0] / s) * 300, (c[2] / s) * 300]; };
  const dist = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * 0.5, a[1] - b[1], a[2] - b[2]);
  // Whole-photo floor colour, for columns where the floor runs off the bottom.
  const fs: number[][] = [];
  for (let x = 0; x < W; x += 2) { const f = line[x]; if (f < 0) continue; for (let y = f + 3; y <= Math.min(H - 1, f + floorBand); y += 2) fs.push(feat(px(orgb, x, y))); }
  const med = (k: number) => { const v = fs.map((c) => c[k]).sort((a, b) => a - b); return v[v.length >> 1] ?? 0; };
  const floorG = [med(0), med(1), med(2)];
  const moved = new Uint8Array(W);
  let valid = 0, maxRise = 0;
  for (let x = 0; x < W; x++) {
    let f = line[x];
    if (f < 0 || f >= H - 3) f = H; // no floor line near the bottom: the real floor runs off the photo here
    if (f - bandTop < 0) continue;
    let free = true;
    for (let xx = Math.max(0, x - side); free && xx <= Math.min(W - 1, x + side); xx++)
      for (let y = Math.max(0, f - pad); y < H; y++) if (mk[y * W + xx] > 127) { free = false; break; }
    if (!free) continue;
    const fl = [0, 0, 0]; let fn = 0;
    for (let y = f + 3; y <= Math.min(H - 1, f + floorBand); y++) { const c = feat(px(orgb, x, y)); fl[0] += c[0]; fl[1] += c[1]; fl[2] += c[2]; fn++; }
    const floorC = fn >= 3 ? fl.map((v) => v / fn) : floorG;
    // The real photo must show WALL above here (not more floor, as in a
    // corner where the floor fills the bottom of the photo).
    const wr = [0, 0, 0]; let wn = 0;
    for (let y = Math.max(0, f - Math.round(bandTop * 2.2)); y <= f - Math.round(bandTop * 1.2); y++) { const c = feat(px(orgb, x, y)); wr[0] += c[0]; wr[1] += c[1]; wr[2] += c[2]; wn++; }
    if (wn < 3) continue;
    const wallC = wr.map((v) => v / wn);
    if (dist(wallC, floorC) < 15) continue;
    valid++;
    // How far above the real floor line does Gemini's floor reach, over
    // pixels the real photo shows as wall? (small gaps allowed)
    let rise = 0, gap = 0;
    for (let y = Math.min(H - 1, f - 1); y >= Math.max(0, f - Math.round(H * 0.15)); y--) {
      const oc = feat(px(orgb, x, y)), sc = feat(px(srgb, x, y));
      const realWall = dist(oc, floorC) > 12 && dist(oc, wallC) < dist(oc, floorC);
      const geminiFloor = dist(sc, floorC) < 9 && dist(sc, oc) > 10;
      if (!realWall && y > f - bandBot) continue; // the skirting edge itself
      if (realWall && geminiFloor) { rise = f - y; gap = 0; }
      else if (++gap > Math.round(H * 0.012)) break;
    }
    if (rise >= (H * FLOOR_MOVED_RISE_PCT) / 100) moved[x] = 1;
    maxRise = Math.max(maxRise, rise);
  }
  let total = 0, best = 0, run = 0, bestEnd = 0;
  for (let x = 0; x < W; x++) { if (moved[x]) { total++; run++; if (run > best) { best = run; bestEnd = x; } } else run = 0; }
  const longestRunPct = +((best / W) * 100).toFixed(1);
  return {
    moved: longestRunPct >= FLOOR_MOVED_MIN_RUN_PCT,
    longestRunPct,
    movedColsPct: +((total / W) * 100).toFixed(1),
    checkedColsPct: +((valid / W) * 100).toFixed(1),
    maxRisePct: +((maxRise / H) * 100).toFixed(1),
    ...(best ? { atXPct: [+(((bestEnd - best + 1) / W) * 100).toFixed(0), +(((bestEnd + 1) / W) * 100).toFixed(0)] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Skirting beside furniture. Gemini sometimes draws a wall's floor line a few
// percent higher or lower than the real one, right next to the furniture it
// stands against (Oct 2026, Bedroom 05: ~5% higher on the short stretch of
// wall left of the bed). The floor-moved check above only looks at columns
// with no furniture anywhere below the floor line, so a narrow stretch beside
// a bed is never checked; the bed is pasted standing on Gemini's floor and
// its back corner misses the real skirting.
//
// measureSkirtingOffsets: for columns where only the strip AROUND the floor
// line must be clear of furniture, where Gemini's floor line is vs the real
// one. A steady offset over a short stretch (2%+ of the width) counts.
// planSkirtingLineUp / applySkirtingLineUp: the furniture standing against
// that wall is pulled forward (or back) in perspective — lower and bigger —
// with its shadows, until it meets the real skirting. If that isn't safe the
// photo is re-staged.
// No AI calls. STAGE2_SKIRTING_LINE_UP=off turns the line-up off (the
// measurement still feeds the floor-moved check).
// ---------------------------------------------------------------------------
export const SKIRTING_LINE_UP = String(process.env.STAGE2_SKIRTING_LINE_UP ?? "on").trim().toLowerCase() !== "off";
export const SKIRTING_OFFSET_MIN_PCT = Number(process.env.STAGE2_SKIRTING_OFFSET_MIN_PCT || 2.5); // of photo height
export const SKIRTING_MIN_RUN_PCT = Number(process.env.STAGE2_SKIRTING_MIN_RUN_PCT || 2);        // of photo width
export const SKIRTING_MAX_SHIFT_PCT = Number(process.env.STAGE2_SKIRTING_MAX_SHIFT_PCT || 8);    // never move furniture further

export type SkirtingRun = { x1Pct: number; x2Pct: number; widthPct: number; dyPct: number };
// Where the horizon sits (fraction of the photo height from the top), for
// "pulling" furniture forward in perspective. Real-estate photos are taken
// about level, so it is close to the middle; small errors only change the
// size by a percent or two.
export const SKIRTING_HORIZON = Number(process.env.STAGE2_SKIRTING_HORIZON || 0.45);

export async function measureSkirtingOffsets(original: Buffer, staged: Buffer, furniture: Uint8Array, w: number, h: number): Promise<{ runs: SkirtingRun[]; checkedColsPct: number; realLine: number[] }> {
  const W = 800, H = Math.max(8, Math.round((W * h) / w));
  const ob = await sharp(original).removeAlpha().resize(W, H, { fit: "fill" }).png().toBuffer();
  const sb = await sharp(staged).removeAlpha().resize(W, H, { fit: "fill" }).png().toBuffer();
  const [lo, ls] = await Promise.all([realFloorLine(ob, W, H), realFloorLine(sb, W, H)]);
  const og = await sharp(ob).greyscale().blur(1.2).raw().toBuffer();
  const mk = await sharp(Buffer.from(furniture.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
    .resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const pad = Math.round(H * 0.08), band = Math.round(H * 0.04), side = Math.round(W * 0.012);
  const wallUp = Math.round(H * 0.1);
  const off = new Float32Array(W).fill(NaN);
  let valid = 0;
  for (let x = 0; x < W; x++) {
    const f = lo[x], g = ls[x];
    if (f < 0 || f >= H - 3 || g < 0 || g >= H - 3 || f - wallUp < 0) continue;
    // Only the strip around both floor lines must be clear of furniture.
    let near = false;
    const yTop = Math.max(0, Math.min(f, g) - pad), yBot = Math.min(H - 1, Math.max(f, g) + band);
    for (let xx = Math.max(0, x - side); !near && xx <= Math.min(W - 1, x + side); xx++)
      for (let y = yTop; y <= yBot; y++) if (mk[y * W + xx] > 127) { near = true; break; }
    if (near) continue;
    // The real photo must show wall above and floor below (not a door or a
    // floor running into a corner): a clear brightness step at the line.
    let a = 0, b = 0, n = 0;
    for (let y = f - wallUp; y < f - Math.round(H * 0.03); y++) { a += og[y * W + x]; n++; }
    const wall = n ? a / n : 0;
    n = 0;
    for (let y = f + 3; y <= Math.min(H - 1, f + band); y++) { b += og[y * W + x]; n++; }
    const floor = n ? b / n : 0;
    if (Math.abs(wall - floor) < 12) continue;
    valid++;
    off[x] = ((g - f) / H) * 100; // negative = Gemini's floor line is higher
  }
  // Runs of a steady offset (same sign, within 1.2% of the run's median),
  // allowing tiny gaps.
  const runs: SkirtingRun[] = [];
  let x = 0;
  while (x < W) {
    if (!(Math.abs(off[x]) >= SKIRTING_OFFSET_MIN_PCT)) { x++; continue; }
    const vals: number[] = [off[x]];
    let end = x, gap = 0;
    for (let k = x + 1; k < W; k++) {
      if (Number.isNaN(off[k])) { if (++gap > 3) break; continue; }
      const sorted = [...vals].sort((p, q) => p - q), med = sorted[sorted.length >> 1];
      if (Math.sign(off[k]) !== Math.sign(med) || Math.abs(off[k] - med) > 1.2) break;
      vals.push(off[k]); end = k; gap = 0;
    }
    const widthPct = ((end - x + 1) / W) * 100;
    if (widthPct >= SKIRTING_MIN_RUN_PCT && vals.length >= 3) {
      const sorted = [...vals].sort((p, q) => p - q);
      runs.push({ x1Pct: +((x / W) * 100).toFixed(1), x2Pct: +(((end + 1) / W) * 100).toFixed(1), widthPct: +widthPct.toFixed(1), dyPct: +sorted[sorted.length >> 1].toFixed(1) });
    }
    x = end + 1;
  }
  // The real floor line, as fractions of the height (-1 = not found), for the line-up plan.
  const realLine = Array.from(lo, (v) => (v < 0 ? -1 : v / H));
  return { runs, checkedColsPct: +((valid / W) * 100).toFixed(1), realLine };
}

export type SkirtingLineUp = {
  ok: boolean; why: string; run?: SkirtingRun;
  select?: Uint8Array;       // furniture pixels that move
  k?: number; vx?: number; vy?: number; // scale about (vx, vy), in pixels
  wallPct?: [number, number]; movedDownPct?: number; growPct?: number;
};

/**
 * "Pull forward": the furniture standing against the wall whose skirting was
 * off is moved toward (or away from) the camera in perspective — lower AND
 * bigger (or higher and smaller) — until the back of it meets the real
 * skirting. Moving it straight down kept its size, so the bed looked too
 * small, and a plant in the next corner was dragged along with it (owner
 * review, Oct 2026, Bedroom 05). Only pieces against that wall move, plus
 * anything lying on the open floor in front of it (the rug); pieces standing
 * against another wall stay where Gemini put them.
 */
export function planSkirtingLineUp(runs: SkirtingRun[], furniture: Uint8Array, w: number, h: number, realLine: number[]): SkirtingLineUp {
  if (!runs.length) return { ok: false, why: "no steady offset" };
  const run = [...runs].sort((a, b) => b.widthPct - a.widthPct)[0];
  if (runs.some((r) => Math.sign(r.dyPct) !== Math.sign(run.dyPct))) return { ok: false, why: "offsets point both ways (Gemini tilted the floor line)", run };
  if (Math.abs(run.dyPct) > SKIRTING_MAX_SHIFT_PCT) return { ok: false, why: `offset ${run.dyPct}% too large to move furniture`, run };
  const L = realLine.length;
  if (!L) return { ok: false, why: "no floor line", run };
  const at = (xFrac: number) => realLine[Math.max(0, Math.min(L - 1, Math.round(xFrac * (L - 1))))];
  // The wall the stretch belongs to: follow its floor line both ways until it
  // turns (a corner) or disappears.
  const c1 = Math.round((run.x1Pct / 100) * (L - 1)), c2 = Math.round((run.x2Pct / 100) * (L - 1));
  const slope = Math.sign((realLine[c2] - realLine[c1]) || 0);
  const step = Math.max(2, Math.round(L * 0.01));
  const sameWall = (a: number, b: number) => realLine[a] >= 0 && realLine[b] >= 0 && (slope === 0 ? Math.abs(realLine[b] - realLine[a]) < 0.01 : Math.sign(realLine[b] - realLine[a]) === slope || Math.abs(realLine[b] - realLine[a]) < 0.002);
  let wx1 = c1, wx2 = c2;
  while (wx2 + step < L && sameWall(wx2, wx2 + step)) wx2 += step;
  while (wx1 - step >= 0 && sameWall(wx1 - step, wx1)) wx1 -= step;
  const wallX1 = (wx1 / (L - 1)) * w, wallX2 = (wx2 / (L - 1)) * w;
  // Pixels that move: furniture in front of that wall; beyond its ends only
  // what lies on the open floor (below the real floor line), not pieces
  // standing against the next wall.
  const margin = w * 0.015, floorGap = h * 0.015;
  const select = new Uint8Array(w * h);
  let n = 0, sx1 = w, sx2 = 0, sy2 = 0, other = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!furniture[i]) continue;
    let take = x >= wallX1 - margin && x <= wallX2 + margin;
    if (!take) { const f = at(x / w); take = f >= 0 && y >= f * h + floorGap; }
    if (take) { select[i] = 1; n++; if (x < sx1) sx1 = x; if (x > sx2) sx2 = x; if (y > sy2) sy2 = y; } else other++;
  }
  const rx1 = (run.x1Pct / 100) * w, rx2 = (run.x2Pct / 100) * w;
  if (!n || sx2 < rx1 - w * 0.03 || sx1 > rx2 + w * 0.03) return { ok: false, why: "no furniture beside the offset stretch", run };
  // Scale about a point on the horizon above the furniture, so the floor line
  // where the offset was measured lands on the real one.
  const vy = SKIRTING_HORIZON * h, vx = (sx1 + sx2) / 2;
  const yReal = at(((run.x1Pct + run.x2Pct) / 200)) * h;
  const yGem = yReal + (run.dyPct / 100) * h;
  if (yReal <= vy + h * 0.05 || yGem <= vy + h * 0.05) return { ok: false, why: "floor line too close to the horizon to scale safely", run };
  const k = (yReal - vy) / (yGem - vy);
  if (k < 0.85 || k > 1.25) return { ok: false, why: `would resize the furniture by ${Math.round((k - 1) * 100)}%`, run };
  // Growing must not push a piece that ends above the bottom edge off it.
  const newBottom = vy + k * (sy2 - vy);
  if (sy2 < h - 2 && newBottom >= h - 1) return { ok: false, why: "pulling the furniture forward would cut it off at the bottom of the photo", run };
  const newLeft = vx + k * (sx1 - vx), newRight = vx + k * (sx2 - vx);
  if ((sx1 > 1 && newLeft < 0) || (sx2 < w - 2 && newRight > w - 1)) return { ok: false, why: "pulling the furniture forward would cut it off at the side of the photo", run };
  return {
    ok: true, why: "steady offset beside furniture", run, select, k, vx, vy,
    wallPct: [+((wallX1 / w) * 100).toFixed(1), +((wallX2 / w) * 100).toFixed(1)],
    movedDownPct: +(((yReal - yGem) / h) * 100).toFixed(1),
    growPct: +((k - 1) * 100).toFixed(1),
  };
}

/**
 * Applies the plan to the staged picture and every trace mask: the selected
 * furniture, with the shadow zone around it, is scaled by k about (vx, vy).
 * Other furniture is never moved or overwritten. Masks: nearest pixel;
 * picture: bilinear.
 */
export async function applySkirtingLineUp(
  staged: Buffer, masks: Record<string, Uint8Array | null | undefined>, furniture: Uint8Array, plan: SkirtingLineUp, w: number, h: number,
): Promise<{ staged: Buffer; masks: Record<string, Mask | null | undefined> }> {
  const { select, k, vx, vy } = plan as Required<SkirtingLineUp>;
  // Region that travels with the furniture: the pieces plus their shadow area,
  // minus any piece that stays.
  let region: Mask = dilate(select, w, h, Math.max(2, Math.round(w * 0.02)));
  region = growDown(region, w, h, Math.round(h * 0.03));
  for (let i = 0; i < region.length; i++) if (furniture[i] && !select[i]) region[i] = 0;
  const keep = (i: number) => furniture[i] && !select[i];
  const { data } = await sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const dst = new Uint8Array(w * h); // destination pixels written from the region
  const srcIdx = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const sy = vy + (y - vy) / k;
    if (sy < 0 || sy > h - 1) continue;
    for (let x = 0; x < w; x++) {
      const sx = vx + (x - vx) / k;
      if (sx < 0 || sx > w - 1) continue;
      const ni = Math.round(sy) * w + Math.round(sx);
      if (!region[ni]) continue;
      const i = y * w + x;
      if (keep(i)) continue;
      dst[i] = 1; srcIdx[i] = ni;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const v = data[(y0 * w + x0) * 3 + c] * (1 - fx) * (1 - fy) + data[(y0 * w + x1) * 3 + c] * fx * (1 - fy) + data[(y1 * w + x0) * 3 + c] * (1 - fx) * fy + data[(y1 * w + x1) * 3 + c] * fx * fy;
        out[i * 3 + c] = Math.round(v);
      }
    }
  }
  const moved: Record<string, Mask | null | undefined> = {};
  for (const [name, m] of Object.entries(masks)) {
    if (!m) { moved[name] = m as any; continue; }
    const o: Mask = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) o[i] = region[i] && !keep(i) ? 0 : m[i];
    for (let i = 0; i < m.length; i++) if (dst[i]) o[i] = m[srcIdx[i]];
    moved[name] = o;
  }
  return { staged: await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), masks: moved };
}

// ---------------------------------------------------------------------------
// Floor patch for floating furniture. Gemini drew the piece standing on ITS
// floor; the merge pasted it onto the real photo, where the floor/skirting sits
// elsewhere, so the legs hang. Fix: under the piece, use Gemini's own floor,
// skirting and the strip of wall just above it, from the piece out to a
// natural edge on each side where the join can't be seen:
//   - a piece standing in front (e.g. the bed beside a bedside table),
//   - a wall corner / pillar edge that sits in the same place in both images,
//   - the edge of the photo.
// Anything else (open wall, the same piece carrying on to the floor, a corner
// Gemini moved) -> no patch; the caller re-stages instead.
// ---------------------------------------------------------------------------
export type FloorPatch = {
  x1: number; x2: number; top: number; bottom: number; // patch box (planning pixels)
  floorTop: number; // top of the floor/skirting band
  runTop: number;   // top of the floating piece
  // A corner whose far side is a structure NEARER the camera (a pillar or wall
  // return): it hides everything behind it, so no shadow may fall on it.
  leftOccluder?: number; rightOccluder?: number; // the real edge column
  runX1: number; runX2: number; runBottom: number;      // the floating piece's columns
  floor?: FloorMatch;
  left: "piece in front" | "wall corner" | "photo edge";
  right: "piece in front" | "wall corner" | "photo edge";
};
const FLOOR_PATCH_REACH = 0.12; // look this far (fraction of width) for an edge

// Is Gemini's floor under the patch the same material as the real floor
// (carpet vs boards vs tiles)? Compares colour, brightness and texture of the
// two floors over the same area (furniture excluded). The patch's colour
// matching would hide a tint, but not planks next to carpet.
export type FloorMatch = { same: boolean; chromaDiff: number; brightRatio: number; textureRatio: number; grainRatio: number; why?: string };
export function compareFloorMaterial(o: Buffer, s: Buffer, gO: Buffer, gS: Buffer, sel: (x: number, y: number) => boolean, w: number, h: number): FloorMatch {
  const acc = () => ({ r: 0, g: 0, b: 0, n: 0, lap: 0, dx: 0, dy: 0 });
  const A = acc(), B = acc();
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (!sel(x, y)) continue;
    const i = y * w + x;
    for (const [src, g, t] of [[o, gO, A], [s, gS, B]] as const) {
      t.r += src[i * 3]; t.g += src[i * 3 + 1]; t.b += src[i * 3 + 2]; t.n++;
      t.lap += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]);
      t.dx += Math.abs(g[i + 1] - g[i - 1]); t.dy += Math.abs(g[i + w] - g[i - w]);
    }
  }
  if (A.n < 50) return { same: false, chromaDiff: 0, brightRatio: 0, textureRatio: 0, grainRatio: 0, why: "too little floor to compare" };
  const sumA = A.r + A.g + A.b, sumB = B.r + B.g + B.b;
  const chromaDiff = Math.abs(A.r / sumA - B.r / sumB) + Math.abs(A.g / sumA - B.g / sumB) + Math.abs(A.b / sumA - B.b / sumB);
  const brightRatio = sumB / Math.max(1, sumA);
  const textureRatio = (B.lap / Math.max(1, sumB)) / Math.max(1e-9, A.lap / Math.max(1, sumA));
  const grainRatio = (B.dx / Math.max(1, B.dy)) / Math.max(1e-9, A.dx / Math.max(1, A.dy));
  const r2 = (v: number) => +v.toFixed(3);
  const out = { chromaDiff: r2(chromaDiff), brightRatio: r2(brightRatio), textureRatio: r2(textureRatio), grainRatio: r2(grainRatio) };
  const why = chromaDiff > 0.06 ? "different floor colour"
    : brightRatio < 0.6 || brightRatio > 1.6 ? "different floor brightness"
    : textureRatio < 0.5 || textureRatio > 2 ? "different floor texture"
    : grainRatio < 0.6 || grainRatio > 1.67 ? "different floor grain (boards vs carpet)"
    : undefined;
  return { same: !why, ...out, ...(why ? { why } : {}) };
}

export async function planFloorPatches(original: Buffer, staged: Buffer, floorMask: Uint8Array, runs: FloatingRun[], w: number, h: number) {
  const grey = (b: Buffer) => sharp(b).removeAlpha().resize(w, h, { fit: "fill" }).greyscale().blur(1.5).raw().toBuffer();
  const rgb = (b: Buffer) => sharp(b).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const [gO, gS, line, cO, cS] = await Promise.all([grey(original), grey(staged), realFloorLine(original, w, h), rgb(original), rgb(staged)]);
  const bottom = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (floorMask[y * w + x]) { bottom[x] = y; break; }
  // mean |horizontal gradient| at column x over rows [y1, y2)
  const vGrad = (g: Buffer, x: number, y1: number, y2: number) => {
    if (x < 2 || x >= w - 2) return 0;
    let s = 0, n = 0;
    for (let y = Math.max(0, y1); y < Math.min(h, y2); y++) { s += Math.abs(g[y * w + x + 2] - g[y * w + x - 2]); n++; }
    return n ? s / n : 0;
  };
  const patches: FloorPatch[] = [];
  const notes: string[] = [];
  for (const r of runs) {
    const xa = Math.max(0, Math.floor((r.x1Pct / 100) * w)), xb = Math.min(w - 1, Math.ceil((r.x2Pct / 100) * w));
    let runBottom = 0, runTop = h, lMin = h, lMax = 0;
    for (let x = xa; x <= xb; x++) {
      runBottom = Math.max(runBottom, bottom[x]);
      for (let y = 0; y < h; y++) if (floorMask[y * w + x]) { runTop = Math.min(runTop, y); break; }
      if (line[x] >= 0) { lMin = Math.min(lMin, line[x]); lMax = Math.max(lMax, line[x]); }
    }
    const top = Math.max(0, Math.min(lMin, runBottom) - Math.round(h * 0.05));
    const bot = Math.min(h - 1, Math.max(lMax, runBottom) + Math.round(h * 0.05));
    const wallY1 = top - Math.round(h * 0.08), wallY2 = top + Math.round(h * 0.02);
    const reach = Math.round(w * FLOOR_PATCH_REACH);
    const side = (dir: -1 | 1): { at: number; why: FloorPatch["left"]; occluder?: number } | string => {
      const start = dir < 0 ? xa : xb;
      for (let k = 1; k <= reach; k++) {
        const x = start + dir * k;
        if (x < 0 || x >= w) return { at: dir < 0 ? 0 : w - 1, why: "photo edge" };
        if (bottom[x] >= 0) {
          const prev = bottom[x - dir];
          if (prev >= 0 && bottom[x] - prev > h * 0.03) {
            // a piece in front: carry on until it covers the whole patch height,
            // then 1% further to swallow leftovers along its edge
            for (let j = 0; j < Math.round(w * 0.08); j++) {
              const xx = x + dir * j;
              if (xx < 0 || xx >= w) break;
              let cov = 0;
              for (let y = top; y <= bot; y++) if (floorMask[y * w + xx]) cov++;
              if (cov >= 0.95 * (bot - top + 1)) return { at: Math.max(0, Math.min(w - 1, xx + dir * Math.round(w * 0.01))), why: "piece in front" };
            }
            return "the piece in front doesn't cover the join";
          }
          if (line[x] >= 0 && bottom[x] >= line[x]) return "the same piece reaches the floor further along";
          continue; // the same piece, still hanging: include it
        }
        if (vGrad(gO, x, wallY1, wallY2) >= 10) {
          const win = Math.round(w * 0.015);
          const peak = (g: Buffer) => {
            let b = -1, bx = x;
            for (let xx = x - win; xx <= x + win; xx++) { const v = vGrad(g, xx, wallY1, wallY2); if (v > b) { b = v; bx = xx; } }
            return { bx, b };
          };
          const pO = peak(gO), pS = peak(gS);
          if (pS.b < 6 || Math.abs(pO.bx - pS.bx) > w * 0.006) return "Gemini moved the wall corner";
          // Nearer structure beyond the corner? Its floor line is missing (it
          // runs out of the photo) or jumps lower; an inside corner's floor
          // line just bends.
          const inside = line[Math.max(0, Math.min(w - 1, pO.bx - dir * Math.round(w * 0.01)))];
          let near = 0, n = 0;
          for (let k2 = Math.round(w * 0.015); k2 <= Math.round(w * 0.05); k2++) {
            const xx = pO.bx + dir * k2;
            if (xx < 0 || xx >= w) break;
            n++;
            if (line[xx] < 0 || (inside >= 0 && line[xx] > inside + h * 0.03)) near++;
          }
          const occluder = n > 0 && near >= 0.6 * n ? pO.bx : undefined;
          return { at: dir < 0 ? Math.max(pO.bx, pS.bx) + 1 : Math.min(pO.bx, pS.bx) - 1, why: "wall corner", occluder };
        }
      }
      return "no corner or piece within reach";
    };
    const L = side(-1), R = side(1);
    const where = `x ${r.x1Pct}-${r.x2Pct}%`;
    if (typeof L === "string" || typeof R === "string") {
      notes.push(`${where}: ${typeof L === "string" ? `left side: ${L}` : `right side: ${R}`}`);
      return { ok: false as const, patches: [], notes };
    }
    const floorTop = top;
    // Same floor material? (carpet must stay carpet)
    const floor = compareFloorMaterial(cO, cS, gO, gS, (x, y) =>
      x >= L.at && x <= R.at && y <= bot && line[x] >= 0 && y >= line[x] + h * 0.01 && !floorMask[y * w + x], w, h);
    if (!floor.same) {
      notes.push(`${where}: ${floor.why} (colour ${floor.chromaDiff}, brightness x${floor.brightRatio}, texture x${floor.textureRatio}, grain x${floor.grainRatio})`);
      return { ok: false as const, patches: [], notes };
    }
    patches.push({ x1: L.at, x2: R.at, top, bottom: bot, floorTop, runTop, leftOccluder: L.occluder, rightOccluder: R.occluder, runX1: xa, runX2: xb, runBottom, left: L.why, right: R.why, floor });
    const tag = (sd: { why: string; occluder?: number }) => sd.why + (sd.occluder !== undefined ? " (nearer structure)" : "");
    notes.push(`${where}: patch x ${((L.at / w) * 100).toFixed(1)}-${((R.at / w) * 100).toFixed(1)}% (${tag(L)} | ${tag(R)})`);
  }
  return { ok: patches.length > 0, patches, notes };
}

// Paste each planned patch from Gemini's image into the final, at the final's
// resolution. Seamless: Gemini's pixels plus a smooth colour offset solved so
// it matches the final exactly along the patch border (no tone step at any
// join). Returns null when a join at a wall corner would add a visible edge.
export async function applyFloorPatches(original: Buffer, final: Buffer, staged: Buffer, floorMask: Uint8Array, patches: FloorPatch[], w: number, h: number) {
  const meta = await sharp(final).metadata();
  const FW = meta.width!, FH = meta.height!;
  const sx = FW / w, sy = FH / h;
  const [fin, stg, mk, org] = await Promise.all([
    sharp(final).removeAlpha().raw().toBuffer(),
    sharp(staged).removeAlpha().resize(FW, FH, { fit: "fill" }).raw().toBuffer(),
    sharp(Buffer.from(floorMask.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
      .resize(FW, FH, { fit: "fill" }).extractChannel(0).raw().toBuffer(),
    sharp(original).removeAlpha().resize(FW, FH, { fit: "fill" }).raw().toBuffer(),
  ]);
  const img = Buffer.from(fin);
  const notes: string[] = [];
  const lum = (b: Buffer, i: number) => (b[i * 3] + b[i * 3 + 1] + b[i * 3 + 2]) / 3;
  for (const p of patches) {
    const L = Math.max(0, Math.round(p.x1 * sx)), R = Math.min(FW - 1, Math.round(p.x2 * sx));
    const top = Math.max(0, Math.round(p.top * sy)), bot = Math.min(FH - 1, Math.round(p.bottom * sy));
    const xa = Math.round(p.runX1 * sx), xb = Math.round(p.runX2 * sx), runBottom = Math.round(p.runBottom * sy);
    // colour offset (final - Gemini) on a coarse grid: fixed along the border
    // (except a photo edge, which is free), smooth inside
    const floorTop = Math.round(p.floorTop * sy);
    // Which pixels take Gemini's: the floor/skirting band, except the lower
    // parts of other pieces (a rug, the foot of the bed).
    const replace = (x: number, y: number) =>
      y >= floorTop && !(mk[y * FW + x] > 127 && (x < xa || x > xb) && y > runBottom + FH * 0.01);
    // Colour offset (target - Gemini) on a coarse grid: fixed wherever pixels
    // are kept and along the box border (except a photo edge, which is free),
    // smooth where pixels are replaced. The target is the final, so shadows
    // the blend gave the wall and floor carry on into the patch.
    const cs = Math.max(2, Math.round(4 * sx));
    const gx = Math.ceil((R - L + 1) / cs), gy = Math.ceil((bot - top + 1) / cs);
    const D = [0, 1, 2].map(() => new Float32Array(gx * gy));
    const fixed = new Uint8Array(gx * gy);
    for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
      const x0 = L + cx * cs, y0 = top + cy * cs, x1 = Math.min(R + 1, x0 + cs), y1 = Math.min(bot + 1, y0 + cs);
      const border = cx === 0 || cy === 0 || cx === gx - 1 || cy === gy - 1;
      const freeEdge = (cx === 0 && p.left === "photo edge") || (cx === gx - 1 && p.right === "photo edge");
      let rep = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (replace(x, y)) rep++; n++; }
      if (!(border && !freeEdge) && rep * 2 >= n) continue; // solved
      const sum = [0, 0, 0];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * FW + x) * 3;
        for (let c = 0; c < 3; c++) sum[c] += fin[i + c] - stg[i + c];
      }
      for (let c = 0; c < 3; c++) D[c][cy * gx + cx] = sum[c] / Math.max(1, n);
      fixed[cy * gx + cx] = 1;
    }
    for (let it = 0; it < 1500; it++) {
      for (let c = 0; c < 3; c++) {
        const d = D[c];
        for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
          const k = cy * gx + cx;
          if (fixed[k]) continue;
          let s = 0, n = 0;
          if (cx > 0) { s += d[k - 1]; n++; }
          if (cx < gx - 1) { s += d[k + 1]; n++; }
          if (cy > 0) { s += d[k - gx]; n++; }
          if (cy < gy - 1) { s += d[k + gx]; n++; }
          d[k] = s / n;
        }
      }
    }
    const at = (d: Float32Array, fx: number, fy: number) => {
      const x0 = Math.max(0, Math.min(gx - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(gy - 1, Math.floor(fy)));
      const x1 = Math.min(gx - 1, x0 + 1), y1 = Math.min(gy - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
      return (d[y0 * gx + x0] * (1 - tx) + d[y0 * gx + x1] * tx) * (1 - ty) + (d[y1 * gx + x0] * (1 - tx) + d[y1 * gx + x1] * tx) * ty;
    };
    const backup = Buffer.from(img);
    for (let y = top; y <= bot; y++) for (let x = L; x <= R; x++) {
      if (!replace(x, y)) continue;
      const i = (y * FW + x) * 3, fx = (x - L) / cs - 0.5, fy = (y - top) / cs - 0.5;
      for (let c = 0; c < 3; c++) img[i + c] = Math.max(0, Math.min(255, Math.round(stg[i + c] + at(D[c], fx, fy))));
    }
    // A join at a wall corner must not add an edge the final didn't have there.
    for (const [why, x] of [[p.left, L], [p.right, R]] as const) {
      if (why !== "wall corner") continue;
      const inX = x === L ? x + 3 : x - 3, outX = x === L ? x - 3 : x + 3;
      if (inX < 0 || outX < 0 || inX >= FW || outX >= FW) continue;
      let ex = 0, n = 0;
      for (let y = top; y <= bot; y++) {
        const now = Math.abs(lum(img, y * FW + outX) - lum(img, y * FW + inX));
        const was = Math.abs(lum(fin, y * FW + outX) - lum(fin, y * FW + inX));
        ex += Math.max(0, now - was - 4);
        n++;
      }
      const score = ex / Math.max(1, n);
      notes.push(`corner join adds ${score.toFixed(1)}`);
      if (score > 8) {
        img.set(backup);
        return { image: null, notes: [...notes, "corner join would show"] };
      }
    }
    // A nearer structure (pillar, wall return) takes precedence: a shadow from
    // the piece behind it must stop at its edge. Where the blend darkened its
    // face, put back the real photo (relit to match the final just above).
    for (const [edge, dir] of [[p.leftOccluder, -1], [p.rightOccluder, 1]] as const) {
      if (edge === undefined) continue;
      const ex = Math.round(edge * sx), reach = Math.round(FW * 0.03);
      const y1 = Math.max(0, Math.round((p.runTop - h * 0.02) * sy)), y2 = Math.min(FH - 1, bot + Math.round(FH * 0.05));
      const cols: number[] = [];
      for (let k = 0; k <= reach; k++) { const x = ex + dir * k; if (x >= 0 && x < FW) cols.push(x); }
      // relight factor from the same face higher up (no shadow there)
      const a = [0, 0, 0], b = [0, 0, 0];
      for (let y = Math.max(0, y1 - Math.round(FH * 0.12)); y < y1; y++) for (const x of cols) {
        if (mk[y * FW + x] > 127) continue;
        for (let c = 0; c < 3; c++) { a[c] += fin[(y * FW + x) * 3 + c]; b[c] += org[(y * FW + x) * 3 + c]; }
      }
      const gain = [0, 1, 2].map((c) => (b[c] > 0 ? a[c] / b[c] : 1));
      let fixedPx = 0;
      for (let y = y1; y <= y2; y++) for (const x of cols) {
        if (mk[y * FW + x] > 127) continue;
        const i = (y * FW + x) * 3;
        const t = [0, 1, 2].map((c) => Math.min(255, org[i + c] * gain[c]));
        if ((t[0] + t[1] + t[2]) / 3 - lum(img, y * FW + x) > 3) {
          for (let c = 0; c < 3; c++) img[i + c] = Math.round(t[c]);
          fixedPx++;
        }
      }
      notes.push(`shadow kept off the nearer structure (${fixedPx} px restored)`);
    }
  }
  const out = await sharp(img, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  return { image: out, notes };
}

// ---------------------------------------------------------------------------
// Line-up: when Gemini drew the room shifted or zoomed (camera estimate from
// checkCameraAlignment), move/resize its staged image back onto the real
// photo's frame. Where the moved image has no pixels (a strip along an edge),
// the real photo is used, so outside the furniture everything is unchanged.
// The traced room check afterwards decides whether the line-up really matches.
// ---------------------------------------------------------------------------
export const REALIGN_MIN_GAIN = Number(process.env.REALIGN_MIN_GAIN || 0.02);
export const REALIGN_MAX_EMPTY_PCT = Number(process.env.REALIGN_MAX_EMPTY_PCT || 15);

// Gemini's picture zoomed or shifted enough that pasting its furniture onto
// the real photo would misplace things (Oct 2026, production: 3.5% zoom with
// a weak fit gain of 0.018 was traced and merged as-is). Such pictures are
// lined up BEFORE tracing — no extra trace cost. A very weak fit gain means
// the "zoom" reading is noise, so the room check is left to decide.
export const PREALIGN_MIN_SCALE_DIFF = Number(process.env.PREALIGN_MIN_SCALE_DIFF || 0.02);
export const PREALIGN_MIN_SHIFT_PCT = Number(process.env.PREALIGN_MIN_SHIFT_PCT || 1.5);
export const PREALIGN_MIN_GAIN = Number(process.env.PREALIGN_MIN_GAIN || 0.01);

export function shouldPrealign(cam: CameraAlignment | null | undefined): boolean {
  if (!cam || cam.gain < PREALIGN_MIN_GAIN) return false;
  return Math.abs(cam.scale - 1) >= PREALIGN_MIN_SCALE_DIFF || cam.shiftPct >= PREALIGN_MIN_SHIFT_PCT;
}

export function canRealign(cam: CameraAlignment | null | undefined): boolean {
  if (!cam) return false;
  if (cam.gain < REALIGN_MIN_GAIN) return false; // the fit barely improves: a new viewpoint, not a shift/zoom
  return Math.abs(cam.scale - 1) >= 0.01 || cam.shiftPct >= 0.5;
}

export async function alignStagedToOriginal(original: Buffer, staged: Buffer, cam: CameraAlignment) {
  const om = await sharp(original).metadata();
  const W = om.width!, H = om.height!;
  const [o, s] = await Promise.all([
    sharp(original).removeAlpha().raw().toBuffer(),
    sharp(staged).removeAlpha().resize(W, H, { fit: "fill" }).raw().toBuffer(),
  ]);
  const out = Buffer.from(o);
  const empty = new Uint8Array(W * H);
  const cx = W / 2, cy = H / 2, dx = (cam.dxPct / 100) * W, dy = (cam.dyPct / 100) * H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // same mapping the camera check measured: real-photo pixel -> staged pixel
    const bx = cx + (x - cx) * cam.scale + dx, by = cy + (y - cy) * cam.scale + dy;
    const i = y * W + x;
    if (bx < 0 || by < 0 || bx > W - 1.001 || by > H - 1.001) { empty[i] = 1; continue; }
    const x0 = Math.floor(bx), y0 = Math.floor(by), tx = bx - x0, ty = by - y0;
    for (let c = 0; c < 3; c++) {
      const p = (xx: number, yy: number) => s[(yy * W + xx) * 3 + c];
      out[i * 3 + c] = Math.round((p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx) * (1 - ty) + (p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx) * ty);
    }
  }
  let n = 0;
  for (const v of empty) n += v;
  const aligned = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { aligned, empty, W, H, emptyPct: +((n / (W * H)) * 100).toFixed(1) };
}

// Edge crop: last resort when the blend could not continue the furniture cut
// off by the line-up's empty strip. The strip is trimmed away (plus a matching
// trim on the other axis so the photo keeps its shape) and the result is
// enlarged back to full size, so the pieces simply run off the photo's edge.
// Capped so it can never hide a real feature such as a heater or doorway.
export const EDGE_CROP_ENABLED = !["0", "off", "false", "no"].includes(String(process.env.STAGE2_EDGE_CROP || "").trim().toLowerCase());
export const EDGE_CROP_MAX_PCT = Number(process.env.STAGE2_EDGE_CROP_MAX_PCT || 4); // max share of width / height trimmed

export type EdgeCropPlan =
  | { ok: true; left: number; top: number; width: number; height: number; trimPct: { top: number; bottom: number; left: number; right: number }; zoomPct: number }
  | { ok: false; reason: string; trimPct?: { top: number; bottom: number; left: number; right: number } };

// The line-up's empty area is everything outside one rectangle (the part of
// the real photo Gemini's picture still covers), so each edge's strip is a run
// of (nearly) fully empty rows or columns.
export function planEdgeCrop(empty: Uint8Array, w: number, h: number, maxPct = EDGE_CROP_MAX_PCT): EdgeCropPlan {
  const rowEmpty = (y: number) => { let n = 0; for (let x = 0; x < w; x++) n += empty[y * w + x] ? 1 : 0; return n / w; };
  const colEmpty = (x: number) => { let n = 0; for (let y = 0; y < h; y++) n += empty[y * w + x] ? 1 : 0; return n / h; };
  let top = 0, bottom = 0, left = 0, right = 0;
  while (top < h && rowEmpty(top) > 0.5) top++;
  while (bottom < h - top && rowEmpty(h - 1 - bottom) > 0.5) bottom++;
  while (left < w && colEmpty(left) > 0.5) left++;
  while (right < w - left && colEmpty(w - 1 - right) > 0.5) right++;
  // A couple of extra pixels on each trimmed edge removes the soft seam.
  const pad = Math.max(2, Math.round(Math.max(w, h) * 0.002));
  if (top) top += pad; if (bottom) bottom += pad; if (left) left += pad; if (right) right += pad;
  const pct = (v: number, of: number) => +((v / of) * 100).toFixed(2);
  const trimPct = { top: pct(top, h), bottom: pct(bottom, h), left: pct(left, w), right: pct(right, w) };
  if (!(top || bottom || left || right)) return { ok: false, reason: "no empty strip at the edges", trimPct };
  // Nothing empty may be left inside the kept area.
  let inside = 0;
  for (let y = top; y < h - bottom; y++) for (let x = left; x < w - right; x++) inside += empty[y * w + x] ? 1 : 0;
  const keptArea = (h - top - bottom) * (w - left - right);
  if (keptArea <= 0 || inside / keptArea > 0.001) return { ok: false, reason: "empty area is not a plain edge strip", trimPct };
  // Same share off both axes keeps the photo's shape: extra trim is split
  // evenly between the two sides of the axis that needs it.
  const share = Math.max((top + bottom) / h, (left + right) / w);
  if (share * 100 > maxPct) return { ok: false, reason: `strip too wide to crop (${(share * 100).toFixed(1)}% > ${maxPct}%)`, trimPct };
  const extraV = Math.max(0, Math.round(share * h) - (top + bottom));
  const extraH = Math.max(0, Math.round(share * w) - (left + right));
  top += Math.floor(extraV / 2); bottom += Math.ceil(extraV / 2);
  left += Math.floor(extraH / 2); right += Math.ceil(extraH / 2);
  return {
    ok: true, left, top, width: w - left - right, height: h - top - bottom,
    trimPct: { top: pct(top, h), bottom: pct(bottom, h), left: pct(left, w), right: pct(right, w) },
    zoomPct: +((1 / (1 - share) - 1) * 100).toFixed(2),
  };
}

// Apply the plan to the final image (at its own size) and enlarge back to it.
export async function applyEdgeCrop(final: Buffer, plan: Extract<EdgeCropPlan, { ok: true }>, w: number, h: number): Promise<Buffer> {
  const fm = await sharp(final).metadata();
  const FW = fm.width!, FH = fm.height!;
  const sx = FW / w, sy = FH / h;
  const left = Math.round(plan.left * sx), top = Math.round(plan.top * sy);
  const width = Math.min(FW - left, Math.round(plan.width * sx)), height = Math.min(FH - top, Math.round(plan.height * sy));
  return sharp(final)
    .extract({ left, top, width, height })
    .resize(FW, FH, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
}

// Furniture that runs into the empty strip: Gemini's picture ended there, so
// the piece stops in a straight line short of the photo's edge. Returns the
// share of the strip's border that furniture touches (0 = nothing cut).
export async function furnitureCutAtEmptyEdge(furniture: Uint8Array, empty: Uint8Array, ew: number, eh: number, w: number, h: number) {
  const e = await sharp(Buffer.from(empty.map((v) => (v ? 255 : 0))), { raw: { width: ew, height: eh, channels: 1 } })
    .resize(w, h, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  let border = 0, touched = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (e[i] > 127) continue;
    if (!(e[i - 1] > 127 || e[i + 1] > 127 || e[i - w] > 127 || e[i + w] > 127)) continue;
    border++;
    let f = 0;
    for (let k = -3; k <= 3 && !f; k++) for (let j = -3; j <= 3; j++) {
      const yy = y + k, xx = x + j;
      if (yy >= 0 && xx >= 0 && yy < h && xx < w && furniture[yy * w + xx]) { f = 1; break; }
    }
    touched += f;
  }
  return { borderPx: border, cutPct: border ? +((touched / border) * 100).toFixed(1) : 0 };
}

// The part of the empty strip (left by the line-up) next to furniture that
// runs into it: where the cut pieces must be continued to the photo's edge.
export async function cutPieceCompletionZone(furniture: Uint8Array, empty: Uint8Array, ew: number, eh: number, w: number, h: number) {
  const e = await sharp(Buffer.from(empty.map((v) => (v ? 255 : 0))), { raw: { width: ew, height: eh, channels: 1 } })
    .resize(w, h, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const touch = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!furniture[i] || e[i] > 127) continue;
    for (let k = -3; k <= 3; k++) for (let j = -3; j <= 3; j++) {
      const yy = y + k, xx = x + j;
      if (yy >= 0 && xx >= 0 && yy < h && xx < w && e[yy * w + xx] > 127) { touch[i] = 1; k = 9; break; }
    }
  }
  // reach across the strip from each touching point (strip <= REALIGN_MAX_EMPTY_PCT)
  const grown = dilate(touch, w, h, Math.round(Math.max(w, h) * 0.12));
  // band: the first ~1% just past the cut line, where the piece must carry on
  const near = dilate(touch, w, h, Math.max(3, Math.round(Math.max(w, h) * 0.012)));
  const zone = new Uint8Array(w * h), band = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < zone.length; i++) if (grown[i] && e[i] > 127) { zone[i] = 1; n++; if (near[i]) band[i] = 1; }
  return { zone, band, zonePct: +((n / (w * h)) * 100).toFixed(2) };
}

// Put Gemini's continuation of the cut pieces (from its blend) into the final,
// inside the completion zone only. Reports how much of the zone Gemini really
// filled with something other than the bare floor (the real photo there).
export async function applyCutPieceCompletion(final: Buffer, harmRaw: Buffer, original: Buffer, zone: Uint8Array, band: Uint8Array, w: number, h: number) {
  const fm = await sharp(final).metadata();
  const FW = fm.width!, FH = fm.height!;
  const bandBig = await sharp(Buffer.from(band.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
    .resize(fm.width!, fm.height!, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const [f, g, o, z] = await Promise.all([
    sharp(final).removeAlpha().raw().toBuffer(),
    sharp(harmRaw).removeAlpha().resize(FW, FH, { fit: "fill" }).raw().toBuffer(),
    sharp(original).removeAlpha().resize(FW, FH, { fit: "fill" }).raw().toBuffer(),
    sharp(Buffer.from(zone.map((v) => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } })
      .resize(FW, FH, { fit: "fill" }).blur(Math.max(0.6, FW / 900)).extractChannel(0).raw().toBuffer(),
  ]);
  const out = Buffer.from(f);
  let inZone = 0, filled = 0;
  for (let i = 0; i < FW * FH; i++) {
    const t = z[i] / 255;
    if (t <= 0) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(f[i * 3 + c] * (1 - t) + g[i * 3 + c] * t);
    if (bandBig[i] > 127) {
      inZone++;
      const d = Math.abs(g[i * 3] - o[i * 3]) + Math.abs(g[i * 3 + 1] - o[i * 3 + 1]) + Math.abs(g[i * 3 + 2] - o[i * 3 + 2]);
      if (d > 60) filled++;
    }
  }
  const image = await sharp(out, { raw: { width: FW, height: FH, channels: 3 } }).png().toBuffer();
  return { image, filledPct: inZone ? +((filled / inZone) * 100).toFixed(1) : 0 };
}
