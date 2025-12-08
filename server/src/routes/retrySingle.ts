import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser, chargeForImages } from "../services/users.js";
import { enqueueEnhanceJob, getJob } from "../services/jobs.js";
import { uploadOriginalToS3 } from "../utils/s3.js";

const uploadRoot = path.join(process.cwd(), "server", "uploads");

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
      if (!file) return res.status(400).json({ success: false, error: "missing_image" });

      // Charge 1 credit up-front (aligns with upload pipeline)
      try {
        await chargeForImages(sessUser.id, 1);
      } catch (e: any) {
        return res.status(402).json({ success: false, error: "insufficient_credits", message: e?.message || "insufficient credits" });
      }

      // Extract form fields
      const body = req.body || {} as any;
      const sceneType = body.sceneType || 'auto';
      const roomType = body.roomType || 'unknown';
      const allowStaging = toBool(body.allowStaging, true);
      const stagingStyle = String(body.stagingStyle || '').trim();
      const declutter = toBool(body.declutter, false);
      const furnitureRemovalMode = String(body.furnitureRemovalMode || 'auto').trim();
      const manualSceneOverride = toBool(body.manualSceneOverride, false);
      const replaceSky = sceneType === 'exterior' ? true : undefined; // default sky replacement for exteriors
      // Optional tuning
      const temperature = parseNumber(body.temperature);
      const topP = parseNumber(body.topP);
      const topK = parseNumber(body.topK);

      // Move file to per-user folder
      const userDir = path.join(uploadRoot, sessUser.id);
      await fs.mkdir(userDir, { recursive: true });
      const finalPath = path.join(userDir, file.filename || file.originalname);
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

      // Create record and enqueue enhance job
      const rec = createImageRecord({ userId: sessUser.id, originalPath: finalPath, roomType, sceneType });
      addImageToUser(sessUser.id, (rec as any).imageId);

      // Upload original to S3 so worker can download it (required for multi-service deployments)
      let remoteOriginalUrl: string | undefined = undefined;
      const requireS3 = process.env.REQUIRE_S3 === '1' || process.env.S3_STRICT === '1' || process.env.NODE_ENV === 'production';
      
      if (requireS3 || process.env.S3_BUCKET) {
        try {
          const up = await uploadOriginalToS3(finalPath);
          remoteOriginalUrl = up.url;
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
        // Dev mode without S3: verify local file exists
        if (!fss.existsSync(finalPath)) {
          return res.status(404).json({ success: false, error: 'local_file_missing' });
        }
      }

      // Map furnitureRemovalMode to declutterIntensity
      let declutterIntensity: 'light' | 'standard' | 'heavy' | undefined;
      let actualFurnitureRemovalMode: 'auto' | 'main' | 'heavy' | undefined;
      if (declutter) {
        const mode = furnitureRemovalMode.toLowerCase();
        if (mode === 'main') {
          declutterIntensity = 'light'; // Tidy mode: micro declutter only
          actualFurnitureRemovalMode = 'main';
        } else if (mode === 'auto') {
          declutterIntensity = 'standard'; // Standard mode: furniture removal + conditional cleanup
          actualFurnitureRemovalMode = 'auto';
        } else if (mode === 'heavy') {
          declutterIntensity = 'heavy'; // Stage-Ready mode: complete clear
          actualFurnitureRemovalMode = 'heavy';
        }
      }

      const options: any = {
        declutter,
        virtualStage: !!allowStaging,
        roomType,
        sceneType,
        replaceSky,
        stagingStyle,
        manualSceneOverride,
        ...(declutterIntensity ? { declutterIntensity } : {}),
        ...(actualFurnitureRemovalMode ? { furnitureRemovalMode: actualFurnitureRemovalMode } : {}),
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
        options,
        stage2OnlyMode
      });

      // Set initial job status (optional, if not handled in enqueueEnhanceJob)
      // You may want to call a jobStatusStore.set(jobId, { success: false, error: 'processing' }) here if not already done.

      // Immediately return jobId for client polling
      return res.status(200).json({ success: true, jobId });
    } catch (err: any) {
      console.error("[retry-single] ERROR:", err);
      return res.status(500).json({ success: false, error: err?.message || "Retry job failed" });
    }
  });

  return r;
}
