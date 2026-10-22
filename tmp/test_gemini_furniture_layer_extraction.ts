// EXPERIMENT (feature/stage2-gemini-furniture-layer): Gemini generates a
// furniture-only image against a uniform artificial background; deterministic
// local image processing (NOT Gemini) extracts a foreground alpha via
// distance-from-background-color, preserving soft shadow gradients; the
// extracted layer is composited onto the untouched Bedroom 12 baseline.
// No production code touched, no Vertex/EdenSign, no validators, no new
// provider — standalone tmp/ harness only, per the experiment directive.
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { runWithSelectedImageModel } from "../worker/src/ai/runWithImageModelFallback";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");
const FULL_STAGED_PATH = path.join(OUT_DIR, "Bedroom 12-2.webp");

// ── Part 1: furniture-only generation prompt ──
function buildFurnitureOnlyPrompt(): string {
  return [
    "You are given a single photograph of an empty bedroom.",
    "",
    "Task: generate an image containing ONLY new furniture and staging decor for this room,",
    "appropriate for a standard real estate listing staging style, against a solid artificial",
    "background.",
    "",
    "Include: bed, nightstands, lamps, rugs, plants, artwork, mirrors, decorative accessories,",
    "and any other furniture/decor appropriate for staging this bedroom.",
    "Include natural contact shadows, cast shadows, and soft grounding shadows that these",
    "objects would realistically cast — these shadows are wanted and important, keep them.",
    "",
    "Do NOT include: walls, ceiling, floor, flooring texture, windows, doors, doorways,",
    "cabinetry, built-ins, architectural elements, room corners, skirting boards, fixtures, or",
    "any other existing property feature. Do not recreate the room.",
    "",
    "Background: fill the ENTIRE background with ONE single, perfectly flat, solid, uniform",
    "bright green color, exactly RGB(0,255,0), like a photography green screen. No gradient, no",
    "shading, no vignette, no texture, no variation anywhere in the background — every",
    "background pixel must be the same flat green.",
    "",
    "Position, scale, and light the furniture as if it were being placed into the room shown in",
    "the reference photo (use the reference photo only to judge scale, perspective, and lighting",
    "direction — do not reproduce any of its content).",
    "",
    "Do not output a mask. Do not output JSON. Do not segment anything. Do not output",
    "transparency. Output a single normal image: furniture/decor + shadows in the foreground,",
    "flat green screen in the background.",
  ].join("\n");
}

function findFirstInlineImagePart(parts: any[]): { mimeType: string; data: string } | null {
  for (const part of parts || []) {
    const inlineData = part?.inlineData;
    if (!inlineData?.data) continue;
    const mimeType = String(inlineData.mimeType || "image/png").toLowerCase();
    if (!mimeType.startsWith("image/")) continue;
    return { mimeType, data: String(inlineData.data) };
  }
  return null;
}

