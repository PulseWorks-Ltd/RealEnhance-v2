// worker/src/utils/usageBilling.ts
// Helper functions for charging usage from worker job completions

import {
  chargeUsageForOutput,
  createFingerprintFromEnhanceJob,
  type ChargeUsageResult,
} from "@realenhance/shared";
import type { EnhanceJobPayload } from "@realenhance/shared/types";

/**
 * Charge for Stage 1 completion (enhanced image output)
 * Call this after Stage 1B (or 1A if no declutter) has been successfully published
 */
export async function chargeForStage1(
  payload: EnhanceJobPayload,
  agencyId: string | null
): Promise<ChargeUsageResult> {
  if (!agencyId) {
    console.log("[BILLING] No agencyId - skipping Stage 1 charge");
    return { charged: false, reason: "no_agency" };
  }

  try {
    const fingerprintParams = createFingerprintFromEnhanceJob(payload);
    fingerprintParams.stageType = "STAGE1";

    const result = await chargeUsageForOutput({
      agencyId,
      userId: payload.userId,
      stageType: "STAGE1",
      jobId: payload.jobId,
      imageId: payload.imageId,
      fingerprintParams,
    });

    if (result.charged) {
      console.log(
        `[BILLING] ✅ Charged STAGE1 for job ${payload.jobId}: mainRemaining=${result.mainRemaining}`
      );
    } else {
      console.log(
        `[BILLING] Skipped STAGE1 charge for job ${payload.jobId}: ${result.reason}`
      );
    }

    return result;
  } catch (err) {
    console.error("[BILLING] Error charging Stage 1:", err);
    return { charged: false, reason: "error" };
  }
}

/**
 * Charge for Stage 2 completion (virtual staging output)
 * Call this after Stage 2 has been successfully published
 */
export async function chargeForStage2(
  payload: EnhanceJobPayload,
  agencyId: string | null
): Promise<ChargeUsageResult> {
  if (!agencyId) {
    console.log("[BILLING] No agencyId - skipping Stage 2 charge");
    return { charged: false, reason: "no_agency" };
  }

  try {
    const fingerprintParams = createFingerprintFromEnhanceJob(payload);
    fingerprintParams.stageType = "STAGE2";

    const result = await chargeUsageForOutput({
      agencyId,
      userId: payload.userId,
      stageType: "STAGE2",
      jobId: payload.jobId,
      imageId: payload.imageId,
      fingerprintParams,
    });

    if (result.charged) {
      const pool = result.usedStagingBundle ? "staging bundle" : "main pool";
      console.log(
        `[BILLING] ✅ Charged STAGE2 for job ${payload.jobId} from ${pool}: stagingRemaining=${result.stagingRemaining}, mainRemaining=${result.mainRemaining}`
      );
    } else {
      console.log(
        `[BILLING] Skipped STAGE2 charge for job ${payload.jobId}: ${result.reason}`
      );
    }

    return result;
  } catch (err) {
    console.error("[BILLING] Error charging Stage 2:", err);
    return { charged: false, reason: "error" };
  }
}

/**
 * Get agencyId from job payload (passed from server)
 */
export function getAgencyIdFromPayload(payload: any): string | null {
  return payload.agencyId || null;
}
