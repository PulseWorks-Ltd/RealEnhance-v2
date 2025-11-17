import sharp from "sharp";
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