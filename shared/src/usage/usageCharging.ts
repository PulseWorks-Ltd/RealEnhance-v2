// shared/src/usage/usageCharging.ts
// Main usage charging logic with fingerprinting and deduplication

import {
  incrementUsage,
  getRemainingUsage,
  getCurrentMonthKey,
  type AgencyUsageMonthly,
} from "./monthlyUsage.js";
import {
  recordBillableUsageEvent,
  computeUsageFingerprint,
  type StageType,
  type UsageFingerprintParams,
} from "./usageEvents.js";

export interface ChargeUsageParams {
  agencyId: string;
  userId: string;
  stageType: StageType;
  jobId?: string;
  imageId?: string;
  // Parameters for fingerprinting
  fingerprintParams: UsageFingerprintParams;
}

export interface ChargeUsageResult {
  charged: boolean;
  reason?: string;
  mainUsed?: number;
  stagingUsed?: number;
  mainRemaining?: number;
  stagingRemaining?: number;
  usedStagingBundle?: boolean;
  fingerprint?: string;
}

/**
 * Charge usage for a completed output
 * This is the main entry point for charging usage from the worker
 */
export async function chargeUsageForOutput(
  params: ChargeUsageParams
): Promise<ChargeUsageResult> {
  const monthKey = getCurrentMonthKey();

  try {
    console.log(
      `[USAGE] Attempting to charge ${params.stageType} for agency ${params.agencyId} job ${params.jobId}`
    );

    // Record usage event (with fingerprint deduplication)
    const eventResult = await recordBillableUsageEvent(
      {
        agencyId: params.agencyId,
        userId: params.userId,
        stageType: params.stageType,
        fingerprintParams: params.fingerprintParams,
        jobId: params.jobId,
        imageId: params.imageId,
      },
      monthKey
    );

    if (!eventResult.charged) {
      console.log(
        `[USAGE] Skipped charging: ${eventResult.reason || "unknown"}`
      );
      return {
        charged: false,
        reason: eventResult.reason,
      };
    }

    const fingerprint = eventResult.event?.fingerprint;

    // Determine which pool to charge
    if (params.stageType === "STAGE1") {
      // Stage 1 always charges main pool
      const updatedUsage = await incrementUsage(
        params.agencyId,
        "main",
        1,
        monthKey
      );
      const remaining = await getRemainingUsage(params.agencyId, monthKey);

      console.log(
        `[USAGE] ✅ Charged STAGE1: mainUsed=${updatedUsage.mainUsed}/${updatedUsage.mainAllowance}, remaining=${remaining.mainRemaining}`
      );

      return {
        charged: true,
        mainUsed: updatedUsage.mainUsed,
        mainRemaining: remaining.mainRemaining,
        stagingUsed: updatedUsage.stagingUsed,
        stagingRemaining: remaining.stagingRemaining,
        fingerprint,
      };
    } else if (params.stageType === "STAGE2") {
      // Stage 2: Use staging bundle first, then fall back to main pool
      const remaining = await getRemainingUsage(params.agencyId, monthKey);

      if (remaining.stagingRemaining > 0) {
        // Use staging bundle
        const updatedUsage = await incrementUsage(
          params.agencyId,
          "staging",
          1,
          monthKey
        );
        const newRemaining = await getRemainingUsage(params.agencyId, monthKey);

        console.log(
          `[USAGE] ✅ Charged STAGE2 from staging bundle: stagingUsed=${updatedUsage.stagingUsed}/${updatedUsage.stagingAllowance}, remaining=${newRemaining.stagingRemaining}`
        );

        return {
          charged: true,
          usedStagingBundle: true,
          mainUsed: updatedUsage.mainUsed,
          mainRemaining: newRemaining.mainRemaining,
          stagingUsed: updatedUsage.stagingUsed,
          stagingRemaining: newRemaining.stagingRemaining,
          fingerprint,
        };
      } else {
        // Staging bundle exhausted, use main pool
        const updatedUsage = await incrementUsage(
          params.agencyId,
          "main",
          1,
          monthKey
        );
        const newRemaining = await getRemainingUsage(params.agencyId, monthKey);

        console.log(
          `[USAGE] ✅ Charged STAGE2 from main pool (staging bundle exhausted): mainUsed=${updatedUsage.mainUsed}/${updatedUsage.mainAllowance}, remaining=${newRemaining.mainRemaining}`
        );

        return {
          charged: true,
          usedStagingBundle: false,
          mainUsed: updatedUsage.mainUsed,
          mainRemaining: newRemaining.mainRemaining,
          stagingUsed: updatedUsage.stagingUsed,
          stagingRemaining: newRemaining.stagingRemaining,
          fingerprint,
        };
      }
    }

    return {
      charged: false,
      reason: "unknown_stage_type",
    };
  } catch (err) {
    console.error("[USAGE] Error charging usage:", err);
    // Return failure but don't throw - usage charging should never break the worker
    return {
      charged: false,
      reason: "error",
    };
  }
}

/**
 * Helper to create fingerprint params from job payload
 */
export function createFingerprintFromEnhanceJob(payload: any): UsageFingerprintParams {
  return {
    agencyId: payload.agencyId || "",
    userId: payload.userId,
    baseImageId: payload.imageId,
    originalUrl: payload.remoteOriginalUrl,
    stageType: "STAGE1", // Will be overridden by caller
    declutter: payload.options?.declutter,
    virtualStage: payload.options?.virtualStage,
    roomType: payload.options?.roomType,
    stagingStyle: payload.options?.stagingStyle,
    sceneType: payload.options?.sceneType,
    replaceSky: payload.options?.replaceSky,
    declutterMode: payload.options?.declutterMode,
    declutterStrength: payload.options?.declutterStrength,
  };
}
