import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { findByPublicUrlRedis } from "@realenhance/shared";
import { enqueueEditJob, enqueueRegionEditJob, getJob } from "../services/jobs.js";
import { computeFallbackVersionKey, getJobMetadata, recordEnhancedImageRedis, saveJobMetadata } from "@realenhance/shared/imageStore";
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

type EditSourceStage = Parameters<typeof enqueueRegionEditJob>[0]["editSourceStage"];
type ExecutionSourceStage = Parameters<typeof enqueueRegionEditJob>[0]["executionSourceStage"];

function normalizeEditSourceStage(raw?: string): EditSourceStage {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;

  if (["stage2", "2", "retry", "edit"].includes(value)) return "stage2";
  if (["stage1b", "1b"].includes(value)) return "stage1B";
  if (["stage1a", "1a", "original"].includes(value)) return "stage1A";
  return undefined;
}

function normalizeExecutionSourceStage(raw?: string): ExecutionSourceStage {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "original" || value === "original_upload") return "original";
  if (value === "1a" || value === "stage1a") return "1A";
  if (value === "1b" || value === "stage1b") return "1B";
  if (value === "2" || value === "stage2") return "2";
  if (value === "retry" || value === "retried" || value === "retry_latest") return "retry";
  if (value === "edit" || value === "edited" || value === "edit_latest") return "edit";
  return undefined;
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

function isHttpUrl(urlValue?: string): boolean {
  return !!urlValue && /^https?:\/\//i.test(urlValue);
}

function canonicalizeUrlForIdentity(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return urlValue.split("?")[0].split("#")[0];
  }
}

function deriveImageIdFromUrl(urlValue: string): string {
  const canonicalUrl = canonicalizeUrlForIdentity(urlValue);
  const digest = createHash("sha1").update(canonicalUrl).digest("hex").slice(0, 24);
  return `url_${digest}`;
}

