// Stand-alone experiment: Stage 2 staging with a furniture-shape mask and a
// "paste back" composite. Nothing here is wired into the live pipeline.
//
// Per image:
//   1. Layout call (Gemini, 1K): draw proposed furniture as flat magenta shapes.
//   2. Mask: keep only the magenta pixels, clean up, grow a little (plus extra
//      downwards for floor shadows).
//   3. Staging call (Gemini, 2K): photo + magenta plan + mask, "only add
//      furniture in the white areas".
//   4. Paste back: staged pixels inside the (feathered) mask, original photo
//      pixels everywhere else — so windows, doors, openings, ceilings and
//      light fittings outside the furniture area cannot change.
//
// Run from the worker folder:
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   ONLY=Bedroom12 npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "C:/photos/lounge.jpg:living_room"
//
// Output: Test Images/Stage2_MaskPasteback/<run timestamp>/

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { generateContentViaRest } from "../ai/geminiRestClient";
import { closestGeminiAspectRatio } from "../ai/gemini";
import { STYLE_PROMPT_MODIFIERS, normalizeStagingStyle } from "../ai/stagingStyles";

const ROOT = path.resolve(__dirname, "../../..");
const T = path.join(ROOT, "Test Images");
const OUT = path.join(T, "Stage2_MaskPasteback", new Date().toISOString().replace(/[:.]/g, "-"));

// Same set as stage2-2k-compare.ts so results can be compared side by side.
const DEFAULT_IMAGES: Array<{ name: string; file: string; roomType: string }> = [
  { name: "Living07", file: "Living (Baseline)/Living 07.jpg", roomType: "living_room" },
  { name: "Living10", file: "Living (Baseline)/Living 10.jpg", roomType: "living_room" },
  { name: "Diningroom01", file: "Living (Baseline)/Diningroom 01.webp", roomType: "dining_room" },
  { name: "Validator_2327860184", file: "Validator Testing Images/2327860184.jpg", roomType: "living_room" },
  { name: "Bedroom14", file: "Validator Testing Images/Bedroom 14.jpg", roomType: "bedroom" },
  { name: "Bedroom12", file: "Validator Testing Images/job_59ac76ce_Bedroom_12_UPLOAD.jpg", roomType: "bedroom" },
];

const LAYOUT_MODEL = process.env.LAYOUT_MODEL || "gemini-3.1-flash-image";
const STAGE_MODEL = process.env.STAGE_MODEL || "gemini-3.1-flash-image";
const LAYOUT_IMAGE_SIZE = (process.env.LAYOUT_IMAGE_SIZE || "1K").toUpperCase();
const STAGE_IMAGE_SIZE = (process.env.STAGE_IMAGE_SIZE || "2K").toUpperCase();
const STAGING_STYLE = normalizeStagingStyle(process.env.STAGING_STYLE || "standard_listing");
// Mask growth, as a percentage of image width/height.
const GROW_PCT = Number(process.env.GROW_PCT || 1.2);
const SHADOW_PCT = Number(process.env.SHADOW_PCT || 2.5);
const FEATHER_PX = Number(process.env.FEATHER_PX || 4);
// Same "changed pixel" threshold as the outside-mask drift check on feature/vertex-mask-inpainting.
const CHANGE_THRESHOLD = 18;
// Gemini 3.1 Flash Image output tokens, USD per 1M (Google pricing page, Oct 2026).
const OUTPUT_PRICE_PER_M = Number(process.env.OUTPUT_PRICE_PER_M || 60);

const ROOM_LABELS: Record<string, string> = {
  living_room: "living room",
  dining_room: "dining room",
  bedroom: "bedroom",
};

const FURNITURE_HINTS: Record<string, string> = {
  living_room: "a sofa, one or two armchairs, a coffee table, a rug and a side table",
  dining_room: "a dining table with chairs and, if there is room, a sideboard",
  bedroom: "a bed, two bedside tables and, if there is room, a chest of drawers",
};

// ── Gemini calls ─────────────────────────────────────────────────────────────

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
  temperature: number;
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
        temperature: params.temperature,
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

