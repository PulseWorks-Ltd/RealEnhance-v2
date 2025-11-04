import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  JobRecord,
  JobId,
  ImageRecord,
  ImageVersion,
  ImageId,
  UserId
} from "@realenhance/shared/dist/types";

function dataDir() {
  return process.env.DATA_DIR || path.resolve(process.cwd(), "..", "server", "data");
}

function readJSON<T>(fileName: string, fallback: T): T {
  const full = path.join(dataDir(), fileName);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(fileName: string, data: T) {
  const full = path.join(dataDir(), fileName);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
}

// Update job record
export function updateJob(jobId: JobId, patch: Partial<JobRecord> & Record<string, any>) {
  const allJobs = readJSON<Record<JobId, JobRecord>>("jobs.json", {});
  const rec = allJobs[jobId];
  if (!rec) return;
  allJobs[jobId] = {
    ...rec,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  writeJSON("jobs.json", allJobs);
}

// Append new image version
export function pushImageVersion(params: {
  imageId: ImageId;
  userId: UserId;
  stageLabel: string;
  filePath: string;
  note?: string;
}): { versionId: string } {
  const allImages = readJSON<Record<ImageId, ImageRecord>>("images.json", {});
  const rec = allImages[params.imageId];
  if (!rec) throw new Error("image not found");

  const versionId = "v_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const v: ImageVersion = {
    versionId,
    stageLabel: params.stageLabel,
    filePath: params.filePath,
    createdAt: now,
    note: params.note
  };

  rec.history.push(v);
  rec.currentVersionId = versionId;
  rec.updatedAt = now;

  allImages[params.imageId] = rec;
  writeJSON("images.json", allImages);

  return { versionId };
}

export function readImageRecord(imageId: ImageId): ImageRecord | undefined {
  const allImages = readJSON<Record<ImageId, ImageRecord>>("images.json", {});
  return allImages[imageId];
}

// convenience helper
export function getVersionPath(
  imageRecord: ImageRecord,
  versionId: string
): string | undefined {
  const v = imageRecord.history.find(vv => vv.versionId === versionId);
  return v?.filePath;
}

export function getOriginalPath(imageRecord: ImageRecord): string {
  return imageRecord.originalPath;
}
