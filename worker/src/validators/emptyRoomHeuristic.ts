import sharp from "sharp";

/**
 * Lightweight heuristic to decide if a staged image is effectively empty.
 * Uses edge density in the central region as a proxy for furniture presence.
 */
export async function isEmptyRoomByEdgeDensity(imagePath: string, opts?: {
  edgeDensityMax?: number;
  centerCropRatio?: number;
}): Promise<{ empty: boolean; edgeDensity: number; threshold: number }> {
  const threshold = opts?.edgeDensityMax ?? Number(process.env.STAGE2_EMPTYROOM_EDGE_DENSITY_MAX ?? 0.045);
  const centerCrop = opts?.centerCropRatio ?? 0.6; // central 60% of the image

  const { data, info } = await sharp(imagePath)
    .resize(256, 256, { fit: "inside" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const cropW = Math.floor(width * centerCrop);
  const cropH = Math.floor(height * centerCrop);
  const startX = Math.floor((width - cropW) / 2);
  const startY = Math.floor((height - cropH) / 2);

  let edgePixels = 0;
  let totalPixels = 0;
  const edgeThreshold = 30;

  for (let y = startY + 1; y < startY + cropH - 1; y++) {
    for (let x = startX + 1; x < startX + cropW - 1; x++) {
      const idx = y * width + x;
      const gx = Math.abs(data[idx + 1] - data[idx - 1]);
      const gy = Math.abs(data[idx + width] - data[idx - width]);
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude > edgeThreshold) edgePixels++;
      totalPixels++;
    }
  }

  const edgeDensity = totalPixels === 0 ? 0 : edgePixels / totalPixels;
  return { empty: edgeDensity <= threshold, edgeDensity, threshold };
}
