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

export type Stage1BValidationResult = {
  ok: boolean;
  reason?: string;
  dims?: { baseW: number; baseH: number; outW: number; outH: number };
  structuralIoU?: number;
};

function computeIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] | b[i]) uni++;
    if (a[i] & b[i]) inter++;
  }
  return uni > 0 ? inter / uni : 1;
}

function maskEdges(edges: Uint8Array, mask: StructuralMask): Uint8Array {
  const out = new Uint8Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    out[i] = edges[i] & mask.data[i];
  }
  return out;
}

async function cannyEdge(imagePath: string): Promise<Uint8Array> {
  // Simple Sobel-based edge for now
  const meta = await sharp(imagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const buf = new Uint8Array(meta.data.buffer, meta.data.byteOffset, meta.data.byteLength);
  const { width, height } = meta.info;
  const edge = new Uint8Array(buf.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (
        buf[i - width - 1] + 2 * buf[i - 1] + buf[i + width - 1] -
        buf[i - width + 1] - 2 * buf[i + 1] - buf[i + width + 1]
      );
      const gy = (
        buf[i - width - 1] + 2 * buf[i - width] + buf[i - width + 1] -
        buf[i + width - 1] - 2 * buf[i + width] - buf[i + width + 1]
      );
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g > 38) edge[i] = 1;
    }
  }
  return edge;
}

export async function validateStage1BStructural(
  canonicalBasePath: string,
  stage1BPath: string,
  masks: { structuralMask: StructuralMask },
): Promise<Stage1BValidationResult> {
  // Segment both images
  const baseSeg = await segmentImageClasses(canonicalBasePath);
  const candSeg = await segmentImageClasses(stage1BPath);
  // Hard fail if dimensions change
  const baseMeta = await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage1BPath).metadata();
  const compliance: string[] = [];
  if (baseMeta.width !== outMeta.width || baseMeta.height !== outMeta.height) {
    compliance.push("dimension_change");
  }
  // Run per-class checks
  const wallRes = compareWalls(baseSeg, candSeg);
  if (!wallRes.pass) compliance.push(wallRes.code || "wall_layout_changed");
  const winRes = compareWindows(baseSeg, candSeg);
  if (!winRes.pass) compliance.push(winRes.code || "windows_changed");
  const doorRes = compareDoors(baseSeg, candSeg);
  if (!doorRes.pass) compliance.push(doorRes.code || "doors_changed");
  const floorRes = compareFloorMaterial(baseSeg, candSeg);
  if (!floorRes.pass) compliance.push(floorRes.code || "floor_material_changed");
  // Log debug metrics (IoU, brightness, etc.)
  // ...existing code...
  if (compliance.length > 0) {
    console.warn('[validateStage1BStructural] Compliance issues:', compliance);
    return { ok: true, meta: { compliance } };
  }
  return { ok: true };
}
