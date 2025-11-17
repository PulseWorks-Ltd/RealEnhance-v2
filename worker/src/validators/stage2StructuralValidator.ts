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

export async function runStage2StructuralValidator(params: Stage2StructParams): Promise<Stage2StructVerdict> {
  const { canonicalPath, stagedPath, structuralMask } = params;
  try {
    // Blur handling: clamp, allow 'none' to disable blur safely
    const rawBlur = process.env.STAGE2_STRUCT_VALIDATOR_BLUR;
    let blurSigma = rawBlur === 'none' ? 0 : Number(rawBlur);
    if (!isFinite(blurSigma) || blurSigma <= 0) blurSigma = 0.4; // safe default avoiding Sharp error
    blurSigma = Math.max(0.3, Math.min(blurSigma, 8));
    const edgeThr = Number(process.env.STAGE2_STRUCT_VALIDATOR_EDGE_THRESHOLD || 40);
    const baseSharp = sharp(canonicalPath).greyscale();
    const stagedSharp = sharp(stagedPath).greyscale();
    const basePipe = blurSigma >= 0.3 ? baseSharp.blur(blurSigma) : baseSharp;
    const stagedPipe = blurSigma >= 0.3 ? stagedSharp.blur(blurSigma) : stagedSharp;
    // Normalize staged image dimensions to canonical for fair comparison.
    // This avoids treating benign canvas changes (e.g., padding) as hard failures.
    const baseRaw = await basePipe.raw().toBuffer({ resolveWithObject: true });
    const stagedResized = stagedPipe.resize(baseRaw.info.width, baseRaw.info.height, { fit: "fill" });
    const stagedRaw = await stagedResized.raw().toBuffer({ resolveWithObject: true });
    const width = baseRaw.info.width; const height = baseRaw.info.height;
    const baseBuf = new Uint8Array(baseRaw.data.buffer, baseRaw.data.byteOffset, baseRaw.data.byteLength);
    const stagedBuf = new Uint8Array(stagedRaw.data.buffer, stagedRaw.data.byteOffset, stagedRaw.data.byteLength);
    const baseEdge = sobelBinary(baseBuf, width, height, edgeThr);
    const stagedEdge = sobelBinary(stagedBuf, width, height, edgeThr);
    const structuralIoU = iouMasked(baseEdge, stagedEdge, structuralMask.data);
    const minIoU = Number(process.env.STAGE2_STRUCT_IOU_MIN || 0.30);
    if (structuralIoU < minIoU) {
      return { ok: false, structuralIoU, reason: "structural_change" };
    }
    return { ok: true, structuralIoU };
  } catch (e) {
    console.error('[stage2-struct] validator error', e);
    return { ok: false, structuralIoU: 0, reason: 'validator_error' };
  }
}
