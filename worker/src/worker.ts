import type { ComplianceVerdict } from "./ai/compliance";
import { Worker, Job } from "bullmq";
import { JOB_QUEUE_NAME } from "@realenhance/shared/constants";
import {
  AnyJobPayload,
  EnhanceJobPayload,
  EditJobPayload,
  RegionEditJobPayload
} from "@realenhance/shared/types";

import fs from "fs";
import sharp from "sharp";

import { runStage1A } from "./pipeline/stage1A";
import { runStage1B } from "./pipeline/stage1B";
import { runStage2 } from "./pipeline/stage2";
import { computeStructuralEdgeMask } from "./validators/structuralMask";
import { applyEdit } from "./pipeline/editApply";
import { preprocessToCanonical } from "./pipeline/preprocess";

import { detectSceneFromImage, determineSkyMode, type SkyModeResult } from "./ai/scene-detector";
import { detectRoomType } from "./ai/room-detector";
import { classifyScene } from "./validators/scene-classifier";

import {
  updateJob,
  pushImageVersion,
  readImageRecord,
  getVersionPath,
  getOriginalPath
} from "./utils/persist";
import { setVersionPublicUrl } from "./utils/persist";
import { recordEnhancedImage } from "../../shared/src/imageHistory";
import { recordEnhancedImageRedis } from "@realenhance/shared";
import { getGeminiClient, enhanceWithGemini } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64 } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";
import { publishImage } from "./utils/publish";
import { downloadToTemp } from "./utils/remote";
import { runStructuralCheck } from "./validators/structureValidatorClient";
import { getLocalValidatorMode, getGeminiValidatorMode, isGeminiBlockingEnabled, logValidationModes } from "./validators/validationModes";
import {
  runUnifiedValidation,
  logUnifiedValidationCompact,
  type UnifiedValidationResult
} from "./validators/runValidation";
const STAGE1B_MAX_ATTEMPTS = Math.max(1, Number(process.env.STAGE1B_MAX_ATTEMPTS || 2));
import { runSemanticStructureValidator } from "./validators/semanticStructureValidator";
import { runMaskedEdgeValidator } from "./validators/maskedEdgeValidator";
import { canStage, logStagingBlocked, type SceneType } from "../../shared/staging-guard";
import { vLog, nLog } from "./logger";
import { VALIDATOR_FOCUS } from "./config";
import { recordEnhanceBundleUsage, recordEditUsage, recordRegionEditUsage } from "./utils/usageTracking";
import { finalizeReservationFromWorker } from "./utils/reservations.js";
import { recordEnhancedImage as recordEnhancedImageHistory } from "./db/enhancedImages.js";
import { generateAuditRef, generateTraceId } from "./utils/audit.js";

/**
 * OPTIMIZED GEMINI API CALL STRATEGY
 * ==================================
 * 
 * To minimize costs and API calls, we use these strategies:
 * 
 * Case A - Enhance Only (no declutter, no staging):
 *   • Stage 1A: Sharp pre-process → 1 Gemini call (enhance-only prompt) → save as 1A
 *   • Total: 1 Gemini call per image
 * 
 * Case B - Enhance + Declutter (no staging):
 *   • Stage 1A: Sharp pre-process → save as 1A (no Gemini, just technical prep)
 *   • Stage 1B: 1 Gemini call (combined enhance+declutter prompt) → save as 1B
 *   • Total: 1 Gemini call per image (saves cost vs separate enhance + declutter)
 * 
 * Case C - Enhance + Declutter + Staging:
 *   • Stage 1A: Sharp pre-process → save as 1A (no Gemini)
 *   • Stage 1B: 1 Gemini call (combined enhance+declutter prompt) → save as 1B
 *   • Stage 2: 1 Gemini call (virtual staging) → save as 2
 *   • Total: 2 Gemini calls per image
 * 
 * Maximum reduction: From 3 potential calls → 2 max, 1 typical
 */

