import { Router, type Request, type Response, type RequestHandler } from "express";
import { Queue } from "bullmq";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createImageRecord } from "../services/images.js";
import { addImageToUser } from "../services/users.js";
import { enqueueEnhanceJob, getJob, updateJob } from "../services/jobs.js";
import { uploadOriginalToS3, extractKeyFromS3Url, copyS3Object } from "../utils/s3.js";
import { recordUsageEvent } from "@realenhance/shared/usageTracker";
import { getJobMetadata, saveJobMetadata } from "@realenhance/shared/imageStore";
import { findByPublicUrlRedis } from "@realenhance/shared";
import { resolveStageUrl, normalizeStageLabel, mergeStageUrls, normalizeStageUrls } from "@realenhance/shared/stageUrlResolver";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { getFreeRetryCount } from "../services/usageLedger.js";
import { findScopedEnhancedImageByUrl } from "../services/enhancedImages.js";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { jobHasEditedArtifact } from "./retry-policy.js";

const uploadRoot = path.join(process.cwd(), "server", "uploads");

// Minimal image validation: check mimetype and magic bytes for common formats (JPEG/PNG/WebP)
async function isLikelyImage(filePath: string, mime?: string | null): Promise<boolean> {
  if (mime && !mime.startsWith("image/")) return false;
  try {
    const fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    await fh.close();
    if (!bytesRead) return false;
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP";
    return isJpeg || isPng || isWebp;
  } catch {
    return false;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(uploadRoot, { recursive: true });
        cb(null, uploadRoot);
      } catch (e) {
        cb(e as Error, uploadRoot);
      }
    },
    filename(_req, file, cb) {
      cb(null, file.originalname);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function toBool(v: any, d = false) {
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  if (typeof v === 'boolean') return v;
  return d;
}

function parseNumber(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseStageList(raw: unknown): Array<"1A" | "1B" | "2"> {
  if (!raw) return [];
  const toCanonical = (stage: unknown): "1A" | "1B" | "2" | null => {
    const s = String(stage || "").trim().toUpperCase();
    if (s === "1A" || s === "1B" || s === "2") return s;
    return null;
  };

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      const out = parsed.map(toCanonical).filter(Boolean) as Array<"1A" | "1B" | "2">;
      return Array.from(new Set(out));
    }
  } catch {
    // Fallback for comma-separated legacy format.
  }

  const csv = String(raw)
    .split(",")
    .map((v) => toCanonical(v))
    .filter(Boolean) as Array<"1A" | "1B" | "2">;
  return Array.from(new Set(csv));
}

function highestStageFrom(stages: Array<"1A" | "1B" | "2">): "1A" | "1B" | "2" | null {
  if (!stages.length) return null;
  if (stages.includes("2")) return "2";
  if (stages.includes("1B")) return "1B";
  if (stages.includes("1A")) return "1A";
  return null;
}

type RetrySourceStage = "original" | "1A" | "1B" | "2" | "retry" | "edit";

function normalizeRetrySourceStage(raw: unknown): RetrySourceStage | null {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v === "original" || v === "original_upload") return "original";
  if (v === "1a" || v === "stage1a") return "1A";
  if (v === "1b" || v === "stage1b") return "1B";
  if (v === "2" || v === "stage2") return "2";
  if (v === "retry" || v === "retry_latest") return "retry";
  if (v === "edit" || v === "edit_latest") return "edit";
  return null;
}

function resolveStage2ModeFromSource(sourceStage: RetrySourceStage): "REFRESH" | "FROM_EMPTY" {
  if (sourceStage === "1A" || sourceStage === "original") return "FROM_EMPTY";
  return "REFRESH";
}

function toEnhanceStage(sourceStage: RetrySourceStage): "1A" | "1B" | "2" {
  if (sourceStage === "1A" || sourceStage === "original") return "1A";
  if (sourceStage === "1B") return "1B";
  return "2";
}

function toRetryPayloadStage(sourceStage: RetrySourceStage): "stage1A" | "stage1B" | "stage2" {
  if (sourceStage === "1A" || sourceStage === "original") return "stage1A";
  if (sourceStage === "1B") return "stage1B";
  return "stage2";
}

async function isRetrySourceReachable(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    return head.ok;
  } catch {
    return false;
  }
}

function normalizePersistedJobStatus(raw: unknown): "completed" | "failed" | "processing" | "queued" | "awaiting_payment" | "unknown" {
  const status = String(raw || "").toLowerCase();
  if (status === "complete" || status === "completed" || status === "done") return "completed";
  if (status === "failed" || status === "error" || status === "cancelled") return "failed";
  if (status === "processing" || status === "active") return "processing";
  if (status === "queued" || status === "waiting" || status === "waiting-children" || status === "delayed") return "queued";
  if (status === "awaiting_payment") return "awaiting_payment";
  return "unknown";
}

async function resolveAuthoritativeStatus(jobId: string): Promise<{
  status: "completed" | "failed" | "processing" | "queued" | "awaiting_payment" | "unknown";
  source: "persisted" | "queue";
}> {
  const persisted = await getJob(jobId);
  const persistedStatus = normalizePersistedJobStatus((persisted as any)?.status);

  if (persistedStatus === "completed" || persistedStatus === "failed") {
    return { status: persistedStatus, source: "persisted" };
  }

  const queue = new Queue(JOB_QUEUE_NAME, {
    connection: { url: REDIS_URL },
  });

  try {
    const job = await queue.getJob(jobId);
    const state = await job?.getState();
    if (state === "completed" || state === "failed") {
      return { status: state, source: "queue" };
    }
  } catch {
    // Ignore queue lookup errors and fall back to persisted state.
  } finally {
    await queue.close().catch(() => {});
  }

  return { status: persistedStatus, source: "persisted" };
}