// ── Part 4: robust background color estimation ──
type RGB = { r: number; g: number; b: number };

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stdDevOf(values: number[], mean: number): number {
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

async function estimateBackgroundStats(rgbRaw: Buffer, width: number, height: number) {
  // Sample a border strip (3% margin) around the whole frame, biased toward
  // the four corners, since furniture is expected (and instructed) to sit
  // roughly centered and not touch the edges.
  const marginX = Math.max(2, Math.round(width * 0.03));
  const marginY = Math.max(2, Math.round(height * 0.03));
  const samples: RGB[] = [];
  const pushSample = (x: number, y: number) => {
    const idx = (y * width + x) * 3;
    samples.push({ r: rgbRaw[idx], g: rgbRaw[idx + 1], b: rgbRaw[idx + 2] });
  };
  for (let x = 0; x < width; x += 4) {
    pushSample(x, 0);
    pushSample(x, marginY - 1);
    pushSample(x, height - marginY);
    pushSample(x, height - 1);
  }
  for (let y = 0; y < height; y += 4) {
    pushSample(0, y);
    pushSample(marginX - 1, y);
    pushSample(width - marginX, y);
    pushSample(width - 1, y);
  }

  const rs = samples.map((s) => s.r);
  const gs = samples.map((s) => s.g);
  const bs = samples.map((s) => s.b);
  const meanR = rs.reduce((a, b) => a + b, 0) / rs.length;
  const meanG = gs.reduce((a, b) => a + b, 0) / gs.length;
  const meanB = bs.reduce((a, b) => a + b, 0) / bs.length;

  return {
    sampleCount: samples.length,
    mean: { r: meanR, g: meanG, b: meanB },
    median: { r: medianOf(rs), g: medianOf(gs), b: medianOf(bs) },
    stdDev: { r: stdDevOf(rs, meanR), g: stdDevOf(gs, meanG), b: stdDevOf(bs, meanB) },
    min: { r: Math.min(...rs), g: Math.min(...gs), b: Math.min(...bs) },
    max: { r: Math.max(...rs), g: Math.max(...gs), b: Math.max(...bs) },
  };
}

function colorDistance(r: number, g: number, b: number, bg: RGB): number {
  const dr = r - bg.r, dg = g - bg.g, db = b - bg.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ── Part 3/5: distance-based alpha extraction (hard + soft) ──
function buildAlphaFromDistance(
  rgbRaw: Buffer,
  width: number,
  height: number,
  bg: RGB,
  mode: "hard" | "soft",
  lowThreshold: number,
  highThreshold: number
): Buffer {
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 3;
    const d = colorDistance(rgbRaw[idx], rgbRaw[idx + 1], rgbRaw[idx + 2], bg);
    if (mode === "hard") {
      alpha[i] = d > lowThreshold ? 255 : 0;
    } else {
      if (d <= lowThreshold) alpha[i] = 0;
      else if (d >= highThreshold) alpha[i] = 255;
      else alpha[i] = Math.round(((d - lowThreshold) / (highThreshold - lowThreshold)) * 255);
    }
  }
  return alpha;
}

function edgeTouchCheck(rgbRaw: Buffer, width: number, height: number, bg: RGB, threshold: number) {
  let topTouch = 0, bottomTouch = 0, leftTouch = 0, rightTouch = 0;
  for (let x = 0; x < width; x += 1) {
    const topIdx = x * 3;
    const bottomIdx = ((height - 1) * width + x) * 3;
    if (colorDistance(rgbRaw[topIdx], rgbRaw[topIdx + 1], rgbRaw[topIdx + 2], bg) > threshold) topTouch += 1;
    if (colorDistance(rgbRaw[bottomIdx], rgbRaw[bottomIdx + 1], rgbRaw[bottomIdx + 2], bg) > threshold) bottomTouch += 1;
  }
  for (let y = 0; y < height; y += 1) {
    const leftIdx = (y * width) * 3;
    const rightIdx = (y * width + width - 1) * 3;
    if (colorDistance(rgbRaw[leftIdx], rgbRaw[leftIdx + 1], rgbRaw[leftIdx + 2], bg) > threshold) leftTouch += 1;
    if (colorDistance(rgbRaw[rightIdx], rgbRaw[rightIdx + 1], rgbRaw[rightIdx + 2], bg) > threshold) rightTouch += 1;
  }
  return {
    topTouchPixels: topTouch, bottomTouchPixels: bottomTouch,
    leftTouchPixels: leftTouch, rightTouchPixels: rightTouch,
    touchesAnyEdge: (topTouch + bottomTouch + leftTouch + rightTouch) > 0,
  };
}

// Composites at the BASELINE's native resolution — the foreground layer
// (generated at whatever resolution Gemini returned) is upsampled to match,
// not the other way around, so the final image retains the original
// property photo's actual fidelity rather than being shrunk to Gemini's
// output size.
async function compositeOnto(
  basePath: string,
  foregroundRgb: Buffer,
  alpha: Buffer,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number
): Promise<Buffer> {
  const overlayRgba = await sharp(foregroundRgb, { raw: { width: srcWidth, height: srcHeight, channels: 3 } })
    .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .joinChannel(
      await sharp(alpha, { raw: { width: srcWidth, height: srcHeight, channels: 1 } })
        .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .raw()
        .toBuffer(),
      { raw: { width: outWidth, height: outHeight, channels: 1 } }
    )
    .png()
    .toBuffer();
  return sharp(basePath)
    .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayRgba, blend: "over" }])
    .png()
    .toBuffer();
}

