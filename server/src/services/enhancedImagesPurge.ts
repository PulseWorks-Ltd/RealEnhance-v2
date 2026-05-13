// server/src/services/enhancedImagesPurge.ts
// Async purge worker: physically deletes S3 objects for soft-deleted enhanced images
// after a configurable delay window (default 7 days) for accidental-delete recovery.
//
// Safety rules:
//  - Only processes rows where deleted_at IS NOT NULL AND purge_status = 'pending'
//    AND deleted_at < NOW() - INTERVAL '{N} days'
//  - Before deleting any S3 key, confirms zero live rows (deleted_at IS NULL)
//    reference the key across all three columns (original_s3_key, enhanced_s3_key, thumb_s3_key)
//  - On any per-row error, marks purge_status = 'failed' and continues with next row
//  - Sets purge_status = 'purged' only when all keys are handled without error
//  - Sets purge_status = 'skipped' when all keys are still referenced by a live row

import { pool } from '../db/index.js';
import { deleteS3Object } from '../utils/s3.js';

const PURGE_DELAY_DAYS = Math.max(
  1,
  Number(process.env.ENHANCED_IMAGE_PURGE_DELAY_DAYS || 7)
);
const PURGE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.ENHANCED_IMAGE_PURGE_BATCH_SIZE || 50)
);
// Hard cap: maximum number of batch iterations per scheduled invocation.
// Prevents runaway purge from monopolising server resources when the queue grows unexpectedly.
const MAX_BATCHES_PER_CYCLE = Math.max(
  1,
  Number(process.env.ENHANCED_IMAGE_MAX_BATCHES_PER_CYCLE || 5)
);
// Hard cap: wall-clock milliseconds before a scheduled invocation stops, regardless of remaining rows.
const MAX_PURGE_RUNTIME_MS = Math.max(
  1_000,
  Number(process.env.ENHANCED_IMAGE_MAX_PURGE_RUNTIME_MS || 30_000)
);

interface PurgeCycleResult {
  processed: number;
  purged: number;
  skipped: number;
  failed: number;
}

/**
 * Check whether a given S3 key is still referenced by any non-deleted row.
 * We check all three key columns because the same key can be stored under different
 * column names in parent vs. child records (e.g., a parent's enhanced_s3_key may
 * become a child's original_s3_key after a region-edit).
 */
async function hasLiveReference(key: string, excludeId: string): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM enhanced_images
      WHERE deleted_at IS NULL
        AND id != $1
        AND (
          original_s3_key = $2
          OR enhanced_s3_key = $2
          OR thumb_s3_key = $2
        )`,
    [excludeId, key]
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * Run one purge cycle: fetch a batch of soft-deleted rows that are past the
 * delay window and attempt to physically delete their S3 objects.
 */
export async function runEnhancedImagePurgeCycle(): Promise<PurgeCycleResult> {
  const stats: PurgeCycleResult = { processed: 0, purged: 0, skipped: 0, failed: 0 };

  let rows: Array<{
    id: string;
    original_s3_key: string | null;
    enhanced_s3_key: string | null;
    thumb_s3_key: string | null;
    audit_ref: string | null;
  }>;

  try {
    const result = await pool.query(
      `SELECT id, original_s3_key, enhanced_s3_key, thumb_s3_key, audit_ref
         FROM enhanced_images
        WHERE deleted_at IS NOT NULL
          AND purge_status = 'pending'
          AND deleted_at < NOW() - INTERVAL '${PURGE_DELAY_DAYS} days'
        ORDER BY deleted_at ASC
        LIMIT $1`,
      [PURGE_BATCH_SIZE]
    );
    rows = result.rows;
  } catch (err) {
    console.error('[purge] failed to fetch pending purge rows:', err);
    return stats;
  }

  if (rows.length === 0) return stats;

  for (const row of rows) {
    stats.processed += 1;
    const rowId = String(row.id);
    const keys = [row.original_s3_key, row.enhanced_s3_key, row.thumb_s3_key]
      .filter((k): k is string => typeof k === 'string' && k.length > 0);

    // Deduplicate keys — a row may store the same key in multiple columns
    const uniqueKeys = [...new Set(keys)];

    try {
      let anyKeyDeleted = false;
      let anyKeySkipped = false;

      for (const key of uniqueKeys) {
        const liveRef = await hasLiveReference(key, rowId);
        if (liveRef) {
          anyKeySkipped = true;
          console.log(`[purge] skipping key (live reference exists): ${key} (row=${rowId})`);
          continue;
        }

        try {
          await deleteS3Object(key);
          anyKeyDeleted = true;
          console.log(`[purge] deleted S3 key: ${key} (row=${rowId} auditRef=${row.audit_ref ?? 'n/a'})`);
        } catch (s3Err) {
          console.error(`[purge] S3 delete failed for key ${key} (row=${rowId}):`, s3Err);
          throw s3Err; // propagate to outer catch so the row is marked failed
        }
      }

      const newStatus: string =
        uniqueKeys.length === 0
          ? 'purged'        // no keys to delete (row had no S3 assets)
          : anyKeySkipped && !anyKeyDeleted
            ? 'skipped'
            : 'purged';

      await pool.query(
        `UPDATE enhanced_images
            SET purge_status = $2,
                purged_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [rowId, newStatus]
      );

      if (newStatus === 'purged') {
        stats.purged += 1;
      } else {
        stats.skipped += 1;
      }
    } catch (err) {
      console.error(`[purge] error processing row ${rowId}:`, err);
      stats.failed += 1;

      try {
        await pool.query(
          `UPDATE enhanced_images
              SET purge_status = 'failed',
                  updated_at = NOW()
            WHERE id = $1`,
          [rowId]
        );
      } catch (updateErr) {
        console.error(`[purge] also failed to mark row ${rowId} as failed:`, updateErr);
      }
    }
  }

  if (stats.processed > 0) {
    console.log(
      `[purge] cycle complete: processed=${stats.processed} purged=${stats.purged} skipped=${stats.skipped} failed=${stats.failed}`
    );
  }

  return stats;
}

