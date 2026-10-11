// Stand-alone experiment: Stage 2 "stage, trace, paste back". Nothing here is
// wired into the live pipeline.
//
// Per image:
//   1. Stage: the normal Stage 2 generation (runStage2GenerationAttempt) at 2K,
//      one attempt, no validators. Or reuse an existing staged result.
//   2. Trace: Gemini is shown the empty photo and its staged version (same
//      camera position) and returns a black/white mask of the furniture it
//      added. Ported from feature/vertex-secondary-inpainting-continuity's
//      "original extractor" — the approach that produced clean bed/rug
//      outlines there: two passes run side by side (primary furniture, then
//      secondary pieces/decor), temperature 0, merged, tiny specks removed.
//   3. Layered merge, starting from the original photo:
//      - floor furniture (and anything sitting on it): staged pixels, thin edge;
//      - wall art (own trace pass): kept only on plain wall with the wall
//        around it unchanged, otherwise dropped;
//      - shadows around/below furniture: only the staged DARKENING is applied
//        to the original, and only where it looks like a real shadow;
//      - everything else stays original, so window removals, filled openings
//        and added light fittings cannot survive. The staged image's overall
//        brightness/colour is matched to the original first.
//   Framing check: paste-back only works if Gemini kept the room's shape. If
//   it reframed or reshaped the room, the photo is flagged for re-staging.
//
// Gemini settings (GEMINI_API_KEY etc.) are read from worker/.env automatically.
//
// Run from the worker folder:
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   REUSE_STAGED=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts   (reuse Test Images/Stage2_2K_Comparison)
//   ONLY=Bedroom12 npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   PAIR_MODE=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts "baseline.jpg:bedroom|failed_staged.jpg"
//     (no staging: traces the furniture in the failed image and pastes it onto the baseline)
//   MERGE_MODE=all  compares original-first, staged-first and hybrid side by side (or: hybrid, staged_first, both)
//   MERGE_MODE=both  (or staged_first) also builds the staged-first result: start from the staged image, revert room changes
//   DEBUG_LAYERS_DIR=/some/folder  saves the merge's decision maps (solid, core, zone, take, factor) there
//   FROM_RUN=2026-10-11T05-08-04-943Z npx tsx src/scripts/stage2-mask-pasteback-test.ts   (rebuild from saved traces, free)
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "C:/photos/lounge.jpg:living_room"
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "photo.jpg:bedroom|old_failed_attempt.webp"
//     (anything after "|" is an earlier failed result, shown first in the comparison sheet)
//
// Output: Test Images/Stage2_MaskPasteback/<run timestamp>/

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { generateContentViaRest } from "../ai/geminiRestClient";

// The worker package does not depend on `dotenv`. Load worker/.env with the
// same minimal parser as measure-stage1a-pregen.ts so GEMINI_API_KEY (and the
// rest of the worker's Gemini settings) are picked up. Values already set in
// the shell win over the file.
function loadDotEnvIfPresent(envPath: string) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIfPresent(path.resolve(__dirname, "../../.env"));

const ROOT = path.resolve(__dirname, "../../..");
const T = path.join(ROOT, "Test Images");
// OUT_DIR (optional): results folder, relative to Test Images. A timestamped
// subfolder is always created inside it.
const OUT = path.join(
  process.env.OUT_DIR ? path.resolve(T, process.env.OUT_DIR) : path.join(T, "Stage2_MaskPasteback"),
  new Date().toISOString().replace(/[:.]/g, "-")
);
const PREVIOUS_STAGED_DIR = path.join(T, "Stage2_2K_Comparison");

// Same set as stage2-2k-compare.ts so results can be compared side by side.
const DEFAULT_IMAGES: Array<{ name: string; file: string; roomType: string }> = [
  { name: "Living07", file: "Living (Baseline)/Living 07.jpg", roomType: "living_room" },
  { name: "Living10", file: "Living (Baseline)/Living 10.jpg", roomType: "living_room" },
  { name: "Diningroom01", file: "Living (Baseline)/Diningroom 01.webp", roomType: "dining_room" },
  { name: "Validator_2327860184", file: "Validator Testing Images/2327860184.jpg", roomType: "living_room" },
  { name: "Bedroom14", file: "Validator Testing Images/Bedroom 14.jpg", roomType: "bedroom" },
  { name: "Bedroom12", file: "Validator Testing Images/job_59ac76ce_Bedroom_12_UPLOAD.jpg", roomType: "bedroom" },
];

