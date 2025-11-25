import { readJsonFile, writeJsonFile } from "../../shared/src/jsonStore.js";

type ImagesState = Record<
  string,
  {
    imageId: string;
    ownerUserId: string;
    history: Array<{
      publicUrl: string;
      versionId: string;
      ts: number;
      [key: string]: any;
    }>;
  }
>;

const IMAGES_DB = "images.json";

export async function recordEnhancedImage(params: {
  userId: string;
  imageId: string;
  publicUrl: string;
  versionId: string;
  extra?: Record<string, any>;
}) {
  const { userId, imageId, publicUrl, versionId, extra = {} } = params;

  const images = readJsonFile<ImagesState>(IMAGES_DB, {});

  let rec = images[imageId];
  if (!rec) {
    rec = {
      imageId,
      ownerUserId: userId,
      history: [],
    };
    images[imageId] = rec;
  }

  // Avoid duplicate entries for same URL/version
  if (!rec.history.some((h: any) => h.publicUrl === publicUrl && h.versionId === versionId)) {
    rec.history.push({
      publicUrl,
      versionId,
      ts: Date.now(),
      ...extra,
    });

    await writeJsonFile(IMAGES_DB, images);
    console.log("[recordEnhancedImage] Added history", { imageId, versionId });
  } else {
    console.log("[recordEnhancedImage] History already present", { imageId, versionId });
  }
}