const CANONICAL_ROOM_TYPES = new Set([
  "bedroom",
  "living_room",
  "dining_room",
  "kitchen",
  "kitchen_dining",
  "kitchen_living",
  "living_dining",
  "multiple_living",
  "study",
  "office",
  "bathroom",
  "bathroom_1",
  "bathroom_2",
  "laundry",
  "garage",
  "basement",
  "attic",
  "hallway",
  "sunroom",
  "staircase",
  "entryway",
  "closet",
  "pantry",
  "outdoor",
  "exterior",
  "other",
  "unknown",
  "auto",
]);

function normalizeRoomType(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "unknown";
  const aliases: Record<string, string> = {
    "bedroom-1": "bedroom",
    "bedroom-2": "bedroom",
    "bedroom-3": "bedroom",
    "bedroom-4": "bedroom",
    "living": "living_room",
    "living-room": "living_room",
    "dining": "dining_room",
    "dining-room": "dining_room",
    "multiple-living-areas": "multiple_living",
    "multiple_living_areas": "multiple_living",
    "multiple-living": "multiple_living",
    "multiple living": "multiple_living",
    "multi-living": "multiple_living",
    "kitchen & dining": "kitchen_dining",
    "kitchen-and-dining": "kitchen_dining",
    "kitchen & living": "kitchen_living",
    "kitchen-and-living": "kitchen_living",
    "living & dining": "living_dining",
    "living-and-dining": "living_dining",
    "bathroom-1": "bathroom_1",
    "bathroom-2": "bathroom_2",
    "sun-room": "sunroom",
  };
  return aliases[value] || value.replace(/-/g, "_");
}

function normalizeStagingStyle(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "standard_listing";

  const aliases: Record<string, string> = {
    nz_standard: "standard_listing",
    "nz standard": "standard_listing",
    "nz standard real estate": "standard_listing",
    nz_standard_real_estate: "standard_listing",
    "standard listing": "standard_listing",
    family_home: "family_home",
    "family home": "family_home",
    urban_apartment: "urban_apartment",
    "urban apartment": "urban_apartment",
    high_end_luxury: "high_end_luxury",
    "high-end luxury": "high_end_luxury",
    "high end luxury": "high_end_luxury",
    country_lifestyle: "country_lifestyle",
    "country lifestyle": "country_lifestyle",
    "country / lifestyle": "country_lifestyle",
    lived_in_rental: "lived_in_rental",
    "lived in rental": "lived_in_rental",
    "lived-in rental": "lived_in_rental",
    "lived-in / rental": "lived_in_rental",
  };

  const normalized = aliases[value] || value.replace(/-/g, "_").replace(/\s+/g, "_");
  return ["standard_listing", "family_home", "urban_apartment", "high_end_luxury", "country_lifestyle", "lived_in_rental"].includes(normalized)
    ? normalized
    : "standard_listing";
}

function isStage1ATainted(parentJob: any, parentMeta: any): boolean {
  const errorMessage = String(parentJob?.errorMessage || "").toUpperCase();
  const jobMeta = (parentJob as any)?.meta || {};
  const savedMeta = parentMeta || {};

  return (
    errorMessage.includes("BLACK_BORDER_STAGE1A") ||
    errorMessage.includes("STAGE1A_TAINTED") ||
    jobMeta?.stage1ATainted === true ||
    savedMeta?.stage1ATainted === true
  );
}

