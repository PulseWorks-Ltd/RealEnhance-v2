import sharp from "sharp";
import { StructuralMask } from "./structuralMask";
import { loadStageAwareConfig } from "./stageAwareConfig";
import { normalizeImagePairForValidator } from "./dimensionUtils";

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
 * IoU result with explicit handling for edge cases
 */
interface IoUMaskedResult {
  value: number | null;
  skipReason?: "union_zero" | "mask_too_small";
  intersectionPixels: number;
  unionPixels: number;
  maskPixels: number;
}

/**
 * Compute IoU between two edge maps within a structural mask region.
 * Handles edge cases properly instead of silently returning 0.
 */
function iouMasked(a: Uint8Array, b: Uint8Array, mask: Uint8Array): IoUMaskedResult {
  let inter = 0, uni = 0, maskPixels = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue; // only consider structural regions
    maskPixels++;
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av & bv) inter++;
    if (av | bv) uni++;
  }

  // Handle union=0 case: if neither image has edges in the mask region,
  // return null with explicit reason (not a meaningful comparison)
  if (uni === 0) {
    return {
      value: null,
      skipReason: "union_zero",
      intersectionPixels: inter,
      unionPixels: uni,
      maskPixels,
    };
  }

  return {
    value: inter / uni,
    intersectionPixels: inter,
    unionPixels: uni,
    maskPixels,
  };
}

export type Stage2ValidationResult = {
  ok: boolean;
  reason?: string;
  dims?: { baseW: number; baseH: number; outW: number; outH: number };
  structuralIoU?: number;
  /** If structuralIoU is null/undefined, explains why */
  structuralIoUSkipReason?: string;
  /** Debug metrics for logging/diagnosis */
  debug?: {
    intersectionPixels?: number;
    unionPixels?: number;
    maskPixels?: number;
    baseWidth?: number;
    baseHeight?: number;
    candWidth?: number;
    candHeight?: number;
    dimensionMismatch?: boolean;
    dimensionNormalized?: boolean;
    /**
     * H3 (RealEnhance audit): always true. The per-class structural
     * comparison this validator used to attempt (walls/windows/doors/
     * floor/grass/driveway/vehicles) was never actually implemented — see
     * the comment above the IoU computation below and
     * validators/_unimplemented/README.md. This field exists so a caller
     * or log reader can tell, from the result object itself, that no
     * per-class check occurred — the ok:true / lack of a `reason` here
     * does not mean per-class structural integrity was verified.
     */
    perClassStructuralComparisonUnimplemented?: boolean;
  };
};