const STAGE_MODEL = process.env.STAGE_MODEL || "gemini-3.1-flash-image";
const TRACE_MODEL = process.env.TRACE_MODEL || "gemini-3.1-flash-image";
const TRACE_IMAGE_SIZE = (process.env.TRACE_IMAGE_SIZE || "1K").toUpperCase();
const STAGING_STYLE = process.env.STAGING_STYLE || "nz_standard";
const REUSE_STAGED = process.env.REUSE_STAGED === "1";
// PAIR_MODE=1: no staging call. The image after "|" in each argument (an
// already-generated, typically failed, staged result) is used as the staged
// image; only its furniture is traced and pasted onto the baseline. This shows
// whether paste-back would have prevented that failure.
const PAIR_MODE = process.env.PAIR_MODE === "1";
// Wall art is traced in its own pass and kept only where it is safe (see
// evaluateWallArt): on plain wall, with the wall around it unchanged. Art is
// where a removed fireplace or a new opening hides, so it is never kept
// blindly. TRACE_ARTWORK=0 leaves art out entirely.
const TRACE_ARTWORK = process.env.TRACE_ARTWORK !== "0";
// Rebuild from an earlier run's saved staged image and raw traces — no Gemini
// calls, no cost. Folder name under Test Images/Stage2_MaskPasteback, or a full path.
const FROM_RUN = process.env.FROM_RUN
  ? path.resolve(path.join(T, "Stage2_MaskPasteback"), process.env.FROM_RUN)
  : null;
// Layered merge settings.
// - Solid layer (furniture + kept art): staged pixels, with only a thin margin.
// - Shadow zone around floor furniture: only the DARKENING from the staged
//   image is transferred onto the original photo, and only where it looks like
//   a real shadow, so walls/doors/frames there always stay original.
const SOLID_GROW_PCT = Number(process.env.SOLID_GROW_PCT || 0.25); // % of width
// Only the CORE of each piece of furniture (the traced shape shrunk by this
// much) is always taken from the staged image. In its thin outer band the
// staged pixel is used unless it is essentially identical to the original
// (trace overshoot onto unchanged wall/floor), in which case the original is
// kept. Shadows are only judged OUTSIDE the traced shape.
const CORE_ERODE_PCT = Number(process.env.CORE_ERODE_PCT || 0.6); // % of width
const ZONE_GROW_PCT = Number(process.env.ZONE_GROW_PCT || 2); // % of width, all round
const ZONE_DOWN_PCT = Number(process.env.ZONE_DOWN_PCT || 4); // % of height, extra downwards
const FEATHER_PX = Number(process.env.FEATHER_PX || 1.5); // at the 2K output size
// MERGE_MODE:
//   original_first (default) — start from the original photo, add furniture,
//     art and shadows from the staged image.
//   staged_first — start from the staged image (natural shadows/lighting) and
//     revert to the original anywhere the room itself changed.
//   both — original-first and staged-first side by side.
//   hybrid — original-first for the room, but Gemini's own pixels (natural
//     shadows/contact shading) around the furniture wherever only shading
//     differs there.
//   all — original-first, staged-first and hybrid side by side.
const MERGE_MODE = (process.env.MERGE_MODE || "original_first").toLowerCase();
// Wall-art safety checks, calibrated on the failed-pair and fresh-staging test
// images: bare wall scores 0 on the busiest patch, while windows, doors, a
// fireplace corbel, switches/power points and wall corners score 33-96; the
// wall around good art differs by ~17, around art on a removed wall by ~78.
const ART_MAX_BUSY_PATCH = 20; // % strong-edge pixels in the busiest small patch underneath
const ART_MAX_EDGE_PCT = 5; // % strong-edge pixels under the whole artwork
const ART_MAX_WALL_STD = 25; // brightness variation underneath (plain wall is low)
const ART_MAX_RING_DIFF = 30; // how much the wall around the art changed in staging
// Same "changed pixel" threshold as the outside-mask drift check on feature/vertex-mask-inpainting.
const CHANGE_THRESHOLD = 18;
// Framing check. A wall/ceiling patch counts as changed above CHANGED_TILE_DIFF
// (average grey-level difference). The photo is flagged as reframed when the
// MEDIAN patch is above REFRAMED_MEDIAN_DIFF — a median ignores a few locally
// changed spots (a removed window) but not a moved/reshaped room. Calibrated
// on Test Images/Stage2_2K_Comparison: the two reframed results scored 28.9
// and 30.9, the ten good ones 10.2 or lower.
const CHANGED_TILE_DIFF = 12;
const REFRAMED_MEDIAN_DIFF = Number(process.env.REFRAMED_MEDIAN_DIFF || 15);
// Gemini 3.1 Flash Image output tokens, USD per 1M (Google pricing page, Oct 2026).
const OUTPUT_PRICE_PER_M = Number(process.env.OUTPUT_PRICE_PER_M || 60);

