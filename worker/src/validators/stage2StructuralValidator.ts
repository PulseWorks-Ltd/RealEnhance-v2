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

function iouMasked(a: Uint8Array, b: Uint8Array, mask: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue; // only consider structural regions
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av & bv) inter++;
    if (av | bv) uni++;
  }
  return uni > 0 ? inter / uni : 1;
}

export type Stage2ValidationResult = {
  ok: boolean;
  reason?: string;
  dims?: { baseW: number; baseH: number; outW: number; outH: number };
  structuralIoU?: number;
};

export async function validateStage2Structural(
  canonicalBasePath: string,
  stage2Path: string,
  masks: { structuralMask: StructuralMask },
): Promise<Stage2ValidationResult> {
  // Segment both images
  const baseSeg = await segmentImageClasses(canonicalBasePath);
  const candSeg = await segmentImageClasses(stage2Path);
  // Dimension change check: log but do not block
  const baseMeta = await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage2Path).metadata();
  if (baseMeta.width !== outMeta.width || baseMeta.height !== outMeta.height) {
    console.warn('[stage2] Structural validator verdict: { ok: false, reason: "dimension_change" }');
    // Do not block, continue validation
  }
  // Run per-class checks
  const wallRes = compareWalls(baseSeg, candSeg);
  if (!wallRes.pass) return { ok: false, reason: wallRes.code || "wall_layout_changed" };
  const winRes = compareWindows(baseSeg, candSeg);
  if (!winRes.pass) return { ok: false, reason: winRes.code || "windows_changed" };
  const doorRes = compareDoors(baseSeg, candSeg);
  if (!doorRes.pass) return { ok: false, reason: doorRes.code || "doors_changed" };
  const floorRes = compareFloorMaterial(baseSeg, candSeg);
  if (!floorRes.pass) return { ok: false, reason: floorRes.code || "floor_material_changed" };
  const grassRes = compareGrassConcrete(baseSeg, candSeg);
  if (!grassRes.pass) return { ok: false, reason: grassRes.code || "grass_to_concrete" };
  const driveRes = compareDrivewayPresence(baseSeg, candSeg);
  if (!driveRes.pass) return { ok: false, reason: driveRes.code || "driveway_changed" };
  const carRes = compareVehicles(baseSeg, candSeg);
  if (!carRes.pass) return { ok: false, reason: carRes.code || "vehicle_changed" };
  // Log debug metrics (IoU, brightness, etc.)
  // ...existing code...
  return { ok: true };
}
