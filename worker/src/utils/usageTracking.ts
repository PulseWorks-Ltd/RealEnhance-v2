// worker/src/utils/usageTracking.ts
// Helper functions for recording usage events from the worker

import { recordUsageEvent, UsageStage } from "@realenhance/shared";
import type { EnhanceJobPayload, EditJobPayload, RegionEditJobPayload } from "@realenhance/shared/types";

/**
 * Extract agencyId from user data (best-effort)
 * This would ideally fetch from a user service, but for now we'll pass it through payload
 */
async function getAgencyIdForUser(userId: string): Promise<string | null> {
  // TODO: In a real implementation, this would query the user service
  // For now, we expect agencyId to be passed in the payload if available
  return null;
}

/**
 * Record usage for an enhance job stage
 */
export async function recordEnhanceStageUsage(
  payload: EnhanceJobPayload,
  stage: UsageStage,
  agencyId?: string | null
): Promise<void> {
  try {
    await recordUsageEvent({
      userId: payload.userId,
      agencyId: agencyId || (await getAgencyIdForUser(payload.userId)),
      jobId: payload.jobId,
      imageId: payload.imageId,
      stage,
      modelUsed: "gemini-2.0-flash-exp", // or extract from config
      roomType: payload.options?.roomType || null,
      sceneType: typeof payload.options?.sceneType === 'string' ? payload.options.sceneType : null,
      declutter: payload.options?.declutter || null,
      staging: payload.options?.virtualStage || null,
      listingId: payload.listingId || null,
    });
  } catch (err) {
    // Best-effort logging - never block the job
    console.error(`[USAGE] Failed to record ${stage} usage (non-blocking):`, err);
  }
}

/**
 * Record usage for an edit job
 */
export async function recordEditUsage(
  payload: EditJobPayload,
  agencyId?: string | null
): Promise<void> {
  try {
    await recordUsageEvent({
      userId: payload.userId,
      agencyId: agencyId || (await getAgencyIdForUser(payload.userId)),
      jobId: payload.jobId,
      imageId: payload.imageId,
      stage: "edit",
      modelUsed: "gemini-2.0-flash-exp",
      roomType: null,
      sceneType: null,
      declutter: null,
      staging: payload.allowStaging || null,
      listingId: payload.listingId || null,
    });
  } catch (err) {
    console.error("[USAGE] Failed to record edit usage (non-blocking):", err);
  }
}

/**
 * Record usage for a region-edit job
 */
export async function recordRegionEditUsage(
  payload: RegionEditJobPayload,
  agencyId?: string | null
): Promise<void> {
  try {
    await recordUsageEvent({
      userId: payload.userId,
      agencyId: agencyId || (await getAgencyIdForUser(payload.userId)),
      jobId: payload.jobId,
      imageId: payload.imageId,
      stage: "region-edit",
      modelUsed: "gemini-2.0-flash-exp",
      roomType: null,
      sceneType: null,
      declutter: null,
      staging: null,
      listingId: payload.listingId || null,
    });
  } catch (err) {
    console.error("[USAGE] Failed to record region-edit usage (non-blocking):", err);
  }
}
