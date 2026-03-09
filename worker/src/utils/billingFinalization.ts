/**
 * Worker-side billing finalization
 * Calls the billing service to finalize charges based on stage completion
 */

import { finalizeImageCharge, type StageFlags } from "@realenhance/shared";
import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 5 }) : null;

const BILLING_LEDGER_RETRY_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.BILLING_LEDGER_RETRY_INTERVAL_MS || 30_000)
);
const BILLING_LEDGER_RETRY_BATCH_SIZE = Math.max(
  1,
  Number(process.env.BILLING_LEDGER_RETRY_BATCH_SIZE || 20)
);
const BILLING_LEDGER_STALE_PROCESSING_SECONDS = Math.max(
  60,
  Number(process.env.BILLING_LEDGER_STALE_PROCESSING_SECONDS || 600)
);

let ledgerTableInitPromise: Promise<void> | null = null;
let billingRetryTimer: NodeJS.Timeout | null = null;
let retrySweepRunning = false;

type BillingLedgerRow = {
  event_id: string;
  job_id: string;
  stage_flags: StageFlags;
  attempts: number;
};

async function ensureBillingLedgerTable(): Promise<void> {
  if (!pool) return;
  if (!ledgerTableInitPromise) {
    ledgerTableInitPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS billing_finalization_ledger (
          event_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          stage_flags JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          next_retry_at TIMESTAMPTZ,
          processed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_billing_ledger_retry
          ON billing_finalization_ledger (status, next_retry_at, created_at)
      `);
    })().catch((err) => {
      ledgerTableInitPromise = null;
      throw err;
    });
  }
  await ledgerTableInitPromise;
}

function normalizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 1_000);
}

function computeRetryDelaySeconds(attemptNumber: number): number {
  const base = 30;
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(15 * 60, base * Math.pow(2, exponent));
}

function buildLedgerEventId(jobId: string, stageFlags: StageFlags): string {
  const fingerprint = JSON.stringify({ jobId, stageFlags });
  const hash = createHash("sha1").update(fingerprint).digest("hex").slice(0, 16);
  return `billing:${jobId}:${hash}`;
}

async function processBillingLedgerEvent(eventId: string, source: "inline" | "retry"): Promise<void> {
  if (!pool) {
    return;
  }

  await ensureBillingLedgerTable();

  const claim = await pool.query<BillingLedgerRow>(
    `
      UPDATE billing_finalization_ledger
         SET status = 'processing',
             updated_at = NOW()
       WHERE event_id = $1
         AND (
           status IN ('pending', 'failed')
           OR (status = 'processing' AND updated_at <= NOW() - ($2 * INTERVAL '1 second'))
         )
     RETURNING event_id, job_id, stage_flags, attempts
    `,
    [eventId, BILLING_LEDGER_STALE_PROCESSING_SECONDS]
  );

  if (!claim.rowCount) {
    return;
  }

  const row = claim.rows[0];
  const nextAttempt = Number(row.attempts || 0) + 1;

  try {
    const result = await finalizeImageCharge({
      jobId: row.job_id,
      stageFlags: row.stage_flags,
      withTransaction,
    });

    await pool.query(
      `
        UPDATE billing_finalization_ledger
           SET status = 'succeeded',
               attempts = $2,
               last_error = NULL,
               next_retry_at = NULL,
               processed_at = NOW(),
               updated_at = NOW()
         WHERE event_id = $1
      `,
      [eventId, nextAttempt]
    );

    if (result.alreadyFinalized) {
      console.log(`[BILLING] Charge already finalized for job ${row.job_id}: ${result.amount} credits`);
    } else if (result.charged) {
      console.log(`[BILLING] Finalized charge for job ${row.job_id}: ${result.amount} credits (reason: ${result.reason})`);
    } else {
      console.log(`[BILLING] No charge for job ${row.job_id}: ${result.reason}`);
    }
  } catch (err) {
    const errorMessage = normalizeErrorMessage(err);
    const retryDelaySeconds = computeRetryDelaySeconds(nextAttempt);
    await pool.query(
      `
        UPDATE billing_finalization_ledger
           SET status = 'failed',
               attempts = $2,
               last_error = $3,
               next_retry_at = NOW() + ($4 * INTERVAL '1 second'),
               updated_at = NOW()
         WHERE event_id = $1
      `,
      [eventId, nextAttempt, errorMessage, retryDelaySeconds]
    );

    console.error(
      `[BILLING] Finalization attempt failed for event ${eventId} (source=${source}, attempt=${nextAttempt}, retryIn=${retryDelaySeconds}s):`,
      err
    );
  }
}

async function processDueBillingLedgerEvents(limit: number): Promise<void> {
  if (!pool) return;
  await ensureBillingLedgerTable();

  const due = await pool.query<{ event_id: string }>(
    `
      SELECT event_id
        FROM billing_finalization_ledger
       WHERE (
         (status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
         OR (status = 'processing' AND updated_at <= NOW() - ($2 * INTERVAL '1 second'))
       )
       ORDER BY created_at ASC
       LIMIT $1
    `,
    [limit, BILLING_LEDGER_STALE_PROCESSING_SECONDS]
  );

  for (const row of due.rows) {
    await processBillingLedgerEvent(row.event_id, "retry");
  }
}

export function startBillingFinalizationRetryLoop(): void {
  if (!pool) {
    console.warn("[BILLING_LEDGER] Retry loop disabled: DATABASE_URL not configured");
    return;
  }

  if (billingRetryTimer) {
    return;
  }

  billingRetryTimer = setInterval(() => {
    if (retrySweepRunning) return;
    retrySweepRunning = true;
    void processDueBillingLedgerEvents(BILLING_LEDGER_RETRY_BATCH_SIZE)
      .catch((err) => {
        console.error("[BILLING_LEDGER] Retry sweep failed:", err);
      })
      .finally(() => {
        retrySweepRunning = false;
      });
  }, BILLING_LEDGER_RETRY_INTERVAL_MS);

  billingRetryTimer.unref?.();

  // Trigger one immediate sweep at startup to reconcile previous failures.
  void processDueBillingLedgerEvents(BILLING_LEDGER_RETRY_BATCH_SIZE).catch((err) => {
    console.error("[BILLING_LEDGER] Initial retry sweep failed:", err);
  });
}

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
  /** Whether the user explicitly selected declutter/Stage1B before submission */
  stage1BUserSelected?: boolean;
  /** Whether Gemini confirmed hasFurniture=true during the routing gate */
  geminiHasFurniture?: boolean;
}): Promise<void> {
  if (!pool) {
    console.error(`[BILLING] Error queueing charge finalization for job ${params.jobId}: DATABASE_URL is required`);
    return;
  }

  const stageFlags: StageFlags = {
    stage1A: params.stage1ASuccess,
    stage1B: params.stage1BSuccess,
    stage2: params.stage2Success,
    sceneType: params.sceneType,
    stage1BUserSelected: params.stage1BUserSelected,
    geminiHasFurniture: params.geminiHasFurniture,
  };

  const eventId = buildLedgerEventId(params.jobId, stageFlags);

  try {
    await ensureBillingLedgerTable();
    await pool.query(
      `
        INSERT INTO billing_finalization_ledger (
          event_id,
          job_id,
          stage_flags,
          status,
          attempts,
          next_retry_at,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3::jsonb, 'pending', 0, NOW(), NOW(), NOW())
        ON CONFLICT (event_id)
        DO UPDATE
          SET stage_flags = EXCLUDED.stage_flags,
              updated_at = NOW()
      `,
      [eventId, params.jobId, JSON.stringify(stageFlags)]
    );
  } catch (err) {
    console.error(`[BILLING_LEDGER] Failed to queue billing event for job ${params.jobId}:`, err);
    return;
  }

  // Non-blocking processing attempt. Retries are handled by the background sweep.
  void processBillingLedgerEvent(eventId, "inline").catch((err) => {
    console.error(`[BILLING_LEDGER] Inline processing failed for event ${eventId}:`, err);
  });
}
