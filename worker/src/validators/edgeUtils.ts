export function computeEdgeMapFromGray(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number
): Uint8Array {
  const edge = new Uint8Array(gray.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = (
        gray[i - width - 1] + 2 * gray[i - 1] + gray[i + width - 1] -
        gray[i - width + 1] - 2 * gray[i + 1] - gray[i + width + 1]
      );
      const gy = (
        gray[i - width - 1] + 2 * gray[i - width] + gray[i - width + 1] -
        gray[i + width - 1] - 2 * gray[i + width] - gray[i + width + 1]
      );
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g > threshold) edge[i] = 1;
    }
  }
  return edge;
}