import sharp from "sharp";
import type { BaseArtifacts } from "./baseArtifacts";
import { StructuralMask } from "./structuralMask";
import { computeBrightnessDiff, computeBrightnessDiffFromBuffers } from "./brightnessValidator";
import { computeEdgeMapFromGray } from "./edgeUtils";
import { VALIDATION_THRESHOLDS } from "./config";
import { StructuralValidationResult } from "./types";

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

// NOTE (H3, RealEnhance audit): this function is fully implemented and
// working (real edge/IoU + brightness comparison, genuine ok:false paths)
// but has zero callers anywhere in the codebase — pipeline/stage1A.ts calls
// validateStage1AStructural (below) instead, and validators/index.ts
// defines its own unrelated same-named local function. Left in place
// (not quarantined with the stub cluster in validators/_unimplemented/)
// because, unlike those, this one actually works — it's simply unwired.
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

// H3 (RealEnhance audit): computeStructuralChangeRatio / computeWindowIoU /
// computeLandcoverChangeRatio were unimplemented stubs (hardcoded return
// values, "always pass for now") with zero callers anywhere in the
// codebase. Quarantined to validators/_unimplemented/orphanedStage1AStubs.ts
// for historical reference — not deleted outright, but removed from the
// live validators/ surface so they can't be mistaken for working code and
// wired in as-is.

/**
 * H3 (RealEnhance audit): this function's per-class structural comparison
 * (walls/windows/doors/floor/grass/driveway/vehicles) was never actually
 * implemented. It depended entirely on semanticSegmenter.ts's
 * segmentImageClasses (a stub that always returns zero masks) and
 * classComparisons.ts (every comparator hardcoded `return {pass:true}`),
 * so none of its `if (!xRes.pass) return {ok:false,...}` branches could
 * ever fire regardless of real image content — both are quarantined under
 * validators/_unimplemented/ now (see that folder's README). This function
 * is called live from pipeline/stage1A.ts, so its silent no-op gave the
 * impression that per-class structural validation was running in Stage 1A,
 * when nothing was actually being checked.
 *
 * This is a status-explicit pass, not a behavior change: the dead call
 * chain has been removed (rather than left calling stubs that could only
 * ever pass) and the result now honestly labels itself as unimplemented.
 * Stage 1A's REAL structural protection is validateStage1A, above — fully
 * implemented, but currently unwired (see its own doc comment).
 */
export async function validateStage1AStructural(
  canonicalPath: string,
  candidatePath: string,
  masks: { structuralMask: StructuralMask; windowMask?: any; landcoverMask?: any; },
  sceneType: "interior" | "exterior"
): Promise<StructuralValidationResult> {
  return {
    ok: true,
    meta: { unimplemented: true, reason: "per_class_structural_comparison_not_implemented" },
  };
}
