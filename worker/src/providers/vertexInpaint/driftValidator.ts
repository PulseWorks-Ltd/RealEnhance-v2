import sharp from "sharp";
import type { OutsideMaskDriftMetrics, OutsideMaskDriftResult } from "./types";

// Ported near-verbatim from feature/vertex-secondary-inpainting-continuity's
// measureOutsideMaskDrift / validateOutsideMaskDrift
// (worker/src/providers/vertex/imageRendererProvider.ts:1259/1466) — this is
// the primary structural safety gate for this experimental path
// (VERTEX_INPAINTING_INVESTIGATION.md §13). Compares source vs. candidate
// pixel-for-pixel outside the mask (mask value < 128 = protected/outside).
// Thresholds reuse the continuity branch's defaults and are configurable via
// the same-shaped env vars.

function parseFiniteEnvNumber(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function resolveDriftThresholds(): { maxMae: number; maxChangedRatio: number; changeThreshold: number } {
  return {
    maxMae: parseFiniteEnvNumber("VERTEX_INPAINT_OUTSIDE_MASK_MAX_MAE", 6),
    maxChangedRatio: parseFiniteEnvNumber("VERTEX_INPAINT_OUTSIDE_MASK_MAX_CHANGED_RATIO", 0.035),
    changeThreshold: parseFiniteEnvNumber("VERTEX_INPAINT_OUTSIDE_MASK_CHANGE_THRESHOLD", 18),
  };
}

async function measureOutsideMaskDrift(params: {
  sourcePath: string;
  candidatePath: string;
  maskPath: string;
  changeThreshold: number;
}): Promise<OutsideMaskDriftMetrics> {
  const sourceMeta = await sharp(params.sourcePath).metadata();
  const width = Number(sourceMeta.width || 0);
  const height = Number(sourceMeta.height || 0);
  if (!width || !height) {
    throw new Error(`Unable to read source dimensions for outside-mask drift validation: ${params.sourcePath}`);
  }

  const [sourceRaw, candidateRaw, maskRaw] = await Promise.all([
    sharp(params.sourcePath).removeAlpha().resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(params.candidatePath).removeAlpha().resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 }).raw().toBuffer(),
    sharp(params.maskPath).removeAlpha().grayscale().resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest }).raw().toBuffer(),
  ]);

  let outsidePixelCount = 0;
  let changedPixelCount = 0;
  let deltaSum = 0;
  const threshold = Math.max(0, Number(params.changeThreshold));

  for (let index = 0; index < maskRaw.length; index += 1) {
    const maskValue = maskRaw[index] ?? 0;
    if (maskValue >= 128) continue; // inside the editable mask — not evaluated
    outsidePixelCount += 1;
    const offset = index * 3;
    const dr = Math.abs((sourceRaw[offset] ?? 0) - (candidateRaw[offset] ?? 0));
    const dg = Math.abs((sourceRaw[offset + 1] ?? 0) - (candidateRaw[offset + 1] ?? 0));
    const db = Math.abs((sourceRaw[offset + 2] ?? 0) - (candidateRaw[offset + 2] ?? 0));
    const meanDelta = (dr + dg + db) / 3;
    deltaSum += meanDelta;
    if (Math.max(dr, dg, db) >= threshold) {
      changedPixelCount += 1;
    }
  }

  const meanAbsoluteDelta = outsidePixelCount > 0 ? deltaSum / outsidePixelCount : 0;
  const changedPixelRatio = outsidePixelCount > 0 ? changedPixelCount / outsidePixelCount : 0;

  return {
    width,
    height,
    threshold,
    outsidePixelCount,
    changedPixelCount,
    meanAbsoluteDelta: Number(meanAbsoluteDelta.toFixed(4)),
    changedPixelRatio: Number(changedPixelRatio.toFixed(6)),
  };
}

export async function validateOutsideMaskDrift(params: {
  sourcePath: string;
  candidatePath: string;
  maskPath: string;
  jobId: string;
  imageId: string;
}): Promise<OutsideMaskDriftResult> {
  const thresholds = resolveDriftThresholds();
  const metrics = await measureOutsideMaskDrift({
    sourcePath: params.sourcePath,
    candidatePath: params.candidatePath,
    maskPath: params.maskPath,
    changeThreshold: thresholds.changeThreshold,
  });

  const exceedsMae = metrics.meanAbsoluteDelta > thresholds.maxMae;
  const exceedsChangedRatio = metrics.changedPixelRatio > thresholds.maxChangedRatio;
  const passed = !(exceedsMae || exceedsChangedRatio);

  console.log("[STAGE2_VERTEX_INPAINT] outside_mask_drift", {
    jobId: params.jobId,
    imageId: params.imageId,
    outsidePixelCount: metrics.outsidePixelCount,
    changedPixelCount: metrics.changedPixelCount,
    meanAbsoluteDelta: metrics.meanAbsoluteDelta,
    changedPixelRatio: metrics.changedPixelRatio,
    maxMae: thresholds.maxMae,
    maxChangedRatio: thresholds.maxChangedRatio,
    changeThreshold: thresholds.changeThreshold,
    status: passed ? "passed" : "failed",
  });

  return {
    passed,
    failureReason: passed
      ? null
      : `outside_mask_drift_exceeded: mae=${metrics.meanAbsoluteDelta} (max ${thresholds.maxMae}), changedRatio=${metrics.changedPixelRatio} (max ${thresholds.maxChangedRatio})`,
    metrics,
    maxMae: thresholds.maxMae,
    maxChangedRatio: thresholds.maxChangedRatio,
  };
}
