import { getUserById } from "./users.js";
import { getUsageSnapshot, reserveAllowance } from "./usageLedger.js";
import { enqueueStoredEnhanceJob, listAwaitingPaymentEnhanceJobs } from "./jobs.js";
import { getTrialSummary } from "./trials.js";

export async function getAvailableCredits(userId: string): Promise<number> {
  const user = await getUserById(userId);
  const agencyId = user?.agencyId;
  if (!agencyId) return 0;

  const [usage, trial] = await Promise.all([
    getUsageSnapshot(agencyId),
    getTrialSummary(agencyId),
  ]);

  const now = Date.now();
  const trialActive =
    trial.status === "active" &&
    (!trial.expiresAt || Number.isNaN(Date.parse(trial.expiresAt)) || Date.parse(trial.expiresAt) > now);

  const usageRemaining = Math.max(0, Number(usage.remaining || 0));
  const trialRemaining = trialActive ? Math.max(0, Number(trial.remaining || 0)) : 0;

  // During promo trial, trial credits are additive to normal usage allowance.
  return usageRemaining + trialRemaining;
}

export async function releaseAwaitingPaymentJobs(userId: string): Promise<{
  released: number;
  remainingAwaiting: number;
  releasedJobIds: string[];
}> {
  const user = await getUserById(userId);
  const agencyId = user?.agencyId;
  if (!agencyId) {
    return { released: 0, remainingAwaiting: 0, releasedJobIds: [] };
  }

  const awaiting = await listAwaitingPaymentEnhanceJobs(userId);
  const releasedJobIds: string[] = [];

  for (const pending of awaiting) {
    const available = await getAvailableCredits(userId);
    if (available < 1) break;

    const payload: any = pending.payload || {};
    const requestedStage2 = !!payload?.options?.virtualStage;

    try {
      await reserveAllowance({
        jobId: pending.jobId,
        agencyId,
        userId,
        requiredImages: 1,
        requestedStage12: true,
        requestedStage2,
      });

      const enqueued = await enqueueStoredEnhanceJob(pending.jobId);
      if (enqueued.enqueued) {
        releasedJobIds.push(pending.jobId);
      }
    } catch (err: any) {
      if (err?.code === "QUOTA_EXCEEDED") {
        break;
      }
      console.error(`[AWAITING_PAYMENT] Failed to release job ${pending.jobId}:`, err?.message || err);
    }
  }

  const remainingAwaiting = Math.max(0, awaiting.length - releasedJobIds.length);
  return {
    released: releasedJobIds.length,
    remainingAwaiting,
    releasedJobIds,
  };
}
