import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createImageRecord } from "../services/images.js";
import { addImageToUser } from "../services/users.js";
import { enqueueEnhanceJob, getJob } from "../services/jobs.js";
import { uploadOriginalToS3, extractKeyFromS3Url, copyS3Object } from "../utils/s3.js";
import { recordUsageEvent } from "@realenhance/shared/usageTracker";
import { getJobMetadata, saveJobMetadata } from "@realenhance/shared/imageStore";
import { findByPublicUrlRedis } from "@realenhance/shared";
import { resolveStageUrl, normalizeStageLabel, mergeStageUrls } from "@realenhance/shared/stageUrlResolver";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { reserveAllowance } from "../services/usageLedger.js";

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
  };
  return aliases[value] || value.replace(/-/g, "_");
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
  stage1BWasRequested: boolean;
  stage1ATainted?: boolean;
}): {
  selectedSourceStage: string | null;
  selectedSourceUrl: string | null;
  retryFromStage: string | null;
  stage2OnlyDisabled: boolean;
  hardFail: { code: string; message: string } | null;
} {
  const { jobId, requestedStage, sourceStageRaw, sourceUrlRaw, stageUrls, stage1BWasRequested, stage1ATainted } = params;

  let selectedSourceStage: string | null = null;
  let selectedSourceUrl: string | null = null;
  let retryFromStage: string | null = null;
  let stage2OnlyDisabled = false;
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

  if (requestedStage === "1A") {
    if (stage1ATainted) {
      hardFail = {
        code: "stage1a_tainted_requires_upload",
        message: "Stage 1A output is flagged as tainted. Retry must start from the original upload image.",
      };
    }
    selectedSourceStage = "1A";
    selectedSourceUrl = resolve("1A");
  } else if (requestedStage === "1B") {
    if (stage1ATainted) {
      hardFail = {
        code: "stage1a_tainted_requires_upload",
        message: "Stage 1A output is flagged as tainted. Retry must start from the original upload image.",
      };
    }
    selectedSourceStage = "1A-stage-ready";
    selectedSourceUrl = resolve("1A");
    retryFromStage = "1B";
    if (!selectedSourceUrl) {
      hardFail = {
        code: "missing_stage1a_baseline",
        message: "Stage 1A baseline is required for Stage 1B retry but was not found",
      };
      selectedSourceStage = null;
    }
  } else if (requestedStage === "2") {
    selectedSourceStage = "1B-stage-ready";
    selectedSourceUrl = resolve("1B");
    if (!selectedSourceUrl) {
      selectedSourceStage = "1A";
      selectedSourceUrl = resolve("1A");
      stage2OnlyDisabled = true;
      retryFromStage = "1B";

      if (!selectedSourceUrl) {
        hardFail = {
          code: "missing_stage1a_baseline",
          message: "Stage 1A baseline is required to rebuild Stage 1B before Stage 2 retry but was not found",
        };
        selectedSourceStage = null;
        stage2OnlyDisabled = false;
      } else if (stage1ATainted) {
        hardFail = {
          code: "stage1a_tainted_requires_upload",
          message: "Stage 1A output is flagged as tainted. Retry must start from the original upload image.",
        };
        selectedSourceStage = null;
        selectedSourceUrl = null;
        stage2OnlyDisabled = false;
      }
    }
  } else if (sourceUrlRaw) {
    selectedSourceStage = normalizeStageLabel(sourceStageRaw) || sourceStageRaw || "stage2";
    selectedSourceUrl = sourceUrlRaw;
  } else {
    const stage2Url = resolve("2");
    const stage1BUrl = resolve("1B");
    const stage1AUrl = resolve("1A");
    if (stage2Url && stage1BUrl) {
      selectedSourceStage = "1B-stage-ready";
      selectedSourceUrl = stage1BUrl;
    } else if (stage1BUrl) {
      selectedSourceStage = "1B-stage-ready";
      selectedSourceUrl = stage1BUrl;
    } else if (stage1AUrl) {
      selectedSourceStage = "1A";
      selectedSourceUrl = stage1AUrl;
    }
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
      const stagingStyle = String(body.stagingStyle || '').trim();
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
      const requestedStage = String(body.requestedStage || '').trim().toUpperCase();
      const effectiveAllowStaging = requestedStage === "2" ? true : !!allowStaging;
      const useStageSource = !!sourceUrlRaw;

      if (!useStageSource && !parentJobId) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_requires_stage_source",
          message: "Manual retry requires a parent job or explicit source URL to resolve stage baseline",
        });
      }

      // ✅ PATCH 2: Idempotency guard (30-second window)
      if (parentJobId) {
        const retryKey = `retry:${sessUser.id}:${parentJobId}:${Math.floor(Date.now() / 30000)}`;
        const redis = getRedis();
        const exists = await redis.get(retryKey);
        if (exists) {
          console.log(`[retry-single] Duplicate retry suppressed: ${retryKey}`);
          return res.status(409).json({ 
            success: false, 
            error: "duplicate_retry",
            message: "Duplicate retry suppressed" 
          });
        }
        await redis.setEx(retryKey, 35, "1");
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
      let stage2OnlyDisabled = false;
      let retryFromStage: string | undefined = undefined;
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

          const owningUser = (parentJob as any)?.userId || parentMeta?.userId;
          if (owningUser && owningUser !== sessUser.id) {
            return res.status(403).json({ success: false, error: "forbidden_source", message: "Source job does not belong to this user" });
          }

          const parentStageUrls = (parentJob as any)?.stageUrls || (parentJob as any)?.stageOutputs || null;
          const metaStageUrls = parentMeta?.stageUrls;

          const allStageUrls = mergeStageUrls(metaStageUrls as any, parentStageUrls as any);
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
            stage1BWasRequested,
            stage1ATainted: isStage1ATainted(parentJob, parentMeta),
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

          if (requestedStage === "2") {
            const hasStage1BBaseline =
              !!selectedSourceStage &&
              (selectedSourceStage === "1B" ||
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
          
          // Never allow edit stages as baseline
          if (!selectedSourceUrl || !selectedSourceStage || selectedSourceStage.toLowerCase().startsWith('edit')) {
            return res.status(400).json({ success: false, error: 'invalid_retry_baseline', message: 'Invalid retry baseline - edit stages not allowed' });
          }
          
          console.log(`[RETRY_BASELINE] requestedStage=${requestedStage} → sourceStage=${selectedSourceStage} stage1BWasRequested=${stage1BWasRequested} url=${selectedSourceUrl?.substring(0, 80)}`);
          
          const collectedUrls = Object.values(allStageUrls || {}).filter(Boolean) as string[];

          if (collectedUrls.length > 0 && !collectedUrls.includes(selectedSourceUrl)) {
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

        const parsedKey = extractKeyFromS3Url(selectedSourceUrl || sourceUrlRaw);
        if (!parsedKey) {
          return res.status(400).json({ success: false, error: "invalid_source_url", message: "Retry source URL is not in the expected bucket" });
        }

        const prefix = (process.env.S3_PREFIX || "realenhance/originals").replace(/\/+$/, "");
        const targetKey = `${prefix}/retry/${sessUser.id}/${Date.now()}-${path.basename(parsedKey)}`.replace(/^\/+/, "");

        const copy = await copyS3Object(parsedKey, targetKey);
        remoteOriginalUrl = copy.url;
        remoteOriginalKey = copy.key;
        retrySourceStage = normalizeStageLabel(selectedSourceStage || sourceStageRaw) || selectedSourceStage || sourceStageRaw || "stage2";
        retrySourceUrl = selectedSourceUrl || sourceUrlRaw;
        retrySourceKey = parsedKey;

        const userDir = path.join(uploadRoot, sessUser.id);
        await fs.mkdir(userDir, { recursive: true });
        finalPath = path.join(userDir, path.basename(targetKey));
        const resp = await fetch(copy.url);
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
        declutter: effectiveDeclutter,
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

      // ✅ Smart Stage-2-only retry logic
      // stage2OnlyMode activates ONLY for explicit Stage 2 retries (requestedStage='2')
      // Stage 1B retries must regenerate 1B through the normal pipeline
      const stage2OnlyStage1BMode: "light" | "stage-ready" = declutterMode === "light" ? "light" : "stage-ready";
      const stage2OnlySourceStage: "1A" | "1B-light" | "1B-stage-ready" =
        selectedSourceStage === "1A"
          ? "1A"
          : stage2OnlyStage1BMode === "light"
            ? "1B-light"
            : "1B-stage-ready";
      const stage2OnlyBaseStage: "1A" | "1B" = stage2OnlySourceStage === "1A" ? "1A" : "1B";
      const stage1AFromParent =
        (parentMeta?.stageUrls && (parentMeta.stageUrls as any)["1A"]) ||
        ((parentJob as any)?.stageUrls && ((parentJob as any).stageUrls as any)["1A"]) ||
        ((parentJob as any)?.stageOutputs && ((parentJob as any).stageOutputs as any)["1A"]) ||
        undefined;
      const stage2OnlyMode =
        requestedStage === '2' && selectedSourceUrl && !stage2OnlyDisabled
          ? {
              enabled: true,
              baseStage: stage2OnlyBaseStage,
              base1BUrl: stage2OnlyBaseStage === "1B" ? selectedSourceUrl : undefined,
              base1AUrl: stage2OnlyBaseStage === "1A" ? selectedSourceUrl : stage1AFromParent,
              sourceStage: stage2OnlySourceStage,
              stage1BMode: stage2OnlyStage1BMode,
            }
          : undefined;

      const hasValidStage2OnlyPayload = !!stage2OnlyMode?.enabled && (
        stage2OnlyMode.baseStage === "1A"
          ? (!!stage2OnlyMode.base1AUrl && !stage1BWasRequested)
          : !!stage2OnlyMode.base1BUrl
      );

      if (requestedStage === "2" && !stage2OnlyDisabled && !hasValidStage2OnlyPayload) {
        return res.status(409).json({
          success: false,
          error: "manual_retry_stage2only_payload_invalid",
          message: "Manual retry payload is missing required Stage2Only fields or violates declutter baseline policy",
        });
      }

      if (retryFromStage) {
        console.log(`[RETRY_ROUTING] retryFromStage=${retryFromStage} stage2OnlyMode=${!!stage2OnlyMode}`);
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
          if (!parentMeta) {
            parentMeta = await getJobMetadata(parentJobId);
          }

          if (parentMeta?.freeRetryUsed === true) {
            return res.status(429).json({
              success: false,
              error: "free_retry_exhausted",
              code: "FREE_RETRY_EXHAUSTED",
              message: "The free retry has already been used for this image. Please submit a new enhancement.",
            });
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
            freeRetryUsed: true,
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

      // Generate job ID for reservation
      const jobId = "job_" + crypto.randomUUID();

      // Free retry must not reserve additional credit.
      // Reserve a zero-credit row only so worker finalization remains idempotent/traceable.
      try {
        await reserveAllowance({
          jobId,
          agencyId,
          userId: sessUser.id,
          requiredImages: 0,
          requestedStage12: true,
          requestedStage2: effectiveAllowStaging,
        });
        console.log(`[retry-single] Registered free retry reservation row (0 credits) for job ${jobId}`);
      } catch (err: any) {
        if (err?.code === "QUOTA_EXCEEDED") {
          return res.status(402).json({ 
            success: false,
            code: "QUOTA_EXCEEDED", 
            snapshot: err.snapshot,
            message: "Unable to register retry reservation"
          });
        }
        console.error('[retry-single] Reservation failed:', err);
        return res.status(503).json({ 
          success: false, 
          error: "reservation_failed",
          message: "Failed to reserve credits for retry"
        });
      }

      const result = await enqueueEnhanceJob({
        userId: sessUser.id,
        imageId: (rec as any).imageId,
        agencyId,
        remoteOriginalUrl,
        remoteOriginalKey,
        options,
        stage2OnlyMode,
        retryInfo: {
          retryType: "manual_retry",
          sourceStage: retrySourceStage,
          sourceUrl: retrySourceUrl,
          sourceKey: retrySourceKey,
          stage1BWasRequested,
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
