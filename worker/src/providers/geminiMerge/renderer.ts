import fs from "fs/promises";
import sharp from "sharp";
import { runStage2 } from "../../pipeline/stage2";
import { siblingOutPath } from "../../utils/images";
import { compositeStagingLayer, buildMaskOverlayDebugImage } from "./compositor";
import { extractStagingLayerMask, getExtractionModel } from "./extraction";
import { validateExtractionMask } from "./maskValidator";
import { GeminiMergeStagingRequest, GeminiMergeStagingResult, MaskValidationError, StagingGenerationError } from "./types";

// Orchestrates the full experimental "generate then extract and merge" flow:
//
//   Stage 1A/1B (original, structural authority)
//         |
//         v
//   existing Gemini/Nano Banana staging generation (runStage2, reused as-is)
//         |
//         v
//   staged candidate image
//         |
//         v
//   Gemini extraction call (original + staged -> alpha mask of new staging layer)
//         |
//         v
//   mask validation (deterministic, local)
//         |
//         v
//   deterministic local composite: original + (staged through alpha mask)
//         |
//         v
//   final Stage 2 output
//
// No specialist validator chain, no Vertex, no EdenSign, no pre-generation
// masks — this experiment tests generation + extraction + compositing only.

export async function renderStagingWithGeminiMerge(
  request: GeminiMergeStagingRequest
): Promise<GeminiMergeStagingResult> {
  console.log("[STAGE2_GEMINI_MERGE] generation_start", {
    jobId: request.jobId,
    imageId: request.imageId,
    roomType: request.roomType,
    sourceStage: request.sourceStage,
  });

  const generationStartedAt = Date.now();
  const stage2Result = await runStage2(request.basePath, request.sourceStage === "1A" ? "1A" : "1B", {
    roomType: request.roomType,
    sceneType: request.sceneType,
    stagingStyle: request.stagingStyle,
    sourceStage: request.sourceStage,
    jobId: request.jobId,
    imageId: request.imageId,
  });
  const generationDurationMs = Date.now() - generationStartedAt;

  if (!stage2Result.outputPath || stage2Result.outputPath === request.basePath || stage2Result.attempts === 0) {
    throw new StagingGenerationError(
      "Existing Gemini staging generation did not produce a new candidate image (disabled, missing API key, or collapsed to input)",
      "gemini_merge_staging_generation_unavailable"
    );
  }
  const stagedCandidatePath = stage2Result.outputPath;

  console.log("[STAGE2_GEMINI_MERGE] generation_complete", {
    jobId: request.jobId,
    imageId: request.imageId,
    stagedCandidatePath,
    attempts: stage2Result.attempts,
    generationDurationMs,
  });

  const extractionStartedAt = Date.now();
  const extraction = await extractStagingLayerMask({
    originalImagePath: request.basePath,
    stagedImagePath: stagedCandidatePath,
    jobId: request.jobId,
    imageId: request.imageId,
  });
  const extractionDurationMs = Date.now() - extractionStartedAt;

  const maskPath = siblingOutPath(request.basePath, "-2-gemini-merge-mask", ".png");
  await fs.writeFile(maskPath, extraction.maskPngBuffer);

  const validation = await validateExtractionMask({
    sourceImagePath: request.basePath,
    maskPngBuffer: extraction.maskPngBuffer,
  });
  console.log("[STAGE2_GEMINI_MERGE] mask_quality", {
    jobId: request.jobId,
    imageId: request.imageId,
    ...validation.metrics,
    coveragePercent: Number((validation.metrics.nonZeroPixelRatio * 100).toFixed(2)),
    valid: validation.valid,
    reason: validation.reason,
  });
  if (!validation.valid) {
    throw new MaskValidationError(
      `Extraction mask failed validation: ${validation.reason}`,
      "gemini_merge_mask_invalid"
    );
  }

  const overlayPath = siblingOutPath(request.basePath, "-2-gemini-merge-overlay", ".png");
  const overlayBuffer = await buildMaskOverlayDebugImage({
    originalImagePath: request.basePath,
    maskPngBuffer: extraction.maskPngBuffer,
  });
  await fs.writeFile(overlayPath, overlayBuffer);

  console.log("[STAGE2_GEMINI_MERGE] composite_start", {
    jobId: request.jobId,
    imageId: request.imageId,
  });
  const compositeStartedAt = Date.now();
  const compositedBuffer = await compositeStagingLayer({
    originalImagePath: request.basePath,
    stagedImagePath: stagedCandidatePath,
    maskPngBuffer: extraction.maskPngBuffer,
  });
  const finalLocalPath = siblingOutPath(request.basePath, "-2-gemini-merge", ".webp");
  await sharp(compositedBuffer).webp({ quality: 95 }).toFile(finalLocalPath);
  const compositeDurationMs = Date.now() - compositeStartedAt;

  console.log("[STAGE2_GEMINI_MERGE] composite_complete", {
    jobId: request.jobId,
    imageId: request.imageId,
    finalLocalPath,
    compositeDurationMs,
  });

  return {
    finalLocalPath,
    stagedCandidatePath,
    extractionMaskPath: maskPath,
    overlayDebugPath: overlayPath,
    maskMetrics: validation.metrics,
    stagingModel: "existing_stage2_gemini_pipeline",
    extractionModel: extraction.modelUsed || getExtractionModel(),
    generationDurationMs,
    extractionDurationMs,
    compositeDurationMs,
  };
}
