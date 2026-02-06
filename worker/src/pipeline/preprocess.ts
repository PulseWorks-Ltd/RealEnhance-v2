import sharp from "sharp";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { computeEdgeMapFromGray } from "../validators/edgeUtils";

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
  // TODO: Add vertical/perspective correction (OpenCV or custom)

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
