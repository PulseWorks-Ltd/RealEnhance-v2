import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser } from "../services/users.js";
import { enqueueEnhanceJob, getJob } from "../services/jobs.js";
import { uploadOriginalToS3, extractKeyFromS3Url, copyS3Object } from "../utils/s3.js";
import { recordUsageEvent } from "@realenhance/shared/usageTracker";
import { getJobMetadata } from "@realenhance/shared/imageStore";
import { findByPublicUrlRedis } from "@realenhance/shared";

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
      const manualSceneOverride = toBool(body.manualSceneOverride, false);
      const replaceSky = sceneType === 'exterior' ? true : undefined; // default sky replacement for exteriors
      const sourceStageRaw = String(body.sourceStage || "").toLowerCase();
      const sourceUrlRaw = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
      const parentImageId = body.imageId || body.retryParentImageId || null;
      const parentJobId = body.parentJobId || body.retryParentJobId || null;
      const clientBatchId = body.clientBatchId || body.batchId || null;
      const useStageSource = !!sourceUrlRaw;

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
      let rec: any = undefined;

      if (useStageSource) {
        const bucket = process.env.S3_BUCKET;
        if (!bucket) {
          return res.status(400).json({ success: false, error: "s3_not_configured", message: "S3 bucket is required to retry from a stage output" });
        }

        if (file && (file as any).path) {
          await fs.unlink((file as any).path).catch(() => {});
        }

        const parsedKey = extractKeyFromS3Url(sourceUrlRaw);
        if (!parsedKey) {
          return res.status(400).json({ success: false, error: "invalid_source_url", message: "Retry source URL is not in the expected bucket" });
        }

        if (parentJobId) {
          const [parentJob, parentMeta] = await Promise.all([
            getJob(parentJobId),
            getJobMetadata(parentJobId),
          ]);

          const owningUser = (parentJob as any)?.userId || parentMeta?.userId;
          if (owningUser && owningUser !== sessUser.id) {
            return res.status(403).json({ success: false, error: "forbidden_source", message: "Source job does not belong to this user" });
          }

          const parentStageUrls = (parentJob as any)?.stageUrls || (parentJob as any)?.stageOutputs || null;
          const metaStageUrls = parentMeta?.stageUrls;
          const collectedUrls = [parentStageUrls, metaStageUrls]
            .filter(Boolean)
            .flatMap((m: any) => Object.values(m as Record<string, string | null>))
            .filter(Boolean) as string[];

          if (collectedUrls.length > 0 && !collectedUrls.includes(sourceUrlRaw)) {
            return res.status(400).json({ success: false, error: "source_url_mismatch", message: "Provided source URL does not match recorded job outputs" });
          }

          if (collectedUrls.length === 0) {
            // Fallback to history lookup; allow but warn if missing
            const history = parentMeta?.imageId ? await findByPublicUrlRedis(sessUser.id, sourceUrlRaw).catch(() => null) : null;
            if (!history) {
              console.warn("[RETRY_META_MISSING_ALLOW]", { jobId: parentJobId, reason: "no_stage_urls_or_history", sourceUrlRaw });
            }
          }
        }

        const prefix = (process.env.S3_PREFIX || "realenhance/originals").replace(/\/+$/, "");
        const targetKey = `${prefix}/retry/${sessUser.id}/${Date.now()}-${path.basename(parsedKey)}`.replace(/^\/+/, "");

        const copy = await copyS3Object(parsedKey, targetKey);
        remoteOriginalUrl = copy.url;
        remoteOriginalKey = copy.key;
        retrySourceStage = sourceStageRaw || "stage2";
        retrySourceUrl = sourceUrlRaw;
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
        declutter,
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
      // Check if there's a previous job for this image with structurally safe Stage-1B
      // Note: This is a simplified implementation - in production you'd query job history by imageId
      // For now, we'll add the capability but it will only activate if explicitly passed
      const stage2OnlyMode = undefined; // Will be populated in future enhancement

      const { jobId } = await enqueueEnhanceJob({
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
      });

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
