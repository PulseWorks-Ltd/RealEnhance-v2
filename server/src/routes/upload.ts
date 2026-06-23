// server/src/routes/upload.ts
import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser, updateUser } from "../services/users.js";
import { cancelEnqueuedJob, createAwaitingPaymentEnhanceJob, enqueueEnhanceJob, listAwaitingPaymentEnhanceJobs } from "../services/jobs.js";
import { createPresignedUploadUrl, getS3PublicUrl, uploadOriginalToS3 } from "../utils/s3.js";
import { recordUsageEvent } from "@realenhance/shared/usageTracker";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { getUserByEmail, getUserById } from "../services/users.js";
import { enforceRetentionLimit } from "../services/imageRetention.js";
import { reserveAllowance, commitReservation, releaseReservation, getUsageSnapshot } from "../services/usageLedger.js";
import { getTrialSummary, releaseTrialReservation, reserveTrialCredits } from "../services/trials.js";
import { estimateBatchCredits } from "@realenhance/shared/billing/rules.js";
import { getAvailableCredits } from "../services/awaitingPayment.js";
import { findOrCreateProperty } from "../services/properties.js";
import { auditLog } from "../utils/audit.js";
import * as crypto from "node:crypto";

function timingSafeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function readBearerToken(req: Request): string | null {
  const raw = String(req.headers.authorization || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

const uploadRoot = path.join(process.cwd(), "server", "uploads");
const UNVERIFIED_PROCESSING_TTL_HOURS = Number(process.env.UNVERIFIED_PROCESSING_TTL_HOURS || 48);
const ENFORCE_UNVERIFIED_PROCESSING_EXPIRY = String(process.env.ENFORCE_UNVERIFIED_PROCESSING_EXPIRY || "true").toLowerCase() !== "false";

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
      const ext = path.extname(file.originalname || "");
      const base = path.basename(file.originalname || "upload", ext).replace(/[^a-zA-Z0-9._-]/g, "_");
      const uniqueName = `${Date.now()}-${crypto.randomUUID()}-${base}${ext}`;
      cb(null, uniqueName);
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

interface DirectUploadedImage {
  key: string;
}

function safeParseUploadedKeys(raw: unknown): DirectUploadedImage[] {
  const parsed = typeof raw === "string"
    ? (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    })()
    : raw;

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      if (typeof item === "string") {
        return { key: item.trim() };
      }
      if (item && typeof item === "object" && typeof (item as any).key === "string") {
        return { key: String((item as any).key).trim() };
      }
      return null;
    })
    .filter((item): item is DirectUploadedImage => Boolean(item?.key));
}

function isMultipartRequest(req: Request): boolean {
  return req.is("multipart/form-data") === "multipart/form-data";
}

const CANONICAL_ROOM_TYPES = new Set([
  "bedroom",
  "living_room",
  "dining_room",
  "kitchen",
  "kitchen_dining",
  "kitchen_living",
  "living_dining",
  "multiple_living",
  "study",
  "office",
  "bathroom",
  "bathroom_1",
  "bathroom_2",
  "laundry",
  "garage",
  "basement",
  "attic",
  "hallway",
  "sunroom",
  "staircase",
  "entryway",
  "closet",
  "pantry",
  "outdoor",
  "exterior",
  "other",
]);

function normalizeRoomType(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const aliases: Record<string, string> = {
    "bedroom-1": "bedroom",
    "bedroom-2": "bedroom",
    "bedroom-3": "bedroom",
    "bedroom-4": "bedroom",
    "living": "living_room",
    "living-room": "living_room",
    "dining": "dining_room",
    "dining-room": "dining_room",
    "multiple-living-areas": "multiple_living",
    "multiple_living_areas": "multiple_living",
    "multiple-living": "multiple_living",
    "multiple living": "multiple_living",
    "multi-living": "multiple_living",
    "kitchen & dining": "kitchen_dining",
    "kitchen-and-dining": "kitchen_dining",
    "kitchen & living": "kitchen_living",
    "kitchen-and-living": "kitchen_living",
    "living & dining": "living_dining",
    "living-and-dining": "living_dining",
    "bathroom-1": "bathroom_1",
    "bathroom-2": "bathroom_2",
    "sun-room": "sunroom",
  };
  return aliases[value] || value.replace(/-/g, "_");
}

function normalizeStagingStyle(style?: string): string {
  if (!style) return "nz_standard";

  const s = style.trim().toLowerCase();

  if (["nz_standard", "standard_listing", "standard", "default"].includes(s)) {
    return "nz_standard";
  }

  return s;
}

