import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFile } from "../services/jsonStore.js";
import { enqueueEditJob } from "../services/jobs.js";

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

function findByPublicUrl(userId: string, url: string) {
  const stripQuery = (u: string) => u.split("?")[0];

  const images = readJsonFile<ImagesState>("images.json", {});
  const target = stripQuery(url);

  let ownerMatch: { record: any; versionId: string } | null = null;
  let anyMatch: { record: any; versionId: string } | null = null;

  for (const rec of Object.values(images) as any[]) {
    if (!rec) continue;

    const owner = rec.ownerUserId;
    for (const v of rec.history || []) {
      const pubUrl = String((v as any).publicUrl || "");
      if (!pubUrl) continue;

      const stripped = stripQuery(pubUrl);
      if (stripped !== target) continue;

      const candidate = { record: rec, versionId: v.versionId };

      // Perfect match: same user + same URL
      if (owner === userId) {
        ownerMatch = candidate;
        break;
      }

      // URL matches but owner differs – keep as fallback
      if (!anyMatch) {
        anyMatch = candidate;
      }
    }

    if (ownerMatch) break;
  }

  if (ownerMatch) {
    return ownerMatch;
  }

  if (anyMatch) {
    console.warn("[region-edit] Found image by URL but ownerUserId mismatch", {
      expectedUserId: userId,
      storedOwnerUserId: anyMatch.record.ownerUserId,
      imageId: anyMatch.record.imageId || anyMatch.record.id,
      versionId: anyMatch.versionId,
    });
    return anyMatch;
  }

  console.warn("[region-edit] No image record found for user", {
    userId,
    url,
  });
  return null;
}

export const regionEditRouter = Router();

// ✅ accept ANY file fields (no more "Unexpected field")
const uploadMw: RequestHandler = upload.any();

regionEditRouter.post("/region-edit", uploadMw, async (req: Request, res: Response) => {
  console.log("[region-edit] POST hit");
  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ success: false, error: "not_authenticated" });
    }

    // req.files is now an array from upload.any()
    const filesArray = (req.files as Express.Multer.File[]) || [];

    // Try the most likely fieldnames used by the client
    const maskFile =
      filesArray.find((f) => f.fieldname === "regionMask") || // 👈 NEW
      filesArray.find((f) => f.fieldname === "mask") ||
      filesArray.find((f) => f.fieldname === "file") ||
      filesArray.find((f) => f.fieldname === "image") ||
      filesArray[0] || // last-ditch fallback
      null;

    if (!maskFile) {
      console.warn(
        "[region-edit] No mask file found in upload. fields=",
        filesArray.map((f) => f.fieldname)
      );
      return res.status(400).json({ success: false, error: "missing_mask_file" });
    }

    const body = (req.body || {}) as any;

    const imageUrl = body.imageUrl as string | undefined;
    const mode = body.mode as "edit" | "restore_original" | undefined;
    const goal = typeof body.goal === "string" ? body.goal : "";
    const sceneType = body.sceneType;
    const roomType = body.roomType;
    const allowStaging = body.allowStaging === "true" || body.allowStaging === true;
    const stagingStyle = body.stagingStyle;

    if (!imageUrl) {
      return res.status(400).json({ success: false, error: "missing_imageUrl" });
    }
    if (!mode) {
      return res.status(400).json({ success: false, error: "missing_mode" });
    }
    if (!["edit", "restore_original"].includes(mode)) {
      return res.status(400).json({ success: false, error: "invalid_mode" });
    }
    if (mode === "edit" && !goal) {
      return res.status(400).json({ success: false, error: "instructions_required" });
    }

    const found = findByPublicUrl(sessUser.id, imageUrl);
    if (!found) {
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    const instruction =
      mode === "edit" ? goal : "Restore original pixels for the masked region.";

    let workerMode: "Add" | "Remove" | "Replace" | "Restore" = "Restore";
    if (mode === "edit") workerMode = "Replace";

    const jobPayload = {
      userId: sessUser.id,
      imageId: record.imageId || record.id,
      baseVersionId,
      mode: workerMode,
      instruction,
      mask: maskFile.path,
      allowStaging,
      stagingStyle,
      sceneType,
      roomType,
    };

    const { jobId } = await enqueueEditJob(jobPayload);
    return res.status(200).json({ success: true, jobId });
  } catch (err: any) {
    console.error("[region-edit] error", err);
    return res.status(500).json({
      success: false,
      message: err.message,
      code: err.code,
    });
  }
});
