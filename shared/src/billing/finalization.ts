/**
 * Billing Finalization Logic (Database Operations)
 * 
 * Implements idempotent charge finalization with database persistence
 * 
 * NOTE: This module is intended for use by server-side code that has
 * direct database access. It uses the server's database pool.
 */

import { pool, withTransaction } from "../../../server/src/db/index.js";
import type { PoolClient } from "pg";
import { computeCharge, type StageFlags } from "./rules.js
import { pool, withTransaction } from "../../../server/src/db/index.js";
import type { PoolClient } from "pg";
import { computeCharge } from "./rules.js";
import type { StageFlags } from "./rules.js";

export type { StageFlags } from "./rules.js";

export interface ChargeResult {
  charged: boolean;
  amount: number;
  reason: string;
  alreadyFinalized: boolean;
}

/**
 * Finalize charge for an image with idempotent guard
 * 
 * CRITICAL: This function must be idempotent - calling it multiple times
 * for the same jobId must not result in double-charging
 */
export async function finalizeImageCharge(params: {
  jobId: string;
  stageFlags: StageFlags;
}): Promise<ChargeResult> {
  return await withTransaction(async (client: PoolClient) => {
    // Lock the job reservation row
    const res = await client.query(
      `SELECT * FROM job_reservations WHERE job_id = $1 FOR UPDATE`,
      [params.jobId]
    );

    if (res.rowCount === 0) {
      console.warn(`[CREDIT_FINALIZE_WARN] No reservation found for job ${params.jobId}`);
      return {
        charged: false,
        amount: 0,
        reason: "no_reservation",
        alreadyFinalized: false,
      };
    }

    const reservation = res.rows[0];

    // Idempotent guard: check if already finalized
    if (reservation.charge_finalized) {
      console.log(
        `[CREDIT_SKIPPED_ALREADY_FINALIZED] jobId=${params.jobId} ` +
        `previousCharge=${reservation.charge_amount} ` +
        `reason=${reservation.charge_log}`
      );
      return {
        charged: false,
        amount: reservation.charge_amount,
        reason: "already_finalized",
        alreadyFinalized: true,
      };
    }

    // Compute charge based on stages
    const { amount, reason } = computeCharge(params.stageFlags);

    // Update reservation with finalized charge
    await client.query(
      `UPDATE job_reservations
       SET charge_finalized = TRUE,
           charge_amount = $1,
           charge_computed_at = NOW(),
           stage1a_success = $2,
           stage1b_success = $3,
           stage2_success = $4,
           scene_type = $5,
           charge_log = $6,
           updated_at = NOW()
       WHERE job_id = $7`,
      [
        amount,
        params.stageFlags.stage1A,
        params.stageFlags.stage1B,
        params.stageFlags.stage2,
        params.stageFlags.sceneType,
        reason,
        params.jobId,
      ]
    );

    // Log structured event
    console.log(
      `[CREDIT_FINALIZED] ` +
      `jobId=${params.jobId} ` +
      `imageId=${reservation.agency_id || "unknown"} ` +
      `sceneType=${params.stageFlags.sceneType} ` +
      `stage1A=${params.stageFlags.stage1A} ` +
      `stage1B=${params.stageFlags.stage1B} ` +
      `stage2=${params.stageFlags.stage2} ` +
      `charge=${amount} ` +
      `reason=${reason}`
    );

    return {
      charged: true,
      amount,
      reason,
      alreadyFinalized: false,
    };
  });
}
