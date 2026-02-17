import sharp from "sharp";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { computeEdgeMapFromGray } from "../validators/edgeUtils";

type CropRect = { left: number; top: number; width: number; height: number };

function parseByteThreshold(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(255, Math.round(parsed)));
}

function getStage0CropThresholds(): { opencvBlackThreshold: number; trimThreshold: number } {
  const shared = parseByteThreshold(process.env.PREPROCESS_CROP_BLACK_THRESHOLD, 10);
  const opencvBlackThreshold = parseByteThreshold(
    process.env.PREPROCESS_CROP_OPENCV_THRESHOLD,
    shared
  );
  const trimThreshold = parseByteThreshold(
    process.env.PREPROCESS_CROP_TRIM_THRESHOLD,
    shared
  );
  return { opencvBlackThreshold, trimThreshold };
}

function logCropStats(method: "alpha" | "opencv" | "trim" | "edge", beforeW: number, beforeH: number, rect: CropRect): void {
  const beforeArea = beforeW * beforeH;
  const afterArea = rect.width * rect.height;
  const removedPct = beforeArea > 0 ? ((beforeArea - afterArea) / beforeArea) * 100 : 0;

  console.log(
    `[preprocess] auto-crop(${method}) rect left=${rect.left} top=${rect.top} width=${rect.width} height=${rect.height} removed=${removedPct.toFixed(2)}%`
  );
  if (removedPct > 15) {
    console.warn(
      `[preprocess] auto-crop warning: removed ${removedPct.toFixed(2)}% area (>15%)`
    );
  }
}

async function detectCropRectFromEdgeBands(
  img: sharp.Sharp,
  darkThreshold: number,
): Promise<CropRect | null> {
  const raw = await img
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = raw.info.width || 0;
  const height = raw.info.height || 0;
  const channels = raw.info.channels || 0;
  if (!width || !height || channels < 4) return null;

  const data = raw.data;

  const maxTrimRatio = Number(process.env.PREPROCESS_CROP_EDGE_MAX_TRIM_RATIO ?? 0.12);
  const lineDarkRatio = Number(process.env.PREPROCESS_CROP_EDGE_LINE_DARK_RATIO ?? 0.92);
  const alphaDarkThreshold = parseByteThreshold(process.env.PREPROCESS_CROP_EDGE_ALPHA_THRESHOLD, 8);

  const maxTrimX = Math.max(1, Math.floor(width * Math.max(0.01, Math.min(0.2, maxTrimRatio))));
  const maxTrimY = Math.max(1, Math.floor(height * Math.max(0.01, Math.min(0.2, maxTrimRatio))));

  const isDarkAt = (x: number, y: number): boolean => {
    const i = (y * width + x) * channels;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a <= alphaDarkThreshold) return true;
    return r <= darkThreshold && g <= darkThreshold && b <= darkThreshold;
  };

  const darkRatioForCol = (x: number): number => {
    let dark = 0;
    for (let y = 0; y < height; y++) {
      if (isDarkAt(x, y)) dark++;
    }
    return dark / Math.max(1, height);
  };

  const darkRatioForRow = (y: number): number => {
    let dark = 0;
    for (let x = 0; x < width; x++) {
      if (isDarkAt(x, y)) dark++;
    }
    return dark / Math.max(1, width);
  };

  let leftTrim = 0;
  while (leftTrim < maxTrimX) {
    if (darkRatioForCol(leftTrim) < lineDarkRatio) break;
    leftTrim++;
  }

  let rightTrim = 0;
  while (rightTrim < maxTrimX) {
    const x = width - 1 - rightTrim;
    if (x < 0 || darkRatioForCol(x) < lineDarkRatio) break;
    rightTrim++;
  }

  let topTrim = 0;
  while (topTrim < maxTrimY) {
    if (darkRatioForRow(topTrim) < lineDarkRatio) break;
    topTrim++;
  }

  let bottomTrim = 0;
  while (bottomTrim < maxTrimY) {
    const y = height - 1 - bottomTrim;
    if (y < 0 || darkRatioForRow(y) < lineDarkRatio) break;
    bottomTrim++;
  }

  if (leftTrim + rightTrim >= width - 2 || topTrim + bottomTrim >= height - 2) {
    return null;
  }

  if (!leftTrim && !rightTrim && !topTrim && !bottomTrim) {
    return null;
  }

  return {
    left: leftTrim,
    top: topTrim,
    width: width - leftTrim - rightTrim,
    height: height - topTrim - bottomTrim,
  };
}

