// INVESTIGATION 2 (standalone, read-only w.r.t. production code, no new
// Gemini call): reuses tonight's already-generated furniture image and
// HSV-hue-weighted extraction (recomputed fresh from the raw image, not
// re-read from the saved mask PNG, to avoid the channel-count pitfall found
// earlier tonight), and compares the OLD blind fit:"fill" (stretch)
// compositing against a NEW aspect-ratio-aware (uniform scale + letterbox
// pad, center-anchored) compositing.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";

const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");
const RAW_FURNITURE_PATH = path.join(OUT_DIR, "Bedroom 12-furniture-layer-raw.png");

// ── HSV hue-weighted extraction, copied from tonight's winning benchmark
// method (test_extraction_benchmark.ts) — unchanged, so this investigation
// isolates ONLY the compositing-geometry variable, not extraction quality. ──
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : delta / max;
  return [h, s, max];
}
function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d);
}
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function stdDevOf(values: number[], mean: number): number {
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

// Ported EXACTLY (not re-derived) from test_extraction_benchmark.ts's
// estimateBackgroundStatsInSpace + hsv_hue_weighted distance/threshold logic,
// including its quirk of computing noiseFloor from RAW (unscaled) [h,s,v]
// stddevs — h in degrees (0-360), s/v as 0-1 fractions — so Math.max(...)
// is implicitly dominated by whichever channel has the largest raw numeric
// spread. This is intentionally NOT "fixed" here: the goal of Investigation 2
// is to hold extraction constant and vary ONLY the compositing geometry, so
// silently changing the extraction math would confound that comparison.
async function computeHsvAlpha(rgbRaw: Buffer, width: number, height: number): Promise<Buffer> {
  const marginX = Math.max(2, Math.round(width * 0.03));
  const marginY = Math.max(2, Math.round(height * 0.03));
  const samples: [number, number, number][] = [];
  const pushSample = (x: number, y: number) => {
    const idx = (y * width + x) * 3;
    samples.push(rgbToHsv(rgbRaw[idx], rgbRaw[idx + 1], rgbRaw[idx + 2]));
  };
  for (let x = 0; x < width; x += 4) { pushSample(x, 0); pushSample(x, marginY - 1); pushSample(x, height - marginY); pushSample(x, height - 1); }
  for (let y = 0; y < height; y += 4) { pushSample(0, y); pushSample(marginX - 1, y); pushSample(width - marginX, y); pushSample(width - 1, y); }
  const hs = samples.map((s) => s[0]), ss = samples.map((s) => s[1]), vs = samples.map((s) => s[2]);
  const bgH = medianOf(hs), bgS = medianOf(ss), bgV = medianOf(vs);
  const meanH = hs.reduce((a, b) => a + b, 0) / hs.length;
  const meanS = ss.reduce((a, b) => a + b, 0) / ss.length;
  const meanV = vs.reduce((a, b) => a + b, 0) / vs.length;
  // Raw (unscaled) stddevs, exactly as the original — this is the quirk described above.
  const noiseFloor = Math.max(stdDevOf(hs, meanH), stdDevOf(ss, meanS), stdDevOf(vs, meanV));
  const lowThreshold = Math.max(noiseFloor * 3, 8);
  const highThreshold = Math.max(lowThreshold + 15, noiseFloor * 10);

  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 3;
    const [h, s, v] = rgbToHsv(rgbRaw[idx], rgbRaw[idx + 1], rgbRaw[idx + 2]);
    const dh = (hueDistance(h, bgH) / 180) * 255;
    const ds = Math.abs(s - bgS) * 255;
    const dv = Math.abs(v - bgV) * 255;
    const d = Math.sqrt((dh * 1.0) ** 2 + (ds * 0.6) ** 2 + (dv * 0.15) ** 2);
    if (d <= lowThreshold) alpha[i] = 0;
    else if (d >= highThreshold) alpha[i] = 255;
    else alpha[i] = Math.round(((d - lowThreshold) / (highThreshold - lowThreshold)) * 255);
  }
  return alpha;
}

// ── OLD geometry: blind fit:"fill" (non-uniform stretch) — tonight's
// as-built behavior, reproduced here unchanged for a fair before/after. ──
async function compositeStretch(rgbRaw: Buffer, alpha: Buffer, srcW: number, srcH: number, outW: number, outH: number): Promise<Buffer> {
  const resizedAlpha = await sharp(alpha, { raw: { width: srcW, height: srcH, channels: 1 } })
    .toColourspace("b-w")
    .resize(outW, outH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw().toBuffer();
  const overlayRgba = await sharp(rgbRaw, { raw: { width: srcW, height: srcH, channels: 3 } })
    .resize(outW, outH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .joinChannel(resizedAlpha, { raw: { width: outW, height: outH, channels: 1 } })
    .png().toBuffer();
  return sharp(BASELINE_PATH)
    .resize(outW, outH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayRgba, blend: "over" }])
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .webp({ quality: 95 })
    .toBuffer();
}

