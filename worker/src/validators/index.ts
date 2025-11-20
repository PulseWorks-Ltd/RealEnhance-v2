import sharp from "sharp";
import { runGlobalEdgeMetrics } from "./globalStructuralValidator";
import { computeBrightnessDiff } from "./brightnessValidator";
import { StructuralMask, loadOrComputeStructuralMask } from "./structuralMask";
import { validateStage1BStructural } from "./stage1BValidator";
import { validateStage2Structural } from "./stage2StructuralValidator";

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
  context: { sceneType: "interior" | "exterior"; roomType?: string }
): Promise<ValidationResult> {
  const { fixedOutputPath, sizeMismatch } = await normalizeDimensions(basePath, outputPath);
  if (stage === "stage1A") return validateStage1A(basePath, fixedOutputPath, context, sizeMismatch);
  if (stage === "stage1B") return validateStage1B(basePath, fixedOutputPath, context, sizeMismatch);
  return validateStage2(basePath, fixedOutputPath, context, sizeMismatch);
}

// Export helpers for potential debugging / metrics collection.
export const _internal = { normalizeDimensions, aspectRatioApproximatelyEqual };
