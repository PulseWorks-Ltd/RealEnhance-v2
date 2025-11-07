// server/src/routes/upload.ts
import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser, chargeForImages } from "../services/users.js";
import { enqueueEnhanceJob } from "../services/jobs.js";
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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function safeParseOptions(raw: unknown): any[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function uploadRouter() {
  const r = Router();

  // If your editor still shows overload errors, this cast silences them safely.
  const uploadMw: RequestHandler = upload.array("images", 20) as unknown as RequestHandler;

  r.post("/upload", uploadMw, async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.length) return res.status(400).json({ error: "no_files" });

    const optionsList = safeParseOptions((req.body as any)?.options);

    // charge credits (throws on insufficient)
    await chargeForImages(sessUser.id, files.length);

    const userDir = path.join(uploadRoot, sessUser.id);
    await fs.mkdir(userDir, { recursive: true });

    const jobs: Array<{ jobId: string; imageId: string }> = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const opts = optionsList[i] ?? {
        declutter: false,
        virtualStage: false,
        roomType: "unknown",
        sceneType: "auto",
      };

      const finalPath = path.join(userDir, f.filename || f.originalname);

      // move file into user's folder
      if ((f as any).path) {
        const src = path.join((f as any).destination ?? uploadRoot, f.filename);
        await fs
          .rename(src, finalPath)
          .catch(async () => {
            const buf = await fs.readFile((f as any).path);
            await fs.writeFile(finalPath, buf);
            await fs.unlink((f as any).path).catch(() => {});
          });
      }

      const rec = createImageRecord({
        userId: sessUser.id,
        originalPath: finalPath,
        roomType: opts.roomType,
        sceneType: opts.sceneType,
      });

      const imageId = (rec as any).imageId ?? (rec as any).id;
      addImageToUser(sessUser.id, imageId);

      // Upload original to S3 (best-effort; if it fails we still enqueue job without remote URL)
      let remoteOriginalUrl: string | undefined = undefined;
      try {
        const up = await uploadOriginalToS3(finalPath);
        remoteOriginalUrl = up.url;
        // optionally, could store in record.versions here in future
      } catch (e) {
        console.warn('[upload] original S3 upload failed, continuing with local path', (e as any)?.message || e);
      }

      const { jobId } = await enqueueEnhanceJob({
        userId: sessUser.id,
        imageId,
        remoteOriginalUrl,
        options: {
          declutter: !!opts.declutter,
          virtualStage: !!opts.virtualStage,
          roomType: opts.roomType,
          sceneType: opts.sceneType,
        },
      });

      jobs.push({ jobId, imageId });
    }

    return res.json({ ok: true, jobs });
  });

  return r;
}