export async function validateStage2Structural(
  canonicalBasePath: string,
  stage2Path: string,
  masks: { structuralMask: StructuralMask },
  buffers?: { baseGray: Uint8Array; candGray: Uint8Array; width: number; height: number },
  options?: { dimensionTolerance?: number }
): Promise<Stage2ValidationResult> {
  const config = loadStageAwareConfig();
  const debug: Stage2ValidationResult["debug"] = {};

  const dimNormalized = await normalizeImagePairForValidator({
    basePath: canonicalBasePath,
    candidatePath: stage2Path,
    tolerance: options?.dimensionTolerance,
  });

  debug.dimensionNormalized = dimNormalized.normalized;

  let baselinePath = dimNormalized.normalized ? dimNormalized.basePath : canonicalBasePath;
  let candidatePath = dimNormalized.normalized ? dimNormalized.candidatePath : stage2Path;

  const baseMeta = dimNormalized.normalized
    ? ({ width: dimNormalized.width, height: dimNormalized.height } as sharp.Metadata)
    : await sharp(canonicalBasePath).metadata();
  const outMeta = dimNormalized.normalized
    ? ({ width: dimNormalized.width, height: dimNormalized.height } as sharp.Metadata)
    : await sharp(stage2Path).metadata();

  const baseW = baseMeta.width!;
  const baseH = baseMeta.height!;
  const candW = outMeta.width!;
  const candH = outMeta.height!;

  debug.baseWidth = baseW;
  debug.baseHeight = baseH;
  debug.candWidth = candW;
  debug.candHeight = candH;
  const dimsMatch = baseW === candW && baseH === candH;
  debug.dimensionMismatch = !dimsMatch;

  if (dimNormalized.normalized) {
    const logFn = dimNormalized.severity === "warn" ? console.warn : console.log;
    logFn(
      `[VALIDATOR][DIM_NORMALIZE] stage=stage2 job=unknown baseline=${dimNormalized.baseOrig?.width || "?"}x${dimNormalized.baseOrig?.height || "?"} candidate=${dimNormalized.candidateOrig?.width || "?"}x${dimNormalized.candidateOrig?.height || "?"} normalized=${dimNormalized.width}x${dimNormalized.height} method=${dimNormalized.method} severity=${dimNormalized.severity}`
    );
  } else if (!dimsMatch) {
    console.warn(
      `[VALIDATOR][DIM_NORMALIZE] stage=stage2 job=unknown baseline=${baseW}x${baseH} candidate=${candW}x${candH} normalized=${dimNormalized.width}x${dimNormalized.height} method=${dimNormalized.method} severity=warn`
    );
  }

  if (!dimsMatch) {
    console.warn(`[stage2] Dimension mismatch (post-normalization attempt): base=${baseW}x${baseH}, candidate=${candW}x${candH}`);
  }

  // H3 (RealEnhance audit): per-class structural comparison (walls/windows/
  // doors/floor/grass/driveway/vehicles) used to run here via
  // segmentImageClasses + classComparisons. It was never actually
  // implemented: segmentImageClasses (validators/_unimplemented/
  // semanticSegmenter.ts) is a stub that always returns zero masks, and
  // every comparator in classComparisons.ts was hardcoded
  // `return {pass:true}` — so none of the `if (!xRes.pass) return
  // {ok:false,...}` branches that used to sit here could ever fire,
  // regardless of real image content. Removed rather than left calling
  // code that could only ever report success (see
  // validators/_unimplemented/README.md for the quarantined originals).
  // The REAL structural protection this function provides — the edge/IoU
  // computation immediately below — does not depend on segmentation and is
  // unchanged by this removal.
  debug.perClassStructuralComparisonUnimplemented = true;

  // ===== COMPUTE STRUCTURAL IoU (CRITICAL FIX) =====
  // This was missing before, causing structuralIoU to always be 0.000

  let structuralIoU: number | undefined = undefined;
  let structuralIoUSkipReason: string | undefined = undefined;

  try {
    // Check mask pixel ratio - skip if mask is too small
    const totalPixels = masks.structuralMask.width * masks.structuralMask.height;
    let maskPixelCount = 0;
    for (let i = 0; i < masks.structuralMask.data.length; i++) {
      if (masks.structuralMask.data[i]) maskPixelCount++;
    }
    const maskRatio = maskPixelCount / totalPixels;
    debug.maskPixels = maskPixelCount;

    if (maskRatio < config.iouMinPixelsRatio) {
      console.warn(`[stage2] Structural mask too small (${(maskRatio * 100).toFixed(2)}% < ${(config.iouMinPixelsRatio * 100).toFixed(2)}%) - skipping IoU`);
      structuralIoUSkipReason = "mask_too_small";
    } else if (debug.dimensionMismatch) {
      // Cannot compute IoU with mismatched dimensions without resizing
      console.warn(`[stage2] Dimension mismatch - skipping IoU computation`);
      structuralIoUSkipReason = "dimension_mismatch";
    } else {
      // Compute edge maps for both images
      let baseGrayArr: Uint8Array;
      let candGrayArr: Uint8Array;
      if (buffers && buffers.width === baseW && buffers.height === baseH) {
        baseGrayArr = buffers.baseGray;
        candGrayArr = buffers.candGray;
      } else {
        const { data: baseGray } = await sharp(baselinePath)
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const { data: candGray } = await sharp(candidatePath)
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true });

        baseGrayArr = new Uint8Array(baseGray.buffer, baseGray.byteOffset, baseGray.byteLength);
        candGrayArr = new Uint8Array(candGray.buffer, candGray.byteOffset, candGray.byteLength);
      }

      // Sobel edge threshold
      const edgeThreshold = Number(process.env.STAGE2_STRUCT_EDGE_THRESHOLD || 50);

      const baseEdge = sobelBinary(baseGrayArr, baseW, baseH, edgeThreshold);
      const candEdge = sobelBinary(candGrayArr, candW, candH, edgeThreshold);

      // Compute masked IoU
      const iouResult = iouMasked(baseEdge, candEdge, masks.structuralMask.data);

      debug.intersectionPixels = iouResult.intersectionPixels;
      debug.unionPixels = iouResult.unionPixels;
      debug.maskPixels = iouResult.maskPixels;

      if (iouResult.value !== null) {
        structuralIoU = iouResult.value;
        console.log(`[stage2] Structural IoU (masked): ${structuralIoU.toFixed(3)} (inter=${iouResult.intersectionPixels}, union=${iouResult.unionPixels})`);
      } else {
        structuralIoUSkipReason = iouResult.skipReason || "union_zero";
        console.warn(`[stage2] Structural IoU skipped: ${structuralIoUSkipReason} (inter=${iouResult.intersectionPixels}, union=${iouResult.unionPixels})`);
      }
    }
  } catch (err) {
    console.error(`[stage2] Error computing structural IoU:`, err);
    structuralIoUSkipReason = "computation_error";
  }

  return {
    ok: true,
    structuralIoU,
    structuralIoUSkipReason,
    debug,
  };
}
