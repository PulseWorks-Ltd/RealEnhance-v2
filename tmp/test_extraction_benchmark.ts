// EXPERIMENT (feature/stage2-gemini-furniture-layer): benchmark several
// color-distance metrics for background extraction against the EXACT SAME
// already-generated Gemini furniture-only image
// ("Bedroom 12-furniture-layer-raw.png") — no new Gemini call. The prior
// RGB-Euclidean extraction failed badly (bed/nightstands/artwork almost
// entirely misclassified as background) because raw RGB distance conflates
// lightness with hue, and the furniture's light neutral tones sit close in
// RGB space to the pale desaturated green background. This benchmark tests
// whether hue-aware metrics (HSV, CIE Lab, chroma-weighted Lab) fix that.
import path from "path";
import sharp from "sharp";

const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");
const RAW_FURNITURE_PATH = path.join(OUT_DIR, "Bedroom 12-furniture-layer-raw.png");

type RGB = { r: number; g: number; b: number };

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function stdDevOf(values: number[], mean: number): number {
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

// ── Color space conversions ──

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

function srgbToLinear(c: number): number {
  const cn = c / 255;
  return cn <= 0.04045 ? cn / 12.92 : Math.pow((cn + 0.055) / 1.055, 2.4);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
  const xn = 0.95047, yn = 1.0, zn = 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / xn), fy = f(y / yn), fz = f(z / zn);
  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [L, a, bb];
}

function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d); // 0-180, circular
}

// ── Distance metrics under test ──

type DistanceFn = (r: number, g: number, b: number, bg: number[]) => number;

const METHODS: { name: string; toSpace: (r: number, g: number, b: number) => number[]; distance: DistanceFn }[] = [
  {
    name: "rgb_euclidean",
    toSpace: (r, g, b) => [r, g, b],
    distance: (r, g, b, bg) => {
      const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
      return Math.sqrt(dr * dr + dg * dg + db * db);
    },
  },
  {
    name: "hsv_hue_weighted",
    toSpace: (r, g, b) => rgbToHsv(r, g, b),
    distance: (r, g, b, bg) => {
      const [h, s, v] = rgbToHsv(r, g, b);
      const dh = (hueDistance(h, bg[0]) / 180) * 255; // normalize to ~0-255 scale
      const ds = Math.abs(s - bg[1]) * 255;
      const dv = Math.abs(v - bg[2]) * 255;
      // Hue weighted heavily, saturation moderately, value (lightness) barely —
      // directly targets the diagnosed RGB-distance failure mode.
      return Math.sqrt((dh * 1.0) ** 2 + (ds * 0.6) ** 2 + (dv * 0.15) ** 2);
    },
  },
  {
    name: "lab_cie76",
    toSpace: (r, g, b) => rgbToLab(r, g, b),
    distance: (r, g, b, bg) => {
      const [L, a, bb] = rgbToLab(r, g, b);
      const dL = L - bg[0], da = a - bg[1], db2 = bb - bg[2];
      return Math.sqrt(dL * dL + da * da + db2 * db2); // standard Delta-E (CIE76)
    },
  },
  {
    name: "lab_chroma_weighted",
    toSpace: (r, g, b) => rgbToLab(r, g, b),
    distance: (r, g, b, bg) => {
      const [L, a, bb] = rgbToLab(r, g, b);
      const dL = L - bg[0], da = a - bg[1], db2 = bb - bg[2];
      // Lightness heavily de-emphasized relative to chroma (a*/b*) — combined
      // chroma + luminance distance per the requested 4th method.
      return Math.sqrt((dL * 0.25) ** 2 + da * da + db2 * db2);
    },
  },
];

async function estimateBackgroundStatsInSpace(
  rgbRaw: Buffer, width: number, height: number,
  toSpace: (r: number, g: number, b: number) => number[]
) {
  const marginX = Math.max(2, Math.round(width * 0.03));
  const marginY = Math.max(2, Math.round(height * 0.03));
  const samples: number[][] = [];
  const pushSample = (x: number, y: number) => {
    const idx = (y * width + x) * 3;
    samples.push(toSpace(rgbRaw[idx], rgbRaw[idx + 1], rgbRaw[idx + 2]));
  };
  for (let x = 0; x < width; x += 4) {
    pushSample(x, 0); pushSample(x, marginY - 1);
    pushSample(x, height - marginY); pushSample(x, height - 1);
  }
  for (let y = 0; y < height; y += 4) {
    pushSample(0, y); pushSample(marginX - 1, y);
    pushSample(width - marginX, y); pushSample(width - 1, y);
  }
  const dims = samples[0].length;
  const medians: number[] = [];
  const stdDevs: number[] = [];
  for (let d = 0; d < dims; d += 1) {
    const values = samples.map((s) => s[d]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    medians.push(medianOf(values));
    stdDevs.push(stdDevOf(values, mean));
  }
  return { medians, stdDevs, sampleCount: samples.length };
}

function buildSoftAlpha(
  rgbRaw: Buffer, width: number, height: number,
  distance: DistanceFn, bg: number[], lowThreshold: number, highThreshold: number
): Buffer {
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 3;
    const d = distance(rgbRaw[idx], rgbRaw[idx + 1], rgbRaw[idx + 2], bg);
    if (d <= lowThreshold) alpha[i] = 0;
    else if (d >= highThreshold) alpha[i] = 255;
    else alpha[i] = Math.round(((d - lowThreshold) / (highThreshold - lowThreshold)) * 255);
  }
  return alpha;
}

