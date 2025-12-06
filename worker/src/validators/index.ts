import sharp from "sharp";
import { runGlobalEdgeMetrics } from "./globalStructuralValidator";
import { computeBrightnessDiff } from "./brightnessValidator";
import { StructuralMask, loadOrComputeStructuralMask } from "./structuralMask";
import { validateStage1BStructural } from "./stage1BValidator";
import { validateStage2Structural } from "./stage2StructuralValidator";
import {
  getValidatorMode,
  isValidatorEnabled,
  shouldValidatorBlock,
  isLogOnlyMode,
  ValidatorMode,
} from "./validatorMode";

// OpenCV-based structural validator
import { validateStructureWithOpenCV } from "../ai/validators/structural-opencv";

/**
 * Wrapper to run OpenCV-based structural validation.
 * Accepts image buffer and options, returns validation result.
 */
export async function runOpenCVStructuralValidator(imageBuffer: Buffer, opts?: { strict?: boolean }) {
  return await validateStructureWithOpenCV(imageBuffer, opts);
}

export type StageName = "stage1A" | "stage1B" | "stage2";

export type ValidationResult = {
  ok: boolean;
  reason?: string; // structural_change | dimension_change | validator_error
  details?: Record<string, unknown>;
  mode?: ValidatorMode; // The mode used for this validation
  blocked?: boolean; // true if validation blocked the image
};

type NormalizeResult = {
  fixedOutputPath: string;
  sizeMismatch: boolean; // true if original dimensions differed (even if auto-fixed)
};

async function normalizeDimensions(basePath: string, outputPath: string): Promise<NormalizeResult> {
  try {
    const [baseMeta, outMeta] = await Promise.all([
      sharp(basePath).metadata(),
      sharp(outputPath).metadata(),
    ]);
    if (!baseMeta.width || !baseMeta.height || !outMeta.width || !outMeta.height) {
      return { fixedOutputPath: outputPath, sizeMismatch: true };
    }
    const baseW = baseMeta.width; const baseH = baseMeta.height;
    const outW = outMeta.width; const outH = outMeta.height;
    if (baseW === outW && baseH === outH) {
      return { fixedOutputPath: outputPath, sizeMismatch: false };
    }
    const baseAspect = baseW / baseH;
    const outAspect = outW / outH;
    const aspectDelta = Math.abs(baseAspect - outAspect) / baseAspect;
    // If aspect nearly matches, auto-resize to canonical with minimal crop.
    if (aspectDelta < 0.005) {
      const fixedPath = outputPath.replace(/\.webp$/i, "-resized.webp");
      await sharp(outputPath)
        .resize(baseW, baseH, { fit: "cover", position: "centre" })
        .toFile(fixedPath);
      return { fixedOutputPath: fixedPath, sizeMismatch: true };
    }
    // Aspect changed meaningfully – caller decides if fatal.
    return { fixedOutputPath: outputPath, sizeMismatch: true };
  } catch (e) {
    console.error("[validator] normalizeDimensions error", e);
    return { fixedOutputPath: outputPath, sizeMismatch: true };
  }
}

async function aspectRatioApproximatelyEqual(basePath: string, outPath: string): Promise<boolean> {
  try {
    const [baseMeta, outMeta] = await Promise.all([
      sharp(basePath).metadata(),
      sharp(outPath).metadata(),
    ]);
    if (!baseMeta.width || !baseMeta.height || !outMeta.width || !outMeta.height) return false;
    const baseAspect = baseMeta.width / baseMeta.height;
    const outAspect = outMeta.width / outMeta.height;
    const delta = Math.abs(baseAspect - outAspect) / baseAspect;
    return delta < 0.005;
  } catch {
    return false;
  }
}

async function computeEdgeIoU(basePath: string, outputPath: string): Promise<number> {
  const m = await runGlobalEdgeMetrics(basePath, outputPath);
  return m.edgeIoU;
}

async function computeStructuralEdgeIoU(basePath: string, outputPath: string): Promise<number> {
  const mask = await loadOrComputeStructuralMask("default", basePath);
  const verdict = await validateStage2Structural(basePath, outputPath, { structuralMask: mask });
  return verdict.structuralIoU ?? 0;
}

async function validateStage1A(basePath: string, outputPath: string, context: any, sizeMismatch: boolean): Promise<ValidationResult> {
  if (sizeMismatch) {
    const aspectOk = await aspectRatioApproximatelyEqual(basePath, outputPath);
    if (!aspectOk) {
      return { ok: false, reason: "dimension_change", details: { stage: "stage1A" } };
    }
  }
  let edgeIoU: number; let brightnessDiff: number;
  try {
    edgeIoU = await computeEdgeIoU(basePath, outputPath);
    brightnessDiff = await computeBrightnessDiff(basePath, outputPath);
  } catch (e) {
    return { ok: false, reason: "validator_error", details: { error: (e as any)?.message } };
  }
  const MIN_EDGE_IOU = Number(process.env.STAGE1A_MIN_EDGE_IOU || 0.65);
  if (edgeIoU < MIN_EDGE_IOU) {
    return { ok: false, reason: "structural_change", details: { edgeIoU, brightnessDiff } };
  }
  return { ok: true, details: { edgeIoU, brightnessDiff, sizeMismatch } };
}

