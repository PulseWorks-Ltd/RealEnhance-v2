import sharp from "sharp";

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

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ? 1 : 0;
    const bv = b[i] ? 1 : 0;
    if (av & bv) inter++;
    if (av | bv) uni++;
  }
  return uni > 0 ? inter / uni : 1;
}

export async function runGlobalEdgeMetrics(basePath: string, candidatePath: string): Promise<{ edgeIoU: number }> {
  // Clamp blur to avoid sharp sigma=0 errors
  let sigma = Number(process.env.GLOBAL_EDGE_PREBLUR || 0.8);
  if (!isFinite(sigma) || sigma <= 0) sigma = 0.8;
  sigma = Math.max(0.3, Math.min(sigma, 8));
  const thr = Number(process.env.LOCAL_EDGE_MAG_THRESHOLD || 35);

  const a = await sharp(basePath).greyscale().blur(sigma).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(candidatePath).greyscale().blur(sigma).raw().toBuffer({ resolveWithObject: true });

  let aData = a.data; let bData = b.data;
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    const rb = await sharp(candidatePath).greyscale().blur(sigma).resize(a.info.width, a.info.height, { fit: "fill" }).raw().toBuffer();
    bData = rb as any;
  }
  const width = a.info.width; const height = a.info.height;
  const aBuf = new Uint8Array(aData.buffer, aData.byteOffset, aData.byteLength);
  const bBuf = new Uint8Array(bData as any);
  const aEdge = sobelBinary(aBuf, width, height, thr);
  const bEdge = sobelBinary(bBuf, width, height, thr);
  return { edgeIoU: iou(aEdge, bEdge) };
}
