import sharp from "sharp";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { computeEdgeMapFromGray } from "../validators/edgeUtils";
import { assertNoDarkBorder } from "../utils/finalBlackEdgeGuard";

type CropRect = { left: number; top: number; width: number; height: number };

const PREPROCESS_DEBUG = process.env.PREPROCESS_DEBUG === "1" || process.env.DEBUG_PREPROCESS === "1";
let preprocessInvalidCropRectCount = 0;
let preprocessSkippedCropCount = 0;

function computeMaxInscribedRect(
  width: number,
  height: number,
  angleDeg: number
) {
  const angle = Math.abs(angleDeg) * (Math.PI / 180);

  const sin = Math.abs(Math.sin(angle));
  const cos = Math.abs(Math.cos(angle));

  const newWidth = width * cos + height * sin;
  const newHeight = width * sin + height * cos;

  const innerWidth =
    (width * height) /
    (width * sin + height * cos);

  const innerHeight =
    (width * height) /
    (width * cos + height * sin);

  const cropWidth = Math.min(innerWidth, newWidth);
  const cropHeight = Math.min(innerHeight, newHeight);

  return {
    left: Math.floor((newWidth - cropWidth) / 2),
    top: Math.floor((newHeight - cropHeight) / 2),
    width: Math.floor(cropWidth),
    height: Math.floor(cropHeight),
  };
}

async function detectBlackBorder(imageBuffer: Buffer): Promise<boolean> {
  const tempPath = `/tmp/preprocess-black-border-${randomUUID()}.webp`;
  const borderPx = Math.max(1, Number(process.env.BLACK_BORDER_CHECK_PX || 3));
  const threshold = Math.max(0, Number(process.env.BLACK_BORDER_THRESHOLD || 5));
  const maxDarkRatio = Math.max(0, Math.min(1, Number(process.env.BLACK_BORDER_MAX_DARK_RATIO || 0.02)));

  try {
    await fs.writeFile(tempPath, imageBuffer);
    await assertNoDarkBorder(tempPath, borderPx, threshold, maxDarkRatio);
    return false;
  } catch (error: any) {
    if (error?.code === "BLACK_BORDER_DETECTED") {
      return true;
    }
    throw error;
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch {}
  }
}

