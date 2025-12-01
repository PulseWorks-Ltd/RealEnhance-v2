import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findByPublicUrlRedis } from "@realenhance/shared";
import { enqueueEditJob, enqueueRegionEditJob } from "../services/jobs.js";

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

// Redis-based lookup
async function findByPublicUrl(userId: string, url: string) {
  const found = await findByPublicUrlRedis(userId, url);
  if (!found) return null;
  // For compatibility with legacy code, return a shape with 'record' and 'versionId'.
  return { 
    record: { imageId: found.imageId, ownerUserId: userId }, 
    versionId: found.versionId 
  };
}

export const regionEditRouter = Router();

// Accept ANY file fields (no more "Unexpected field")
const uploadMw: RequestHandler = upload.any();

regionEditRouter.post("/region-edit", uploadMw, async (req: Request, res: Response) => {
  console.log("[region-edit] POST hit");
  
  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      console.error("[region-edit] Not authenticated");
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


    // Get mask from req.body (sent as string from frontend) or req.files (if sent as Blob)
    let maskDataUrl = body.regionMask || body.mask;

    // If not in body, check if it was uploaded as a file
    if (!maskDataUrl && Array.isArray(req.files) && req.files.length > 0) {
      const maskFile = req.files.find(
        (f: any) => f.fieldname === 'regionMask' || f.fieldname === 'mask'
      );
      if (maskFile) {
        console.log("[region-edit] Found mask as uploaded file, converting to base64...");
        const maskBuf = await fs.readFile(maskFile.path);
        maskDataUrl = `data:${maskFile.mimetype};base64,${maskBuf.toString('base64')}`;
        console.log("[region-edit] Converted uploaded mask to data URL, length:", maskDataUrl.length);
      }
    }

    // Enhanced logging
    console.log("[region-edit] Request details:", {
      imageUrl: imageUrl ? imageUrl.substring(0, 80) + "..." : "MISSING",
      mode,
      goal: goal ? goal.substring(0, 50) + "..." : "MISSING",
      hasMask: !!maskDataUrl,
      maskType: typeof maskDataUrl,
      maskLength: maskDataUrl?.length || 0,
      bodyKeys: Object.keys(body),
    });

    // ===== VALIDATION =====
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

    // ===== IMAGE LOOKUP =====
    console.log("[region-edit] Looking up image for user:", sessUser.id);
    const found = await findByPublicUrl(sessUser.id, imageUrl);
    
    if (!found) {
      console.error("[region-edit] Image not found for URL:", imageUrl);
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    console.log("[region-edit] Image found:", {
      imageId: record.imageId,
      versionId: baseVersionId,
    });

    // ===== DETERMINE BASE IMAGE URL =====
    let baseImageUrl: string = imageUrl; // Default to provided URL
    
    // If there's a newer version in the record, use that
    if (record && record.latest && record.latest.publicUrl) {
      baseImageUrl = record.latest.publicUrl;
      console.log("[region-edit] Using latest version:", baseImageUrl.substring(0, 80) + "...");
    } else {
      console.log("[region-edit] Using provided URL:", baseImageUrl.substring(0, 80) + "...");
    }

    // ===== PROCESS MASK =====
    let maskBase64: string;
    try {
      if (maskDataUrl.startsWith("data:image/")) {
        // Strip data URL prefix: "data:image/png;base64,xxxxx" -> "xxxxx"
        maskBase64 = maskDataUrl.split(",")[1];
        console.log("[region-edit] Stripped data URL prefix, mask length:", maskBase64.length);
      } else {
        // Already base64
        maskBase64 = maskDataUrl;
        console.log("[region-edit] Mask already base64, length:", maskBase64.length);
      }
    } catch (e) {
      console.error("[region-edit] Failed to process mask:", e);
      return res.status(400).json({ success: false, error: "invalid_mask_format" });
    }

    // ===== BUILD INSTRUCTION =====
    const instruction = mode === "edit" 
      ? goal 
      : "Restore original pixels for the masked region.";

    // ===== DETERMINE WORKER MODE (robust intent parsing) =====
    let workerMode: "Add" | "Remove" | "Replace" | "Restore";
    if (mode === "restore_original") {
      // User wants to restore original pixels - no Gemini needed
      workerMode = "Restore";
    } else if (mode === "edit") {
      // User wants to edit - parse their instruction
      const goalLower = goal.toLowerCase();
      if (goalLower.includes("add") || goalLower.includes("place") || goalLower.includes("insert")) {
        workerMode = "Add";
      } else if (goalLower.includes("remove") || goalLower.includes("delete") || goalLower.includes("take out")) {
        workerMode = "Remove";
      } else {
        // Default to Replace for other edits (change, modify, etc.)
        workerMode = "Replace";
      }
    } else {
      // Fallback
      workerMode = "Replace";
    }

    console.log("[region-edit] User goal:", goal);
    console.log("[region-edit] Selected mode:", mode);
    console.log("[region-edit] Worker mode:", workerMode);

    // ===== CREATE JOB PAYLOAD =====
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;



    // Determine restoreFromUrl for pixel-level restoration
    let restoreFromUrl: string | undefined = undefined;
    if (workerMode === "Restore") {
      // Prefer Stage 1B or original image for restoration
      restoreFromUrl = record.latest?.stage1BUrl || record.latest?.originalUrl || baseImageUrl;
    }

    const jobPayload = {
      userId: sessUser.id,
      mode: workerMode.toLowerCase(),
      prompt: instruction,
      currentImageUrl: baseImageUrl,
      baseImageUrl,
      mask: maskBase64,
      ...(restoreFromUrl ? { restoreFromUrl } : {}),
    };

    console.log("[region-edit] Enqueuing job:", {
      jobId,
      imageId: record.imageId || record.id,
      mode: apiMode,
      baseImageUrlLength: baseImageUrl.length,
      maskLength: maskBase64.length,
      instructionLength: instruction.length,
    });

    // ===== ENQUEUE JOB =====
    // Debug: log payload fields before enqueuing
    console.log("[region-edit] Job payload keys:", Object.keys(jobPayload));
    console.log("[region-edit] Has 'mask' field:", 'mask' in jobPayload);
    console.log("[region-edit] Mask field value type:", typeof jobPayload.mask);
    console.log("[region-edit] Mask field value length:", jobPayload.mask?.length || 0);

    const result = await enqueueRegionEditJob(jobPayload);

    console.log("[region-edit] Job enqueued successfully:", result.jobId);

    return res.status(200).json({ 
        success: true, 
        jobId: result.jobId 
    });

    console.log("[region-edit] Job enqueued successfully:", result.jobId);

    return res.status(200).json({ 
      success: true, 
      jobId: result.jobId 
    });
    
  } catch (err: any) {
    console.error("[region-edit] Fatal error:", err);
    console.error("[region-edit] Error stack:", err.stack);
    
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      code: err.code,
    });
  }
});