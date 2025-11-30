import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFile } from "../services/jsonStore.js";
import { findByPicUrlRedis } from "@realenhance/shared";
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

function parseRetryInfo(url: string) {
  const noQuery = url.split("?")[0];
  const filename = noQuery.split("/").pop() || "";
  // retryN at the end of the filename before extension
  const retryMatch = filename.match(/-retry(\d+)(?=\.[^.]+$)/);
  const retry = retryMatch ? parseInt(retryMatch[1], 10) : 0;
  const baseKey = filename.replace(/-retry\d+(?=\.[^.]+$)/, "");
  return { noQuery, filename, baseKey, retry };
}


// Redis-based lookup
async function findByPublicUrl(userId: string, url: string) {
  const found = await findByPublicUrlRedis(userId, url);
  if (!found) return null;
  // For compatibility with legacy code, return a shape with 'record' and 'versionId'.
  return { record: { imageId: found.imageId, ownerUserId: userId }, versionId: found.versionId };
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
    // Log mask info for debugging
    const mask = body.regionMask || body.mask;
    console.log("[region-edit] mask typeof:", typeof mask);
    if (typeof mask === "string") {
      console.log("[region-edit] mask length:", mask.length);
      console.log("[region-edit] mask prefix:", mask.slice(0, 50));
    }

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


    const found = await findByPublicUrl(sessUser.id, imageUrl);
    if (!found) {
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    // Compute baseImageUrl: prefer latest enhanced/retry, fallback to imageUrl
    let baseImageUrl: string | null = null;
    if (record && record.latest && record.latest.publicUrl) {
      baseImageUrl = record.latest.publicUrl;
    } else if (imageUrl) {
      baseImageUrl = imageUrl;
    }

    if (!baseImageUrl) {
      return res.status(400).json({
        success: false,
        error: "No base image URL available for edit.",
      });
    }

    const instruction =
      mode === "edit" ? goal : "Restore original pixels for the masked region.";

    let workerMode: "Add" | "Remove" | "Replace" | "Restore" = "Restore";
    if (mode === "edit") workerMode = "Replace";

    // Read the mask file as base64 (or data URL) for the worker
    let maskBase64: string | undefined = undefined;
    try {
      if (maskFile && maskFile.path) {
        const maskBuf = await fs.readFile(maskFile.path);
        maskBase64 = maskBuf.toString("base64");
        // If you want a data URL instead:
        // maskBase64 = "data:image/png;base64," + maskBuf.toString("base64");
      }
    } catch (e) {
      console.warn("[region-edit] Failed to read mask file for base64", e);
    }

    const jobPayload = {
      userId: sessUser.id,
      imageId: record.imageId || record.id,
      baseVersionId,
      baseImageUrl, // 👈 always send this
      mode: workerMode,
      instruction,
      mask: maskBase64,
      allowStaging,
      stagingStyle,
    };

    const { jobId } = await enqueueEditJob(jobPayload);
    return res.status(200).json({ success: true, jobId });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      message: err.message,
      code: err.code,
    });
  }
});
