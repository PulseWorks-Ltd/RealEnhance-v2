import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findByPublicUrlRedis } from "@realenhance/shared";
import { enqueueEditJob, enqueueRegionEditJob, getJob } from "../services/jobs.js";
import { getJobMetadata, saveJobMetadata } from "@realenhance/shared/imageStore";
import { getRedis } from "@realenhance/shared/redisClient.js"; // AUDIT FIX: idempotency guard
import { findScopedEnhancedImageByUrl } from "../services/enhancedImages.js";
import { consumeFreeEditCount } from "../services/usageLedger.js";

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

function normalizeLookupUrl(urlValue?: string): string {
  if (!urlValue) return "";
  try {
    const parsed = new URL(urlValue);
    const transientParams = ["v", "t", "ts", "cb", "cacheBust"];
    transientParams.forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function resolveStage1AUrlFromJob(jobRecord: any): string | undefined {
  if (!jobRecord || typeof jobRecord !== "object") return undefined;

  const stageUrls = (jobRecord.stageUrls || {}) as Record<string, string | null | undefined>;
  const candidates = [
    stageUrls.stage1A,
    stageUrls["1A"],
    stageUrls["1"],
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  const byStageUrl = candidates.find((u) => /^https?:\/\//i.test(u));
  if (byStageUrl) return byStageUrl;

  // Some older jobs may store URL-like values in stageOutputs; prefer stage1A keys only.
  const stageOutputs = (jobRecord.stageOutputs || {}) as Record<string, string | null | undefined>;
  const stageOutputCandidates = [
    stageOutputs["1A"],
    stageOutputs.stage1A as any,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  return stageOutputCandidates.find((u) => /^https?:\/\//i.test(u));
}

export const regionEditRouter = Router();

// Accept ANY file fields (no more "Unexpected field")
const uploadMw: RequestHandler = upload.any();

regionEditRouter.post("/region-edit", uploadMw, async (req: Request, res: Response) => {
  console.log("[region-edit] POST hit");
  console.log("[region-edit] Session ID:", req.session.id);
  console.log("[region-edit] Session user:", (req.session as any)?.user ? 'exists' : 'MISSING');
  console.log("[region-edit] Cookie:", req.headers.cookie ? 'present' : 'MISSING');

  try {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      console.error("[region-edit] Not authenticated - session user is missing");
      console.error("[region-edit] Full session:", JSON.stringify(req.session, null, 2));
      return res.status(401).json({ success: false, error: "not_authenticated" });
    }

    const body = (req.body || {}) as any;
    
    // AUDIT FIX: Idempotency guard — suppress duplicate region-edit within 30s window
    const rawImageUrl = body.imageUrl as string | undefined;
    const imageUrl = normalizeLookupUrl(rawImageUrl);
    const rawEditSourceUrl = body.editSourceUrl as string | undefined;
    const editSourceUrl = normalizeLookupUrl(rawEditSourceUrl);
    const sourceLookupUrl = editSourceUrl || imageUrl;
    const sourceJobId = typeof body.jobId === "string" ? body.jobId : undefined;
    const rawEditSourceStage = typeof body.editSourceStage === "string" ? body.editSourceStage : undefined;
    const editSourceStage =
      rawEditSourceStage === "stage2" || rawEditSourceStage === "stage1B" || rawEditSourceStage === "stage1A"
        ? rawEditSourceStage
        : undefined;
    if (sourceLookupUrl) {
      const dedupKey = `region-edit:${sessUser.id}:${sourceLookupUrl.slice(-40)}:${Math.floor(Date.now() / 30000)}`;
      const redis = getRedis();
      const exists = await redis.get(dedupKey);
      if (exists) {
        console.log(`[region-edit] Duplicate suppressed: ${dedupKey}`);
        return res.status(409).json({ success: false, error: "duplicate_request", message: "Duplicate region edit suppressed" });
      }
      await redis.setEx(dedupKey, 35, "1");
    }
    
    // Extract all fields from body
    const rawClientBaseImageUrl = body.baseImageUrl as string | undefined;
    const clientBaseImageUrl = normalizeLookupUrl(rawClientBaseImageUrl);
    const mode = body.mode as "edit" | "restore_original" | undefined;
    const explicitEditIntent = typeof body.editIntent === "string" ? body.editIntent.trim().toLowerCase() : undefined;
    const editIntent = explicitEditIntent === "add" || explicitEditIntent === "remove" || explicitEditIntent === "replace"
      ? (explicitEditIntent as "add" | "remove" | "replace")
      : undefined;
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
      rawImageUrl: rawImageUrl ? rawImageUrl.substring(0, 80) + "..." : "MISSING",
      editSourceUrl: editSourceUrl ? editSourceUrl.substring(0, 80) + "..." : "MISSING",
      rawEditSourceUrl: rawEditSourceUrl ? rawEditSourceUrl.substring(0, 80) + "..." : "MISSING",
      editSourceStage: editSourceStage || "MISSING",
      sourceJobId: sourceJobId || "MISSING",
      clientBaseImageUrl: clientBaseImageUrl ? clientBaseImageUrl.substring(0, 80) + "..." : "MISSING",
      rawClientBaseImageUrl: rawClientBaseImageUrl ? rawClientBaseImageUrl.substring(0, 80) + "..." : "MISSING",
      mode,
      goal: goal ? goal.substring(0, 50) + "..." : "MISSING",
      hasMask: !!maskDataUrl,
      maskType: typeof maskDataUrl,
      maskLength: maskDataUrl?.length || 0,
      bodyKeys: Object.keys(body),
    });

    // ===== VALIDATION =====
    if (!sourceLookupUrl) {
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
    let found = await findByPublicUrl(sessUser.id, sourceLookupUrl);
    
    // Fix A: If primary URL not found, try baseImageUrl (client sends both)
    // This handles the case where stageUrls["2"] differs from resultUrl
    // (double S3 upload gives different keys) or Redis data loss
    if (!found && clientBaseImageUrl && clientBaseImageUrl !== sourceLookupUrl) {
      console.warn("[region-edit] Primary URL not found, trying baseImageUrl fallback:", clientBaseImageUrl.substring(0, 80) + "...");
      found = await findByPublicUrl(sessUser.id, clientBaseImageUrl);
      if (found) {
        console.log("[region-edit] Found image via baseImageUrl fallback");
      }
    }

    if (!found) {
      console.error("[region-edit] Image not found for URL:", sourceLookupUrl);
      console.error("[region-edit] Also tried baseImageUrl:", clientBaseImageUrl || "N/A");
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    const editCounterJobId = `edit_counter:${record.imageId || record.id}`;
    const editUse = await consumeFreeEditCount({
      imageId: String(record.imageId || record.id),
      userId: sessUser.id,
    });
    if (!editUse.allowed) {
      return res.status(429).json({
        success: false,
        error: "edit_limit_reached",
        code: "EDIT_LIMIT_REACHED",
        editCount: editUse.count,
        message: "You have reached the maximum allowed free edits for this image. Please submit a new enhancement.",
      });
    }

    const editMeta = await getJobMetadata(editCounterJobId);

    const baseEditMeta = editMeta && editMeta.jobId
      ? editMeta
      : {
          jobId: editCounterJobId,
          userId: sessUser.id,
          imageId: record.imageId || record.id,
          createdAt: new Date().toISOString(),
        };

    await saveJobMetadata({
      ...baseEditMeta,
      freeEditCount: editUse.count,
      freeEditLimit: editUse.limit,
      editCount: editUse.count,
      lastEditAt: new Date().toISOString(),
    } as any);

    console.log("[region-edit] Image found:", {
      imageId: record.imageId,
      versionId: baseVersionId,
    });

    // ===== DETERMINE BASE IMAGE URL =====
    // For restore_original we want to honor the Stage 1 URL that the
    // client derived (baseImageUrl). For edit mode we keep the previous
    // behavior of preferring the latest stored version.
    let baseImageUrl: string;

    if (mode === "restore_original") {
      baseImageUrl = clientBaseImageUrl || sourceLookupUrl;
      console.log("[region-edit] restore_original baseImageUrl:", baseImageUrl ? baseImageUrl.substring(0, 80) + "..." : "MISSING");
    } else {
      baseImageUrl = sourceLookupUrl;
      console.log("[region-edit] Using provided edit source URL (edit mode):", baseImageUrl.substring(0, 80) + "...");
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

    // ===== DETERMINE WORKER MODE (explicit intent first, parser fallback) =====
    let workerMode: "Add" | "Remove" | "Replace" | "Restore";
    if (mode === "restore_original") {
      // User wants to restore original pixels - no Gemini needed
      workerMode = "Restore";
    } else if (mode === "edit") {
      // Prefer explicit client intent; fall back to goal parsing for backward compatibility.
      if (editIntent === "add") {
        workerMode = "Add";
      } else if (editIntent === "remove") {
        workerMode = "Remove";
      } else if (editIntent === "replace") {
        workerMode = "Replace";
      } else {
        const goalLower = goal.toLowerCase();
        if (goalLower.includes("add") || goalLower.includes("place") || goalLower.includes("insert")) {
          workerMode = "Add";
        } else if (goalLower.includes("remove") || goalLower.includes("delete") || goalLower.includes("take out")) {
          workerMode = "Remove";
        } else {
          // Default to Replace for other edits (change, modify, etc.)
          workerMode = "Replace";
        }
      }
    } else {
      // Fallback
      workerMode = "Replace";
    }

    console.log("[region-edit] User goal:", goal);
    console.log("[region-edit] Selected mode:", mode);
    console.log("[region-edit] Explicit editIntent:", editIntent || "none");
    console.log("[region-edit] Worker mode:", workerMode);

    // ===== CREATE JOB PAYLOAD =====
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;



    // Determine restoreFromUrl for pixel-level restoration
    let restoreFromUrl: string | undefined = undefined;
    if (workerMode === "Restore") {
      // Edit contract: restoration source must remain the currently visible committed output.
      restoreFromUrl = baseImageUrl;
    }

    let stage1AReferenceUrl: string | undefined = undefined;
    if ((workerMode === "Add" || workerMode === "Remove") && sourceJobId) {
      try {
        const sourceJob = await getJob(sourceJobId);
        stage1AReferenceUrl = resolveStage1AUrlFromJob(sourceJob);
        if (!stage1AReferenceUrl) {
          console.warn("[region-edit] No Stage-1A reference URL resolved from source job", { sourceJobId });
        }
      } catch (stage1AErr) {
        console.warn("[region-edit] Failed to resolve Stage-1A reference URL (non-blocking)", {
          sourceJobId,
          error: (stage1AErr as any)?.message || stage1AErr,
        });
      }
    }

    // Map workerMode to API mode for enqueueRegionEditJob
    // Note: "Replace" mode should use Gemini, not pixel restoration
    let apiMode: "add" | "remove" | "restore" | "replace";
    if (workerMode === "Add") {
      apiMode = "add";
    } else if (workerMode === "Remove") {
      apiMode = "remove";
    } else if (workerMode === "Restore") {
      apiMode = "restore";
    } else {
      // "Replace" mode - modify the masked area
      apiMode = "replace";
    }

    const sourceEnhanced = sessUser.agencyId
      ? await findScopedEnhancedImageByUrl({
          agencyId: sessUser.agencyId,
          userId: sessUser.role === 'admin' || sessUser.role === 'owner' ? undefined : sessUser.id,
          publicUrl: sourceLookupUrl,
        })
      : null;

    const jobPayload = {
      userId: sessUser.id,
      agencyId: sessUser.agencyId,
      sourceJobId,
      sourceImageId: sourceEnhanced?.id,
      propertyId: sourceEnhanced?.propertyId || undefined,
      imageId: record.imageId || record.id,
      mode: apiMode,
      editIntent,
      prompt: instruction,
      currentImageUrl: baseImageUrl,
      baseImageUrl,
      mask: maskBase64,
      ...(restoreFromUrl ? { restoreFromUrl } : {}),
      ...(stage1AReferenceUrl ? { stage1AReferenceUrl } : {}),
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

    // Persist job metadata for retry
    const meta: any = {
      jobId: result.jobId,
      userId: sessUser.id,
      operation: "region-edit",
      imageId: record.imageId || record.id,
      originalImageUrl: baseImageUrl,
      prompt: instruction,
      mask: maskBase64 || null,
      options: {
        mode: apiMode,
        editIntent,
        restoreFromUrl,
        stage1AReferenceUrl,
        sourceJobId,
        editSourceUrl: editSourceUrl || sourceLookupUrl,
        editSourceStage,
        sceneType,
        roomType,
        allowStaging,
        stagingStyle,
      },
      createdAt: new Date().toISOString(),
    };
    await saveJobMetadata(meta);

    console.log("[region-edit] Job enqueued successfully:", result.jobId);
    console.log("[region-edit] Returning response:", { success: true, jobId: result.jobId });

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