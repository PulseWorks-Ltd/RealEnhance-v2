import crypto from "node:crypto";
import {
  ImageRecord,
  ImageVersion,
  ImageId,
  UserId
} from "@realenhance/shared/dist/types.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

type ImagesState = Record<ImageId, ImageRecord>;

function loadAll(): ImagesState {
  return readJsonFile<ImagesState>("images.json", {});
}

function saveAll(state: ImagesState) {
  writeJsonFile("images.json", state);
}

export function createImageRecord(params: {
  userId: UserId;
  originalPath: string;
  roomType?: string;
  sceneType?: string;
}): ImageRecord {
  const state = loadAll();
  const imageId = "img_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const record: ImageRecord = {
    imageId,
    ownerUserId: params.userId,
    originalPath: params.originalPath,
    roomType: params.roomType,
    sceneType: params.sceneType,
    history: [],
    currentVersionId: "",
    createdAt: now,
    updatedAt: now
  };

  state[imageId] = record;
  saveAll(state);

  return record;
}

export function addImageVersion(
  imageId: ImageId,
  data: { stageLabel: string; filePath: string; note?: string }
): { versionId: string; record: ImageRecord } {
  const state = loadAll();
  const rec = state[imageId];
  if (!rec) throw new Error("Image not found");

  const versionId = "v_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const version: ImageVersion = {
    versionId,
    stageLabel: data.stageLabel,
    filePath: data.filePath,
    createdAt: now,
    note: data.note
  };

  rec.history.push(version);
  rec.currentVersionId = versionId;
  rec.updatedAt = now;

  state[imageId] = rec;
  saveAll(state);

  return { versionId, record: rec };
}

export function getImageRecord(imageId: ImageId): ImageRecord | undefined {
  const state = loadAll();
  return state[imageId];
}

export function listImagesForUser(userId: UserId): ImageRecord[] {
  const state = loadAll();
  return Object.values(state).filter(img => img.ownerUserId === userId);
}

// Optional: undo route can call this
export function undoLastEdit(imageId: ImageId): ImageRecord | undefined {
  const state = loadAll();
  const rec = state[imageId];
  if (!rec) return;

  if (rec.history.length <= 1) {
    // can't undo if there's only one version
    return rec;
  }

  rec.history.pop();
  const newLast = rec.history[rec.history.length - 1];
  rec.currentVersionId = newLast.versionId;
  rec.updatedAt = new Date().toISOString();

  state[imageId] = rec;
  saveAll(state);

  return rec;
}
