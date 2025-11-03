import sharp from 'sharp';

export async function validateGeometry(origBuf: Buffer, outBuf: Buffer) {
  // Very lightweight check: compare high-contrast structural edges.
  // If edge maps diverge too much, flag as geometry drift.
  const edges = async (b: Buffer) =>
    sharp(b).greyscale().normalize().linear(1, 0).convolve({
      // 3x3 Laplacian approximation for edges
      width: 3, height: 3,
      kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
    }).raw().toBuffer({ resolveWithObject: true });

  const [a, b] = await Promise.all([edges(origBuf), edges(outBuf)]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return true; // canvas changed

  // Compute simple L1 difference ratio
  let diff = 0, tot = 0;
  for (let i = 0; i < a.data.length; i++) { 
    diff += Math.abs(a.data[i] - b.data[i]); 
    tot += 255; 
  }
  const ratio = diff / tot; // 0..1
  // Tune threshold: ~0.055–0.08 usually catches big geometry moves but allows lighting changes
  // Maintain strict 0.07 threshold to protect against structural alterations
  return ratio > 0.07;
}