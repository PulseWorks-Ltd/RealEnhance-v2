// server/src/services/images.ts
import * as crypto from "node:crypto";
import type {
  ImageRecord,
  ImageVersionEntry,
  ImageVersion,
  ImageId,
  UserId,
} from "../shared/types.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

type ImagesState = Record<ImageId, ImageRecord>;

function loadAllImages(): ImagesState {
  return readJsonFile<ImagesState>("images.json", {});
}

function saveAllImages(state: ImagesState): void {
  writeJsonFile("images.json", state);
}

export function createImageRecord(params: {
  userId: UserId;
  originalPath: string;
  roomType?: string;
  sceneType?: string;
}): ImageRecord {
  const state = loadAllImages();

  const imageId: ImageId = "img_" + crypto.randomUUID();
  const versionId = "ver_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const version: ImageVersionEntry = {
    versionId,
    stageLabel: "uploaded",
    filePath: params.originalPath,
    createdAt: now,
    note: undefined,
  };

  const record: ImageRecord = {
    id: imageId,
    imageId, // mirror id for legacy callers
    ownerUserId: params.userId,
    currentVersionId: versionId,
    history: [version],
    originalPath: params.originalPath,
    versions: { original: params.originalPath },
    meta: {
      roomType: params.roomType,
      sceneType: params.sceneType,
    },
    createdAt: now,
    updatedAt: now,
  };

  state[imageId] = record;
  saveAllImages(state);

  return record;
}

export function addImageVersion(
  imageId: ImageId,
  data: { stageLabel: string; filePath: string; note?: string }
): { versionId: string; record: ImageRecord } {
  const state = loadAllImages();
  const rec = state[imageId];
  if (!rec) throw new Error("Image not found");

  const versionId = "ver_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const version: ImageVersion = {
    versionId,
    stageLabel: data.stageLabel,
    filePath: data.filePath,
    createdAt: now,
    note: data.note,
  };

  rec.history.push(version);
  rec.currentVersionId = versionId;
  rec.updatedAt = now;

  state[imageId] = rec;
  saveAllImages(state);

  return { versionId, record: rec };
}

export function getImageRecord(imageId: ImageId): ImageRecord | undefined {
  const state = loadAllImages();
  return state[imageId];
}

export function listImagesForUser(userId: UserId): ImageRecord[] {
  const state = loadAllImages();
  return Object.values(state).filter((img) => img.ownerUserId === userId);
}

export function undoLastEdit(imageId: ImageId): ImageRecord | undefined {
  const state = loadAllImages();
  const rec = state[imageId];
  if (!rec) return;

  if (rec.history.length <= 1) {
    // can't undo if there's only one version
    return rec;
  }

  rec.history.pop();
  const newLast = rec.history[rec.history.length - 1]!;
  rec.currentVersionId = newLast.versionId;
  rec.updatedAt = new Date().toISOString();

  state[imageId] = rec;
  saveAllImages(state);

  return rec;
}
