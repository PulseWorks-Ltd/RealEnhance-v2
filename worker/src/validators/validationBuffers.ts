import sharp from "sharp";
import type { BaseArtifacts } from "./baseArtifacts";
import { ensureBaseBlur } from "./baseArtifacts";

export interface ValidationBuffers {
  width: number;
  height: number;
  resized: boolean;
  baseGray: Uint8Array;
  candGray: Uint8Array;
  baseBlur: Uint8Array;
  candBlur: Uint8Array;
  smallWidth: number;
  smallHeight: number;
  baseSmall: Uint8Array;
  candSmall: Uint8Array;
}

export interface BuildValidationBuffersOptions {
  blurSigma?: number;
  smallSize?: number;
}

export async function buildValidationBuffers(
  basePath: string,
  candPath: string,
  options: BuildValidationBuffersOptions = {},
  baseArtifacts?: BaseArtifacts
): Promise<ValidationBuffers> {
  const blurSigma = Number.isFinite(options.blurSigma) ? Number(options.blurSigma) : 0.8;
  const smallSize = Number.isFinite(options.smallSize) ? Number(options.smallSize) : 512;

  let resolvedWidth = baseArtifacts?.width;
  let resolvedHeight = baseArtifacts?.height;
  if (!resolvedWidth || !resolvedHeight) {
    const baseMeta = await sharp(basePath).metadata();
    if (!baseMeta.width || !baseMeta.height) {
      throw new Error("Failed to read base image dimensions");
    }
    resolvedWidth = baseMeta.width;
    resolvedHeight = baseMeta.height;
  }

  const candSharp = sharp(candPath).greyscale();

  // Ensure candidate is normalized to base dimensions once

  const candNormalized = candSharp.clone().resize(resolvedWidth, resolvedHeight, { fit: "fill" });

  const candGrayPromise = candNormalized.clone().raw().toBuffer({ resolveWithObject: true });
  const candBlurPromise = candNormalized.clone().blur(blurSigma).raw().toBuffer({ resolveWithObject: true });
  const candSmallPromise = candNormalized
    .clone()
    .resize(smallSize, smallSize, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const [candGray, candBlur, candSmall] = await Promise.all([
    candGrayPromise,
    candBlurPromise,
    candSmallPromise,
  ]);

  candSharp.destroy();

  const baseGray = baseArtifacts?.gray
    ? { data: baseArtifacts.gray, info: { width: resolvedWidth, height: resolvedHeight } }
    : await sharp(basePath).greyscale().raw().toBuffer({ resolveWithObject: true });

  const baseBlur = baseArtifacts
    ? { data: await ensureBaseBlur(baseArtifacts, blurSigma), info: { width: resolvedWidth, height: resolvedHeight } }
    : await sharp(basePath).greyscale().blur(blurSigma).raw().toBuffer({ resolveWithObject: true });

  const baseSmall = baseArtifacts?.smallGray
    ? { data: baseArtifacts.smallGray, info: { width: baseArtifacts.smallWidth, height: baseArtifacts.smallHeight } }
    : await sharp(basePath)
        .greyscale()
        .resize(smallSize, smallSize, { fit: "inside" })
        .raw()
        .toBuffer({ resolveWithObject: true });

  const resized = (candGray.info.width !== resolvedWidth || candGray.info.height !== resolvedHeight);

  return {
    width: resolvedWidth,
    height: resolvedHeight,
    resized,
    baseGray: new Uint8Array(baseGray.data.buffer, baseGray.data.byteOffset, baseGray.data.byteLength),
    candGray: new Uint8Array(candGray.data.buffer, candGray.data.byteOffset, candGray.data.byteLength),
    baseBlur: new Uint8Array(baseBlur.data.buffer, baseBlur.data.byteOffset, baseBlur.data.byteLength),
    candBlur: new Uint8Array(candBlur.data.buffer, candBlur.data.byteOffset, candBlur.data.byteLength),
    smallWidth: baseSmall.info.width,
    smallHeight: baseSmall.info.height,
    baseSmall: new Uint8Array(baseSmall.data.buffer, baseSmall.data.byteOffset, baseSmall.data.byteLength),
    candSmall: new Uint8Array(candSmall.data.buffer, candSmall.data.byteOffset, candSmall.data.byteLength),
  };
}
