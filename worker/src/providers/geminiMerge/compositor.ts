import sharp from "sharp";
import { CompositeError } from "./types";

// Deterministic, local compositing only — Gemini never performs the final
// merge (implementation directive §11). Reuses the same Sharp alpha-overlay
// idiom already used elsewhere in this codebase (joinChannel + composite
// blend:"over" — see worker/src/pipeline/editApply.ts's local-harmonize
// compositing), rather than a hand-rolled per-pixel blend loop.
//
// final = original * (1 - alpha) + staged * alpha
// (mathematically what Sharp's "over" alpha-compositing does when the overlay
// carries a real per-pixel alpha channel built from the extraction mask.)

export async function compositeStagingLayer(params: {
  originalImagePath: string;
  stagedImagePath: string;
  maskPngBuffer: Buffer; // grayscale alpha mask, same dimensions as original
}): Promise<Buffer> {
  const originalMetadata = await sharp(params.originalImagePath).metadata();
  const width = originalMetadata.width || 0;
  const height = originalMetadata.height || 0;
  if (!width || !height) {
    throw new CompositeError(
      `Unable to read original image dimensions: ${params.originalImagePath}`,
      "composite_original_dimensions_unreadable"
    );
  }

  const [alphaRaw, stagedRgbBuffer] = await Promise.all([
    sharp(params.maskPngBuffer)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer(),
    sharp(params.stagedImagePath)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .toBuffer(),
  ]);

  let overlayRgba: Buffer;
  try {
    overlayRgba = await sharp(stagedRgbBuffer)
      .joinChannel(alphaRaw, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
  } catch (err: any) {
    throw new CompositeError(
      `Failed to build alpha overlay from staged image + extraction mask: ${err?.message || err}`,
      "composite_overlay_build_failed"
    );
  }

  try {
    return await sharp(params.originalImagePath)
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .composite([{ input: overlayRgba, blend: "over" }])
      .toBuffer();
  } catch (err: any) {
    throw new CompositeError(
      `Failed to composite staging layer onto original image: ${err?.message || err}`,
      "composite_blend_failed"
    );
  }
}

// Debug artifact (implementation directive §13): renders the extraction mask
// as a semi-transparent red overlay on the original image, so it's easy to
// visually inspect "what exactly did Gemini think was newly added."
export async function buildMaskOverlayDebugImage(params: {
  originalImagePath: string;
  maskPngBuffer: Buffer;
}): Promise<Buffer> {
  const originalMetadata = await sharp(params.originalImagePath).metadata();
  const width = originalMetadata.width || 0;
  const height = originalMetadata.height || 0;

  const alphaRaw = await sharp(params.maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();

  // Scale mask alpha down for a translucent overlay so the underlying photo
  // stays visible through the highlighted region.
  const overlayAlpha = Buffer.alloc(alphaRaw.length);
  for (let i = 0; i < alphaRaw.length; i += 1) {
    overlayAlpha[i] = Math.round((alphaRaw[i] ?? 0) * 0.6);
  }
  const redFill = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    redFill[i * 3] = 255;
    redFill[i * 3 + 1] = 32;
    redFill[i * 3 + 2] = 32;
  }
  const overlayRgba = await sharp(redFill, { raw: { width, height, channels: 3 } })
    .joinChannel(overlayAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();

  return sharp(params.originalImagePath)
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .composite([{ input: overlayRgba, blend: "over" }])
    .png()
    .toBuffer();
}
