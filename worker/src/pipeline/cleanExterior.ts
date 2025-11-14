export async function sharpNormalize(imgBuffer: Buffer): Promise<Buffer> {
  // Ensures output is color (3 channels)
  let buf = await sharp(imgBuffer).normalize().sharpen().toBuffer();
  const meta = await sharp(buf).metadata();
  if (meta.channels !== 3 && meta.channels !== 4) {
    buf = await sharp(buf).toColourspace('srgb').toBuffer();
  }
  return buf;
}
import sharp from "sharp";
// If OpenCV bindings are available, import them here
// import cv from "opencv4nodejs";
import { prepareWindowLock, stageModelOutputRestore, WindowLockOptions } from "./windowLock";

/**
 * Classical exterior cleaning for driveways, decks, patios, etc.
 * Applies bilateral smoothing, mild noise cleanup, green tint reduction, and normalization.
 * Returns a cleaned image buffer.
 */

export interface ExteriorCleanOptions {
  blurPrimary?: number;
  blurSecondary?: number;
  gamma?: number;
  normalize?: boolean;
  sharpen?: boolean;
  sharpenSigma?: number;
  windowLock?: WindowLockOptions;
}

/**
 * Exterior cleaning with optional window locking and auto-detect mask.
 * If windowMask or autoDetectMask+ai are provided, original window pixels are composited back after processing.
 */
export async function cleanDrivewayAndDeck(
  inputPath: string,
  opts: ExteriorCleanOptions = {}
): Promise<Buffer> {
  const {
    blurPrimary = 1.5,
    blurSecondary = 0.5,
    gamma = 1.1,
    normalize = true,
    sharpen = true,
    sharpenSigma = 1.0,
    windowLock
  } = opts;

  const original = await sharp(inputPath).toBuffer();

  // Optional window lock preparation (before enhancement / staging model)
  let windowPrep: Awaited<ReturnType<typeof prepareWindowLock>> | undefined;
  if (windowLock) {
    windowPrep = await prepareWindowLock(original, windowLock);
  }

  // Work on either original or masked variant
  let working = windowPrep ? windowPrep.maskedForModel : original;

  // Bilateral smoothing (simulate with blur for now)
  let pipeline = sharp(working);
  if (blurPrimary > 0) pipeline = pipeline.blur(blurPrimary);
  if (gamma !== 1.0) pipeline = pipeline.gamma(gamma);
  if (blurSecondary > 0) pipeline = pipeline.blur(blurSecondary);
  if (normalize) pipeline = pipeline.normalize();
  if (sharpen) pipeline = pipeline.sharpen(sharpenSigma);
  working = await pipeline.toBuffer();

  // After model-like processing, restore original windows if locking enabled
  if (windowPrep) {
    let restored = await stageModelOutputRestore(
      working,
      original,
      windowPrep.windowMask,
      windowLock
    );
    // Ensure color output
    const meta = await sharp(restored.restored).metadata();
    if (meta.channels !== 3 && meta.channels !== 4) {
      restored.restored = await sharp(restored.restored).toColourspace('srgb').toBuffer();
    }
    return restored.restored;
  }

  // Ensure color output for non-window-locked images
  const meta = await sharp(working).metadata();
  if (meta.channels !== 3 && meta.channels !== 4) {
    working = await sharp(working).toColourspace('srgb').toBuffer();
  }
  return working;
}