async function resizeAlphaTo(alpha: Buffer, srcWidth: number, srcHeight: number, outWidth: number, outHeight: number): Promise<Buffer> {
  return sharp(alpha, { raw: { width: srcWidth, height: srcHeight, channels: 1 } })
    .resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
}

async function computeOutsideMaskDiff(basePath: string, compositeBuffer: Buffer, alphaAtOutRes: Buffer, width: number, height: number) {
  const [baseRaw, compRaw] = await Promise.all([
    sharp(basePath).resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).removeAlpha().raw().toBuffer(),
    sharp(compositeBuffer).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer(),
  ]);
  let outsidePixelCount = 0, changedPixelCount = 0, deltaSum = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (alphaAtOutRes[i] > 0) continue; // only check strictly-outside-mask pixels (alpha==0)
    outsidePixelCount += 1;
    const idx = i * 3;
    const dr = Math.abs(baseRaw[idx] - compRaw[idx]);
    const dg = Math.abs(baseRaw[idx + 1] - compRaw[idx + 1]);
    const db = Math.abs(baseRaw[idx + 2] - compRaw[idx + 2]);
    const meanDelta = (dr + dg + db) / 3;
    deltaSum += meanDelta;
    if (Math.max(dr, dg, db) >= 4) changedPixelCount += 1; // small tolerance for resize/encode rounding
  }
  return {
    outsidePixelCount,
    changedPixelCount,
    changedPixelRatio: outsidePixelCount > 0 ? changedPixelCount / outsidePixelCount : 0,
    meanAbsoluteDelta: outsidePixelCount > 0 ? deltaSum / outsidePixelCount : 0,
  };
}

