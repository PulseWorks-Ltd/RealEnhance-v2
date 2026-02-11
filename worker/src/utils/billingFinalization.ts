/**
 * Worker-side billing finalization
 * Calls the billing service to finalize charges based on stage completion
 */

import { finalizeImageCharge, type StageFlags } from "@realenhance/shared";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 5 }) : null;

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) {
    throw new Error("DATABASE_URL is required for billing finalization");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[billing] rollback failed", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function finalizeImageChargeFromWorker(params: {
  jobId: string;
  stage1ASuccess: boolean;
  stage1BSuccess: boolean;
  stage2Success: boolean;
  sceneType: string;
}): Promise<void> {
  try {
    const stageFlags: StageFlags = {
      stage1A: params.stage1ASuccess,
      stage1B: params.stage1BSuccess,
      stage2: params.stage2Success,
      sceneType: params.sceneType,
    };

    const result = await finalizeImageCharge({
      jobId: params.jobId,
      stageFlags,
      withTransaction,
    });

    if (result.alreadyFinalized) {
      console.log(`[BILLING] Charge already finalized for job ${params.jobId}: ${result.amount} credits`);
    } else if (result.charged) {
      console.log(`[BILLING] Finalized charge for job ${params.jobId}: ${result.amount} credits (reason: ${result.reason})`);
    } else {
      console.log(`[BILLING] No charge for job ${params.jobId}: ${result.reason}`);
    }
  } catch (err) {
    console.error(`[BILLING] Error finalizing charge for job ${params.jobId}:`, err);
    // Don't throw - billing errors should not crash the worker
  }
}
