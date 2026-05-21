import sharp from "sharp";
import { applyTransformation } from "../utils/sharp-utils";

export interface Stage1APostFinishOptions {
  jobId: string;
  sceneType?: string;
}

interface TransformDiagnosticMeta {
  width: number | null;
  height: number | null;
  space: string | null;
  channels: number | null;
  depth: string | null;
  hasAlpha: boolean | null;
}

function toTransformDiagnosticMeta(meta: sharp.Metadata | null | undefined): TransformDiagnosticMeta {
  return {
    width: typeof meta?.width === "number" ? meta.width : null,
    height: typeof meta?.height === "number" ? meta.height : null,
    space: meta?.space ?? null,
    channels: typeof meta?.channels === "number" ? meta.channels : null,
    depth: meta?.depth ?? null,
    hasAlpha: typeof meta?.hasAlpha === "boolean" ? meta.hasAlpha : null,
  };
}

function isToneTransformCompatible(meta: TransformDiagnosticMeta): boolean {
  const channels = meta.channels ?? 0;
  const space = (meta.space || "").toLowerCase();
  const rgbLikeSpace = !space || space === "srgb" || space === "rgb";
  return channels >= 3 && rgbLikeSpace;
}

function logTransformDiagnostic(
  operation: string,
  phase: "before" | "after" | "skipped",
  meta: TransformDiagnosticMeta,
  branch: string,
  extras?: Record<string, unknown>
): void {
  console.debug("[stage1A-postfinish] transform", {
    operation,
    phase,
    branch,
    width: meta.width,
    height: meta.height,
    space: meta.space,
    channels: meta.channels,
    depth: meta.depth,
    hasAlpha: meta.hasAlpha,
    ...(extras || {}),
  });
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
  const branch = isExterior ? "exterior" : "interior";
  const sharpenM2Base = isExterior ? 0.5 : 0.38;
  const contrastBase = isExterior ? 0.022 : 0.018;
  const sourceMeta = toTransformDiagnosticMeta(await sharp(inputPath).metadata().catch(() => null));

  const outPath = inputPath.replace(/\.webp$/i, "-postfinish.webp");

  await applyTransformation(
    inputPath,
    outPath,
    (s) => {
      let pipeline = s;

      if (microContrastEnabled && microContrastScale > 0) {
        const scale = contrastBase * microContrastScale;
        if (isToneTransformCompatible(sourceMeta)) {
          logTransformDiagnostic("linear", "before", sourceMeta, branch, {
            scale,
            offset: -(128 * scale * 0.2),
          });
          pipeline = pipeline.linear(1 + scale, -(128 * scale * 0.2));
          logTransformDiagnostic("linear", "after", sourceMeta, branch);
        } else {
          console.warn("[stage1A-postfinish] Skipping unsupported linear() transform", {
            branch,
            width: sourceMeta.width,
            height: sourceMeta.height,
            space: sourceMeta.space,
            channels: sourceMeta.channels,
            depth: sourceMeta.depth,
            hasAlpha: sourceMeta.hasAlpha,
          });
          logTransformDiagnostic("linear", "skipped", sourceMeta, branch);
        }
      }

      if (sharpenEnabled && sharpenScale > 0) {
        logTransformDiagnostic("sharpen", "before", sourceMeta, branch, {
          sigma: 1.1,
          m2: sharpenM2Base * sharpenScale,
        });
        pipeline = pipeline.sharpen({
          sigma: 1.1,
          m1: 0.8,
          m2: sharpenM2Base * sharpenScale,
          x1: 2,
          y2: 10,
          y3: 20,
        });
        logTransformDiagnostic("sharpen", "after", sourceMeta, branch);
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
