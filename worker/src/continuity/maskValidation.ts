import sharp from "sharp";
import { nLog } from "../logger";
import type { CompiledMaskResult, MaskBoundingBox, MaskValidationResult } from "./types";
import { VertexSecondaryContinuityError } from "./types";

function isBinaryMask(buffer: Buffer): boolean {
  for (const value of buffer) {
    if (value !== 0 && value !== 255) {
      return false;
    }
  }
  return true;
}

function requireBounds(bounds: MaskBoundingBox | null): MaskBoundingBox {
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    return bounds;
  }
  throw new VertexSecondaryContinuityError(
    "Final continuity mask has no editable insertion region",
    "mask_empty_final_region"
  );
}

export async function validateCompiledMask(params: {
  sourceImagePath: string;
  compiledMask: CompiledMaskResult;
  continuityGroupId?: string | null;
  jobId: string;
  imageId: string;
}): Promise<MaskValidationResult> {
  const sourceMetadata = await sharp(params.sourceImagePath).metadata();
  const sourceWidth = sourceMetadata.width || 0;
  const sourceHeight = sourceMetadata.height || 0;
  if (!sourceWidth || !sourceHeight) {
    throw new VertexSecondaryContinuityError(
      "Unable to read source image dimensions for continuity mask validation",
      "mask_validation_missing_source_dimensions"
    );
  }

  if (sourceWidth !== params.compiledMask.width || sourceHeight !== params.compiledMask.height) {
    throw new VertexSecondaryContinuityError(
      "Continuity masks do not match the source image dimensions",
      "mask_dimension_mismatch"
    );
  }

  const occupancyRaw = await sharp(params.compiledMask.occupancyMaskBuffer)
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer();
  const exclusionRaw = await sharp(params.compiledMask.exclusionMaskBuffer)
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer();
  const finalRaw = await sharp(params.compiledMask.finalMaskBuffer)
    .removeAlpha()
    .grayscale()
    .raw()
    .toBuffer();

  const binaryIntegrity = {
    occupancy: isBinaryMask(occupancyRaw),
    exclusion: isBinaryMask(exclusionRaw),
    final: isBinaryMask(finalRaw),
  };
  if (!binaryIntegrity.occupancy || !binaryIntegrity.exclusion || !binaryIntegrity.final) {
    throw new VertexSecondaryContinuityError(
      "Continuity mask validation detected non-binary mask pixels",
      "mask_non_binary"
    );
  }

  const totalPixelCount = params.compiledMask.totalPixelCount;
  if (params.compiledMask.occupancyPixelCount <= 0 || params.compiledMask.occupancyPixelCount >= totalPixelCount) {
    throw new VertexSecondaryContinuityError(
      "Occupancy mask is empty or covers the full frame",
      "mask_invalid_occupancy_area"
    );
  }
  if (params.compiledMask.exclusionPixelCount >= totalPixelCount) {
    throw new VertexSecondaryContinuityError(
      "Exclusion mask protects the full frame",
      "mask_invalid_exclusion_area"
    );
  }
  if (params.compiledMask.finalPixelCount <= 0 || params.compiledMask.finalPixelCount >= totalPixelCount) {
    throw new VertexSecondaryContinuityError(
      "Final continuity mask is empty or covers the full frame",
      "mask_invalid_final_area"
    );
  }
  if (params.compiledMask.finalPixelCount > params.compiledMask.occupancyPixelCount) {
    throw new VertexSecondaryContinuityError(
      "Final continuity mask exceeds occupancy coverage",
      "mask_invalid_overlap_ratio"
    );
  }
  if (params.compiledMask.overlapPixelCount >= params.compiledMask.occupancyPixelCount) {
    throw new VertexSecondaryContinuityError(
      "Occupancy mask was fully stripped by exclusions",
      "mask_fully_stripped_by_exclusions"
    );
  }

  const occupancyStrippedRatio = params.compiledMask.occupancyPixelCount > 0
    ? params.compiledMask.overlapPixelCount / params.compiledMask.occupancyPixelCount
    : 1;
  nLog("[CONTINUITY_MASK_VALIDATION_COVERAGE]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    totalPixelCount,
    occupancyPixelCount: params.compiledMask.occupancyPixelCount,
    exclusionPixelCount: params.compiledMask.exclusionPixelCount,
    finalPixelCount: params.compiledMask.finalPixelCount,
    overlapPixelCount: params.compiledMask.overlapPixelCount,
    occupancyAreaRatio: Number(params.compiledMask.occupancyAreaRatio.toFixed(4)),
    exclusionAreaRatio: Number(params.compiledMask.exclusionAreaRatio.toFixed(4)),
    finalAreaRatio: Number(params.compiledMask.finalAreaRatio.toFixed(4)),
    occupancyStrippedRatio: Number(occupancyStrippedRatio.toFixed(4)),
    protectedEdgeStats: params.compiledMask.protectedEdgeStats,
  });

  if (occupancyStrippedRatio >= 0.95) {
    throw new VertexSecondaryContinuityError(
      "Occupancy mask is almost entirely removed by the exclusion mask",
      "mask_exclusion_overreach"
    );
  }

  const validation: MaskValidationResult = {
    width: params.compiledMask.width,
    height: params.compiledMask.height,
    totalPixelCount,
    occupancyPixelCount: params.compiledMask.occupancyPixelCount,
    exclusionPixelCount: params.compiledMask.exclusionPixelCount,
    finalPixelCount: params.compiledMask.finalPixelCount,
    overlapPixelCount: params.compiledMask.overlapPixelCount,
    occupancyAreaRatio: params.compiledMask.occupancyAreaRatio,
    exclusionAreaRatio: params.compiledMask.exclusionAreaRatio,
    finalAreaRatio: params.compiledMask.finalAreaRatio,
    overlapReductionRatio: params.compiledMask.overlapReductionRatio,
    occupancyStrippedRatio,
    insertionBounds: requireBounds(params.compiledMask.insertionBounds),
    binaryIntegrity,
    guidanceCorrelation: {
      validatorFlow: "existing_stage2_pipeline",
      validatorPassRate: null,
      insertionRealismOutcome: null,
      edgeHarshnessReport: null,
      continuityQualityOutcome: null,
      localContrastAnalysis: "pending_instrumentation",
      edgeRealismEvaluation: "pending_instrumentation",
    },
    occupancyValidationMode: params.compiledMask.occupancyValidationMode,
    preRenderOccupancyTelemetry: params.compiledMask.preRenderOccupancyTelemetry,
    postRenderContinuityEval: null,
  };

  nLog("[CONTINUITY_MASK_VALIDATION]", {
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    width: validation.width,
    height: validation.height,
    occupancyPixelCount: validation.occupancyPixelCount,
    exclusionPixelCount: validation.exclusionPixelCount,
    finalPixelCount: validation.finalPixelCount,
    overlapPixelCount: validation.overlapPixelCount,
    occupancyStrippedRatio: Number(validation.occupancyStrippedRatio.toFixed(4)),
    binaryIntegrity: validation.binaryIntegrity,
  });

  return validation;
}