function buildLayoutPrompt(roomType: string): string {
  const room = ROOM_LABELS[roomType] || roomType.replace(/_/g, " ");
  const hint = FURNITURE_HINTS[roomType] || "the furniture a professional stager would use";
  return [
    `You are a professional real estate home stager planning furniture for this empty ${room}.`,
    "Return this exact same photograph with ONE change: draw each piece of furniture you would place as a flat, solid, pure magenta (#FF00FF) silhouette, at realistic size and in the correct perspective, standing on the floor where it would go.",
    `Typical pieces for this room: ${hint}.`,
    "",
    "Rules:",
    "- Use only flat pure magenta (#FF00FF) for the furniture. No shading, outlines, texture, gradients or other colours.",
    "- Change nothing else in the photo. Do not alter, remove, cover or add windows, doors, openings, walls, ceilings, light fittings, power points, heaters, cabinetry or any other fixture.",
    "- Keep doorways and walkways clear. Furniture may sit below a window sill but must not cover window glass or frames.",
    "- Draw nothing on the ceiling or walls: no ceiling lights, pendant lights, wall lights, curtains, blinds or wall art.",
    "- Keep the same camera angle, framing and crop.",
  ].join("\n");
}

function buildStagingPrompt(roomType: string): string {
  const room = ROOM_LABELS[roomType] || roomType.replace(/_/g, " ");
  const style = STYLE_PROMPT_MODIFIERS[STAGING_STYLE];
  return [
    "You are given three images:",
    "IMAGE 1 — the real room photograph.",
    "IMAGE 2 — the furniture plan: the same photograph with each planned piece of furniture drawn as a flat magenta shape.",
    "IMAGE 3 — the editing mask: WHITE = where you may add furniture, BLACK = must stay exactly as in IMAGE 1.",
    "",
    `Task: virtually stage this ${room} for a real estate listing. Replace each magenta shape from IMAGE 2 with a realistic piece of furniture of the matching type, position, size and perspective, placed into IMAGE 1.`,
    style,
    "",
    "Rules:",
    "- Only add furniture (and items on it such as cushions, bedding or a vase) inside the WHITE areas of IMAGE 3.",
    "- Everything in the BLACK areas must stay identical to IMAGE 1: walls, windows, doors, openings, ceilings, light fittings, flooring and fixtures.",
    "- Do not add ceiling lights, pendant lights, wall lights, curtains, blinds or wall art.",
    "- Do not change the camera angle, crop, framing, lighting or colours.",
    "- Add natural contact shadows under the furniture.",
    "- Output the full photograph with the same framing as IMAGE 1. No magenta anywhere in the result.",
  ].filter(Boolean).join("\n");
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

async function extractMagentaMask(layoutImage: Buffer, w: number, h: number) {
  const raw = await sharp(layoutImage).removeAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    mask[i] = r >= 170 && b >= 170 && g <= 110 && r - g >= 90 && b - g >= 90 ? 1 : 0;
  }
  const rawRatio = ratioOf(mask);
  // Close small holes and gaps inside each shape, then drop specks.
  const closeR = Math.max(2, Math.round(w * 0.004));
  mask = erode(dilate(mask, w, h, closeR), w, h, closeR);
  mask = removeSmallComponents(mask, w, h, Math.round(w * h * 0.002));
  const shapeRatio = ratioOf(mask);
  // Grow for soft edges, and further downwards for floor shadows.
  mask = dilate(mask, w, h, Math.round((w * GROW_PCT) / 100));
  mask = growDown(mask, w, h, Math.round((h * SHADOW_PCT) / 100));
  return { mask, rawRatio, shapeRatio, finalRatio: ratioOf(mask) };
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
  const out = Buffer.alloc(fw * fh * 3);
  for (let i = 0; i < fw * fh; i++) {
    const a = alpha[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(stg[i * 3 + c] * a + orig[i * 3 + c] * (1 - a));
  }
  return { buffer: await sharp(out, { raw: { width: fw, height: fh, channels: 3 } }).webp({ quality: 95 }).toBuffer(), width: fw, height: fh };
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

async function runOne(img: { name: string; file: string; roomType: string }) {
  const t0 = Date.now();
  const dir = path.join(OUT, img.name);
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(img.file);
  const meta = await sharp(original).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  const aspectRatio = closestGeminiAspectRatio(w, h);
  fs.writeFileSync(path.join(dir, `1_original${path.extname(img.file)}`), original);
  const row: any = { image: img.name, roomType: img.roomType, input: `${w}x${h}`, aspectRatio };
  let layout: Buffer | null = null, overlay: Buffer | null = null, staged: Buffer | null = null, final: Buffer | null = null;

  try {
    console.log(`[${img.name}] 1/3 layout (${LAYOUT_MODEL}, ${LAYOUT_IMAGE_SIZE})`);
    const layoutRes = await callGeminiImage({
      model: LAYOUT_MODEL,
      parts: [{ text: buildLayoutPrompt(img.roomType) }, imagePart(original, mimeFor(img.file))],
      imageSize: LAYOUT_IMAGE_SIZE,
      aspectRatio,
      temperature: 0.4,
    });
    layout = layoutRes.image;
    fs.writeFileSync(path.join(dir, "2_layout_magenta.png"), layout);
    row.layoutCostUsd = approxOutputCost(layoutRes.usage);

    const { mask, rawRatio, shapeRatio, finalRatio } = await extractMagentaMask(layout, w, h);
    row.maskPct = { magentaFound: +(rawRatio * 100).toFixed(1), shapes: +(shapeRatio * 100).toFixed(1), afterGrow: +(finalRatio * 100).toFixed(1) };
    const maskPng = await maskToPng(mask, w, h);
    fs.writeFileSync(path.join(dir, "3_mask.png"), maskPng);
    overlay = await maskOverlay(original, mask, w, h);
    fs.writeFileSync(path.join(dir, "3_mask_overlay.jpg"), overlay);
    if (shapeRatio < 0.01) throw new Error(`layout step drew almost no magenta furniture (${(shapeRatio * 100).toFixed(2)}% of image) — skipping staging`);
    if (finalRatio > 0.7) console.warn(`[${img.name}] warning: mask covers ${(finalRatio * 100).toFixed(0)}% of the image — protection will be weak`);

    console.log(`[${img.name}] 2/3 staging (${STAGE_MODEL}, ${STAGE_IMAGE_SIZE})`);
    const stageRes = await callGeminiImage({
      model: STAGE_MODEL,
      parts: [
        { text: buildStagingPrompt(img.roomType) },
        { text: "IMAGE 1 — room photograph:" }, imagePart(original, mimeFor(img.file)),
        { text: "IMAGE 2 — furniture plan:" }, imagePart(layout, "image/png"),
        { text: "IMAGE 3 — editing mask:" }, imagePart(maskPng, "image/png"),
      ],
      imageSize: STAGE_IMAGE_SIZE,
      aspectRatio,
      temperature: 0.2,
    });
    staged = stageRes.image;
    fs.writeFileSync(path.join(dir, "4_gemini_staged_no_pasteback.png"), staged);
    const stagedMeta = await sharp(staged).metadata();
    row.stagedSize = `${stagedMeta.width}x${stagedMeta.height}`;
    row.stagingCostUsd = approxOutputCost(stageRes.usage);
    row.geminiChangesOutsideMask = await measureOutsideDrift(original, staged, mask, w, h);

    console.log(`[${img.name}] 3/3 paste back`);
    const pasted = await pasteBack(original, staged, maskPng, w, h);
    final = pasted.buffer;
    fs.writeFileSync(path.join(dir, "5_final_pasteback.webp"), final);
    row.finalSize = `${pasted.width}x${pasted.height}`;
    row.ok = true;
  } catch (e: any) {
    row.ok = false;
    row.error = String(e?.message || e).slice(0, 400);
  }

  const sheet = await contactSheet(
    [
      { label: "1. Original", image: original },
      { label: "2. Gemini furniture plan", image: layout },
      { label: "3. Mask (red = editable)", image: overlay },
      { label: "4. Gemini staged (no paste-back)", image: staged },
      { label: "5. Final (pasted back)", image: final },
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

export { extractMagentaMask, measureOutsideDrift, pasteBack, maskToPng, maskOverlay, contactSheet };
