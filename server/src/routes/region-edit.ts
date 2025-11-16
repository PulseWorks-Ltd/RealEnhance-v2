import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import { readJsonFile } from "../services/jsonStore.js";
import { enqueueEditJob, getJob } from "../services/jobs.js";
import { addImageVersion, createImageRecord, getImageRecord } from "../services/images.js";

type ImagesState = Record<string, any>;

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

function findByPublicUrl(userId: string, url: string) {
  const images = readJsonFile<ImagesState>("images.json", {});
  for (const rec of Object.values(images) as any[]) {
    if (!rec || rec.ownerUserId !== userId) continue;
    const idx = (rec.history || []).findIndex((v: any) => String((v as any).publicUrl || '') === url);
    if (idx !== -1) {
      const versionId = rec.history[idx].versionId;
      return { record: rec, versionId };
    }
  }
  return null;
}

export function regionEditRouter() {
  const r = Router();
  const uploadMw: RequestHandler = upload.single("image") as unknown as RequestHandler;

  // POST /api/region-edit
  r.post("/region-edit", uploadMw, async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ success: false, error: "not_authenticated" });

    const file = (req.file as Express.Multer.File | undefined);
    const body = (req.body || {}) as any;

    const imageUrl = body.imageUrl as string | undefined;
    const mask = body.regionMask as string | undefined;
    const operation = (body.regionOperation as string || '').toLowerCase();
    const goal = String(body.goal || '').trim();
    const smartReinstate = String(body.smartReinstate || 'true').toLowerCase() === 'true';
    const sensitivityPx = Number.isFinite(Number(body.sensitivityPx)) ? Number(body.sensitivityPx) : undefined;

    if (!mask) return res.status(400).json({ success: false, error: "missing_mask" });
    if (!operation) return res.status(400).json({ success: false, error: "missing_operation" });

    // Resolve image record + base version
    let record: any | undefined;
    let baseVersionId: string | undefined;

    if (imageUrl) {
      const found = findByPublicUrl(sessUser.id, imageUrl);
      if (!found) return res.status(404).json({ success: false, error: "image_not_found" });
      record = found.record;
      baseVersionId = found.versionId;
    } else if (file) {
      // Create a new record from uploaded file (less common path for region edit)
      const userDir = path.join(uploadRoot, sessUser.id);
      await fs.mkdir(userDir, { recursive: true });
      const finalPath = path.join(userDir, file.filename || file.originalname);
      const src = path.join((file as any).destination ?? uploadRoot, file.filename);
      await fs.rename(src, finalPath).catch(async () => {
        const buf = await fs.readFile((file as any).path);
        await fs.writeFile(finalPath, buf);
      });
      const rec = createImageRecord({ userId: sessUser.id, originalPath: finalPath });
      record = rec;
      baseVersionId = rec.currentVersionId;
    } else {
      return res.status(400).json({ success: false, error: "missing_image_reference" });
    }

    const mode = operation === 'add' ? 'Add' : operation === 'remove' ? 'Remove' : operation === 'replace' ? 'Replace' : operation === 'restore' ? 'Restore' : 'Replace';
    const instruction = goal || (mode === 'Restore' ? 'Restore original pixels for the masked region.' : 'Apply requested edit in the masked region only.');

    // Resolve base version for edit - ensure it exists and has a valid path
    const history = (record as any).history || [];
    const baseVersion = history.find((v: any) => v.versionId === baseVersionId);
    if (!baseVersion || !baseVersion.filePath) {
      return res.status(404).json({ success: false, error: "base_version_not_found" });
    }

    // For Restore mode, find the enhancement stage to restore from
    let restoreVersion: any = undefined;
    if (mode === 'Restore') {
      const stage1B = history.find((v: any) => v.stageLabel === '1B');
      const stage1A = history.find((v: any) => v.stageLabel === '1A');
      restoreVersion = stage1B || stage1A;
      if (!restoreVersion) {
        return res.status(404).json({ success: false, error: "enhancement_stage_not_found" });
      }
    }

    // Upload base (and restore source if different) to S3 for multi-service worker access
    let remoteBaseUrl: string | undefined;
    let remoteRestoreUrl: string | undefined;
    const isProduction = process.env.NODE_ENV === 'production' || process.env.REQUIRE_S3 === '1';
    
    if (isProduction) {
      try {
        const { uploadOriginalToS3 } = await import('../utils/s3.js');
        const basePath = path.join(uploadRoot, sessUser.id, baseVersion.filePath);
        if (!fss.existsSync(basePath)) {
          return res.status(404).json({ success: false, error: "base_file_not_found_on_disk" });
        }
        const baseUpload = await uploadOriginalToS3(basePath);
        remoteBaseUrl = baseUpload.url;
        
        if (restoreVersion && restoreVersion.versionId !== baseVersion.versionId) {
          const restorePath = path.join(uploadRoot, sessUser.id, restoreVersion.filePath);
          if (fss.existsSync(restorePath)) {
            const restoreUpload = await uploadOriginalToS3(restorePath);
            remoteRestoreUrl = restoreUpload.url;
          }
        }
      } catch (err: any) {
        console.error('[region-edit] S3 upload failed:', err);
        return res.status(503).json({ success: false, error: 's3_upload_failed', message: err?.message });
      }
    }

    // Enqueue edit job with remote URLs
    const { jobId } = await enqueueEditJob({
      userId: sessUser.id,
      imageId: (record as any).imageId || (record as any).id,
      baseVersionId: baseVersionId!,
      mode: mode as any,
      instruction,
      mask,
      remoteBaseUrl,
      remoteRestoreUrl,
    });

    const started = Date.now();
    const timeoutMs = 120_000;
    let last: any = undefined;
    while (Date.now() - started < timeoutMs) {
      await new Promise(r => setTimeout(r, 1000));
      last = getJob(jobId);
      if (last && (last as any).status === 'complete') {
        const imageId = (record as any).imageId || (record as any).id;
        const recFresh = getImageRecord(imageId);
        const current = recFresh?.history?.find(v => v.versionId === recFresh?.currentVersionId);
        const imageUrl = (current as any)?.publicUrl || undefined;
        const originalUrl = imageUrl; // send same for slider fallback if needed
        return res.json({ success: true, imageUrl, originalUrl, maskUrl: 'inline', creditsUsed: 1, mode: 'polish-only' });
      }
      if (last && (last as any).status === 'error') {
        return res.status(400).json({ success: false, error: (last as any).errorMessage || 'Edit failed', creditsUsed: 0 });
      }
    }

    return res.status(202).json({ success: false, jobId, message: 'processing' });
  });

  return r;
}
