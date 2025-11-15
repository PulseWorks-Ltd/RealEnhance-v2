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
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const file = (req.file as Express.Multer.File | undefined);
    if (!file) return res.status(400).json({ error: "missing_image" });

    // Charge 1 credit up-front (aligns with upload pipeline)
    try {
      await chargeForImages(sessUser.id, 1);
    } catch (e: any) {
      return res.status(402).json({ error: "insufficient_credits", message: e?.message || "insufficient credits" });
    }

    // Extract form fields
    const body = req.body || {} as any;
    const sceneType = body.sceneType || 'auto';
    const roomType = body.roomType || 'unknown';
    const allowStaging = toBool(body.allowStaging, true);
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
    try {
      const up = await uploadOriginalToS3(finalPath);
      remoteOriginalUrl = up.url;
    } catch (e) {
      const msg = (e as any)?.message || String(e);
      console.warn('[retrySingle] original S3 upload failed:', msg);
      // In dev, continue without remote URL (worker will try local fallback)
      if (process.env.REQUIRE_S3 === '1' || process.env.S3_STRICT === '1' || process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 's3_unavailable', message: msg });
      }
    }

    const options: any = {
      declutter: false,
      virtualStage: !!allowStaging,
      roomType,
      sceneType,
      replaceSky,
    };
    if (temperature !== undefined || topP !== undefined || topK !== undefined) {
      options.sampling = {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
        ...(topK !== undefined ? { topK } : {}),
      };
    }

    const { jobId } = await enqueueEnhanceJob({ userId: sessUser.id, imageId: (rec as any).imageId, remoteOriginalUrl, options });

    // Poll jobs.json for completion (up to ~120s)
    const started = Date.now();
    const timeoutMs = 120_000;
    let last: any = undefined;
    while (Date.now() - started < timeoutMs) {
      await new Promise(r => setTimeout(r, 1000));
      last = getJob(jobId);
      if (last && (last as any).status === 'complete') {
        const imageUrl = (last as any).resultUrl || (last as any).imageUrl || (last as any)?.stageUrls?.["2"] || (last as any)?.stageUrls?.["1B"] || (last as any)?.stageUrls?.["1A"];
        return res.json({ success: true, imageUrl, mode: options.virtualStage ? 'staged' : 'polish-only' });
      }
      if (last && (last as any).status === 'error') {
        return res.status(400).json({ success: false, message: (last as any).errorMessage || 'Retry failed' });
      }
    }

    // Timed out - return 202 with job id for client to optionally poll via status API
    return res.status(202).json({ success: false, jobId, message: 'processing' });
  });

  return r;
}