async function detectCropRectWithOpenCv(
  tempImagePath: string,
  blackThreshold: number
): Promise<CropRect | null> {
  let src: any = null;
  let gray: any = null;
  let mask: any = null;
  let contours: any = null;
  let hierarchy: any = null;

  try {
    const mod: any = await import("opencv-ts");
    const cv: any = mod?.default ?? mod;

    if (!cv || typeof cv.imread !== "function" || typeof cv.findContours !== "function") {
      return null;
    }

    src = cv.imread(tempImagePath);
    if (!src || !src.cols || !src.rows) return null;

    gray = new cv.Mat();
    const toGrayCode = cv.COLOR_RGBA2GRAY ?? cv.COLOR_BGRA2GRAY ?? cv.COLOR_BGR2GRAY;
    cv.cvtColor(src, gray, toGrayCode);

    mask = new cv.Mat();
    cv.threshold(gray, mask, blackThreshold, 255, cv.THRESH_BINARY);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestArea = 0;
    let bestRect: any = null;

    const count = typeof contours.size === "function" ? contours.size() : 0;
    for (let i = 0; i < count; i++) {
      const contour = contours.get(i);
      const area = Number(cv.contourArea(contour, false) || 0);
      if (area > bestArea) {
        bestArea = area;
        bestRect = cv.boundingRect(contour);
      }
      if (contour && typeof contour.delete === "function") contour.delete();
    }

    if (!bestRect) return null;

    const left = Math.max(0, Math.floor(bestRect.x || 0));
    const top = Math.max(0, Math.floor(bestRect.y || 0));
    const width = Math.max(1, Math.floor(bestRect.width || 0));
    const height = Math.max(1, Math.floor(bestRect.height || 0));

    return { left, top, width, height };
  } catch {
    return null;
  } finally {
    for (const mat of [src, gray, mask, contours, hierarchy]) {
      if (mat && typeof mat.delete === "function") {
        try { mat.delete(); } catch {}
      }
    }
  }
}

async function detectCropRectFromAlpha(
  img: sharp.Sharp,
  minAlpha: number
): Promise<CropRect | null> {
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(minAlpha)));
  const rgba = await img
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = rgba.info.width || 0;
  const height = rgba.info.height || 0;
  const channels = rgba.info.channels || 0;
  if (!width || !height || channels < 4) return null;

  const data = rgba.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + 3];
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

