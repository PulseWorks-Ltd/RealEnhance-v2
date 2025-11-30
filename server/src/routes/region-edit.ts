import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFile } from "../services/jsonStore.js";
import { findByPublicUrlRedis } from "@realenhance/shared";
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

    const body = (req.body || {}) as any;
    // Extract all fields from body
    const imageUrl = body.imageUrl as string | undefined;
    const mode = body.mode as "edit" | "restore_original" | undefined;
    const goal = typeof body.goal === "string" ? body.goal : "";
    const sceneType = body.sceneType;
    const roomType = body.roomType;
    const allowStaging = body.allowStaging === "true" || body.allowStaging === true;
    const stagingStyle = body.stagingStyle;

    // ✅ FIX: Get mask from req.body (not req.files) since it's sent as a string
    const maskDataUrl = body.regionMask || body.mask;

    console.log("[region-edit] imageUrl:", imageUrl);
    console.log("[region-edit] mode:", mode);
    console.log("[region-edit] goal:", goal);
    console.log("[region-edit] mask received:", !!maskDataUrl);
    console.log("[region-edit] mask length:", maskDataUrl?.length || 0);

    // Validation
    if (!imageUrl) {
      console.error("[region-edit] Missing imageUrl");
      return res.status(400).json({ success: false, error: "missing_imageUrl" });
    }
    if (!mode) {
      console.error("[region-edit] Missing mode");
      return res.status(400).json({ success: false, error: "missing_mode" });
    }
    if (!["edit", "restore_original"].includes(mode)) {
      console.error("[region-edit] Invalid mode:", mode);
      return res.status(400).json({ success: false, error: "invalid_mode" });
    }
    if (mode === "edit" && !goal) {
      console.error("[region-edit] Missing goal for edit mode");
      return res.status(400).json({ success: false, error: "instructions_required" });
    }
    if (!maskDataUrl) {
      console.error("[region-edit] Missing mask data");
      return res.status(400).json({ success: false, error: "missing_mask" });
    }

    // Look up the image record
    const found = await findByPublicUrl(sessUser.id, imageUrl);
    if (!found) {
      console.error("[region-edit] Image not found for URL:", imageUrl);
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    // Determine the base image URL to edit
    let baseImageUrl: string = imageUrl; // Default to the provided imageUrl
    if (record && record.latest && record.latest.publicUrl) {
      baseImageUrl = record.latest.publicUrl;
      console.log("[region-edit] Using latest version:", baseImageUrl);
    }

    // Convert mask data URL to base64 string (strip the data:image/png;base64, prefix)
    let maskBase64: string;
    if (maskDataUrl.startsWith("data:image/")) {
      maskBase64 = maskDataUrl.split(",")[1];
    } else {
      maskBase64 = maskDataUrl;
    }

    const instruction = mode === "edit" 
      ? goal 
      : "Restore original pixels for the masked region.";

    let workerMode: "Add" | "Remove" | "Replace" | "Restore" = "Restore";
    if (mode === "edit") workerMode = "Replace";

    // ✅ FIX: Create proper job payload with all required fields
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const jobPayload = {
      type: "region-edit",
      jobId,
      userId: sessUser.id,
      imageId: record.imageId || record.id,
      baseVersionId,
      baseImageUrl,        // ✅ The URL to download and edit
      currentImageUrl: baseImageUrl, // ✅ Same as baseImageUrl for region edits
      mode: workerMode,
      prompt: instruction, // ✅ Use 'prompt' instead of 'instruction'
      mask: maskBase64,    // ✅ Plain base64 string (no data URL prefix)
      sceneType,
      roomType,
      allowStaging,
      stagingStyle,
    };

    console.log("[region-edit] Enqueuing job:", {
      jobId,
      imageId: jobPayload.imageId,
      mode: workerMode,
      hasBaseImageUrl: !!baseImageUrl,
      hasMask: !!maskBase64,
      maskLength: maskBase64.length,
    });

    const result = await enqueueEditJob(jobPayload);
    return res.status(200).json({ 
      success: true, 
      jobId: result.jobId 
    });
  } catch (err: any) {
    console.error("[region-edit] Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      code: err.code,
    });
  }
});
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