// The Stage 2 model is read once when the Stage 2 code first loads, so these
// must be set before anything imports ../ai/gemini or ../pipeline/stage2.
process.env.USE_GEMINI_STAGE2 = "1";
process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = STAGE_MODEL;
process.env.REALENHANCE_STAGE2_IMAGE_SIZE = process.env.REALENHANCE_STAGE2_IMAGE_SIZE || "2K";

// Floor-furniture targets match the continuity branch's two extractor passes;
// wall art has its own pass so it can be checked separately.
type TraceKind = "floor" | "wall_art";
const TRACE_PASSES: Array<{ label: string; kind: TraceKind; targets: string }> = [
  { label: "primary", kind: "floor", targets: "beds, sofas, dining tables, major rugs, major seating" },
  { label: "secondary", kind: "floor", targets: "lamps, bedside tables, chairs, decor on furniture, plants, secondary furniture" },
  ...(TRACE_ARTWORK
    ? [{ label: "wall_art", kind: "wall_art" as TraceKind, targets: "framed artwork, prints, paintings, canvases and mirrors hung on walls" }]
    : []),
];

// ── Gemini tracing call ──────────────────────────────────────────────────────

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function imagePart(buffer: Buffer, mimeType: string) {
  return { inlineData: { mimeType, data: buffer.toString("base64") } };
}

async function callGeminiImage(params: {
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
function buildTracePrompt(roomType: string, targets: string, kind: TraceKind = "floor"): string {
  const kindRules =
    kind === "wall_art"
      ? ["- Mark ONLY items hung on walls. Do NOT mark furniture, lamps, plants, rugs, TVs, shelves, curtains, blinds or light fittings — they stay black"]
      : ["- Do NOT mark anything hung on or attached to walls (artwork, mirrors, shelves, TVs) — it stays black"];
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
      : "- Mark the furniture silhouette and footprint regions as white, including rugs on the floor",
    "- Do NOT mark changes to the room itself, even if the two images differ there: windows, doors, openings, walls, ceilings, light fittings, curtains, blinds and built-in fixtures stay black",
    ...kindRules,
    `Room type: ${roomType.replace(/_/g, " ")}`,
  ].join("\n");
}

// Turns Gemini's mask image into a 0/1 mask at the original photo size.
// Transparent pixels count as black; if most of the frame comes back white the
// model has flipped the colours, so it is inverted (the continuity branch
// handled the same polarity problem).
async function binarizeTraceResponse(image: Buffer, w: number, h: number) {
  const gray = await sharp(image)
    .flatten({ background: "#000000" })
    .resize(w, h, { fit: "fill", kernel: sharp.kernel.nearest })
    .grayscale()
    .raw()
    .toBuffer();
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] >= 128 ? 1 : 0;
  let inverted = false;
  if (ratioOf(mask) > 0.6) {
    mask = invert(mask);
    inverted = true;
  }
  return { mask, inverted };
}

