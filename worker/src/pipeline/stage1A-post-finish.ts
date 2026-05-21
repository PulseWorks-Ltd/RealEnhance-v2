import sharp from "sharp";
import { applyTransformation } from "../utils/sharp-utils";

export interface Stage1APostFinishOptions {
  jobId: string;
  sceneType?: string;
}

function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export async function applyStage1APostGenerationFinish(
  inputPath: string,
  options: Stage1APostFinishOptions,
): Promise<string> {
  const enabled = parseOptionalBoolean(process.env.STAGE1A_POSTGEN_FINISH_ENABLED) ?? true;
  if (!enabled) {
    return inputPath;
  }

  const sharpenEnabled = parseOptionalBoolean(process.env.STAGE1A_POSTGEN_FINISH_SHARPEN_ENABLED) ?? true;
  const microContrastEnabled = parseOptionalBoolean(process.env.STAGE1A_POSTGEN_FINISH_MICROCONTRAST_ENABLED) ?? true;
  const sharpenScale = parseBoundedNumber(process.env.STAGE1A_POSTGEN_FINISH_SHARPEN_SCALE, 1, 0, 2);
  const microContrastScale = parseBoundedNumber(process.env.STAGE1A_POSTGEN_FINISH_MICROCONTRAST_SCALE, 1, 0, 2);
  const quality = parseBoundedNumber(process.env.STAGE1A_POSTGEN_FINISH_WEBP_QUALITY, 96, 80, 100);

  const isExterior = options.sceneType === "exterior";
  const sharpenM2Base = isExterior ? 0.5 : 0.38;
  const contrastBase = isExterior ? 0.022 : 0.018;

  const outPath = inputPath.replace(/\.webp$/i, "-postfinish.webp");

  await applyTransformation(
    inputPath,
    outPath,
    (s) => {
      let pipeline = s;

      if (microContrastEnabled && microContrastScale > 0) {
        const scale = contrastBase * microContrastScale;
        pipeline = pipeline.linear(1 + scale, -(128 * scale * 0.2));
      }

      if (sharpenEnabled && sharpenScale > 0) {
        pipeline = pipeline.sharpen({
          sigma: 1.1,
          m1: 0.8,
          m2: sharpenM2Base * sharpenScale,
          x1: 2,
          y2: 10,
          y3: 20,
        });
      }

      return pipeline.webp({
        quality,
        effort: 6,
        smartSubsample: true,
      });
    },
    options.jobId,
  );

  return outPath;
}
