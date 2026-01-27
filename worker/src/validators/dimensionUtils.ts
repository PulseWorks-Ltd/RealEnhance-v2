import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import { StructuralIssueCode, StructuralValidationResult } from "./types";

export async function normaliseDimensionsForValidation(basePath: string, outPath: string): Promise<{
  baseImgPath: string;
  outImgPath: string;
  dimIssue: StructuralIssueCode;
  baseSize: { width: number; height: number };
  outSize: { width: number; height: number };
}> {
  const baseMeta = await sharp(basePath).metadata();
  const outMeta = await sharp(outPath).metadata();
  const bw = baseMeta.width!;
  const bh = baseMeta.height!;
  const ow = outMeta.width!;
  const oh = outMeta.height!;
  if (bw === ow && bh === oh) {
    return { baseImgPath: basePath, outImgPath: outPath, dimIssue: "none", baseSize: { width: bw, height: bh }, outSize: { width: ow, height: oh } };
  }
  const baseRatio = bw / bh;
  const outRatio = ow / oh;
  const ratioDiff = Math.abs(baseRatio - outRatio) / baseRatio;
  // If aspect ratio is almost the same, allow resize
  if (ratioDiff < 0.03) {
    const resizedPath = outPath.replace(/\.webp$/, ".aligned.webp");
    await sharp(outPath).resize(bw, bh, { fit: "fill" }).toFile(resizedPath);
    return { baseImgPath: basePath, outImgPath: resizedPath, dimIssue: "none", baseSize: { width: bw, height: bh }, outSize: { width: bw, height: bh } };
  }
  // More radical change: mark as potential structural problem
  return {
    baseImgPath: basePath,
    outImgPath: outPath,
    dimIssue: "dimension_change",
    baseSize: { width: bw, height: bh },
    outSize: { width: ow, height: oh }
  };
}

export type NormalizedPairResult = {
  basePath: string;
  candidatePath: string;
  width: number;
  height: number;
  baseOrig?: { width: number; height: number };
  candidateOrig?: { width: number; height: number };
  normalized: boolean;
  method: "none" | "crop" | "resize" | "crop+resize";
  severity: "info" | "warn";
  note?: string;
};

/**
 * Center-crop both images to the shared minimum dimensions (fail-open).
 * If extraction fails, returns the original paths and marks severity=warn.
 */
export async function normalizeImagePairForValidator(params: {
  basePath: string;
  candidatePath: string;
  jobId?: string;
  tolerance?: number;
}): Promise<NormalizedPairResult> {
  const tolerance = params.tolerance ?? 8;
  const jobTag = params.jobId ? params.jobId.replace(/[^a-zA-Z0-9_-]/g, "") : `${Date.now()}`;

  const [baseMeta, candMeta] = await Promise.all([
    sharp(params.basePath).metadata(),
    sharp(params.candidatePath).metadata(),
  ]);

  const bw = baseMeta.width ?? 0;
  const bh = baseMeta.height ?? 0;
  const cw = candMeta.width ?? 0;
  const ch = candMeta.height ?? 0;

  if (!bw || !bh || !cw || !ch) {
    return {
      basePath: params.basePath,
      candidatePath: params.candidatePath,
      baseOrig: { width: bw, height: bh },
      candidateOrig: { width: cw, height: ch },
      width: bw || 0,
      height: bh || 0,
      normalized: false,
      method: "none",
      severity: "warn",
      note: "invalid_dimensions",
    };
  }

  if (bw === cw && bh === ch) {
    return {
      basePath: params.basePath,
      candidatePath: params.candidatePath,
      baseOrig: { width: bw, height: bh },
      candidateOrig: { width: cw, height: ch },
      width: bw,
      height: bh,
      normalized: false,
      method: "none",
      severity: "info",
    };
  }

  const targetW = Math.min(bw, cw);
  const targetH = Math.min(bh, ch);
  const withinTolerance = Math.abs(bw - cw) <= tolerance && Math.abs(bh - ch) <= tolerance;
  const severity: "info" | "warn" = withinTolerance ? "info" : "warn";

  const cropToCenter = async (src: string, label: "base" | "cand") => {
    const meta = label === "base" ? baseMeta : candMeta;
    const left = Math.max(0, Math.floor(((meta.width ?? targetW) - targetW) / 2));
    const top = Math.max(0, Math.floor(((meta.height ?? targetH) - targetH) / 2));
    const outPath = path.join("/tmp", `validator-norm-${jobTag}-${label}-${targetW}x${targetH}.webp`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await sharp(src)
      .extract({ left, top, width: targetW, height: targetH })
      .toFile(outPath);
    return outPath;
  };

  try {
    const [baseOut, candOut] = await Promise.all([
      cropToCenter(params.basePath, "base"),
      cropToCenter(params.candidatePath, "cand"),
    ]);

    return {
      basePath: baseOut,
      candidatePath: candOut,
      baseOrig: { width: bw, height: bh },
      candidateOrig: { width: cw, height: ch },
      width: targetW,
      height: targetH,
      normalized: true,
      method: "crop",
      severity,
    };
  } catch (err) {
    return {
      basePath: params.basePath,
      candidatePath: params.candidatePath,
      baseOrig: { width: bw, height: bh },
      candidateOrig: { width: cw, height: ch },
      width: targetW,
      height: targetH,
      normalized: false,
      method: "none",
      severity: "warn",
      note: `normalize_failed:${(err as Error)?.message || err}`,
    };
  }
}