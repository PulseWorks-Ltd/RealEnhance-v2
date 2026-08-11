import fs from "fs/promises";
import sharp from "sharp";
import { SUPPORTED_IMAGEN_ASPECT_RATIOS, type ImagenAspectRatioNormalization } from "./types";

// Ported near-verbatim from feature/vertex-secondary-inpainting-continuity's
// resolveNearestImagenAspectRatio (worker/src/providers/vertex/imageRendererProvider.ts:193) —
// this logic has no continuity coupling. Vertex Imagen only accepts
// {1:1, 4:3, 3:4, 16:9, 9:16}; arbitrary real-estate photo dimensions must be
// padded to the nearest supported ratio before the call and cropped back
// after (VERTEX_INPAINTING_INVESTIGATION.md §19).

function findExactSupportedAspectRatio(width: number, height: number) {
  return SUPPORTED_IMAGEN_ASPECT_RATIOS.find((candidate) => width * candidate.heightUnits === height * candidate.widthUnits);
}

export function resolveNearestImagenAspectRatio(width: number, height: number): ImagenAspectRatioNormalization {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid image dimensions for Imagen aspect ratio normalization: ${width}x${height}`);
  }

  const originalRatio = width / height;
  const exactMatch = findExactSupportedAspectRatio(width, height);
  if (exactMatch) {
    return {
      originalWidth: width,
      originalHeight: height,
      originalRatio,
      targetAspectRatio: exactMatch.label,
      paddedWidth: width,
      paddedHeight: height,
      padLeft: 0,
      padRight: 0,
      padTop: 0,
      padBottom: 0,
      normalizationApplied: false,
    };
  }

  const bestCandidate = [...SUPPORTED_IMAGEN_ASPECT_RATIOS]
    .map((candidate) => {
      const scale = Math.max(
        Math.ceil(width / candidate.widthUnits),
        Math.ceil(height / candidate.heightUnits)
      );
      const targetWidth = scale * candidate.widthUnits;
      const targetHeight = scale * candidate.heightUnits;
      const totalPadWidth = targetWidth - width;
      const totalPadHeight = targetHeight - height;
      const padLeft = Math.floor(totalPadWidth / 2);
      const padRight = totalPadWidth - padLeft;
      const padTop = Math.floor(totalPadHeight / 2);
      const padBottom = totalPadHeight - padTop;
      return {
        candidate,
        targetWidth,
        targetHeight,
        totalAddedPixels: (targetWidth * targetHeight) - (width * height),
        ratioDelta: Math.abs(originalRatio - candidate.value),
        padLeft,
        padRight,
        padTop,
        padBottom,
      };
    })
    .sort((left, right) => {
      if (left.ratioDelta !== right.ratioDelta) return left.ratioDelta - right.ratioDelta;
      if (left.totalAddedPixels !== right.totalAddedPixels) return left.totalAddedPixels - right.totalAddedPixels;
      if (left.targetWidth !== right.targetWidth) return left.targetWidth - right.targetWidth;
      return left.targetHeight - right.targetHeight;
    })[0];

  return {
    originalWidth: width,
    originalHeight: height,
    originalRatio,
    targetAspectRatio: bestCandidate.candidate.label,
    paddedWidth: bestCandidate.targetWidth,
    paddedHeight: bestCandidate.targetHeight,
    padLeft: bestCandidate.padLeft,
    padRight: bestCandidate.padRight,
    padTop: bestCandidate.padTop,
    padBottom: bestCandidate.padBottom,
    normalizationApplied: true,
  };
}

// Pads a local image file in place (transparent extend) to the normalization's
// padded dimensions. Used identically on both the source image and the mask so
// they stay dimensionally aligned (VERTEX_INPAINTING_INVESTIGATION.md §19).
export async function padImageInPlace(localPath: string, normalization: ImagenAspectRatioNormalization): Promise<void> {
  const tempPath = `${localPath}.aspect-normalized.tmp`;
  await sharp(localPath)
    .extend({
      left: normalization.padLeft,
      right: normalization.padRight,
      top: normalization.padTop,
      bottom: normalization.padBottom,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(tempPath);
  await fs.rename(tempPath, localPath);
}

// Crops a generated image buffer back down to the original (pre-padding) dimensions.
export async function cropToOriginalDimensions(
  imageBuffer: Buffer,
  normalization: ImagenAspectRatioNormalization
): Promise<Buffer> {
  return sharp(imageBuffer)
    .extract({
      left: normalization.padLeft,
      top: normalization.padTop,
      width: normalization.originalWidth,
      height: normalization.originalHeight,
    })
    .toBuffer();
}
