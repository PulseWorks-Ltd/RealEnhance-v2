import sharp from "sharp";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { computeEdgeMapFromGray } from "../validators/edgeUtils";

type CropRect = { left: number; top: number; width: number; height: number };

function logCropStats(method: "opencv" | "trim", beforeW: number, beforeH: number, rect: CropRect): void {
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

async function detectCropRectWithOpenCv(tempImagePath: string): Promise<CropRect | null> {
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
    cv.threshold(gray, mask, 10, 255, cv.THRESH_BINARY);

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

async function autoCropPostStraighten(img: sharp.Sharp): Promise<sharp.Sharp> {
  const meta = await img.metadata();
  const beforeW = meta.width || 0;
  const beforeH = meta.height || 0;
  if (!beforeW || !beforeH) return img;

  // Primary method: OpenCV contour crop on non-black region
  const tempPath = `/tmp/preprocess-straighten-${randomUUID()}.png`;
  try {
    const pngBuf = await img.clone().png().toBuffer();
    await fs.writeFile(tempPath, pngBuf);
    const rect = await detectCropRectWithOpenCv(tempPath);

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
      .trim({ threshold: 10 })
      .toBuffer({ resolveWithObject: true });

    const afterW = trimmed.info.width || beforeW;
    const afterH = trimmed.info.height || beforeH;

    if (afterW > 0 && afterH > 0 && (afterW < beforeW || afterH < beforeH)) {
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
  // Auto-orient (EXIF)
  img = img.rotate();

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
          // Rotate opposite of measured drift, then crop back deterministically to original frame size.
          img = img
            .rotate(-clampedRoll)
            .resize(targetW, targetH, { fit: "cover", position: "centre" });
        }
      }
    } catch {
      // Fail-open: if straightening analysis fails, keep canonical preprocessing running.
    }
  }

  // Stage 0 post-straighten border crop to remove black wedges introduced by rotation.
  // Applied to image preprocessing only, before Stage 1A/1B/2.
  img = await autoCropPostStraighten(img);

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
  return artifactsPromise ? await artifactsPromise : undefined;
}
