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
//   3. Paste back: staged pixels inside the (grown, feathered) mask, original
//      photo pixels everywhere else — so window removals, filled openings and
//      added light fittings outside the furniture cannot survive. The staged
//      image's overall brightness/colour is matched to the original first.
//   Framing check: paste-back only works if Gemini kept the room's shape. If
//   it reframed or reshaped the room, the photo is flagged for re-staging.
//
// Gemini settings (GEMINI_API_KEY etc.) are read from worker/.env automatically.
//
// Run from the worker folder:
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   REUSE_STAGED=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts   (reuse Test Images/Stage2_2K_Comparison)
//   ONLY=Bedroom12 npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   FROM_RUN=2026-10-11T05-08-04-943Z npx tsx src/scripts/stage2-mask-pasteback-test.ts   (rebuild from saved traces, free)
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "C:/photos/lounge.jpg:living_room"
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
const OUT = path.join(T, "Stage2_MaskPasteback", new Date().toISOString().replace(/[:.]/g, "-"));
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
// Rebuild from an earlier run's saved staged image and raw traces — no Gemini
// calls, no cost. Folder name under Test Images/Stage2_MaskPasteback, or a full path.
const FROM_RUN = process.env.FROM_RUN
  ? path.resolve(path.join(T, "Stage2_MaskPasteback"), process.env.FROM_RUN)
  : null;
// Mask growth, as a percentage of image width/height.
const GROW_PCT = Number(process.env.GROW_PCT || 1.0);
const SHADOW_PCT = Number(process.env.SHADOW_PCT || 2.5);
const FEATHER_PX = Number(process.env.FEATHER_PX || 4);
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

