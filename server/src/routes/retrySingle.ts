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
import { getJobMetadata } from "@realenhance/shared/imageStore";
import { findByPublicUrlRedis } from "@realenhance/shared";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { reserveAllowance, incrementRetry } from "../services/usageLedger.js";

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
      const roomType = body.roomType || 'unknown';
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
      const useStageSource = !!sourceUrlRaw;

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
      let rec: any = undefined;
      let parentJob: any = undefined;
      let parentMeta: any = undefined;

      if (useStageSource) {
        const bucket = process.env.S3_BUCKET;
        if (!bucket) {
          return res.status(400).json({ success: false, error: "s3_not_configured", message: "S3 bucket is required to retry from a stage output" });
        }

        if (file && (file as any).path) {
          await fs.unlink((file as any).path).catch(() => {});
        }

        // Defaults when no parent metadata is available
        selectedSourceStage = sourceStageRaw || "stage2";
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
          
          // ✅ PATCH 1: Stage-aware baseline selection
          // Merge stage URLs from both sources
          const allStageUrls = { ...metaStageUrls, ...parentStageUrls };
          
          // Filter out edit stages - never use as baseline
          const validStageUrls = Object.entries(allStageUrls || {})
            .filter(([stage]) => !stage.toLowerCase().startsWith('edit'))
            .reduce((acc, [stage, url]) => {
              if (typeof url === "string" && url.length > 0) {
                acc[stage] = url;
              }
              return acc;
            }, {} as Record<string, string>);
          
          if (requestedStage === '1A') {
            // Retry from Stage 1A → full pipeline
            selectedSourceStage = '1A';
            selectedSourceUrl = validStageUrls['1A'];
          } else if (requestedStage === '1B') {
            // Retry Stage 1B → regenerate 1B + Stage 2 from Stage 1A baseline
            selectedSourceStage = '1A-stage-ready';
            selectedSourceUrl =
              validStageUrls['1A'] ||
              validStageUrls['original'];
            retryFromStage = '1B';
            
            // Fallback: if no Stage 1A available, fall back to original upload
            if (!selectedSourceUrl) {
              console.warn(`[RETRY_FALLBACK] Stage1A missing for 1B retry, will use uploaded file`);
              selectedSourceStage = '1A';
            }
          } else if (requestedStage === '2') {
            // CRITICAL: Retry Stage 2 from Stage 1B, NOT Stage 2
            selectedSourceStage = '1B-stage-ready';
            selectedSourceUrl = validStageUrls['1B'];
            
            // ✅ CHECK 2: Fallback to Stage1A if Stage1B missing
            if (!selectedSourceUrl && validStageUrls['1A']) {
              console.warn(`[RETRY_FALLBACK] Stage1B missing, falling back to Stage1A for requestedStage=2`);
              selectedSourceStage = '1A';
              selectedSourceUrl = validStageUrls['1A'];
              // Disable stage2OnlyMode if falling back to 1A (need full pipeline)
              stage2OnlyDisabled = true;
            }
          } else if (sourceUrlRaw) {
            // Fallback: use provided sourceUrl (backward compat)
            selectedSourceStage = sourceStageRaw || 'stage2';
            selectedSourceUrl = sourceUrlRaw;
          } else {
            // Default: retry from highest available non-edit stage
            const stageRanks = { '2': 3, '1B': 2, '1A': 1 };
            const sortedStages = Object.entries(validStageUrls)
              .sort(([a], [b]) => (stageRanks[b as keyof typeof stageRanks] || 0) - (stageRanks[a as keyof typeof stageRanks] || 0));
            
            if (sortedStages.length > 0) {
              const [stage, url] = sortedStages[0];
              selectedSourceStage = stage === '1B' ? '1B-stage-ready' : stage === '2' ? '1B-stage-ready' : '1A';
              selectedSourceUrl = stage === '2' ? validStageUrls['1B'] : url;
            } else {
              return res.status(400).json({ success: false, error: 'no_valid_baseline', message: 'No valid retry baseline found' });
            }
          }
          
          // Never allow edit stages as baseline
          if (!selectedSourceUrl || selectedSourceStage.toLowerCase().startsWith('edit')) {
            return res.status(400).json({ success: false, error: 'invalid_retry_baseline', message: 'Invalid retry baseline - edit stages not allowed' });
          }
          
          console.log(`[RETRY_BASELINE] requestedStage=${requestedStage} → sourceStage=${selectedSourceStage} url=${selectedSourceUrl}`);
          
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

        const parsedKey = extractKeyFromS3Url(selectedSourceUrl || sourceUrlRaw);
        if (!parsedKey) {
          return res.status(400).json({ success: false, error: "invalid_source_url", message: "Retry source URL is not in the expected bucket" });
        }

        const prefix = (process.env.S3_PREFIX || "realenhance/originals").replace(/\/+$/, "");
        const targetKey = `${prefix}/retry/${sessUser.id}/${Date.now()}-${path.basename(parsedKey)}`.replace(/^\/+/, "");

        const copy = await copyS3Object(parsedKey, targetKey);
        remoteOriginalUrl = copy.url;
        remoteOriginalKey = copy.key;
        retrySourceStage = selectedSourceStage || sourceStageRaw || "stage2";
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
        virtualStage: !!allowStaging,
        roomType,
        sceneType,
        replaceSky,
        stagingStyle,
        manualSceneOverride,
      };
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
      const stage2OnlyMode =
        requestedStage === '2' && !stage2OnlyDisabled && selectedSourceUrl
          ? { enabled: true, base1BUrl: selectedSourceUrl }
          : undefined;

      if (retryFromStage) {
        console.log(`[RETRY_ROUTING] retryFromStage=${retryFromStage} stage2OnlyMode=${!!stage2OnlyMode}`);
      }

      // ✅ PATCH 3 & CHECK 4: Billing - reserve 1 credit for manual retry
      // Retry quota enforcement (CHECK 4):
      // - Scope: Per parent job (not per user, not per imageId)
      // - Counts: Manual retries ONLY (not validator/system retries)
      // - Limit: Max 2 manual retries per parent job
      const agencyId = sessUser.agencyId || null;
      if (!agencyId) {
        return res.status(400).json({ 
          success: false, 
          error: "missing_agency",
          message: "Agency ID required for retry billing"
        });
      }

      // Enforce retry quota cap
      if (parentJobId) {
        try {
          const retryCheck = await incrementRetry(parentJobId);
          if (retryCheck.locked) {
            return res.status(429).json({ 
              success: false,
              error: "retry_limit_reached", 
              code: "RETRY_LIMIT_REACHED",
              retryCount: retryCheck.retryCount,
              message: "Maximum retry limit (2) reached for this image"
            });
          }
        } catch (err: any) {
          console.error('[retry-single] incrementRetry failed:', err);
          // Continue - don't block on quota check failure
        }
      }

      // Generate job ID for reservation
      const jobId = "job_" + crypto.randomUUID();

      // Reserve exactly 1 credit for manual retry (all retries cost 1 credit)
      try {
        await reserveAllowance({
          jobId,
          agencyId,
          userId: sessUser.id,
          requiredImages: 1,  // Always 1 credit per retry
          requestedStage12: true,
          requestedStage2: allowStaging,
        });
        console.log(`[retry-single] Reserved 1 credit for manual retry job ${jobId}`);
      } catch (err: any) {
        if (err?.code === "QUOTA_EXCEEDED") {
          return res.status(402).json({ 
            success: false,
            code: "QUOTA_EXCEEDED", 
            snapshot: err.snapshot,
            message: "Insufficient credits for retry"
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
        remoteOriginalUrl,
        remoteOriginalKey,
        options,
        stage2OnlyMode,
        retryInfo: {
          retryType: "manual_retry",
          sourceStage: retrySourceStage,
          sourceUrl: retrySourceUrl,
          sourceKey: retrySourceKey,
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
