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
const storage = multer.diskStorage({
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
});
const upload = multer({ storage });
const uploadMw = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "mask", maxCount: 1 }
]);

function findByPublicUrl(userId: string, url: string) {
  // Try to match by stripping query params from S3 URLs
  const stripQuery = (u: string) => u.split('?')[0];
  const images = readJsonFile<ImagesState>("images.json", {});
  for (const rec of Object.values(images) as any[]) {
    if (!rec || rec.ownerUserId !== userId) continue;
    for (const v of rec.history || []) {
      const pubUrl = String((v as any).publicUrl || '');
      if (pubUrl === url || stripQuery(pubUrl) === stripQuery(url)) {
        return { record: rec, versionId: v.versionId };
      }
    }
  }
  // Log more details if not found
  console.warn('[region-edit] No image record found for user', { userId, url });
  return null;
}


export const regionEditRouter = Router();
const uploadMw: RequestHandler = upload.fields([
  { name: "mask", maxCount: 1 },
  { name: "image", maxCount: 1 }
]) as unknown as RequestHandler;

regionEditRouter.post("/region-edit", uploadMw, async (req: Request, res: Response) => {
  console.log("[region-edit] POST hit");
  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ success: false, error: "not_authenticated" });

    const imageFile = req.files?.image?.[0];
    const maskFile = req.files?.mask?.[0];
    const body = (req.body || {}) as any;

    const imageUrl = body.imageUrl as string | undefined;
    const mode = body.mode;
    const goal = typeof body.goal === 'string' ? body.goal : '';
    const sceneType = body.sceneType;
    const roomType = body.roomType;
    const allowStaging = body.allowStaging === 'true' || body.allowStaging === true;
    const stagingStyle = body.stagingStyle;

    if (!imageUrl) return res.status(400).json({ success: false, error: "missing_imageUrl" });
    if (!maskFile) return res.status(400).json({ success: false, error: "missing_mask_file" });
    if (!mode) return res.status(400).json({ success: false, error: "missing_mode" });
    if (!["edit", "restore_original"].includes(mode)) {
      return res.status(400).json({ success: false, error: "invalid_mode" });
    }
    if (mode === "edit" && !goal) {
      return res.status(400).json({ success: false, error: "instructions_required" });
    }

    // Find image record and version
    const found = findByPublicUrl(sessUser.id, imageUrl);
    if (!found) {
      console.warn("[region-edit] image not found", { userId: sessUser.id, imageUrl });
      return res.status(404).json({ success: false, error: "image_not_found" });
    }
    const record = found.record;
    const baseVersionId = found.versionId;

    // Compose instruction and mode for worker
    const instruction = mode === 'edit' ? goal : 'Restore original pixels for the masked region.';
    // Map mode to worker enum if needed
    let workerMode: "Add" | "Remove" | "Replace" | "Restore" = "Restore";
    if (mode === "edit") workerMode = "Replace";
    // Compose payload for enqueueEditJob
    const jobPayload = {
      userId: sessUser.id,
      imageId: record.imageId || record.id,
      baseVersionId,
      mode: workerMode,
      instruction,
      mask: maskFile.path,
      allowStaging,
      stagingStyle,
    };
    const { jobId } = await enqueueEditJob(jobPayload);
    return res.status(200).json({ success: true, jobId });
  } catch (err: any) {
    console.error("region-edit error", err);
    return res.status(500).json({ success: false, message: err.message, code: err.code });
  }
});