export function uploadRouter() {
  const r = Router();

  // If your editor still shows overload errors, this cast silences them safely.
  const uploadMw: RequestHandler = upload.array("images", 20) as unknown as RequestHandler;
  const maybeUploadMw: RequestHandler = (req, res, next) => {
    if (isMultipartRequest(req)) {
      console.warn("Legacy upload route hit – should not be used", {
        path: req.path,
        userId: (req.session as any)?.user?.id || null,
      });
      return uploadMw(req, res, next);
    }
    return next();
  };

  r.post("/upload-url", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const filename = String((req.body as any)?.filename || "").trim();
    const contentType = String((req.body as any)?.contentType || "").trim();

    if (!filename) {
      return res.status(400).json({ error: "filename_required", message: "filename is required" });
    }

    if (contentType !== "image/jpeg") {
      return res.status(400).json({ error: "invalid_content_type", message: "Only image/jpeg uploads are supported" });
    }

    try {
      const signed = await createPresignedUploadUrl({ filename, contentType, expiresIn: 300 });
      return res.json({ url: signed.url, key: signed.key });
    } catch (error: any) {
      console.error("[upload-url] failed to create signed URL", error);
      return res.status(503).json({ error: "upload_url_failed", message: error?.message || "Failed to create upload URL" });
    }
  });

  r.post("/upload", maybeUploadMw, async (req: Request, res: Response) => {
    let sessUser = (req.session as any)?.user;
    let authMode: "session" | "internal" = "session";
    let hasToken = false;

    if (!sessUser) {
      const expectedKey = String(process.env.INTERNAL_API_KEY || "").trim();
      const internalUserId = String(process.env.INTERNAL_API_USER_ID || "").trim();
      const token = readBearerToken(req);
      hasToken = !!token;

      if (!expectedKey || !token || token.length !== expectedKey.length || !timingSafeEqual(token, expectedKey)) {
        return res.status(401).json({ error: "unauthorized" });
      }

      if (!internalUserId) {
        return res.status(503).json({ error: "internal_api_user_not_configured" });
      }

      const internalUser = await getUserById(internalUserId as any);
      if (!internalUser) {
        return res.status(503).json({ error: "internal_api_user_not_found" });
      }

      if (internalUser.isSystemUser !== true) {
        return res.status(503).json({ error: "internal_api_user_not_system_user" });
      }

      if (!internalUser.agencyId) {
        return res.status(503).json({ error: "internal_api_agency_not_configured" });
      }

      (req.session as any).user = {
        id: internalUser.id,
        name: internalUser.name ?? null,
        firstName: internalUser.firstName ?? null,
        lastName: internalUser.lastName ?? null,
        displayName: internalUser.name ?? internalUser.email,
        email: internalUser.email,
        emailVerified: internalUser.emailVerified === true,
        credits: internalUser.credits,
        agencyId: internalUser.agencyId ?? null,
        role: internalUser.role ?? "member",
        hasSeenWelcome: internalUser.hasSeenWelcome === false ? false : true,
        hasReceivedSignupCredits: internalUser.hasReceivedSignupCredits === true,
      };

      sessUser = (req.session as any).user;
      authMode = "internal";
    }

    console.log("upload route auth mode:", authMode, {
      hasSession: !!sessUser,
      hasToken,
    });

    const fullUser = await getUserById(sessUser.id);
    if (!fullUser) return res.status(401).json({ error: "not_authenticated" });

    if (authMode !== "internal" && ENFORCE_UNVERIFIED_PROCESSING_EXPIRY && fullUser.emailVerified !== true) {
      const createdAtMs = new Date(fullUser.createdAt).getTime();
      if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > UNVERIFIED_PROCESSING_TTL_HOURS * 60 * 60 * 1000) {
        return res.status(403).json({
          code: "EMAIL_VERIFICATION_REQUIRED_EXPIRED",
          error: "Email verification required",
          message: "Please confirm your email address to continue processing images.",
        });
      }
    }

    const files = (req.files as Express.Multer.File[]) || [];
    const uploadedKeys = safeParseUploadedKeys((req.body as any)?.uploadedKeys);
    const uploadCount = uploadedKeys.length || files.length;
    if (!uploadCount) return res.status(400).json({ error: "no_files" });

    const optionsList = safeParseOptions((req.body as any)?.options);
    // Read high-level form toggles (string booleans)
    const allowStagingForm = String((req.body as any)?.allowStaging ?? "").toLowerCase() === "true";
    const declutterForm = String((req.body as any)?.declutter ?? "").toLowerCase() === "true";
    const declutterModeForm = String((req.body as any)?.declutterMode || "").trim();
    const stagingStyleForm = normalizeStagingStyle((req.body as any)?.stagingStyle);
    const stagingPreferenceForm = String((req.body as any)?.stagingPreference || "").trim();
    const stage2OnlyForm = String((req.body as any)?.stage2Only ?? "").toLowerCase() === "true";
    const enhanceExteriorSkyForm = String((req.body as any)?.enhanceExteriorSky ?? "").toLowerCase() === "true";
    const stage2VariantForm = String((req.body as any)?.stage2Variant || "").trim();
    const furnishedStateForm = String((req.body as any)?.furnishedState || "").trim();
    const manualSceneOverrideForm = String((req.body as any)?.manualSceneOverride ?? "").toLowerCase() === "true";
    const propertyAddressRaw = String((req.body as any)?.propertyAddress || '').trim();
    const clientBatchId = String((req.body as any)?.clientBatchId || '').trim() || undefined;
    try {
      console.log('[upload] FORM raw allowStaging=%s declutter=%s declutterMode=%s stage2Variant=%s furnishedState=%s', (req.body as any)?.allowStaging, (req.body as any)?.declutter, (req.body as any)?.declutterMode, (req.body as any)?.stage2Variant, (req.body as any)?.furnishedState);
      console.log('[upload] FORM parsed allowStagingForm=%s declutterForm=%s declutterModeForm=%s stage2VariantForm=%s furnishedStateForm=%s', String(allowStagingForm), String(declutterForm), String(declutterModeForm), stage2VariantForm || 'unset', furnishedStateForm || 'unset');
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
    let trialSummary: Awaited<ReturnType<typeof getTrialSummary>> | null = null;
    const now = new Date();

    if (authMode !== "internal" && fullUser && fullUser.agencyId) {
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

        trialSummary = await getTrialSummary(fullUser.agencyId);
        const availableCredits = await getAvailableCredits(sessUser.id);

        // Backwards compatibility: write back ACTIVE if subscriptionStatus was missing
        if (!agency.subscriptionStatus) {
          console.log(`[SUBSCRIPTION GATE] Writing back ACTIVE status for legacy agency ${fullUser.agencyId}`);
          agency.subscriptionStatus = "ACTIVE";
          // Also set grandfather flag for legacy agencies (6 months)
          const grandfatherDate = new Date();
          grandfatherDate.setMonth(grandfatherDate.getMonth() + 6);
          agency.billingGrandfatheredUntil = grandfatherDate.toISOString();
          await updateAgency(agency);
        }

        const agencyPlan = String((agency as any).planTier || "unknown");
        const agencyStatus = String((agency as any).status || "unknown");
        const subscriptionStatus = String(agency.subscriptionStatus || "unknown");
        console.log(
          `[UPLOAD_BILLING_GATE] begin ` +
          `agencyId=${fullUser.agencyId} ` +
          `agency.plan=${agencyPlan} ` +
          `agency.status=${agencyStatus} ` +
          `subscription.status=${subscriptionStatus} ` +
          `availableCredits=${availableCredits}`
        );

        const hasStripeSubscription = !!agency.stripeSubscriptionId;
        const isGrandfathered = agency.billingGrandfatheredUntil
          ? new Date(agency.billingGrandfatheredUntil) > now
          : false;

        const trialExpired = trialSummary.status === "expired" || (trialSummary.expiresAt && new Date(trialSummary.expiresAt) < now);
        const hasActiveStripeSubscription =
          hasStripeSubscription && ["ACTIVE", "TRIAL"].includes(String(agency.subscriptionStatus || "").toUpperCase());
        const hasRemainingCredits = availableCredits > 0;
        const canProcess = hasActiveStripeSubscription || hasRemainingCredits || isGrandfathered;

        if (!canProcess) {
          console.log(
            `[SUBSCRIPTION GATE] Agency ${fullUser.agencyId} blocked ` +
            `(subscriptionStatus=${agency.subscriptionStatus || "unknown"}, ` +
            `trialStatus=${trialSummary.status}, trialRemaining=${trialSummary.remaining}, ` +
            `availableCredits=${availableCredits}, hasStripeSubscription=${hasStripeSubscription})`
          );
          return res.status(403).json({
            code: hasStripeSubscription ? "SUBSCRIPTION_INACTIVE" : (trialExpired ? "TRIAL_ENDED" : "SUBSCRIPTION_REQUIRED"),
            error: hasStripeSubscription
              ? "Subscription inactive"
              : (trialExpired ? "Trial ended" : "Subscription required"),
            message: hasStripeSubscription
              ? "Your subscription is inactive. Please update your payment method or contact support."
              : (trialExpired
                ? "Your promo trial has ended. Please upgrade to continue enhancing images."
                : "Please activate your subscription or add credits to begin enhancing images."),
            requiresSubscription: true,
            subscriptionStatus: agency.subscriptionStatus,
            availableCredits,
            trial: trialSummary,
          });
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

    const userDir = path.join(uploadRoot, sessUser.id);
    await fs.mkdir(userDir, { recursive: true });

    const jobs: Array<{ jobId: string; imageId: string }> = [];
    const stagedJobs: Array<{ jobId: string; imageId: string; jobPayload: any }> = [];
    const reservedJobs: string[] = [];
    const trialReservedJobs: string[] = [];

    const releaseReservations = async () => {
      for (const jobId of reservedJobs) {
        try {
          await releaseReservation({ jobId });
        } catch (e) {
          console.error(`[upload] failed to release reservation for ${jobId}`, e);
        }
      }
      for (const jobId of trialReservedJobs) {
        try {
          await releaseTrialReservation(jobId);
        } catch (e) {
          console.error(`[upload] failed to release trial reservation for ${jobId}`, e);
        }
      }
    };

    // Get agencyId for image tracking and retention (reusing fullUser from subscription gate above)
    const agencyId = fullUser?.agencyId || undefined;
    const isIndividualAccount = !agencyId;

    let propertyIdForBatch: string | null = null;
    if (propertyAddressRaw && agencyId) {
      try {
        const property = await findOrCreateProperty({
          agencyId,
          createdByUserId: sessUser.id,
          address: propertyAddressRaw,
        });
        propertyIdForBatch = property.id;
      } catch (propertyErr) {
        console.error('[upload] Failed to resolve property address', propertyErr);
        return res.status(400).json({ error: 'invalid_property_address', message: 'Property address is invalid' });
      }
    }

    // Server-side validation: if staging is enabled, every interior image must have a valid roomType
    if (allowStagingForm) {
      const invalidRoomType: number[] = [];
      for (let i = 0; i < uploadCount; i++) {
        // Determine sceneType and roomType from metaJson or options
        const meta = metaByIndex[i] || {};
        const sceneType = meta.sceneType || (optionsList[i]?.sceneType) || "auto";
        const roomTypeRaw = meta.roomType || (optionsList[i]?.roomType);
        const roomType = normalizeRoomType(roomTypeRaw);
        if (sceneType !== "exterior") {
          // Must have a valid canonical room type string
          if (!roomType || !CANONICAL_ROOM_TYPES.has(roomType)) {
            invalidRoomType.push(i + 1);
          }
        }
      }
      if (invalidRoomType.length) {
        return res.status(400).json({
          error: "invalid_room_type",
          message: `A valid room type is required for interior image(s): ${invalidRoomType.join(", ")}`
        });
      }
    }

    // CREDIT GATE LAYER (pre-submit): enforce credits before any reservation, DB row, or enqueue
    let requiredCredits = 0;
    let availableCredits = 0;
    let monthlyRemaining = 0;
    let addonRemaining = 0;
    let requiresPayment = false;
    let deficit = 0;

    try {
      const estimateImages = Array.from({ length: uploadCount }, (_unused, i) => {
        const meta = metaByIndex[i] || {};
        const opts: any = optionsList[i] ?? {};
        const sceneType = String(meta.sceneType || opts.sceneType || "auto").toLowerCase();
        const declutter = meta.declutter !== undefined ? meta.declutter : (opts.declutter !== undefined ? opts.declutter : declutterForm);
        const virtualStage = meta.virtualStage !== undefined ? meta.virtualStage : (opts.virtualStage !== undefined ? opts.virtualStage : allowStagingForm);
        const stage2Variant =
          (meta.stage2Variant === "2A" || meta.stage2Variant === "2B")
            ? meta.stage2Variant
            : ((opts.stage2Variant === "2A" || opts.stage2Variant === "2B")
              ? opts.stage2Variant
              : (stage2VariantForm === "2A" || stage2VariantForm === "2B" ? stage2VariantForm : undefined));
        const furnishedState =
          (meta.furnishedState === "furnished" || meta.furnishedState === "empty")
            ? meta.furnishedState
            : ((opts.furnishedState === "furnished" || opts.furnishedState === "empty")
              ? opts.furnishedState
              : (furnishedStateForm === "furnished" || furnishedStateForm === "empty"
                ? furnishedStateForm
                : (stage2Variant === "2A" ? "furnished" : stage2Variant === "2B" ? "empty" : undefined)));

        // Declutter+Stage projected billing: empty -> 1 credit (skip 1B), furnished/unknown -> 2 credits.
        const stage1BProjected = !!declutter && (!virtualStage || furnishedState !== "empty");

        return {
          sceneType: sceneType === "exterior" ? "exterior" : "interior",
          userSelectedStage1B: stage1BProjected,
          userSelectedStage2: !!virtualStage,
        };
      });

      requiredCredits = estimateBatchCredits(estimateImages);
      if (agencyId) {
        const usageSnapshot = await getUsageSnapshot(agencyId);
        monthlyRemaining = Math.max(0, Number(usageSnapshot.includedRemaining || 0));
        addonRemaining = Math.max(0, Number(usageSnapshot.addonRemaining || 0));
        availableCredits = await getAvailableCredits(sessUser.id);
      } else {
        availableCredits = Math.max(0, Number(fullUser?.credits || 0));
        monthlyRemaining = availableCredits;
        addonRemaining = 0;
      }

      console.log(
        `[CREDIT_PREFLIGHT_ENFORCED] ` +
        `agencyId=${agencyId || "individual"} ` +
        `userId=${sessUser.id} ` +
        `imageCount=${uploadCount} ` +
        `requiredCredits=${requiredCredits} ` +
        `monthlyRemaining=${monthlyRemaining} ` +
        `addonRemaining=${addonRemaining} ` +
        `availableCredits=${availableCredits}`
      );

      if (requiredCredits > availableCredits) {
        if (agencyId) {
          requiresPayment = true;
          deficit = requiredCredits - availableCredits;
        } else {
          return res.status(402).json({
            code: "INSUFFICIENT_CREDITS",
            message: "Your individual account does not have enough credits to process this batch.",
            requiredCredits,
            availableCredits,
            missingCredits: requiredCredits - availableCredits,
          });
        }
      }
    } catch (creditGateErr) {
      console.error("[CREDIT_PREFLIGHT_ENFORCED] Failed to validate credits:", creditGateErr);
      return res.status(503).json({
        code: "CREDIT_CHECK_FAILED",
        message: "Unable to verify available credits. Please try again.",
      });
    }

    // Deduplicate pending jobs only for the same logical batch.
    // This prevents Start New Batch from being hijacked by older pending jobs.
    if (requiresPayment) {
      const existingAwaiting = await listAwaitingPaymentEnhanceJobs(sessUser.id);
      const normalizedClientBatchId = String(clientBatchId || "").trim();
      const nowMs = Date.now();
      const REUSE_WINDOW_MS = 2 * 60 * 1000;

      const reusableAwaiting = existingAwaiting.filter((pending) => {
        const pendingBatchId = String((pending as any)?.payload?.clientBatchId || "").trim();

        // Preferred path: explicit client batch id must match.
        if (normalizedClientBatchId) {
          return pendingBatchId === normalizedClientBatchId;
        }

        // Fallback path for legacy clients that do not send clientBatchId:
        // only reuse very recent pending jobs to cover accidental double-submit.
        const createdAtMs = Date.parse(String(pending?.createdAt || ""));
        return Number.isFinite(createdAtMs) && (nowMs - createdAtMs) <= REUSE_WINDOW_MS;
      });

      if (reusableAwaiting.length > 0) {
        const existingJobs = reusableAwaiting.map((pending) => ({
          jobId: pending.jobId,
          imageId: String((pending as any)?.payload?.imageId || ""),
        }));

        return res.json({
          requiresPayment: true,
          deficit,
          requiredCredits,
          availableCredits,
          jobs: existingJobs,
        });
      }
    }

    for (let i = 0; i < uploadCount; i++) {
      const f = files[i];
      const directUpload = uploadedKeys[i];
      const hasPerItemOptions = !!optionsList[i];
      const opts: any = optionsList[i] ?? {
        // NOTE: Do not set defaults for declutter or virtualStage here; allow form-level override below
        roomType: "unknown",
        sceneType: "auto",
      };
            // Staging style: read from per-item options or metaJson
            if (typeof (optionsList[i] || {}).stagingStyle === 'string') {
              opts.stagingStyle = normalizeStagingStyle((optionsList[i] as any).stagingStyle);
            }
      // Merge metadata from metaJson if available
      const meta = metaByIndex[i] || {};
      if (meta.sceneType) opts.sceneType = meta.sceneType;
      if (meta.roomType) opts.roomType = normalizeRoomType(meta.roomType);
      if (meta.declutter !== undefined) opts.declutter = !!meta.declutter;
      if (meta.replaceSky !== undefined) opts.replaceSky = meta.replaceSky;
      if (meta.enhanceExteriorSky !== undefined) opts.enhanceExteriorSky = !!meta.enhanceExteriorSky;
      if (meta.manualSceneOverride !== undefined) opts.manualSceneOverride = !!meta.manualSceneOverride;
      // Pass scenePrediction to worker for SKY_SAFE forcing logic
      if (meta.scenePrediction) opts.scenePrediction = meta.scenePrediction;
      if (typeof meta.stagingStyle === 'string' && !opts.stagingStyle) {
        opts.stagingStyle = normalizeStagingStyle(meta.stagingStyle);
      }
      if (meta.stage2Variant === "2A" || meta.stage2Variant === "2B") {
        opts.stage2Variant = meta.stage2Variant;
      }
      if (meta.furnishedState === "furnished" || meta.furnishedState === "empty") {
        opts.furnishedState = meta.furnishedState;
      }
      // Apply form-level stagingStyle if no per-item style is set
      if (!opts.stagingStyle && stagingStyleForm) {
        opts.stagingStyle = normalizeStagingStyle(stagingStyleForm);
      }
      // Staging preference override (refresh vs full)
      const metaStagingPreference = meta.stagingPreference;
      if (metaStagingPreference === "refresh" || metaStagingPreference === "full") {
        opts.stagingPreference = metaStagingPreference;
      } else if (stagingPreferenceForm === "refresh" || stagingPreferenceForm === "full") {
        opts.stagingPreference = stagingPreferenceForm as "refresh" | "full";
      }
      // Stage 2 variant & furnished state (per-batch or per-item)
      const metaStage2Variant = meta.stage2Variant;
      if (metaStage2Variant === "2A" || metaStage2Variant === "2B") {
        opts.stage2Variant = metaStage2Variant;
      } else if (stage2VariantForm === "2A" || stage2VariantForm === "2B") {
        opts.stage2Variant = stage2VariantForm as "2A" | "2B";
      }
      const metaFurnishedState = meta.furnishedState;
      if (metaFurnishedState === "furnished" || metaFurnishedState === "empty") {
        opts.furnishedState = metaFurnishedState;
      } else if (furnishedStateForm === "furnished" || furnishedStateForm === "empty") {
        opts.furnishedState = furnishedStateForm as "furnished" | "empty";
      }
      if (meta.stage2Only !== undefined) {
        opts.stage2Only = !!meta.stage2Only;
      } else if (stage2OnlyForm) {
        opts.stage2Only = true;
      }
            if (typeof opts.roomType === "string") {
              opts.roomType = normalizeRoomType(opts.roomType);
            }

      // Sky replacement is only valid for exterior scenes.
      // This prevents stale per-item options from keeping replaceSky=true
      // after sceneType has been changed to interior/auto.
      const normalizedSceneType = String(opts.sceneType || "auto").toLowerCase();
      if (normalizedSceneType !== "exterior") {
        opts.replaceSky = false;
      }

      // Apply form-level manualSceneOverride if set globally and not present per-item
      if (opts.manualSceneOverride === undefined && manualSceneOverrideForm) {
        opts.manualSceneOverride = true;
      }
      if (opts.enhanceExteriorSky === undefined) {
        opts.enhanceExteriorSky = enhanceExteriorSkyForm;
      }
      // Default to canonical NZ standard token.
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
      // If user explicitly chose a Stage 2 variant or furnished state, force-enable virtualStage
      if (!opts.virtualStage && (opts.stage2Variant || opts.furnishedState)) {
        opts.virtualStage = true;
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
      // Align declutter boolean with authoritative mode to avoid null skips downstream
      opts.declutter = declutterMode !== null;

      // Stage2-only must remain worker-driven: do not pre-lock furnished/refresh decisions.
      if (opts.stage2Only === true) {
        opts.stagingPreference = "auto";
        opts.furnishedState = "unknown";
        opts.stage2Variant = undefined;
      }

      // Derive Stage 2 variant defaults if still unset (except stage2Only, which is worker-resolved)
      if (!opts.stage2Variant && opts.virtualStage && opts.stage2Only !== true) {
        if (opts.stagingPreference === "refresh") {
          opts.stage2Variant = "2A";
        } else if (opts.stagingPreference === "full") {
          opts.stage2Variant = "2B";
        }
      }
      if (!opts.stage2Variant && opts.virtualStage && opts.stage2Only !== true && opts.declutterMode === "light") {
        opts.stage2Variant = "2A";
      }
      // For Declutter+Stage (stage-ready), leave variant unset when furnished state is unknown.
      // Worker furnished gate will decide deterministically per-image.
      if (!opts.stage2Variant && opts.virtualStage && opts.stage2Only !== true && opts.declutterMode !== "stage-ready") {
        opts.stage2Variant = "2B"; // safest default for non-declutter-stage flows
      }

      // Furnished state derives from variant when missing (except stage2Only, which remains unknown)
      if (!opts.furnishedState && opts.stage2Only !== true && opts.stage2Variant === "2A") {
        opts.furnishedState = "furnished";
      } else if (!opts.furnishedState && opts.stage2Only !== true && opts.stage2Variant === "2B") {
        opts.furnishedState = "empty";
      }

      // Logging for debugging
      console.log(`[upload] item ${i} RESOLVED MODE:`, {
        declutter: opts.declutter,
        virtualStage: opts.virtualStage,
        declutterMode: declutterMode,
        source: metaDeclutterMode ? 'metadata' : (declutterModeForm ? 'form' : 'derived')
      });

      try { console.log(`[upload] item ${i} after declutterMode assign: opts.declutterMode=${opts.declutterMode}`); } catch {}
      try {
        const stagesSelected = ["1A", opts.declutterMode ? "1B" : null, opts.virtualStage ? "2" : null].filter(Boolean);
        console.log(`[upload] item ${i} outbound payload`, {
          declutterMode: opts.declutterMode,
          stage2Variant: opts.stage2Variant || 'unset',
          furnishedState: opts.furnishedState || 'unset',
          stagesSelected,
        });
      } catch {}
      // Auto-enable sky replacement for exterior images if not explicitly set
      // Can be explicitly disabled by user setting replaceSky: false
      if (opts.sceneType === "exterior" && opts.replaceSky === undefined) {
        opts.replaceSky = true;
      }

      const jobId = "job_" + crypto.randomUUID();
      const finalVirtualStage = parseStrictBool(opts.virtualStage);
      const requiredImages = 1;

      const trialEligible = Boolean(
        agencyId &&
        trialSummary &&
        trialSummary.status === "active" &&
        trialSummary.remaining > 0 &&
        (!trialSummary.expiresAt || new Date(trialSummary.expiresAt) > now)
      );
      let usedTrial = false;

      if (!requiresPayment && agencyId && trialEligible) {
        try {
          const trialReserve = await reserveTrialCredits({ agencyId, jobId, requiredImages });
          if (trialReserve.allowed) {
            trialReservedJobs.push(jobId);
            usedTrial = true;
            if (trialSummary) {
              trialSummary = {
                ...trialSummary,
                remaining: Math.max(0, trialSummary.remaining - requiredImages),
              };
            }
          } else if (trialReserve.reason === "TRIAL_DEPLETED" || trialReserve.reason === "TRIAL_EXPIRED") {
            await releaseReservations();
            return res.status(402).json({ code: "TRIAL_EXHAUSTED", trial: trialSummary });
          }
        } catch (err) {
          console.error(`[upload] trial reservation failed for ${jobId}`, err);
          await releaseReservations();
          return res.status(503).json({ error: "trial_reservation_failed" });
        }
      }

      // Only reserve subscription allowance if trial did not satisfy this job
      if (!requiresPayment && agencyId && !usedTrial) {
        try {
          const reservation = await reserveAllowance({
            jobId,
            agencyId,
            userId: sessUser.id,
            requiredImages,
            requestedStage12: true,
            requestedStage2: finalVirtualStage,
          });
          reservedJobs.push(jobId);
          console.log(`[upload] reserved allowance for ${jobId}: remaining=${reservation.remaining}`);
        } catch (err: any) {
          console.error(`[upload] reservation failed for job ${jobId}`, err?.message || err);
          if (err?.code === "QUOTA_EXCEEDED") {
            await releaseReservations();
            return res.status(402).json({ code: "QUOTA_EXCEEDED", snapshot: err.snapshot });
          }
          await releaseReservations();
          return res.status(503).json({ error: "reservation_failed" });
        }
      }

      let finalPath: string | undefined;
      let recordOriginalPath: string;
      let remoteOriginalUrl: string | undefined = undefined;
      let remoteOriginalKey: string | undefined = undefined;

      if (directUpload) {
        remoteOriginalKey = directUpload.key;
        remoteOriginalUrl = getS3PublicUrl(directUpload.key);
        recordOriginalPath = directUpload.key;
      } else {
        const localFinalPath = path.join(userDir, f.filename || f.originalname);
        finalPath = localFinalPath;

        if ((f as any).path) {
          const src = path.join((f as any).destination ?? uploadRoot, f.filename);
          await fs
            .rename(src, localFinalPath)
            .catch(async () => {
              const buf = await fs.readFile((f as any).path);
              await fs.writeFile(localFinalPath, buf);
              await fs.unlink((f as any).path).catch(() => {});
            });
        }

        recordOriginalPath = localFinalPath;
      }

      const rec = createImageRecord({
        userId: sessUser.id,
        agencyId,
        jobId,
        originalPath: recordOriginalPath,
        roomType: opts.roomType,
        sceneType: opts.sceneType,
      });

      const imageId = (rec as any).imageId ?? (rec as any).id;
      await addImageToUser(sessUser.id, imageId);

      // Upload original to S3.
      // In strict mode (production or REQUIRE_S3=1), failure will abort the request.
      // In non-strict mode, we continue but mark lack of remoteOriginalUrl.
      if (!directUpload && finalPath) {
        try {
          const up = await uploadOriginalToS3(finalPath);
          remoteOriginalUrl = up.url;
          remoteOriginalKey = up.key;
        } catch (e) {
          const strict = process.env.REQUIRE_S3 === '1' || process.env.S3_STRICT === '1' || process.env.NODE_ENV === 'production';
          const msg = (e as any)?.message || String(e);
          console.warn('[upload] original S3 upload failed', msg, strict ? '(strict mode: aborting)' : '(non-strict: continuing without remote URL)');
          if (strict) {
            await releaseReservations();
            return res.status(503).json({ ok: false, error: 's3_unavailable', message: msg });
          }
        }
      }

      auditLog({
        jobId,
        imageId,
        stage: "upload",
        event: "IMAGE_UPLOADED",
        metadata: {
          sceneType: String(opts.sceneType || "unknown"),
          roomType: String(opts.roomType || "unknown"),
          virtualStage: Boolean(finalVirtualStage),
          declutter: Boolean(opts.declutter),
          originalImageUrl: remoteOriginalUrl || null,
        },
      });

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

      try { console.log(`[upload] item ${i} FINAL declutter=%s virtualStage=%s declutterMode=%s`, String(finalDeclutter), String(finalVirtualStage), String(opts.declutterMode || 'none')); } catch {}

      const jobPayload = {
        userId: sessUser.id,
        imageId,
        clientBatchId,
        remoteOriginalUrl,
        remoteOriginalKey,
        agencyId,
        propertyId: propertyIdForBatch,
        options: {
          declutter: finalDeclutter,
          declutterMode: opts.declutterMode,
          virtualStage: finalVirtualStage,
          stage2Only: !!opts.stage2Only,
          roomType: opts.roomType,
          sceneType: opts.sceneType,
          enhanceExteriorSky: !!opts.enhanceExteriorSky,
          replaceSky: opts.replaceSky,
          manualSceneOverride: opts.manualSceneOverride,
          scenePrediction: opts.scenePrediction,
          sampling: opts.sampling,
          declutterIntensity: opts.declutterIntensity,
          stagingStyle: opts.stagingStyle,
          stage2Variant: opts.stage2Variant,
          furnishedState: opts.furnishedState,
        },
      };

      stagedJobs.push({ jobId, imageId, jobPayload });
    }

    // Batch-wide finalization: only enqueue/commit after every image has passed pre-processing.
    if (requiresPayment) {
      for (const staged of stagedJobs) {
        const { jobId: awaitingJobId } = await createAwaitingPaymentEnhanceJob(staged.jobPayload, staged.jobId);
        jobs.push({ jobId: awaitingJobId, imageId: staged.imageId });

        // Track usage for analytics (non-blocking)
        recordUsageEvent({
          userId: sessUser.id,
          jobId: staged.jobId,
          imageId: staged.imageId,
          stage: "1A", // Upload always starts with stage 1A
          imagesProcessed: 1,
        });
      }
    } else {
      const enqueuedJobIds: string[] = [];
      try {
        // Enqueue everything first; if any enqueue fails, release all still-reserved credits.
        for (const staged of stagedJobs) {
          const { jobId: enqueuedJobId } = await enqueueEnhanceJob(staged.jobPayload, staged.jobId);
          enqueuedJobIds.push(enqueuedJobId);
          jobs.push({ jobId: enqueuedJobId, imageId: staged.imageId });
        }

        // Commit all reservations only after the full batch has been enqueued.
        for (const jobId of reservedJobs) {
          await commitReservation({ jobId });
        }

        // Trial reservations are only released on pre-processing/enqueue failure.
        trialReservedJobs.length = 0;
        reservedJobs.length = 0;

        if (isIndividualAccount && requiredCredits > 0 && fullUser) {
          const nextCredits = Math.max(0, Number(fullUser.credits || 0) - requiredCredits);
          await updateUser(fullUser.id, { credits: nextCredits });
          if ((req.session as any)?.user) {
            (req.session as any).user.credits = nextCredits;
          }
        }

        for (const staged of stagedJobs) {
          // Track usage for analytics (non-blocking)
          recordUsageEvent({
            userId: sessUser.id,
            jobId: staged.jobId,
            imageId: staged.imageId,
            stage: "1A", // Upload always starts with stage 1A
            imagesProcessed: 1,
          });
        }
      } catch (enqueueErr) {
        for (const enqueuedJobId of enqueuedJobIds) {
          await cancelEnqueuedJob(enqueuedJobId, "batch_enqueue_failed");
        }
        await releaseReservations();
        throw enqueueErr;
      }
    }

    // Enforce retention limit for agency (silent, non-blocking)
    // This runs after all uploads are processed to avoid blocking the response
    if (agencyId) {
      const agency = await getAgency(agencyId);
      if (agency) {
        enforceRetentionLimit(agencyId, agency.planTier ?? "starter").catch((err) => {
          console.error(`[RETENTION] Failed to enforce retention for agency ${agencyId}:`, err);
          // Do not fail the upload, just log the error
        });
      }
    }

    if (requiresPayment) {
      return res.json({
        requiresPayment: true,
        deficit,
        requiredCredits,
        availableCredits,
        jobs,
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