async function autoCropPostStraighten(img: sharp.Sharp): Promise<sharp.Sharp> {
  const meta = await img.metadata();
  const beforeW = meta.width || 0;
  const beforeH = meta.height || 0;
  if (!beforeW || !beforeH) return img;

  const thresholds = getStage0CropThresholds();
  console.log(
    `[stage0] CROP thresholds opencv=${thresholds.opencvBlackThreshold} trim=${thresholds.trimThreshold}`
  );

  // First pass: exact alpha crop (handles transparent wedges created by rotation).
  try {
    const alphaThreshold = parseByteThreshold(process.env.PREPROCESS_CROP_ALPHA_THRESHOLD, 1);
    const rect = await detectCropRectFromAlpha(img, alphaThreshold);
    if (
      rect &&
      rect.width > 1 &&
      rect.height > 1 &&
      (rect.left > 0 || rect.top > 0 || rect.width < beforeW || rect.height < beforeH)
    ) {
      const clamped: CropRect = {
        left: Math.max(0, Math.min(beforeW - 1, rect.left)),
        top: Math.max(0, Math.min(beforeH - 1, rect.top)),
        width: Math.max(1, Math.min(beforeW - rect.left, rect.width)),
        height: Math.max(1, Math.min(beforeH - rect.top, rect.height)),
      };
      console.log(`[stage0] CROP rect=${clamped.left},${clamped.top},${clamped.width},${clamped.height} method=alpha`);
      console.log(`[stage0] POST-CROP size=${clamped.width}x${clamped.height}`);
      logCropStats("alpha", beforeW, beforeH, clamped);
      return img.extract(clamped);
    }
  } catch {
    // Fail-open to OpenCV + trim fallback paths.
  }

  // Primary method: OpenCV contour crop on non-black region
  const tempPath = `/tmp/preprocess-straighten-${randomUUID()}.png`;
  try {
    const pngBuf = await img.clone().png().toBuffer();
    await fs.writeFile(tempPath, pngBuf);
    const rect = await detectCropRectWithOpenCv(tempPath, thresholds.opencvBlackThreshold);

    if (
      rect &&
      rect.width > 1 &&
      rect.height > 1 &&
      (rect.left > 0 || rect.top > 0 || rect.width < beforeW || rect.height < beforeH)
    ) {
      const clamped: CropRect = {
        left: Math.max(0, Math.min(beforeW - 1, rect.left)),
        top: Math.max(0, Math.min(beforeH - 1, rect.top)),
        width: Math.max(1, Math.min(beforeW - rect.left, rect.width)),
        height: Math.max(1, Math.min(beforeH - rect.top, rect.height)),
      };
      console.log(`[stage0] CROP rect=${clamped.left},${clamped.top},${clamped.width},${clamped.height} method=opencv`);
      console.log(`[stage0] POST-CROP size=${clamped.width}x${clamped.height}`);
      logCropStats("opencv", beforeW, beforeH, clamped);
      return img.extract(clamped);
    }
  } catch {
    // Fail-open to fallback below
  } finally {
    try { await fs.unlink(tempPath); } catch {}
  }

  // Fallback: sharp trim
  try {
    const trimmed = await img
      .clone()
      .trim({ threshold: thresholds.trimThreshold })
      .toBuffer({ resolveWithObject: true });

    const afterW = trimmed.info.width || beforeW;
    const afterH = trimmed.info.height || beforeH;

    if (afterW > 0 && afterH > 0 && (afterW < beforeW || afterH < beforeH)) {
      console.log(`[stage0] CROP rect=0,0,${afterW},${afterH} method=trim`);
      console.log(`[stage0] POST-CROP size=${afterW}x${afterH}`);
      logCropStats("trim", beforeW, beforeH, {
        left: 0,
        top: 0,
        width: afterW,
        height: afterH,
      });
      return sharp(trimmed.data);
    }
  } catch {
    // fail-open: keep image unchanged
  }

  // Final fallback: conservative edge-band crop for near-black/transparent wedges.
  // This catches occasional rotation triangles that bypass contour + trim heuristics.
  try {
    const edgeThreshold = parseByteThreshold(process.env.PREPROCESS_CROP_EDGE_THRESHOLD, thresholds.trimThreshold);
    const rect = await detectCropRectFromEdgeBands(img, edgeThreshold);
    if (
      rect &&
      rect.width > 1 &&
      rect.height > 1 &&
      (rect.left > 0 || rect.top > 0 || rect.width < beforeW || rect.height < beforeH)
    ) {
      const clamped: CropRect = {
        left: Math.max(0, Math.min(beforeW - 1, rect.left)),
        top: Math.max(0, Math.min(beforeH - 1, rect.top)),
        width: Math.max(1, Math.min(beforeW - rect.left, rect.width)),
        height: Math.max(1, Math.min(beforeH - rect.top, rect.height)),
      };
      console.log(`[stage0] CROP rect=${clamped.left},${clamped.top},${clamped.width},${clamped.height} method=edge`);
      console.log(`[stage0] POST-CROP size=${clamped.width}x${clamped.height}`);
      logCropStats("edge", beforeW, beforeH, clamped);
      return img.extract(clamped);
    }
  } catch {
    // fail-open
  }

  console.log(`[stage0] CROP rect=none method=none`);
  console.log(`[stage0] POST-CROP size=${beforeW}x${beforeH}`);

  return img;
}

function normalizeAngleDeg(angle: number): number {
  let out = angle;
  while (out > 90) out -= 180;
  while (out < -90) out += 180;
  return out;
}

function estimateRollFromEdges(gray: Uint8Array, width: number, height: number): number {
  if (width < 8 || height < 8) return 0;

  let weightedSum = 0;
  let weightTotal = 0;
  const edgeThreshold = 36;
  const maxVerticalDeviation = 25;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;

      const gx = (
        gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1] -
        gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1]
      );
      const gy = (
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1] -
        gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1]
      );

      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag < edgeThreshold) continue;

      const gradAngle = Math.atan2(gy, gx) * (180 / Math.PI);
      const lineAngle = normalizeAngleDeg(gradAngle + 90);
      const fromVertical = normalizeAngleDeg(lineAngle - 90);
      const absFromVertical = Math.abs(fromVertical);
      if (absFromVertical > maxVerticalDeviation) continue;

      const weight = mag * (1 - absFromVertical / maxVerticalDeviation);
      weightedSum += fromVertical * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal <= 1e-6) return 0;
  return weightedSum / weightTotal;
}

/**
 * Preprocesses an image to create the canonical base image for a job.
 * - Straightens/rotates/perspective-corrects (deterministic)
 * - For interiors, normalizes brightness/saturation if too dark
 * - Returns path to canonical image
 */
