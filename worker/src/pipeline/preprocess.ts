import sharp from "sharp";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { computeEdgeMapFromGray } from "../validators/edgeUtils";

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
