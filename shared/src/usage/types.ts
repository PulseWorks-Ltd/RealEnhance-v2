// shared/src/usage/types.ts
// Usage tracking types for analytics and soft warnings

export type UsageStage = "1A" | "1B" | "2" | "edit" | "region-edit";

export interface UsageEvent {
  id: string;
  userId: string;
  agencyId?: string | null;
  jobId: string;
  imageId?: string | null;
  stage: UsageStage;
  modelUsed?: string | null;
  roomType?: string | null;
  sceneType?: string | null;
  declutter?: boolean | null;
  staging?: boolean | null;
  listingId?: string | null;
  createdAt: string; // ISO
}

export interface MonthlyRollup {
  images: number; // Total image outputs
  listings: number; // Distinct listingIds
  stage_1A: number;
  stage_1B: number;
  stage_2: number;
  stage_edit: number;
  stage_region_edit: number;
}

export interface UsageWarning {
  agencyId: string;
  month: string; // YYYY-MM
  kind: "approaching_limit" | "over_limit";
  metric: "listings" | "images";
  used: number;
  limit: number;
  thresholdPct: number;
  createdAt: string;
}
