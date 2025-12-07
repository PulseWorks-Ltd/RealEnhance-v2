import sharp from "sharp";

/**
 * Detects roof/pergola-like structures near the top of the image.
 * Conservative heuristic: counts strong vertical edge density in the top 35%.
 * Returns true when density exceeds a threshold.
 */
export async function detectRoofOrPergola(imagePath: string): Promise<boolean> {
  try {
    const ANALYSIS_W = 256;
    const ANALYSIS_H = 256;
    const img = sharp(imagePath).resize(ANALYSIS_W, ANALYSIS_H, { fit: "inside" }).raw();
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;
    const channels = info.channels; // expect 3 (RGB) or 4
    if (w === 0 || h === 0) return false;

    // Focus on top region
    const topH = Math.max(1, Math.floor(h * 0.35));
    const stride = channels; // bytes per pixel

    // Compute simple x-gradient magnitude to find vertical edges
    let edgeCount = 0;
    let sampleCount = 0;
    const THRESH = 35; // edge magnitude threshold (0-255)

    for (let y = 0; y < topH; y++) {
      for (let x = 1; x < w; x++) {
        const i0 = (y * w + (x - 1)) * stride;
        const i1 = (y * w + x) * stride;
        const r0 = data[i0] || 0, g0 = data[i0 + 1] || 0, b0 = data[i0 + 2] || 0;
        const r1 = data[i1] || 0, g1 = data[i1 + 1] || 0, b1 = data[i1 + 2] || 0;
        // Luma approximation
        const l0 = Math.max(r0, g0, b0);
        const l1 = Math.max(r1, g1, b1);
        const diff = Math.abs(l1 - l0);
        if (diff >= THRESH) edgeCount++;
        sampleCount++;
      }
    }

    const density = edgeCount / Math.max(1, sampleCount);
    // Roof/pergola beams produce repeated vertical edges; set a conservative threshold
    // Typical photos without roof structures have low density (<0.06). Pergola-like often >0.10.
    return density >= 0.10;
  } catch {
    return false;
  }
}