async function progressiveEdgeCropRecovery(
  imageBuffer: Buffer,
  jobId: string | undefined
): Promise<Buffer> {
  const MAX_CROP_RECOVERY_ATTEMPTS = 3;
  let currentBuffer = imageBuffer;

  for (let attempt = 1; attempt <= MAX_CROP_RECOVERY_ATTEMPTS; attempt++) {
    const baseImage = sharp(currentBuffer);
    const raw = await baseImage.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    
    const width = raw.info.width || 0;
    const height = raw.info.height || 0;
    const channels = raw.info.channels || 4;

    if (width === 0 || height === 0) return currentBuffer;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    // Expand search criteria slightly on subsequent retries
    const darkThreshold = 20 + (attempt - 1) * 4; 
    const alphaThreshold = 24 + (attempt - 1) * 8;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const r = raw.data[idx];
        const g = raw.data[idx + 1];
        const b = raw.data[idx + 2];
        const a = raw.data[idx + 3];
        
        const isDark = a <= alphaThreshold || (r <= darkThreshold && g <= darkThreshold && b <= darkThreshold);
        if (!isDark) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    // If entirely black or bounds are inverted
    if (maxX < minX || maxY < minY) {
       console.log(`[BLACK_EDGE_RECOVERY_FAILED] jobId=${jobId || 'unknown'} attempt=${attempt} - Image is entirely black`);
       throw new Error("BLACK_BORDER_STAGE1A_FATAL");
    }

    // Inset safely by progressive pixels to aggressively remove anti-aliased edge artifacts
    const safeInset = attempt * 2;
    let cropX = minX + safeInset;
    let cropY = minY + safeInset;
    let cropW = (maxX - minX + 1) - safeInset * 2;
    let cropH = (maxY - minY + 1) - safeInset * 2;

    if (cropW <= 0 || cropH <= 0 || cropW < width * 0.5 || cropH < height * 0.5) {
       console.log(`[BLACK_EDGE_RECOVERY_FAILED] jobId=${jobId || 'unknown'} attempt=${attempt} - Crop area too small or invalid: ${cropW}x${cropH}`);
       throw new Error("BLACK_BORDER_STAGE1A_FATAL");
    }

    const cropRect = {
        left: Math.max(0, cropX),
        top: Math.max(0, cropY),
        width: Math.min(width - cropX, cropW),
        height: Math.min(height - cropY, cropH)
    };

    console.log(`[BLACK_EDGE_CROP_ATTEMPT] jobId=${jobId || 'unknown'} attempt=${attempt} exact crop=left:${cropRect.left},top:${cropRect.top},width:${cropRect.width},height:${cropRect.height}`);

    const cropped = baseImage.extract(cropRect);
    currentBuffer = await cropped.toBuffer();

    const hasBlackBorder = await detectBlackBorder(currentBuffer);

    if (!hasBlackBorder) {
      console.log(`[BLACK_EDGE_RECOVERY_SUCCESS] jobId=${jobId || 'unknown'} resolved on attempt ${attempt}`);
      return currentBuffer;
    }
  }

  console.log(`[BLACK_EDGE_RECOVERY_EXHAUSTED] jobId=${jobId || 'unknown'} - Still has black edges after ${MAX_CROP_RECOVERY_ATTEMPTS} exact crop attempts!`);
  throw new Error("BLACK_BORDER_STAGE1A_FATAL");
}

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

function recordInvalidCropRectMetric(
  method: "non_dark_bbox" | "alpha" | "opencv" | "edge",
  imageW: number,
  imageH: number,
  rect: CropRect,
): void {
  preprocessInvalidCropRectCount += 1;
  preprocessSkippedCropCount += 1;
  console.warn(
    `[METRIC] preprocess_crop_guard event=invalid_rect method=${method} image=${imageW}x${imageH} rect=${rect.left},${rect.top},${rect.width},${rect.height} preprocess_invalid_crop_rect_count=${preprocessInvalidCropRectCount} preprocess_skipped_crop_count=${preprocessSkippedCropCount}`
  );
}

function sanitizeCropRect(rect: CropRect, imageW: number, imageH: number): CropRect | null {
  if (!Number.isFinite(imageW) || !Number.isFinite(imageH)) return null;
  if (imageW <= 0 || imageH <= 0) return null;

  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }

  const rawLeft = Math.floor(rect.left);
  const rawTop = Math.floor(rect.top);
  if (rawLeft >= imageW || rawTop >= imageH) return null;

  const left = Math.max(0, rawLeft);
  const top = Math.max(0, rawTop);

  const remainingW = imageW - left;
  const remainingH = imageH - top;
  if (remainingW <= 0 || remainingH <= 0) return null;

  let requestedW = Math.floor(rect.width);
  let requestedH = Math.floor(rect.height);
  if (requestedW <= 0 || requestedH <= 0) return null;

  if (rawLeft + requestedW > imageW && requestedW > 1) {
    requestedW -= 1;
  }
  if (rawTop + requestedH > imageH && requestedH > 1) {
    requestedH -= 1;
  }

  const width = Math.max(1, Math.min(remainingW, requestedW));
  const height = Math.max(1, Math.min(remainingH, requestedH));

  return { left, top, width, height };
}

