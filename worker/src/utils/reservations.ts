import { consumeBundleImages, getTotalBundleRemaining } from "@realenhance/shared/usage/imageBundles.js";
import { withTransaction } from "../db/index.js";

const STALE_COMMITTED_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.STALE_COMMITTED_SWEEP_INTERVAL_MS || 5 * 60 * 1000)
);
const STALE_COMMITTED_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.STALE_COMMITTED_TTL_MS || 30 * 60 * 1000)
);

let staleCommittedSweepTimer: NodeJS.Timeout | null = null;

export async function finalizeReservationFromWorker(params: {
  jobId: string;
  stage12Success: boolean;
  stage2Success: boolean;
  actualCharge?: number;
}): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query(`SELECT * FROM job_reservations WHERE job_id = $1 FOR UPDATE`, [params.jobId]);
    if (res.rowCount === 0) return;
    const jr = res.rows[0];

    // Idempotency guard: if reservation is already in a terminal state, skip all accounting.
    // 'consumed'  → all stages were committed; a late crash-recovery refund must not claw them back.
    // 'released'  → all stages were already refunded; a second failure call must not double-refund.
    // 'partially_released' is intentionally allowed through so a stage2-only retry can re-consume
    // the previously-refunded stage2 portion.
    const rs = String(jr.reservation_status || "");
    if (rs === "consumed" || rs === "released") {
      console.warn(`[DOUBLE_FINALIZATION_ATTEMPT] type=reservation jobId=${params.jobId} reservationStatus=${rs}`);
      console.log(
        `[RESERVATION] Already finalized (${rs}) for job ${params.jobId} — skipping duplicate call`
      );
      return;
    }

    // Reservation never committed means no prior deduction exists.
    // Mark as released and exit without touching usage counters.
    if (rs === "reserved") {
      await client.query(
        `UPDATE job_reservations
           SET reservation_status = 'released',
               stage12_consumed = FALSE,
               stage2_consumed = FALSE,
               updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId]
      );
      return;
    }

    const usageRes = await client.query(
      `SELECT * FROM agency_month_usage WHERE agency_id = $1 AND yyyymm = $2 FOR UPDATE`,
      [jr.agency_id, jr.yyyymm]
    );
    if (usageRes.rowCount === 0) return;
    const usage = usageRes.rows[0];

    const acctRes = await client.query(`SELECT * FROM agency_accounts WHERE agency_id = $1 FOR UPDATE`, [jr.agency_id]);
    const acct = acctRes.rows[0];

    let deltaAddonConsume = 0;
    let deltaAddonRefund = 0;

    // Reconcile reservation to actual charge when provided.
    // Positive delta: reserve additional usage.
    // Negative delta: refund excess reservation.
    if (typeof params.actualCharge === "number" && Number.isFinite(params.actualCharge)) {
      const reservedImages = Math.max(0, Number(jr.reserved_images || 0));
      const actualImages = Math.max(0, Number(params.actualCharge));
      const delta = actualImages - reservedImages;

      if (delta !== 0) {
        const includedRemaining = Math.max(0, Number(usage.included_limit || 0) - Number(usage.included_used || 0));
        const addonRemaining = Math.max(0, Number(await getTotalBundleRemaining(jr.agency_id, jr.yyyymm)));

        if (delta > 0) {
          let need = delta;
          const takeAddon = Math.min(need, addonRemaining);
          need -= takeAddon;
          const takeIncluded = Math.min(need, includedRemaining);
          need -= takeIncluded;

          if (need > 0) {
            throw new Error(`reservation_delta_insufficient_balance: needed=${delta} available=${takeAddon + takeIncluded}`);
          }

          await client.query(
            `UPDATE agency_month_usage
               SET included_used = included_used + $1,
                   addon_used = addon_used + $2,
                   updated_at = NOW()
             WHERE agency_id = $3 AND yyyymm = $4`,
            [takeIncluded, takeAddon, jr.agency_id, jr.yyyymm]
          );
          await client.query(
            `UPDATE agency_accounts
               SET addon_images_balance = addon_images_balance - $1,
                   updated_at = NOW()
             WHERE agency_id = $2`,
            [takeAddon, jr.agency_id]
          );

          deltaAddonConsume += takeAddon;

          await client.query(
            `UPDATE job_reservations
               SET reserved_images = reserved_images + $1,
                   reserved_from_included = reserved_from_included + $2,
                   reserved_from_addon = reserved_from_addon + $3,
                   updated_at = NOW()
             WHERE job_id = $4`,
            [delta, takeIncluded, takeAddon, params.jobId]
          );
        } else {
          const refundTotal = Math.abs(delta);
          const refundableAddon = Math.min(refundTotal, Math.max(0, Number(jr.reserved_from_addon || 0)));
          const refundableIncluded = Math.min(refundTotal - refundableAddon, Math.max(0, Number(jr.reserved_from_included || 0)));

          if (refundableIncluded > 0 || refundableAddon > 0) {
            await client.query(
              `UPDATE agency_month_usage
                 SET included_used = included_used - $1,
                     addon_used = addon_used - $2,
                     updated_at = NOW()
               WHERE agency_id = $3 AND yyyymm = $4`,
              [refundableIncluded, refundableAddon, jr.agency_id, jr.yyyymm]
            );
            await client.query(
              `UPDATE agency_accounts
                 SET addon_images_balance = addon_images_balance + $1,
                     updated_at = NOW()
               WHERE agency_id = $2`,
              [refundableAddon, jr.agency_id]
            );

            deltaAddonRefund += refundableAddon;

            await client.query(
              `UPDATE job_reservations
                 SET reserved_images = reserved_images - $1,
                     reserved_from_included = reserved_from_included - $2,
                     reserved_from_addon = reserved_from_addon - $3,
                     updated_at = NOW()
               WHERE job_id = $4`,
              [refundTotal, refundableIncluded, refundableAddon, params.jobId]
            );
          }
        }
      }
    }

    let refundIncluded = 0;
    let refundAddon = 0;
    let consumeStage12 = false;
    let consumeStage2 = false;

    if (jr.requested_stage12) {
      if (params.stage12Success) {
        consumeStage12 = true;
      } else {
        refundIncluded += jr.stage12_from_included;
        refundAddon += jr.stage12_from_addon;
      }
    }

    if (jr.requested_stage2) {
      if (params.stage2Success) {
        consumeStage2 = true;
      } else {
        refundIncluded += jr.stage2_from_included;
        refundAddon += jr.stage2_from_addon;
      }
    }

    if (refundIncluded > 0 || refundAddon > 0) {
      await client.query(
        `UPDATE agency_month_usage
           SET included_used = included_used - $1,
               addon_used = addon_used - $2,
               updated_at = NOW()
         WHERE agency_id = $3 AND yyyymm = $4`,
        [refundIncluded, refundAddon, jr.agency_id, jr.yyyymm]
      );
      await client.query(
        `UPDATE agency_accounts
           SET addon_images_balance = addon_images_balance + $1,
               updated_at = NOW()
         WHERE agency_id = $2`,
        [refundAddon, jr.agency_id]
      );
    }

    if (consumeStage12) {
      await client.query(
        `UPDATE agency_month_usage
           SET stage12_used = stage12_used + 1,
               updated_at = NOW()
         WHERE agency_id = $1 AND yyyymm = $2`,
        [jr.agency_id, jr.yyyymm]
      );
    }
    if (consumeStage2) {
      await client.query(
        `UPDATE agency_month_usage
           SET stage2_used = stage2_used + 1,
               updated_at = NOW()
         WHERE agency_id = $1 AND yyyymm = $2`,
        [jr.agency_id, jr.yyyymm]
      );
    }

    // Consume add-on bundles (FIFO) to keep Redis bundle balance in sync
    const addonToConsume = Math.max(0, (consumeStage12 ? jr.stage12_from_addon : 0) + (consumeStage2 ? jr.stage2_from_addon : 0) + deltaAddonConsume - deltaAddonRefund);
    if (addonToConsume > 0) {
      await consumeBundleImages(jr.agency_id, addonToConsume, jr.yyyymm);
    }

    const newStatus = params.stage12Success && (!jr.requested_stage2 || params.stage2Success)
      ? "consumed"
      : (!params.stage12Success && (!jr.requested_stage2 || !params.stage2Success))
      ? "released"
      : "partially_released";

    await client.query(
      `UPDATE job_reservations
         SET reservation_status = $1,
             stage12_consumed = $2,
             stage2_consumed = $3,
             updated_at = NOW()
       WHERE job_id = $4`,
      [newStatus, consumeStage12, consumeStage2, params.jobId]
    );
  });
}

export async function reconcileStaleCommittedReservations(limit = 100): Promise<{ scanned: number; refunded: number }> {
  const cutoffIso = new Date(Date.now() - STALE_COMMITTED_TTL_MS).toISOString();
  const staleJobs = await withTransaction(async (client) => {
    const res = await client.query(
      `SELECT job_id
         FROM job_reservations
        WHERE reservation_status = 'committed'
          AND updated_at < $1
        ORDER BY updated_at ASC
        LIMIT $2`,
      [cutoffIso, Math.max(1, limit)]
    );
    return res.rows.map((r) => String((r as any).job_id || "")).filter(Boolean);
  });

  let refunded = 0;
  for (const jobId of staleJobs) {
    try {
      await finalizeReservationFromWorker({
        jobId,
        stage12Success: false,
        stage2Success: false,
      });
      refunded += 1;
      console.warn(`[STALE_COMMITTED_REFUND] jobId=${jobId} ttlMs=${STALE_COMMITTED_TTL_MS}`);
    } catch (err) {
      console.error(`[STALE_COMMITTED_REFUND_ERROR] jobId=${jobId}`, err);
    }
  }

  return { scanned: staleJobs.length, refunded };
}

export function startStaleCommittedReservationSweepLoop(): void {
  if (staleCommittedSweepTimer) return;

  const runSweep = async () => {
    try {
      const result = await reconcileStaleCommittedReservations();
      if (result.scanned > 0) {
        console.log(
          `[STALE_COMMITTED_SWEEP] scanned=${result.scanned} refunded=${result.refunded} ttlMs=${STALE_COMMITTED_TTL_MS}`
        );
      }
    } catch (err) {
      console.error("[STALE_COMMITTED_SWEEP_ERROR]", err);
    }
  };

  runSweep().catch(() => {});
  staleCommittedSweepTimer = setInterval(() => {
    runSweep().catch(() => {});
  }, STALE_COMMITTED_SWEEP_INTERVAL_MS);
}
