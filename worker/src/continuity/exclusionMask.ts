import sharp from "sharp";
import { nLog } from "../logger";
import type { ProtectedEdgeStats } from "./types";
import { VertexSecondaryContinuityError } from "./types";

function threshold(value: number, limit: number): number {
  return value >= limit ? 255 : 0;
}

function countWhitePixels(buffer: Buffer): number {
  let count = 0;
  for (const value of buffer) {
    if (value > 0) {
      count += 1;
    }
  }
  return count;
}

export async function buildArchitecturalExclusionMask(params: {
  secondaryImagePath: string;
  exclusionMaskPath: string;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
}): Promise<{ maskBuffer: Buffer; maskPath: string; width: number; height: number; protectedPixelCount: number; protectedEdgeStats: ProtectedEdgeStats }> {
  const metadata = await sharp(params.secondaryImagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    throw new VertexSecondaryContinuityError(
      "Unable to read secondary image dimensions for exclusion mask compilation",
      "exclusion_mask_missing_dimensions"
    );
  }

  const grayscale = await sharp(params.secondaryImagePath)
    .greyscale()
    .raw()
    .toBuffer();

  const edgeBuffer = await sharp(grayscale, {
    raw: { width, height, channels: 1 },
  })
    .convolve({
      width: 3,
      height: 3,
      kernel: [
        -1, -1, -1,
        -1, 8, -1,
        -1, -1, -1,
      ],
      scale: 1,
      offset: 0,
    })
    .raw()
    .toBuffer();

  const borderX = Math.max(4, Math.round(width * 0.02));
  const borderTop = Math.max(4, Math.round(height * 0.02));
  const borderBottom = Math.max(8, Math.round(height * 0.06));
  const edgeThreshold = 28;
  const cornerWidth = Math.max(12, Math.round(width * 0.05));
  const cornerHeight = Math.max(12, Math.round(height * 0.05));

  const exclusion = Buffer.alloc(width * height);
  let baseboardPixels = 0;
  let trimPixels = 0;
  let cornerPixels = 0;
  let edgeProtectedPixels = 0;
  let borderProtectedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const edgeStrength = Math.abs((edgeBuffer[index] || 0) - 128);
      const nearVerticalBorder = x < borderX || x >= width - borderX;
      const nearTopBorder = y < borderTop;
      const nearBottomBorder = y >= height - borderBottom;
      const nearArchitecturalBoundary = nearVerticalBorder || nearTopBorder || nearBottomBorder;
      const protectPixel = nearArchitecturalBoundary || edgeStrength >= edgeThreshold;
      exclusion[index] = threshold(protectPixel ? 255 : 0, 1);

      if (protectPixel && edgeStrength >= edgeThreshold) {
        edgeProtectedPixels += 1;
      }
      if (protectPixel && nearArchitecturalBoundary) {
        borderProtectedPixels += 1;
      }
      if (protectPixel && nearBottomBorder) {
        baseboardPixels += 1;
      }
      if (protectPixel && (nearTopBorder || nearVerticalBorder)) {
        trimPixels += 1;
      }
      if (
        protectPixel
        && ((x < cornerWidth && y < cornerHeight)
          || (x >= width - cornerWidth && y < cornerHeight)
          || (x < cornerWidth && y >= height - cornerHeight)
          || (x >= width - cornerWidth && y >= height - cornerHeight))
      ) {
        cornerPixels += 1;
      }
    }
  }

  const dilated = await sharp(exclusion, {
    raw: { width, height, channels: 1 },
  })
    .blur(0.45)
    .threshold(1, { grayscale: true })
    .png()
    .toBuffer();

  await sharp(dilated).toFile(params.exclusionMaskPath);
  const protectedPixelCount = countWhitePixels(
    await sharp(dilated).raw().toBuffer()
  );

  nLog("[CONTINUITY_EXCLUSION_MASK]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    maskDimensions: `${width}x${height}`,
    exclusionPixelCount: protectedPixelCount,
    protectedEdgeStats: {
      baseboardPixels,
      trimPixels,
      cornerPixels,
      edgeProtectedPixels,
      borderProtectedPixels,
    },
    artifactPath: params.exclusionMaskPath,
  });

  return {
    maskBuffer: dilated,
    maskPath: params.exclusionMaskPath,
    width,
    height,
    protectedPixelCount,
    protectedEdgeStats: {
      baseboardPixels,
      trimPixels,
      cornerPixels,
      edgeProtectedPixels,
      borderProtectedPixels,
    },
  };
}