import sharp from "sharp";
import {
  binarizeGrayscale,
  countConnectedComponents,
  countWhitePixels,
  findMaskBoundingBox,
  isBinaryMask,
} from "./maskUtils";
import type { MaskQualityMetrics, MaskValidationResult } from "./types";

// Minimal single-image mask validator (VERTEX_INPAINTING_INVESTIGATION.md §8).
// Deliberately NOT the continuity branch's validateCompiledMask — that
// function assumes occupancy/exclusion/final compiled-mask concepts that only
// make sense for master/secondary projection. This checks only what a single
// furniture-placement mask actually needs to satisfy before being sent to
// Vertex: it exists, matches source dimensions, is valid PNG, is strictly
// binary, isn't fully black or fully white, and has a meaningful region.
export async function validateMask(params: {
  sourceImagePath: string;
  maskPath: string;
  minWhitePixelRatio?: number;
  maxWhitePixelRatio?: number;
}): Promise<MaskValidationResult> {
  const minWhiteRatio = params.minWhitePixelRatio ?? 0.01;
  const maxWhiteRatio = params.maxWhitePixelRatio ?? 0.95;

  const sourceMetadata = await sharp(params.sourceImagePath).metadata();
  const sourceWidth = sourceMetadata.width || 0;
  const sourceHeight = sourceMetadata.height || 0;

  let maskMetadata: sharp.Metadata;
  try {
    maskMetadata = await sharp(params.maskPath).metadata();
  } catch (err: any) {
    return invalidResult(0, 0, `mask_not_a_valid_image: ${err?.message || err}`);
  }
  const maskWidth = maskMetadata.width || 0;
  const maskHeight = maskMetadata.height || 0;

  if (!sourceWidth || !sourceHeight) {
    return invalidResult(maskWidth, maskHeight, "source_dimensions_unreadable");
  }
  if (!maskWidth || !maskHeight) {
    return invalidResult(0, 0, "mask_dimensions_unreadable");
  }
  if (maskWidth !== sourceWidth || maskHeight !== sourceHeight) {
    return invalidResult(
      maskWidth,
      maskHeight,
      `mask_dimension_mismatch: source=${sourceWidth}x${sourceHeight} mask=${maskWidth}x${maskHeight}`
    );
  }

  const grayscaleRaw = await sharp(params.maskPath).removeAlpha().grayscale().raw().toBuffer();
  // Binarize defensively: the Gemini response is instructed to return a
  // strictly binary mask, but model output can drift (anti-aliased edges,
  // near-white/near-black noise) — normalize before validating "is binary".
  const binarized = binarizeGrayscale(grayscaleRaw);
  const totalPixelCount = maskWidth * maskHeight;
  const whitePixelCount = countWhitePixels(binarized);
  const whitePixelRatio = whitePixelCount / totalPixelCount;
  const boundingBox = findMaskBoundingBox(binarized, maskWidth, maskHeight);
  const connectedComponentCount = countConnectedComponents(binarized, maskWidth);

  const metrics: MaskQualityMetrics = {
    width: maskWidth,
    height: maskHeight,
    whitePixelCount,
    whitePixelRatio,
    blackPixelRatio: 1 - whitePixelRatio,
    boundingBox,
    connectedComponentCount,
  };

  if (!isBinaryMask(grayscaleRaw) && !isBinaryMask(binarized)) {
    // Both raw and post-binarize checks fail only if binarize itself produced
    // non-binary output, which cannot happen — this branch exists purely as
    // a defensive invariant check, not a real rejection path.
    return { valid: false, reason: "mask_binarization_failed", metrics };
  }

  if (whitePixelCount === 0) {
    return { valid: false, reason: "mask_completely_black_no_editable_region", metrics };
  }
  if (whitePixelCount === totalPixelCount) {
    return { valid: false, reason: "mask_completely_white_nothing_protected", metrics };
  }
  if (whitePixelRatio < minWhiteRatio) {
    return { valid: false, reason: `mask_editable_region_too_small: ratio=${whitePixelRatio.toFixed(4)}`, metrics };
  }
  if (whitePixelRatio > maxWhiteRatio) {
    return { valid: false, reason: `mask_editable_region_too_large: ratio=${whitePixelRatio.toFixed(4)}`, metrics };
  }
  if (!boundingBox) {
    return { valid: false, reason: "mask_no_bounding_box", metrics };
  }

  return { valid: true, reason: null, metrics };
}

function invalidResult(width: number, height: number, reason: string): MaskValidationResult {
  return {
    valid: false,
    reason,
    metrics: {
      width,
      height,
      whitePixelCount: 0,
      whitePixelRatio: 0,
      blackPixelRatio: 1,
      boundingBox: null,
      connectedComponentCount: 0,
    },
  };
}
