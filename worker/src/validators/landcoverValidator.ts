import sharp from "sharp";

// Heuristic landcover check for exteriors: ensure green coverage doesn't change excessively
export async function runLandcoverCheck(basePath: string, candidatePath: string): Promise<boolean> {
  const SAMPLE = Number(process.env.LANDCOVER_SAMPLE_SIZE || 512);
  const deltaMax = Number(process.env.LANDCOVER_GREEN_DELTA_MAX || 0.35); // very tolerant

  async function greenRatio(p: string): Promise<number> {
    const img = await sharp(p).resize(SAMPLE, SAMPLE, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    const data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const channels = img.info.channels || 3;
    let g = 0; let n = 0;
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      // crude green detector: green dominance and moderate brightness
      if (gg > r + 10 && gg > b + 10 && gg > 40) g++;
      n++;
    }
    return n ? g / n : 0;
  }

  const [a, b] = await Promise.all([greenRatio(basePath), greenRatio(candidatePath)]);
  return Math.abs(a - b) <= deltaMax;
}
