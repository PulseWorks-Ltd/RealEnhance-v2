import os from "os";
import path from "path";
import fs from "fs/promises";
import sharp from "sharp";
import { validateLineStructure } from "../lineEdgeValidator";
import { StageId, ValidationTrigger } from "../stageAwareConfig";
import { StructuralMask } from "../structuralMask";

export interface LineGeometryCheckResult {
  triggers: ValidationTrigger[];
  metrics: {
    lineScore?: number;
    edgeLoss?: number;
  };
}

export async function runLineGeometryCheck(opts: {
  baselinePath: string;
  candidatePath: string;
  stage: StageId;
  threshold: number;
  maskBaseline?: StructuralMask;
  maskCandidate?: StructuralMask;
  jobId?: string;
}): Promise<LineGeometryCheckResult> {
  const { baselinePath, candidatePath, stage, threshold, maskBaseline, maskCandidate, jobId } = opts;
  const triggers: ValidationTrigger[] = [];
  const metrics: LineGeometryCheckResult["metrics"] = {};

  try {
    const maskedPaths = await maybeMaskImagesWithStructure({
      baselinePath,
      candidatePath,
      maskBaseline,
      maskCandidate,
      jobId,
    });

    const result = await validateLineStructure({
      originalPath: maskedPaths?.baseline || baselinePath,
      enhancedPath: maskedPaths?.candidate || candidatePath,
      sensitivity: threshold,
    });

    metrics.lineScore = result.score;
    metrics.edgeLoss = result.edgeLoss;

    if (!result.passed && result.score !== undefined) {
      triggers.push({
        id: "line_geometry_score",
        message: `Line geometry score too low: ${result.score.toFixed(3)} < ${threshold}`,
        value: result.score,
        threshold,
        stage,
      });
    }
  } catch (err) {
    console.warn(`[lineGeometryValidator] Error during line geometry check (non-fatal):`, err);
  }

  return { triggers, metrics };
}

async function maybeMaskImagesWithStructure(opts: {
  baselinePath: string;
  candidatePath: string;
  maskBaseline?: StructuralMask;
  maskCandidate?: StructuralMask;
  jobId?: string;
}): Promise<{ baseline: string; candidate: string } | null> {
  const { baselinePath, candidatePath, maskBaseline, maskCandidate, jobId } = opts;
  if (!maskBaseline || !maskCandidate) return null;

  const tmpDir = os.tmpdir();
  const prefix = `linegeom-${jobId || Date.now()}`;
  const maskedBaseline = path.join(tmpDir, `${prefix}-base.png`);
  const maskedCandidate = path.join(tmpDir, `${prefix}-cand.png`);

  await Promise.all([
    maskImageWithStructuralMask(baselinePath, maskBaseline, maskedBaseline),
    maskImageWithStructuralMask(candidatePath, maskCandidate, maskedCandidate),
  ]);

  return { baseline: maskedBaseline, candidate: maskedCandidate };
}

async function maskImageWithStructuralMask(imagePath: string, mask: StructuralMask, outPath: string): Promise<void> {
  const maskBuf = await sharp(mask.data, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .toFormat("png")
    .toBuffer();

  const img = sharp(imagePath).ensureAlpha();
  const { width, height } = await img.metadata();
  const resizedMask = await sharp(maskBuf)
    .resize(width || mask.width, height || mask.height, { fit: "fill" })
    .toBuffer();

  const masked = await img
    .composite([
      {
        input: resizedMask,
        blend: "dest-in", // keep only structural regions
      },
    ])
    .png()
    .toBuffer();

  await fs.writeFile(outPath, masked);
}
