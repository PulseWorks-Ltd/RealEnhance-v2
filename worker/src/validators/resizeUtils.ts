import sharp from "sharp";

export async function ensureSameSizeAsBase(basePath: string, candidatePath: string): Promise<string> {
  const baseMeta = await sharp(basePath).metadata();
  const candMeta = await sharp(candidatePath).metadata();
  if (!baseMeta.width || !baseMeta.height || !candMeta.width || !candMeta.height) {
    return candidatePath;
  }
  if (baseMeta.width === candMeta.width && baseMeta.height === candMeta.height) {
    return candidatePath;
  }
  const resizedPath = candidatePath.replace(/\.webp$/, "-resized.webp");
  await sharp(candidatePath)
    .resize(baseMeta.width, baseMeta.height, { fit: "fill" })
    .toFile(resizedPath);
  return resizedPath;
}
