import sharp from "sharp";

type PerceptualStage = "1B" | "2";

export interface PerceptualDiffResult {
  passed: boolean;
  score: number;
  threshold: number;
  width: number;
  height: number;
}

const MAX_SIZE = 512;

const SSIM_THRESHOLDS: Record<PerceptualStage, number> = {
  "1B": 0.9,
  "2": 0.97,
};

function computeSSIM(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) {
    throw new Error(`Perceptual diff buffers differ in length: ${a.length} vs ${b.length}`);
  }

  const length = a.length;
  if (length === 0) return 1;

  let sumA = 0;
  let sumB = 0;

  for (let i = 0; i < length; i++) {
    sumA += a[i];
    sumB += b[i];
  }

  const meanA = sumA / length;
  const meanB = sumB / length;

  let varA = 0;
  let varB = 0;
  let cov = 0;

  for (let i = 0; i < length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }

  varA /= length;
  varB /= length;
  cov /= length;

  const L = 255;
  const c1 = (0.01 * L) ** 2; // stability constant for luminance
  const c2 = (0.03 * L) ** 2; // stability constant for contrast

  const numerator = (2 * meanA * meanB + c1) * (2 * cov + c2);
  const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);

  return denominator === 0 ? 1 : numerator / denominator;
}

async function normalizeImage(path: string, targetWidth: number, targetHeight: number) {
  const { data, info } = await sharp(path)
    .resize(targetWidth, targetHeight, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
  };
}

export async function runPerceptualDiff(params: {
  originalPath: string;
  enhancedPath: string;
  stage: PerceptualStage;
}): Promise<PerceptualDiffResult> {
  const { originalPath, enhancedPath, stage } = params;

  const baseMeta = await sharp(originalPath).metadata();
  const baseWidth = baseMeta.width || MAX_SIZE;
  const baseHeight = baseMeta.height || MAX_SIZE;

  const scale = Math.min(1, MAX_SIZE / Math.max(baseWidth, baseHeight));
  const targetWidth = Math.max(1, Math.round(baseWidth * scale));
  const targetHeight = Math.max(1, Math.round(baseHeight * scale));

  const base = await normalizeImage(originalPath, targetWidth, targetHeight);
  const cand = await normalizeImage(enhancedPath, targetWidth, targetHeight);

  const score = computeSSIM(base.data, cand.data);
  const threshold = SSIM_THRESHOLDS[stage];

  return {
    passed: score >= threshold,
    score,
    threshold,
    width: targetWidth,
    height: targetHeight,
  };
}
