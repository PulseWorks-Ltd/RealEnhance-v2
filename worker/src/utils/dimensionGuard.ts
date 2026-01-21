import path from "path";
import sharp from "sharp";

import { siblingOutPath } from "./images";

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

export interface DimensionDelta {
  widthPct: number;
  heightPct: number;
}

export interface NormalizationResult extends DimensionGuardResult {
  normalizedPath: string;
  method: "crop" | "pad" | "crop+pad" | "none";
  deltas: DimensionDelta;
}

export const DEFAULT_DIM_MISMATCH_TOLERANCE_PCT = 0.04; // 4%

export function getDimensionTolerancePct(): number {
  const raw = process.env.DIM_MISMATCH_TOLERANCE_PCT;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 0.5) {
      return parsed;
    }
  }
  return DEFAULT_DIM_MISMATCH_TOLERANCE_PCT;
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

export function calculateDimensionDelta(baseline: DimensionInfo, candidate: DimensionInfo): DimensionDelta {
  const widthPct = baseline.width === 0 ? Infinity : Math.abs(candidate.width - baseline.width) / baseline.width;
  const heightPct = baseline.height === 0 ? Infinity : Math.abs(candidate.height - baseline.height) / baseline.height;
  return { widthPct, heightPct };
}

export function isWithinDimensionTolerance(
  baseline: DimensionInfo,
  candidate: DimensionInfo,
  tolerancePct: number = getDimensionTolerancePct()
): boolean {
  const deltas = calculateDimensionDelta(baseline, candidate);
  return deltas.widthPct <= tolerancePct && deltas.heightPct <= tolerancePct;
}

export async function normalizeCandidateToBaseline(
  baselinePath: string,
  candidatePath: string,
  opts: { suffix?: string } = {}
): Promise<NormalizationResult> {
  const [baseline, candidate] = await Promise.all([
    probeDimensions(baselinePath),
    probeDimensions(candidatePath),
  ]);

  const ok = baseline.width === candidate.width && baseline.height === candidate.height;
  const deltas = calculateDimensionDelta(baseline, candidate);

  if (ok) {
    return {
      ok: true,
      baseline,
      candidate,
      message: "Dimensions already match",
      normalizedPath: candidatePath,
      method: "none",
      deltas,
    };
  }

  // Start from the candidate buffer
  let transformer = sharp(candidatePath);
  let currentWidth = candidate.width;
  let currentHeight = candidate.height;

  // If candidate is larger on any dimension, center-crop to baseline
  if (candidate.width > baseline.width || candidate.height > baseline.height) {
    const extractLeft = Math.max(0, Math.floor((candidate.width - baseline.width) / 2));
    const extractTop = Math.max(0, Math.floor((candidate.height - baseline.height) / 2));
    const extractWidth = Math.min(candidate.width, baseline.width);
    const extractHeight = Math.min(candidate.height, baseline.height);

    transformer = transformer.extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight });
    currentWidth = extractWidth;
    currentHeight = extractHeight;
  }

  // After potential crop, decide padding using tracked sizes

  const padLeft = currentWidth < baseline.width ? Math.floor((baseline.width - currentWidth) / 2) : 0;
  const padRight = currentWidth < baseline.width ? baseline.width - currentWidth - padLeft : 0;
  const padTop = currentHeight < baseline.height ? Math.floor((baseline.height - currentHeight) / 2) : 0;
  const padBottom = currentHeight < baseline.height ? baseline.height - currentHeight - padTop : 0;

  let finalMethod: NormalizationResult["method"] = "crop";
  if (padLeft > 0 || padRight > 0 || padTop > 0 || padBottom > 0) {
    finalMethod = currentWidth > baseline.width || currentHeight > baseline.height ? "crop+pad" : "pad";
    transformer = transformer.extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }

  const parsed = path.parse(candidatePath);
  const normalizedPath = siblingOutPath(candidatePath, opts.suffix || "-dimnorm", parsed.ext || ".webp");
  await transformer.toFile(normalizedPath);

  const normalizedDims = await probeDimensions(normalizedPath);
  const normalizedOk = normalizedDims.width === baseline.width && normalizedDims.height === baseline.height;

  return {
    ok: normalizedOk,
    baseline,
    candidate,
    message: normalizedOk ? "Normalized to baseline dimensions" : "Failed to normalize dimensions",
    normalizedPath,
    method: normalizedOk ? finalMethod : finalMethod,
    deltas,
  };
}