async function validateStage1B(basePath: string, outputPath: string, context: any, sizeMismatch: boolean): Promise<ValidationResult> {
  if (sizeMismatch) {
    const aspectOk = await aspectRatioApproximatelyEqual(basePath, outputPath);
    if (!aspectOk) {
      return { ok: false, reason: "dimension_change", details: { stage: "stage1B" } };
    }
  }
  let mask: StructuralMask;
  try {
    mask = await loadOrComputeStructuralMask(context.jobId || "default", basePath);
    const verdict = await validateStage1BStructural(basePath, outputPath, { structuralMask: mask });
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason || "structural_change", details: { structIoU: verdict.structuralIoU } };
    }
    return { ok: true, details: { structIoU: verdict.structuralIoU, sizeMismatch } };
  } catch (e) {
    return { ok: false, reason: "validator_error", details: { error: (e as any)?.message } };
  }
}

async function validateStage2(basePath: string, outputPath: string, context: any, sizeMismatch: boolean): Promise<ValidationResult> {
  if (sizeMismatch) {
    const aspectOk = await aspectRatioApproximatelyEqual(basePath, outputPath);
    if (!aspectOk) {
      console.warn('[stage2] Validator: dimension_change detected, but not blocking.');
      // Do not block, continue validation and allow result
    }
  }
  let mask: StructuralMask;
  try {
    mask = await loadOrComputeStructuralMask(context.jobId || "default", basePath);
    const verdict = await validateStage2Structural(basePath, outputPath, { structuralMask: mask });
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason || "structural_change", details: { structIoU: verdict.structuralIoU } };
    }
    return { ok: true, details: { structIoU: verdict.structuralIoU, sizeMismatch } };
  } catch (e) {
    return { ok: false, reason: "validator_error", details: { error: (e as any)?.message } };
  }
}

export async function validateStageOutput(
  stage: StageName,
  basePath: string,
  outputPath: string,
  context: { sceneType: "interior" | "exterior"; roomType?: string; jobId?: string }
): Promise<ValidationResult> {
  const mode = getValidatorMode("structure");

  // Check if validator is enabled
  if (!isValidatorEnabled("structure")) {
    console.log(`[validator:${stage}] Structural validator disabled (mode=off)`);
    return {
      ok: true,
      reason: "validator_disabled",
      mode,
      blocked: false,
      details: { stage, sceneType: context.sceneType },
    };
  }

  console.log(`[validator:${stage}] Running structural validation (mode=${mode}, scene=${context.sceneType})`);

  const { fixedOutputPath, sizeMismatch } = await normalizeDimensions(basePath, outputPath);

  let result: ValidationResult;
  if (stage === "stage1A") {
    result = await validateStage1A(basePath, fixedOutputPath, context, sizeMismatch);
  } else if (stage === "stage1B") {
    result = await validateStage1B(basePath, fixedOutputPath, context, sizeMismatch);
  } else {
    result = await validateStage2(basePath, fixedOutputPath, context, sizeMismatch);
  }

  // Attach mode info
  result.mode = mode;

  // Log validation result
  console.log(`[validator:${stage}] === Validation Result ===`);
  console.log(`[validator:${stage}] Stage: ${stage}`);
  console.log(`[validator:${stage}] Scene: ${context.sceneType}`);
  console.log(`[validator:${stage}] Mode: ${mode}`);
  console.log(`[validator:${stage}] OK: ${result.ok}`);
  if (result.reason) {
    console.log(`[validator:${stage}] Reason: ${result.reason}`);
  }
  if (result.details) {
    console.log(`[validator:${stage}] Details: ${JSON.stringify(result.details, null, 2)}`);
  }

  // Determine if we should block based on mode
  const shouldBlock = !result.ok && shouldValidatorBlock("structure");
  result.blocked = shouldBlock;

  if (!result.ok && isLogOnlyMode("structure")) {
    console.warn(`[validator:${stage}] ⚠️ Validation failed but not blocking (log-only mode)`);
    console.warn(`[validator:${stage}] Failure reason: ${result.reason}`);
    // Override to ok=true in log-only mode so the image continues
    result.ok = true;
  } else if (shouldBlock) {
    console.error(`[validator:${stage}] ❌ Validation failed - BLOCKING image`);
  } else if (result.ok) {
    console.log(`[validator:${stage}] ✓ Validation passed`);
  }

  console.log(`[validator:${stage}] =======================`);

  return result;
}

// Export unified validation pipeline
export {
  runUnifiedValidation,
  logUnifiedValidationCompact,
  type UnifiedValidationResult,
  type UnifiedValidationParams,
  type ValidatorResult,
} from "./runValidation";

// Export helpers for potential debugging / metrics collection.
export const _internal = { normalizeDimensions, aspectRatioApproximatelyEqual };