// ── NEW geometry: aspect-ratio-aware uniform scale ("contain") + letterbox
// pad, center-anchored. Chosen over "cover"+crop deliberately (see report):
// this is a diagnostic experiment where losing part of the furniture layer
// to a crop would make the before/after comparison itself less trustworthy,
// and a transparent letterbox pad on an alpha-masked overlay is visually
// harmless (no visible bars), unlike padding an opaque image. ──
async function compositeAspectAware(rgbRaw: Buffer, alpha: Buffer, srcW: number, srcH: number, outW: number, outH: number) {
  const srcRatio = srcW / srcH;
  const outRatio = outW / outH;
  const scale = Math.min(outW / srcW, outH / srcH); // "contain"
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);
  const padLeft = Math.floor((outW - scaledW) / 2);
  const padRight = outW - scaledW - padLeft;
  const padTop = Math.floor((outH - scaledH) / 2);
  const padBottom = outH - scaledH - padTop;

  console.log("[aspect-ratio-aware] geometry", {
    srcDimensions: { width: srcW, height: srcH }, srcRatio: Number(srcRatio.toFixed(4)),
    outDimensions: { width: outW, height: outH }, outRatio: Number(outRatio.toFixed(4)),
    ratioMismatchPct: Number((Math.abs(srcRatio - outRatio) / outRatio * 100).toFixed(2)),
    uniformScale: Number(scale.toFixed(4)),
    scaledDimensions: { width: scaledW, height: scaledH },
    padding: { left: padLeft, right: padRight, top: padTop, bottom: padBottom },
  });

  const resizedAlpha = await sharp(alpha, { raw: { width: srcW, height: srcH, channels: 1 } })
    .toColourspace("b-w")
    .resize(scaledW, scaledH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .extend({ left: padLeft, right: padRight, top: padTop, bottom: padBottom, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toColourspace("b-w")
    .raw().toBuffer();
  const resizedRgb = await sharp(rgbRaw, { raw: { width: srcW, height: srcH, channels: 3 } })
    .resize(scaledW, scaledH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .extend({ left: padLeft, right: padRight, top: padTop, bottom: padBottom, background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw().toBuffer();

  const overlayRgba = await sharp(resizedRgb, { raw: { width: outW, height: outH, channels: 3 } })
    .joinChannel(resizedAlpha, { raw: { width: outW, height: outH, channels: 1 } })
    .png().toBuffer();
  const compositeBuffer = await sharp(BASELINE_PATH)
    .resize(outW, outH, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayRgba, blend: "over" }])
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .webp({ quality: 95 })
    .toBuffer();

  return { compositeBuffer, padding: { left: padLeft, right: padRight, top: padTop, bottom: padBottom } };
}

async function main() {
  const baselineMeta = await sharp(BASELINE_PATH).metadata();
  const furnitureMeta = await sharp(RAW_FURNITURE_PATH).metadata();
  const outW = baselineMeta.width!, outH = baselineMeta.height!;
  const srcW = furnitureMeta.width!, srcH = furnitureMeta.height!;

  console.log("=== aspect-ratio investigation starting ===");
  console.log(JSON.stringify({
    baseline: { width: outW, height: outH, ratio: Number((outW / outH).toFixed(4)) },
    furnitureImage: { width: srcW, height: srcH, ratio: Number((srcW / srcH).toFixed(4)) },
    ratioMismatchPct: Number((Math.abs((srcW / srcH) - (outW / outH)) / (outW / outH) * 100).toFixed(2)),
  }, null, 2));

  const rgbRaw = await sharp(RAW_FURNITURE_PATH).resize(srcW, srcH).removeAlpha().raw().toBuffer();
  const alpha = await computeHsvAlpha(rgbRaw, srcW, srcH);

  let nonZero = 0;
  for (const v of alpha) if (v > 0) nonZero += 1;
  console.log("recomputed HSV alpha coverage (should match tonight's benchmark ~54.9%):", (nonZero / alpha.length * 100).toFixed(1) + "%");

  // OLD: stretch
  const stretchBuffer = await compositeStretch(rgbRaw, alpha, srcW, srcH, outW, outH);
  const stretchPath = path.join(OUT_DIR, "Bedroom 12-aspectfix-BEFORE-stretch.webp");
  await sharp(stretchBuffer).toFile(stretchPath);

  // NEW: aspect-ratio-aware
  const { compositeBuffer: containBuffer, padding } = await compositeAspectAware(rgbRaw, alpha, srcW, srcH, outW, outH);
  const containPath = path.join(OUT_DIR, "Bedroom 12-aspectfix-AFTER-contain.webp");
  await sharp(containBuffer).toFile(containPath);

  console.log("\n=== ARTIFACTS ===");
  console.log(JSON.stringify({ before_stretch: stretchPath, after_contain: containPath, letterboxPadding: padding }, null, 2));
  console.log("\n=== DONE ===");
}

main().catch((e) => {
  console.error("investigate_aspect_ratio_fix failed:", e);
  process.exit(1);
});
