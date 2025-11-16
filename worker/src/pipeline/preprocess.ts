import sharp from "sharp";

/**
 * Preprocesses an image to create the canonical base image for a job.
 * - Straightens/rotates/perspective-corrects (deterministic)
 * - For interiors, normalizes brightness/saturation if too dark
 * - Returns path to canonical image
 */
export async function preprocessToCanonical(inputPath: string, outputPath: string, sceneType: string): Promise<void> {
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
  await img.toFile(outputPath);
}
