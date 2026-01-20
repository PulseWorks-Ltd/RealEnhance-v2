import sharp from "sharp";

export interface DimensionInfo {
  width: number;
  height: number;
}

export interface DimensionGuardResult {
  ok: boolean;
  baseline: DimensionInfo;
  candidate: DimensionInfo;
  message: string;
}

export const STRICT_DIMENSION_PROMPT_SUFFIX =
  "CRITICAL OUTPUT CONSTRAINT: The output image MUST be exactly the same pixel dimensions as the input image (same width and height). Do NOT crop, pad, rotate, or rescale. Preserve the exact framing and perspective.";

async function probeDimensions(imagePath: string): Promise<DimensionInfo> {
  const meta = await sharp(imagePath).metadata();
  return {
    width: meta.width || 0,
    height: meta.height || 0,
  };
}

export async function compareImageDimensions(
  baselinePath: string,
  candidatePath: string
): Promise<DimensionGuardResult> {
  const [baseline, candidate] = await Promise.all([
    probeDimensions(baselinePath),
    probeDimensions(candidatePath),
  ]);

  const ok = baseline.width === candidate.width && baseline.height === candidate.height;
  const message = ok
    ? "Dimensions match"
    : `Dimension mismatch: baseline=${baseline.width}x${baseline.height}, candidate=${candidate.width}x${candidate.height}`;

  return { ok, baseline, candidate, message };
}
