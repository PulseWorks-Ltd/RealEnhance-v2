/**
 * Stage-Aware Structural Validator
 *
 * This module provides the core stage-aware validation logic:
 * - Stage1A baseline = Original
 * - Stage1B baseline = Stage1A output (declutter compares vs enhanced, NOT original)
 * - Stage2 baseline = Stage1A output (staging compares vs enhanced, NOT original)
 * - Stage-specific thresholds and edge modes
 * - Multi-signal gating (require >=2 independent triggers for risk)
 * - Proper IoU handling (no silent 0.000)
 */

import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  StageId,
  ValidationSummary,
  ValidationTrigger,
  ValidateParams,
  StageAwareConfig,
  loadStageAwareConfig,
  STAGE_THRESHOLDS,
  getStage2EdgeIouMin,
  Stage1AThresholds,
  Stage1BThresholds,
  Stage1BHardFailSwitches,
  Stage2Thresholds,
  HardFailSwitches,
} from "../stageAwareConfig";
import { loadOrComputeStructuralMask, StructuralMask } from "../structuralMask";
import { runLineGeometryCheck } from "./lineGeometryValidator";
import { runOpeningsIntegrityCheck } from "./openingsIntegrityValidator";
import { isEmptyRoomByEdgeDensity } from "../emptyRoomHeuristic";
import { getDimensionTolerancePct } from "../../utils/dimensionGuard";

type DimensionDecision = {
  mismatch: boolean;
  aspectRatioIn: number;
  aspectRatioOut: number;
  aspectRatioDelta: number;
  widthDeltaPct: number;
  heightDeltaPct: number;
  maxDimDeltaPct: number;
  strideAligned: boolean;
  classification: "match" | "fatal_aspect_ratio" | "fatal_large_delta" | "benign_resize" | "moderate_delta";
  fatal: boolean;
  shouldNormalize: boolean;
  skipAlignedComparisons: boolean;
  reason: string;
  nonBlocking: boolean;
};

function classifyDimensionChange(opts: {
  baseW: number;
  baseH: number;
  candW: number;
  candH: number;
  config: StageAwareConfig;
}): DimensionDecision {
  const { baseW, baseH, candW, candH, config } = opts;
  const mismatch = baseW !== candW || baseH !== candH;

  const aspectRatioIn = baseW / baseH;
  const aspectRatioOut = candW / candH;
  const aspectRatioDelta = Math.abs(aspectRatioIn - aspectRatioOut) / Math.max(Number.EPSILON, aspectRatioIn);

  const widthDeltaPct = Math.abs(candW - baseW) / Math.max(1, baseW);
  const heightDeltaPct = Math.abs(candH - baseH) / Math.max(1, baseH);
  const maxDimDeltaPct = Math.max(widthDeltaPct, heightDeltaPct);
  const strideAligned = candW % config.dimStrideMultiple === 0 && candH % config.dimStrideMultiple === 0;

  if (!mismatch) {
    return {
      mismatch: false,
      aspectRatioIn,
      aspectRatioOut,
      aspectRatioDelta,
      widthDeltaPct,
      heightDeltaPct,
      maxDimDeltaPct,
      strideAligned,
      classification: "match",
      fatal: false,
      shouldNormalize: false,
      skipAlignedComparisons: false,
      reason: "dimensions_match",
      nonBlocking: false,
    };
  }

  // Fatal when aspect ratio meaningfully changes
  if (aspectRatioDelta > config.dimAspectRatioTolerance) {
    return {
      mismatch: true,
      aspectRatioIn,
      aspectRatioOut,
      aspectRatioDelta,
      widthDeltaPct,
      heightDeltaPct,
      maxDimDeltaPct,
      strideAligned,
      classification: "fatal_aspect_ratio",
      fatal: true,
      shouldNormalize: false,
      skipAlignedComparisons: true,
      reason: "aspect_ratio_delta_exceeds_tolerance",
      nonBlocking: false,
    };
  }

  // Fatal when size delta is large even if aspect ratio is preserved
  if (maxDimDeltaPct > config.dimLargeDeltaPct) {
    return {
      mismatch: true,
      aspectRatioIn,
      aspectRatioOut,
      aspectRatioDelta,
      widthDeltaPct,
      heightDeltaPct,
      maxDimDeltaPct,
      strideAligned,
      classification: "fatal_large_delta",
      fatal: true,
      shouldNormalize: false,
      skipAlignedComparisons: true,
      reason: "dimension_delta_exceeds_large_threshold",
      nonBlocking: false,
    };
  }

  // Benign resize: aspect ratio preserved and delta small or stride-aligned
  if (maxDimDeltaPct <= config.dimSmallDeltaPct || strideAligned) {
    return {
      mismatch: true,
      aspectRatioIn,
      aspectRatioOut,
      aspectRatioDelta,
      widthDeltaPct,
      heightDeltaPct,
      maxDimDeltaPct,
      strideAligned,
      classification: "benign_resize",
      fatal: false,
      shouldNormalize: true,
      skipAlignedComparisons: false,
      reason: strideAligned ? "stride_aligned_resize" : "small_delta_resize",
      nonBlocking: true,
    };
  }

  // Moderate delta, aspect ratio preserved: warn/risk but do not hard fail
  return {
    mismatch: true,
    aspectRatioIn,
    aspectRatioOut,
    aspectRatioDelta,
    widthDeltaPct,
    heightDeltaPct,
    maxDimDeltaPct,
    strideAligned,
    classification: "moderate_delta",
    fatal: false,
    shouldNormalize: true,
    skipAlignedComparisons: false,
    reason: "moderate_delta_resize",
    nonBlocking: false,
  };
}

