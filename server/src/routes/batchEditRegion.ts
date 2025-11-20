import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { enqueueRegionEditJob } from "../services/jobs.js";
import { chargeForImages } from "../services/users.js";

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

export function batchEditRegionRouter() {
  const r = Router();
  const uploadMw: RequestHandler = upload.single("mask") as unknown as RequestHandler;

  // POST /api/batch/edit-region
  r.post("/batch/edit-region", uploadMw, async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ success: false, error: "not_authenticated" });

    const maskFile = req.file as Express.Multer.File | undefined;
    const { mode, prompt, imageUrl, baseImageUrl, imageIndex } = req.body || {};
    if (!maskFile || !imageUrl || !mode) {
      return res.status(400).json({ success: false, error: "missing_fields" });
    }

    try {
      await chargeForImages(sessUser.id, 1);
    } catch (e: any) {
      return res.status(402).json({ success: false, error: "insufficient_credits", message: e?.message || "insufficient credits" });
    }

    // Download imageUrl and baseImageUrl to temp files (reuse storage helper if available)
    // For now, just pass URLs and mask path to job
    const job = await enqueueRegionEditJob({
      userId: sessUser.id,
      mode,
      prompt,
      currentImageUrl: imageUrl,
      baseImageUrl,
      maskPath: maskFile.path,
      imageIndex: Number(imageIndex)
    });

    // Wait for job completion or respond with job info (simulate immediate for now)
    // Assume job returns { imageUrl }
    if (job && job.imageUrl) {
      return res.json({ success: true, imageUrl: job.imageUrl });
    }
    return res.status(500).json({ success: false, error: "job_failed" });
  });

  return r;
}