async function main() {
  const baselineMeta = await sharp(BASELINE_PATH).metadata();
  console.log("=== furniture layer extraction experiment starting ===", {
    baselineDimensions: { width: baselineMeta.width, height: baselineMeta.height },
  });

  // ── PART 1: Gemini furniture-only generation ──
  const baselineImage = toBase64(BASELINE_PATH);
  const prompt = buildFurnitureOnlyPrompt();
  const ai = getGeminiClient();
  const genStartedAt = Date.now();
  const run = await runWithSelectedImageModel({
    stageLabel: "2",
    ai,
    model: MODEL,
    baseRequest: {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: baselineImage.mime, data: baselineImage.data } },
          ],
        },
      ],
      generationConfig: { temperature: 0.4, topP: 0.9, candidateCount: 1 },
    } as any,
    context: "furniture_layer_experiment_generation",
    meta: {
      jobId: "furniture_layer_experiment",
      imageId: "furniture_layer_experiment",
      stage: "2",
      reason: "furniture_layer_experiment_generation",
      callType: "image_generation",
    },
  });
  const generationDurationMs = Date.now() - genStartedAt;

  const parts: any[] = run.resp?.candidates?.[0]?.content?.parts || [];
  const imagePart = findFirstInlineImagePart(parts);
  if (!imagePart) {
    console.error("PART 1 FAILED: no image returned", { generationDurationMs });
    process.exit(1);
  }
  const rawBuffer = Buffer.from(imagePart.data, "base64");
  const rawMeta = await sharp(rawBuffer).metadata();
  const rawPngPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-raw.png");
  await sharp(rawBuffer).png().toFile(rawPngPath);

  console.log("\n=== PART 1/2: RAW GENERATION RESULT ===");
  console.log(JSON.stringify({
    modelUsed: run.modelUsed,
    generationDurationMs,
    rawPngPath,
    outputDimensions: { width: rawMeta.width, height: rawMeta.height, format: rawMeta.format },
  }, null, 2));

  // Work at the raw generated image's own resolution for extraction (avoids
  // resampling artifacts along the green/foreground edge before we've even
  // computed alpha), then resize the FINAL composite to baseline dimensions.
  const width = rawMeta.width || 0;
  const height = rawMeta.height || 0;
  const rgbRaw = await sharp(rawBuffer).resize(width, height).removeAlpha().raw().toBuffer();

  // ── PART 4: background estimation ──
  const bgStats = await estimateBackgroundStats(rgbRaw, width, height);
  const requestedBg: RGB = { r: 0, g: 255, b: 0 };
  const bgDeltaFromRequested = colorDistance(bgStats.median.r, bgStats.median.g, bgStats.median.b, requestedBg);

  console.log("\n=== PART 4: BACKGROUND ESTIMATION ===");
  console.log(JSON.stringify({ ...bgStats, requestedBg, deltaFromRequested: bgDeltaFromRequested }, null, 2));

  const bg = bgStats.median; // robust estimate, used for all extraction below
  const noiseFloor = Math.max(bgStats.stdDev.r, bgStats.stdDev.g, bgStats.stdDev.b);

  // ── PART 2 (edge-touch check) ──
  const edgeCheck = edgeTouchCheck(rgbRaw, width, height, bg, Math.max(20, noiseFloor * 4));
  console.log("\n=== PART 2: EDGE-TOUCH CHECK ===");
  console.log(JSON.stringify(edgeCheck, null, 2));

  // ── PART 3/5: hard-key and soft-alpha extraction ──
  // Thresholds derived from measured background noise floor, not assumed —
  // low threshold a few std-devs above the floor (background self-variation
  // shouldn't trip it), high threshold well into "clearly different" territory.
  const lowThreshold = Math.max(12, Math.round(noiseFloor * 4));
  const highThreshold = Math.max(lowThreshold + 20, Math.round(noiseFloor * 12));
  const hardThreshold = Math.round((lowThreshold + highThreshold) / 2);

  const hardAlpha = buildAlphaFromDistance(rgbRaw, width, height, bg, "hard", hardThreshold, hardThreshold);
  const softAlpha = buildAlphaFromDistance(rgbRaw, width, height, bg, "soft", lowThreshold, highThreshold);

  const alphaCoverage = (alpha: Buffer) => {
    let nonZero = 0, sum = 0;
    for (const v of alpha) { if (v > 0) nonZero += 1; sum += v; }
    return { nonZeroRatio: nonZero / alpha.length, meanAlpha: sum / alpha.length };
  };

  console.log("\n=== PART 3/5: EXTRACTION THRESHOLDS + COVERAGE ===");
  console.log(JSON.stringify({
    measuredNoiseFloor: noiseFloor,
    lowThreshold, highThreshold, hardThreshold,
    hardKeyCoverage: alphaCoverage(hardAlpha),
    softAlphaCoverage: alphaCoverage(softAlpha),
  }, null, 2));

  // Save alpha visualizations
  const hardAlphaPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-alpha-hard.png");
  const softAlphaPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-alpha-soft.png");
  await sharp(hardAlpha, { raw: { width, height, channels: 1 } }).png().toFile(hardAlphaPath);
  await sharp(softAlpha, { raw: { width, height, channels: 1 } }).png().toFile(softAlphaPath);

  // Extracted-layer previews (foreground on transparent, for direct inspection)
  const hardExtractPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-extracted-hard.png");
  const softExtractPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-extracted-soft.png");
  await sharp(rgbRaw, { raw: { width, height, channels: 3 } })
    .joinChannel(hardAlpha, { raw: { width, height, channels: 1 } })
    .png().toFile(hardExtractPath);
  await sharp(rgbRaw, { raw: { width, height, channels: 3 } })
    .joinChannel(softAlpha, { raw: { width, height, channels: 1 } })
    .png().toFile(softExtractPath);

  // Alpha overlay on furniture-only image (red where alpha=0 removed, for inspection)
  const overlayRaw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const idx = i * 3;
    if (softAlpha[i] === 0) {
      overlayRaw[idx] = 255; overlayRaw[idx + 1] = 0; overlayRaw[idx + 2] = 0;
    } else {
      overlayRaw[idx] = rgbRaw[idx]; overlayRaw[idx + 1] = rgbRaw[idx + 1]; overlayRaw[idx + 2] = rgbRaw[idx + 2];
    }
  }
  const alphaOverlayPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-alpha-overlay.png");
  await sharp(overlayRaw, { raw: { width, height, channels: 3 } }).png().toFile(alphaOverlayPath);

  // ── PART 6: composite onto baseline (Stage 1A/1B stand-in) — at the
  // BASELINE's native resolution, not Gemini's output resolution.
  const outWidth = baselineMeta.width || width;
  const outHeight = baselineMeta.height || height;
  const hardComposite = await compositeOnto(BASELINE_PATH, rgbRaw, hardAlpha, width, height, outWidth, outHeight);
  const softComposite = await compositeOnto(BASELINE_PATH, rgbRaw, softAlpha, width, height, outWidth, outHeight);
  const hardCompositePath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-composite-hard.webp");
  const softCompositePath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-composite-soft.webp");
  await sharp(hardComposite).webp({ quality: 95 }).toFile(hardCompositePath);
  await sharp(softComposite).webp({ quality: 95 }).toFile(softCompositePath);

  // ── PART 8: structural preservation check (outside-mask diff vs baseline) ──
  const hardAlphaAtOutRes = await resizeAlphaTo(hardAlpha, width, height, outWidth, outHeight);
  const softAlphaAtOutRes = await resizeAlphaTo(softAlpha, width, height, outWidth, outHeight);
  const hardDiff = await computeOutsideMaskDiff(BASELINE_PATH, hardComposite, hardAlphaAtOutRes, outWidth, outHeight);
  const softDiff = await computeOutsideMaskDiff(BASELINE_PATH, softComposite, softAlphaAtOutRes, outWidth, outHeight);

  console.log("\n=== PART 8: STRUCTURAL PRESERVATION (outside-mask diff vs baseline) ===");
  console.log(JSON.stringify({ hardKey: hardDiff, softAlpha: softDiff, outputDimensions: { outWidth, outHeight } }, null, 2));

  // Difference visualization (soft composite vs baseline), at output resolution
  const [baseRawForDiff, compRawForDiff] = await Promise.all([
    sharp(BASELINE_PATH).resize(outWidth, outHeight, { fit: "fill", kernel: sharp.kernel.lanczos3 }).removeAlpha().raw().toBuffer(),
    sharp(softComposite).resize(outWidth, outHeight, { fit: "fill" }).removeAlpha().raw().toBuffer(),
  ]);
  const diffRaw = Buffer.alloc(outWidth * outHeight * 3);
  for (let i = 0; i < outWidth * outHeight * 3; i += 1) {
    diffRaw[i] = Math.min(255, Math.abs(baseRawForDiff[i] - compRawForDiff[i]) * 3);
  }
  const diffVizPath = path.join(OUT_DIR, "Bedroom 12-furniture-layer-diff-vs-baseline.png");
  await sharp(diffRaw, { raw: { width: outWidth, height: outHeight, channels: 3 } }).png().toFile(diffVizPath);

  console.log("\n=== ALL ARTIFACTS ===");
  console.log(JSON.stringify({
    baseline: BASELINE_PATH,
    fullStagedComparison: FULL_STAGED_PATH,
    rawFurnitureOutput: rawPngPath,
    hardAlphaMask: hardAlphaPath,
    softAlphaMask: softAlphaPath,
    hardExtractedLayer: hardExtractPath,
    softExtractedLayer: softExtractPath,
    alphaOverlay: alphaOverlayPath,
    hardComposite: hardCompositePath,
    softComposite: softCompositePath,
    diffVisualization: diffVizPath,
  }, null, 2));

  console.log("\n=== DONE ===");
}

main().catch((e) => {
  console.error("test_gemini_furniture_layer_extraction failed:", e);
  process.exit(1);
});