/**
 * Run up to MAX_BATCHES_PER_CYCLE batch iterations, stopping early if the
 * queue is empty or MAX_PURGE_RUNTIME_MS wall-clock time has elapsed.
 * This is the function the scheduler calls on each tick.
 */
async function runBoundedPurgeCycles(): Promise<void> {
  const deadline = Date.now() + MAX_PURGE_RUNTIME_MS;
  const totals: PurgeCycleResult = { processed: 0, purged: 0, skipped: 0, failed: 0 };

  for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch += 1) {
    if (Date.now() >= deadline) {
      console.warn(
        `[purge] runtime cap reached after ${batch} batch(es) — deferring remaining rows to next cycle` +
        ` (maxBatches=${MAX_BATCHES_PER_CYCLE} maxRuntimeMs=${MAX_PURGE_RUNTIME_MS})`
      );
      break;
    }

    const result = await runEnhancedImagePurgeCycle();
    totals.processed += result.processed;
    totals.purged    += result.purged;
    totals.skipped   += result.skipped;
    totals.failed    += result.failed;

    // Queue is empty — nothing left to do this cycle
    if (result.processed === 0) break;
  }

  if (totals.processed > 0) {
    console.log(
      `[purge] invocation summary: processed=${totals.processed} purged=${totals.purged}` +
      ` skipped=${totals.skipped} failed=${totals.failed}`
    );
  }
}

/**
 * Start a periodic purge loop.
 * Returns a stop function that clears the interval.
 */
export function startEnhancedImagePurgeScheduler(): () => void {
  const INTERVAL_MS = Math.max(
    60_000,
    Number(process.env.ENHANCED_IMAGE_PURGE_INTERVAL_MS || 60 * 60 * 1000) // default: 1 hour
  );

  console.log(
    `[purge] scheduler started — interval=${INTERVAL_MS}ms delayDays=${PURGE_DELAY_DAYS}` +
    ` batchSize=${PURGE_BATCH_SIZE} maxBatchesPerCycle=${MAX_BATCHES_PER_CYCLE} maxRuntimeMs=${MAX_PURGE_RUNTIME_MS}`
  );

  // Run once immediately so recently-expired rows don't wait a full interval on first deploy
  void runBoundedPurgeCycles().catch((err) => {
    console.error('[purge] initial cycle failed:', err);
  });

  const timer = setInterval(() => {
    void runBoundedPurgeCycles().catch((err) => {
      console.error('[purge] scheduled cycle failed:', err);
    });
  }, INTERVAL_MS);

  // Allow the process to exit even if this timer is pending
  timer.unref?.();

  return () => clearInterval(timer);
}
