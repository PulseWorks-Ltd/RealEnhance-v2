import { readJsonFile, writeJsonFile } from "./jsonStore";

export interface RecordEnhancedImageOpts {
  userId: string;
  imageId: string;
  publicUrl: string;
  baseKey: string;
  versionId: string;
  extra?: Record<string, any>;
}

export async function recordEnhancedImage({
  userId,
  imageId,
  publicUrl,
  baseKey,
  versionId,
  extra = {},
}: RecordEnhancedImageOpts) {
  const imagesPath = "images.json";
  const images = readJsonFile(imagesPath, {});

  let rec = (images as any)[imageId];
  if (!rec) {
    rec = {
      imageId,
      ownerUserId: userId,
      history: [],
    };
    (images as any)[imageId] = rec;
  }

  if (!rec.history.some((h: any) => h.publicUrl === publicUrl || h.baseKey === baseKey)) {
    rec.history.push({
      publicUrl,
      baseKey,
      versionId,
      ...extra,
      ts: Date.now(),
    });
    await writeJsonFile(imagesPath, images);
    console.log("[recordEnhancedImage] Added history for", {
      imageId,
      publicUrl,
      baseKey,
      versionId,
    });
  }
}
