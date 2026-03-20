import sharp from "sharp";

const logger = console;

const DIFF_THRESHOLD = 12;
const MIN_OVERLAP_PCT = 0.1;
const MIN_CHANGED_PIXELS = 500;

export async function validateMaskAnchorOverlap(params: {
  baseImagePath: string;
  finalImagePath: string;
  maskBuffer: Buffer;
}): Promise<{
  passed: boolean;
  overlapPct: number;
}> {
  const baseRaw = await sharp(params.baseImagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = baseRaw.info.width;
  const height = baseRaw.info.height;

  const finalRaw = await sharp(params.finalImagePath)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = await sharp(params.maskBuffer)
    .ensureAlpha()
    .resize(width, height, {
      fit: "contain",
      position: "top-left",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
      kernel: sharp.kernel.nearest,
    })
    .threshold(128)
    .removeAlpha()
    .raw()
    .toBuffer();

  const pixelCount = width * height;
  let totalChangedPixels = 0;
  let overlapPixels = 0;

  for (let i = 0; i < pixelCount; i += 1) {
    const idx = i * 3;
    const dr = Math.abs((baseRaw.data[idx] ?? 0) - (finalRaw.data[idx] ?? 0));
    const dg = Math.abs((baseRaw.data[idx + 1] ?? 0) - (finalRaw.data[idx + 1] ?? 0));
    const db = Math.abs((baseRaw.data[idx + 2] ?? 0) - (finalRaw.data[idx + 2] ?? 0));
    const diff = (dr + dg + db) / 3;

    if (diff < DIFF_THRESHOLD) {
      continue;
    }

    totalChangedPixels += 1;
    if ((mask[i] ?? 0) > 127) {
      overlapPixels += 1;
    }
  }

  const overlapPct =
    totalChangedPixels > 0
      ? overlapPixels / totalChangedPixels
      : 0;

  logger.info("maskAnchorCheck", {
    overlapPct,
    totalChangedPixels,
  });

  if (totalChangedPixels < MIN_CHANGED_PIXELS) {
    return {
      passed: true,
      overlapPct,
    };
  }

  return {
    passed: overlapPct >= MIN_OVERLAP_PCT,
    overlapPct,
  };
}