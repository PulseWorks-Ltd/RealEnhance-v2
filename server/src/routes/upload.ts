// server/src/routes/upload.ts
import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser } from "../services/users.js";
import { enqueueEnhanceJob } from "../services/jobs.js";
import { uploadOriginalToS3 } from "../utils/s3.js";
import { recordUsageEvent } from "@realenhance/shared/usageTracker";
import { isUsageExhausted, getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { getUserByEmail, getUserById } from "../services/users.js";

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
    // Read high-level form toggles (string booleans)
    const allowStagingForm = String((req.body as any)?.allowStaging ?? "").toLowerCase() === "true";
    const declutterForm = String((req.body as any)?.declutter ?? "").toLowerCase() === "true";
    const declutterModeForm = String((req.body as any)?.declutterMode || "").trim();
    const stagingStyleForm = String((req.body as any)?.stagingStyle || "").trim();
    const manualSceneOverrideForm = String((req.body as any)?.manualSceneOverride ?? "").toLowerCase() === "true";
    try {
      console.log('[upload] FORM raw allowStaging=%s declutter=%s declutterMode=%s', (req.body as any)?.allowStaging, (req.body as any)?.declutter, (req.body as any)?.declutterMode);
      console.log('[upload] FORM parsed allowStagingForm=%s declutterForm=%s declutterModeForm=%s', String(allowStagingForm), String(declutterForm), String(declutterModeForm));
    } catch {}
    
    // Parse metaJson if provided (contains per-image metadata like sceneType, roomType, replaceSky)
    let metaByIndex: Record<number, any> = {};
    try {
      const metaJson = (req.body as any)?.metaJson;
      if (metaJson && typeof metaJson === "string") {
        const metaArr = JSON.parse(metaJson);
        if (Array.isArray(metaArr)) {
          metaArr.forEach((item: any) => {
            if (typeof item.index === "number") {
              metaByIndex[item.index] = item;
            }
          });
        }
      }
    } catch (e) {
      console.warn('[upload] Failed to parse metaJson:', e);
    }

    // ===== SUBSCRIPTION STATUS GATING: Check if agency subscription is active =====
    // FAIL-CLOSED: block uploads if we can't verify subscription status
    const fullUser = getUserById(sessUser.id);
    if (fullUser && fullUser.agencyId) {
      try {
        const agency = await getAgency(fullUser.agencyId);

        if (!agency) {
          // Agency record missing - this is a critical error
          console.error(`[SUBSCRIPTION GATE] Agency ${fullUser.agencyId} not found`);
          return res.status(503).json({
            code: "SUBSCRIPTION_CHECK_FAILED",
            error: "Service temporarily unavailable",
            message: "Unable to verify your subscription. Please try again or contact support.",
          });
        }

        // Allow both ACTIVE and TRIAL subscriptions
        const allowedStatuses = ["ACTIVE", "TRIAL"];
        if (!allowedStatuses.includes(agency.subscriptionStatus)) {
          console.log(`[SUBSCRIPTION GATE] Agency ${fullUser.agencyId} has inactive subscription: ${agency.subscriptionStatus}`);
          return res.status(403).json({
            code: "SUBSCRIPTION_INACTIVE",
            error: "Subscription inactive",
            message: "Your subscription is inactive. Please contact support to reactivate your account.",
            subscriptionStatus: agency.subscriptionStatus,
          });
        }

        // Backwards compatibility: write back ACTIVE if subscriptionStatus was missing
        if (!agency.subscriptionStatus) {
          console.log(`[SUBSCRIPTION GATE] Writing back ACTIVE status for legacy agency ${fullUser.agencyId}`);
          agency.subscriptionStatus = "ACTIVE";
          await updateAgency(agency);
        }

      } catch (subscriptionGateErr) {
        // FAIL-CLOSED: If we can't check subscription, block the upload
        console.error(`[SUBSCRIPTION GATE] Error checking subscription for agency ${fullUser.agencyId} (fail-closed):`, subscriptionGateErr);
        return res.status(503).json({
          code: "SUBSCRIPTION_CHECK_FAILED",
          error: "Service temporarily unavailable",
          message: "Unable to verify your subscription. Please try again or contact support.",
        });
      }
    }

    // ===== USAGE GATING: Check if agency has exhausted monthly allowance =====
    try {
      const fullUser = getUserById(sessUser.id);
      if (fullUser && fullUser.agencyId) {
        const exhaustedCheck = await isUsageExhausted(fullUser.agencyId);
        if (exhaustedCheck.exhausted) {
          const monthKey = getCurrentMonthKey();
          console.log(`[USAGE GATE] Agency ${fullUser.agencyId} exhausted usage for ${monthKey}`);
          return res.status(402).json({
            code: "USAGE_EXHAUSTED",
            error: "Plan limit reached",
            message: `Your agency has reached its monthly image limit. Please contact support to add capacity or wait until next month.`,
            monthKey,
            mainRemaining: exhaustedCheck.mainRemaining,
            stagingRemaining: exhaustedCheck.stagingRemaining,
          });
        }
      }
    } catch (usageGateErr) {
      // Fail-open: if usage check fails, allow the request to proceed
      console.error("[USAGE GATE] Error checking usage (fail-open):", usageGateErr);
    }

    const userDir = path.join(uploadRoot, sessUser.id);
    await fs.mkdir(userDir, { recursive: true });

    const jobs: Array<{ jobId: string; imageId: string }> = [];


    // Server-side validation: if staging is enabled, every interior image must have a valid roomType
    if (allowStagingForm) {
      const missingRoomType: number[] = [];
      for (let i = 0; i < files.length; i++) {
        // Determine sceneType and roomType from metaJson or options
        const meta = metaByIndex[i] || {};
        const sceneType = meta.sceneType || (optionsList[i]?.sceneType) || "auto";
        const roomType = meta.roomType || (optionsList[i]?.roomType);
        if (sceneType !== "exterior") {
          // Must have a non-empty roomType string
          if (!roomType || typeof roomType !== "string" || !roomType.trim()) {
            missingRoomType.push(i + 1);
          }
        }
      }
      if (missingRoomType.length) {
        return res.status(400).json({
          error: "missing_room_type",
          message: `Room type is required for interior image(s): ${missingRoomType.join(", ")}`
        });
      }
    }

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const hasPerItemOptions = !!optionsList[i];
      const opts: any = optionsList[i] ?? {
        // NOTE: Do not set defaults for declutter or virtualStage here; allow form-level override below
        roomType: "unknown",
        sceneType: "auto",
      };
            // Staging style: read from per-item options or metaJson
            if (typeof (optionsList[i] || {}).stagingStyle === 'string') {
              opts.stagingStyle = String((optionsList[i] as any).stagingStyle).trim();
            }
      // Merge metadata from metaJson if available
      const meta = metaByIndex[i] || {};
      if (meta.sceneType) opts.sceneType = meta.sceneType;
      if (meta.roomType) opts.roomType = meta.roomType;
      if (meta.declutter !== undefined) opts.declutter = !!meta.declutter;
      if (meta.replaceSky !== undefined) opts.replaceSky = meta.replaceSky;
      if (meta.manualSceneOverride !== undefined) opts.manualSceneOverride = !!meta.manualSceneOverride;
      if (typeof meta.stagingStyle === 'string' && !opts.stagingStyle) {
        opts.stagingStyle = String(meta.stagingStyle).trim();
      }
      // Apply form-level stagingStyle if no per-item style is set
      if (!opts.stagingStyle && stagingStyleForm) {
        opts.stagingStyle = stagingStyleForm;
      }
      // Apply form-level manualSceneOverride if set globally and not present per-item
      if (opts.manualSceneOverride === undefined && manualSceneOverrideForm) {
        opts.manualSceneOverride = true;
      }
      // CRITICAL: Default to NZ Standard Real Estate if no style specified
      if (!opts.stagingStyle || opts.stagingStyle.trim() === '') {
        opts.stagingStyle = 'nz_standard';
      }
      // Optional tuning propagated from UI per-image meta
      const temp = Number.isFinite(meta.temperature) ? Number(meta.temperature) : undefined;
      const topP = Number.isFinite(meta.topP) ? Number(meta.topP) : undefined;
      const topK = Number.isFinite(meta.topK) ? Number(meta.topK) : undefined;
      if (temp !== undefined || topP !== undefined || topK !== undefined) {
        opts.sampling = {
          ...(opts.sampling || {}),
          ...(temp !== undefined ? { temperature: temp } : {}),
          ...(topP !== undefined ? { topP } : {}),
          ...(topK !== undefined ? { topK } : {}),
        };
      }
      if (typeof meta.declutterIntensity === 'string') {
        const s = String(meta.declutterIntensity).toLowerCase();
        if (['light','standard','heavy'].includes(s)) {
          opts.declutterIntensity = s;
        }
      }
      // If no per-item options or virtualStage not explicitly set, inherit from form-level allowStaging
      // Use typeof check to ensure false is not overridden by true default
      if (!hasPerItemOptions || typeof opts.virtualStage !== 'boolean') {
        opts.virtualStage = allowStagingForm;
      }
      // If no per-item declutter provided, inherit from form-level declutter
      // Use typeof check to ensure false is not overridden by true default
      try { console.log(`[upload] item ${i} before declutter assign: hasPerItemOptions=${hasPerItemOptions} opts.declutter=${opts.declutter} declutterForm=${declutterForm}`); } catch {}
      if (!hasPerItemOptions || typeof opts.declutter !== 'boolean') {
        opts.declutter = declutterForm;
      }
      try { console.log(`[upload] item ${i} after declutter assign: opts.declutter=${opts.declutter}`); } catch {}

      // ✅ AUTHORITATIVE DECLUTTER MODE DERIVATION
      // Accept UI's explicit declutterMode if valid, otherwise derive from flags
      let declutterMode: "light" | "stage-ready" | null = null;

      // Priority 1: Check per-item metadata for explicit declutterMode
      const metaDeclutterMode = meta.declutterMode;
      if (metaDeclutterMode === "light" || metaDeclutterMode === "stage-ready") {
        declutterMode = metaDeclutterMode;
        console.log(`[upload] item ${i} → Using metadata declutterMode: ${declutterMode}`);
      }
      // Priority 2: Check form-level declutterMode
      else if (declutterModeForm === "light" || declutterModeForm === "stage-ready") {
        declutterMode = declutterModeForm as "light" | "stage-ready";
        console.log(`[upload] item ${i} → Using form declutterMode: ${declutterMode}`);
      }
      // Priority 3: Derive from declutter + virtualStage flags (legacy compatibility)
      else if (opts.declutter === true) {
        if (opts.virtualStage === true) {
          declutterMode = "stage-ready";
          console.log(`[upload] item ${i} → Derived STAGE-READY mode: declutter=true, virtualStage=true`);
        } else {
          declutterMode = "light";
          console.log(`[upload] item ${i} → Derived LIGHT mode: declutter=true, virtualStage=false`);
        }
      } else {
        console.log(`[upload] item ${i} → NO DECLUTTER: declutter=false`);
      }

      // Set authoritative mode
      opts.declutterMode = declutterMode;

      // Logging for debugging
      console.log(`[upload] item ${i} RESOLVED MODE:`, {
        declutter: opts.declutter,
        virtualStage: opts.virtualStage,
        declutterMode: declutterMode,
        source: metaDeclutterMode ? 'metadata' : (declutterModeForm ? 'form' : 'derived')
      });

      try { console.log(`[upload] item ${i} after declutterMode assign: opts.declutterMode=${opts.declutterMode}`); } catch {}
      // Auto-enable sky replacement for exterior images if not explicitly set
      // Can be explicitly disabled by user setting replaceSky: false
      if (opts.sceneType === "exterior" && opts.replaceSky === undefined) {
        opts.replaceSky = true;
      }

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

      // Upload original to S3.
      // In strict mode (production or REQUIRE_S3=1), failure will abort the request.
      // In non-strict mode, we continue but mark lack of remoteOriginalUrl.
      let remoteOriginalUrl: string | undefined = undefined;
      try {
        const up = await uploadOriginalToS3(finalPath);
        remoteOriginalUrl = up.url;
        // optionally, could store in record.versions here in future
      } catch (e) {
        const strict = process.env.REQUIRE_S3 === '1' || process.env.S3_STRICT === '1' || process.env.NODE_ENV === 'production';
        const msg = (e as any)?.message || String(e);
        console.warn('[upload] original S3 upload failed', msg, strict ? '(strict mode: aborting)' : '(non-strict: continuing without remote URL)');
        if (strict) {
          return res.status(503).json({ ok: false, error: 's3_unavailable', message: msg });
        }
      }

      // Debug summary for this item
      try {
        console.log('[upload] item %d → sceneType=%s roomType=%s replaceSky=%s virtualStage=%s declutter=%s stagingStyle=%s',
          i,
          String(opts.sceneType),
          String(opts.roomType),
          String(opts.replaceSky),
          String(opts.virtualStage),
          String(opts.declutter),
          String(opts.stagingStyle || 'none')
        );
      } catch {}

      const finalDeclutter = parseStrictBool(opts.declutter);
      const finalVirtualStage = parseStrictBool(opts.virtualStage);
      try { console.log(`[upload] item ${i} FINAL declutter=%s virtualStage=%s declutterMode=%s`, String(finalDeclutter), String(finalVirtualStage), String(opts.declutterMode || 'none')); } catch {}

      // Get user's agencyId for billing
      const fullUser = getUserById(sessUser.id);
      const agencyId = fullUser?.agencyId || null;

      const { jobId } = await enqueueEnhanceJob({
        userId: sessUser.id,
        imageId,
        remoteOriginalUrl,
        agencyId, // Pass agencyId for usage billing in worker
        options: {
          declutter: finalDeclutter,
          declutterMode: opts.declutterMode,
          virtualStage: finalVirtualStage,
          roomType: opts.roomType,
          sceneType: opts.sceneType,
          replaceSky: opts.replaceSky, // Pass through sky replacement preference
          manualSceneOverride: opts.manualSceneOverride,
          sampling: opts.sampling,
          declutterIntensity: opts.declutterIntensity,
          stagingStyle: opts.stagingStyle,
        },
      });

      jobs.push({ jobId, imageId });

      // Track usage for analytics (non-blocking)
      recordUsageEvent({
        userId: sessUser.id,
        jobId,
        imageId,
        stage: "1A", // Upload always starts with stage 1A
        imagesProcessed: 1,
      });
    }

    return res.json({ ok: true, jobs });
  });

  return r;
}

// Strict boolean parsing helper (placed at end for minimal intrusion; could be centralized later)
function parseStrictBool(v: any, defaultValue = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (["true","1","yes","y","on"].includes(s)) return true;
    if (["false","0","no","n","off",""].includes(s)) return false;
  }
  return defaultValue;
}