// ── Mask helpers (binary masks: Uint8Array of 0/1, row-major) ────────────────

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
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

function invert(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] ? 0 : 1;
  return out;
}

function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return invert(dilate(invert(src), w, h, r));
}

// Extends every masked pixel straight down by n pixels, so floor shadows
// cast below furniture land inside the editable area.
function growDown(src: Uint8Array, w: number, h: number, n: number): Uint8Array {
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
function fillFurnitureColumns(src: Uint8Array, w: number, h: number): Uint8Array {
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

function removeSmallComponents(src: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
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

function ratioOf(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count / mask.length;
}

function maskToPng(mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const px = Buffer.alloc(w * h);
  for (let i = 0; i < mask.length; i++) px[i] = mask[i] ? 255 : 0;
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

// Splits a mask into separate pieces (4-connected). Returns each piece's pixel
// indices and bounding box.
function labelComponents(src: Uint8Array, w: number, h: number) {
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
async function evaluateWallArt(original: Buffer, staged: Buffer, artMask: Uint8Array, floorMask: Uint8Array, w: number, h: number) {
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
async function refineArtRegion(original: Buffer, staged: Buffer, artKeep: Uint8Array, w: number, h: number): Promise<Uint8Array> {
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
async function compositeLayers(
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
  hybrid = false
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
  for (let i = 0; i < N; i++) {
    const sa = solidA[i] / 255, ca = coreA[i] / 255, za = zoneA[i] / 255;
    // How strongly the staged pixel is used: always in the core, per-pixel in the band.
    const bandTake = takeSmooth[i] / 255;
    const a = Math.min(1, ca + sa * (1 - ca) * bandTake);
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
    shadowPctOfZone: zonePixels ? Number(((shadowPixels / zonePixels) * 100).toFixed(1)) : 0,
    edgeBandStagedPct: bandPixels ? Number(((bandStaged / bandPixels) * 100).toFixed(1)) : 0,
    hybridStagedPctOfImage: hybrid ? Number(((hybridStagedPixels / N) * 100).toFixed(1)) : undefined,
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
async function compositeStagedFirst(original: Buffer, staged: Buffer, solidPng: Buffer, srcW: number, srcH: number) {
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

// Panel 3: furniture red, kept wall art blue, dropped wall art orange.
async function layersOverlay(staged: Buffer, floor: Uint8Array, artKept: Uint8Array, artDropped: Uint8Array, w: number, h: number): Promise<Buffer> {
  const raw = await sharp(staged).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  const tint = (i: number, r: number, g2: number, b: number) => {
    raw[i * 3] = Math.round(raw[i * 3] * 0.45 + r * 0.55);
    raw[i * 3 + 1] = Math.round(raw[i * 3 + 1] * 0.45 + g2 * 0.55);
    raw[i * 3 + 2] = Math.round(raw[i * 3 + 2] * 0.45 + b * 0.55);
  };
  for (let i = 0; i < w * h; i++) {
    if (artDropped[i]) tint(i, 255, 140, 0);
    else if (artKept[i]) tint(i, 40, 110, 255);
    else if (floor[i]) tint(i, 255, 0, 80);
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

// ── Measurements and output images ──────────────────────────────────────────

// How much the raw Gemini output changed OUTSIDE the mask, compared with the
// original. High numbers = Gemini altered windows/walls/etc. (or shifted the
// framing) on its own — the things paste-back is there to undo.
async function measureOutsideDrift(original: Buffer, staged: Buffer, mask: Uint8Array, w: number, h: number) {
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

async function maskOverlay(original: Buffer, mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const raw = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    raw[i * 3] = Math.round(raw[i * 3] * 0.5 + 255 * 0.5);
    raw[i * 3 + 1] = Math.round(raw[i * 3 + 1] * 0.5);
    raw[i * 3 + 2] = Math.round(raw[i * 3 + 2] * 0.5 + 80 * 0.5);
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function contactSheet(panels: Array<{ label: string; image: Buffer | null }>, srcW: number, srcH: number): Promise<Buffer> {
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

function approxOutputCost(usage: any): number | null {
  const tokens = Number(usage?.candidatesTokenCount);
  return Number.isFinite(tokens) ? Number(((tokens * OUTPUT_PRICE_PER_M) / 1_000_000).toFixed(4)) : null;
}

// Checks whether Gemini kept the room's geometry. The area outside the mask is
// split into tiles and each textured tile is compared with the staged image.
// A removed window only spoils a few tiles, but a reframed or re-shaped room
// spoils many — and paste-back cannot repair that.
async function checkFraming(original: Buffer, staged: Buffer, mask: Uint8Array, w: number, h: number) {
  const sw = 480;
  const sh = Math.round((sw * h) / w);
  const [a, b, m] = await Promise.all([
    sharp(original).removeAlpha().resize(sw, sh, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(staged).removeAlpha().resize(sw, sh, { fit: "fill" }).grayscale().raw().toBuffer(),
    sharp(await maskToPng(mask, w, h)).resize(sw, sh, { fit: "fill" }).raw().toBuffer(),
  ]);
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

// Red where the raw staged image changed the room OUTSIDE the furniture mask —
// i.e. exactly what paste-back throws away.
async function undoneOverlay(original: Buffer, staged: Buffer, mask: Uint8Array, w: number, h: number): Promise<Buffer> {
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

// ── Main ─────────────────────────────────────────────────────────────────────

function resolveImages() {
  const args = process.argv.slice(2);
  if (args.length === 0) return DEFAULT_IMAGES.map((img) => ({ ...img, file: path.join(T, img.file) }));
  // "path/to/photo.jpg:room_type" (room type defaults to living_room).
  // "path/to/photo.jpg:room_type|path/to/old_failed_attempt.webp" — room type
  // defaults to living_room; the old attempt is optional.
  return args.map((arg) => {
    const [photoPart, previousPart] = arg.split("|");
    const match = photoPart.match(/^(.*?)(?::([a-z_]+))?$/);
    const file = path.resolve(match?.[1] || photoPart);
    const previousFile = previousPart ? path.resolve(previousPart.trim()) : undefined;
    return { name: path.parse(file).name.replace(/[^A-Za-z0-9_-]+/g, "_"), file, roomType: match?.[2] || "living_room", previousFile };
  });
}

async function stageImage(img: { name: string; file: string; roomType: string; previousFile?: string }, dir: string): Promise<{ staged: Buffer; source: string }> {
  if (PAIR_MODE) {
    if (!img.previousFile || !fs.existsSync(img.previousFile)) {
      throw new Error(`PAIR_MODE: no staged image given after "|" (or file missing): ${img.previousFile || "none"}`);
    }
    return { staged: fs.readFileSync(img.previousFile), source: `pair image ${path.basename(img.previousFile)} (no staging call)` };
  }
  if (FROM_RUN) {
    const previous = path.join(FROM_RUN, img.name, "2_staged_raw.webp");
    if (!fs.existsSync(previous)) throw new Error(`FROM_RUN: no staged image at ${previous}`);
    return { staged: fs.readFileSync(previous), source: `from run ${path.basename(FROM_RUN)}` };
  }
  if (REUSE_STAGED) {
    const previous = path.join(PREVIOUS_STAGED_DIR, `${img.name}__${STAGE_MODEL}.webp`);
    if (fs.existsSync(previous)) return { staged: fs.readFileSync(previous), source: `reused ${path.relative(T, previous)}` };
    console.warn(`[${img.name}] no previous staged result at ${previous} — staging now`);
  }
  const { runStage2GenerationAttempt } = await import("../pipeline/stage2");
  const input = path.join(dir, `stage2_input${path.extname(img.file)}`);
  fs.copyFileSync(img.file, input);
  const outputPath = path.join(dir, "2_staged_raw.webp");
  await runStage2GenerationAttempt(input, {
    roomType: img.roomType, sceneType: "interior", promptMode: "full", sourceStage: "1A",
    stagingStyle: STAGING_STYLE, jobId: `pasteback_${img.name}`, imageId: img.name, outputPath, attempt: 1,
  });
  // STAGE2_PROMPT_VARIANT=grok/grok_skill (from worker/.env) sends staging to
  // Grok's image-edit API instead of Gemini, exactly as in production.
  const variant = String(process.env.STAGE2_PROMPT_VARIANT || "").trim();
  const stagedWith = variant === "grok" || variant === "grok_skill" ? `grok (${process.env.GROK_IMAGE_MODEL || "grok-imagine-image-quality"})` : STAGE_MODEL;
  return { staged: fs.readFileSync(outputPath), source: `staged now (${stagedWith}${variant ? `, STAGE2_PROMPT_VARIANT=${variant}` : ""})` };
}

async function runOne(img: { name: string; file: string; roomType: string; previousFile?: string }) {
  const t0 = Date.now();
  const dir = path.join(OUT, img.name);
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(img.file);
  const meta = await sharp(original).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  const { closestGeminiAspectRatio } = await import("../ai/gemini");
  const aspectRatio = closestGeminiAspectRatio(w, h);
  fs.writeFileSync(path.join(dir, `1_original${path.extname(img.file)}`), original);
  const row: any = { image: img.name, roomType: img.roomType, input: `${w}x${h}`, aspectRatio };
  let staged: Buffer | null = null, traced: Buffer | null = null, undone: Buffer | null = null, final: Buffer | null = null;
  let stagedFirstFinal: Buffer | null = null, stagedFirstReverted: Buffer | null = null, hybridFinal: Buffer | null = null;

  try {
    console.log(`[${img.name}] 1/3 stage`);
    const stageRes = await stageImage(img, dir);
    staged = stageRes.staged;
    row.staging = stageRes.source;
    if (!fs.existsSync(path.join(dir, "2_staged_raw.webp"))) fs.writeFileSync(path.join(dir, "2_staged_raw.webp"), staged);
    const stagedMeta = await sharp(staged).metadata();
    const stagedMime = stagedMeta.format === "jpeg" ? "image/jpeg" : stagedMeta.format === "png" ? "image/png" : "image/webp";
    row.stagedSize = `${stagedMeta.width}x${stagedMeta.height}`;

    console.log(`[${img.name}] 2/3 trace (${FROM_RUN ? "saved traces, no Gemini call" : `${TRACE_MODEL}, ${TRACE_IMAGE_SIZE}, ${TRACE_PASSES.length} passes`})`);
    const passes = await Promise.all(
      TRACE_PASSES.map(async (pass) => {
        if (FROM_RUN) {
          const savedPath = path.join(FROM_RUN, img.name, `3_trace_${pass.label}_raw.png`);
          if (!fs.existsSync(savedPath)) {
            console.warn(`[${img.name}] FROM_RUN: no saved "${pass.label}" trace — treating it as empty`);
            return { label: pass.label, kind: pass.kind, mask: new Uint8Array(w * h), inverted: false, cost: 0 };
          }
          const saved = fs.readFileSync(savedPath);
          fs.writeFileSync(path.join(dir, `3_trace_${pass.label}_raw.png`), saved);
          return { label: pass.label, kind: pass.kind, ...(await binarizeTraceResponse(saved, w, h)), cost: 0 };
        }
        const res = await callGeminiImage({
          model: TRACE_MODEL,
          parts: [
            { text: buildTracePrompt(img.roomType, pass.targets, pass.kind) },
            { text: "STAGED_IMAGE" }, imagePart(staged!, stagedMime),
            { text: "EMPTY_IMAGE" }, imagePart(original, mimeFor(img.file)),
          ],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        });
        fs.writeFileSync(path.join(dir, `3_trace_${pass.label}_raw.png`), res.image);
        const bin = await binarizeTraceResponse(res.image, w, h);
        return { label: pass.label, kind: pass.kind, ...bin, cost: approxOutputCost(res.usage) };
      })
    );
    row.traceCostUsd = Number(passes.reduce((sum, p) => sum + (p.cost || 0), 0).toFixed(4));
    row.tracePasses = passes.map((p) => ({ pass: p.label, coveragePct: +(ratioOf(p.mask) * 100).toFixed(1), coloursFlipped: p.inverted }));

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
    const tracedRatio = ratioOf(floor);
    floor = fillFurnitureColumns(floor, w, h);
    const furnitureRatio = ratioOf(floor);
    fs.writeFileSync(path.join(dir, "3_mask_traced.png"), await maskToPng(floor, w, h));
    if (furnitureRatio < 0.01) throw new Error(`tracing found almost no furniture (${(furnitureRatio * 100).toFixed(2)}% of image)`);

    // Wall art: its own layer, kept piece by piece only where it is safe.
    const art = await evaluateWallArt(original, staged, artAll, floor, w, h);
    row.wallArt = art.report;
    for (const piece of art.report) {
      console.log(`[${img.name}] wall art ${piece.kept ? "KEPT" : "DROPPED"} (${piece.areaPct}% of image): ${piece.reason}`);
    }

    // Solid layer = furniture + kept art, with a thin margin. Shadow zone =
    // around and below floor furniture, outside the solid layer.
    const artRegion = await refineArtRegion(original, staged, art.keep, w, h);
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
      solid: +(ratioOf(solid) * 100).toFixed(1),
      shadowZone: +(ratioOf(zone) * 100).toFixed(1),
    };
    // Core = furniture shrunk inwards; wall art has no core (decided per pixel).
    const core = erode(floor, w, h, Math.max(1, Math.round((w * CORE_ERODE_PCT) / 100)));
    for (let i = 0; i < core.length; i++) core[i] |= artRegion[i];
    const solidPng = await maskToPng(solid, w, h);
    fs.writeFileSync(path.join(dir, "3_mask_final.png"), solidPng);
    fs.writeFileSync(path.join(dir, "3_mask_shadow_zone.png"), await maskToPng(zone, w, h));
    traced = await layersOverlay(staged, floor, artRegion, art.dropped, w, h);
    fs.writeFileSync(path.join(dir, "3_mask_overlay.jpg"), traced);

    // Room-change measurements ignore furniture and ALL traced art (kept or
    // dropped), so they reflect the room itself.
    const measureMask = new Uint8Array(w * h);
    for (let i = 0; i < measureMask.length; i++) measureMask[i] = solid[i] | artAll[i];
    row.stagedChangesOutsideMask = await measureOutsideDrift(original, staged, measureMask, w, h);
    row.framingCheck = await checkFraming(original, staged, measureMask, w, h);
    if (row.framingCheck.framingChanged) {
      console.warn(`[${img.name}] Gemini reshaped/reframed the room (typical wall/ceiling patch differs by ${row.framingCheck.medianDiff}) — paste-back can't fix this; this photo would need re-staging`);
    }
    undone = await undoneOverlay(original, staged, solid, w, h);
    fs.writeFileSync(path.join(dir, "4_changes_removed_by_pasteback.jpg"), undone);

    console.log(`[${img.name}] 3/3 layered merge`);
    const zonePng = await maskToPng(zone, w, h);
    const pasted = await compositeLayers(original, staged, solidPng, await maskToPng(core, w, h), zonePng, w, h);
    final = pasted.buffer;
    fs.writeFileSync(path.join(dir, "5_final_pasteback.webp"), final);
    row.finalSize = `${pasted.width}x${pasted.height}`;
    row.colourGains = pasted.colourGains;
    row.shadowPctOfZone = pasted.shadowPctOfZone;
    row.edgeBandStagedPct = pasted.edgeBandStagedPct;
    if (MERGE_MODE === "hybrid" || MERGE_MODE === "all") {
      const hy = await compositeLayers(original, staged, solidPng, await maskToPng(core, w, h), zonePng, w, h, true);
      hybridFinal = hy.buffer;
      fs.writeFileSync(path.join(dir, "7_final_hybrid.webp"), hy.buffer);
      row.hybrid = { stagedAroundFurniturePctOfImage: hy.hybridStagedPctOfImage };
    }
    if (MERGE_MODE === "staged_first" || MERGE_MODE === "both" || MERGE_MODE === "all") {
      const sf = await compositeStagedFirst(original, staged, solidPng, w, h);
      stagedFirstFinal = sf.buffer;
      stagedFirstReverted = sf.revertedView;
      fs.writeFileSync(path.join(dir, "6_final_staged_first.webp"), sf.buffer);
      fs.writeFileSync(path.join(dir, "6_staged_first_reverted.jpg"), sf.revertedView);
      row.stagedFirst = { revertedPctOfImage: sf.revertedPct };
    }
    // A big average change across the untouched room usually means Gemini
    // re-lit or slightly reframed the photo, which can leave visible seams.
    if (row.stagedChangesOutsideMask.meanAbsoluteDelta > 8) {
      row.checkSeams = true;
      console.warn(`[${img.name}] Gemini changed the rest of the room a lot (avg ${row.stagedChangesOutsideMask.meanAbsoluteDelta}) — check panel 5 for seams`);
    }
    row.ok = true;
  } catch (e: any) {
    row.ok = false;
    row.error = String(e?.message || e).slice(0, 400);
  }

  let previous: Buffer | null = null;
  if (img.previousFile && !PAIR_MODE) {
    if (fs.existsSync(img.previousFile)) {
      previous = fs.readFileSync(img.previousFile);
      fs.writeFileSync(path.join(dir, `0_old_failed_attempt${path.extname(img.previousFile)}`), previous);
      row.oldFailedAttempt = path.relative(ROOT, img.previousFile);
    } else {
      console.warn(`[${img.name}] old attempt not found: ${img.previousFile}`);
    }
  }
  const reshaped = row.framingCheck?.framingChanged ? " - RESHAPED, re-stage" : "";
  const panels =
    MERGE_MODE === "all"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Original-first" + reshaped, image: final },
          { label: "4. Staged-first" + reshaped, image: stagedFirstFinal },
          { label: "5. Hybrid" + reshaped, image: hybridFinal },
        ]
      : MERGE_MODE === "hybrid"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art kept blue / dropped orange", image: traced },
          { label: "4. Hybrid result" + reshaped, image: hybridFinal },
        ]
      : MERGE_MODE === "both"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art kept blue / dropped orange", image: traced },
          { label: "4. Original-first result" + reshaped, image: final },
          { label: "5. Staged-first: reverted areas (red)", image: stagedFirstReverted },
          { label: "6. Staged-first result" + reshaped, image: stagedFirstFinal },
        ]
      : [
          ...(previous ? [{ label: "0. Old failed attempt", image: previous }] : []),
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art kept blue / dropped orange", image: traced },
          ...(MERGE_MODE === "staged_first"
            ? [
                { label: "4. Staged-first: reverted areas (red)", image: stagedFirstReverted },
                { label: "5. Staged-first result" + reshaped, image: stagedFirstFinal },
              ]
            : [
                { label: "4. Room changes removed (red)", image: undone },
                { label: row.framingCheck?.framingChanged ? "5. Final - ROOM RESHAPED, re-stage" : "5. Final (pasted back)", image: final },
              ]),
        ];
  const sheet = await contactSheet(panels, w, h);
  fs.writeFileSync(path.join(OUT, `${img.name}__compare.jpg`), sheet);
  row.seconds = (Date.now() - t0) / 1000;
  console.log("RESULT", JSON.stringify(row));
  return row;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.ONLY;
  const rows: any[] = [];
  for (const img of resolveImages()) {
    if (only && !img.name.includes(only)) continue;
    if (!fs.existsSync(img.file)) {
      console.warn(`Skipping ${img.name}: file not found (${img.file})`);
      continue;
    }
    rows.push(await runOne(img));
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
  console.log(`\nDone. ${rows.filter((r) => r.ok).length}/${rows.length} succeeded.`);
  console.log(`Open the *__compare.jpg files in: ${OUT}`);
}

if (require.main === module) {
  // Exit explicitly: the worker modules this loads (Stage 2, Gemini helpers)
  // keep background connections/timers open, so Node would otherwise never
  // exit after the results are written.
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { compositeStagedFirst, refineArtRegion, evaluateWallArt, compositeLayers, layersOverlay, labelComponents, fillFurnitureColumns, checkFraming, binarizeTraceResponse, measureOutsideDrift, maskToPng, maskOverlay, undoneOverlay, contactSheet, removeSmallComponents, dilate, growDown, ratioOf };
