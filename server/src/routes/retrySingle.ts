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
import { resolveStageUrl, normalizeStageLabel, mergeStageUrls } from "@realenhance/shared/stageUrlResolver";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { consumeFreeRetryCount } from "../services/usageLedger.js";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";

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

function normalizeBaselineSourceStage(rawStage: string | undefined): "1A" | "1B" | "original_upload" {
  const s = String(rawStage || "").trim().toLowerCase();
  if (s.startsWith("1a")) return "1A";
  if (s === "1b" || s === "1b-light" || s === "1b-stage-ready" || s.startsWith("1b")) {
    return "1B";
  }
  return "original_upload";
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

function resolveRetryBaseline(params: {
  jobId: string;
  requestedStage: string;
  sourceStageRaw: string;
  sourceUrlRaw: string;
  stageUrls: Record<string, string | null>;
  retryLatestUrl?: string;
  editLatestUrl?: string;
  stage1BWasRequested: boolean;
  stage1ATainted?: boolean;
  originalUploadUrl?: string;
}): {
  selectedSourceStage: string | null;
  selectedSourceUrl: string | null;
  retryFromStage: string | null;
  stage2OnlyDisabled: boolean;
  retryMode: "stage_resume" | "full_pipeline_restart";
  hardFail: { code: string; message: string } | null;
} {
  const {
    jobId,
    requestedStage,
    sourceStageRaw,
    sourceUrlRaw,
    stageUrls,
    retryLatestUrl,
    editLatestUrl,
    stage1BWasRequested,
    stage1ATainted,
    originalUploadUrl,
  } = params;

  let selectedSourceStage: string | null = null;
  let selectedSourceUrl: string | null = null;
  let retryFromStage: string | null = null;
  let stage2OnlyDisabled = false;
  let retryMode: "stage_resume" | "full_pipeline_restart" = "stage_resume";
  let hardFail: { code: string; message: string } | null = null;

  let selectedKey: string | null = null;
  const captureKey = (_message: string, payload: any) => {
    selectedKey = payload?.selectedKey || null;
  };

  const resolve = (stage: "1A" | "1B" | "2") =>
    resolveStageUrl(stageUrls, stage, {
      context: `retry:${requestedStage}`,
      logger: captureKey,
    });

  const stage2Url = resolve("2");
  const stage1BUrl = resolve("1B");
  const stage1AUrl = resolve("1A");

  const orderedCandidates: Array<{ stage: string; url: string | null | undefined }> = [
    // Prefer canonical artifacts from parent lineage first.
    { stage: "retry_latest", url: retryLatestUrl || null },
    { stage: "edit_latest", url: editLatestUrl || null },
    { stage: "2", url: stage2Url },
    { stage: "1B-stage-ready", url: stage1BUrl },
    { stage: "1A", url: stage1ATainted ? null : stage1AUrl },
    // Keep explicit client source as fallback to avoid stale UI payload poisoning.
    { stage: normalizeStageLabel(sourceStageRaw) || sourceStageRaw || "manual_source", url: sourceUrlRaw || null },
    { stage: "original_upload", url: originalUploadUrl || null },
  ];

  const selected = orderedCandidates.find((entry) => typeof entry.url === "string" && entry.url.trim().length > 0) || null;

  if (selected) {
    selectedSourceStage = selected.stage;
    selectedSourceUrl = selected.url as string;
  }

  if (!selectedSourceUrl) {
    hardFail = {
      code: "retry_baseline_not_found",
      message: "Unable to resolve retry baseline from latest successful artifacts",
    };
  }

  if (selectedSourceStage === "original_upload") {
    retryFromStage = "1A";
    stage2OnlyDisabled = true;
    retryMode = "full_pipeline_restart";
  } else if (selectedSourceStage === "1A" && requestedStage === "2") {
    retryFromStage = "1B";
    stage2OnlyDisabled = true;
  }

  const keysFound = Object.keys(stageUrls).filter((key) => {
    const value = stageUrls[key];
    return typeof value === "string" && value.trim().length > 0;
  });

  console.log(
    `[retry-baseline] jobId=${jobId} requestedStage=${requestedStage || "default"} stage1BRequested=${stage1BWasRequested} keysFound=${JSON.stringify(keysFound)} selectedKey=${selectedKey || "none"} selectedUrl=${selectedSourceUrl || "none"} fallback=${stage2OnlyDisabled} reason=${hardFail ? hardFail.code : (selectedSourceUrl ? "alias-match" : "not-found")}`,
  );

  return {
    selectedSourceStage,
    selectedSourceUrl,
    retryFromStage,
    stage2OnlyDisabled,
    retryMode,
    hardFail,
  };
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
      const sourceStageRaw = String(body.sourceStage || "").toLowerCase();
      const sourceUrlRaw = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
      const parentImageId = body.imageId || body.retryParentImageId || null;
      const parentJobId = body.parentJobId || body.retryParentJobId || null;
      const clientBatchId = body.clientBatchId || body.batchId || null;
      const stagesToRun = parseStageList(body.stagesToRun);
      const requestedStagesList = parseStageList(body.requestedStages);
      const payloadBaselineStage = String(body.baselineStage || "").trim().toUpperCase();
      const payloadBaselineUrl = typeof body.baselineUrl === "string" ? body.baselineUrl.trim() : "";
      const requestedStageFromPayload = String(body.requestedStage || '').trim().toUpperCase();
      const requestedStage = highestStageFrom(stagesToRun) || (requestedStageFromPayload as "1A" | "1B" | "2" | "") || "2";
      const stagePlanIncludes1A = stagesToRun.includes("1A");
      const stagePlanIncludes1B = stagesToRun.includes("1B");
      const stagePlanIncludes2 = stagesToRun.includes("2");
      const stage2OnlyRequested = stagesToRun.length > 0
        ? (stagePlanIncludes2 && !stagePlanIncludes1A && !stagePlanIncludes1B)
        : requestedStage === "2";
      const effectiveAllowStaging = requestedStage === "2" ? true : !!allowStaging;
      const useStageSource = !!sourceUrlRaw;

      if (!useStageSource && !parentJobId) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_requires_stage_source",
          message: "Manual retry requires a parent job or explicit source URL to resolve stage baseline",
        });
      }

      // Optional tuning
      const temperature = parseNumber(body.temperature);
      const topP = parseNumber(body.topP);
      const topK = parseNumber(body.topK);

      if (sceneType !== "exterior" && !CANONICAL_ROOM_TYPES.has(roomType)) {
        return res.status(400).json({ success: false, error: "invalid_room_type", message: "Invalid roomType for interior retry" });
      }

      if (!useStageSource && !file) {
        return res.status(400).json({ success: false, error: "missing_image", message: "No image provided for retry" });
      }

      let finalPath: string;
      let remoteOriginalUrl: string | undefined = undefined;
      let remoteOriginalKey: string | undefined = undefined;
      let retrySourceStage: string | undefined = undefined;
      let retrySourceUrl: string | undefined = undefined;
      let retrySourceKey: string | undefined = undefined;
      let selectedSourceStage: string | undefined = undefined;
      let selectedSourceUrl: string | undefined = undefined;
      let originalUploadUrlCandidate: string | undefined = undefined;
      let stage1AFromParent: string | undefined = undefined;
      let stage1BFromParent: string | undefined = undefined;
      let stage2OnlyDisabled = false;
      let retryFromStage: string | undefined = undefined;
      let retryMode: "stage_resume" | "full_pipeline_restart" = "stage_resume";
      let stage1BWasRequested = toBool(body.stage1BWasRequested, false);
      let rec: any = undefined;
      let parentJob: any = undefined;
      let parentMeta: any = undefined;

      if (useStageSource || parentJobId) {
        const bucket = process.env.S3_BUCKET;
        if (!bucket) {
          return res.status(400).json({ success: false, error: "s3_not_configured", message: "S3 bucket is required to retry from a stage output" });
        }

        if (file && (file as any).path) {
          await fs.unlink((file as any).path).catch(() => {});
        }

        // Defaults when no parent metadata is available
        selectedSourceStage = normalizeStageLabel(sourceStageRaw) || sourceStageRaw || "stage2";
        selectedSourceUrl = sourceUrlRaw || undefined;

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

          if (auth.source === "queue" && parentStatus !== auth.status) {
            await updateJob(parentJobId as any, { status: auth.status });
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

          const parentStageUrls = (parentJob as any)?.stageUrls || (parentJob as any)?.stageOutputs || null;
          const metaStageUrls = parentMeta?.stageUrls;
          const retryLatestUrl =
            (parentJob as any)?.retryLatestUrl ||
            (parentMeta as any)?.retryLatestUrl ||
            (parentMeta as any)?.result?.retryLatestUrl ||
            null;
          const editLatestUrl =
            (parentJob as any)?.editLatestUrl ||
            (parentMeta as any)?.editLatestUrl ||
            (parentMeta as any)?.result?.editLatestUrl ||
            null;
          const originalUploadUrl =
            (parentJob as any)?.payload?.remoteOriginalUrl ||
            (parentJob as any)?.remoteOriginalUrl ||
            parentMeta?.originalUrl ||
            null;
          originalUploadUrlCandidate = originalUploadUrl || undefined;

          const allStageUrls = mergeStageUrls(metaStageUrls as any, parentStageUrls as any);
          stage1AFromParent =
            (allStageUrls as any)?.["1A"] ||
            (allStageUrls as any)?.["1a"] ||
            stage1AFromParent;
          stage1BFromParent =
            (allStageUrls as any)?.["1B"] ||
            (allStageUrls as any)?.["1b"] ||
            stage1BFromParent;
          stage1BWasRequested = stage1BWasRequested
            || !!parentMeta?.requestedStages?.stage1b
            || !!(parentJob as any)?.metadata?.requestedStages?.stage1b
            || !!(parentJob as any)?.options?.declutter;

          const baseline = resolveRetryBaseline({
            jobId: parentJobId,
            requestedStage,
            sourceStageRaw,
            sourceUrlRaw,
            stageUrls: allStageUrls,
            retryLatestUrl: retryLatestUrl || undefined,
            editLatestUrl: editLatestUrl || undefined,
            stage1BWasRequested,
            stage1ATainted: isStage1ATainted(parentJob, parentMeta),
            originalUploadUrl: originalUploadUrl || undefined,
          });

          if (baseline.hardFail) {
            return res.status(409).json({
              success: false,
              error: baseline.hardFail.code,
              message: baseline.hardFail.message,
            });
          }

          selectedSourceStage = baseline.selectedSourceStage || undefined;
          selectedSourceUrl = baseline.selectedSourceUrl || undefined;
          retryFromStage = baseline.retryFromStage || undefined;
          stage2OnlyDisabled = baseline.stage2OnlyDisabled;
          retryMode = baseline.retryMode;

          if (retryMode === "full_pipeline_restart") {
            console.log(`[RETRY_FALLBACK_FULL_PIPELINE] job=${parentJobId} reason=no_stage1_baseline source=original_upload`);
          }

          if (stage2OnlyRequested && retryMode !== "full_pipeline_restart") {
            const hasStage1BBaseline =
              !!selectedSourceStage &&
              (selectedSourceStage === "1B" ||
                selectedSourceStage === "2" ||
                selectedSourceStage === "retry_latest" ||
                selectedSourceStage === "edit_latest" ||
                selectedSourceStage === "1B-light" ||
                selectedSourceStage === "1B-stage-ready" ||
                selectedSourceStage.toLowerCase().startsWith("1b"));
            const hasStage1ABaseline =
              !!selectedSourceStage &&
              (selectedSourceStage === "1A" || selectedSourceStage.toLowerCase().startsWith("1a"));
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
          if (selectedSourceStage &&
              (selectedSourceStage === "1B" || 
               selectedSourceStage === "1B-light" || 
               selectedSourceStage === "1B-stage-ready" ||
               selectedSourceStage.startsWith("1b"))) {
            stage1BWasRequested = true;
          }
          
          if (!selectedSourceUrl || !selectedSourceStage) {
            return res.status(400).json({ success: false, error: 'invalid_retry_baseline', message: 'Invalid retry baseline' });
          }
          
          console.log(`[RETRY_BASELINE] requestedStage=${requestedStage} → sourceStage=${selectedSourceStage} stage1BWasRequested=${stage1BWasRequested} url=${selectedSourceUrl?.substring(0, 80)}`);
          
          const collectedUrls = Object.values(allStageUrls || {}).filter(Boolean) as string[];

          if (retryMode !== "full_pipeline_restart" && collectedUrls.length > 0 && !collectedUrls.includes(selectedSourceUrl)) {
            return res.status(400).json({ success: false, error: "source_url_mismatch", message: "Selected source URL does not match recorded job outputs" });
          }

          if (collectedUrls.length === 0) {
            // Fallback to history lookup; allow but warn if missing
            const history = parentMeta?.imageId ? await findByPublicUrlRedis(sessUser.id, selectedSourceUrl).catch(() => null) : null;
            if (!history) {
              console.warn("[RETRY_META_MISSING_ALLOW]", { jobId: parentJobId, reason: "no_stage_urls_or_history", selectedSourceUrl });
            }
          }
        }

        if (!selectedSourceUrl) {
          return res.status(409).json({
            success: false,
            error: "retry_baseline_not_found",
            message: "Unable to resolve retry baseline from parent job stage outputs",
          });
        }

        if (
          retryMode !== "full_pipeline_restart" &&
          selectedSourceStage &&
          selectedSourceStage !== "original_upload" &&
          selectedSourceUrl
        ) {
          const baselineReachable = await isRetrySourceReachable(selectedSourceUrl);
          if (!baselineReachable && originalUploadUrlCandidate) {
            selectedSourceStage = "original_upload";
            selectedSourceUrl = originalUploadUrlCandidate;
            retryFromStage = "1A";
            stage2OnlyDisabled = true;
            retryMode = "full_pipeline_restart";
            console.log(`[RETRY_FALLBACK_FULL_PIPELINE] job=${parentJobId || "unknown"} reason=baseline_url_unreachable source=original_upload`);
          }
        }

        const copyCandidates: Array<{ stage: string; url: string }> = [];
        if (selectedSourceStage && selectedSourceUrl) {
          copyCandidates.push({ stage: selectedSourceStage, url: selectedSourceUrl });
        }
        if (
          originalUploadUrlCandidate &&
          selectedSourceUrl &&
          originalUploadUrlCandidate !== selectedSourceUrl
        ) {
          copyCandidates.push({ stage: "original_upload", url: originalUploadUrlCandidate });
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
            retrySourceStage = normalizeStageLabel(candidate.stage || sourceStageRaw) || candidate.stage || sourceStageRaw || "stage2";
            retrySourceUrl = candidate.url;
            retrySourceKey = parsedKey;
            selectedSourceStage = candidate.stage;
            selectedSourceUrl = candidate.url;
            copied = true;

            if (candidate.stage === "original_upload" && idx > 0) {
              retryFromStage = "1A";
              stage2OnlyDisabled = true;
              retryMode = "full_pipeline_restart";
              console.log(`[RETRY_FALLBACK_FULL_PIPELINE] job=${parentJobId || "unknown"} reason=baseline_artifact_missing source=original_upload`);
            }
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
      } else {
        if (!file) {
          return res.status(400).json({ success: false, error: "missing_image", message: "No image provided for retry" });
        }
        const tempPath = (file as any).path || path.join((file as any).destination ?? uploadRoot, file.filename);
        const isImage = await isLikelyImage(tempPath, file.mimetype);
        if (!isImage) {
          await fs.unlink(tempPath).catch(() => {});
          return res.status(400).json({ success: false, error: "invalid_image_format", message: "Invalid image format for retry" });
        }

        const userDir = path.join(uploadRoot, sessUser.id);
        await fs.mkdir(userDir, { recursive: true });
        finalPath = path.join(userDir, file.filename || file.originalname);
        if ((file as any).path) {
          const src = path.join((file as any).destination ?? uploadRoot, file.filename);
          await fs
            .rename(src, finalPath)
            .catch(async () => {
              const buf = await fs.readFile((file as any).path);
              await fs.writeFile(finalPath, buf);
              await fs.unlink((file as any).path).catch(() => {});
            });
        }

        const requireS3 = process.env.REQUIRE_S3 === '1' || process.env.S3_STRICT === '1' || process.env.NODE_ENV === 'production';
        if (requireS3 || process.env.S3_BUCKET) {
          try {
            const up = await uploadOriginalToS3(finalPath);
            remoteOriginalUrl = up.url;
            remoteOriginalKey = up.key;
            console.log(`[retrySingle] Original uploaded to S3: ${remoteOriginalUrl}`);
          } catch (e) {
            const msg = (e as any)?.message || String(e);
            console.error('[retrySingle] S3 upload failed:', msg);
            if (requireS3) {
              return res.status(503).json({ success: false, error: 's3_upload_failed', message: msg });
            }
            console.warn('[retrySingle] Continuing without S3 (dev mode)');
          }
        } else {
          if (!fss.existsSync(finalPath)) {
            return res.status(404).json({ success: false, error: 'local_file_missing' });
          }
        }
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
      const effectiveDeclutterWithFallback = retryMode === "full_pipeline_restart" ? true : effectiveDeclutter;
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

      console.log(`[RETRY_SINGLE] imageId=${parentImageId || 'n/a'} sourceStage=${retrySourceStage || 'upload'} sourceUrl=${retrySourceUrl || 'upload'} sourceKey=${retrySourceKey || 'n/a'} userId=${sessUser.id}`);

      const options: any = {
        declutter: effectiveDeclutterWithFallback,
        declutterMode: declutterMode ?? undefined,
        virtualStage: effectiveAllowStaging,
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
            ? ((retryMode === "full_pipeline_restart" || stage2OnlyDisabled)
                ? ["1A", "1B", "2"]
                : ["2"])
            : []);
      const effectiveRequestedStages: Array<"1A" | "1B" | "2"> = requestedStagesList.length > 0
        ? requestedStagesList
        : effectiveStagesToRun;

      if (effectiveStagesToRun.includes("1B")) {
        stage1BWasRequested = true;
      }

      const normalizedSelectedStage = String(selectedSourceStage || "").trim().toLowerCase();
      const stage2LikeSelection =
        normalizedSelectedStage === "2" ||
        normalizedSelectedStage === "retry_latest" ||
        normalizedSelectedStage === "edit_latest";

      const resolvedBaselineStage: "1A" | "1B" | "original_upload" = stage2LikeSelection
        ? (stage1BFromParent
            ? "1B"
            : (stage1AFromParent
                ? "1A"
                : "original_upload"))
        : normalizeBaselineSourceStage(selectedSourceStage);
      const selectedLooksLike1A = normalizedSelectedStage.startsWith("1a");
      const selectedLooksLike1B =
        normalizedSelectedStage === "1b" ||
        normalizedSelectedStage === "2" ||
        normalizedSelectedStage === "retry_latest" ||
        normalizedSelectedStage === "edit_latest" ||
        normalizedSelectedStage === "1b-light" ||
        normalizedSelectedStage === "1b-stage-ready" ||
        normalizedSelectedStage.startsWith("1b");
      const resolvedBaselineUrl =
        resolvedBaselineStage === "1A"
          ? (stage1AFromParent || (selectedLooksLike1A ? selectedSourceUrl : undefined))
          : resolvedBaselineStage === "1B"
            ? (stage1BFromParent || (selectedLooksLike1B ? selectedSourceUrl : undefined))
            : (originalUploadUrlCandidate || (normalizedSelectedStage === "original_upload" ? selectedSourceUrl : undefined));
      const resolvedExecutionPlan = {
        runStage1A: effectiveStagesToRun.includes("1A"),
        runStage1B: effectiveStagesToRun.includes("1B"),
        runStage2: effectiveStagesToRun.includes("2"),
        stage2Baseline: resolvedBaselineStage,
        baselineUrl: resolvedBaselineUrl || undefined,
        sourceStage: selectedSourceStage || undefined,
      } as const;

      // Invariant: when Stage 2 is planned, both baselineUrl and stage2Baseline must be present.
      if (resolvedExecutionPlan.runStage2) {
        const hasCanonicalBaselineArtifact =
          resolvedExecutionPlan.stage2Baseline === "1A"
            ? !!stage1AFromParent
            : resolvedExecutionPlan.stage2Baseline === "1B"
              ? !!stage1BFromParent
              : !!originalUploadUrlCandidate;
        const hasBaselineUrl = !!resolvedExecutionPlan.baselineUrl;
        const hasBaselineStage =
          resolvedExecutionPlan.stage2Baseline === "1A"
          || resolvedExecutionPlan.stage2Baseline === "1B"
          || resolvedExecutionPlan.stage2Baseline === "original_upload";
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
            : resolvedExecutionPlan.stage2Baseline === "1B"
              ? stage1BFromParent
              : originalUploadUrlCandidate;
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
        retryMode !== "full_pipeline_restart" &&
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

      if (stage2OnlyRequested && !stage2OnlyDisabled && retryMode !== "full_pipeline_restart" && !effectiveStage2OnlyMode) {
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
          selectedSourceStage,
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

      // Free retry contract: exactly one free retry per parent image.
      // This retry must not reserve additional credit and must be tracked on parent job metadata.
      const agencyId = sessUser.agencyId || null;
      if (!agencyId) {
        return res.status(400).json({ 
          success: false, 
          error: "missing_agency",
          message: "Agency ID required for retry billing"
        });
      }

      // Enforce one free retry via parent job metadata.
      if (parentJobId) {
        try {
          const retryUse = await consumeFreeRetryCount({
            parentJobId,
            userId: sessUser.id,
          });

          if (!retryUse.allowed) {
            return res.status(429).json({
              success: false,
              error: "free_retry_exhausted",
              code: "FREE_RETRY_EXHAUSTED",
              message: "The free retry has already been used for this image. Please submit a new enhancement.",
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
            freeRetryUsed: retryUse.count >= 1,
            freeRetryUsedAt: new Date().toISOString(),
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

      const result = await enqueueEnhanceJob({
        userId: sessUser.id,
        imageId: (rec as any).imageId,
        agencyId,
        remoteOriginalUrl,
        remoteOriginalKey,
        options,
        stage2OnlyMode: effectiveStage2OnlyMode,
        executionPlan: resolvedExecutionPlan,
        retryInfo: {
          retryType: "manual_retry",
          sourceStage: retrySourceStage,
          sourceUrl: retrySourceUrl,
          sourceKey: retrySourceKey,
          stage1BWasRequested,
          baselineStage: payloadBaselineStage || selectedSourceStage || null,
          baselineUrl: payloadBaselineUrl || selectedSourceUrl || null,
          requestedStages: effectiveRequestedStages,
          stagesToRun: effectiveStagesToRun,
          parentImageId,
          parentJobId,
          clientBatchId,
        }
      }, jobId);  // Pass pre-generated jobId for billing

      // Track usage for analytics (non-blocking)
      recordUsageEvent({
        userId: sessUser.id,
        jobId,
        imageId: (rec as any).imageId,
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
