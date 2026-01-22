import { withTransaction } from "../db/index.js";
import { consumeBundleImages } from "@realenhance/shared/usage/imageBundles.js";

export async function finalizeReservationFromWorker(params: {
  jobId: string;
  stage12Success: boolean;
  stage2Success: boolean;
}): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query(`SELECT * FROM job_reservations WHERE job_id = $1 FOR UPDATE`, [params.jobId]);
    if (res.rowCount === 0) return;
    const jr = res.rows[0];

    const usageRes = await client.query(
      `SELECT * FROM agency_month_usage WHERE agency_id = $1 AND yyyymm = $2 FOR UPDATE`,
      [jr.agency_id, jr.yyyymm]
    );
    if (usageRes.rowCount === 0) return;
    const usage = usageRes.rows[0];

    const acctRes = await client.query(`SELECT * FROM agency_accounts WHERE agency_id = $1 FOR UPDATE`, [jr.agency_id]);
    const acct = acctRes.rows[0];

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

    // Consume bundle allowance from Redis on success
    const addonToConsume = (consumeStage12 ? jr.stage12_from_addon : 0) + (consumeStage2 ? jr.stage2_from_addon : 0);
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