export async function preprocessToCanonical(
  inputPath: string,
  outputPath: string,
  sceneType: string,
  options: { buildArtifacts?: boolean; smallSize?: number } = {}
): Promise<BaseArtifacts | undefined> {
  let img = sharp(inputPath);
  const inputMeta = await img.metadata();
  console.log(`[stage0] ROTATE size=before ${inputMeta.width || 0}x${inputMeta.height || 0}`);
  // Auto-orient (EXIF)
  img = img.rotate();
  const rotatedMeta = await img.metadata();
  console.log(`[stage0] ROTATE size=after ${rotatedMeta.width || 0}x${rotatedMeta.height || 0}`);

  // Deterministic pre-Stage1A geometric straightening (global roll only)
  // Keeps correction conservative to avoid over-cropping and structural drift.
  const straightenEnabled = process.env.PREPROCESS_GEOMETRIC_STRAIGHTEN !== "0";
  const maxCorrectionDeg = Number(process.env.PREPROCESS_STRAIGHTEN_MAX_DEG ?? 2.0);
  const minApplyDeg = Number(process.env.PREPROCESS_STRAIGHTEN_MIN_APPLY_DEG ?? 0.35);
  if (straightenEnabled) {
    try {
      const orientedMeta = await img.metadata();
      const targetW = orientedMeta.width;
      const targetH = orientedMeta.height;
      if (targetW && targetH) {
        const analysis = await img
          .clone()
          .greyscale()
          .resize(768, 768, { fit: "inside" })
          .raw()
          .toBuffer({ resolveWithObject: true });
        const gray = new Uint8Array(analysis.data.buffer, analysis.data.byteOffset, analysis.data.byteLength);
        const estimatedRoll = estimateRollFromEdges(gray, analysis.info.width, analysis.info.height);
        const clampedRoll = Math.max(-maxCorrectionDeg, Math.min(maxCorrectionDeg, estimatedRoll));

        if (Math.abs(clampedRoll) >= minApplyDeg) {
          // Rotate opposite of measured drift with transparent fill.
          // Post-rotation crop removes wedges without inventing content beyond source pixels.
          img = img
            .ensureAlpha()
            .rotate(-clampedRoll, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        }
      }
    } catch {
      // Fail-open: if straightening analysis fails, keep canonical preprocessing running.
    }
  }

  // Stage 0 post-straighten border crop to remove black wedges introduced by rotation.
  // Applied to image preprocessing only, before Stage 1A/1B/2.
  img = await autoCropPostStraighten(img);
  img = img.removeAlpha();

  // For interiors, normalize brightness/saturation if too dark
  if (sceneType === "interior") {
    const stats = await img.stats();
    const meanLum = stats.channels[0].mean / 255;
    if (meanLum < 0.35) {
      img = img.modulate({ brightness: 1.12, saturation: 1.05 });
    }
  }
  const buildArtifacts = options.buildArtifacts === true;
  const smallSize = Number.isFinite(options.smallSize) ? Number(options.smallSize) : 512;

  let artifactsPromise: Promise<BaseArtifacts> | undefined;
  if (buildArtifacts) {
    const base = img.clone();
    const metaPromise = base.metadata();
    const grayPromise = base.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
    const smallPromise = base.clone().greyscale().resize(smallSize, smallSize, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    const rgbPromise = base.clone().ensureAlpha().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });

    artifactsPromise = Promise.all([metaPromise, grayPromise, smallPromise, rgbPromise]).then(
      ([meta, gray, small, rgb]) => {
        if (!meta.width || !meta.height) {
          throw new Error("Failed to read canonical dimensions for BaseArtifacts");
        }
        const grayData = new Uint8Array(gray.data.buffer, gray.data.byteOffset, gray.data.byteLength);
        const edge = computeEdgeMapFromGray(grayData, gray.info.width, gray.info.height, 38);
        return {
          path: outputPath,
          width: meta.width,
          height: meta.height,
          gray: grayData,
          smallGray: new Uint8Array(small.data.buffer, small.data.byteOffset, small.data.byteLength),
          smallWidth: small.info.width,
          smallHeight: small.info.height,
          edge,
          rgb: new Uint8Array(rgb.data.buffer, rgb.data.byteOffset, rgb.data.byteLength),
        } satisfies BaseArtifacts;
      }
    );
  }

  await img.toFile(outputPath);
  try {
    const finalMeta = await sharp(outputPath).metadata();
    console.log(`[stage0] FINAL size=${finalMeta.width || 0}x${finalMeta.height || 0}`);
  } catch {}
  return artifactsPromise ? await artifactsPromise : undefined;
}