async function main() {
  const rawMeta = await sharp(RAW_FURNITURE_PATH).metadata();
  const width = rawMeta.width || 0;
  const height = rawMeta.height || 0;
  const rgbRaw = await sharp(RAW_FURNITURE_PATH).resize(width, height).removeAlpha().raw().toBuffer();
  const baselineMeta = await sharp(BASELINE_PATH).metadata();
  const outWidth = baselineMeta.width || width;
  const outHeight = baselineMeta.height || height;

  console.log("=== extraction benchmark starting (reusing existing raw furniture image, no new Gemini call) ===");
  console.log(JSON.stringify({ furnitureImageDimensions: { width, height }, baselineDimensions: { width: outWidth, height: outHeight } }, null, 2));

  const results: any[] = [];

  for (const method of METHODS) {
    const bgStats = await estimateBackgroundStatsInSpace(rgbRaw, width, height, method.toSpace);
    const bg = bgStats.medians;
    const noiseFloor = Math.max(...bgStats.stdDevs);

    // Same principled threshold-derivation approach as the primary
    // experiment, applied per-method in that method's own units.
    const lowThreshold = Math.max(noiseFloor * 3, 8);
    const highThreshold = Math.max(lowThreshold + 15, noiseFloor * 10);

    const alpha = buildSoftAlpha(rgbRaw, width, height, method.distance, bg, lowThreshold, highThreshold);

    let nonZero = 0, alphaSum = 0;
    for (const v of alpha) { if (v > 0) nonZero += 1; alphaSum += v; }
    const coverage = { nonZeroRatio: nonZero / alpha.length, meanAlpha: alphaSum / alpha.length };

    // Save mask + extracted layer
    const maskPath = path.join(OUT_DIR, `Bedroom 12-benchmark-${method.name}-alpha.png`);
    await sharp(alpha, { raw: { width, height, channels: 1 } }).png().toFile(maskPath);
    const extractPath = path.join(OUT_DIR, `Bedroom 12-benchmark-${method.name}-extracted.png`);
    await sharp(rgbRaw, { raw: { width, height, channels: 3 } })
      .joinChannel(alpha, { raw: { width, height, channels: 1 } })
      .png().toFile(extractPath);

    // Composite onto baseline at baseline's native resolution.
    // IMPORTANT: resizing a raw single-channel buffer silently upconverts it
    // to 3 channels unless the pipeline is explicitly told to stay
    // single-band via toColourspace("b-w") — confirmed via isolated test.
    // Without this, the resized alpha buffer is 3x the expected length while
    // still being declared as 1-channel width*height, silently corrupting
    // the joinChannel call and producing a garbled composite.
    const resizedAlpha = await sharp(alpha, { raw: { width, height, channels: 1 } })
      .toColourspace("b-w")
      .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw().toBuffer();
    const overlayRgba = await sharp(rgbRaw, { raw: { width, height, channels: 3 } })
      .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .joinChannel(resizedAlpha, { raw: { width: outWidth, height: outHeight, channels: 1 } })
      .png().toBuffer();
    // IMPORTANT: sharp's composite() output carries an alpha channel even
    // when the base image is opaque (confirmed via isolated synthetic test —
    // without an explicit flatten, the saved file / any raw re-read can
    // misrepresent the result). Flatten explicitly so the saved composite is
    // unambiguously a fully-opaque 3-channel image.
    const compositeBuffer = await sharp(BASELINE_PATH)
      .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .composite([{ input: overlayRgba, blend: "over" }])
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .webp({ quality: 95 })
      .toBuffer();
    const compositePath = path.join(OUT_DIR, `Bedroom 12-benchmark-${method.name}-composite.webp`);
    await sharp(compositeBuffer).toFile(compositePath);

    const result = {
      method: method.name,
      backgroundMedian: bg,
      backgroundNoiseFloor: noiseFloor,
      lowThreshold, highThreshold,
      coverage,
      maskPath, extractPath, compositePath,
    };
    results.push(result);
    console.log(`\n=== ${method.name} ===`);
    console.log(JSON.stringify(result, null, 2));
  }

  console.log("\n=== SUMMARY (all methods) ===");
  console.log(JSON.stringify(results.map((r) => ({ method: r.method, coverage: r.coverage })), null, 2));
  console.log("\n=== DONE ===");
}

main().catch((e) => {
  console.error("test_extraction_benchmark failed:", e);
  process.exit(1);
});
