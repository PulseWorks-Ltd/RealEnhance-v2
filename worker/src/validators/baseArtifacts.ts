import sharp from "sharp";
import { computeEdgeMapFromGray } from "./edgeUtils";

export interface BaseArtifacts {
  path: string;
  width: number;
  height: number;
  gray: Uint8Array;
  smallGray: Uint8Array;
  smallWidth: number;
  smallHeight: number;
  edge: Uint8Array;
  rgb?: Uint8Array;
  blur?: Uint8Array;
}

export interface BuildBaseArtifactsOptions {
  smallSize?: number;
  includeRgb?: boolean;
  buildBlur?: boolean;
  blurSigma?: number;
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

function isRgbCompatible(meta: TransformDiagnosticMeta): boolean {
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
  console.debug("[baseArtifacts] transform", {
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

export async function buildBaseArtifacts(
  basePath: string,
  options: BuildBaseArtifactsOptions = {}
): Promise<BaseArtifacts> {
  const smallSize = Number.isFinite(options.smallSize) ? Number(options.smallSize) : 512;
  const includeRgb = options.includeRgb !== false;
  const buildBlur = options.buildBlur === true;
  const blurSigma = Number.isFinite(options.blurSigma) ? Number(options.blurSigma) : 0.8;

  const baseSharp = sharp(basePath);
  const meta = await baseSharp.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Failed to read base image dimensions");
  }
  const width = meta.width;
  const height = meta.height;

  const grayPromise = baseSharp.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
  const smallPromise = baseSharp
    .clone()
    .greyscale()
    .resize(smallSize, smallSize, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgbPromise = includeRgb
    ? Promise.resolve().then(async () => {
        const rgbMeta = toTransformDiagnosticMeta(meta);
        if (!isRgbCompatible(rgbMeta)) {
          console.warn("[baseArtifacts] Skipping RGB conversion due to unsupported metadata", {
            width: rgbMeta.width,
            height: rgbMeta.height,
            space: rgbMeta.space,
            channels: rgbMeta.channels,
            depth: rgbMeta.depth,
            hasAlpha: rgbMeta.hasAlpha,
          });
          logTransformDiagnostic("rgb_conversion", "skipped", rgbMeta, "base_artifacts");
          return null;
        }

        logTransformDiagnostic("ensureAlpha", "before", rgbMeta, "base_artifacts");
        const rgba = baseSharp.clone().ensureAlpha();
        logTransformDiagnostic("ensureAlpha", "after", rgbMeta, "base_artifacts");
        logTransformDiagnostic("removeAlpha", "before", rgbMeta, "base_artifacts");
        const rgb = rgba.removeAlpha();
        logTransformDiagnostic("removeAlpha", "after", rgbMeta, "base_artifacts");
        logTransformDiagnostic("toColourspace", "before", rgbMeta, "base_artifacts", { target: "srgb" });
        const srgb = rgb.toColourspace("srgb");
        logTransformDiagnostic("toColourspace", "after", rgbMeta, "base_artifacts", { target: "srgb" });
        return srgb
          .resize(width, height, { fit: "fill" })
          .raw()
          .toBuffer({ resolveWithObject: true });
      }).catch((err) => {
        console.warn("[baseArtifacts] RGB conversion failed-open", {
          message: (err as any)?.message || String(err),
        });
        return null;
      })
    : null;

  const blurPromise = buildBlur
    ? baseSharp.clone().greyscale().blur(blurSigma).raw().toBuffer({ resolveWithObject: true })
    : null;

  const [gray, small, rgb, blur] = await Promise.all([
    grayPromise,
    smallPromise,
    rgbPromise,
    blurPromise,
  ]);

  baseSharp.destroy();

  const grayData = new Uint8Array(gray.data.buffer, gray.data.byteOffset, gray.data.byteLength);
  const edge = computeEdgeMapFromGray(grayData, gray.info.width, gray.info.height, 38);

  return {
    path: basePath,
    width,
    height,
    gray: grayData,
    smallGray: new Uint8Array(small.data.buffer, small.data.byteOffset, small.data.byteLength),
    smallWidth: small.info.width,
    smallHeight: small.info.height,
    edge,
    rgb: rgb ? new Uint8Array(rgb.data.buffer, rgb.data.byteOffset, rgb.data.byteLength) : undefined,
    blur: blur ? new Uint8Array(blur.data.buffer, blur.data.byteOffset, blur.data.byteLength) : undefined,
  };
}

export async function ensureBaseBlur(
  artifacts: BaseArtifacts,
  blurSigma: number
): Promise<Uint8Array> {
  if (artifacts.blur) return artifacts.blur;
  const expectedGrayLength = artifacts.width * artifacts.height;
  const hasValidGrayBuffer =
    Number.isFinite(artifacts.width) &&
    Number.isFinite(artifacts.height) &&
    artifacts.width > 0 &&
    artifacts.height > 0 &&
    artifacts.gray.length >= expectedGrayLength;

  if (hasValidGrayBuffer) {
    try {
      const blurred = await sharp(artifacts.gray, {
        raw: { width: artifacts.width, height: artifacts.height, channels: 1 },
      })
        .blur(blurSigma)
        .raw()
        .toBuffer({ resolveWithObject: true });
      artifacts.blur = new Uint8Array(
        blurred.data.buffer,
        blurred.data.byteOffset,
        blurred.data.byteLength
      );
      return artifacts.blur;
    } catch {
    }
  }

  const blurredFromPath = await sharp(artifacts.path)
    .greyscale()
    .resize(artifacts.width, artifacts.height, { fit: "fill", withoutEnlargement: false })
    .blur(blurSigma)
    .raw()
    .toBuffer({ resolveWithObject: true });

  artifacts.blur = new Uint8Array(
    blurredFromPath.data.buffer,
    blurredFromPath.data.byteOffset,
    blurredFromPath.data.byteLength
  );
  return artifacts.blur;
}