// shared/src/usageTracker.ts
// Internal usage tracking for analytics and future plan enforcement
// This does NOT block execution - it's purely for metrics

export interface UsageEvent {
  userId: string;
  jobId: string;
  imageId?: string;
  stage: "1A" | "1B" | "2" | "edit" | "region-edit";
  imagesProcessed: number;
  modelUsed?: string;
  listingId?: string; // Future: track which listing this belongs to
  createdAt: string;
}

export interface UsageStats {
  userId: string;
  monthlyImages: number;
  monthlyListings: number;
  lastReset: string;
}

// Log-only tracking - never throws, never blocks
export function recordUsageEvent(event: Partial<UsageEvent>): void {
  try {
    const fullEvent: UsageEvent = {
      userId: event.userId || "unknown",
      jobId: event.jobId || "unknown",
      imageId: event.imageId,
      stage: event.stage || "1A",
      imagesProcessed: event.imagesProcessed || 1,
      modelUsed: event.modelUsed,
      listingId: event.listingId,
      createdAt: event.createdAt || new Date().toISOString(),
    };

    // For now, just log it. In the future, this could write to Redis/DB
    console.log("[USAGE TRACKING]", JSON.stringify(fullEvent));
  } catch (err) {
    // Silently ignore errors - usage tracking must never break execution
    console.error("[USAGE TRACKING] Failed to record event:", err);
  }
}

// Helper to infer listing usage from job metadata (future use)
export function inferListingUsage(jobPayload: any): {
  listingId?: string;
  imagesInListing: number;
} {
  // For now, return defaults. In the future, extract from job metadata
  return {
    listingId: jobPayload.listingId,
    imagesInListing: 1,
  };
}
