import sharp from "sharp";
import { StructuralMask } from "./structuralMask";

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

export async function validateStage1B(
  canonicalBasePath: string,
  stage1BPath: string,
  structuralMask: StructuralMask
): Promise<Stage1BValidationResult> {
  const baseMeta = await sharp(canonicalBasePath).metadata();
  const outMeta = await sharp(stage1BPath).metadata();
  const baseW = baseMeta.width!;
  const baseH = baseMeta.height!;
  const outW = outMeta.width!;
  const outH = outMeta.height!;

  if (baseW !== outW || baseH !== outH) {
    const wRatio = outW / baseW;
    const hRatio = outH / baseH;
    const maxDev = Math.max(Math.abs(wRatio - 1), Math.abs(hRatio - 1));
    if (maxDev <= 0.01) {
      await sharp(stage1BPath)
        .resize(baseW, baseH, { fit: "fill", withoutEnlargement: false })
        .toFile(stage1BPath + ".aligned.webp");
      stage1BPath = stage1BPath + ".aligned.webp";
    } else {
      return {
        ok: false,
        reason: "dimension_change",
        dims: { baseW, baseH, outW, outH },
      };
    }
  }

  const baseEdges = await cannyEdge(canonicalBasePath);
  const outEdges = await cannyEdge(stage1BPath);
  const baseStruct = maskEdges(baseEdges, structuralMask);
  const outStruct = maskEdges(outEdges, structuralMask);
  const structuralIoU = computeIoU(baseStruct, outStruct);

  if (structuralIoU < 0.80) {
    return { ok: false, reason: "structural_change", structuralIoU };
  }
  return { ok: true, structuralIoU };
}
