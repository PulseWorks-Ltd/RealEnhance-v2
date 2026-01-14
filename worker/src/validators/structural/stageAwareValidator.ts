/**
 * Stage-Aware Structural Validator
 *
 * This module provides the core stage-aware validation logic:
 * - Stage1A baseline = Original
 * - Stage2 baseline = Stage1A output (NOT original)
 * - Stage-specific thresholds and edge modes
 * - Multi-signal gating (require >=2 independent triggers for risk)
 * - Proper IoU handling (no silent 0.000)
 */

import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import {
  StageId,
  ValidationSummary,
  ValidationTrigger,
  ValidateParams,
  StageAwareConfig,
  loadStageAwareConfig,
  STAGE_THRESHOLDS,
  getStage2EdgeIouMin,
} from "../stageAwareConfig";
import { loadOrComputeStructuralMask, StructuralMask } from "../structuralMask";
import { runGlobalEdgeMetrics } from "../globalStructuralValidator";

/**
 * Sobel edge detection with binary threshold
 */
function sobelBinary(data: Uint8Array, width: number, height: number, threshold: number): Uint8Array {
  const edge = new Uint8Array(data.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (
        data[i - width - 1] + 2 * data[i - 1] + data[i + width - 1] -
        data[i - width + 1] - 2 * data[i + 1] - data[i + width + 1]
      );
      const gy = (
        data[i - width - 1] + 2 * data[i - width] + data[i - width + 1] -
        data[i + width - 1] - 2 * data[i + width] - data[i + width + 1]
      );
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g > threshold) edge[i] = 1;
    }
  }
  return edge;
}

/**
 * Compute IoU between two binary edge maps
 */
function computeIoU(a: Uint8Array, b: Uint8Array): { value: number | null; inter: number; uni: number } {
  let inter = 0, uni = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av & bv) inter++;
    if (av | bv) uni++;
  }

  if (uni === 0) {
    return { value: null, inter, uni };
  }
  return { value: inter / uni, inter, uni };
}

/**
 * Compute IoU within a structural mask region only
 */
function computeMaskedIoU(a: Uint8Array, b: Uint8Array, mask: Uint8Array): { value: number | null; inter: number; uni: number; maskPixels: number } {
  let inter = 0, uni = 0, maskPixels = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    maskPixels++;
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av & bv) inter++;
    if (av | bv) uni++;
  }

  if (uni === 0) {
    return { value: null, inter, uni, maskPixels };
  }
  return { value: inter / uni, inter, uni, maskPixels };
}

/**
 * Compute IoU excluding bottom X% of image (for Stage2 furniture filtering)
 */
function computeExcludeLowerIoU(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  excludePct: number
): { value: number | null; inter: number; uni: number } {
  const excludeRows = Math.floor(height * excludePct);
  const effectiveHeight = height - excludeRows;

  let inter = 0, uni = 0;
  for (let y = 0; y < effectiveHeight; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const av = a[i] ? 1 : 0;
      const bv = b[i] ? 1 : 0;
      if (av & bv) inter++;
      if (av | bv) uni++;
    }
  }

  if (uni === 0) {
    return { value: null, inter, uni };
  }
  return { value: inter / uni, inter, uni };
}

/**
 * Compute IoU within dilated structural mask (structure_only mode)
 */
function computeStructureOnlyIoU(
  baseEdge: Uint8Array,
  candEdge: Uint8Array,
  mask: StructuralMask
): { value: number | null; inter: number; uni: number; maskPixels: number } {
  // Dilate mask slightly to include edges around structural elements
  const { width, height, data: maskData } = mask;
  const dilated = new Uint8Array(maskData.length);

  // 3x3 dilation
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      let on = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (maskData[(y + dy) * width + (x + dx)]) {
            on = 1;
            break;
          }
        }
        if (on) break;
      }
      if (on) dilated[i] = 1;
    }
  }

  return computeMaskedIoU(baseEdge, candEdge, dilated);
}

/**
 * Count nonzero pixels in a buffer
 */
function countNonzero(data: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i]) count++;
  }
  return count;
}

/**
 * Build a failed summary (for early error exits)
 */
function buildFailedSummary(stage: StageId, reason: string, mode: "log" | "block"): ValidationSummary {
  return {
    stage,
    mode,
    passed: mode === "log", // In log mode, always pass
    risk: true,
    score: 0,
    triggers: [{ id: reason, message: reason, value: 0, threshold: 0, stage }],
    metrics: {},
    debug: {
      dimsBaseline: { w: 0, h: 0 },
      dimsCandidate: { w: 0, h: 0 },
      dimensionMismatch: false,
      maskAPixels: 0,
      maskBPixels: 0,
      maskARatio: 0,
      maskBRatio: 0,
    },
  };
}

