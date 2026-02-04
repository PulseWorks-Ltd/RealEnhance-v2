import sharp from "sharp";

export function computeBrightnessDiffFromBuffers(
  baseGray: Uint8Array,
  candGray: Uint8Array
): number {
  const n = Math.min(baseGray.length, candGray.length);
  let sA = 0;
  let sB = 0;
  for (let i = 0; i < n; i++) {
    sA += baseGray[i];
    sB += candGray[i];
  }
  const mA = sA / (n * 255);
  const mB = sB / (n * 255);
  return Math.abs(mA - mB);
}

// Returns absolute normalized mean brightness difference (0..1)
export async function computeBrightnessDiff(basePath: string, candidatePath: string): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(basePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
    sharp(candidatePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    // If sizes differ, resize candidate to base for fair comparison
    const resized = await sharp(candidatePath)
      .greyscale()
      .resize(a.info.width, a.info.height, { fit: "fill" })
      .raw()
      .toBuffer();
    b.data = resized as any;
  }
  const ad = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const bd = new Uint8Array(b.data as any);
  return computeBrightnessDiffFromBuffers(ad, bd);
}
