import sharp from "sharp";
import type { ExtractionMaskMetrics, MaskValidationResult } from "./types";

// Deliberately simple, deterministic validation (implementation directive
// §10): no elaborate validator framework, just the checks that actually
// matter before trusting a mask enough to composite with it.

const MIN_NONZERO_RATIO = 0.0005; // effectively empty below this
const MAX_NONZERO_RATIO = 0.85; // "not effectively the entire image" above this

function findBoundingBox(
  raw: Buffer,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if ((raw[index] ?? 0) === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function countConnectedComponents(binary: Buffer, width: number): number {
  const visited = new Uint8Array(binary.length);
  let count = 0;
  const offsets = [-1, 1, -width, width];
  for (let index = 0; index < binary.length; index += 1) {
    if ((binary[index] ?? 0) === 0 || visited[index] === 1) continue;
    count += 1;
    const queue: number[] = [index];
    visited[index] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      const x = current % width;
      for (const offset of offsets) {
        const next = current + offset;
        if (next < 0 || next >= binary.length || visited[next] === 1 || (binary[next] ?? 0) === 0) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  return count;
}

export async function validateExtractionMask(params: {
  sourceImagePath: string;
  maskPngBuffer: Buffer;
}): Promise<MaskValidationResult> {
  const sourceMetadata = await sharp(params.sourceImagePath).metadata();
  const sourceWidth = sourceMetadata.width || 0;
  const sourceHeight = sourceMetadata.height || 0;

  let maskMetadata: sharp.Metadata;
  try {
    maskMetadata = await sharp(params.maskPngBuffer).metadata();
  } catch (err: any) {
    return invalidResult(0, 0, `mask_not_a_valid_image: ${err?.message || err}`);
  }
  const maskWidth = maskMetadata.width || 0;
  const maskHeight = maskMetadata.height || 0;

  if (!sourceWidth || !sourceHeight) {
    return invalidResult(maskWidth, maskHeight, "source_dimensions_unreadable");
  }
  if (!maskWidth || !maskHeight) {
    return invalidResult(0, 0, "mask_dimensions_unreadable");
  }
  if (maskWidth !== sourceWidth || maskHeight !== sourceHeight) {
    return invalidResult(
      maskWidth,
      maskHeight,
      `mask_dimension_mismatch: source=${sourceWidth}x${sourceHeight} mask=${maskWidth}x${maskHeight}`
    );
  }

  const grayscaleRaw = await sharp(params.maskPngBuffer).removeAlpha().grayscale().raw().toBuffer();
  const totalPixelCount = maskWidth * maskHeight;

  let nonZeroCount = 0;
  let alphaSum = 0;
  for (const value of grayscaleRaw) {
    if (value > 0) nonZeroCount += 1;
    alphaSum += value;
  }
  const nonZeroRatio = nonZeroCount / totalPixelCount;
  const meanAlpha = alphaSum / totalPixelCount;

  const binary = Buffer.alloc(totalPixelCount);
  for (let i = 0; i < totalPixelCount; i += 1) {
    binary[i] = (grayscaleRaw[i] ?? 0) > 0 ? 1 : 0;
  }
  const boundingBox = findBoundingBox(binary, maskWidth, maskHeight);
  const connectedComponentCount = countConnectedComponents(binary, maskWidth);

  const metrics: ExtractionMaskMetrics = {
    width: maskWidth,
    height: maskHeight,
    nonZeroPixelCount: nonZeroCount,
    nonZeroPixelRatio: nonZeroRatio,
    meanAlpha,
    boundingBox,
    connectedComponentCount,
  };

  if (nonZeroCount === 0) {
    return { valid: false, reason: "mask_empty_no_staging_layer_detected", metrics };
  }
  if (nonZeroRatio < MIN_NONZERO_RATIO) {
    return { valid: false, reason: `mask_effectively_empty: ratio=${nonZeroRatio.toFixed(6)}`, metrics };
  }
  if (nonZeroRatio > MAX_NONZERO_RATIO) {
    return { valid: false, reason: `mask_effectively_entire_image: ratio=${nonZeroRatio.toFixed(4)}`, metrics };
  }

  return { valid: true, reason: null, metrics };
}

function invalidResult(width: number, height: number, reason: string): MaskValidationResult {
  return {
    valid: false,
    reason,
    metrics: {
      width,
      height,
      nonZeroPixelCount: 0,
      nonZeroPixelRatio: 0,
      meanAlpha: 0,
      boundingBox: null,
      connectedComponentCount: 0,
    },
  };
}