// Target lists match the continuity branch's two extractor passes.
const TRACE_PASSES = [
  { label: "primary", targets: "beds, sofas, dining tables, major rugs, major seating" },
  { label: "secondary", targets: "lamps, bedside tables, chairs, artwork, decor, plants, secondary furniture" },
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
function buildTracePrompt(roomType: string, targets: string): string {
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
    "- Mark the furniture silhouette and footprint regions as white, including rugs on the floor",
    "- Do NOT mark changes to the room itself, even if the two images differ there: windows, doors, openings, walls, ceilings, light fittings, curtains, blinds and built-in fixtures stay black",
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

// Final image is built at the staged (2K) resolution; the original is scaled
// up to match so both line up pixel for pixel.
async function pasteBack(original: Buffer, staged: Buffer, maskPng: Buffer, srcW: number, srcH: number) {
  const stagedMeta = await sharp(staged).metadata();
  const fw = stagedMeta.width || srcW;
  const fh = Math.round((fw * srcH) / srcW);
  const [orig, stg, alpha] = await Promise.all([
    sharp(original).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(staged).removeAlpha().resize(fw, fh, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(maskPng).resize(fw, fh, { fit: "fill" }).blur(Math.max(0.3, FEATHER_PX)).grayscale().raw().toBuffer(),
  ]);
  // Gemini often shifts the whole room's brightness/colour slightly while
  // staging. Measure that on the untouched area and correct the staged pixels
  // so pasted furniture matches the original lighting and edges don't show.
  const sums = [0, 0, 0, 0, 0, 0];
  let count = 0;
  for (let i = 0; i < fw * fh; i++) {
    if (alpha[i] > 12) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] += orig[i * 3 + c];
      sums[c + 3] += stg[i * 3 + c];
    }
    count++;
  }
  const gains = [0, 1, 2].map((c) => (count > 0 && sums[c + 3] > 0 ? Math.min(1.4, Math.max(0.7, sums[c] / sums[c + 3])) : 1));
  const out = Buffer.alloc(fw * fh * 3);
  for (let i = 0; i < fw * fh; i++) {
    const a = alpha[i] / 255;
    for (let c = 0; c < 3; c++) {
      const matched = Math.min(255, stg[i * 3 + c] * gains[c]);
      out[i * 3 + c] = Math.round(matched * a + orig[i * 3 + c] * (1 - a));
    }
  }
  return {
    buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(),
    width: fw,
    height: fh,
    colourGains: gains.map((g) => Number(g.toFixed(3))),
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
  return args.map((arg) => {
    const match = arg.match(/^(.*?)(?::([a-z_]+))?$/);
    const file = path.resolve(match?.[1] || arg);
    return { name: path.parse(file).name.replace(/[^A-Za-z0-9_-]+/g, "_"), file, roomType: match?.[2] || "living_room" };
  });
}

async function stageImage(img: { name: string; file: string; roomType: string }, dir: string): Promise<{ staged: Buffer; source: string }> {
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

async function runOne(img: { name: string; file: string; roomType: string }) {
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

  try {
    console.log(`[${img.name}] 1/3 stage`);
    const stageRes = await stageImage(img, dir);
    staged = stageRes.staged;
    row.staging = stageRes.source;
    if (!fs.existsSync(path.join(dir, "2_staged_raw.webp"))) fs.writeFileSync(path.join(dir, "2_staged_raw.webp"), staged);
    const stagedMeta = await sharp(staged).metadata();
    row.stagedSize = `${stagedMeta.width}x${stagedMeta.height}`;

    console.log(`[${img.name}] 2/3 trace (${FROM_RUN ? "saved traces, no Gemini call" : `${TRACE_MODEL}, ${TRACE_IMAGE_SIZE}, ${TRACE_PASSES.length} passes`})`);
    const passes = await Promise.all(
      TRACE_PASSES.map(async (pass) => {
        if (FROM_RUN) {
          const saved = fs.readFileSync(path.join(FROM_RUN, img.name, `3_trace_${pass.label}_raw.png`));
          fs.writeFileSync(path.join(dir, `3_trace_${pass.label}_raw.png`), saved);
          return { label: pass.label, ...(await binarizeTraceResponse(saved, w, h)), cost: 0 };
        }
        const res = await callGeminiImage({
          model: TRACE_MODEL,
          parts: [
            { text: buildTracePrompt(img.roomType, pass.targets) },
            { text: "STAGED_IMAGE" }, imagePart(staged!, "image/webp"),
            { text: "EMPTY_IMAGE" }, imagePart(original, mimeFor(img.file)),
          ],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        });
        fs.writeFileSync(path.join(dir, `3_trace_${pass.label}_raw.png`), res.image);
        const bin = await binarizeTraceResponse(res.image, w, h);
        return { label: pass.label, ...bin, cost: approxOutputCost(res.usage) };
      })
    );
    row.traceCostUsd = Number(passes.reduce((sum, p) => sum + (p.cost || 0), 0).toFixed(4));
    row.tracePasses = passes.map((p) => ({ pass: p.label, coveragePct: +(ratioOf(p.mask) * 100).toFixed(1), coloursFlipped: p.inverted }));

    // Merge (OR), then drop tiny specks only — thin parts like lamp stems and chair legs must survive.
    let mask = new Uint8Array(w * h);
    for (const p of passes) for (let i = 0; i < mask.length; i++) mask[i] |= p.mask[i];
    mask = removeSmallComponents(mask, w, h, Math.max(24, Math.round(w * h * 0.0002)));
    const tracedRatio = ratioOf(mask);
    mask = fillFurnitureColumns(mask, w, h);
    const furnitureRatio = ratioOf(mask);
    fs.writeFileSync(path.join(dir, "3_mask_traced.png"), await maskToPng(mask, w, h));
    if (furnitureRatio < 0.01) throw new Error(`tracing found almost no furniture (${(furnitureRatio * 100).toFixed(2)}% of image)`);

    // Grow for soft edges, and further downwards for floor shadows.
    mask = dilate(mask, w, h, Math.round((w * GROW_PCT) / 100));
    mask = growDown(mask, w, h, Math.round((h * SHADOW_PCT) / 100));
    row.maskPct = { traced: +(tracedRatio * 100).toFixed(1), furniture: +(furnitureRatio * 100).toFixed(1), afterGrow: +(ratioOf(mask) * 100).toFixed(1) };
    if (ratioOf(mask) > 0.7) console.warn(`[${img.name}] warning: mask covers ${(ratioOf(mask) * 100).toFixed(0)}% of the image — protection will be weak`);
    const maskPng = await maskToPng(mask, w, h);
    fs.writeFileSync(path.join(dir, "3_mask_final.png"), maskPng);
    traced = await maskOverlay(staged, mask, w, h);
    fs.writeFileSync(path.join(dir, "3_mask_overlay.jpg"), traced);

    row.stagedChangesOutsideMask = await measureOutsideDrift(original, staged, mask, w, h);
    row.framingCheck = await checkFraming(original, staged, mask, w, h);
    if (row.framingCheck.framingChanged) {
      console.warn(`[${img.name}] Gemini reshaped/reframed the room (typical wall/ceiling patch differs by ${row.framingCheck.medianDiff}) — paste-back can't fix this; this photo would need re-staging`);
    }
    undone = await undoneOverlay(original, staged, mask, w, h);
    fs.writeFileSync(path.join(dir, "4_changes_removed_by_pasteback.jpg"), undone);

    console.log(`[${img.name}] 3/3 paste back`);
    const pasted = await pasteBack(original, staged, maskPng, w, h);
    final = pasted.buffer;
    fs.writeFileSync(path.join(dir, "5_final_pasteback.webp"), final);
    row.finalSize = `${pasted.width}x${pasted.height}`;
    row.colourGains = pasted.colourGains;
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

  const sheet = await contactSheet(
    [
      { label: "1. Original", image: original },
      { label: "2. Gemini staged (raw)", image: staged },
      { label: "3. Traced furniture (red)", image: traced },
      { label: "4. Room changes removed (red)", image: undone },
      { label: row.framingCheck?.framingChanged ? "5. Final - ROOM RESHAPED, re-stage" : "5. Final (pasted back)", image: final },
    ],
    w,
    h
  );
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
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { fillFurnitureColumns, checkFraming, binarizeTraceResponse, measureOutsideDrift, pasteBack, maskToPng, maskOverlay, undoneOverlay, contactSheet, removeSmallComponents, dilate, growDown, ratioOf };
