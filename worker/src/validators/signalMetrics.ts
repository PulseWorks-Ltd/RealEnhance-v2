import sharp from "sharp";

type GrayImage = {
  data: Uint8Array;
  width: number;
  height: number;
};

async function toNormalizedGray(base64Image: string): Promise<GrayImage> {
  const input = Buffer.from(base64Image, "base64");
  const width = 192;
  const height = 192;
  const raw = await sharp(input)
    .grayscale()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();

  return { data: new Uint8Array(raw), width, height };
}

function computeHistogram(image: GrayImage, bins = 32): number[] {
  const hist = new Array<number>(bins).fill(0);
  const n = image.data.length;
  if (n === 0) return hist;

  for (let i = 0; i < n; i += 1) {
    const v = image.data[i];
    const idx = Math.min(bins - 1, Math.floor((v / 256) * bins));
    hist[idx] += 1;
  }

  for (let i = 0; i < bins; i += 1) {
    hist[i] /= n;
  }

  return hist;
}

function l1Distance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += Math.abs(a[i] - b[i]);
  }
  // L1 distance on normalized histograms is in [0, 2].
  return Math.max(0, Math.min(1, total / 2));
}

function textureEnergy(image: GrayImage): number {
  const { data, width, height } = image;
  if (width < 2 || height < 2) return 0;

  let energy = 0;
  let count = 0;

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx = Math.abs(data[idx] - data[idx + 1]);
      const gy = Math.abs(data[idx] - data[idx + width]);
      energy += (gx + gy) / 2;
      count += 1;
    }
  }

  if (count === 0) return 0;
  return Math.max(0, Math.min(1, energy / (count * 255)));
}

function openingProxyStats(image: GrayImage): { ratio: number; aspect: number } {
  const { data, width, height } = image;
  const x0 = Math.floor(width * 0.05);
  const x1 = Math.floor(width * 0.95);
  const y0 = Math.floor(height * 0.15);
  const y1 = Math.floor(height * 0.75);

  let count = 0;
  let total = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  // Bright openings vs midtone wall proxy.
  const threshold = 170;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const idx = y * width + x;
      const v = data[idx];
      total += 1;
      if (v >= threshold) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const ratio = total > 0 ? count / total : 0;

  let aspect = 0;
  if (count > 20 && maxX > minX && maxY > minY) {
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    aspect = w / h;
  }

  return { ratio, aspect };
}

export async function computeOpeningGeometrySignal(base64Before: string, base64After: string): Promise<{
  openingAreaDelta: number;
  aspectRatioDelta: number;
  suspiciousOpeningGeometry: boolean;
}> {
  const [before, after] = await Promise.all([
    toNormalizedGray(base64Before),
    toNormalizedGray(base64After),
  ]);

  const beforeStats = openingProxyStats(before);
  const afterStats = openingProxyStats(after);

  const openingAreaDelta = Math.abs(afterStats.ratio - beforeStats.ratio);
  const baseAspect = Math.max(0.1, beforeStats.aspect || 0.1);
  const aspectRatioDelta = Math.abs((afterStats.aspect || 0) - (beforeStats.aspect || 0)) / baseAspect;

  return {
    openingAreaDelta,
    aspectRatioDelta,
    suspiciousOpeningGeometry: openingAreaDelta > 0.15,
  };
}

export async function computeMaterialSignal(base64Before: string, base64After: string): Promise<{
  colorShift: number;
  textureShift: number;
  suspiciousMaterialChange: boolean;
}> {
  const [before, after] = await Promise.all([
    toNormalizedGray(base64Before),
    toNormalizedGray(base64After),
  ]);

  const histBefore = computeHistogram(before);
  const histAfter = computeHistogram(after);
  const colorShift = l1Distance(histBefore, histAfter);

  const textureBefore = textureEnergy(before);
  const textureAfter = textureEnergy(after);
  const textureShift = Math.abs(textureAfter - textureBefore);

  return {
    colorShift,
    textureShift,
    suspiciousMaterialChange: colorShift > 0.2 && textureShift > 0.25,
  };
}
