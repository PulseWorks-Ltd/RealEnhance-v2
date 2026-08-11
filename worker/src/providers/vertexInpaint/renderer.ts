import fs from "fs/promises";
import sharp from "sharp";
import { STYLE_PROMPT_MODIFIERS, normalizeStagingStyle } from "../../ai/stagingStyles";
import { siblingOutPath, toBase64 } from "../../utils/images";
import { cropToOriginalDimensions, padImageInPlace, resolveNearestImagenAspectRatio } from "./aspectRatio";
import { validateOutsideMaskDrift } from "./driftValidator";
import { generateFurniturePlacementMask } from "./maskGenerator";
import { validateMask } from "./maskValidator";
import { MaskValidationError, OutsideMaskDriftError, VertexInpaintStagingRequest, VertexInpaintStagingResult } from "./types";
import { buildVertexInpaintPredictPayload, getVertexImagenModel, predictInpaint } from "./vertexClient";

// Orchestrates the full experimental Stage 2 flow
// (VERTEX_INPAINTING_INVESTIGATION.md §4):
//
//   Stage 1A/1B output -> Gemini furniture-placement mask -> mask validation
//   -> Vertex Imagen EDIT_MODE_INPAINT_INSERTION -> outside-mask drift check
//   -> Stage 2 output
//
// Runs synchronously inline in the normal Stage 2 worker job — no new queue,
// no new worker process (§23).

function buildStagingPrompt(roomType: string, stagingStyle?: string): string {
  const normalizedStyle = normalizeStagingStyle(stagingStyle);
  const styleModifier = STYLE_PROMPT_MODIFIERS[normalizedStyle];
  return [
    `Stage this ${roomType || "room"} with realistic, well-proportioned furniture appropriate for a real estate listing photo.`,
    styleModifier,
    "Only add furniture within the editable region. Ground furniture with realistic shadows and consistent scale and lighting matching the existing photograph.",
  ].filter(Boolean).join(" ");
}

export async function renderStagingWithVertexInpaint(
  request: VertexInpaintStagingRequest
): Promise<VertexInpaintStagingResult> {
  const submittedAt = new Date().toISOString();
  const maskPath = siblingOutPath(request.basePath, "-2-vertex-inpaint-mask", ".png");
  const outputPath = siblingOutPath(request.basePath, "-2-vertex-inpaint", ".webp");

  const maskGenStartedAt = Date.now();
  await generateFurniturePlacementMask({
    sourceImagePath: request.basePath,
    roomType: request.roomType,
    outputMaskPath: maskPath,
    jobId: request.jobId,
    imageId: request.imageId,
  });
  const maskGenerationDurationMs = Date.now() - maskGenStartedAt;

  const maskValidation = await validateMask({
    sourceImagePath: request.basePath,
    maskPath,
  });
  console.log("[STAGE2_VERTEX_INPAINT] mask_quality", {
    jobId: request.jobId,
    imageId: request.imageId,
    ...maskValidation.metrics,
    valid: maskValidation.valid,
    reason: maskValidation.reason,
  });
  if (!maskValidation.valid) {
    throw new MaskValidationError(
      `Generated furniture-placement mask failed validation: ${maskValidation.reason}`,
      "mask_invalid"
    );
  }

  // Aspect ratio normalization (§19): pad both source and mask identically to
  // the nearest Vertex-supported ratio, restore by cropping the result back.
  const sourceMetadata = await sharp(request.basePath).metadata();
  const normalization = resolveNearestImagenAspectRatio(sourceMetadata.width || 0, sourceMetadata.height || 0);

  let vertexSourcePath = request.basePath;
  let vertexMaskPath = maskPath;
  if (normalization.normalizationApplied) {
    vertexSourcePath = siblingOutPath(request.basePath, "-2-vertex-inpaint-source-padded", ".png");
    vertexMaskPath = siblingOutPath(request.basePath, "-2-vertex-inpaint-mask-padded", ".png");
    await fs.copyFile(request.basePath, vertexSourcePath);
    await fs.copyFile(maskPath, vertexMaskPath);
    await padImageInPlace(vertexSourcePath, normalization);
    await padImageInPlace(vertexMaskPath, normalization);
  }

  console.log("[STAGE2_VERTEX_INPAINT] aspect_ratio", {
    jobId: request.jobId,
    imageId: request.imageId,
    originalDimensions: { width: normalization.originalWidth, height: normalization.originalHeight },
    targetAspectRatio: normalization.targetAspectRatio,
    normalizationApplied: normalization.normalizationApplied,
    paddedDimensions: normalization.normalizationApplied
      ? { width: normalization.paddedWidth, height: normalization.paddedHeight }
      : null,
  });

  const sourceWire = toBase64(vertexSourcePath);
  const maskWire = toBase64(vertexMaskPath);
  const prompt = buildStagingPrompt(request.roomType, request.stagingStyle);
  const payload = buildVertexInpaintPredictPayload({
    prompt,
    sourcePayload: { bytesBase64Encoded: sourceWire.data, mimeType: sourceWire.mime },
    maskPayload: { bytesBase64Encoded: maskWire.data, mimeType: maskWire.mime },
  });

  const vertexRenderStartedAt = Date.now();
  const generated = await predictInpaint(payload, request.jobId, request.imageId);
  const vertexRenderDurationMs = Date.now() - vertexRenderStartedAt;

  let outputBuffer: Buffer = Buffer.from(generated.imageBytes, "base64");
  if (normalization.normalizationApplied) {
    outputBuffer = await cropToOriginalDimensions(outputBuffer, normalization);
  }
  await sharp(outputBuffer).webp({ quality: 95 }).toFile(outputPath);

  const driftResult = await validateOutsideMaskDrift({
    sourcePath: request.basePath,
    candidatePath: outputPath,
    maskPath,
    jobId: request.jobId,
    imageId: request.imageId,
  });
  if (!driftResult.passed) {
    throw new OutsideMaskDriftError(
      driftResult.failureReason || "outside_mask_drift_exceeded",
      "outside_mask_drift_exceeded"
    );
  }

  const completedAt = new Date().toISOString();
  return {
    localPath: outputPath,
    maskPath,
    maskMetrics: maskValidation.metrics,
    aspectRatioNormalization: normalization,
    driftResult,
    model: getVertexImagenModel(),
    submittedAt,
    completedAt,
    maskGenerationDurationMs,
    vertexRenderDurationMs,
  };
}
