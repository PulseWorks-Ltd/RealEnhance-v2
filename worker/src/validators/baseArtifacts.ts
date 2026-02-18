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
    ? baseSharp
        .clone()
        .ensureAlpha()
        .removeAlpha()
        .toColourspace("srgb")
        .resize(width, height, { fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true })
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