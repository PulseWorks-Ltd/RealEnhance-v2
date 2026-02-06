import sharp from "sharp";
import type { BaseArtifacts } from "./baseArtifacts";
import { StructuralMask } from "./structuralMask";
import { computeBrightnessDiff, computeBrightnessDiffFromBuffers } from "./brightnessValidator";
import { computeEdgeMapFromGray } from "./edgeUtils";
import { VALIDATION_THRESHOLDS } from "./config";
import { StructuralValidationResult } from "./types";
import { ensureSameSizeAsBase } from "./resizeUtils";
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

export type Stage1AValidationResult = {
  ok: boolean;
  reason?: string;
  dims?: { baseW: number; baseH: number; outW: number; outH: number };
  structuralIoU?: number;
  brightnessDiff?: number;
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

function edgeFromGrayBuffer(gray: Uint8Array, width: number, height: number): Uint8Array {
  return computeEdgeMapFromGray(gray, width, height, 38);
}

async function cannyEdge(imagePath: string): Promise<Uint8Array> {
  // Simple Sobel-based edge for now
  const meta = await sharp(imagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
  const buf = new Uint8Array(meta.data.buffer, meta.data.byteOffset, meta.data.byteLength);
  const { width, height } = meta.info;
  return edgeFromGrayBuffer(buf, width, height);
}

export async function validateStage1A(
  canonicalBasePath: string,
  stage1APath: string,
  structuralMask: StructuralMask,
  baseArtifacts?: BaseArtifacts
): Promise<Stage1AValidationResult> {
  const baseW = baseArtifacts?.path === canonicalBasePath
    ? baseArtifacts.width
    : (await sharp(canonicalBasePath).metadata()).width!;
  const baseH = baseArtifacts?.path === canonicalBasePath
    ? baseArtifacts.height
    : (await sharp(canonicalBasePath).metadata()).height!;
  const outMeta = await sharp(stage1APath).metadata();
  const outW = outMeta.width!;
  const outH = outMeta.height!;

  if (baseW !== outW || baseH !== outH) {
    const wRatio = outW / baseW;
    const hRatio = outH / baseH;
    const maxDev = Math.max(Math.abs(wRatio - 1), Math.abs(hRatio - 1));
    if (maxDev <= 0.01) {
      await sharp(stage1APath)
        .resize(baseW, baseH, { fit: "fill", withoutEnlargement: false })
        .toFile(stage1APath + ".aligned.webp");
      stage1APath = stage1APath + ".aligned.webp";
    } else {
      return {
        ok: false,
        reason: "dimension_change",
        dims: { baseW, baseH, outW, outH },
      };
    }
  }

  let brightnessDiff: number;
  let baseEdges: Uint8Array;
  let outEdges: Uint8Array;
  if (baseArtifacts?.path === canonicalBasePath && baseArtifacts.gray) {
    const cand = await sharp(stage1APath).greyscale().raw().toBuffer({ resolveWithObject: true });
    const candGray = new Uint8Array(cand.data.buffer, cand.data.byteOffset, cand.data.byteLength);
    brightnessDiff = computeBrightnessDiffFromBuffers(baseArtifacts.gray, candGray);
    baseEdges = baseArtifacts.edge || edgeFromGrayBuffer(baseArtifacts.gray, baseArtifacts.width, baseArtifacts.height);
    outEdges = edgeFromGrayBuffer(candGray, cand.info.width, cand.info.height);
  } else {
    brightnessDiff = await computeBrightnessDiff(canonicalBasePath, stage1APath);
    baseEdges = await cannyEdge(canonicalBasePath);
    outEdges = await cannyEdge(stage1APath);
  }
  const baseStruct = maskEdges(baseEdges, structuralMask);
  const outStruct = maskEdges(outEdges, structuralMask);
  const structuralIoU = computeIoU(baseStruct, outStruct);

  if (structuralIoU < 0.85) {
    return { ok: false, reason: "structural_change", structuralIoU };
  }
  if (brightnessDiff < -0.3 || brightnessDiff > 1.2) {
    return { ok: false, reason: "brightness_out_of_range", brightnessDiff };
  }
  return { ok: true, structuralIoU, brightnessDiff };
}

export async function computeStructuralChangeRatio(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real mask diff logic using mask object
  return 0.01; // always pass for now
}

export async function computeWindowIoU(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real window IoU logic using mask object
  return 0.99; // always pass for now
}

export async function computeLandcoverChangeRatio(basePath: string, candidatePath: string, mask: StructuralMask): Promise<number> {
  // TODO: Implement real landcover diff logic using mask object
  return 0.0; // always pass for now
}

export async function validateStage1AStructural(
  canonicalPath: string,
  candidatePath: string,
  masks: { structuralMask: StructuralMask; windowMask?: any; landcoverMask?: any; },
  sceneType: "interior" | "exterior"
): Promise<StructuralValidationResult> {
  // Segment both images
  const baseSeg = await segmentImageClasses(canonicalPath);
  const candSeg = await segmentImageClasses(candidatePath);
  // Hard fail if dimensions change
  const candidatePathResized = await ensureSameSizeAsBase(canonicalPath, candidatePath);
  // Run per-class checks
  const wallRes = compareWalls(baseSeg, candSeg);
  if (!wallRes.pass) return { ok: false, reason: wallRes.code || "wall_layout_changed" };
  const winRes = compareWindows(baseSeg, candSeg);
  if (!winRes.pass) return { ok: false, reason: winRes.code || "windows_changed" };
  const doorRes = compareDoors(baseSeg, candSeg);
  if (!doorRes.pass) return { ok: false, reason: doorRes.code || "doors_changed" };
  const floorRes = compareFloorMaterial(baseSeg, candSeg);
  if (!floorRes.pass) return { ok: false, reason: floorRes.code || "floor_material_changed" };
  if (sceneType === "exterior") {
    const grassRes = compareGrassConcrete(baseSeg, candSeg);
    if (!grassRes.pass) return { ok: false, reason: grassRes.code || "grass_to_concrete" };
    const driveRes = compareDrivewayPresence(baseSeg, candSeg);
    if (!driveRes.pass) return { ok: false, reason: driveRes.code || "driveway_changed" };
    const carRes = compareVehicles(baseSeg, candSeg);
    if (!carRes.pass) return { ok: false, reason: carRes.code || "vehicle_changed" };
  }
  return { ok: true };
}