/**
 * Main stage-aware structural validation function
 *
 * IMPORTANT: Baselines must be set correctly by caller:
 * - Stage1A: baselinePath = original image
 * - Stage2: baselinePath = Stage1A output (NOT original!)
 */
export async function validateStructureStageAware(params: ValidateParams): Promise<ValidationSummary> {
  const config = params.config || loadStageAwareConfig();
  const thresholds = STAGE_THRESHOLDS[params.stage === "stage1B" ? "stage1A" : params.stage];
  const mode = params.mode || "log";
  const triggers: ValidationTrigger[] = [];
  const metrics: ValidationSummary["metrics"] = {};

  const debug: ValidationSummary["debug"] = {
    dimsBaseline: { w: 0, h: 0 },
    dimsCandidate: { w: 0, h: 0 },
    dimensionMismatch: false,
    maskAPixels: 0,
    maskBPixels: 0,
    maskARatio: 0,
    maskBRatio: 0,
    baselineUrl: params.baselinePath,
    candidateUrl: params.candidatePath,
  };

  console.log(`[stageAware] === Stage-Aware Validation (${params.stage}) ===`);
  console.log(`[stageAware] Baseline: ${params.baselinePath}`);
  console.log(`[stageAware] Candidate: ${params.candidatePath}`);
  console.log(`[stageAware] Mode: ${mode}`);

  // ===== 1. LOAD AND VERIFY DIMENSIONS =====
  let baseMeta: sharp.Metadata;
  let candMeta: sharp.Metadata;

  try {
    [baseMeta, candMeta] = await Promise.all([
      sharp(params.baselinePath).metadata(),
      sharp(params.candidatePath).metadata(),
    ]);
  } catch (err) {
    console.error(`[stageAware] Error loading image metadata:`, err);
    return buildFailedSummary(params.stage, "metadata_error", mode);
  }

  if (!baseMeta.width || !baseMeta.height || !candMeta.width || !candMeta.height) {
    console.error(`[stageAware] Invalid image dimensions`);
    return buildFailedSummary(params.stage, "invalid_dimensions", mode);
  }

  debug.dimsBaseline = { w: baseMeta.width, h: baseMeta.height };
  debug.dimsCandidate = { w: candMeta.width, h: candMeta.height };
  debug.dimensionMismatch = baseMeta.width !== candMeta.width || baseMeta.height !== candMeta.height;

  // ===== 2. DIMENSION MISMATCH HANDLING =====
  // Per spec: treat dimension mismatch as a trigger, do NOT auto-resize
  if (debug.dimensionMismatch) {
    console.warn(`[stageAware] Dimension mismatch: base=${baseMeta.width}x${baseMeta.height}, cand=${candMeta.width}x${candMeta.height}`);
    triggers.push({
      id: "dimension_mismatch",
      message: `Dimensions changed: ${candMeta.width}x${candMeta.height} vs expected ${baseMeta.width}x${baseMeta.height}`,
      value: 1,
      threshold: 0,
      stage: params.stage,
    });
  }

  // ===== 3. LOAD/COMPUTE STRUCTURAL MASKS =====
  const jobId = params.jobId || "default";
  let maskBaseline: StructuralMask;
  let maskCandidate: StructuralMask;

  try {
    [maskBaseline, maskCandidate] = await Promise.all([
      loadOrComputeStructuralMask(jobId + "-base", params.baselinePath),
      loadOrComputeStructuralMask(jobId + "-cand", params.candidatePath),
    ]);
  } catch (err) {
    console.error(`[stageAware] Error computing structural masks:`, err);
    return buildFailedSummary(params.stage, "mask_error", mode);
  }

  // ===== 4. COMPUTE MASK PIXEL RATIOS =====
  const totalPixelsBase = maskBaseline.width * maskBaseline.height;
  const totalPixelsCand = maskCandidate.width * maskCandidate.height;

  const maskAPixels = countNonzero(maskBaseline.data);
  const maskBPixels = countNonzero(maskCandidate.data);

  debug.maskAPixels = maskAPixels;
  debug.maskBPixels = maskBPixels;
  debug.maskARatio = maskAPixels / totalPixelsBase;
  debug.maskBRatio = maskBPixels / totalPixelsCand;

  console.log(`[stageAware] Mask A: ${maskAPixels} pixels (${(debug.maskARatio * 100).toFixed(2)}%)`);
  console.log(`[stageAware] Mask B: ${maskBPixels} pixels (${(debug.maskBRatio * 100).toFixed(2)}%)`);

  // ===== 5. COMPUTE STRUCTURAL MASK IoU (if valid) =====
  let structuralIoU: number | null = null;

  if (debug.dimensionMismatch) {
    debug.structuralIoUSkipped = true;
    debug.structuralIoUSkipReason = "dimension_mismatch";
    console.warn(`[stageAware] Skipping structural IoU: dimension mismatch`);
  } else if (debug.maskARatio < config.iouMinPixelsRatio || debug.maskBRatio < config.iouMinPixelsRatio) {
    debug.structuralIoUSkipped = true;
    debug.structuralIoUSkipReason = "mask_too_small";
    console.warn(`[stageAware] Skipping structural IoU: mask too small (A=${(debug.maskARatio * 100).toFixed(2)}%, B=${(debug.maskBRatio * 100).toFixed(2)}%)`);
  } else {
    // Load grayscale images and compute edges
    try {
      const [baseRaw, candRaw] = await Promise.all([
        sharp(params.baselinePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
        sharp(params.candidatePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
      ]);

      const baseGray = new Uint8Array(baseRaw.data.buffer, baseRaw.data.byteOffset, baseRaw.data.byteLength);
      const candGray = new Uint8Array(candRaw.data.buffer, candRaw.data.byteOffset, candRaw.data.byteLength);

      const edgeThreshold = Number(process.env.STRUCT_EDGE_THRESHOLD || 50);
      const baseEdge = sobelBinary(baseGray, baseMeta.width, baseMeta.height, edgeThreshold);
      const candEdge = sobelBinary(candGray, candMeta.width, candMeta.height, edgeThreshold);

      const iouResult = computeMaskedIoU(baseEdge, candEdge, maskBaseline.data);
      debug.intersectionPixels = iouResult.inter;
      debug.unionPixels = iouResult.uni;

      if (iouResult.value !== null) {
        structuralIoU = iouResult.value;
        metrics.structuralIoU = structuralIoU;
        console.log(`[stageAware] Structural IoU (masked): ${structuralIoU.toFixed(3)} (inter=${iouResult.inter}, union=${iouResult.uni})`);

        if (structuralIoU < thresholds.structuralMaskIouMin) {
          triggers.push({
            id: "structural_mask_iou",
            message: `Structural mask IoU too low: ${structuralIoU.toFixed(3)} < ${thresholds.structuralMaskIouMin}`,
            value: structuralIoU,
            threshold: thresholds.structuralMaskIouMin,
            stage: params.stage,
          });
        }
      } else {
        debug.structuralIoUSkipped = true;
        debug.structuralIoUSkipReason = "union_zero";
        console.warn(`[stageAware] Structural IoU skipped: union=0`);
      }
    } catch (err) {
      console.error(`[stageAware] Error computing structural IoU:`, err);
      debug.structuralIoUSkipped = true;
      debug.structuralIoUSkipReason = "computation_error";
    }
  }

  // ===== 6. COMPUTE EDGE IoU (stage-specific mode) =====
  if (!debug.dimensionMismatch) {
    try {
      const [baseRaw, candRaw] = await Promise.all([
        sharp(params.baselinePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
        sharp(params.candidatePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
      ]);

      const baseGray = new Uint8Array(baseRaw.data.buffer, baseRaw.data.byteOffset, baseRaw.data.byteLength);
      const candGray = new Uint8Array(candRaw.data.buffer, candRaw.data.byteOffset, candRaw.data.byteLength);

      const edgeThreshold = Number(process.env.STRUCT_EDGE_THRESHOLD || 50);
      const baseEdge = sobelBinary(baseGray, baseMeta.width, baseMeta.height, edgeThreshold);
      const candEdge = sobelBinary(candGray, candMeta.width, candMeta.height, edgeThreshold);

      let edgeIoU: number | null = null;
      let edgeThresholdValue: number;

      if (params.stage === "stage2") {
        // Stage2: use stage-specific edge mode
        const edgeMode = config.stage2EdgeMode;
        debug.edgeMode = edgeMode;
        edgeThresholdValue = getStage2EdgeIouMin(edgeMode);

        if (edgeMode === "exclude_lower") {
          debug.excludedLowerPct = config.stage2ExcludeLowerPct;
          const result = computeExcludeLowerIoU(
            baseEdge,
            candEdge,
            baseMeta.width,
            baseMeta.height,
            config.stage2ExcludeLowerPct
          );
          edgeIoU = result.value;
          console.log(`[stageAware] Edge IoU (exclude_lower ${(config.stage2ExcludeLowerPct * 100).toFixed(0)}%): ${edgeIoU?.toFixed(3) || "null"}`);
        } else if (edgeMode === "structure_only") {
          const result = computeStructureOnlyIoU(baseEdge, candEdge, maskBaseline);
          edgeIoU = result.value;
          console.log(`[stageAware] Edge IoU (structure_only): ${edgeIoU?.toFixed(3) || "null"}`);
        } else {
          // global mode
          const result = computeIoU(baseEdge, candEdge);
          edgeIoU = result.value;
          console.log(`[stageAware] Edge IoU (global): ${edgeIoU?.toFixed(3) || "null"}`);
        }

        if (edgeIoU !== null) {
          metrics.edgeIoU = edgeIoU;
          if (edgeIoU < edgeThresholdValue) {
            triggers.push({
              id: "edge_iou",
              message: `Edge IoU (${edgeMode}) too low: ${edgeIoU.toFixed(3)} < ${edgeThresholdValue}`,
              value: edgeIoU,
              threshold: edgeThresholdValue,
              stage: params.stage,
            });
          }
        }
      } else {
        // Stage1A/1B: use global edge IoU
        edgeThresholdValue = thresholds.globalEdgeIouMin || 0.60;

        const result = computeIoU(baseEdge, candEdge);
        edgeIoU = result.value;

        if (edgeIoU !== null) {
          metrics.globalEdgeIoU = edgeIoU;
          console.log(`[stageAware] Global Edge IoU: ${edgeIoU.toFixed(3)} (threshold: ${edgeThresholdValue})`);

          if (edgeIoU < edgeThresholdValue) {
            triggers.push({
              id: "global_edge_iou",
              message: `Global edge IoU too low: ${edgeIoU.toFixed(3)} < ${edgeThresholdValue}`,
              value: edgeIoU,
              threshold: edgeThresholdValue,
              stage: params.stage,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[stageAware] Error computing edge IoU:`, err);
    }
  }

  // ===== 6.5 PAINT-OVER DETECTION (Stage2 only) =====
  if (params.stage === "stage2" && config.paintOverEnable && !debug.dimensionMismatch) {
    try {
      const { runPaintOverCheck } = await import("./paintOverDetector.js");
      const paintOverResult = await runPaintOverCheck({
        baselinePath: params.baselinePath,
        candidatePath: params.candidatePath,
        config,
        jobId: params.jobId,
      });

      // Add paint-over triggers
      if (paintOverResult?.triggers?.length) {
        for (const t of paintOverResult.triggers) {
          triggers.push(t);
          if (t.fatal) {
            console.error(`[stageAware] FATAL paint-over detected: ${t.message}`);
          }
        }
      }

      // Log debug artifacts
      if (paintOverResult?.debugArtifacts?.length) {
        console.log(`[stageAware] Paint-over debug artifacts: ${paintOverResult.debugArtifacts.join(", ")}`);
      }
    } catch (err) {
      console.error(`[stageAware] Error in paint-over detection:`, err);
    }
  }

  // ===== 7. MULTI-SIGNAL GATING (with fatal bypass) =====
  const hasFatalTrigger = triggers.some(t => t.fatal === true);
  const risk = hasFatalTrigger || triggers.length >= config.gateMinSignals;
  const passed = !risk || mode === "log";

  console.log(`[stageAware] Triggers: ${triggers.length} (gate: ${config.gateMinSignals}, hasFatal: ${hasFatalTrigger})`);
  triggers.forEach((t, i) => console.log(`[stageAware]   ${i + 1}. ${t.id}${t.fatal ? " [FATAL]" : ""}: ${t.message}`));
  console.log(`[stageAware] Risk: ${risk ? "YES" : "NO"}${hasFatalTrigger ? " (FATAL BYPASS)" : ""}`);
  console.log(`[stageAware] Passed: ${passed ? "YES" : "NO"}`);

  // ===== 8. COMPUTE AGGREGATE SCORE =====
  let score = 1.0;
  const weights = { structuralIoU: 0.4, edgeIoU: 0.3, globalEdgeIoU: 0.3 };
  let weightSum = 0;
  let total = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const value = metrics[key as keyof typeof metrics];
    if (value !== undefined && value !== null) {
      total += value * weight;
      weightSum += weight;
    }
  }

  if (weightSum > 0) {
    score = total / weightSum;
  }

  // ===== 9. LOG DEBUG ARTIFACTS (if enabled and risk detected) =====
  if (risk && config.logArtifactsOnFail) {
    try {
      const artifactDir = process.env.STRUCT_DEBUG_DIR || "/tmp";
      const prefix = `${artifactDir}/struct-${params.jobId || Date.now()}`;

      console.log(`[stageAware] Saving debug artifacts to ${prefix}-*.json`);

      await fs.writeFile(
        `${prefix}-summary.json`,
        JSON.stringify({ params, triggers, metrics, debug, risk, passed, score }, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.warn(`[stageAware] Failed to save debug artifacts:`, err);
    }
  }

  console.log(`[stageAware] ===============================`);

  return {
    stage: params.stage,
    mode,
    passed,
    risk,
    score,
    triggers,
    metrics,
    debug,
  };
}

/**
 * Export for use by other modules
 */
export { loadStageAwareConfig, STAGE_THRESHOLDS, getStage2EdgeIouMin };
