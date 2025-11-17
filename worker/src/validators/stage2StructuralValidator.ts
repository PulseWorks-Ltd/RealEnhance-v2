import sharp from "sharp";
import { StructuralMask } from "./structuralMask";

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

export async function validateStage2(
  canonicalBasePath: string,
  stage2Path: string,
  structuralMask: StructuralMask
): Promise<Stage2ValidationResult> {
  const baseMeta = await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage2Path).metadata();
  const baseW = baseMeta.width!;
  const baseH = baseMeta.height!;
  const outW = outMeta.width!;
  const outH = outMeta.height!;
  if (baseW !== outW || baseH !== outH) {
    const wRatio = outW / baseW;
    const hRatio = outH / baseH;
    const maxDev = Math.max(Math.abs(wRatio - 1), Math.abs(hRatio - 1));
    if (maxDev <= 0.01) {
      await sharp(stage2Path)
        .resize(baseW, baseH, { fit: "fill", withoutEnlargement: false })
        .toFile(stage2Path + ".aligned.webp");
      stage2Path = stage2Path + ".aligned.webp";
    } else {
      return {
        ok: false,
        reason: "dimension_change",
        dims: { baseW, baseH, outW, outH },
      };
    }
  }
  // Blur handling: clamp, safe default
  let sigma = Number(process.env.STAGE2_STRUCT_VALIDATOR_BLUR || 0.5);
  if (!isFinite(sigma) || sigma < 0.3) sigma = 0.5;
  const edgeThr = Number(process.env.STAGE2_STRUCT_VALIDATOR_EDGE_THRESHOLD || 40);
  const baseMetaObj = await sharp(canonicalBasePath).greyscale().blur(sigma).raw().toBuffer({ resolveWithObject: true });
  const outMetaObj = await sharp(stage2Path).greyscale().blur(sigma).raw().toBuffer({ resolveWithObject: true });
  const baseBuf = new Uint8Array(baseMetaObj.data.buffer, baseMetaObj.data.byteOffset, baseMetaObj.data.byteLength);
  const outBuf = new Uint8Array(outMetaObj.data.buffer, outMetaObj.data.byteOffset, outMetaObj.data.byteLength);
  const width = baseMetaObj.info.width;
  const height = baseMetaObj.info.height;
  const baseEdge = sobelBinary(baseBuf, width, height, edgeThr);
  const outEdge = sobelBinary(outBuf, width, height, edgeThr);
  const baseStruct = new Uint8Array(baseEdge.length);
  const outStruct = new Uint8Array(outEdge.length);
  for (let i = 0; i < baseEdge.length; i++) {
    baseStruct[i] = baseEdge[i] & structuralMask.data[i];
    outStruct[i] = outEdge[i] & structuralMask.data[i];
  }
  let inter = 0, uni = 0;
  for (let i = 0; i < baseStruct.length; i++) {
    if (baseStruct[i] | outStruct[i]) uni++;
    if (baseStruct[i] & outStruct[i]) inter++;
  }
  const structuralIoU = uni > 0 ? inter / uni : 1;
  if (structuralIoU < 0.78) {
    return { ok: false, reason: "structural_change", structuralIoU };
  }
  return { ok: true, structuralIoU };
}