async function rotateAndCropSafe(
  image: sharp.Sharp,
  angleDeg: number,
  minApplyDeg: number,
  maxCorrectionDeg: number,
  borderRecoveryInsetPx = 0
): Promise<{ image: sharp.Sharp; applied: boolean; straightenAngle: number; cropRect: CropRect | null; reason: string }> {
  const absAngle = Math.abs(angleDeg);
  if (absAngle < minApplyDeg) {
    return {
      image,
      applied: false,
      straightenAngle: 0,
      cropRect: null,
      reason: "below_min",
    };
  }

  if (absAngle > maxCorrectionDeg) {
    return {
      image,
      applied: false,
      straightenAngle: 0,
      cropRect: null,
      reason: "above_max",
    };
  }

  try {
    const originalMeta = await image.metadata();
    const originalWidth = originalMeta.width || 0;
    const originalHeight = originalMeta.height || 0;
    if (!originalWidth || !originalHeight) {
      return {
        image,
        applied: false,
        straightenAngle: 0,
        cropRect: null,
        reason: "missing_dimensions",
      };
    }

    const rotated = image
      .ensureAlpha()
      .rotate(-angleDeg, { background: { r: 0, g: 0, b: 0 } });

    const rotatedMeta = await rotated.metadata();
    const rotatedWidth = rotatedMeta.width || 0;
    const rotatedHeight = rotatedMeta.height || 0;
    if (!rotatedWidth || !rotatedHeight) {
      return {
        image,
        applied: false,
        straightenAngle: 0,
        cropRect: null,
        reason: "missing_rotated_dimensions",
      };
    }

    const rawCropRect = computeMaxInscribedRect(
      originalWidth,
      originalHeight,
      angleDeg
    );

    const cropRect = sanitizeCropRect(rawCropRect, rotatedWidth, rotatedHeight);
    if (!cropRect) {
      recordInvalidCropRectMetric("edge", rotatedWidth, rotatedHeight, rawCropRect);
      return {
        image,
        applied: false,
        straightenAngle: 0,
        cropRect: null,
        reason: "crop_failed",
      };
    }

    let cropped = rotated.extract(cropRect);
    let buffer = await cropped.toBuffer();

    return {
      image: sharp(buffer),
      applied: true,
      straightenAngle: -angleDeg,
      cropRect,
      reason: "rotated_and_cropped",
    };
  } catch (error: any) {
    if (error?.message === "BLACK_BORDER_STAGE1A_FATAL") {
      throw error;
    }
    return {
      image,
      applied: false,
      straightenAngle: 0,
      cropRect: null,
      reason: "rotate_or_crop_error",
    };
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

    // Harden contour detection against thin anti-aliased wedges/fringes.
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    if (kernel && typeof kernel.delete === "function") {
      kernel.delete();
    }

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

    let left = Math.max(0, Math.floor(bestRect.x || 0));
    let top = Math.max(0, Math.floor(bestRect.y || 0));
    let width = Math.max(1, Math.floor(bestRect.width || 0));
    let height = Math.max(1, Math.floor(bestRect.height || 0));

    const inwardPadRaw = Number(process.env.PREPROCESS_INWARD_PAD ?? 2);
    const inwardPad = Number.isFinite(inwardPadRaw)
      ? Math.max(0, Math.min(8, Math.floor(inwardPadRaw)))
      : 2;

    if (inwardPad > 0 && width > inwardPad * 2 + 2 && height > inwardPad * 2 + 2) {
      left += inwardPad;
      top += inwardPad;
      width -= inwardPad * 2;
      height -= inwardPad * 2;
    }

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
  const probe = await img
    .clone()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const beforeW = probe.info.width || 0;
  const beforeH = probe.info.height || 0;
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
      const clamped = sanitizeCropRect(rect, beforeW, beforeH);
      if (!clamped) {
        recordInvalidCropRectMetric("alpha", beforeW, beforeH, rect);
        console.warn(`[stage0] CROP rect=invalid method=alpha`);
      } else {
      console.log(`[stage0] CROP rect=${clamped.left},${clamped.top},${clamped.width},${clamped.height} method=alpha`);
      console.log(`[stage0] POST-CROP size=${clamped.width}x${clamped.height}`);
      logCropStats("alpha", beforeW, beforeH, clamped);
      return img.extract(clamped);
      }
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
      const clamped = sanitizeCropRect(rect, beforeW, beforeH);
      if (!clamped) {
        recordInvalidCropRectMetric("opencv", beforeW, beforeH, rect);
        console.warn(`[stage0] CROP rect=invalid method=opencv`);
      } else {
      console.log(`[stage0] CROP rect=${clamped.left},${clamped.top},${clamped.width},${clamped.height} method=opencv`);
      console.log(`[stage0] POST-CROP size=${clamped.width}x${clamped.height}`);
      logCropStats("opencv", beforeW, beforeH, clamped);
      return img.extract(clamped);
      }
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
      const clamped = sanitizeCropRect(rect, beforeW, beforeH);
      if (!clamped) {
        recordInvalidCropRectMetric("edge", beforeW, beforeH, rect);
        console.warn(`[stage0] CROP rect=invalid method=edge`);
      } else {
      console.log(`[stage0] CROP rect=${clamped.left},${clamped.top},${clamped.width},${clamped.height} method=edge`);
      console.log(`[stage0] POST-CROP size=${clamped.width}x${clamped.height}`);
      logCropStats("edge", beforeW, beforeH, clamped);
      return img.extract(clamped);
      }
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
  options: { buildArtifacts?: boolean; smallSize?: number; stage1ABorderRetryIndex?: number; jobId?: string } = {}
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
  const stage1ABorderRetryIndex = Math.max(0, Number(options.stage1ABorderRetryIndex || 0));
  const borderRecoveryInsetPx = Math.min(8, stage1ABorderRetryIndex * 2);
  let straightenAngle = 0;
  let straightenCropRect: CropRect | null = null;
  if (straightenEnabled) {
    let estimatedRoll = 0;
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
        estimatedRoll = estimateRollFromEdges(gray, analysis.info.width, analysis.info.height);
      }
    } catch {
      // Fail-open: if straightening analysis fails, skip straighten and continue.
      estimatedRoll = 0;
    }

    const safeRotate = await rotateAndCropSafe(
      img,
      estimatedRoll,
      minApplyDeg,
      maxCorrectionDeg,
      borderRecoveryInsetPx,
    );
    img = safeRotate.image;
    straightenAngle = safeRotate.straightenAngle;
    straightenCropRect = safeRotate.cropRect;

    if (PREPROCESS_DEBUG) {
      const afterStraightenMeta = await img.metadata();
      console.log(
        `[preprocess] straightenAngle=${straightenAngle.toFixed(4)} originalWidth=${rotatedMeta.width || 0} originalHeight=${rotatedMeta.height || 0} boundingCropWidth=${straightenCropRect?.width ?? (afterStraightenMeta.width || 0)} boundingCropHeight=${straightenCropRect?.height ?? (afterStraightenMeta.height || 0)} reason=${safeRotate.reason}`
      );
    }
  }

  img = img.removeAlpha();

  // For interiors, normalize brightness/saturation if too dark
  if (sceneType === "interior") {
    const stats = await img.stats();
    const meanLum = stats.channels[0].mean / 255;
    if (meanLum < 0.35) {
      img = img.modulate({ brightness: 1.12, saturation: 1.05 });
    }
  }

  let stage0ResultBuffer = await img.toBuffer();
  if (await detectBlackBorder(stage0ResultBuffer)) {
    console.log(`[BLACK_EDGE_RECOVERY_START] jobId=${options.jobId || 'unknown'} reason=black_edges_after_stage0`);
    const recoveredImage = await progressiveEdgeCropRecovery(stage0ResultBuffer, options.jobId);
    console.log(`[BLACK_EDGE_RECOVERY_COMPLETE] jobId=${options.jobId || 'unknown'}`);
    img = sharp(recoveredImage);
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
