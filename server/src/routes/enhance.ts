import { Router, type Request, type Response } from "express";
import { estimateBatchCredits } from "@realenhance/shared/billing/rules.js";
import { getAvailableCredits } from "../services/awaitingPayment.js";
import { enqueueStoredEnhanceJob, getJob, updateJob } from "../services/jobs.js";
import { reserveAllowance } from "../services/usageLedger.js";
import { getUserById } from "../services/users.js";

function deriveRequiredCreditsFromJobPayload(payload: any): number {
  const options = payload?.options || {};
  const virtualStage = !!options?.virtualStage;
  const declutter = !!options?.declutter;
  const furnishedState = String(options?.furnishedState || "").toLowerCase();

  // Match upload-side projection: declutter+stage with empty room can skip Stage 1B (1 credit total).
  const stage1BProjected = declutter && (!virtualStage || furnishedState !== "empty");

  return estimateBatchCredits([
    {
      sceneType: "interior",
      userSelectedStage1B: stage1BProjected,
      userSelectedStage2: virtualStage,
    },
  ]);
}

function isExpired(expiresAt: unknown): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(String(expiresAt));
  if (!Number.isFinite(ts)) return false;
  return Date.now() > ts;
}

export function enhanceRouter() {
  const router = Router();

  router.post("/preflight", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const requestedCountRaw = Number(req.body?.requestedCount);
    const imageIds = Array.isArray(req.body?.imageIds) ? req.body.imageIds : [];
    const jobId = String(req.body?.jobId || "").trim() || undefined;
    const requestedCount = Number.isFinite(requestedCountRaw)
      ? Math.max(1, Math.floor(requestedCountRaw))
      : Math.max(1, imageIds.length || 1);

    try {
      const currentCredits = await getAvailableCredits(sessUser.id);
      if (currentCredits >= requestedCount) {
        return res.json({
          status: "ready",
          ...(jobId ? { jobId } : {}),
          requiredCredits: requestedCount,
          currentCredits,
          missingCredits: 0,
        });
      }

      return res.json({
        status: "insufficient_credits",
        ...(jobId ? { jobId } : {}),
        requiredCredits: requestedCount,
        currentCredits,
        missingCredits: Math.max(0, requestedCount - currentCredits),
      });
    } catch (err: any) {
      console.error("[enhance/preflight] failed", err?.message || err);
      return res.status(503).json({
        error: "credit_check_failed",
        message: "Unable to verify available credits",
      });
    }
  });

  router.post("/resume", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const jobId = String(req.body?.jobId || "").trim();
    if (!jobId) {
      return res.status(400).json({ error: "jobId_required" });
    }

    const rec: any = await getJob(jobId);
    if (!rec) {
      return res.status(404).json({ error: "job_not_found" });
    }

    if (String(rec.userId || "") !== String(sessUser.id)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const status = String(rec.status || "");

    if (status === "queued" || status === "processing" || status === "complete") {
      return res.json({ status: "processing", jobId });
    }

    if (status !== "awaiting_payment") {
      return res.status(409).json({ error: "invalid_job_state", status });
    }

    if (isExpired(rec.expiresAt)) {
      await updateJob(jobId as any, {
        status: "cancelled",
        cancelReason: "payment_timeout",
        cancelledAt: new Date().toISOString(),
      });
      return res.status(410).json({ error: "job_expired", reason: "payment_timeout" });
    }

    const requiredCredits = deriveRequiredCreditsFromJobPayload(rec.payload);
    const currentCredits = await getAvailableCredits(sessUser.id);

    if (currentCredits < requiredCredits) {
      return res.json({
        status: "insufficient_credits",
        jobId,
        requiredCredits,
        currentCredits,
        missingCredits: Math.max(0, requiredCredits - currentCredits),
      });
    }

    const user = await getUserById(sessUser.id);
    const agencyId = (rec?.payload?.agencyId as string | undefined) || user?.agencyId;
    if (!agencyId) {
      return res.status(400).json({ error: "agency_required" });
    }

    const requestedStage2 = !!rec?.payload?.options?.virtualStage;

    try {
      await reserveAllowance({
        jobId,
        agencyId,
        userId: sessUser.id,
        requiredImages: requiredCredits,
        requestedStage12: true,
        requestedStage2,
      });

      const enqueued = await enqueueStoredEnhanceJob(jobId);
      if (!enqueued.enqueued) {
        return res.status(409).json({ error: "enqueue_failed" });
      }

      return res.json({ status: "processing", jobId });
    } catch (err: any) {
      if (err?.code === "QUOTA_EXCEEDED") {
        return res.json({
          status: "insufficient_credits",
          jobId,
          requiredCredits,
          currentCredits: await getAvailableCredits(sessUser.id),
          missingCredits: 1,
        });
      }

      console.error("[enhance/resume] failed", err?.message || err);
      return res.status(503).json({ error: "resume_failed" });
    }
  });

  router.post("/cancel", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const jobId = String(req.body?.jobId || "").trim();
    if (!jobId) {
      return res.status(400).json({ error: "jobId_required" });
    }

    const rec: any = await getJob(jobId);
    if (!rec) {
      return res.status(404).json({ error: "job_not_found" });
    }

    if (String(rec.userId || "") !== String(sessUser.id)) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (String(rec.status || "") === "awaiting_payment") {
      await updateJob(jobId as any, {
        status: "cancelled",
        cancelReason: "user_cancelled",
        cancelledAt: new Date().toISOString(),
      });
    }

    return res.json({ status: "cancelled", jobId });
  });

  return router;
}
