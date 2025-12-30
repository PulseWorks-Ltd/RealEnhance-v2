// server/src/services/imageRetention.ts
// Silent, agency-level rolling image retention

import type { ImageId, ImageRecord } from "../shared/types.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import { getRetentionLimit } from "@realenhance/shared/plans.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";
import * as fs from "node:fs";
import * as path from "node:path";

type ImagesState = Record<ImageId, ImageRecord>;

function loadAllImages(): ImagesState {
  return readJsonFile<ImagesState>("images.json", {});
}

function saveAllImages(state: ImagesState): void {
  writeJsonFile("images.json", state);
}

/**
 * Get all images for an agency, sorted by creation date (oldest first)
 */
export function getAgencyImages(agencyId: string): ImageRecord[] {
  const state = loadAllImages();
  return Object.values(state)
    .filter((img) => img.agencyId === agencyId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/**
 * Delete an image record and its associated files
 * @param imageId - The image ID to delete
 * @param reason - Reason for deletion (for logging)
 */
async function deleteImage(imageId: ImageId, reason: string): Promise<void> {
  const state = loadAllImages();
  const image = state[imageId];

  if (!image) {
    console.log(`[RETENTION] Image ${imageId} not found for deletion (${reason})`);
    return;
  }

  // Delete all version files
  const filesToDelete = new Set<string>();
  if (image.originalPath) {
    filesToDelete.add(image.originalPath);
  }

  for (const version of image.history) {
    if (version.filePath) {
      filesToDelete.add(version.filePath);
    }
  }

  // Delete files from disk
  for (const filePath of filesToDelete) {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        console.log(`[RETENTION] Deleted file: ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.error(`[RETENTION] Failed to delete file ${filePath}:`, err);
      // Continue with deletion even if file removal fails
    }
  }

  // Remove from database
  delete state[imageId];
  saveAllImages(state);

  console.log(
    `[RETENTION] Deleted image ${imageId} (${reason}) - Agency: ${image.agencyId}, Created: ${image.createdAt}`
  );
}

/**
 * Enforce retention limit for an agency
 * Silently deletes oldest images when limit is exceeded
 *
 * @param agencyId - The agency ID to enforce retention for
 * @param planTier - The agency's current plan tier
 * @returns Number of images deleted
 */
export async function enforceRetentionLimit(
  agencyId: string,
  planTier: PlanTier
): Promise<number> {
  const retentionLimit = getRetentionLimit(planTier);
  const agencyImages = getAgencyImages(agencyId);

  const currentCount = agencyImages.length;
  const excessCount = currentCount - retentionLimit;

  if (excessCount <= 0) {
    // Within limit, no action needed
    return 0;
  }

  // Delete oldest images until within limit
  const imagesToDelete = agencyImages.slice(0, excessCount);

  console.log(
    `[RETENTION] Agency ${agencyId} exceeded retention limit (${currentCount}/${retentionLimit}). Deleting ${excessCount} oldest images.`
  );

  for (const image of imagesToDelete) {
    await deleteImage(
      image.imageId,
      `retention enforcement (plan: ${planTier}, limit: ${retentionLimit})`
    );
  }

  console.log(
    `[RETENTION] Agency ${agencyId} retention enforcement complete. Deleted ${excessCount} images.`
  );

  return excessCount;
}

/**
 * Get retention statistics for an agency
 * For internal monitoring/debugging only - NOT exposed to frontend
 */
export function getRetentionStats(agencyId: string, planTier: PlanTier): {
  currentCount: number;
  retentionLimit: number;
  utilizationPercent: number;
  oldestImageDate: string | null;
  newestImageDate: string | null;
} {
  const retentionLimit = getRetentionLimit(planTier);
  const agencyImages = getAgencyImages(agencyId);

  return {
    currentCount: agencyImages.length,
    retentionLimit,
    utilizationPercent: (agencyImages.length / retentionLimit) * 100,
    oldestImageDate: agencyImages[0]?.createdAt || null,
    newestImageDate: agencyImages[agencyImages.length - 1]?.createdAt || null,
  };
}