export function retrySingleRouter() {
  const r = Router();

  const uploadMw: RequestHandler = upload.single("image") as unknown as RequestHandler;

  // POST /api/batch/retry-single
  r.post("/batch/retry-single", uploadMw, async (req: Request, res: Response) => {
    try {
      const sessUser = (req.session as any)?.user;
      if (!sessUser) return res.status(401).json({ success: false, error: "not_authenticated" });

      const file = (req.file as Express.Multer.File | undefined);

      // REMOVED: Credit gating - execution is now always allowed
      // Usage tracking happens after job enqueuing

      // Extract form fields
      const body = req.body || {} as any;
      const sceneType = body.sceneType || 'auto';
      const roomType = normalizeRoomType(body.roomType || 'unknown');
      const allowStaging = toBool(body.allowStaging, true);
      const stagingStyle = normalizeStagingStyle(body.stagingStyle);
      const declutter = toBool(body.declutter, false);
      const declutterModeRaw = String(body.declutterMode || '').trim();
      let declutterMode: "light" | "stage-ready" | null = null;
      let declutterModeSource: "form" | "parent_meta" | "none" = "none";
      if (declutterModeRaw === "light" || declutterModeRaw === "stage-ready") {
        declutterMode = declutterModeRaw;
        declutterModeSource = "form";
      }
      const manualSceneOverride = toBool(body.manualSceneOverride, false);
      const replaceSky = sceneType === 'exterior' ? true : undefined; // default sky replacement for exteriors
      const sourceUrlRaw = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
      const sourceStage = normalizeRetrySourceStage(body.sourceStage);
      const uiSelectedTab = typeof body.uiSelectedTab === "string" ? body.uiSelectedTab.trim() : "";
      const incomingImageId = String(body.imageId || "").trim() || null;
      const incomingRetryParentImageId = String(body.retryParentImageId || "").trim() || null;
      const incomingRetryParentJobId = String(body.retryParentJobId || "").trim() || null;
      let parentJobId = String(body.parentJobId || body.retryParentJobId || "").trim() || null;
      let parentImageId = String(body.retryParentImageId || body.imageId || "").trim() || null;
      const clientBatchId = body.clientBatchId || body.batchId || null;
      const stagesToRun = parseStageList(body.stagesToRun);
      const requestedStagesList = parseStageList(body.requestedStages);
      const requestedStageFromPayload = String(body.requestedStage || '').trim().toUpperCase();
      const requestedStage = highestStageFrom(stagesToRun) || (requestedStageFromPayload as "1A" | "1B" | "2" | "") || "2";
      const stagePlanIncludes1A = stagesToRun.includes("1A");
      const stagePlanIncludes1B = stagesToRun.includes("1B");
      const stagePlanIncludes2 = stagesToRun.includes("2");
      const stage2OnlyRequested = stagesToRun.length > 0
        ? (stagePlanIncludes2 && !stagePlanIncludes1A && !stagePlanIncludes1B)
        : requestedStage === "2";
      const effectiveAllowStaging = requestedStage === "2" ? true : !!allowStaging;
      if (!sourceUrlRaw) {
        return res.status(400).json({
          success: false,
          error: "missing_source_url",
          message: "Missing sourceUrl - cannot resolve source image",
        });
      }

      if (!sourceStage) {
        return res.status(400).json({
          success: false,
          error: "missing_source_stage",
          message: "Missing sourceStage - cannot resolve source stage",
        });
      }

      if (!parentJobId) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_requires_stage_source",
          message: "Manual retry requires a parent job to resolve canonical stage baseline",
        });
      }

      console.log("RETRY_REQUEST_INPUT", {
        incomingImageId,
        retryParentImageId: incomingRetryParentImageId,
        retryParentJobId: incomingRetryParentJobId,
      });

      // Optional tuning
      const temperature = parseNumber(body.temperature);
      const topP = parseNumber(body.topP);
      const topK = parseNumber(body.topK);

      if (sceneType !== "exterior" && !CANONICAL_ROOM_TYPES.has(roomType)) {
        return res.status(400).json({ success: false, error: "invalid_room_type", message: "Invalid roomType for interior retry" });
      }

      console.log("[SOURCE_RESOLVED]", {
        sourceUrl: sourceUrlRaw,
        sourceStage,
        uiSelectedTab: uiSelectedTab || null,
        imageId: incomingImageId || null,
      });

      let finalPath = "";
      let remoteOriginalUrl: string | undefined = undefined;
      let remoteOriginalKey: string | undefined = undefined;
      let retrySourceStage: string | undefined = undefined;
      let retrySourceUrl: string | undefined = undefined;
      let retrySourceKey: string | undefined = undefined;
      let selectedSourceStage: "1A" | "1B" | "2" | undefined = undefined;
      let executionSourceStage: "1A" | "1B" | "2" | undefined = undefined;
      let uiSourceStage: "1A" | "1B" | "2" | undefined = undefined;
      let selectedSourceUrl: string | undefined = undefined;
      let originalUploadUrlCandidate: string | undefined = undefined;
      let stage1AFromParent: string | undefined = undefined;
      let stage1BFromParent: string | undefined = undefined;
      let inheritedStageUrls: Record<string, string | null> = {};
      let stage2OnlyDisabled = false;
      let retryFromStage: string | undefined = undefined;
      let retryMode: "stage_resume" | "full_pipeline_restart" = "stage_resume";
      let stage1BWasRequested = toBool(body.stage1BWasRequested, false);
      let rec: any = undefined;
      let parentJob: any = undefined;
      let parentMeta: any = undefined;

      if (parentJobId) {
        const bucket = process.env.S3_BUCKET;
        if (!bucket) {
          return res.status(400).json({ success: false, error: "s3_not_configured", message: "S3 bucket is required to retry from a stage output" });
        }

        if (file && (file as any).path) {
          await fs.unlink((file as any).path).catch(() => {});
        }

        if (parentJobId) {
          [parentJob, parentMeta] = await Promise.all([
            getJob(parentJobId),
            getJobMetadata(parentJobId),
          ]);

          if (!parentJob) {
            return res.status(404).json({
              success: false,
              error: "parent_job_not_found",
              message: "Parent job not found for retry.",
            });
          }

          const parentStatusRaw = String(
            (parentJob as any)?.status ||
            (parentJob as any)?.state ||
            (parentJob as any)?.jobState ||
            (parentJob as any)?.queueStatus ||
            ""
          ).toLowerCase();
          const parentStatus = normalizePersistedJobStatus(parentStatusRaw);
          const auth = await resolveAuthoritativeStatus(parentJobId);

          console.log("[RETRY_ELIGIBILITY]", {
            jobId: parentJobId,
            persisted: parentStatus,
            authoritative: auth.status,
            source: auth.source,
          });

          if (
            auth.source === "queue" &&
            (auth.status === "completed" || auth.status === "failed") &&
            parentStatus !== auth.status
          ) {
            const persistedStatus = auth.status === "completed" ? "complete" : "failed";
            await updateJob(parentJobId as any, { status: persistedStatus });
          }

          if (!(auth.status === "completed" || auth.status === "failed")) {
            return res.status(409).json({
              success: false,
              error: "retry_not_allowed_for_job_state",
              message: "Retry is only allowed for completed or failed jobs.",
              status: auth.status || "unknown",
            });
          }

          const owningUser = (parentJob as any)?.userId || parentMeta?.userId;
          if (owningUser && owningUser !== sessUser.id) {
            return res.status(403).json({ success: false, error: "forbidden_source", message: "Source job does not belong to this user" });
          }

          // Canonical retry lineage: parent identity must remain anchored to the original pipeline parent.
          let canonicalParentJobId = String(parentJobId || "");
          let canonicalParentImageId = String((parentJob as any)?.imageId || parentImageId || "");
          const visitedParentJobs = new Set<string>();
          while (canonicalParentJobId && !visitedParentJobs.has(canonicalParentJobId)) {
            visitedParentJobs.add(canonicalParentJobId);
            const currentParentJob = canonicalParentJobId === parentJobId
              ? parentJob
              : await getJob(canonicalParentJobId);
            if (!currentParentJob) break;

            // Bug C fix: stop walking as soon as the current job carries valid stageUrls.
            // This prevents skipping over an edit job that already had stageUrls
            // inherited (Bug D fix), and avoids regressing into stale upstream state
            // in chains like: enhance → retry → edit → retry.
            const currentStageUrls = (currentParentJob as any)?.stageUrls;
            const hasValidStageUrls =
              currentStageUrls &&
              typeof currentStageUrls === "object" &&
              Object.values(currentStageUrls).some((v) => typeof v === "string" && v.trim().length > 0);
            if (hasValidStageUrls && currentParentJob !== parentJob) {
              // Use this job as the canonical anchor.
              canonicalParentJobId = String((currentParentJob as any)?.id || (currentParentJob as any)?.jobId || canonicalParentJobId);
              break;
            }

            const currentPayload = ((currentParentJob as any)?.payload || {}) as any;
            // Bug C fix: fall through to parentJobId / sourceJobId for edit job ancestry
            // (edit jobs use parentJobId, not retryParentJobId).
            const nextParentJobId = String(
              currentPayload.retryParentJobId ||
              currentPayload.parentJobId ||
              currentPayload.sourceJobId ||
              ""
            ).trim();
            const nextParentImageId = String(currentPayload.retryParentImageId || "").trim();

            if (nextParentImageId) {
              canonicalParentImageId = nextParentImageId;
            } else if (String((currentParentJob as any)?.imageId || "").trim()) {
              canonicalParentImageId = String((currentParentJob as any).imageId).trim();
            }

            if (!nextParentJobId || nextParentJobId === canonicalParentJobId) {
              break;
            }
            canonicalParentJobId = nextParentJobId;
          }

          const requestedParentJobId = parentJobId;
          const requestedParentImageId = parentImageId;
          if (canonicalParentJobId !== parentJobId || canonicalParentImageId !== parentImageId) {
            console.log("RETRY_PARENT_CANONICALIZED", {
              requestedParentJobId,
              requestedParentImageId,
              canonicalParentJobId,
              canonicalParentImageId,
            });
          }

          if (canonicalParentJobId && canonicalParentJobId !== parentJobId) {
            parentJobId = canonicalParentJobId;
            const [canonicalParentJob, canonicalParentMeta] = await Promise.all([
              getJob(parentJobId),
              getJobMetadata(parentJobId),
            ]);
            if (!canonicalParentJob) {
              return res.status(409).json({
                success: false,
                error: "retry_baseline_not_found",
                message: "Unable to resolve canonical parent job for retry",
              });
            }
            parentJob = canonicalParentJob;
            parentMeta = canonicalParentMeta;
          }

          const requestedEditedSource = sourceStage === "edit" || uiSelectedTab.toLowerCase() === "edit" || uiSelectedTab.toLowerCase() === "edited";
          if (requestedEditedSource || jobHasEditedArtifact(parentJob)) {
            return res.status(409).json({
              success: false,
              error: "retry_not_allowed_after_edit",
              message: "Retry is unavailable after an edit. Continue editing this version or start a new enhancement.",
            });
          }

          parentImageId = canonicalParentImageId || parentImageId;

          const parentStageUrls = normalizeStageUrls(
            ((parentJob as any)?.stageUrls || (parentJob as any)?.stageOutputs || null) as Record<string, string | null | undefined>
          );
          const metaStageUrls = normalizeStageUrls(parentMeta?.stageUrls as Record<string, string | null | undefined>);
          const originalUploadUrl =
            (parentJob as any)?.payload?.remoteOriginalUrl ||
            (parentJob as any)?.remoteOriginalUrl ||
            parentMeta?.originalUrl ||
            null;
          originalUploadUrlCandidate = originalUploadUrl || undefined;

          const allStageUrls = normalizeStageUrls(mergeStageUrls(metaStageUrls as any, parentStageUrls as any));
          stage1AFromParent = allStageUrls.stage1A || stage1AFromParent;
          stage1BFromParent = allStageUrls.stage1B || stage1BFromParent;
          stage1BWasRequested = stage1BWasRequested
            || !!parentMeta?.requestedStages?.stage1b
            || !!(parentJob as any)?.metadata?.requestedStages?.stage1b
            || !!(parentJob as any)?.options?.declutter;

          const canonicalStageUrls: Record<"1A" | "1B" | "2", string | null> = {
            "1A": resolveStageUrl(allStageUrls, "1A"),
            "1B": resolveStageUrl(allStageUrls, "1B"),
            "2": resolveStageUrl(allStageUrls, "2"),
          };

          inheritedStageUrls = normalizeStageUrls({
            stage1A: canonicalStageUrls["1A"],
            stage1B: canonicalStageUrls["1B"],
            stage2: canonicalStageUrls["2"],
          });

          selectedSourceStage = toEnhanceStage(sourceStage);
          executionSourceStage = selectedSourceStage;
          uiSourceStage = selectedSourceStage;
          selectedSourceUrl = sourceUrlRaw;
          retrySourceStage = toRetryPayloadStage(sourceStage);
          retrySourceUrl = sourceUrlRaw;
          // Only require 1B rebuild before stage 2 when 1B was part of the original pipeline.
          // When the pipeline was 1A→2 (no 1B), stage 2 can run directly from the 1A baseline.
          retryFromStage = requestedStage === "2" && executionSourceStage === "1A" && stage1BWasRequested ? "1B" : undefined;
          stage2OnlyDisabled = requestedStage === "2" && executionSourceStage === "1A" && stage1BWasRequested;
          retryMode = "stage_resume";

          // Keep UI intent as Stage 2, but resolve execution from a valid baseline.
          if (requestedStage === "2" && selectedSourceStage === "2") {
            const fallback1B = stage1BFromParent || resolveStageUrl(inheritedStageUrls as any, "1B");
            const fallback1A = stage1AFromParent || resolveStageUrl(inheritedStageUrls as any, "1A");

            if (fallback1B) {
              executionSourceStage = "1B";
              selectedSourceUrl = fallback1B;
              retrySourceStage = "stage1B";
              retrySourceUrl = fallback1B;
              stage1BWasRequested = true;
              stage2OnlyDisabled = false;
              retryFromStage = undefined;
            } else if (fallback1A) {
              executionSourceStage = "1A";
              selectedSourceUrl = fallback1A;
              retrySourceStage = "stage1A";
              retrySourceUrl = fallback1A;
              // If policy expects 1B, worker must rebuild 1B before Stage 2.
              retryFromStage = "1B";
              stage2OnlyDisabled = true;
            } else {
              return res.status(409).json({
                success: false,
                error: "manual_retry_stage2only_required",
                message: "Manual retry requires a valid Stage 1B baseline, or Stage 1A baseline when Stage 1B must be rebuilt",
              });
            }

            console.log("[RETRY_RESOLUTION]", {
              uiSourceStage: uiSourceStage || null,
              executionSourceStage: executionSourceStage || null,
              stage1BWasRequested,
              retryFromStage: retryFromStage || null,
            });
          }

          if (stage2OnlyRequested) {
            const hasStage1BBaseline = executionSourceStage === "1B";
            const hasStage1ABaseline = executionSourceStage === "1A";
            const canUseStage1AForStage2 = hasStage1ABaseline && (stage2OnlyDisabled || !stage1BWasRequested);

            if (!selectedSourceUrl || (!hasStage1BBaseline && !canUseStage1AForStage2)) {
              return res.status(409).json({
                success: false,
                error: "manual_retry_stage2only_required",
                message: "Manual retry requires a valid Stage 1B baseline, or Stage 1A baseline when Stage 1B must be rebuilt",
              });
            }
          }
          
          // ✅ FIX: Set stage1BWasRequested=true when resolved baseline is Stage 1B
          // This ensures worker doesn't fall back to 1A when 1B is the intended baseline
          if (executionSourceStage === "1B") {
            stage1BWasRequested = true;
          }
          
          if (!selectedSourceUrl || !executionSourceStage) {
            return res.status(400).json({ success: false, error: 'invalid_retry_baseline', message: 'Invalid retry baseline' });
          }
          
          console.log(`[RETRY_BASELINE] requestedStage=${requestedStage} uiSourceStage=${uiSourceStage} executionSourceStage=${executionSourceStage} stage1BWasRequested=${stage1BWasRequested} url=${selectedSourceUrl?.substring(0, 80)}`);
        }

        if (!selectedSourceUrl) {
          return res.status(409).json({
            success: false,
            error: "retry_baseline_not_found",
            message: "Unable to resolve retry baseline from parent job stage outputs",
          });
        }

        if (executionSourceStage && selectedSourceUrl) {
          const baselineReachable = await isRetrySourceReachable(selectedSourceUrl);
          if (!baselineReachable) {
            return res.status(409).json({
              success: false,
              error: "retry_baseline_unreachable",
              message: "Resolved retry baseline URL is not reachable",
            });
          }
        }

        const copyCandidates: Array<{ stage: "1A" | "1B" | "2"; url: string }> = [];
        if (executionSourceStage && selectedSourceUrl) {
          copyCandidates.push({ stage: executionSourceStage, url: selectedSourceUrl });
        }

        let copied = false;
        let lastCopyError: string | null = null;
        const prefix = (process.env.S3_PREFIX || "realenhance/originals").replace(/\/+$/, "");

        for (let idx = 0; idx < copyCandidates.length && !copied; idx += 1) {
          const candidate = copyCandidates[idx];
          const parsedKey = extractKeyFromS3Url(candidate.url);
          if (!parsedKey) {
            lastCopyError = "invalid_source_url";
            continue;
          }

          const targetKey = `${prefix}/retry/${sessUser.id}/${Date.now()}-${path.basename(parsedKey)}`.replace(/^\/+/, "");
          try {
            const copy = await copyS3Object(parsedKey, targetKey);
            remoteOriginalUrl = copy.url;
            remoteOriginalKey = copy.key;
            retrySourceStage = toRetryPayloadStage(candidate.stage as RetrySourceStage);
            retrySourceUrl = candidate.url;
            retrySourceKey = parsedKey;
            executionSourceStage = candidate.stage;
            selectedSourceUrl = candidate.url;
            copied = true;
          } catch (err: any) {
            lastCopyError = err?.message || "copy_failed";
          }
        }

        if (!copied) {
          return res.status(400).json({
            success: false,
            error: "invalid_source_url",
            message: lastCopyError || "Retry source URL is not in the expected bucket",
          });
        }

        const userDir = path.join(uploadRoot, sessUser.id);
        await fs.mkdir(userDir, { recursive: true });
        finalPath = path.join(userDir, path.basename(remoteOriginalKey || "retry-source.jpg"));
        const resp = await fetch(remoteOriginalUrl!);
        if (!resp.ok) {
          return res.status(503).json({ success: false, error: "source_download_failed", message: "Could not download copied stage output" });
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        await fs.writeFile(finalPath, buf);
      }

      // If the client did not supply declutterMode, try to hydrate from the parent job metadata
      if (!declutterMode && parentJobId && !parentMeta) {
        try {
          parentMeta = await getJobMetadata(parentJobId);
        } catch (e) {
          console.warn("[retrySingle] Failed to load parent metadata for declutterMode hydration", e);
        }
      }
      if (!declutterMode && parentMeta?.requestedStages?.stage1b) {
        const stage1bReq = parentMeta.requestedStages.stage1b;
        if (stage1bReq === "light") {
          declutterMode = "light";
          declutterModeSource = "parent_meta";
        } else if (stage1bReq === "full" || stage1bReq === true) {
          declutterMode = "stage-ready";
          declutterModeSource = "parent_meta";
        }
      }

      const effectiveDeclutter = declutter || !!declutterMode;
      const effectiveDeclutterWithFallback = effectiveDeclutter;
      if (declutterModeSource !== "none") {
        console.log(`[RETRY_SINGLE] declutterMode resolved: ${declutterMode} (source=${declutterModeSource})`);
      }

      // Create image record for the new retry job (regardless of source path)
      rec = createImageRecord({
        userId: sessUser.id,
        originalPath: finalPath,
        roomType,
        sceneType,
        ...(parentImageId ? { retryParentImageId: parentImageId } : {}),
      });
      await addImageToUser(sessUser.id, (rec as any).imageId);

      console.log(`[RETRY_SINGLE] imageId=${parentImageId || 'n/a'} sourceStage=${retrySourceStage || 'missing'} sourceUrl=${retrySourceUrl || 'missing'} sourceKey=${retrySourceKey || 'n/a'} userId=${sessUser.id}`);

      const options: any = {
        declutter: effectiveDeclutterWithFallback,
        declutterMode: declutterMode ?? undefined,
        virtualStage: effectiveAllowStaging,
        sourceStage: executionSourceStage,
        stage2Mode: resolveStage2ModeFromSource(executionSourceStage as RetrySourceStage),
        roomType,
        sceneType,
        replaceSky,
        stagingStyle,
        manualSceneOverride,
      };

      // Preserve furnished gate decision for deterministic retry routing.
      // Retry must not re-detect furnished state and drift credit/routing outcomes.
      const parentFurnishedState =
        (parentJob as any)?.options?.furnishedState === "furnished" || (parentJob as any)?.options?.furnishedState === "empty"
          ? (parentJob as any).options.furnishedState
          : (((parentJob as any)?.meta?.furnishedGate && typeof (parentJob as any).meta.furnishedGate.furnished === "boolean")
            ? ((parentJob as any).meta.furnishedGate.furnished ? "furnished" : "empty")
            : undefined);
      if (parentFurnishedState === "furnished" || parentFurnishedState === "empty") {
        options.furnishedState = parentFurnishedState;
      }
      if (temperature !== undefined || topP !== undefined || topK !== undefined) {
        options.sampling = {
          ...(temperature !== undefined ? { temperature } : {}),
          ...(topP !== undefined ? { topP } : {}),
          ...(topK !== undefined ? { topK } : {}),
        };
      }

      // Server-authoritative execution plan for retry.
      // Client request fields are advisory; worker executes this resolved plan only.
      const stage2OnlyStage1BMode: "light" | "stage-ready" = declutterMode === "light" ? "light" : "stage-ready";
      stage1AFromParent =
        stage1AFromParent ||
        (parentMeta?.stageUrls && (parentMeta.stageUrls as any)["1A"]) ||
        ((parentJob as any)?.stageUrls && ((parentJob as any).stageUrls as any)["1A"]) ||
        ((parentJob as any)?.stageOutputs && ((parentJob as any).stageOutputs as any)["1A"]) ||
        undefined;
      stage1BFromParent =
        stage1BFromParent ||
        (parentMeta?.stageUrls && (parentMeta.stageUrls as any)["1B"]) ||
        ((parentJob as any)?.stageUrls && ((parentJob as any).stageUrls as any)["1B"]) ||
        ((parentJob as any)?.stageOutputs && ((parentJob as any).stageOutputs as any)["1B"]) ||
        undefined;

      // Ensure worker receives an explicit execution plan.
      // Without this, manual retries can be interpreted as Stage-2-only by default.
      const effectiveStagesToRun: Array<"1A" | "1B" | "2"> = stagesToRun.length > 0
        ? stagesToRun
        : (requestedStage === "2"
          ? ((stage2OnlyDisabled)
                ? ["1A", "1B", "2"]
                : ["2"])
            : []);
      const effectiveRequestedStages: Array<"1A" | "1B" | "2"> = requestedStagesList.length > 0
        ? requestedStagesList
        : effectiveStagesToRun;

      if (effectiveStagesToRun.includes("1B")) {
        stage1BWasRequested = true;
      }

      const resolvedBaselineStage: "1A" | "1B" = stage1BFromParent ? "1B" : "1A";
      const resolvedBaselineUrl =
        resolvedBaselineStage === "1A"
          ? stage1AFromParent
          : stage1BFromParent;
      const resolvedExecutionPlan = {
        runStage1A: effectiveStagesToRun.includes("1A"),
        runStage1B: effectiveStagesToRun.includes("1B"),
        runStage2: effectiveStagesToRun.includes("2"),
        stage2Baseline: resolvedBaselineStage,
        baselineUrl: resolvedBaselineUrl || undefined,
        sourceStage: executionSourceStage,
      } as const;

      // Invariant: when Stage 2 is planned, both baselineUrl and stage2Baseline must be present.
      if (resolvedExecutionPlan.runStage2) {
        const hasCanonicalBaselineArtifact =
          resolvedExecutionPlan.stage2Baseline === "1A"
            ? !!stage1AFromParent
            : !!stage1BFromParent;
        const hasBaselineUrl = !!resolvedExecutionPlan.baselineUrl;
        const hasBaselineStage =
          resolvedExecutionPlan.stage2Baseline === "1A"
          || resolvedExecutionPlan.stage2Baseline === "1B";
        if (!hasBaselineUrl || !hasBaselineStage || !hasCanonicalBaselineArtifact) {
          return res.status(409).json({
            success: false,
            error: "manual_retry_stage2only_payload_invalid",
            message: "Manual retry requires a deterministic Stage 2 baseline with an existing canonical artifact",
          });
        }

        const expectedCanonicalBaselineUrl =
          resolvedExecutionPlan.stage2Baseline === "1A"
            ? stage1AFromParent
            : stage1BFromParent;
        if (
          expectedCanonicalBaselineUrl &&
          resolvedExecutionPlan.baselineUrl &&
          expectedCanonicalBaselineUrl !== resolvedExecutionPlan.baselineUrl
        ) {
          return res.status(409).json({
            success: false,
            error: "manual_retry_stage2only_payload_invalid",
            message: "Manual retry baseline source label does not match canonical baseline URL",
          });
        }
      }

      // Invariant: Stage 2 cannot execute without a resolved baseline.
      if (resolvedExecutionPlan.runStage2 && !resolvedExecutionPlan.baselineUrl) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_stage2only_payload_invalid",
          message: "Manual retry requires a resolved baseline URL before Stage 2 can execute",
        });
      }

      // Invariant: If Stage 1B was requested by pipeline policy, Stage 2 cannot run from 1A unless 1B is rebuilt.
      if (
        resolvedExecutionPlan.runStage2 &&
        !resolvedExecutionPlan.runStage1B &&
        stage1BWasRequested &&
        resolvedExecutionPlan.stage2Baseline === "1A"
      ) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_stage2only_payload_invalid",
          message: "Manual retry requires Stage 1B baseline, or Stage 1B regeneration, before Stage 2",
        });
      }

      const resolvedStage2OnlySourceStage: "1A" | "1B-light" | "1B-stage-ready" =
        resolvedExecutionPlan.stage2Baseline === "1A"
          ? "1A"
          : stage2OnlyStage1BMode === "light"
            ? "1B-light"
            : "1B-stage-ready";
      const effectiveStage2OnlyMode =
        resolvedExecutionPlan.runStage2 &&
        !resolvedExecutionPlan.runStage1A &&
        !resolvedExecutionPlan.runStage1B &&
        !stage2OnlyDisabled &&
        (resolvedExecutionPlan.stage2Baseline === "1A" || resolvedExecutionPlan.stage2Baseline === "1B")
          ? {
              enabled: true,
              baseStage: resolvedExecutionPlan.stage2Baseline,
              base1BUrl: resolvedExecutionPlan.stage2Baseline === "1B" ? resolvedExecutionPlan.baselineUrl : undefined,
              base1AUrl: resolvedExecutionPlan.stage2Baseline === "1A" ? resolvedExecutionPlan.baselineUrl : stage1AFromParent,
              sourceStage: resolvedStage2OnlySourceStage,
              stage1BMode: stage2OnlyStage1BMode,
            }
          : undefined;

      const stage2OnlyBaselineSourceCount = effectiveStage2OnlyMode
        ? Number(!!effectiveStage2OnlyMode.base1AUrl && effectiveStage2OnlyMode.baseStage === "1A")
          + Number(!!effectiveStage2OnlyMode.base1BUrl && effectiveStage2OnlyMode.baseStage === "1B")
        : 0;

      if (effectiveStage2OnlyMode && stage2OnlyBaselineSourceCount !== 1) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_stage2only_payload_invalid",
          message: "Manual retry requires exactly one Stage 2 baseline source",
        });
      }

      if (stage2OnlyRequested && !stage2OnlyDisabled && !effectiveStage2OnlyMode) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_stage2only_payload_invalid",
          message: "Manual retry plan is not deterministic for Stage 2-only execution",
        });
      }

      // Generate job ID early so plan logging and billing records share the same identifier.
      const jobId = "job_" + crypto.randomUUID();

      console.log("[RETRY_EXECUTION_PLAN]", {
        jobId,
        retryIntent: {
          retryType: "manual_retry",
          requestedStage,
          stagesToRun: effectiveStagesToRun,
          requestedStages: effectiveRequestedStages,
          uiSourceStage,
          executionSourceStage,
          selectedSourceUrl: selectedSourceUrl?.substring(0, 120),
          stage2OnlyDisabled,
          retryMode,
        },
        resolvedExecutionPlan: resolvedExecutionPlan,
        derivedStage2OnlyMode: effectiveStage2OnlyMode
          ? {
              enabled: true,
              baseStage: effectiveStage2OnlyMode.baseStage,
              hasBase1AUrl: !!effectiveStage2OnlyMode.base1AUrl,
              hasBase1BUrl: !!effectiveStage2OnlyMode.base1BUrl,
              baselineSourceCount: stage2OnlyBaselineSourceCount,
              sourceStage: effectiveStage2OnlyMode.sourceStage,
            }
          : null,
        baselineSourceResolvedFrom:
          resolvedExecutionPlan.stage2Baseline === "1A"
            ? "stage1A"
            : resolvedExecutionPlan.stage2Baseline === "1B"
              ? "stage1B"
              : "original_upload",
      });

      if (retryFromStage) {
        console.log(`[RETRY_ROUTING] retryFromStage=${retryFromStage} stage2OnlyMode=${!!effectiveStage2OnlyMode} stagesToRun=${effectiveStagesToRun.join(",") || "none"}`);
      }

      // Free retry contract: retry allowance is enforced per parent image.
      // This retry must not reserve additional credit and must be tracked on parent job metadata.
      const agencyId = sessUser.agencyId || null;
      if (!agencyId) {
        return res.status(400).json({ 
          success: false, 
          error: "missing_agency",
          message: "Agency ID required for retry billing"
        });
      }

      // Enforce free retry availability via parent job metadata without consuming here.
      if (parentJobId) {
        try {
          const retryUse = await getFreeRetryCount({
            parentJobId,
            userId: sessUser.id,
          });

          if (!retryUse.allowed) {
            return res.status(429).json({
              success: false,
              error: "free_retry_exhausted",
              code: "FREE_RETRY_EXHAUSTED",
              message: "All free retries have been used for this image. Please submit a new enhancement.",
            });
          }

          if (!parentMeta) {
            parentMeta = await getJobMetadata(parentJobId);
          }

          const baseMeta = parentMeta && parentMeta.jobId
            ? parentMeta
            : {
                jobId: parentJobId,
                userId: (parentJob as any)?.userId || sessUser.id,
                imageId: (parentJob as any)?.imageId || String(parentImageId || ""),
                createdAt: (parentJob as any)?.createdAt || new Date().toISOString(),
              };

          await saveJobMetadata({
            ...baseMeta,
            freeRetryCount: retryUse.count,
            freeRetryLimit: retryUse.limit,
            freeRetryUsed: retryUse.count >= retryUse.limit,
          } as any);
        } catch (err: any) {
          console.error("[retry-single] free retry metadata update failed:", err);
          return res.status(503).json({
            success: false,
            error: "retry_contract_update_failed",
            message: "Unable to validate free retry availability. Please try again.",
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          error: "missing_parent_job",
          message: "parentJobId is required for free retry enforcement",
        });
      }

      // Free retries must never create allowance reservations or billing ledger entries.
      // Manual retry charge finalization is skipped in worker when retryType === "manual_retry".

      // Idempotency guard (30-second window) is applied only after eligibility and immediately before enqueue.
      if (parentJobId) {
        const retryKey = `retry:${sessUser.id}:${parentJobId}:${Math.floor(Date.now() / 30000)}`;
        const redis = getRedis();
        const lock = await redis.set(retryKey, "1", { EX: 35, NX: true });
        if (!lock) {
          console.log(`[retry-single] Duplicate retry suppressed: ${retryKey}`);
          return res.status(409).json({
            success: false,
            error: "duplicate_retry",
            message: "Duplicate retry suppressed"
          });
        }
        console.log(`[retry-single] Lock acquired: ${retryKey}`);
      }

      const retryImageId = String(parentImageId || (rec as any).imageId || "").trim();
      const retrySourceEnhanced =
        agencyId && selectedSourceUrl
          ? await findScopedEnhancedImageByUrl({
              agencyId,
              userId: sessUser.id,
              publicUrl: selectedSourceUrl,
            })
          : null;
      const result = await enqueueEnhanceJob({
        userId: sessUser.id,
        imageId: retryImageId,
        agencyId,
        sourceStage: executionSourceStage,
        baselineStage: executionSourceStage,
        stageUrls: inheritedStageUrls,
        remoteOriginalUrl,
        remoteOriginalKey,
        options,
        stage2OnlyMode: effectiveStage2OnlyMode,
        executionPlan: resolvedExecutionPlan,
        retryInfo: {
          retryType: "manual_retry",
          sourceStage: sourceStage,
          executionSourceStage,
          sourceUrl: retrySourceUrl,
          sourceKey: retrySourceKey,
          stage1BWasRequested,
          baselineStage: executionSourceStage,
          baselineUrl: selectedSourceUrl,
          requestedStages: effectiveRequestedStages,
          stagesToRun: effectiveStagesToRun,
          parentImageId,
          galleryParentImageId: retrySourceEnhanced?.id || null,
          parentJobId,
          clientBatchId,
        }
      }, jobId);  // Pass pre-generated jobId for billing

      // Track usage for analytics (non-blocking)
      recordUsageEvent({
        userId: sessUser.id,
        jobId,
        imageId: retryImageId,
        stage: "1A",
        imagesProcessed: 1,
      });

      // Immediately return jobId for client polling
      return res.status(200).json({ success: true, jobId });
    } catch (err: any) {
      console.error("[retry-single] ERROR:", err);
      return res.status(500).json({ success: false, error: err?.message || "Retry job failed" });
    }
  });

  return r;
}
