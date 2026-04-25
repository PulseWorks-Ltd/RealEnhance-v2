import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Queue } from "bullmq";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { pool } from "../db/index.js";
import { createImageRecord } from "../services/images.js";
import { cancelEnqueuedJob, enqueueEnhanceJob, getJob } from "../services/jobs.js";
import { addImageToUser, getUserById } from "../services/users.js";
import { commitReservation, releaseReservation, reserveAllowance } from "../services/usageLedger.js";
import { uploadOriginalToS3 } from "../utils/s3.js";

const WAIT_TIMEOUT_MS = 15_000;
const WAIT_INTERVAL_MS = 1_000;

function timingSafeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function readBearerToken(req: Request): string | null {
  const raw = String(req.headers.authorization || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function requireInternalApiKey(req: Request, res: Response, next: Function) {
  const expectedKey = String(process.env.INTERNAL_API_KEY || "").trim();
  if (!expectedKey) {
    return res.status(503).json({ error: "internal_api_not_configured" });
  }

  const token = readBearerToken(req);
  if (!token || !timingSafeEqual(token, expectedKey)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveExtension(imageUrl: string, contentType: string | null): string {
  const normalizedType = String(contentType || "").toLowerCase();
  if (normalizedType.includes("image/png")) return ".png";
  if (normalizedType.includes("image/webp")) return ".webp";
  if (normalizedType.includes("image/jpeg") || normalizedType.includes("image/jpg")) return ".jpg";

  try {
    const pathname = new URL(imageUrl).pathname;
    const ext = path.extname(pathname || "").toLowerCase();
    if ([".png", ".webp", ".jpg", ".jpeg"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    // Ignore URL parse failures and fall back to jpg.
  }

  return ".jpg";
}

async function downloadRemoteImage(params: {
  imageUrl: string;
  destinationDir: string;
}): Promise<{ localPath: string; contentType: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(params.imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`remote_fetch_failed:${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error("remote_fetch_not_image");
    }

    const ext = deriveExtension(params.imageUrl, contentType);
    const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
    const localPath = path.join(params.destinationDir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(localPath, buffer);
    return { localPath, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

function getCompletedImageUrl(job: any): string | null {
  const status = String(job?.status || "").toLowerCase();
  if (!["complete", "completed", "done"].includes(status)) {
    return null;
  }

  const url = job?.finalOutputUrl || job?.resultUrl || job?.imageUrl || null;
  return typeof url === "string" && url.trim().length > 0 ? url : null;
}

function normalizeInternalJobState(state: string | null): "processing" | "completed" | "failed" {
  switch (String(state || "").toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "processing";
  }
}

async function readInternalJobStatus(jobId: string): Promise<
  | { status: "processing" }
  | { status: "completed"; resultUrl: string }
  | { status: "failed"; error: string }
  | null
> {
  const local = await getJob(jobId);
  const localRecord = local as any;

  let queueState: string | null = null;
  let queueReturnValue: any = null;
  let queueFailedReason: string | undefined;

  try {
    const queue = new Queue(JOB_QUEUE_NAME, {
      connection: { url: REDIS_URL },
    });
    const queueJob = await queue.getJob(jobId);
    if (queueJob) {
      queueState = await queueJob.getState();
      queueReturnValue = queueJob.returnvalue || null;
      queueFailedReason = queueJob.failedReason || undefined;
    }
    await queue.close();
  } catch {
    // Fall back to the persisted job record when queue inspection is unavailable.
  }

  if (!local && !queueState && !queueReturnValue && !queueFailedReason) {
    return null;
  }

  const persistedStatus = String(local?.status || "").trim();
  const normalizedPersisted = normalizeInternalJobState(persistedStatus || null);
  const normalizedQueue = normalizeInternalJobState(queueState);
  const resultUrl = String(
    queueReturnValue?.finalOutputUrl
    || queueReturnValue?.resultUrl
    || localRecord?.finalOutputUrl
    || localRecord?.resultUrl
    || localRecord?.imageUrl
    || ""
  ).trim();
  const error = String(localRecord?.errorMessage || queueFailedReason || "Job failed").trim();

  if ((normalizedPersisted === "completed" || normalizedQueue === "completed") && resultUrl) {
    return {
      status: "completed",
      resultUrl,
    };
  }

  if (normalizedPersisted === "failed" || normalizedQueue === "failed") {
    return {
      status: "failed",
      error,
    };
  }

  return { status: "processing" };
}

async function getInternalUserOrThrow() {
  const internalUserId = String(process.env.INTERNAL_API_USER_ID || "").trim();
  if (!internalUserId) {
    throw new Error("internal_api_user_not_configured");
  }

  const internalUser = await getUserById(internalUserId as any);
  if (!internalUser) {
    throw new Error("internal_api_user_not_found");
  }

  if (internalUser.isSystemUser !== true) {
    throw new Error("internal_api_user_not_system_user");
  }

  const agencyId = String(process.env.INTERNAL_API_AGENCY_ID || internalUser.agencyId || "").trim();
  if (!agencyId) {
    throw new Error("internal_api_agency_not_configured");
  }

  return {
    internalUserId,
    internalUser,
    agencyId,
  };
}

export function internalEnhanceRouter() {
  const router = Router();

  router.get("/status", requireInternalApiKey, async (req: Request, res: Response) => {
    const jobId = String(req.query?.jobId || "").trim();
    if (!jobId) {
      return res.status(400).json({ error: "jobId_required" });
    }

    try {
      const status = await readInternalJobStatus(jobId);
      if (!status) {
        return res.status(404).json({ error: "job_not_found" });
      }
      return res.json(status);
    } catch (err) {
      console.error("[internal-status] failed", { jobId, err });
      return res.status(500).json({ error: "internal_status_failed" });
    }
  });

  router.post("/enhance", requireInternalApiKey, async (req: Request, res: Response) => {
    const imageUrl = String(req.body?.imageUrl || "").trim();
    const roomTypeRaw = String(req.body?.roomType || "").trim();
    const roomType = roomTypeRaw || "unknown";
    const isExterior = typeof req.body?.isExterior === "boolean" ? req.body.isExterior : undefined;

    if (!imageUrl) {
      return res.status(400).json({ error: "imageUrl_required" });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      return res.status(400).json({ error: "invalid_imageUrl" });
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "invalid_imageUrl_protocol" });
    }

    let internalConfig;
    try {
      internalConfig = await getInternalUserOrThrow();
    } catch (err: any) {
      return res.status(503).json({ error: err?.message || "internal_api_user_invalid" });
    }

    const { internalUserId, agencyId } = internalConfig;
    const sceneType = typeof isExterior === "boolean"
      ? (isExterior ? "exterior" : "interior")
      : "auto";
    const uploadsDir = path.join(process.cwd(), "server", "uploads", internalUserId, "internal");

    try {
      await fs.mkdir(uploadsDir, { recursive: true });

      const { localPath } = await downloadRemoteImage({
        imageUrl,
        destinationDir: uploadsDir,
      });

      const imageRecord = createImageRecord({
        userId: internalUserId as any,
        agencyId,
        originalPath: localPath,
        roomType,
        sceneType,
      });
      const imageId = (imageRecord as any).imageId ?? (imageRecord as any).id;
      await addImageToUser(internalUserId as any, imageId);

      const uploadedOriginal = await uploadOriginalToS3(localPath);
      const declutter = true;
      const virtualStage = true;
      const declutterMode = declutter ? (virtualStage ? "stage-ready" : "light") : undefined;
      const jobId = `job_${crypto.randomUUID()}`;

      await reserveAllowance({
        jobId,
        agencyId,
        userId: internalUserId,
        requiredImages: 1,
        requestedStage12: true,
        requestedStage2: virtualStage,
      });

      let enqueued = false;
      try {
        await enqueueEnhanceJob({
          userId: internalUserId as any,
          imageId,
          agencyId,
          remoteOriginalUrl: uploadedOriginal.url,
          remoteOriginalKey: uploadedOriginal.key,
          options: {
            declutter,
            declutterMode,
            virtualStage,
            roomType,
            sceneType,
          },
        }, jobId);
        enqueued = true;
        await commitReservation({ jobId });
      } catch (err) {
        if (enqueued) {
          await cancelEnqueuedJob(jobId, "internal_enqueue_failed").catch(() => undefined);
        }
        await releaseReservation({ jobId }).catch(() => undefined);
        throw err;
      }

      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const job = await getJob(jobId);
        const enhancedImageUrl = getCompletedImageUrl(job);
        if (enhancedImageUrl) {
          return res.json({
            status: "completed",
            jobId,
            enhancedImageUrl,
          });
        }

        if (String(job?.status || "").toLowerCase() === "failed") {
          return res.status(502).json({
            error: "enhancement_failed",
            jobId,
          });
        }

        await sleep(WAIT_INTERVAL_MS);
      }

      return res.json({
        status: "processing",
        jobId,
      });
    } catch (err: any) {
      console.error("[internal/enhance] failed", err?.message || err);
      return res.status(500).json({ error: "internal_enhance_failed" });
    }
  });

  router.get("/usage", requireInternalApiKey, async (_req: Request, res: Response) => {
    try {
      const { internalUserId, internalUser } = await getInternalUserOrThrow();
      let jobsProcessed = 0;

      try {
        const usageRes = await pool.query(
          `SELECT COUNT(*)::int AS total
             FROM job_reservations
            WHERE user_id = $1`,
          [internalUserId]
        );
        jobsProcessed = Math.max(0, Number(usageRes.rows[0]?.total || 0));
      } catch (err) {
        console.warn("[internal/usage] failed to query job_reservations", err);
      }

      return res.json({
        totalCreditsUsed: Math.max(0, Number(internalUser.creditUsageCount || 0)),
        jobsProcessed,
        userId: internalUserId,
      });
    } catch (err: any) {
      return res.status(503).json({ error: err?.message || "internal_api_user_invalid" });
    }
  });

  return router;
}