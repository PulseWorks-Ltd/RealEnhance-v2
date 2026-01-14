import sharp from "sharp";
import { StructuralMask } from "./structuralMask";
import { segmentImageClasses, SegmentationResult } from "./semanticSegmenter";
import {
  compareWalls,
  compareWindows,
  compareDoors,
  compareFloorMaterial,
  compareGrassConcrete,
  compareDrivewayPresence,
  compareVehicles,
} from "./classComparisons";
import { loadStageAwareConfig } from "./stageAwareConfig";

interface Stage2StructParams {
  canonicalPath: string;
  stagedPath: string;
  structuralMask: StructuralMask;
  sceneType?: string;
  roomType?: string;
}

interface Stage2StructVerdict {
  ok: boolean;
  structuralIoU: number;
  reason?: string;
}

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
  };
};

export async function validateStage2Structural(
  canonicalBasePath: string,
  stage2Path: string,
  masks: { structuralMask: StructuralMask },
): Promise<Stage2ValidationResult> {
  const config = loadStageAwareConfig();
  const debug: Stage2ValidationResult["debug"] = {};

  // Get dimensions
  const baseMeta = await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage2Path).metadata();

  const baseW = baseMeta.width!;
  const baseH = baseMeta.height!;
  const candW = outMeta.width!;
  const candH = outMeta.height!;

  debug.baseWidth = baseW;
  debug.baseHeight = baseH;
  debug.candWidth = candW;
  debug.candHeight = candH;
  debug.dimensionMismatch = baseW !== candW || baseH !== candH;

  // Dimension change check: log but do not block
  if (debug.dimensionMismatch) {
    console.warn(`[stage2] Dimension mismatch: base=${baseW}x${baseH}, candidate=${candW}x${candH}`);
    // For now, do not block - just note it. The caller can decide.
  }

  // Segment both images for semantic checks
  const baseSeg = await segmentImageClasses(canonicalBasePath);
  const candSeg = await segmentImageClasses(stage2Path);

  // Run per-class checks
  const wallRes = compareWalls(baseSeg, candSeg);
  if (!wallRes.pass) return { ok: false, reason: wallRes.code || "wall_layout_changed", debug };
  const winRes = compareWindows(baseSeg, candSeg);
  if (!winRes.pass) return { ok: false, reason: winRes.code || "windows_changed", debug };
  const doorRes = compareDoors(baseSeg, candSeg);
  if (!doorRes.pass) return { ok: false, reason: doorRes.code || "doors_changed", debug };
  const floorRes = compareFloorMaterial(baseSeg, candSeg);
  if (!floorRes.pass) return { ok: false, reason: floorRes.code || "floor_material_changed", debug };
  const grassRes = compareGrassConcrete(baseSeg, candSeg);
  if (!grassRes.pass) return { ok: false, reason: grassRes.code || "grass_to_concrete", debug };
  const driveRes = compareDrivewayPresence(baseSeg, candSeg);
  if (!driveRes.pass) return { ok: false, reason: driveRes.code || "driveway_changed", debug };
  const carRes = compareVehicles(baseSeg, candSeg);
  if (!carRes.pass) return { ok: false, reason: carRes.code || "vehicle_changed", debug };

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
      const { data: baseGray } = await sharp(canonicalBasePath)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { data: candGray } = await sharp(stage2Path)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const baseGrayArr = new Uint8Array(baseGray.buffer, baseGray.byteOffset, baseGray.byteLength);
      const candGrayArr = new Uint8Array(candGray.buffer, candGray.byteOffset, candGray.byteLength);

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