async function normalizeCandidateForAlignment(candidatePath: string, targetW: number, targetH: number, jobId?: string): Promise<string> {
  const parsed = path.parse(candidatePath);
  const outDir = process.env.STRUCT_DIM_NORMALIZE_DIR || os.tmpdir();
  const outPath = path.join(outDir, `${parsed.name}-${jobId || "job"}-${Date.now()}-dimnorm${parsed.ext || ".webp"}`);

  await sharp(candidatePath)
    .resize(targetW, targetH, { fit: "fill" })
    .toFile(outPath);

  return outPath;
}

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
  let skipEdgeIoUTriggers = false;
  let largeDrift = false;
  let maxDelta = 0;

  console.log(`[stageAware] blockOnDimensionMismatch=${config.blockOnDimensionMismatch ? "ENABLED" : "DISABLED (non-fatal)"}`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // ENV-CONFIGURABLE STAGE THRESHOLDS
  // ═══════════════════════════════════════════════════════════════════════════════
  // When STRUCT_VALIDATION_STAGE_AWARE=1, use env-configurable thresholds for all stages
  const stage1AThresholds = config.stage1AThresholds;
  const stage1BThresholds = config.stage1BThresholds;
  const stage1BHardFailSwitches = config.stage1BHardFailSwitches;
  const stage2Thresholds = config.stage2Thresholds;
  const hardFailSwitches = config.hardFailSwitches;
  const isStage2 = params.stage === "stage2";
  const isStage1A = params.stage === "stage1A";
  const isStage1B = params.stage === "stage1B";
  const stage2GateMinSignals = isStage2 ? Math.max(config.gateMinSignals, 3) : config.gateMinSignals;

  // Use env-configured thresholds for Stage 1A, 1B, and Stage 2
  const effectiveThresholds = {
    structuralMaskIouMin: isStage2
      ? stage2Thresholds.structIouMin
      : isStage1B
        ? stage1BThresholds.structIouMin
        : isStage1A
          ? stage1AThresholds.structIouMin
          : thresholds.structuralMaskIouMin,
    globalEdgeIouMin: isStage2
      ? stage2Thresholds.edgeIouMin
      : isStage1B
        ? stage1BThresholds.edgeIouMin
        : isStage1A
          ? stage1AThresholds.edgeIouMin
          : (thresholds.globalEdgeIouMin || 0.60),
    lineEdgeMin: isStage2
      ? stage2Thresholds.lineEdgeMin
      : isStage1B
        ? stage1BThresholds.lineEdgeMin
        : 0.70,
    unifiedMin: isStage2
      ? stage2Thresholds.unifiedMin
      : isStage1B
        ? stage1BThresholds.unifiedMin
        : 0.65,
    maskedDriftMax: isStage2
      ? stage2Thresholds.maskedDriftMax
      : isStage1B
        ? stage1BThresholds.maskedDriftMax
        : thresholds.maskedDriftMax,
    openingsCreateMax: isStage2
      ? stage2Thresholds.openingsCreateMax
      : isStage1B
        ? stage1BThresholds.openingsCreateMax
        : thresholds.openingsCreateMax || 0,
    openingsCloseMax: isStage2
      ? stage2Thresholds.openingsCloseMax
      : isStage1B
        ? stage1BThresholds.openingsCloseMax
        : thresholds.openingsCloseMax || 0,
  };

  // Effective hard-fail switches - use stage-specific for Stage 1B, global for Stage 2
  const effectiveHardFailSwitches: HardFailSwitches = isStage1B
    ? stage1BHardFailSwitches
    : hardFailSwitches;

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
  if (isStage1A) {
    console.log(`[stageAware] Stage1A Thresholds: edgeIouMin=${effectiveThresholds.globalEdgeIouMin}, structIouMin=${effectiveThresholds.structuralMaskIouMin}`);
  }
  if (isStage1B) {
    console.log(`[stageAware] Stage1B Thresholds: edgeIouMin=${effectiveThresholds.globalEdgeIouMin}, structIouMin=${effectiveThresholds.structuralMaskIouMin}, lineEdgeMin=${effectiveThresholds.lineEdgeMin}, unifiedMin=${effectiveThresholds.unifiedMin}`);
    console.log(`[stageAware] Stage1B Hard-fail switches: windowCount=${effectiveHardFailSwitches.blockOnWindowCountChange}, windowPos=${effectiveHardFailSwitches.blockOnWindowPositionChange}, openings=${effectiveHardFailSwitches.blockOnOpeningsDelta}`);
  }
  if (isStage2) {
    console.log(`[stageAware] Stage2 Thresholds: edgeIouMin=${effectiveThresholds.globalEdgeIouMin}, structIouMin=${effectiveThresholds.structuralMaskIouMin}, lineEdgeMin=${effectiveThresholds.lineEdgeMin}, unifiedMin=${effectiveThresholds.unifiedMin}`);
    console.log(`[stageAware] Hard-fail switches: windowCount=${effectiveHardFailSwitches.blockOnWindowCountChange}, windowPos=${effectiveHardFailSwitches.blockOnWindowPositionChange}, openings=${effectiveHardFailSwitches.blockOnOpeningsDelta}`);
  }

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
  const dimensionDecision = classifyDimensionChange({
    baseW: baseMeta.width,
    baseH: baseMeta.height,
    candW: candMeta.width,
    candH: candMeta.height,
    config,
  });

  debug.dimensionMismatch = dimensionDecision.mismatch;
  debug.dimensionReason = dimensionDecision.reason;
  debug.dimensionClassification = dimensionDecision.classification;
  debug.dimensionAspectRatioDelta = dimensionDecision.aspectRatioDelta;
  debug.dimensionMaxDeltaPct = dimensionDecision.maxDimDeltaPct;
  debug.dimensionStrideAligned = dimensionDecision.strideAligned;

  metrics.dimensionAspectRatioDelta = dimensionDecision.aspectRatioDelta;
  metrics.dimensionWidthDeltaPct = dimensionDecision.widthDeltaPct;
  metrics.dimensionHeightDeltaPct = dimensionDecision.heightDeltaPct;
  metrics.dimensionMaxDeltaPct = dimensionDecision.maxDimDeltaPct;
  metrics.dimensionStrideAligned = dimensionDecision.strideAligned ? 1 : 0;

  let candidatePathForAlignment = params.candidatePath;
  let candWidth = candMeta.width!;
  let candHeight = candMeta.height!;
  let alignmentBlocked = dimensionDecision.skipAlignedComparisons;

  if (dimensionDecision.shouldNormalize && dimensionDecision.mismatch) {
    try {
      candidatePathForAlignment = await normalizeCandidateForAlignment(params.candidatePath, baseMeta.width!, baseMeta.height!, params.jobId);
      candWidth = baseMeta.width!;
      candHeight = baseMeta.height!;
      metrics.dimensionNormalized = 1;
      debug.dimensionNormalizedPath = candidatePathForAlignment;
    } catch (err) {
      alignmentBlocked = true;
      console.warn(`[stageAware] Failed to normalize candidate for alignment:`, err);
    }
  }

  // Compute dimension deltas for large-drift regime (Stage1B/Stage2 only)
  const widthDelta = dimensionDecision.widthDeltaPct;
  const heightDelta = dimensionDecision.heightDeltaPct;
  maxDelta = dimensionDecision.maxDimDeltaPct;

  if (params.dimContext) {
    debug.originalDims = {
      base: { w: params.dimContext.baseline.width, h: params.dimContext.baseline.height },
      candidate: { w: params.dimContext.candidateOriginal.width, h: params.dimContext.candidateOriginal.height },
      wasNormalized: params.dimContext.wasNormalized,
      maxDelta: params.dimContext.maxDelta,
    };
    console.log(`[stageAware] DimContext provided: base=${params.dimContext.baseline.width}x${params.dimContext.baseline.height} candOrig=${params.dimContext.candidateOriginal.width}x${params.dimContext.candidateOriginal.height} maxDelta=${params.dimContext.maxDelta.toFixed(4)} wasNormalized=${params.dimContext.wasNormalized ? "yes" : "no"}`);
  }

  const dimTolerance = getDimensionTolerancePct();
  const driftDecision = computeLargeDriftFlag({
    stage: params.stage,
    dimContext: params.dimContext,
    computedMaxDelta: maxDelta,
    tolerance: dimTolerance,
    largeDriftIouSignalOnly: config.largeDriftIouSignalOnly,
  });
  const effectiveMaxDelta = driftDecision.effectiveMaxDelta;
  largeDrift = driftDecision.largeDrift;
  maxDelta = effectiveMaxDelta;

  // ===== 2. DIMENSION MISMATCH HANDLING (STAGE-AWARE) =====
  if (dimensionDecision.mismatch) {
    console.warn(`[stageAware] Dimension mismatch: base=${baseMeta.width}x${baseMeta.height}, cand=${candMeta.width}x${candMeta.height} classification=${dimensionDecision.classification}`);
    triggers.push({
      id: dimensionDecision.classification === "fatal_aspect_ratio" ? "dimension_aspect_ratio_mismatch" : "dimension_mismatch",
      message: `Dimensions changed: ${candMeta.width}x${candMeta.height} -> ${baseMeta.width}x${baseMeta.height}; ${dimensionDecision.reason}`,
      value: Number(dimensionDecision.maxDimDeltaPct.toFixed(4)),
      threshold: dimensionDecision.fatal ? Math.max(config.dimLargeDeltaPct, config.dimAspectRatioTolerance) : config.dimSmallDeltaPct,
      stage: params.stage,
      fatal: dimensionDecision.fatal && config.blockOnDimensionMismatch,
      nonBlocking: dimensionDecision.nonBlocking,
      meta: {
        aspectRatioDelta: dimensionDecision.aspectRatioDelta,
        widthDeltaPct: widthDelta,
        heightDeltaPct: heightDelta,
        strideAligned: dimensionDecision.strideAligned,
        classification: dimensionDecision.classification,
      },
    });
  }

  // ===== 3. LOAD/COMPUTE STRUCTURAL MASKS =====
  const jobId = params.jobId || "default";
  let maskBaseline: StructuralMask;
  let maskCandidate: StructuralMask;
  const maskCandidateKey = `${jobId}-cand${dimensionDecision.shouldNormalize && dimensionDecision.mismatch ? "-norm" : ""}`;

  try {
    [maskBaseline, maskCandidate] = await Promise.all([
      loadOrComputeStructuralMask(jobId + "-base", params.baselinePath),
      loadOrComputeStructuralMask(maskCandidateKey, candidatePathForAlignment),
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

  // ===== 4.5 LOW-EDGE HEURISTIC (skip noisy edge checks on nearly empty scenes) =====
  // Only applies to stages that run staging/declutter (1B/2) to avoid altering Stage1A behavior.
  if (config.lowEdgeEnable && !alignmentBlocked && (isStage1B || isStage2)) {
    try {
      const lowEdge = await isEmptyRoomByEdgeDensity(candidatePathForAlignment, {
        edgeDensityMax: config.lowEdgeEdgeDensityMax,
        centerCropRatio: config.lowEdgeCenterCropRatio,
      });

      metrics.edgeDensity = lowEdge.edgeDensity;
      debug.lowEdgeDetected = lowEdge.empty;
      debug.lowEdgeThreshold = lowEdge.threshold;

      if (lowEdge.empty && config.lowEdgeSkipEdgeIoU) {
        skipEdgeIoUTriggers = true;
        console.log(`[stageAware] Low-edge scene detected (edgeDensity=${lowEdge.edgeDensity.toFixed(4)} <= ${lowEdge.threshold}); skipping edge IoU triggers`);
      }
    } catch (err) {
      console.warn(`[stageAware] Low-edge heuristic error (non-fatal):`, err);
    }
  }

  // ===== 5. COMPUTE STRUCTURAL MASK IoU (if valid) =====
  let structuralIoU: number | null = null;

  if (alignmentBlocked) {
    debug.structuralIoUSkipped = true;
    debug.structuralIoUSkipReason = "dimension_alignment_blocked";
    console.warn(`[stageAware] Skipping structural IoU: dimension alignment blocked`);
  } else if (debug.maskARatio < config.iouMinPixelsRatio || debug.maskBRatio < config.iouMinPixelsRatio) {
    debug.structuralIoUSkipped = true;
    debug.structuralIoUSkipReason = "mask_too_small";
    console.warn(`[stageAware] Skipping structural IoU: mask too small (A=${(debug.maskARatio * 100).toFixed(2)}%, B=${(debug.maskBRatio * 100).toFixed(2)}%)`);
  } else {
    // Load grayscale images and compute edges
    try {
      const [baseRaw, candRaw] = await Promise.all([
        sharp(params.baselinePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
        sharp(candidatePathForAlignment).greyscale().raw().toBuffer({ resolveWithObject: true }),
      ]);

      const baseGray = new Uint8Array(baseRaw.data.buffer, baseRaw.data.byteOffset, baseRaw.data.byteLength);
      const candGray = new Uint8Array(candRaw.data.buffer, candRaw.data.byteOffset, candRaw.data.byteLength);

      const edgeThreshold = Number(process.env.STRUCT_EDGE_THRESHOLD || 50);
      const baseEdge = sobelBinary(baseGray, baseMeta.width, baseMeta.height, edgeThreshold);
      const candEdge = sobelBinary(candGray, candWidth, candHeight, edgeThreshold);

      const iouResult = computeMaskedIoU(baseEdge, candEdge, maskBaseline.data);
      debug.intersectionPixels = iouResult.inter;
      debug.unionPixels = iouResult.uni;

      if (iouResult.value !== null) {
        structuralIoU = iouResult.value;
        metrics.structuralIoU = structuralIoU;
        console.log(`[stageAware] Structural IoU (masked): ${structuralIoU.toFixed(3)} (inter=${iouResult.inter}, union=${iouResult.uni})`);

        if (structuralIoU < effectiveThresholds.structuralMaskIouMin) {
          triggers.push({
            id: "structural_mask_iou",
            message: `Structural mask IoU too low: ${structuralIoU.toFixed(3)} < ${effectiveThresholds.structuralMaskIouMin}`,
            value: structuralIoU,
            threshold: effectiveThresholds.structuralMaskIouMin,
            stage: params.stage,
            fatal: isStage2,
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
  if (!alignmentBlocked) {
    try {
      const [baseRaw, candRaw] = await Promise.all([
        sharp(params.baselinePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
        sharp(candidatePathForAlignment).greyscale().raw().toBuffer({ resolveWithObject: true }),
      ]);

      const baseGray = new Uint8Array(baseRaw.data.buffer, baseRaw.data.byteOffset, baseRaw.data.byteLength);
      const candGray = new Uint8Array(candRaw.data.buffer, candRaw.data.byteOffset, candRaw.data.byteLength);

      const edgeThreshold = Number(process.env.STRUCT_EDGE_THRESHOLD || 50);
      const baseEdge = sobelBinary(baseGray, baseMeta.width, baseMeta.height, edgeThreshold);
      const candEdge = sobelBinary(candGray, candWidth, candHeight, edgeThreshold);

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
          if (!skipEdgeIoUTriggers && edgeIoU < edgeThresholdValue) {
            triggers.push({
              id: "edge_iou",
              message: `Edge IoU (${edgeMode}) too low: ${edgeIoU.toFixed(3)} < ${edgeThresholdValue}`,
              value: edgeIoU,
              threshold: edgeThresholdValue,
              stage: params.stage,
              fatal: isStage2,
            });
          } else if (skipEdgeIoUTriggers) {
            console.log(`[stageAware] Edge IoU trigger suppressed due to low-edge scene (edgeIoU=${edgeIoU.toFixed(3)})`);
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

          if (!skipEdgeIoUTriggers && edgeIoU < edgeThresholdValue) {
            triggers.push({
              id: "global_edge_iou",
              message: `Global edge IoU too low: ${edgeIoU.toFixed(3)} < ${edgeThresholdValue}`,
              value: edgeIoU,
              threshold: edgeThresholdValue,
              stage: params.stage,
            });
          } else if (skipEdgeIoUTriggers) {
            console.log(`[stageAware] Global edge IoU trigger suppressed due to low-edge scene (edgeIoU=${edgeIoU.toFixed(3)})`);
          }
        }
      }
    } catch (err) {
      console.error(`[stageAware] Error computing edge IoU:`, err);
    }
  }

  // ===== 6.5 HARD-FAIL SWITCH CHECKS (Stage2 only) =====
  // These run window/opening detection and add FATAL triggers when switches enabled
  if (isStage2 && !alignmentBlocked) {
    try {
      const { validateWindows } = await import("../windowValidator.js");
      const windowResult = await validateWindows(params.baselinePath, candidatePathForAlignment);

      // Add window validation metrics to debug
      if (windowResult) {
        metrics.windowValidationPassed = windowResult.ok ? 1 : 0;

        if (!windowResult.ok && windowResult.reason) {
          // Check if hard-fail switch is enabled
          if (windowResult.reason === "window_count_change" && effectiveHardFailSwitches.blockOnWindowCountChange) {
            triggers.push({
              id: "window_count_change",
              message: `Window count changed (hard-fail enabled)`,
              value: 1,
              threshold: 0,
              stage: params.stage,
              fatal: true, // Bypasses multi-signal gating
            });
            console.log(`[stageAware] FATAL: Window count change detected (blockOnWindowCountChange=true)`);
          } else if (windowResult.reason === "window_position_change" && effectiveHardFailSwitches.blockOnWindowPositionChange) {
            triggers.push({
              id: "window_position_change",
              message: `Window position changed significantly (hard-fail enabled)`,
              value: 1,
              threshold: 0,
              stage: params.stage,
              fatal: true,
            });
            console.log(`[stageAware] FATAL: Window position change detected (blockOnWindowPositionChange=true)`);
          } else if (!windowResult.ok) {
            // Non-fatal window issue - add as regular trigger
            const nonBlocking = windowResult.reason === "window_position_change" && !effectiveHardFailSwitches.blockOnWindowPositionChange;
            triggers.push({
              id: windowResult.reason || "window_change",
              message: `Window validation failed: ${windowResult.reason}`,
              value: 1,
              threshold: 0,
              stage: params.stage,
              nonBlocking,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[stageAware] Window validation error (non-fatal):`, err);
    }

    // Check for openings delta using semantic validator
    try {
      const { runSemanticStructureValidator } = await import("../semanticStructureValidator.js");
      const semanticResult = await runSemanticStructureValidator({
        originalImagePath: params.baselinePath,
        enhancedImagePath: candidatePathForAlignment,
        scene: params.sceneType || "interior",
        mode: "log",
      });

      if (semanticResult) {
        const openingsDelta = semanticResult.openings.created + semanticResult.openings.closed;
        metrics.openingsCreated = semanticResult.openings.created;
        metrics.openingsClosed = semanticResult.openings.closed;

        if (openingsDelta > 0 && effectiveHardFailSwitches.blockOnOpeningsDelta) {
          triggers.push({
            id: "openings_delta",
            message: `Openings changed: +${semanticResult.openings.created} created, -${semanticResult.openings.closed} closed (hard-fail enabled)`,
            value: openingsDelta,
            threshold: 0,
            stage: params.stage,
            fatal: true,
          });
          console.log(`[stageAware] FATAL: Openings delta detected (blockOnOpeningsDelta=true)`);
        } else if (openingsDelta > 0) {
          // Non-fatal openings change - add as regular trigger
          triggers.push({
            id: "openings_delta",
            message: `Openings changed: +${semanticResult.openings.created} created, -${semanticResult.openings.closed} closed`,
            value: openingsDelta,
            threshold: 0,
            stage: params.stage,
            nonBlocking: true,
          });
        }
      }
    } catch (err) {
      console.warn(`[stageAware] Semantic structure validation error (non-fatal):`, err);
    }
  }

  // ===== 6.6 PAINT-OVER DETECTION (Stage2 only) =====
  if (params.stage === "stage2" && config.paintOverEnable && !alignmentBlocked) {
    try {
      const { runPaintOverCheck } = await import("./paintOverDetector.js");
      const paintOverResult = await runPaintOverCheck({
        baselinePath: params.baselinePath,
        candidatePath: candidatePathForAlignment,
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

  // ===== 6.7 LINE GEOMETRY (Stage1B/Stage2) =====
  if ((isStage1B || isStage2) && !alignmentBlocked) {
    try {
      const lineResult = await runLineGeometryCheck({
        baselinePath: params.baselinePath,
        candidatePath: candidatePathForAlignment,
        stage: params.stage,
        threshold: effectiveThresholds.lineEdgeMin,
        maskBaseline,
        maskCandidate,
        jobId: params.jobId,
      });

      if (lineResult.metrics.lineScore !== undefined) {
        metrics.lineScore = lineResult.metrics.lineScore;
        metrics.edgeLoss = lineResult.metrics.edgeLoss;
      }

      if (lineResult.triggers.length) {
        triggers.push(...lineResult.triggers);
      }
    } catch (err) {
      console.warn(`[stageAware] Line geometry validation error (non-fatal):`, err);
    }
  }

  // ===== 6.8 OPENINGS INTEGRITY (Stage1B/Stage2) =====
  if ((isStage1B || isStage2) && !alignmentBlocked) {
    try {
      const openingsResult = await runOpeningsIntegrityCheck({
        baselinePath: params.baselinePath,
        candidatePath: candidatePathForAlignment,
        stage: params.stage,
        scene: params.sceneType || "interior",
        thresholds: {
          createMax: effectiveThresholds.openingsCreateMax ?? 0,
          closeMax: effectiveThresholds.openingsCloseMax ?? 0,
          maskedDriftMax: effectiveThresholds.maskedDriftMax ?? thresholds.maskedDriftMax,
          openingsMinDelta: isStage2 ? stage2Thresholds.openingsMinDelta : 1,
        },
        fatalOnOpeningsDelta: effectiveHardFailSwitches.blockOnOpeningsDelta,
      });

      if (openingsResult.metrics.openingsCreated !== undefined) {
        metrics.openingsCreated = openingsResult.metrics.openingsCreated;
      }
      if (openingsResult.metrics.openingsClosed !== undefined) {
        metrics.openingsClosed = openingsResult.metrics.openingsClosed;
      }
      if (openingsResult.metrics.maskedEdgeDrift !== undefined) {
        metrics.maskedEdgeDrift = openingsResult.metrics.maskedEdgeDrift;
      }

      if (openingsResult.triggers.length) {
        triggers.push(...openingsResult.triggers);
      }
    } catch (err) {
      console.warn(`[stageAware] Openings integrity validation error (non-fatal):`, err);
    }
  }

  // ===== 6.9 NORMALIZE NON-BLOCKING TRIGGERS BASED ON SWITCHES =====
  // Ensure gate counting ignores signals explicitly marked non-blocking via config switches.
  for (const t of triggers) {
    if (t.id === "window_position_change" && !effectiveHardFailSwitches.blockOnWindowPositionChange) {
      t.nonBlocking = true;
    }

    if (isStage2 && (t.id === "masked_edge_drift" || t.id === "openings_created_maskededge" || t.id === "openings_closed_maskededge")) {
      t.nonBlocking = true;
    }

    if (
      (t.id === "openings_delta" || t.id === "openings_created_maskededge" || t.id === "openings_closed_maskededge") &&
      !effectiveHardFailSwitches.blockOnOpeningsDelta
    ) {
      t.nonBlocking = true;
    }

    if (isStage2) {
      const fatalWhitelist = new Set([
        "dimension_aspect_ratio_mismatch",
        "dimension_mismatch",
        "invalid_dimensions",
        "mask_error",
        "metadata_error",
        "structural_mask_iou",
        "edge_iou",
      ]);

      if (t.fatal && !fatalWhitelist.has(t.id)) {
        t.fatal = false;
        t.nonBlocking = true;
      }
    }
  }

  // ===== 7. MULTI-SIGNAL GATING (with fatal bypass + large-drift regime) =====
  const decision = evaluateRiskWithLargeDrift({
    triggers,
    gateMinSignals: stage2GateMinSignals,
    largeDrift,
    largeDriftIouSignalOnly: config.largeDriftIouSignalOnly,
    largeDriftRequireNonIouSignals: config.largeDriftRequireNonIouSignals,
  });

  const risk = decision.risk;
  const hasFatalTrigger = decision.hasFatal;
  const passed = !risk || mode === "log";
  const gateEligibleTriggers = triggers.filter(t => !t.nonBlocking);

  console.log(`[stageAware] Triggers: ${triggers.length} (gateEligible: ${gateEligibleTriggers.length}, gate: ${stage2GateMinSignals}, hasFatal: ${hasFatalTrigger})`);
  triggers.forEach((t, i) => console.log(`[stageAware]   ${i + 1}. ${t.id}${t.fatal ? " [FATAL]" : ""}: ${t.message}`));
  console.log(`[stageAware] Risk: ${risk ? "YES" : "NO"}${hasFatalTrigger ? " (FATAL BYPASS)" : ""} reason=${decision.reason}`);
  console.log(`[stageAware] Passed: ${passed ? "YES" : "NO"}`);

  // ===== 7.5 CONCISE FAILURE LOG (single-line summary for monitoring) =====
  if (risk) {
    const fatalIds = triggers.filter(t => t.fatal).map(t => t.id);
    const nonFatalIds = triggers.filter(t => !t.fatal).map(t => t.id);
    const metricsStr = Object.entries(metrics)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(3) : v}`)
      .join(" ");

    if (isStage2) {
      const windowLike = triggers.filter(t => t.id.startsWith("window") || t.id.includes("openings"));
      const maskedDriftVal = metrics.maskedEdgeDrift;
      const maskedDriftThresh = (effectiveThresholds.maskedDriftMax ?? thresholds.maskedDriftMax)?.toFixed(3);
      console.log(
        `[stageAware][stage2] block_detail reason=${decision.reason} fatal=${hasFatalTrigger} ` +
        `window_openings=[${windowLike.map(t => t.id).join(",")}] ` +
        `masked_edge_drift=${maskedDriftVal !== undefined ? maskedDriftVal.toFixed(3) : "n/a"}` +
        `${maskedDriftThresh ? "/" + maskedDriftThresh : ""} ` +
        `iouOnly=${countIouTriggers(gateEligibleTriggers) > 0 && countNonIouTriggers(gateEligibleTriggers) === 0}`
      );
    }

    // Single-line structured log for easy parsing/alerting
    console.log(
      `[STRUCT_FAIL] stage=${params.stage} mode=${mode} ` +
      `fatal=[${fatalIds.join(",")}] triggers=[${nonFatalIds.join(",")}] ` +
      `largeDrift=${largeDrift} maxDelta=${maxDelta?.toFixed(4)} tol=${dimTolerance?.toFixed(4)} ` +
      `iouTriggers=${countIouTriggers(gateEligibleTriggers)} nonIouTriggers=${countNonIouTriggers(gateEligibleTriggers)} ` +
      `reason=${decision.reason} ` +
      `${metricsStr} jobId=${params.jobId || "unknown"}`
    );
  }

  // ===== 8. COMPUTE AGGREGATE SCORE =====
  let score = 1.0;
  const weights = { structuralIoU: 0.35, edgeIoU: 0.25, globalEdgeIoU: 0.25, lineScore: 0.15 } as const;
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

// Helper: classify triggers and decide risk under large-drift regime (exported for tests)
export function evaluateRiskWithLargeDrift(opts: {
  triggers: ValidationTrigger[];
  gateMinSignals: number;
  largeDrift: boolean;
  largeDriftIouSignalOnly: boolean;
  largeDriftRequireNonIouSignals: boolean;
}): { risk: boolean; hasFatal: boolean; reason: string; gateCount: number } {
  const { triggers, gateMinSignals, largeDrift, largeDriftIouSignalOnly, largeDriftRequireNonIouSignals } = opts;

  const fatal = triggers.filter(t => t.fatal);
  const gateTriggers = triggers.filter(t => !t.nonBlocking);
  const iou = gateTriggers.filter(isIouTrigger);
  const nonIou = gateTriggers.filter(t => !isIouTrigger(t) && !t.fatal);

  if (!largeDrift || !largeDriftIouSignalOnly) {
    const risk = fatal.length > 0 || gateTriggers.length >= gateMinSignals;
    return {
      risk,
      hasFatal: fatal.length > 0,
      reason: risk ? (fatal.length ? "fatal" : `gate>=${gateMinSignals}`) : "pass-normal",
      gateCount: gateTriggers.length,
    };
  }

  // Large drift regime: IoU triggers are signal-only
  if (fatal.length > 0) {
    return { risk: true, hasFatal: true, reason: `fatal=${fatal.map(t => t.id).join(",")}`, gateCount: gateTriggers.length };
  }

  if (largeDriftRequireNonIouSignals) {
    if (nonIou.length >= 1 && iou.length >= 1) {
      return { risk: true, hasFatal: false, reason: "iou+nonIou", gateCount: gateTriggers.length };
    }
    if (nonIou.length >= 2) {
      return { risk: true, hasFatal: false, reason: ">=2 nonIou", gateCount: gateTriggers.length };
    }
    return { risk: false, hasFatal: false, reason: "largeDrift-iou-only", gateCount: gateTriggers.length };
  }

  // If non-IoU requirement disabled, fall back to gateMinSignals using gate-eligible triggers
  const risk = gateTriggers.length >= gateMinSignals;
  return {
    risk,
    hasFatal: false,
    reason: risk ? `gate>=${gateMinSignals}` : "largeDrift-pass",
    gateCount: gateTriggers.length,
  };
}

function isIouTrigger(t: ValidationTrigger): boolean {
  return t.id === "edge_iou" || t.id === "global_edge_iou" || t.id === "structural_mask_iou" || t.id === "unified_iou";
}

function countIouTriggers(triggers: ValidationTrigger[]): number {
  return triggers.filter(isIouTrigger).length;
}

function countNonIouTriggers(triggers: ValidationTrigger[]): number {
  return triggers.filter(t => !isIouTrigger(t) && !t.fatal).length;
}

// Helper: choose maxDelta source and compute large-drift flag (exported for tests)
export function computeLargeDriftFlag(opts: {
  stage: StageId;
  dimContext?: ValidateParams["dimContext"];
  computedMaxDelta: number;
  tolerance: number;
  largeDriftIouSignalOnly: boolean;
}): { largeDrift: boolean; effectiveMaxDelta: number } {
  const effectiveMaxDelta = opts.dimContext?.maxDelta ?? opts.computedMaxDelta;
  const applies = (opts.stage === "stage1B" || opts.stage === "stage2") && opts.largeDriftIouSignalOnly;
  const largeDrift = applies && effectiveMaxDelta > opts.tolerance;
  return { largeDrift, effectiveMaxDelta };
}