// handle "enhance" pipeline
async function handleEnhanceJob(payload: EnhanceJobPayload) {
  nLog(`========== PROCESSING JOB ${payload.jobId} ==========`);
  if ((payload as any).retryType === "manual_retry") {
    nLog(`[JOB_START] retryType=manual_retry sourceStage=${(payload as any).retrySourceStage || 'upload'} sourceUrl=${(payload as any).retrySourceUrl || 'n/a'} sourceKey=${(payload as any).retrySourceKey || 'n/a'} parentJobId=${(payload as any).retryParentJobId || 'n/a'}`);
  }

  // Re-hydrate and repair job metadata contract for ownership validation
  const buildRequestedStages = (): any => ({
    stage1a: true,
    stage1b: (payload as any).options?.declutter
      ? ((payload as any).options?.declutterMode === "light" ? "light" : "full")
      : undefined,
    stage2: !!(payload as any).options?.virtualStage,
    stage2Mode: (payload as any).options?.virtualStage
      ? ((payload as any).options?.stagingPreference === "refresh"
        ? "refresh"
        : (payload as any).options?.stagingPreference === "full"
          ? "empty"
          : "auto")
      : undefined,
  });

  try {
    const [liveJob, savedMeta] = await Promise.all([
      getJob(payload.jobId),
      getJobMetadata(payload.jobId),
    ]);

    const existingMeta = (liveJob as any)?.metadata as JobOwnershipMetadata | undefined;
    const merged: JobOwnershipMetadata = {
      userId: savedMeta?.userId || existingMeta?.userId || payload.userId,
      imageId: savedMeta?.imageId || existingMeta?.imageId || payload.imageId,
      jobId: payload.jobId,
      createdAt: savedMeta?.createdAt || existingMeta?.createdAt || payload.createdAt || new Date().toISOString(),
      requestedStages: savedMeta?.requestedStages || existingMeta?.requestedStages || buildRequestedStages(),
      stageUrls: savedMeta?.stageUrls || existingMeta?.stageUrls,
      resultUrl: savedMeta?.resultUrl || existingMeta?.resultUrl,
      s3: savedMeta?.s3 || existingMeta?.s3,
      warnings: savedMeta?.warnings || existingMeta?.warnings,
      debug: savedMeta?.debug || existingMeta?.debug,
    };

    const missingFields: string[] = [];
    if (!savedMeta?.userId && !existingMeta?.userId) missingFields.push("userId");
    if (!savedMeta?.imageId && !existingMeta?.imageId) missingFields.push("imageId");
    if (!savedMeta?.requestedStages && !existingMeta?.requestedStages) missingFields.push("requestedStages");
    if (missingFields.length) {
      nLog(`[JOB_META_REPAIRED] jobId=${payload.jobId} missingFields=${missingFields.join(",")}`);
    }

    await Promise.all([
      updateJob(payload.jobId, { metadata: merged }),
      saveJobMetadata(merged, JOB_META_TTL_PROCESSING_SECONDS),
    ]);
  } catch (metaErr: any) {
    nLog(`[JOB_META_WARN] Failed to repair metadata for job ${payload.jobId}: ${metaErr?.message || metaErr}`);
  }

  let stage12Success = false;
  let stage2Success = false;
  let stage2AttemptsUsed = 0;
  let stage2MaxAttempts = 1;
  let stage2ValidationRisk = false;
  let stage2Blocked = false;
  let stage2BlockedReason: string | undefined;
  let stage2FallbackStage: "1A" | "1B" | null = null;
  let fallbackUsed: string | null = null;
  let stage2NeedsConfirm = false;
  let stage2LocalReasons: string[] = [];
  const localValidatorMode = getLocalValidatorMode();
  const geminiValidatorMode = getGeminiValidatorMode();
  const geminiBlockingEnabled = isGeminiBlockingEnabled();
  const VALIDATION_BLOCKING_ENABLED = localValidatorMode === "block";
  const structureValidatorMode = localValidatorMode;
  logValidationModes();
  // Surface job metadata globally for downstream logging
  (global as any).__jobId = payload.jobId;
  (global as any).__jobRoomType = (payload.options as any)?.roomType;
  // Strict boolean normalization to avoid truthy string issues (e.g. "false" becoming true)
  const strictBool = (v: any): boolean => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (["true","1","yes","y","on"].includes(s)) return true;
      if (["false","0","no","n","off",""] .includes(s)) return false;
    }
    return false;
  };
  const rawDeclutter = (payload as any).options.declutter;
  const rawVirtualStage = (payload as any).options.virtualStage;
  (payload as any).options.declutter = strictBool(rawDeclutter);
  (payload as any).options.virtualStage = strictBool(rawVirtualStage);
  if (typeof rawDeclutter !== 'boolean') {
    nLog(`[WORKER] Normalized declutter '${rawDeclutter}' → ${payload.options.declutter}`);
  }
  if (typeof rawVirtualStage !== 'boolean') {
    nLog(`[WORKER] Normalized virtualStage '${rawVirtualStage}' → ${payload.options.virtualStage}`);
  }
  
  // Check if we have a remote original URL (multi-service deployment)
  const remoteUrl: string | undefined = (payload as any).remoteOriginalUrl;
  let origPath: string;
  
  if (remoteUrl) {
    // Multi-service mode: Download original from S3
    try {
      nLog(`[WORKER] Remote original detected, downloading: ${remoteUrl}\n`);
      origPath = await downloadToTemp(remoteUrl, payload.jobId);
      nLog(`[WORKER] Remote original downloaded to: ${origPath}\n`);
    } catch (e) {
      nLog(`[WORKER] ERROR: Failed to download remote original: ${(e as any)?.message || e}\n`);
      updateJob(payload.jobId, { status: "failed", errorMessage: `Failed to download original: ${(e as any)?.message || 'unknown error'}` });
      return;
    }
  } else {
    // Legacy single-service mode: Read from local filesystem
    nLog("[WORKER] WARN: Job lacks remoteOriginalUrl. Attempting to read from local filesystem.\n");
    nLog("[WORKER] In production multi-service deployment, server should upload originals to S3 and provide remoteOriginalUrl.\n");
    
    const rec = readImageRecord(payload.imageId);
    if (!rec) {
      nLog(`[WORKER] ERROR: Image record not found for ${payload.imageId} and no remoteOriginalUrl provided.\n`);
      updateJob(payload.jobId, { status: "failed", errorMessage: "image not found - no remote URL and local record missing" });
      return;
    }
    origPath = getOriginalPath(rec);
    if (!fs.existsSync(origPath)) {
      nLog(`[WORKER] ERROR: Local original file not found at ${origPath}\n`);
      updateJob(payload.jobId, { status: "failed", errorMessage: "original file not accessible in this container" });
      return;
    }
  }

  // Track primary scene detection (interior/exterior) confidence across all flows
  let scenePrimary: any = undefined;

  // ═══════════ STAGE-2-ONLY RETRY MODE ═══════════
  // ✅ Smart retry: Skip 1A/1B, run only Stage-2 from validated 1B output
  if (payload.stage2OnlyMode?.enabled && payload.stage2OnlyMode?.base1BUrl) {
    nLog(`[worker] 🚀 ═══════════ STAGE-2-ONLY RETRY MODE ACTIVATED ═══════════`);
    nLog(`[worker] Reusing validated Stage-1B output: ${payload.stage2OnlyMode.base1BUrl}`);

    try {
      const timings: Record<string, number> = {};
      const t0 = Date.now();
      const t2 = Date.now();

      // Download Stage-1B base image
      const basePath = await downloadToTemp(payload.stage2OnlyMode.base1BUrl, `${payload.jobId}-stage1B`);
      nLog(`[worker] Downloaded Stage-1B base to: ${basePath}`);

      // Run Stage-2 only (using 1B as base)
      const stage2Result = await runStage2(basePath, "1B", {
        stagingStyle: payload.options.stagingStyle || "nz_standard",
        roomType: payload.options.roomType,
        sceneType: payload.options.sceneType as any,
        angleHint: undefined,
        profile: undefined,
        stagingRegion: undefined,
        jobId: payload.jobId,
      });
      const path2 = stage2Result.outputPath;

      timings.stage2Ms = Date.now() - t2;
      nLog(`[worker] Stage-2-only completed in ${timings.stage2Ms}ms`);

      // Run validators on Stage-2 output (log-only)
      const sceneLabel = payload.options.sceneType === "exterior" ? "exterior" : "interior";

      // Note: runStructuralCheck requires URLs, but we'll skip geometry for stage2-only for now
      // The semantic and masked edge validators are the key ones for Stage-2

      await runSemanticStructureValidator({
        originalImagePath: basePath,
        enhancedImagePath: path2,
        scene: sceneLabel as any,
        mode: "log",
      });

      await runMaskedEdgeValidator({
        originalImagePath: basePath,
        enhancedImagePath: path2,
        scene: sceneLabel as any,
        mode: "log",
        jobId: payload.jobId,
      });

      // Publish Stage-2 result
      const pub2 = await publishImage(path2);
      const pub2Url = pub2.url;

      stage2Success = true;

      timings.totalMs = Date.now() - t0;

      updateJob(payload.jobId, {
        status: "complete",
        resultUrl: pub2Url,
        stageUrls: {
          "1A": null,
          "1B": payload.stage2OnlyMode.base1BUrl,
          "2": pub2Url
        },
        meta: {
          stage2OnlyRetry: true,
          timings,
          scene: { label: sceneLabel as any, confidence: scenePrimary?.confidence ?? null }
        }
      });

      // Finalize reservation with bundled pricing: Stage1 already done, Stage2 succeeded here
      try {
        await finalizeReservationFromWorker({
          jobId: payload.jobId,
          stage12Success: true,
          stage2Success: true,
        });
        nLog(`[BILLING] Finalized reservation for stage2-only retry: ${payload.jobId}`);
      } catch (billingErr) {
        nLog("[BILLING] Failed to finalize reservation (stage2-only retry):", (billingErr as any)?.message || billingErr);
      }

      nLog(`[worker] ✅ Stage-2-only retry complete: ${pub2Url}`);
      return; // ✅ Exit early - full pipeline not needed

    } catch (err: any) {
      nLog(`[worker] ❌ Stage-2-only retry failed: ${err?.message || err}`);
      nLog(`[worker] Falling back to full pipeline retry`);
      // Continue to full pipeline below
    }
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  // UNIFIED VALIDATION CONFIGURATION (env-driven)
  nLog(`[worker] Validator config: structureMode=${structureValidatorMode}, blocking=${VALIDATION_BLOCKING_ENABLED ? "ENABLED" : "DISABLED"}`);

  // VALIDATOR FOCUS MODE: Print session header
  if (VALIDATOR_FOCUS) {
    vLog("════════ IMAGE VALIDATION SESSION ════════");
    const imageLabel = (payload as any).label || (payload as any).originalFilename || payload.imageId || 'unknown';
    vLog(`[VAL][job=${payload.jobId}] label="${imageLabel}"`);
    vLog(`[VAL][job=${payload.jobId}] originalUrl=${remoteUrl || origPath}`);
  }

  // Publish original so client can render before/after across services
  nLog(`\n[WORKER] ═══════════ Publishing original image ═══════════`);
  const publishedOriginal = await publishImage(origPath);
  nLog(`[WORKER] Original published: kind=${publishedOriginal?.kind} url=${(publishedOriginal?.url||'').substring(0, 80)}...\n\n`);
  // surface early so UI can show before/after immediately
  updateJob(payload.jobId, { status: "processing", currentStage: "upload-original", stage: "upload-original", progress: 10, originalUrl: publishedOriginal?.url });

  // Auto detection: primary scene (interior/exterior) + room type
  let detectedRoom: string | undefined;
  let sceneLabel = (payload.options.sceneType as any) || "auto";
  let allowStaging = true;
  let stagingRegionGlobal: any = null;

  // ═══════════════════════════════════════════════════════════════════════════════
  // SKY_SAFE FORCING LOGIC (V1 Launch Safety)
  // ═══════════════════════════════════════════════════════════════════════════════
  // Manual scene override flag passed from client/server
  const manualSceneOverride = strictBool((payload as any).manualSceneOverride) || strictBool(((payload as any).options || {}).manualSceneOverride);

  // Client-side scene prediction (passed from upload for SKY_SAFE forcing)
  const clientScenePrediction = (payload.options as any)?.scenePrediction;
  const SCENE_CONF_THRESHOLD = Number(process.env.SCENE_CONF_THRESHOLD || 0.65);

  // Determine if scene was uncertain from client prediction
  const requiresSceneConfirm = ((): boolean => {
    if (!clientScenePrediction) return false; // No client prediction → auto-detected by worker
    if (clientScenePrediction.scene === null) return true; // Explicit null scene
    if (clientScenePrediction.reason === "uncertain") return true; // Uncertain reason
    if (clientScenePrediction.reason === "covered_exterior_suspect") return true; // Covered exterior suspect
    const conf = typeof clientScenePrediction.confidence === "number" ? clientScenePrediction.confidence : 0;
    if (conf < SCENE_CONF_THRESHOLD) return true; // Below threshold
    return false;
  })();

  // Track whether to force SKY_SAFE (user involvement indicator)
  const hasManualSceneOverride = !!manualSceneOverride;

  const tScene = Date.now();
  try {
    const buf = fs.readFileSync(origPath);
    // Primary scene (ONNX + heuristic fallback)
    const primary = await detectSceneFromImage(buf);
    scenePrimary = primary;
    const fmt = (v: any) => typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : "n/a";
    nLog(`[SCENE] primary=${primary?.label ?? "unknown"} conf=${fmt(primary?.confidence)} sky=${fmt((primary as any)?.skyPct)} grass=${fmt((primary as any)?.grassPct)} deck=${fmt((primary as any)?.woodDeckPct)}`);

    // Sky mode determination for exteriors (SKY_SAFE vs SKY_STRONG)
    if (primary?.label === "exterior") {
      const baseSkyModeResult = determineSkyMode(primary);

      // ═══════════════════════════════════════════════════════════════════════════
      // FORCE SKY_SAFE RULE: If user was involved (uncertain scene OR manual override)
      // ═══════════════════════════════════════════════════════════════════════════
      const effectiveScene = sceneLabel !== "auto" ? sceneLabel : primary?.label;
      const forceSkySafe = effectiveScene === "exterior" && (requiresSceneConfirm || hasManualSceneOverride);

      // Apply force-safe override if needed
      const finalSkyModeResult = forceSkySafe ? {
        ...baseSkyModeResult,
        mode: "safe" as const,
        allowStrongSky: false,
        forcedSafe: true,
        forcedReason: requiresSceneConfirm ? "scene_uncertain" : "manual_override"
      } : baseSkyModeResult;

      (scenePrimary as any).skyModeResult = finalSkyModeResult;

      // Enhanced logging for debugging
      nLog(`[SKY_MODE] mode=${finalSkyModeResult.mode} allowStrongSky=${finalSkyModeResult.allowStrongSky} coveredSuspect=${baseSkyModeResult.coveredExteriorSuspect}`);
      nLog(`[SKY_MODE] features: skyTop10=${fmt(finalSkyModeResult.features.skyTop10)} skyTop40=${fmt(finalSkyModeResult.features.skyTop40)} blueOverall=${fmt(finalSkyModeResult.features.blueOverall)}`);
      nLog(`[SKY_MODE] thresholds: skyTop40Min=${finalSkyModeResult.thresholds.skyTop40Min} blueOverallMin=${finalSkyModeResult.thresholds.blueOverallMin}`);
      if (forceSkySafe) {
        nLog(`[SKY_MODE] ⚠️ FORCED SKY_SAFE: reason=${(finalSkyModeResult as any).forcedReason} requiresSceneConfirm=${requiresSceneConfirm} hasManualSceneOverride=${hasManualSceneOverride}`);
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // PER-FILE SCENE/SKY DECISION LOG (PART B - One line per file)
      // ═══════════════════════════════════════════════════════════════════════════
      const clientPred = clientScenePrediction;
      const skyReplacementAllowed = finalSkyModeResult.mode === "strong";
      console.log(`[SCENE_SKY_DECISION] imageId=${payload.imageId} ` +
        `scene=${effectiveScene} skyMode=${finalSkyModeResult.mode} confidence=${fmt(primary?.confidence)} ` +
        `coveredExteriorSuspect=${baseSkyModeResult.coveredExteriorSuspect} ` +
        `skyReplacementAllowed=${skyReplacementAllowed} ` +
        `reason=${(finalSkyModeResult as any).forcedReason || (skyReplacementAllowed ? 'confident_open_sky' : 'features_below_threshold')} ` +
        `envThresholds={skyTop40Min:${finalSkyModeResult.thresholds.skyTop40Min},blueOverallMin:${finalSkyModeResult.thresholds.blueOverallMin}} ` +
        `features={skyTop10:${fmt(finalSkyModeResult.features.skyTop10)},skyTop40:${fmt(finalSkyModeResult.features.skyTop40)},blueOverall:${fmt(finalSkyModeResult.features.blueOverall)}} ` +
        `clientPrediction=${clientPred?.scene ?? 'null'}/${fmt(clientPred?.confidence)}/${clientPred?.reason ?? 'n/a'} ` +
        `manualOverride=${hasManualSceneOverride} requiresConfirm=${requiresSceneConfirm}`);
    }
    // Room type (ONNX + heuristic fallback; fallback again to legacy heuristic)
    let room = await detectRoomType(buf).catch(async () => null as any);
    if (!room) {
      const heur = await classifyScene(origPath);
      room = { label: heur.label, confidence: heur.confidence } as any;
    }
    detectedRoom = room.label as string;
    // Use primary scene detector for interior/exterior when sceneType=auto
    if (sceneLabel === "auto" || !sceneLabel) sceneLabel = (primary?.label as any) || "interior";
    // Outdoor staging area detection for exteriors
    let stagingRegion: any = null;
    // Master kill switch for outdoor staging (default OFF for V1 launch)
    const outdoorStagingEnabled = (process.env.OUTDOOR_STAGING_ENABLED || '0') === '1';
    if (sceneLabel === "exterior" && !outdoorStagingEnabled) {
      nLog(`[WORKER] Outdoor staging disabled via OUTDOOR_STAGING_ENABLED=0 (default for V1)`);
    }
    if (sceneLabel === "exterior" && outdoorStagingEnabled) {
      try {
        const { getGeminiClient } = await import("./ai/gemini.js");
        const { detectStagingArea } = await import("./ai/staging-area-detector.js");
        const { detectStagingRegion } = await import("./ai/region-detector.js");
        const sharpMod: any = await import("sharp");
        const ai = getGeminiClient();
        const base64 = toBase64(origPath).data;
        const stagingResult = await detectStagingArea(ai, base64);
        // ---------- Exterior gating rules ----------
        // Allowed types and confidence
        const allowedTypes = (process.env.EXTERIOR_STAGING_ALLOWED_TYPES || "deck,patio,balcony,terrace,verandah")
          .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        const minConfLevel = (process.env.EXTERIOR_STAGING_MIN_CONFIDENCE_LEVEL || "medium").toLowerCase();
        const confRank = (c: string) => c === 'high' ? 3 : (c === 'medium' ? 2 : 1);
        const minRank = confRank(minConfLevel);

        // Initial decision from detector
        allowStaging = !!stagingResult.hasStagingArea;
        // Area type filter (defensive)
        const areaType = String(stagingResult.areaType || 'none').toLowerCase();
        if (!allowedTypes.includes(areaType)) {
          allowStaging = false;
          nLog(`[WORKER] Exterior gating: areaType='${areaType}' not in allowedTypes=[${allowedTypes.join(', ')}] → disallow staging`);
        }
        // Confidence gate
        const level = String(stagingResult.confidence || 'low').toLowerCase();
        if (confRank(level) < minRank) {
          allowStaging = false;
          nLog(`[WORKER] Exterior gating: confidence='${level}' < minLevel='${minConfLevel}' → disallow staging`);
        }

        // Region detection only if preliminarily allowed
        if (allowStaging) {
          stagingRegion = await detectStagingRegion(ai, base64);
          // Compute coverage % if region detected and image size known
          try {
            const meta = await sharpMod.default(origPath).metadata();
            const W = meta.width || 0;
            const H = meta.height || 0;
            if (stagingRegion && W > 0 && H > 0) {
              const area = Math.max(0, Math.min(stagingRegion.width, W)) * Math.max(0, Math.min(stagingRegion.height, H));
              const coverage = area / (W * H);
              const minCoverage = Number(process.env.EXTERIOR_STAGING_MIN_COVERAGE || 0.2);
              // Optional: require region to exist for staging
              const requireRegion = (process.env.EXTERIOR_STAGING_REQUIRE_REGION || '1') === '1';
              if (coverage < minCoverage) {
                allowStaging = false;
                nLog(`[WORKER] Exterior staging region below threshold: ${(coverage*100).toFixed(1)}% < ${(minCoverage*100).toFixed(0)}% → disallow staging`);
              } else {
                nLog(`[WORKER] Exterior staging region coverage: ${(coverage*100).toFixed(1)}% (>= ${(minCoverage*100).toFixed(0)}%)`);
              }
              if (requireRegion && !stagingRegion) {
                allowStaging = false;
                nLog(`[WORKER] Exterior gating: requireRegion=1 but no region detected → disallow staging`);
              }
              // If region has areaType metadata, ensure it matches allowed types
              const regionType = String((stagingRegion as any)?.areaType || areaType).toLowerCase();
              if (!allowedTypes.includes(regionType)) {
                allowStaging = false;
                nLog(`[WORKER] Exterior gating: region.areaType='${regionType}' not allowed → disallow staging`);
              }
              // Green dominance sanity check inside region (avoid staging on lawns)
              const greenCheck = (process.env.EXTERIOR_REGION_GREEN_CHECK || '1') === '1';
              if (allowStaging && greenCheck) {
                try {
                  const analysisSize = Math.max(64, Number(process.env.EXTERIOR_REGION_ANALYSIS_SIZE || 256));
                  const H_MIN = Number(process.env.EXTERIOR_GREEN_H_MIN || 70);
                  const H_MAX = Number(process.env.EXTERIOR_GREEN_H_MAX || 160);
                  const S_MIN = Number(process.env.EXTERIOR_GREEN_S_MIN || 0.28);
                  const V_MIN = Number(process.env.EXTERIOR_GREEN_V_MIN || 0.25);
                  const maxGreen = Math.min(0.9, Math.max(0, Number(process.env.EXTERIOR_REGION_GREEN_MAX || 0.25)));
                  // Shrink region by 5% margins to avoid boundary bleed
                  const shrinkX = Math.floor(stagingRegion.width * 0.05);
                  const shrinkY = Math.floor(stagingRegion.height * 0.05);
                  const rx = Math.max(0, Math.min(W - 1, Math.floor(stagingRegion.x + shrinkX)));
                  const ry = Math.max(0, Math.min(H - 1, Math.floor(stagingRegion.y + shrinkY)));
                  const rw = Math.max(1, Math.min(W - rx, Math.floor(stagingRegion.width - shrinkX * 2)));
                  const rh = Math.max(1, Math.min(H - ry, Math.floor(stagingRegion.height - shrinkY * 2)));
                  const patch = await sharpMod.default(origPath)
                    .extract({ left: rx, top: ry, width: rw, height: rh })
                    .resize(analysisSize, analysisSize, { fit: 'cover' })
                    .raw()
                    .toBuffer({ resolveWithObject: true });
                  const buf = patch.data as Buffer;
                  const w = analysisSize, h = analysisSize;
                  let green = 0, total = 0;
                  for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                      const i = (y * w + x) * 3; // raw() defaults to 3 channels without alpha
                      const r = buf[i] / 255, g = buf[i+1] / 255, b = buf[i+2] / 255;
                      const max = Math.max(r,g,b), min = Math.min(r,g,b);
                      const v = max; const d = max - min; const s = max === 0 ? 0 : d / max;
                      let hdeg = 0;
                      if (d !== 0) {
                        if (max === r) hdeg = ((g - b) / d) % 6; else if (max === g) hdeg = (b - r) / d + 2; else hdeg = (r - g) / d + 4;
                        hdeg *= 60; if (hdeg < 0) hdeg += 360;
                      }
                      const isGreen = (v > V_MIN) && (s > S_MIN) && (hdeg >= H_MIN && hdeg <= H_MAX);
                      if (isGreen) green++;
                      total++;
                    }
                  }
                  const greenRatio = green / Math.max(1, total);
                  const decision = greenRatio <= maxGreen;
                  nLog(`[WORKER] Exterior region green check: green=${(greenRatio*100).toFixed(1)}% max=${(maxGreen*100).toFixed(0)}% → ${decision ? 'allow' : 'disallow'}`);
                  if (!decision) {
                    allowStaging = false;
                  }
                } catch (e) {
                  nLog('[WORKER] Green-region check failed; proceeding without this gate', e);
                }
              }
              // attach coverage for meta/debugging
              (stagingRegion as any).coverage = coverage;
            }
          } catch (e) {
            nLog('[WORKER] Failed to compute staging coverage; proceeding without area gate', e);
          }
        }
        nLog(`[WORKER] Outdoor staging area: has=${stagingResult.hasStagingArea}, type=${stagingResult.areaType}, conf=${stagingResult.confidence}`);
        nLog(`[WORKER] Exterior staging decision: allowStaging=${allowStaging} (minConf=${minConfLevel}, minCoverage=${Number(process.env.EXTERIOR_STAGING_MIN_COVERAGE || 0.2)})`);
        if (stagingRegion) {
          nLog(`[WORKER] Staging region:`, stagingRegion);
        }
        stagingRegionGlobal = stagingRegion;
      } catch (e) {
        allowStaging = false;
        stagingRegion = null;
        stagingRegionGlobal = null;
        nLog(`[WORKER] Outdoor staging area/region detection failed, defaulting to no staging:`, e);
      }
    }
    // store interim meta (non-fatal if write fails)
    updateJob(payload.jobId, { meta: {
      scene: { label: sceneLabel as any, confidence: primary?.confidence ?? null },
      scenePrimary: primary,
      allowStaging,
      stagingRegion: stagingRegionGlobal,
      roomTypeDetected: detectedRoom,
      roomType: payload.options.roomType || undefined
    } });
    try {
      nLog(`[WORKER] Scene resolved: primary=${primary?.label}(${(primary?.confidence??0).toFixed(2)}) → resolved=${sceneLabel}, room=${room.label}`);
    } catch {}
  } catch {
    if (sceneLabel === "auto" || !sceneLabel) sceneLabel = "other" as any;
    allowStaging = false;
  }
  timings.sceneDetectMs = Date.now() - tScene;

  const sceneMeta = { scene: { label: sceneLabel as any, confidence: scenePrimary?.confidence ?? null }, scenePrimary };

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "failed", errorMessage: "cancelled" });
    return;
  }

  // CANONICAL PREPROCESS (new) for structural baseline
  let canonicalPath = origPath.replace(/\.(jpg|jpeg|png|webp)$/i, "-canonical.webp");
  try {
    await preprocessToCanonical(origPath, canonicalPath, sceneLabel);
    (global as any).__canonicalPath = canonicalPath;
    // Precompute structural mask (architecture only) from canonical
    try {
      const mask = await computeStructuralEdgeMask(canonicalPath);
      (global as any).__structuralMask = mask;
      nLog(`[WORKER] Structural mask computed: ${mask.width}x${mask.height}`);
    } catch (e) {
      nLog('[WORKER] Failed to compute structural mask:', e);
    }
  } catch (e) {
    nLog('[WORKER] Canonical preprocess failed; falling back to original for stages', e);
    canonicalPath = origPath; // fallback
    (global as any).__canonicalPath = canonicalPath;
  }

  // STAGE 1A
  const t1A = Date.now();
  // Inject per-job tuning into global for pipeline modules (simple dependency injection)
  try {
    const s = (payload.options as any)?.sampling || {};
    (global as any).__jobSampling = {
      temperature: typeof s.temperature === 'number' ? s.temperature : undefined,
      topP: typeof s.topP === 'number' ? s.topP : undefined,
      topK: typeof s.topK === 'number' ? s.topK : undefined,
    };
    (global as any).__jobDeclutterIntensity = (payload.options as any)?.declutterIntensity;
  } catch {}
  let path1A: string = origPath;
  // Stage 1A: Always run Gemini for quality enhancement (HDR, color, sharpness)
  // SKY SAFEGUARD: compute safeReplaceSky using manual override + pergola/roof detection
  let safeReplaceSky: boolean = ((): boolean => {
    const explicit = (payload.options.replaceSky as any);
    const explicitBool = typeof explicit === 'boolean' ? explicit : undefined;
    const defaultExterior = sceneLabel === "exterior";
    return explicitBool === undefined ? defaultExterior : explicitBool;
  })();

  // Force-safe when user was involved (uncertain scene or manual override)
  const effectiveSceneForSafe = sceneLabel !== "auto" ? sceneLabel : (scenePrimary?.label || "interior");
  const forceSkySafeForReplace = effectiveSceneForSafe === "exterior" && (requiresSceneConfirm || hasManualSceneOverride);
  if (forceSkySafeForReplace) {
    safeReplaceSky = false;
    nLog(`[WORKER] Sky Safeguard: forceSkySafe=1 (requiresSceneConfirm=${requiresSceneConfirm}, hasManualSceneOverride=${hasManualSceneOverride}) → disable sky replacement`);
  }

  if (manualSceneOverride) {
    safeReplaceSky = false;
    nLog(`[WORKER] Sky Safeguard: manualSceneOverride=1 → disable sky replacement`);
  }
  if (sceneLabel === "exterior") {
    try {
      const { detectRoofOrPergola } = await import("./validators/pergolaGuard.js");
      const hasRoof = await detectRoofOrPergola(origPath);
      if (hasRoof) {
        safeReplaceSky = false;
        nLog(`[WORKER] Sky Safeguard: pergola/roof detected → disable sky replacement`);
      }
    } catch (e) {
      nLog(`[WORKER] Sky Safeguard: pergola detector error (fail-open):`, (e as any)?.message || e);
    }
  }

  // Determine sky mode from scene detection results (already force-safe applied in detection block)
  const skyModeForStage1A = (scenePrimary as any)?.skyModeResult?.mode || "safe";
  nLog(`[STAGE1A] Final: sceneLabel=${sceneLabel} skyMode=${skyModeForStage1A} safeReplaceSky=${safeReplaceSky}`);
  path1A = await runStage1A(canonicalPath, {
    replaceSky: safeReplaceSky,
    declutter: false, // Never declutter in Stage 1A - that's Stage 1B's job
    sceneType: sceneLabel,
    interiorProfile: ((): any => {
      const p = (payload.options as any)?.interiorProfile;
      if (p === 'nz_high_end' || p === 'nz_standard') return p;
      return undefined;
    })(),
    skyMode: skyModeForStage1A,
    jobId: payload.jobId,
    roomType: payload.options.roomType,
  });
  nLog(`[stage1a] Gemini validation skipped by design (local-only sanity checks)`);
  timings.stage1AMs = Date.now() - t1A;
  
  // Record 1A version (optional in multi-service mode where images.json is not shared)
  let v1A: any = null;
  try {
    v1A = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1A", filePath: path1A, note: "Quality enhanced" });
  } catch (e) {
    // Silently ignore - images.json is not available in multi-service deployment
    // This is expected and normal behavior
  }
  
  let pub1AUrl: string | undefined = undefined;
  let pub1BUrl: string | undefined = undefined;
  try {
    const pub1A = await publishImage(path1A);
    pub1AUrl = pub1A.url;
    if (v1A) {
      try {
        setVersionPublicUrl(payload.imageId, v1A.versionId, pub1A.url);
      } catch (e) {
        // Ignore - images.json not accessible in multi-service mode
      }
    }
    // VALIDATOR FOCUS: Log Stage 1A URL
    vLog(`[VAL][job=${payload.jobId}] stage1AUrl=${pub1AUrl}`);
  } catch (e) {
    nLog('[worker] failed to publish 1A', e);
  }
  updateJob(payload.jobId, { status: "processing", currentStage: "1A", stage: "1A", progress: 35, stageUrls: { "1A": pub1AUrl ?? null } });
  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "failed", errorMessage: "cancelled" });
    return;
  }

  // STAGE 1B (optional declutter)
  const t1B = Date.now();
  let path1B: string | undefined = undefined;
  let stage1BStructuralSafe = true;
  
  // ✅ STRICT PAYLOAD MODE ONLY — NO INFERENCE OR DEFAULTS
  const declutterMode = (payload.options as any).declutterMode;

  nLog(`[WORKER] Checking Stage 1B: payload.options.declutter=${payload.options.declutter}`);
  nLog(`[WORKER] Stage 1B declutterMode from payload: ${declutterMode || 'null'}`);
  nLog(`[WORKER] Stage 1B virtualStage: ${payload.options.virtualStage}`);

  if (!declutterMode) {
    nLog(`[WORKER] ❌ Stage 1B DISABLED — declutterMode is null, skipping`);
  } else {
    // ✅ VALIDATE MODE
    if (declutterMode !== "light" && declutterMode !== "stage-ready") {
      const errMsg = `Invalid declutterMode: "${declutterMode}". Must be "light" or "stage-ready"`;
      console.error(`❌ ${errMsg}`);
      console.error(`Payload options:`, JSON.stringify(payload.options, null, 2));
      updateJob(payload.jobId, {
        status: "failed",
        errorMessage: errMsg,
        error: errMsg,
        meta: { ...sceneMeta }
      });
      throw new Error(errMsg);
    }

    nLog(`[WORKER] ✅ Stage 1B ENABLED - mode: ${declutterMode}`);
    nLog(`[WORKER] Mode explanation: ${declutterMode === "light" ? "Remove clutter/mess, keep furniture" : "Remove ALL furniture (empty room ready for staging)"}`);
    nLog(`[WORKER] virtualStage setting: ${payload.options.virtualStage}`);

    const runStage1BWithValidation = async (mode: "light" | "stage-ready", attempt: number) => {
      const output = await runStage1B(path1A, {
        replaceSky: false,
        sceneType: sceneLabel,
        roomType: payload.options.roomType,
        declutterMode: mode,
        jobId: payload.jobId,
      });

      const verdict = await runUnifiedValidation({
        originalPath: path1A,
        enhancedPath: output,
        stage: "1B",
        sceneType: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        roomType: payload.options.roomType,
        mode: "log", // Advisory only; never block locally
        jobId: payload.jobId,
        stage1APath: path1A,
      });

      const needsConfirm = localValidatorMode === "block" ? !verdict.passed : false;
      const advisoryReasons = verdict.reasons || [];
      if (!verdict.passed) {
        const msg = advisoryReasons.length ? advisoryReasons.join("; ") : "Stage 1B structural validation flagged issues";
        nLog(`[stage1B][attempt=${attempt}] validation advisory: ${msg}`);
      }

      return { output, verdict, needsConfirm, advisoryReasons };
    };

    let stage1BAttempts = 0;
    const maxAttempts = STAGE1B_MAX_ATTEMPTS;
    let useLightFallback = false;
    let lastError: string | undefined;
    let stage1BNeedsConfirm = false;
    let stage1BLocalReasons: string[] = [];

    while (true) {
      stage1BAttempts += 1;
      const currentMode: "light" | "stage-ready" = useLightFallback ? "light" : declutterMode as any;
      nLog(`[stage1B] Attempt ${stage1BAttempts}/${useLightFallback ? 1 : maxAttempts} mode=${currentMode}`);
      try {
        const { output, verdict, needsConfirm, advisoryReasons } = await runStage1BWithValidation(currentMode, stage1BAttempts);
        path1B = output;
        stage1BStructuralSafe = verdict.passed;
        stage1BNeedsConfirm = needsConfirm;
        stage1BLocalReasons = advisoryReasons;
        if (needsConfirm && VALIDATION_BLOCKING_ENABLED && stage1BAttempts < maxAttempts && !useLightFallback) {
          const msg = verdict.reasons?.length ? verdict.reasons.join("; ") : "stage1B validation flagged";
          nLog(`[stage1B] advisory failure, retrying: ${msg}`);
          continue;
        }
        break;
      } catch (err: any) {
        lastError = err?.message || String(err);
        nLog(`[stage1B] attempt ${stage1BAttempts} failed: ${lastError}`);
        const exhausted = useLightFallback || stage1BAttempts >= maxAttempts;
        if (exhausted && !useLightFallback && declutterMode === "stage-ready") {
          // Switch to light declutter fallback for one attempt
          useLightFallback = true;
          stage1BAttempts = 0;
          nLog(`[stage1B] Switching to light declutter fallback after failures in stage-ready mode`);
          continue;
        }
        if (exhausted) {
          const errMsg = `Stage 1B failed after ${stage1BAttempts} attempt(s): ${lastError}`;
            updateJob(payload.jobId, {
              status: "failed",
              errorMessage: errMsg,
              error: errMsg,
              meta: { ...sceneMeta, stage1BAttempts }
            });
            return;
        }
      }
    }

    const stage1BLocalStatus = stage1BNeedsConfirm ? "needs_confirm" : "pass";
    nLog(`[LOCAL_VALIDATE] stage=1B status=${stage1BLocalStatus} reasons=${JSON.stringify(stage1BLocalReasons)}`);

    // Gemini confirmation layer for Stage1B (only when local mode requires confirm)
    if (stage1BNeedsConfirm && path1B) {
      const { confirmWithGeminiStructure } = await import("./validators/confirmWithGeminiStructure.js");
      const confirm = await confirmWithGeminiStructure({
        baselinePathOrUrl: path1A,
        candidatePathOrUrl: path1B,
        stage: "stage1b",
        roomType: payload.options.roomType,
        sceneType: sceneLabel as any,
        jobId: payload.jobId,
        localReasons: stage1BLocalReasons,
      });
      nLog(`[GEMINI_CONFIRM] stage=1B status=${confirm.status} confirmedFail=${confirm.confirmedFail} reasons=${JSON.stringify(confirm.reasons)}`);

      if (confirm.confirmedFail) {
        const errMsg = confirm.reasons.join("; ") || "Stage1B blocked by Gemini confirmation";
        if (geminiBlockingEnabled) {
          nLog(`[VALIDATE_FINAL] stage=1B decision=block blockedBy=gemini_confirm override=false`);
          updateJob(payload.jobId, {
            status: "failed",
            errorMessage: errMsg,
            error: errMsg,
            meta: { ...sceneMeta, stage1BAttempts, stage1BLocalReasons, geminiConfirm: confirm },
          });
          return;
        }
      }

      updateJob(payload.jobId, {
        meta: {
          ...sceneMeta,
          stage1BAttempts,
          stage1BLocalReasons,
          geminiConfirm: { ...confirm, override: !confirm.confirmedFail },
        }
      });
      nLog(`[VALIDATE_FINAL] stage=1B decision=accept blockedBy=${confirm.confirmedFail && geminiBlockingEnabled ? "gemini_confirm" : "none"} override=${confirm.confirmedFail ? !geminiBlockingEnabled : true}`);
    } else {
      nLog(`[VALIDATE_FINAL] stage=1B decision=accept blockedBy=none override=${!stage1BNeedsConfirm}`);
    }

    timings.stage1BMs = Date.now() - t1B;
    if (await isCancelled(payload.jobId)) {
      updateJob(payload.jobId, { status: "failed", errorMessage: "cancelled" });
      return;
    }
  }

  // Record Stage 1B publish if it exists and is different from 1A
  // pub1BUrl already declared above; removed duplicate
  if (path1B && path1B !== path1A) {
    try {
      const pub1B = await publishImage(path1B);
      pub1BUrl = pub1B.url;
      updateJob(payload.jobId, { status: "processing", currentStage: payload.options.declutter ? "1B" : "1A", stage: payload.options.declutter ? "1B" : "1A", progress: 55, stageUrls: { "1B": pub1BUrl }, imageUrl: pub1BUrl });
    } catch (e) {
      nLog('[worker] failed to publish 1B', e);
    }
  }

  // ═══════════ Post-1B Structural Validation (LOG-ONLY) ═══════════

  if (path1B && pub1AUrl && pub1BUrl) {
    try {
      nLog(`[worker] ═══════════ Running Post-1B Structural Validators ═══════════`);

      // Geometry validator (requires published URLs)
      const geo = await runStructuralCheck(pub1AUrl, pub1BUrl, { stage: "stage1B", jobId: payload.jobId });

      const sem = await runSemanticStructureValidator({
        originalImagePath: path1A,
        enhancedImagePath: path1B,
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
      });

      const mask = await runMaskedEdgeValidator({
        originalImagePath: path1A,
        enhancedImagePath: path1B,
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
        jobId: payload.jobId,
      });

      // ✅ Aggregate structural safety decision
      stage1BStructuralSafe =
        geo?.isSuspicious !== true &&
        sem?.passed === true &&
        mask?.createdOpenings === 0 &&
        mask?.closedOpenings === 0;

      nLog(
        `[worker] Post-1B Structural Safety: ${
          stage1BStructuralSafe ? "SAFE ✅" : "UNSAFE ❌"
        }`
      );

    } catch (err) {
      nLog(`[worker] Post-1B validation error (fail-open):`, err);
      stage1BStructuralSafe = false;
    }
  }

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "failed", errorMessage: "cancelled" });
    return;
  }

  // STAGE 2 (optional virtual staging via Gemini)
  const t2 = Date.now();
  const profileId = (payload as any)?.options?.stagingProfileId as string | undefined;
  const profile = profileId ? getStagingProfile(profileId) : undefined;
  const angleHint = (payload as any)?.options?.angleHint as any; // "primary" | "secondary" | "other"
  nLog(`[WORKER] Stage 2 ${payload.options.virtualStage ? 'ENABLED' : 'DISABLED'}; USE_GEMINI_STAGE2=${process.env.USE_GEMINI_STAGE2 || 'unset'}`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // STAGING GUARD (PART C) - Single source of truth for staging eligibility
  // ═══════════════════════════════════════════════════════════════════════════════
  const stagingGuardScene: SceneType = sceneLabel === "interior" ? "interior" :
                                        sceneLabel === "exterior" ? "exterior" : "unknown";
  const stagingGuardResult = canStage({
    scene: stagingGuardScene,
    roomType: payload.options.roomType,
    outdoorStagingEnabled: false // ALWAYS false for V1 - exterior staging blocked
  });

  // If staging was requested but not allowed, log and skip
  if (payload.options.virtualStage && !stagingGuardResult.allowed) {
    logStagingBlocked({
      orgId: (payload as any).agencyId,
      imageId: payload.imageId,
      scene: stagingGuardScene,
      reason: stagingGuardResult.reason
    });
    nLog(`[WORKER] ⚠️ Staging blocked: ${stagingGuardResult.reason} - ${stagingGuardResult.message}`);
    // Don't error - just skip staging and return enhanced image
    payload.options.virtualStage = false;
  }
  // Stage 2 input selection:
  // - Interior: use Stage 1B (decluttered) if declutter enabled; else Stage 1A
  // - Exterior: always use Stage 1A
  const isExteriorScene = sceneLabel === "exterior";
  let stage2InputPath = isExteriorScene ? path1A : (payload.options.declutter && path1B ? path1B : path1A);
  stage12Success = true;
  let stage2BaseStage: "1A"|"1B" = isExteriorScene ? "1A" : (payload.options.declutter && path1B ? "1B" : "1A");
  nLog(`[WORKER] Stage 2 source: baseStage=${stage2BaseStage}, inputPath=${stage2InputPath}`);
  let path2: string = stage2InputPath;
  try {
    // Only allow exterior staging if allowStaging is true
    if (sceneLabel === "exterior" && !allowStaging) {
      nLog(`[WORKER] Exterior image: No suitable outdoor area detected, skipping staging. Returning ${payload.options.declutter && path1B ? '1B' : '1A'} output.`);
      path2 = payload.options.declutter && path1B ? path1B : path1A; // Only enhancement, no staging
    } else {
      // Surface incoming stagingStyle before calling Stage 2
      const stagingStyleRaw: any = (payload as any)?.options?.stagingStyle;
      console.info("[stage2] incoming stagingStyle =", stagingStyleRaw);
      const stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === 'string' ? stagingStyleRaw.trim() : undefined;

      const stage2Outcome = payload.options.virtualStage
        ? await runStage2(stage2InputPath, stage2BaseStage, {
            roomType: (
              !payload.options.roomType ||
              ["auto", "unknown"].includes(String(payload.options.roomType).toLowerCase())
            )
              ? String(detectedRoom || "living_room")
              : payload.options.roomType,
            sceneType: sceneLabel as any,
            profile,
            angleHint,
            stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
            stagingStyle: stagingStyleNorm,
            jobId: payload.jobId,
            validationConfig: { localMode: localValidatorMode },
            onStrictRetry: ({ reasons }) => {
              try {
                const msg = reasons && reasons.length
                  ? `Validation failed: ${reasons.join('; ')}. Retrying with stricter settings...`
                  : "Validation failed. Retrying with stricter settings...";
                updateJob(payload.jobId, {
                  message: msg,
                  meta: {
                    ...(sceneLabel ? { ...sceneMeta } : {}),
                    strictRetry: true,
                    strictRetryReasons: reasons || []
                  }
                });
              } catch {}
            }
          })
        : (payload.options.declutter && path1B ? path1B : path1A);

      if (typeof stage2Outcome === "string") {
        path2 = stage2Outcome;
      } else {
        path2 = stage2Outcome.outputPath;
        stage2AttemptsUsed = stage2Outcome.attempts;
        stage2MaxAttempts = stage2Outcome.maxAttempts;
        stage2ValidationRisk = stage2Outcome.validationRisk;
        stage2LocalReasons = stage2Outcome.localReasons || [];
        stage2NeedsConfirm = VALIDATION_BLOCKING_ENABLED && stage2ValidationRisk;
      }
    }
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    nLog(`[worker] Stage 2 failed: ${errMsg}`);
    updateJob(payload.jobId, {
      status: "failed",
      errorMessage: errMsg,
      error: errMsg,
      meta: { ...sceneMeta }
    });
    return;
  }

  // Fallback: if full removal (stage-ready) exhausted retries with validation risk, try light declutter then rerun Stage 2
  const declutterModeFallback = (payload.options as any).declutterMode;
  const shouldFallbackLightDeclutter =
    payload.options.virtualStage &&
    stage2ValidationRisk &&
    stage2AttemptsUsed >= stage2MaxAttempts &&
    declutterModeFallback === "stage-ready";

  if (shouldFallbackLightDeclutter) {
    try {
      nLog(`[worker] [FALLBACK] using light declutter backstop after full-removal retries exhausted`);
      const lightPath1B = await runStage1B(path1A, {
        replaceSky: false,
        sceneType: sceneLabel,
        roomType: payload.options.roomType,
        declutterMode: "light",
        jobId: payload.jobId,
      });

      stage2InputPath = lightPath1B;
      stage2BaseStage = "1B";
      const stagingStyleFallback = (() => {
        const raw: any = (payload as any)?.options?.stagingStyle;
        return raw && typeof raw === "string" ? raw.trim() : undefined;
      })();

      const stage2Outcome = await runStage2(stage2InputPath, stage2BaseStage, {
        roomType: (
          !payload.options.roomType ||
          ["auto", "unknown"].includes(String(payload.options.roomType).toLowerCase())
        )
          ? String(detectedRoom || "living_room")
          : payload.options.roomType,
        sceneType: sceneLabel as any,
        profile,
        angleHint,
        stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
        stagingStyle: stagingStyleFallback,
        jobId: payload.jobId,
        validationConfig: { localMode: localValidatorMode },
        onStrictRetry: ({ reasons }) => {
          try {
            const msg = reasons && reasons.length
              ? `Validation failed: ${reasons.join('; ')}. Retrying with stricter settings...`
              : "Validation failed. Retrying with stricter settings...";
            updateJob(payload.jobId, {
              message: msg,
              meta: {
                ...(sceneLabel ? { ...sceneMeta } : {}),
                strictRetry: true,
                strictRetryReasons: reasons || []
              }
            });
          } catch {}
        }
      });

      if (typeof stage2Outcome === "string") {
        path2 = stage2Outcome;
      } else {
        path2 = stage2Outcome.outputPath;
        stage2AttemptsUsed = stage2Outcome.attempts;
        stage2MaxAttempts = stage2Outcome.maxAttempts;
        stage2ValidationRisk = stage2Outcome.validationRisk;
        stage2LocalReasons = stage2Outcome.localReasons || [];
        stage2NeedsConfirm = VALIDATION_BLOCKING_ENABLED && stage2ValidationRisk;
      }

      fallbackUsed = "light_declutter_backstop";
    } catch (fallbackErr: any) {
      const errMsg = fallbackErr?.message || String(fallbackErr);
      nLog(`[worker] Fallback light declutter failed: ${errMsg}`);
      updateJob(payload.jobId, { status: "failed", errorMessage: errMsg, error: errMsg, meta: { ...sceneMeta }, fallbackUsed: "light_declutter_backstop" });
      return;
    }
  }

  // Preserve the staged candidate path before validation decides whether it can ship
  const stage2CandidatePath = path2;

  timings.stage2Ms = Date.now() - t2;
  updateJob(payload.jobId, { status: "processing", currentStage: payload.options.virtualStage ? "2" : (payload.options.declutter ? "1B" : "1A"), stage: payload.options.virtualStage ? "2" : (payload.options.declutter ? "1B" : "1A"), progress: payload.options.virtualStage ? 75 : (payload.options.declutter ? 55 : 45) });

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "failed", errorMessage: "cancelled" });
    return;
  }

  // Publish Stage 2 after validation (deferred); keep placeholder for URL
  let pub2Url: string | undefined = undefined;

  // ===== UNIFIED STRUCTURAL VALIDATION =====
  // Run unified validation pipeline for Stage 2
  let unifiedValidation: UnifiedValidationResult | undefined = undefined;
  let effectiveValidationMode: "log" | "enforce" | undefined = undefined;
  if (path2 && payload.options.virtualStage) {
    try {
      const validationStartTime = Date.now();

      // Determine which stage to validate
      const validationStage: "1A" | "1B" | "2" = payload.options.virtualStage ? "2" :
                     (payload.options.declutter ? "1B" : "1A");

      // Get the base path (prefer Stage 1B when available for Stage 2)
      const validationBasePath = (validationStage === "2" && path1B) ? path1B : path1A;

      nLog(`[worker] ═══════════ Running Unified Structural Validation ═══════════`);

      effectiveValidationMode = "log";
      nLog(`[worker] Unified validation mode: configured=${structureValidatorMode} effective=${effectiveValidationMode} blocking=OFF (advisory)`);

      unifiedValidation = await runUnifiedValidation({
        originalPath: validationBasePath,
        enhancedPath: path2,
        stage: validationStage,
        sceneType: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        roomType: payload.options.roomType,
        mode: "log",
        jobId: payload.jobId,
        stagingStyle: payload.options.stagingStyle || "nz_standard",
        stage1APath: validationBasePath,
      });

      const validationElapsed = Date.now() - validationStartTime;
      nLog(`[worker] Unified validation completed in ${validationElapsed}ms`);
      nLog(`[worker] Validation result: ${unifiedValidation.passed ? "PASSED" : "FAILED"} (score: ${unifiedValidation.score})`);

      // VALIDATOR FOCUS: Compact unified validation output
      if (VALIDATOR_FOCUS && unifiedValidation) {
        vLog(""); // Blank line for readability
        logUnifiedValidationCompact(
          payload.jobId,
          unifiedValidation,
          validationStage,
          sceneLabel === "exterior" ? "exterior" : "interior"
        );
      }

      // Store validation results in job metadata
      updateJob(payload.jobId, {
        meta: {
          ...(sceneLabel ? { ...sceneMeta } : {}),
          unifiedValidation: {
            passed: unifiedValidation.passed,
            hardFail: unifiedValidation.hardFail,
            score: unifiedValidation.score,
            reasons: unifiedValidation.reasons,
            warnings: unifiedValidation.warnings,
            normalized: unifiedValidation.normalized,
            modeConfigured: structureValidatorMode,
            modeEffective: effectiveValidationMode,
            blockingEnabled: VALIDATION_BLOCKING_ENABLED,
          },
        },
      });

      if (unifiedValidation && !unifiedValidation.passed) {
        if (VALIDATION_BLOCKING_ENABLED) {
          stage2NeedsConfirm = true;
        }
        stage2LocalReasons.push(...(unifiedValidation.reasons || []));
      }

    } catch (validationError: any) {
      // Validation errors should never crash the job
      nLog(`[worker] Unified validation error (non-fatal):`, validationError);
      nLog(`[worker] Stack:`, validationError?.stack);
      // Continue processing - fail-open behavior
    }
  }

  // ===== SEMANTIC STRUCTURAL VALIDATION (Stage-2 ONLY) =====
  // Run semantic structure validator ONLY after Stage-2 virtual staging
  // This validator detects window/door count changes, wall drift, and opening modifications
  // MODE: LOG-ONLY (non-blocking)
  if (path2 && payload.options.virtualStage) {
    try {
      nLog(`[worker] ═══════════ Running Semantic Structure Validator (Stage-2) ═══════════`);

      await runSemanticStructureValidator({
        originalImagePath: path1A,  // Pre-staging baseline
        enhancedImagePath: path2,   // Final staged output
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
      });

      nLog(`[worker] Semantic validation completed (log-only, non-blocking)`);
    } catch (semanticError: any) {
      // Semantic validation errors should never crash the job
      nLog(`[worker] Semantic validation error (non-fatal):`, semanticError);
      nLog(`[worker] Stack:`, semanticError?.stack);
      // Continue processing - fail-open behavior
    }
  }

  // ===== MASKED EDGE GEOMETRY VALIDATOR (Stage-2 ONLY) =====
  // Run masked edge validator ONLY after Stage-2 virtual staging
  // This validator focuses on architectural lines only (walls, doors, windows)
  // Ignores furniture, curtains, plants, and other non-structural elements
  // MODE: LOG-ONLY (non-blocking)
  if (path2 && payload.options.virtualStage) {
    try {
      nLog(`[worker] ═══════════ Running Masked Edge Geometry Validator (Stage-2) ═══════════`);

      await runMaskedEdgeValidator({
        originalImagePath: path1A,  // Pre-staging baseline
        enhancedImagePath: path2,   // Final staged output
        scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        mode: "log",
        jobId: payload.jobId,
      });

      nLog(`[worker] Masked edge validation completed (log-only, non-blocking)`);
    } catch (maskedEdgeError: any) {
      // Masked edge validation errors should never crash the job
      nLog(`[worker] Masked edge validation error (non-fatal):`, maskedEdgeError);
      nLog(`[worker] Stack:`, maskedEdgeError?.stack);
      // Continue processing - fail-open behavior
    }
  }

  if (payload.options.virtualStage) {
    const stage2LocalStatus = stage2NeedsConfirm ? "needs_confirm" : "pass";
    nLog(`[LOCAL_VALIDATE] stage=2 status=${stage2LocalStatus} reasons=${JSON.stringify(stage2LocalReasons)}`);

    // Gemini confirmation gate for Stage 2
    if (stage2CandidatePath && stage2NeedsConfirm) {
      const { confirmWithGeminiStructure } = await import("./validators/confirmWithGeminiStructure.js");
      const baselineForConfirm = (path1B && stage2BaseStage === "1B") ? path1B : path1A;
      const confirm = await confirmWithGeminiStructure({
        baselinePathOrUrl: baselineForConfirm,
        candidatePathOrUrl: stage2CandidatePath,
        stage: "stage2",
        roomType: payload.options.roomType,
        sceneType: sceneLabel as any,
        jobId: payload.jobId,
        localReasons: stage2LocalReasons,
      });
      nLog(`[GEMINI_CONFIRM] stage=2 status=${confirm.status} confirmedFail=${confirm.confirmedFail} reasons=${JSON.stringify(confirm.reasons)}`);

      if (confirm.confirmedFail && geminiBlockingEnabled) {
        stage2Blocked = true;
        stage2BlockedReason = confirm.reasons.join("; ") || "Stage2 blocked by Gemini confirmation";
        nLog(`[VALIDATE_FINAL] stage=2 decision=block blockedBy=gemini_confirm override=false`);
        updateJob(payload.jobId, {
          status: "failed",
          errorMessage: stage2BlockedReason,
          error: stage2BlockedReason,
          meta: { ...sceneMeta, stage2LocalReasons, geminiConfirm: confirm },
        });
        return;
      }

      updateJob(payload.jobId, {
        meta: {
          ...sceneMeta,
          stage2LocalReasons,
          geminiConfirm: { ...confirm, override: !confirm.confirmedFail },
        }
      });
      nLog(`[VALIDATE_FINAL] stage=2 decision=accept blockedBy=${confirm.confirmedFail && geminiBlockingEnabled ? "gemini_confirm" : "none"} override=${confirm.confirmedFail ? !geminiBlockingEnabled : true}`);
    } else {
      nLog(`[VALIDATE_FINAL] stage=2 decision=accept blockedBy=none override=${!stage2NeedsConfirm}`);
    }
  }

  // Publish Stage 2 only if it passed blocking validation
  if (payload.options.virtualStage && !stage2Blocked && stage2CandidatePath) {
    // If Stage 2 equals Stage 1B (no change), reuse the Stage 1B URL to avoid duplicate uploads
    if (stage2CandidatePath === path1B && pub1BUrl) {
      pub2Url = pub1BUrl;
      stage2Success = true;
      updateJob(payload.jobId, { status: "processing", currentStage: "2", stage: "2", progress: 85, stageUrls: { "2": pub2Url }, imageUrl: pub2Url });
      vLog(`[VAL][job=${payload.jobId}] stage2Url=${pub2Url} (reused 1B)`);
    } else {
      let v2: any = null;
      try {
        v2 = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "2", filePath: stage2CandidatePath, note: "Virtual staging" });
      } catch (e) {
        nLog(`[worker] Note: Could not record Stage 2 version in images.json (expected in multi-service deployment)\n`);
      }
      try {
        const pub2 = await publishImage(stage2CandidatePath);
        pub2Url = pub2.url;
        stage2Success = true;
        if (v2) {
          try {
            setVersionPublicUrl(payload.imageId, v2.versionId, pub2.url);
          } catch (e) {
            // Ignore
          }
        }
        updateJob(payload.jobId, { status: "processing", currentStage: "2", stage: "2", progress: 85, stageUrls: { "2": pub2Url }, imageUrl: pub2Url });
        // VALIDATOR FOCUS: Log Stage 2 URL
        vLog(`[VAL][job=${payload.jobId}] stage2Url=${pub2Url}`);
        nLog(`[worker] ✅ Stage 2 published: ${pub2Url}`);
      } catch (e) {
        nLog('[worker] failed to publish Stage 2', e);
      }
    }
  }

  // COMPLIANCE VALIDATION (best-effort)
  let compliance: any = undefined;
  const tVal = Date.now();
  try {
    const ai = getGeminiClient();
    const base1A = toBase64(path1A);
    const baseFinal = toBase64(path2);
    compliance = await checkCompliance(ai as any, base1A.data, baseFinal.data);
    let retries = 0;
    let maxRetries = 2;
    let temperature = 0.5;
    let lastViolationMsg = "";
    let retryPath2 = path2;
    while (compliance && compliance.ok === false && retries < maxRetries) {
      lastViolationMsg = `Structural violations detected: ${(compliance.reasons || ["Compliance check failed"]).join("; ")}`;
      updateJob(payload.jobId, {
        status: "processing",
        errorMessage: lastViolationMsg,
        error: lastViolationMsg,
        message: `Validation failed. Retrying with stricter settings (attempt ${retries+2}/3)...`,
        meta: {
          ...(sceneLabel ? { ...sceneMeta } : {}),
          compliance,
          strictRetry: true,
          strictRetryReasons: Array.isArray((compliance as any)?.reasons) ? (compliance as any).reasons : ["compliance retry"],
          strictRetryPhase: "compliance"
        }
      });
      nLog(`[worker] ❌ Job ${payload.jobId} failed compliance: ${lastViolationMsg} (retry ${retries+1})`);
      temperature = Math.max(0.1, temperature - 0.1);
      // Call Gemini enhancement directly with reduced temperature
      if (!path1B) {
        nLog("[worker] path1B is undefined – skipping retry for 1B.");
      } else {
        retryPath2 = await enhanceWithGemini(path1B, { ...payload.options, temperature });
        const baseFinalRetry = toBase64(retryPath2);
        compliance = await checkCompliance(ai, base1A.data, baseFinalRetry.data);
      }
      retries++;
    }
    if (compliance && compliance.ok === false) {
      lastViolationMsg = `Structural violations detected: ${(compliance.reasons || ["Compliance check failed"]).join("; ")}`;
      // Record the violation for the final status update but keep the job in-flight
      compliance = {
        ...compliance,
        complianceFailed: true,
        complianceFailureReason: lastViolationMsg,
      } as any;
      nLog(`[worker] Compliance failed for job ${payload.jobId} after retries: ${lastViolationMsg} (image still published)`);
      // Do NOT return; continue so image is published and final status is set once done
    }
  } catch (e) {
    // proceed if Gemini not configured or any error
    // nLog("[worker] compliance check skipped:", (e as any)?.message || e);
  }
  timings.validateMs = Date.now() - tVal;

  // Log combined validation summary (normal mode)
  if (unifiedValidation || compliance) {
    nLog(`[worker] ═══════════ Validation Summary ═══════════`);
    if (unifiedValidation) {
      nLog(`[worker] Unified Structural: ${unifiedValidation.hardFail ? "✗ FAILED" : "✓ PASSED"} (score: ${unifiedValidation.score})`);
      if (unifiedValidation.hardFail && unifiedValidation.reasons.length > 0) {
        nLog(`[worker] Structural issues: ${unifiedValidation.reasons.join("; ")}`);
      }
      if (!unifiedValidation.hardFail && unifiedValidation.warnings.length > 0) {
        nLog(`[worker] Structural warnings: ${unifiedValidation.warnings.join("; ")}`);
      }
    }
    if (compliance) {
      nLog(`[worker] Gemini Compliance: ${compliance.ok ? "✓ PASSED" : "✗ FAILED"}`);
      if (!compliance.ok && compliance.reasons) {
        nLog(`[worker] Compliance issues: ${compliance.reasons.join("; ")}`);
      }
    }
    nLog(`[worker] Blocking mode: ${VALIDATION_BLOCKING_ENABLED ? "ENABLED" : "DISABLED (log-only)"}`);
    nLog(`[worker] ═══════════════════════════════════════════`);
  }

  // stage 1B publishing was deferred until here; attach URL and surface progress
  // pub1BUrl already declared above; removed duplicate
  if (payload.options.declutter) {
    if (!path1B) {
      throw new Error("Stage 1B path is undefined");
    }
    let v1B: any = null;
    try {
      v1B = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1B", filePath: path1B, note: "Decluttered / depersonalized" });
    } catch (e) {
      // Silently ignore - images.json is not available in multi-service deployment
    }
    try {
      const pub1B = await publishImage(path1B);
      pub1BUrl = pub1B.url;
      if (v1B) {
        try {
          setVersionPublicUrl(payload.imageId, v1B.versionId, pub1B.url);
        } catch (e) {
          // Ignore
        }
      }
      updateJob(payload.jobId, { stage: "1B", progress: 55, stageUrls: { "1B": pub1BUrl } });
      // VALIDATOR FOCUS: Log Stage 1B URL
      vLog(`[VAL][job=${payload.jobId}] stage1BUrl=${pub1BUrl}`);
    } catch (e) {
      nLog('[worker] failed to publish 1B', e);
    }
  }

  // Decide final base path for versioning + final publish.
  // Preference order:
  //   1) Stage 2 (if virtualStage requested AND not blocked)
  //   2) Stage 1B (decluttered) if available
  //   3) Stage 1A
  const hasStage2 = payload.options.virtualStage && !stage2Blocked && !!pub2Url;
  const finalBasePath = hasStage2 ? stage2CandidatePath : (payload.options.declutter && path1B ? path1B! : path1A);
  const finalStageLabel = hasStage2 ? "2" : (payload.options.declutter ? "1B" : "1A");

  let finalPathVersion: any = null;
  try {
    finalPathVersion = pushImageVersion({
      imageId: payload.imageId,
      userId: payload.userId,
      stageLabel: hasStage2 ? "2" : (payload.options.declutter ? "1B" : "1A"),
      filePath: finalBasePath,
      note: hasStage2 ? "Virtual staging" : (payload.options.declutter ? "Decluttered final" : "Final enhanced")
    });
  } catch (e) {
    // Silently ignore - images.json is not available in multi-service deployment
  }

  // Publish final for client consumption and attach to version

  let publishedFinal: any = null;
  let pubFinalUrl: string | undefined = undefined;

  // 🔍 OPENCV STRUCTURAL VALIDATOR
  // Run OpenCV-based structural validation before publishing final output
  // This must happen AFTER we know what the final output will be but BEFORE publishing
  // Note: We'll call it after publishing to get the public URL for the OpenCV service
  let structuralValidationResult: any = null;

  if (finalBasePath === path1A && pub1AUrl) {
    nLog(`\n[WORKER] ═══════════ Final image same as 1A - reusing URL ═══════════\n`);
    pubFinalUrl = pub1AUrl;
    publishedFinal = { url: pub1AUrl, kind: 's3' };
    nLog(`[WORKER] Final URL (reused from 1A): ${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
  } else if (finalBasePath === path1B && pub1BUrl) {
    nLog(`\n[WORKER] ═══════════ Final image same as 1B - reusing URL ═══════════\n`);
    pubFinalUrl = pub1BUrl;
    publishedFinal = { url: pub1BUrl, kind: 's3' };
    nLog(`[WORKER] Final URL (reused from 1B): ${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
  } else {
    try {
      nLog(`\n[WORKER] ═══════════ Publishing final enhanced image ═══════════\n`);
      publishedFinal = await publishImage(path2);
      pubFinalUrl = publishedFinal?.url;
      if (!pubFinalUrl) {
        throw new Error('publishImage returned no URL');
      }
      if (finalPathVersion) {
        try {
          setVersionPublicUrl(payload.imageId, finalPathVersion.versionId, pubFinalUrl);
        } catch (e) {
          // Ignore - images.json not accessible in multi-service mode
        }
      }
      nLog(`[WORKER] Final published: kind=${publishedFinal?.kind} url=${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
      // VALIDATOR FOCUS: Log final URL
      vLog(`[VAL][job=${payload.jobId}] finalUrl=${pubFinalUrl}`);
    } catch (e) {
      nLog(`[WORKER] CRITICAL: Failed to publish final image: ${e}\n`);
      nLog(`[WORKER] publishedFinal: ${JSON.stringify(publishedFinal)}\n`);
    }
  }

  // VALIDATOR FOCUS: Log final URL if reused from earlier stage
  if (pubFinalUrl && !publishedFinal) {
    vLog(`[VAL][job=${payload.jobId}] finalUrl=${pubFinalUrl}`);
  }

  // 🔍 RUN OPENCV STRUCTURAL VALIDATION
  // Now that we have public URLs for both original and final, validate structure
  // This uses the Python OpenCV microservice for proper line detection
  if (pubFinalUrl && publishedOriginal?.url) {
    try {
      structuralValidationResult = await runStructuralCheck(
        publishedOriginal.url,
        pubFinalUrl,
        { stage: finalStageLabel, jobId: payload.jobId }
      );
      // Validation result is logged inside runStructuralCheck
      // If mode="block" and isSuspicious=true, it will throw and abort the job
    } catch (validationError: any) {
      // If validator throws (blocking mode), propagate the error
      if (validationError.message?.includes("Structural validation failed")) {
        nLog("[worker] Structural validation blocked the image");
        throw validationError;
      }
      // Otherwise just log and continue (fail open)
      nLog("[worker] Structural validation error (non-blocking):", validationError.message);
    }
  } else {
    nLog("[worker] Skipping structural validation (no public URLs available)");
  }

  // 🔹 Record final output in Redis for later region-edit lookups
  try {
    if (pubFinalUrl) {
      const baseKey = pubFinalUrl.split("?")[0].split("/").pop() || "";
      const finalPathKey = (() => {
        try {
          const u = new URL(pubFinalUrl);
          return u.pathname.replace(/^\/+/, "");
        } catch {
          return baseKey;
        }
      })();
      const fallbackVersionKey = finalPathKey ? computeFallbackVersionKey(finalPathKey) : undefined;
      await recordEnhancedImageRedis({
        userId: payload.userId,
        imageId: payload.imageId,
        publicUrl: pubFinalUrl,
        baseKey, // recordEnhancedImageRedis will normalize & log if it tweaks this
        versionId: finalPathVersion?.versionId || fallbackVersionKey || "",
        fallbackVersionKey,
        stage: ((): "1A" | "1B" | "2" | "final" => {
          if (hasStage2) return "2";
          if (payload.options.declutter) return "1B";
          return "1A";
        })(),
      });
      nLog("[worker] Redis image history recorded", {
        userId: payload.userId,
        baseKey,
        imageId: payload.imageId,
      });
    } else {
      nLog("[worker] No pubFinalUrl, skipping Redis history record");
    }
  } catch (err) {
    nLog(
      "[worker] Failed to record image history in Redis:",
      (err as any)?.message || err
    );
  }

  updateJob(payload.jobId, { stage: "upload-final", progress: 90, resultUrl: pubFinalUrl });

  // ===== USAGE TRACKING (BEST-EFFORT, NON-BLOCKING) =====
  // Record a single bundled usage event following pricing rules
  try {
    const agencyId = (payload as any).agencyId || null;
    const imagesUsed = payload.options.declutter && payload.options.virtualStage ? 2 : 1;
    await recordEnhanceBundleUsage(payload, imagesUsed, agencyId);
  } catch (usageErr) {
    // Usage tracking must never block job completion
    nLog("[USAGE] Failed to record usage (non-blocking):", (usageErr as any)?.message || usageErr);
  }

  // ===== RESERVATION FINALIZATION =====
  // Finalize reservation based on actual stage completion
  try {
    await finalizeReservationFromWorker({
      jobId: payload.jobId,
      stage12Success,
      stage2Success,
    });
    nLog(`[BILLING] Finalized reservation for ${payload.jobId}: stage12=${stage12Success}, stage2=${stage2Success}`);
  } catch (billingErr) {
    // Billing must never block job completion, but log error for reconciliation
    nLog("[BILLING] Failed to finalize reservation (non-blocking):", (billingErr as any)?.message || billingErr);
    // In production, you might want to queue this for retry or manual reconciliation
  }

  const meta = {
    ...sceneMeta,
    roomTypeDetected: detectedRoom,
    roomType: payload.options.roomType || undefined,
    allowStaging,
    stagingRegion: stagingRegionGlobal,
    timings: { ...timings, totalMs: Date.now() - t0 },
    ...(compliance ? { compliance } : {}),
    // ✅ Save Stage-1B structural safety flag for smart retry routing
    ...(path1B ? { stage1BStructuralSafe } : {}),
    ...(unifiedValidation ? { unifiedValidation } : {}),
    ...(stage2Blocked ? { stage2Blocked: true, stage2BlockedReason, validationNote: stage2BlockedReason, fallbackStage: stage2FallbackStage } : {}),
  };

  updateJob(payload.jobId, {
    status: "complete",
    currentStage: "finalizing",
    finalStage: finalStageLabel,
    resultStage: finalStageLabel,
    stageOutputs: {
      "1A": path1A,
      "1B": payload.options.declutter ? path1B : undefined,
      "2": hasStage2 ? path2 : undefined
    },
    resultVersionId: finalPathVersion?.versionId || undefined,
    meta,
    originalUrl: publishedOriginal?.url,
    resultUrl: pubFinalUrl,
    validation: (() => {
      const normalizedFlag = unifiedValidation?.normalized;
      if (unifiedValidation) {
        return {
          hardFail: unifiedValidation.hardFail,
          warnings: unifiedValidation.warnings,
          normalized: normalizedFlag,
          modeConfigured: structureValidatorMode,
          modeEffective: VALIDATION_BLOCKING_ENABLED ? "block" : "log",
          blockingEnabled: VALIDATION_BLOCKING_ENABLED,
          blockedStage: stage2Blocked ? "2" : undefined,
          fallbackStage: stage2Blocked ? stage2FallbackStage : undefined,
          note: stage2Blocked ? (stage2BlockedReason || "Stage 2 blocked") : undefined,
        };
      }
      if (stage2Blocked) {
        return {
          hardFail: true,
          warnings: stage2BlockedReason ? [stage2BlockedReason] : [],
          normalized: normalizedFlag,
          modeConfigured: structureValidatorMode,
          modeEffective: VALIDATION_BLOCKING_ENABLED ? "block" : "log",
          blockingEnabled: VALIDATION_BLOCKING_ENABLED,
          blockedStage: "2",
          fallbackStage: stage2FallbackStage,
          note: stage2BlockedReason,
        };
      }
      return undefined;
    })(),
    attempts: stage2AttemptsUsed || stage2MaxAttempts
      ? { current: stage2AttemptsUsed || undefined, max: stage2MaxAttempts || undefined }
      : undefined,
    fallbackUsed,
    blockedStage: stage2Blocked ? "2" : undefined,
    fallbackStage: stage2Blocked ? stage2FallbackStage : undefined,
    validationNote: stage2Blocked ? (stage2BlockedReason || "Stage 2 blocked") : undefined,
    stageUrls: {
      "1A": pub1AUrl ?? null,
      "1B": pub1BUrl ?? null,
      "2": hasStage2 ? (pub2Url ?? null) : null
    }
  });

  // Persist finalized metadata with longer history TTL
  try {
    const existingMeta = await getJobMetadata(payload.jobId);
    const stageUrlsMeta = {
      stage1a: pub1AUrl || undefined,
      stage1b: pub1BUrl || undefined,
      stage2: pub2Url || undefined,
      publish: pubFinalUrl || undefined,
    };
    const debugMeta = {
      ...(existingMeta?.debug || {}),
      stage2ModeUsed: hasStage2
        ? ((payload as any).options?.stagingPreference === "refresh"
          ? "refresh"
          : (payload as any).options?.stagingPreference === "full"
            ? "empty"
            : "auto")
        : undefined,
      validatorSummary: unifiedValidation || (stage2Blocked ? { blocked: true, reason: stage2BlockedReason } : undefined),
    };

    const mergedMeta: JobOwnershipMetadata = {
      userId: existingMeta?.userId || payload.userId,
      imageId: existingMeta?.imageId || payload.imageId,
      jobId: payload.jobId,
      createdAt: existingMeta?.createdAt || payload.createdAt || new Date().toISOString(),
      requestedStages: existingMeta?.requestedStages || buildRequestedStages(),
      stageUrls: stageUrlsMeta,
      resultUrl: pubFinalUrl || existingMeta?.resultUrl,
      s3: existingMeta?.s3,
      warnings: existingMeta?.warnings,
      debug: debugMeta,
    };

    await Promise.all([
      updateJob(payload.jobId, { metadata: mergedMeta }),
      saveJobMetadata(mergedMeta, JOB_META_TTL_HISTORY_SECONDS),
    ]);
  } catch (metaFinalizeErr: any) {
    nLog(`[JOB_META_WARN] Failed to persist finalized metadata for job ${payload.jobId}: ${metaFinalizeErr?.message || metaFinalizeErr}`);
  }

  const finalWarningCount = unifiedValidation?.warnings?.length || 0;
  nLog(`[JOB_FINAL][job=${payload.jobId}] status=complete hardFail=${unifiedValidation?.hardFail ?? false} warnings=${finalWarningCount} normalized=${unifiedValidation?.normalized ?? false}`);

  // Record enhanced image for "Previously Enhanced Images" history
  // FAIL-SAFE: Non-blocking - if this fails, job still completes successfully
  if (payload.agencyId && pubFinalUrl) {
    const stagesCompleted: string[] = ['1A'];
    if (payload.options.declutter && pub1BUrl) stagesCompleted.push('1B');
    if (hasStage2 && pub2Url) stagesCompleted.push('2');

    const auditRef = generateAuditRef();
    const traceId = generateTraceId(payload.jobId);
    const extractKey = (url?: string | null) => {
      if (!url) return null;
      try {
        const u = new URL(url);
        return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
      } catch {
        return null;
      }
    };
    const originalKey = (payload as any).remoteOriginalKey || extractKey((payload as any).remoteOriginalUrl || publishedOriginal?.url || null);
    const enhancedKey = extractKey(pubFinalUrl || null);
    const thumbKey = extractKey(pubFinalUrl || null);

    recordEnhancedImageHistory({
      agencyId: payload.agencyId,
      userId: payload.userId,
      jobId: payload.jobId,
      stagesCompleted,
      publicUrl: pubFinalUrl,
      thumbnailUrl: pubFinalUrl, // Use same URL for thumbnail (can be optimized later)
      originalUrl: publishedOriginal?.url || (payload as any).remoteOriginalUrl || null,
      originalS3Key: originalKey,
      enhancedS3Key: enhancedKey,
      thumbS3Key: thumbKey,
      auditRef,
      traceId,
    }).catch((err) => {
      // Log but don't throw - this is not critical for job completion
      nLog(`[enhanced-images] Failed to record image: ${err}`);
    });
  }

  // Return value for BullMQ status consumers
  const returnValue = {
    ok: true,
    imageId: payload.imageId,
    jobId: payload.jobId,
    finalPath: finalBasePath,
    originalUrl: publishedOriginal?.url || null,
    resultUrl: pubFinalUrl || null,
    stageUrls: {
      "1A": pub1AUrl || null,
      "1B": pub1BUrl || null,
      "2": hasStage2 ? (pub2Url || null) : null
    },
    meta
  };
  
  // Log the return value for debugging
  nLog('\n[WORKER] ═══════════ JOB RETURN VALUE ═══════════\n');
  nLog(`[WORKER] imageId: ${returnValue.imageId}\n`);
  nLog(`[WORKER] originalUrl: ${returnValue.originalUrl ? (String(returnValue.originalUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  nLog(`[WORKER] resultUrl: ${returnValue.resultUrl ? (String(returnValue.resultUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  nLog(`[WORKER] stageUrls.2: ${returnValue.stageUrls["2"] ? (String(returnValue.stageUrls["2"]).substring(0, 80) + '...') : 'NULL'}\n`);
  nLog('═══════════════════════════════════════════════\n\n');
  
  return returnValue;
}

// handle "edit" pipeline
async function handleEditJob(payload: any) {

  // 1) Download the enhanced image we’re editing
  const { jobId, baseImageUrl, maskBase64, userInstruction, userId, imageId } = payload;
  nLog("[worker-edit] Downloading base from:", baseImageUrl);
  const basePath = await downloadToTemp(baseImageUrl, `${jobId}-base`);
  nLog("[worker-edit] Base downloaded to:", basePath);

  // 2) Decode maskBase64 to Buffer
  let mask: Buffer | undefined = undefined;
  if (maskBase64) {
    if (maskBase64.startsWith("data:image/")) {
      const comma = maskBase64.indexOf(",");
      const b64 = maskBase64.slice(comma + 1);
      mask = Buffer.from(b64, "base64");
    } else {
      mask = Buffer.from(maskBase64, "base64");
    }
  }
  if (!mask) {
    nLog("[worker-edit] No mask provided, aborting edit.");
    return;
  }

  // 3) Call applyEdit – this will talk to Gemini & composite with mask
  const editPath = await applyEdit({
    baseImagePath: basePath,
    mask,
    mode: "Add", // Default to "Add"; adjust as needed if mode is in payload
    instruction: userInstruction || "",
    // restoreFromPath: undefined, // Add if needed
  });

  // 4) Publish edited image
  const pub = await publishImage(editPath);
  nLog("[worker-edit] Published edit URL:", pub.url);

  // 5) Record history in Redis
  await recordEnhancedImageRedis({
    userId,
    imageId,
    publicUrl: pub.url,
    baseKey: pub.url.split("?")[0].split("/").pop() || "",
    versionId: "",
    stage: "edit",
  });

  // 6) Record usage tracking (best-effort, non-blocking)
  try {
    const agencyId = (payload as any).agencyId || null;
    await recordEditUsage(payload, agencyId);
  } catch (usageErr) {
    nLog("[USAGE] Failed to record edit usage (non-blocking):", (usageErr as any)?.message || usageErr);
  }

  // 7) Update job – IMPORTANT: don't hard-fail on compliance
  await updateJob(jobId, {
    status: "complete",
    success: true,
    imageUrl: pub.url,
    meta: {
      ...payload,
    },
  });
}


// Determine Redis URL with preference for private/internal in hosted environments
const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";

// DEPLOYMENT VERIFICATION
const BUILD_VERSION = "2025-11-07_16:00_S3_VERBOSE_LOGS";
nLog('╔════════════════════════════════════════════════════════════════╗');
nLog('║                   WORKER STARTING                              ║');
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog(`[WORKER] BUILD: ${BUILD_VERSION}`);
nLog(`[WORKER] Queue: ${JOB_QUEUE_NAME}`);
nLog(`[WORKER] Redis: ${REDIS_URL}`);
nLog('\n'); // Force flush

// Log S3 configuration on startup
nLog('╔════════════════════════════════════════════════════════════════╗');
nLog('║                   S3 CONFIGURATION                             ║');
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog('  S3_BUCKET:', process.env.S3_BUCKET || '❌ NOT SET');
nLog('  AWS_REGION:', process.env.AWS_REGION || '❌ NOT SET');
nLog('  AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `✅ SET (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : '❌ NOT SET');
nLog('  AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '✅ SET' : '❌ NOT SET');
nLog('  S3_PUBLIC_BASEURL:', process.env.S3_PUBLIC_BASEURL || 'NOT SET (will use S3 direct URLs)');
const s3Enabled = !!(process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
nLog('  📊 Status:', s3Enabled ? '✅ ENABLED - Images will upload to S3' : '❌ DISABLED - Will use data URLs');
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog('\n'); // Force flush

// Log validator configuration on startup
logValidationModes();
nLog('\n'); // Force flush

// BullMQ worker
const worker = new Worker(
  JOB_QUEUE_NAME,
  async (job: Job) => {
    const payload = job.data as AnyJobPayload;
    updateJob((payload as any).jobId, { status: "processing" });
    try {
      if (typeof payload === "object" && payload && "type" in payload) {
        if (payload.type === "enhance") {
          return await handleEnhanceJob(payload as EnhanceJobPayload);
        } else if (payload.type === "edit") {
          return await handleEditJob(payload as EditJobPayload);
        } else if (payload.type === "region-edit") {
          const regionPayload = payload as RegionEditJobPayload;
          const regionAny = regionPayload as any;
          // ✅ ADD DETAILED DEBUG LOGGING
          nLog("[worker-region-edit] Received payload:", JSON.stringify({
            type: regionPayload.type,
            jobId: regionPayload.jobId,
            hasBaseImageUrl: !!regionAny.baseImageUrl,
            hasCurrentImageUrl: !!regionAny.currentImageUrl,
            hasImageUrl: !!regionAny.imageUrl,
            hasMask: !!regionAny.mask,
            allKeys: Object.keys(regionAny),
            baseImageUrl: regionAny.baseImageUrl,
            currentImageUrl: regionAny.currentImageUrl,
            imageUrl: regionAny.imageUrl,
            maskLength: regionAny.mask ? regionAny.mask.length : 0,
          }, null, 2));
          nLog("[worker-region-edit] Processing job:", {
            jobId: regionPayload.jobId,
            mode: regionAny.mode,
            hasBaseImageUrl: !!regionAny.baseImageUrl,
            hasMask: !!regionAny.mask,
          });

          // ✅ FIX: Get the correct URL field
          const baseImageUrl = 
            regionAny.baseImageUrl || 
            regionAny.currentImageUrl ||
            regionAny.imageUrl ||
            null;

          if (!baseImageUrl) {
            nLog("[worker-region-edit] No base image URL found in payload:", {
              jobId: regionPayload.jobId,
              payloadKeys: Object.keys(regionAny),
            });
            throw new Error("Missing base image URL for region-edit job");
          }

          nLog("[worker-region-edit] Downloading base from:", baseImageUrl);
          const basePath = await downloadToTemp(baseImageUrl, regionPayload.jobId + "-base");
          nLog("[worker-region-edit] Downloaded to:", basePath);

          // ✅ FIX: Get mask from payload (it's a base64 string)
          const maskBase64 = regionAny.mask;
          if (!maskBase64) {
            nLog("[worker-region-edit] No mask data in payload");
            throw new Error("Missing mask data for region-edit job");
          }

          // Convert mask base64 to Buffer
          const maskBuf = Buffer.from(maskBase64, "base64");
          nLog("[worker-region-edit] Mask buffer size:", maskBuf.length);

          // Get the instruction/prompt
          const prompt = regionAny.prompt || regionAny.instruction || "";

          // Normalize mode to capitalized form ("add" -> "Add", "remove" -> "Remove", etc.)
          const rawMode = regionAny.mode || "replace";
          const mode = rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase();

          nLog("[worker-region-edit] Calling applyEdit with mode:", mode);

          // Download restore source if provided (for pixel-level restoration)
          let restoreFromPath: string | undefined;
          if (mode === "Restore" && regionAny.restoreFromUrl) {
            nLog("[worker-region-edit] Downloading restore source from:", regionAny.restoreFromUrl);
            restoreFromPath = await downloadToTemp(regionAny.restoreFromUrl, regionPayload.jobId + "-restore");
            nLog("[worker-region-edit] Restore source downloaded to:", restoreFromPath);
          }

          // Call applyEdit
          const outPath = await applyEdit({
            baseImagePath: basePath,
            mask: maskBuf,
            mode: mode as any,
            instruction: prompt,
            restoreFromPath: restoreFromPath || basePath, // Use restore source or fallback to base
          });

          nLog("[worker-region-edit] Edit complete, publishing:", outPath);

          // Publish the result
          const pub = await publishImage(outPath);

          nLog("[worker-region-edit] Published to:", pub.url);

          // Publish the mask for reference
          const maskPath = `/tmp/${regionPayload.jobId}-mask.png`;
          await sharp(maskBuf).toFile(maskPath);
          const pubMask = await publishImage(maskPath);
          nLog("[worker-region-edit] Mask published to:", pubMask.url);

          // Record in Redis for image history lookups (enables future edits on this result)
          try {
            await recordEnhancedImageRedis({
              userId: regionPayload.userId,
              imageId: regionAny.imageId || regionPayload.userId, // Use userId as fallback if imageId missing
              publicUrl: pub.url,
              baseKey: pub.url.split("?")[0].split("/").pop() || "",
              versionId: "", // Region edits don't have version IDs
              stage: "region-edit",
            });
            nLog("[worker-region-edit] Redis image history recorded");
          } catch (err) {
            nLog("[worker-region-edit] Failed to record image history in Redis:", (err as any)?.message || err);
          }

          // Record usage tracking (best-effort, non-blocking)
          try {
            const agencyId = (regionPayload as any).agencyId || null;
            await recordRegionEditUsage(regionPayload, agencyId);
          } catch (usageErr) {
            nLog("[USAGE] Failed to record region-edit usage (non-blocking):", (usageErr as any)?.message || usageErr);
          }

          // Update job status with all required fields (matches enhance job format for /api/status/batch)
          await updateJob(regionPayload.jobId, {
            status: "complete",
            success: true,
            resultUrl: pub.url, // Primary result URL (checked by status endpoint)
            imageUrl: pub.url, // Fallback field
            originalUrl: baseImageUrl, // Return the original input URL
            maskUrl: pubMask.url, // Return the published mask URL
            imageId: regionPayload.imageId, // Include imageId for tracking
            mode: regionAny.mode, // Include original mode from payload (add/remove/replace/restore)
            meta: {
              type: "region-edit",
              mode: mode, // Normalized mode (Add/Remove/Replace/Restore)
              instruction: prompt,
            },
          });
          nLog('[worker-region-edit] updateJob called', {
            jobId: regionPayload.jobId,
            imageUrl: pub.url,
            maskUrl: pubMask.url,
          });

          return {
            ok: true,
            resultUrl: pub.url,
            imageUrl: pub.url,
            originalUrl: baseImageUrl,
            maskUrl: pubMask.url,
          };
        } else {
          updateJob((payload as any).jobId, { status: "failed", errorMessage: "unknown job type" });
        }
      } else {
        throw new Error("Job payload missing 'type' property or is not an object");
      }
    } catch (err: any) {
      nLog("[worker] job failed", err);
      updateJob((payload as any).jobId, { status: "failed", errorMessage: err?.message || "unhandled worker error" });
      throw err;
    }
  },
  {
    connection: { url: REDIS_URL },
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2)
  }
);

// Show readiness (optional in BullMQ v5)
(async () => {
  try {
    // @ts-ignore
    await worker.waitUntilReady?.();
    nLog("[worker] ready and listening");
  } catch (e) {
    nLog("[worker] failed to initialize", e);
  }
})();

worker.on("completed", (job, result: any) => {
  const url =
    result && (result as any).resultUrl
      ? String((result as any).resultUrl).slice(0, 120)
      : undefined;

  nLog(
    `[worker] completed job ${job.id}${url ? ` -> ${url}` : ""}`
  );
});

worker.on("failed", (job, err) => {
  nLog(`[worker] failed job ${job?.id}`, err);
});