async function resolveCanonicalRegionEditParent(sourceJobId: string): Promise<{
  parentJobId: string;
  parentImageId: string | null;
}> {
  let canonicalParentJobId = String(sourceJobId || "").trim();
  let canonicalParentImageId: string | null = null;
  const visitedJobIds = new Set<string>();

  while (canonicalParentJobId && !visitedJobIds.has(canonicalParentJobId)) {
    visitedJobIds.add(canonicalParentJobId);
    const currentJob = await getJob(canonicalParentJobId);
    if (!currentJob) break;

    const currentPayload = (((currentJob as any)?.payload || {}) as Record<string, unknown>);
    const currentImageId = String(
      currentPayload.retryParentImageId ||
      currentPayload.sourceImageId ||
      (currentJob as any)?.imageId ||
      ""
    ).trim();
    if (currentImageId) canonicalParentImageId = currentImageId;

    const nextParentJobId = String(
      currentPayload.retryParentJobId ||
      currentPayload.parentJobId ||
      currentPayload.sourceJobId ||
      ""
    ).trim();

    if (!nextParentJobId || nextParentJobId === canonicalParentJobId) {
      break;
    }
    canonicalParentJobId = nextParentJobId;
  }

  return {
    parentJobId: canonicalParentJobId || String(sourceJobId || "").trim(),
    parentImageId: canonicalParentImageId,
  };
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

    const tryRehydrateRedisFromDb = async (dbRecord: { id: string; userId: string }, lookupUrl: string): Promise<void> => {
      try {
        const noQuery = lookupUrl.split("?")[0];
        const baseKey = noQuery.split("/").pop() || "";
        const pathKey = (() => {
          try {
            const u = new URL(lookupUrl);
            return u.pathname.replace(/^\/+/, "");
          } catch {
            return baseKey;
          }
        })();
        const fallbackVersionKey = pathKey ? computeFallbackVersionKey(pathKey) : "";

        await recordEnhancedImageRedis({
          userId: dbRecord.userId,
          imageId: dbRecord.id,
          publicUrl: lookupUrl,
          baseKey,
          versionId: fallbackVersionKey,
          fallbackVersionKey,
          stage: "2",
        });

        console.log("[region-edit] Redis rehydration after DB fallback success", {
          redisMiss: true,
          dbFallbackSuccess: true,
          redisRehydrated: true,
          lookupUrl,
        });
      } catch (rehydrateErr) {
        console.warn("[region-edit] Redis rehydration failed (non-blocking)", {
          redisMiss: true,
          dbFallbackSuccess: true,
          redisRehydrated: false,
          lookupUrl,
          error: (rehydrateErr as any)?.message || rehydrateErr,
        });
      }
    };
    
    // AUDIT FIX: Idempotency guard — suppress duplicate region-edit within 30s window
    const rawSourceUrl = body.sourceUrl as string | undefined;
    const sourceUrl = normalizeLookupUrl(rawSourceUrl);
    const uiSelectedTab = typeof body.uiSelectedTab === "string" ? body.uiSelectedTab.trim() : "";
    const incomingImageId = String(body.imageId || "").trim() || null;
    const sourceJobId = typeof body.jobId === "string" ? body.jobId.trim() : undefined;
    const currentCardJobId = typeof body.currentCardJobId === "string" ? body.currentCardJobId.trim() : undefined;
    const rawEditSourceStage = typeof body.sourceStage === "string" ? body.sourceStage : undefined;
    const editSourceStage: EditSourceStage = normalizeEditSourceStage(rawEditSourceStage);
    const executionSourceStage: ExecutionSourceStage = normalizeExecutionSourceStage(
      typeof body.uiSelectedTab === "string" ? body.uiSelectedTab : rawEditSourceStage,
    );
    let effectiveExecutionSourceStage: ExecutionSourceStage = executionSourceStage;
    const baselineStage: "1A" | "1B" | "2" | undefined =
      editSourceStage === "stage2"
        ? "2"
        : editSourceStage === "stage1B"
          ? "1B"
          : editSourceStage === "stage1A"
            ? "1A"
            : undefined;
    if (sourceUrl) {
      const dedupKey = `region-edit:${sessUser.id}:${sourceUrl.slice(-40)}:${Math.floor(Date.now() / 30000)}`;
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
      sourceUrl: sourceUrl ? sourceUrl.substring(0, 80) + "..." : "MISSING",
      rawSourceUrl: rawSourceUrl ? rawSourceUrl.substring(0, 80) + "..." : "MISSING",
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
    if (!sourceUrl) {
      console.error("[region-edit] Missing sourceUrl");
      return res.status(400).json({ success: false, error: "missing_sourceUrl" });
    }

    const selectedOutputUrl = sourceUrl;

    if (!editSourceStage) {
      console.error("[region-edit] Missing sourceStage");
      return res.status(400).json({ success: false, error: "missing_sourceStage" });
    }

    if (!executionSourceStage) {
      console.error("[region-edit] Missing executionSourceStage");
      return res.status(400).json({ success: false, error: "missing_execution_source_stage" });
    }

    if (!sourceJobId) {
      console.error("[region-edit] Missing source job lineage");
      return res.status(400).json({ success: false, error: "missing_source_job_id" });
    }

    const requestedSourceJobId = sourceJobId;
    const canonicalLineage = await resolveCanonicalRegionEditParent(requestedSourceJobId);
    const parentJobId = canonicalLineage.parentJobId;
    console.log("EDIT_LINEAGE", {
      requestedSourceJobId,
      sourceJobId,
      parentJobId,
      canonicalParentImageId: canonicalLineage.parentImageId,
    });

    console.log("[SOURCE_RESOLVED]", {
      sourceUrl: selectedOutputUrl,
      sourceStage: editSourceStage,
      uiSelectedTab: uiSelectedTab || null,
      imageId: incomingImageId,
    });
    
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
    // URL is authoritative for edit source resolution. Job context is fallback metadata only.
    console.log("[region-edit] Looking up image for user:", sessUser.id);
    console.debug("[edit-source-resolution]", {
      sourceUrl: sourceUrl || null,
      sourceJobId: sourceJobId || null,
      resolution: "url-first",
    });
    let sourceEnhancedFromLookup: { id: string; propertyId: string | null; userId: string; agencyId: string } | null = null;
    let foundViaDbFallback = false;
    const resolvedLookupUrl = selectedOutputUrl;
    let resolvedBy: "url_index" | "source_job_context" | "url_derived_identity" = "url_index";

    const findByDb = async (url: string) => {
      if (!sessUser.agencyId) return null;
      return await findScopedEnhancedImageByUrl({
        agencyId: sessUser.agencyId,
        userId: sessUser.role === 'admin' || sessUser.role === 'owner' ? undefined : sessUser.id,
        publicUrl: url,
      });
    };

    const dbRecordToFound = (dbRecord: { id: string; userId: string }) => {
      return {
        record: {
          imageId: dbRecord.id,
          id: dbRecord.id,
          ownerUserId: dbRecord.userId,
        },
        versionId: "",
      };
    };

    let found: { record: { imageId: string; ownerUserId: string }; versionId: string } | null = null;
    if (isHttpUrl(selectedOutputUrl)) {
      found = await findByPublicUrl(sessUser.id, selectedOutputUrl);
      if (!found) {
        const dbFallback = await findByDb(selectedOutputUrl);
        if (dbFallback) {
          found = dbRecordToFound(dbFallback);
          sourceEnhancedFromLookup = dbFallback;
          foundViaDbFallback = true;
          console.log("[region-edit] Redis miss + DB fallback success", {
            redisMiss: true,
            dbFallbackSuccess: true,
            lookupUrl: selectedOutputUrl,
          });
          await tryRehydrateRedisFromDb(dbFallback, selectedOutputUrl);
        }
      }
    }

    if (!found && sourceJobId) {
      try {
        const sourceJob = await getJob(sourceJobId);
        const sourceJobUserId = String((sourceJob as any)?.userId || "").trim();
        const sourceJobImageId = String((sourceJob as any)?.imageId || "").trim();
        const isPrivilegedUser = sessUser.role === "admin" || sessUser.role === "owner";
        const canUseSourceJobContext = !!sourceJob && (isPrivilegedUser || sourceJobUserId === sessUser.id);

        if (canUseSourceJobContext) {
          const sourceStageUrls = ((sourceJob as any)?.stageUrls || (sourceJob as any)?.stageOutputs || {}) as Record<string, string | null | undefined>;
          const sourceStage1AUrl = resolveStage1AUrlFromJob(sourceJob as any);
          const sourceStage2Url = sourceStageUrls.stage2 || sourceStageUrls["2"] || (sourceJob as any)?.retryLatestUrl || (sourceJob as any)?.latestRetryUrl || (sourceJob as any)?.resultUrl || (sourceJob as any)?.finalOutputUrl;
          const sourceStage1BUrl = sourceStageUrls.stage1B || sourceStageUrls["1B"];

          const candidateUrls = [
            selectedOutputUrl,
            sourceStage2Url,
            sourceStage1BUrl,
            sourceStage1AUrl,
          ]
            .filter((value): value is string => isHttpUrl(value))
            .filter((value, index, arr) => arr.indexOf(value) === index);

          for (const candidateUrl of candidateUrls) {
            found = await findByPublicUrl(sessUser.id, candidateUrl);
            if (!found) {
              const dbFallback = await findByDb(candidateUrl);
              if (dbFallback) {
                found = dbRecordToFound(dbFallback);
                sourceEnhancedFromLookup = dbFallback;
                foundViaDbFallback = true;
                await tryRehydrateRedisFromDb(dbFallback, selectedOutputUrl);
              }
            }
            if (found) {
              resolvedBy = "source_job_context";
              break;
            }
          }

          if (!found && sourceJobImageId) {
            const noQuery = selectedOutputUrl.split("?")[0];
            const baseKey = noQuery.split("/").pop() || "";
            const pathKey = (() => {
              try {
                const u = new URL(selectedOutputUrl);
                return u.pathname.replace(/^\/+/, "");
              } catch {
                return baseKey;
              }
            })();
            const fallbackVersionKey = pathKey ? computeFallbackVersionKey(pathKey) : "";

            await recordEnhancedImageRedis({
              userId: sourceJobUserId || sessUser.id,
              imageId: sourceJobImageId,
              publicUrl: selectedOutputUrl,
              baseKey,
              versionId: fallbackVersionKey,
              fallbackVersionKey,
              stage: baselineStage || "2",
            });

            found = {
              record: {
                imageId: sourceJobImageId,
                ownerUserId: sourceJobUserId || sessUser.id,
              },
              versionId: fallbackVersionKey,
            };
            resolvedBy = "source_job_context";
            console.warn("[region-edit] URL history miss recovered via source job context", {
              sourceJobId,
              selectedOutputUrl,
              sourceJobImageId,
            });
          }
        }
      } catch (sourceFallbackErr: any) {
        console.warn("[region-edit] Source-job fallback lookup failed (non-blocking)", {
          sourceJobId,
          selectedOutputUrl,
          error: sourceFallbackErr?.message || sourceFallbackErr,
        });
      }
    }

    if (!found) {
      console.error("[region-edit] Image not found for URL:", selectedOutputUrl);
      return res.status(404).json({ success: false, error: "image_not_found" });
    }

    const record = found.record as any;
    const baseVersionId = found.versionId;

    console.debug("[edit-source-resolution]", {
      sourceUrl: selectedOutputUrl || null,
      sourceJobId: sourceJobId || null,
      resolution: "url-first",
      resolvedBy,
      resolvedImageId: record.imageId || record.id || null,
    });

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
      baseImageUrl = clientBaseImageUrl || selectedOutputUrl;
      console.log("[region-edit] restore_original baseImageUrl:", baseImageUrl ? baseImageUrl.substring(0, 80) + "..." : "MISSING");
    } else {
      baseImageUrl = selectedOutputUrl;
      console.log("[region-edit] Using provided edit source URL (edit mode):", baseImageUrl.substring(0, 80) + "...");
    }

    if (!selectedOutputUrl) {
      throw new Error("No valid source for edit — cannot resolve stage");
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
    let inheritedStageUrls: Record<string, string | null> | undefined = undefined;
    if (sourceJobId) {
      // Bug B fix: resolve Stage 1A reference for all edit modes (not just Add/Remove).
      // Replace and Restore also need the structural anchor for the worker's validators.
      try {
        const sourceJob = await getJob(sourceJobId);
        const sourceJobRetryUrl =
          normalizeLookupUrl(
            (sourceJob as any)?.latestRetryUrl ||
            (sourceJob as any)?.retryLatestUrl ||
            (sourceJob as any)?.result?.latestRetryUrl ||
            (sourceJob as any)?.result?.retryLatestUrl ||
            undefined,
          );
        const sourceJobEditUrl =
          normalizeLookupUrl(
            (sourceJob as any)?.latestEditUrl ||
            (sourceJob as any)?.editLatestUrl ||
            (sourceJob as any)?.result?.latestEditUrl ||
            (sourceJob as any)?.result?.editLatestUrl ||
            undefined,
          );
        if (sourceUrl && sourceJobRetryUrl && normalizeLookupUrl(sourceUrl) === sourceJobRetryUrl) {
          effectiveExecutionSourceStage = "retry";
        } else if (sourceUrl && sourceJobEditUrl && normalizeLookupUrl(sourceUrl) === sourceJobEditUrl) {
          effectiveExecutionSourceStage = "edit";
        }
        stage1AReferenceUrl = resolveStage1AUrlFromJob(sourceJob);
        const sourceJobStageUrls = (sourceJob as any)?.stageUrls || (sourceJob as any)?.stageOutputs || null;
        if (sourceJobStageUrls && typeof sourceJobStageUrls === "object") {
          inheritedStageUrls = { ...(sourceJobStageUrls as Record<string, string | null>) };
        }
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

    const sourceEnhanced = sourceEnhancedFromLookup || (sessUser.agencyId
      ? await findScopedEnhancedImageByUrl({
          agencyId: sessUser.agencyId,
          userId: sessUser.role === 'admin' || sessUser.role === 'owner' ? undefined : sessUser.id,
          publicUrl: resolvedLookupUrl,
        })
      : null);

    if (foundViaDbFallback) {
      console.log("[region-edit] Proceeding with DB-backed image lookup", {
        redisMiss: true,
        dbFallbackSuccess: true,
        resolvedLookupUrl,
        sourceImageId: sourceEnhanced?.id || record.imageId || record.id,
      });
    }

    const resolvedSourceStage: "stage1A" | "stage1B" | "stage2" = editSourceStage;
    const effectiveStageUrls: Record<string, string | null> = inheritedStageUrls
      ? { ...inheritedStageUrls }
      : {};
    if (resolvedSourceStage === "stage2") {
      if (!effectiveStageUrls.stage2) effectiveStageUrls.stage2 = baseImageUrl;
      if (!effectiveStageUrls["2"]) effectiveStageUrls["2"] = baseImageUrl;
    } else if (resolvedSourceStage === "stage1B") {
      if (!effectiveStageUrls.stage1B) effectiveStageUrls.stage1B = baseImageUrl;
      if (!effectiveStageUrls["1B"]) effectiveStageUrls["1B"] = baseImageUrl;
    } else {
      if (!effectiveStageUrls.stage1A) effectiveStageUrls.stage1A = baseImageUrl;
      if (!effectiveStageUrls["1A"]) effectiveStageUrls["1A"] = baseImageUrl;
    }

    const jobPayload: Parameters<typeof enqueueRegionEditJob>[0] = {
      userId: sessUser.id,
      agencyId: sessUser.agencyId,
      sourceJobId,
      parentJobId,
      sourceImageId: record.imageId || record.id,
      propertyId: sourceEnhanced?.propertyId || undefined,
      galleryParentImageId: sourceEnhanced?.id || null,
      imageId: record.imageId || record.id,
      currentCardJobId,
      mode: apiMode,
      editIntent,
      prompt: instruction,
      currentImageUrl: baseImageUrl,
      baseImageUrl,
      mask: maskBase64,
      sourceStage: resolvedSourceStage,
      baselineStage: resolvedSourceStage,
      stageUrls: effectiveStageUrls,
      executionSourceStage: effectiveExecutionSourceStage,
      ...(restoreFromUrl ? { restoreFromUrl } : {}),
      ...(stage1AReferenceUrl ? { stage1AReferenceUrl } : {}),
      ...(editSourceStage ? { editSourceStage } : {}),
    };

    console.log("[region-edit] Enqueuing job:", {
      jobId,
      imageId: record.imageId || record.id,
      mode: apiMode,
      sourceStage: resolvedSourceStage,
      executionSourceStage: effectiveExecutionSourceStage,
      lineageSourceUrl: resolvedSourceStage === "stage2"
        ? (effectiveStageUrls.stage2 || effectiveStageUrls["2"] || null)
        : resolvedSourceStage === "stage1B"
          ? (effectiveStageUrls.stage1B || effectiveStageUrls["1B"] || null)
          : (effectiveStageUrls.stage1A || effectiveStageUrls["1A"] || null),
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
    console.log("[IMAGE_ID_CHAIN]", {
      imageId: record.imageId || record.id,
      sourceImageId: record.imageId || record.id,
      sourceJobId: sourceJobId || null,
    });

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
        currentCardJobId,
        parentJobId,
        canonicalParentImageId: canonicalLineage.parentImageId,
        editSourceUrl: sourceUrl,
        editSourceStage,
        executionSourceStage: effectiveExecutionSourceStage,
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