import sharp from "sharp";

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
  options: BuildValidationBuffersOptions = {}
): Promise<ValidationBuffers> {
  const blurSigma = Number.isFinite(options.blurSigma) ? Number(options.blurSigma) : 0.8;
  const smallSize = Number.isFinite(options.smallSize) ? Number(options.smallSize) : 512;

  const baseMeta = await sharp(basePath).metadata();
  if (!baseMeta.width || !baseMeta.height) {
    throw new Error("Failed to read base image dimensions");
  }
  const width = baseMeta.width;
  const height = baseMeta.height;

  const baseSharp = sharp(basePath).greyscale();
  const candSharp = sharp(candPath).greyscale();

  // Ensure candidate is normalized to base dimensions once
  const candNormalized = candSharp.clone().resize(width, height, { fit: "fill" });

  const baseGrayPromise = baseSharp.clone().raw().toBuffer({ resolveWithObject: true });
  const candGrayPromise = candNormalized.clone().raw().toBuffer({ resolveWithObject: true });

  const baseBlurPromise = baseSharp.clone().blur(blurSigma).raw().toBuffer({ resolveWithObject: true });
  const candBlurPromise = candNormalized.clone().blur(blurSigma).raw().toBuffer({ resolveWithObject: true });

  const baseSmallPromise = baseSharp
    .clone()
    .resize(smallSize, smallSize, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const candSmallPromise = candNormalized
    .clone()
    .resize(smallSize, smallSize, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const [baseGray, candGray, baseBlur, candBlur, baseSmall, candSmall] = await Promise.all([
    baseGrayPromise,
    candGrayPromise,
    baseBlurPromise,
    candBlurPromise,
    baseSmallPromise,
    candSmallPromise,
  ]);

  baseSharp.destroy();
  candSharp.destroy();

  const resized = (candGray.info.width !== width || candGray.info.height !== height);

  return {
    width,
    height,
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
