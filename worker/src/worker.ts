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
import { randomUUID } from "crypto";

import { runStage1A } from "./pipeline/stage1A";
import { runStage1B } from "./pipeline/stage1B";
import { runStage2 } from "./pipeline/stage2";
import { computeStructuralEdgeMask } from "./validators/structuralMask";
import { applyEdit } from "./pipeline/editApply";
import { preprocessToCanonical } from "./pipeline/preprocess";

import { detectSceneFromImage, determineSkyMode, type SkyModeResult } from "./ai/scene-detector";
import { detectRoomType } from "./ai/room-detector";
import { classifyScene } from "./validators/scene-classifier";
import { detectFurniture, getAnchorClassSet, resolveFurnishedGateDecision } from "./ai/furnitureDetector";
import { isRoomEmpty } from "./vision/isRoomEmpty";

import {
  updateJob,
  getJob,
  pushImageVersion,
  readImageRecord,
  getVersionPath,
  getOriginalPath
} from "./utils/persist";
import { setVersionPublicUrl } from "./utils/persist";
import { recordEnhancedImage } from "../../shared/src/imageHistory";
import { recordEnhancedImageRedis } from "@realenhance/shared";
import { resolveStageUrl, mergeStageUrls } from "@realenhance/shared/stageUrlResolver";
import { getJobMetadata, saveJobMetadata, JOB_META_TTL_PROCESSING_SECONDS, JOB_META_TTL_HISTORY_SECONDS, computeFallbackVersionKey } from "@realenhance/shared/imageStore";
import type { JobOwnershipMetadata } from "@realenhance/shared";
import { getGeminiClient, enhanceWithGemini } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64, siblingOutPath } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";
import { publishImage } from "./utils/publish";
import { downloadToTemp } from "./utils/remote";
import { isTerminalStatus, safeWriteJobStatus } from "./utils/statusUtils";
import { canMarkJobComplete, logCompletionGuard } from "./utils/completionGuard";
import { checkStageOutput } from "./utils/stageOutputGuard";
import { runStructuralCheck } from "./validators/structureValidatorClient";
import { getLocalValidatorMode, getGeminiValidatorMode, isGeminiBlockingEnabled, logValidationModes } from "./validators/validationModes";
import {
  runUnifiedValidation,
  logUnifiedValidationCompact,
  shouldInjectEvidence,
  type UnifiedValidationResult
} from "./validators/runValidation";
import { getStage2ValidationModeFromPromptMode } from "./validators/stage2ValidationMode";
import { shouldRetry as evidenceShouldRetry } from "./validators/validationEvidence";
import { isJobFailedFinal } from "./validators/stageRetryManager";
const STAGE1B_MAX_ATTEMPTS = Math.max(1, Number(process.env.STAGE1B_MAX_ATTEMPTS || 2));
const GEMINI_CONFIRM_MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_CONFIRM_MAX_RETRIES || 2));
const MAX_STAGE_RUNTIME_MS = Number(process.env.MAX_STAGE_RUNTIME_MS || 300000);
const STAGE1B_DECLUTTER_EFFECTIVENESS_ENABLED = String(process.env.STAGE1B_DECLUTTER_EFFECTIVENESS_ENABLED ?? "true").toLowerCase() !== "false";
import { runSemanticStructureValidator } from "./validators/semanticStructureValidator";
import { runMaskedEdgeValidator } from "./validators/maskedEdgeValidator";
import {
  runStage1BDeclutterEffectivenessValidator,
  type Stage1BDeclutterEffectivenessResult,
} from "./validators/stage1BDeclutterEffectiveness";
import { detectCurtainRail } from "./validators/curtainRailDetector";
import { canStage, logStagingBlocked, type SceneType } from "../../shared/staging-guard";
import { vLog, nLog, isValidationFocusMode, logIfNotFocusMode } from "./logger";
import { VALIDATOR_FOCUS } from "./config";
import { createTempTracker, type TempTracker } from "./utils/tempTracker";
import { cleanupTempFiles } from "./utils/sharp-utils";
import { recordEnhanceBundleUsage, recordEditUsage, recordRegionEditUsage } from "./utils/usageTracking";
import { finalizeReservationFromWorker } from "./utils/reservations.js";
import { recordEnhancedImage as recordEnhancedImageHistory } from "./db/enhancedImages.js";
import { generateAuditRef, generateTraceId } from "./utils/audit.js";
import { startMemoryTracking, endMemoryTracking, updatePeakMemory, isMemoryCritical, forceGC } from "./utils/memory-monitor.js";
import { VALIDATION_FOCUS_MODE } from "./utils/logFocus";
import { buildRetryMeta, type RetryMeta } from "./utils/retryMeta";
import { finalizeImageChargeFromWorker } from "./utils/billingFinalization.js";
import { applyFinalBlackEdgeGuard, assertNoDarkBorder } from "./utils/finalBlackEdgeGuard";

const FINAL_BLACK_EDGE_GUARD_ENABLED = String(process.env.FINAL_BLACK_EDGE_GUARD || "").toLowerCase() === "true";
const logger = console;

async function publishWithOptionalBlackEdgeGuard(localPath: string, stageLabel: string) {
  if (FINAL_BLACK_EDGE_GUARD_ENABLED) {
    const guard = await applyFinalBlackEdgeGuard(localPath);
    if (guard.changed) {
      nLog(`[BLACK_EDGE_GUARD] stage=${stageLabel} action=cropped reason=${guard.reason}`);
    } else if (guard.reason !== "not_detected") {
      nLog(`[BLACK_EDGE_GUARD] stage=${stageLabel} action=skipped reason=${guard.reason}`);
    }
  }

  const borderPx = Math.max(1, Number(process.env.BLACK_BORDER_CHECK_PX || 3));
  const threshold = Math.max(0, Number(process.env.BLACK_BORDER_THRESHOLD || 5));
  const maxDarkRatio = Math.max(0, Math.min(1, Number(process.env.BLACK_BORDER_MAX_DARK_RATIO || 0.02)));
  await assertNoDarkBorder(localPath, borderPx, threshold, maxDarkRatio);
  return publishImage(localPath);
}

function computeCurtainRailFeatures(mask?: { width: number; height: number; data: Uint8Array }) {
  if (!mask || !mask.width || !mask.height || !mask.data) {
    return { horizontalLinesNearTop: 0, windowTopEdgeDensity: 0 };
  }

  const { width, height, data } = mask;
  const topBandHeight = Math.max(1, Math.floor(height * 0.2));
  const rowEdgeCounts = new Array(topBandHeight).fill(0);
  let topEdges = 0;

  for (let y = 0; y < topBandHeight; y++) {
    let rowCount = 0;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (data[rowOffset + x]) {
        rowCount++;
        topEdges++;
      }
    }
    rowEdgeCounts[y] = rowCount;
  }

  const rowThreshold = Math.max(1, Math.floor(width * 0.15));
  const rowsWithLines = rowEdgeCounts.filter((c) => c >= rowThreshold).length;
  const horizontalLinesNearTop = rowsWithLines / Math.max(1, topBandHeight);
  const windowTopEdgeDensity = topEdges / Math.max(1, width * topBandHeight);

  return { horizontalLinesNearTop, windowTopEdgeDensity };
}

async function checkStage2AlreadyFinal(jobId: string, attemptedBy: string): Promise<boolean> {
  try {
    const current = await getJob(jobId);
    const status = current?.status as string | undefined;
    const finalStage = (current as any)?.finalStage as string | undefined;
    if (status === "complete" && finalStage === "2") {
      nLog(`[COMPLETION_GUARD] skip write — Stage2 already final jobId=${jobId} attemptedBy=${attemptedBy}`);
      const incomingType = attemptedBy === "edit"
        ? "edit"
        : attemptedBy === "region-edit"
          ? "region"
          : attemptedBy === "stage2_only"
            ? "stage1B"
            : "partial";
      console.log(`[COMPLETION_GUARD_BLOCKED] job=${jobId} attemptId=${attemptedBy} incomingType=${incomingType} finalStatusAlreadySet=true`);
      return true;
    }
  } catch {}
  return false;
}

async function completePartialJob(params: {
  jobId: string;
  triggerStage: "1B" | "2";
  finalStage: "1A" | "1B";
  finalPath: string;
  pub1AUrl?: string;
  pub1BUrl?: string;
  sceneMeta?: Record<string, any>;
  userMessage: string;
  reason: string;
  stageOutputs: { "1A": string; "1B"?: string };
}) {
  const { jobId, triggerStage, finalStage, finalPath, pub1AUrl, pub1BUrl, sceneMeta, userMessage, reason, stageOutputs } = params;
  let resultUrl = finalStage === "1A" ? pub1AUrl : pub1BUrl;
  if (!resultUrl) {
    const pub = await publishWithOptionalBlackEdgeGuard(finalPath, `partial-${finalStage}`);
    resultUrl = pub.url;
  }

  nLog(`[FALLBACK_TRIGGERED] stage=${triggerStage} reason=${reason}`);

  if (await checkStage2AlreadyFinal(jobId, triggerStage)) {
    return;
  }

  // Completion guard — partial completions have no validator result
  const currentJob = await getJob(jobId);
  const guard = canMarkJobComplete(currentJob as any, null, {
    outputUrl: resultUrl,
    finalStageRan: finalStage,
    expectedFinalStage: finalStage,
  });
  logCompletionGuard(jobId, guard);
  if (!guard.ok) {
    await safeWriteJobStatus(jobId, { status: "failed", errorMessage: `completion_guard_block: ${guard.reason}` }, "completion_guard_block");
    return;
  }

  await safeWriteJobStatus(jobId, {
    status: "complete",
    success: true,
    completed: true,
    currentStage: "finalizing",
    finalStage: finalStage,
    resultStage: finalStage,
    resultUrl,
    imageUrl: resultUrl,
    message: userMessage,
    stageUrls: {
      "1A": pub1AUrl ?? null,
      "1B": pub1BUrl ?? null,
      "2": null,
    },
    stageOutputs: {
      "1A": stageOutputs["1A"],
      "1B": stageOutputs["1B"],
    },
    meta: {
      ...(sceneMeta || {}),
      partial: true,
      fallbackStage: finalStage,
      fallbackReason: reason,
      userMessage,
    },
  }, `partial_complete:${reason}`);

  nLog(`[PARTIAL_COMPLETE] finalStage=${finalStage} resultUrl=${resultUrl}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRITICAL: Global error handlers to prevent silent crashes (bus errors)
// ═══════════════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (error, origin) => {
  console.error('[FATAL] Uncaught Exception:', {
    error: error.message,
    stack: error.stack,
    origin
  });
  // Log but don't exit immediately - let worker finish current job
  setTimeout(() => {
    console.error('[FATAL] Exiting after uncaught exception');
    process.exit(1);
  }, 5000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise Rejection:', {
    reason,
    promise
  });
  // Don't exit - just log for debugging
});

// Module-level ref so shutdown handlers can access the BullMQ worker
// (assigned after the Worker constructor at the bottom of the file)
let _workerRef: import('bullmq').Worker | null = null;

async function gracefulShutdown(signal: string) {
  console.log(`[WORKER] ${signal} received, graceful shutdown...`);
  const FORCE_EXIT_MS = 10_000;
  const forceTimer = setTimeout(() => {
    console.error(`[WORKER] Forced exit after ${FORCE_EXIT_MS}ms`);
    process.exit(1);
  }, FORCE_EXIT_MS);
  // Prevent the timer from keeping the process alive
  forceTimer.unref();

  try {
    if (_workerRef) {
      await _workerRef.close();
      console.log('[WORKER] BullMQ worker closed cleanly');
    }
  } catch (err) {
    console.error('[WORKER] Error closing worker:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

// ═══════════════════════════════════════════════════════════════════════════════

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
  // Start memory tracking for this job
  startMemoryTracking(payload.jobId);

  if (isValidationFocusMode()) {
    console.log("[VALIDATION_FOCUS_MODE] enabled — suppressing non-validator logs");
  }

  nLog(`========== PROCESSING JOB ${payload.jobId} ==========`);
  if ((payload as any).retryType === "manual_retry") {
    nLog(`[JOB_START] retryType=manual_retry sourceStage=${(payload as any).retrySourceStage || 'upload'} sourceUrl=${(payload as any).retrySourceUrl || 'n/a'} sourceKey=${(payload as any).retrySourceKey || 'n/a'} parentJobId=${(payload as any).retryParentJobId || 'n/a'}`);
    // Attach retryMeta for observability
    buildRetryMeta(payload.jobId, {
      attempt: 1,
      reason: "manual_retry",
      stage: ((payload as any).retrySourceStage as any) || "1A",
      parentJobId: (payload as any).retryParentJobId,
    });
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

  let requestedStages: any | undefined;

  let stagingStyleNorm: string | undefined;

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

    requestedStages = merged.requestedStages;

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

  if (!requestedStages) {
    requestedStages = buildRequestedStages();
  }

  let stage12Success = false;
  let stage2Success = false;
  let stage2PublishSuccess = false;
  let stage2PublishedUrl: string | undefined = undefined;
  let stage2AttemptsUsed = 0;
  let stage2MaxAttempts = 1;
  let stage2ValidationRisk = false;
  let stage2Blocked = false;
  let stage2BlockedReason: string | undefined;
  let stage2FallbackStage: "1A" | "1B" | null = null;
  let fallbackUsed: string | null = null;
  let stage2NeedsConfirm = false;
  let stage2LocalReasons: string[] = [];
  const stage2AttemptOutputs: Array<{
    attempt: number;
    localPath: string;
    publishedUrl?: string;
    blockedBy?: string | null;
    reasons?: string[] | null;
  }> = [];
  let stage2SummaryLogged = false;
  let stage2SummaryEligible = false;
  const localValidatorMode = getLocalValidatorMode();
  const geminiValidatorMode = getGeminiValidatorMode();
  const geminiBlockingEnabled = isGeminiBlockingEnabled();
  // Local validators run in their configured mode (log/block)
  // Gemini confirmation is triggered only when local mode is log
  const VALIDATION_BLOCKING_ENABLED = localValidatorMode === "block";
  const GEMINI_CONFIRMATION_ENABLED = localValidatorMode === "log";
  const structureValidatorMode = localValidatorMode;
  
  // Unified flag: true when ANY validator can block images
  // Used for retry gating, fallback gating, and validation behavior
  const VALIDATORS_ARE_BLOCKING = VALIDATION_BLOCKING_ENABLED || geminiBlockingEnabled;
  const COMPLIANCE_BLOCK_THRESHOLD = Number(process.env.COMPLIANCE_BLOCK_THRESHOLD ?? 0.85);
  
  // Sharp-based semantic structure validator control
  const sharpFinalValidatorRaw = process.env.SHARP_FINAL_VALIDATOR;
  const sharpFinalValidatorMode = sharpFinalValidatorRaw?.trim().toLowerCase() === "block" ? "block" : 
                                   sharpFinalValidatorRaw?.trim().toLowerCase() === "log" ? "log" : null;
  const SHARP_SEMANTIC_ENABLED = sharpFinalValidatorMode !== null;
  
  // Gemini-based semantic validation control (Stage 2 perspective/furniture/realism checks)
  const geminiSemanticValidatorRaw = process.env.ENABLE_GEMINI_SEMANTIC_VALIDATION;
  const geminiSemanticValidatorMode = geminiSemanticValidatorRaw?.trim().toLowerCase() === "block" ? "block" : 
                                       geminiSemanticValidatorRaw?.trim().toLowerCase() === "log" ? "log" : null;
  
  logValidationModes();

  // ═══════════ PER-IMAGE JOB EXECUTION CONTEXT (CROSS-IMAGE ISOLATION) ═══════════
  // Prevents shared mutable state corruption across concurrent image processing
  interface JobExecutionContext {
    jobId: string;
    imageId: string;
    roomType?: string;
    canonicalPath: string | null;
    baseArtifacts: any;
    baseArtifactsCache: Map<string, any>;
    structuralMask: { width: number; height: number; data: Uint8Array } | null;
    curtainRailLikely: boolean | "unknown";
    curtainRailConfidence: number;
    jobSampling: any;
    jobDeclutterIntensity?: "light" | "standard" | "heavy";
    stagingRegion: any;
  }

  const jobContext: JobExecutionContext = {
    jobId: payload.jobId,
    imageId: payload.imageId,
    roomType: (payload.options as any)?.roomType,
    canonicalPath: null,
    baseArtifacts: null,
    baseArtifactsCache: new Map(),
    structuralMask: null,
    curtainRailLikely: "unknown",
    curtainRailConfidence: 0,
    jobSampling: null,
    jobDeclutterIntensity: undefined,
    stagingRegion: null,
  };

  const stageLineage = {
    jobId: payload.jobId,
    imageId: payload.imageId,
    stage1A: { input: null as string | null, output: null as string | null, committed: false },
    stage1B: { input: null as string | null, output: null as string | null, committed: false },
    stage2: { input: null as string | null, output: null as string | null, committed: false },
    curtainRailLikely: "unknown" as boolean | "unknown",
    baseArtifacts: null as any,
    fallbackUsed: null as string | null,
  };

  const logStageInput = (stage: string, sourceStage: string | null, path: string) => {
    nLog("[STAGE_INPUT_SELECTED]", { jobId: payload.jobId, stage, sourceStage, path: path.substring(path.length - 40) });
  };

  const logStageOutput = (stage: string, path: string) => {
    nLog("[STAGE_OUTPUT_COMMITTED]", { jobId: payload.jobId, stage, path: path.substring(path.length - 40) });
  };

  const recordStage2AttemptOutput = (attempt: number, localPath: string) => {
    if (!Number.isFinite(attempt) || attempt < 0) return;
    if (stage2AttemptOutputs.some((entry) => entry.localPath === localPath)) return;
    stage2AttemptOutputs.push({ attempt, localPath });
  };

  const recordStage2AttemptsFromResult = (basePath: string, attemptsUsed?: number) => {
    if (!attemptsUsed || attemptsUsed < 1) return;
    for (let attempt = 0; attempt < attemptsUsed; attempt++) {
      const suffix = attempt === 0 ? "-2" : `-2-retry${attempt}`;
      recordStage2AttemptOutput(attempt, siblingOutPath(basePath, suffix, ".webp"));
    }
  };

  const attachStage2PublishedUrl = (localPath: string, publishedUrl: string) => {
    const match = stage2AttemptOutputs.find((entry) => entry.localPath === localPath);
    if (match) {
      match.publishedUrl = publishedUrl;
    }
  };

  const stage2BlockedByPriority = (blockedBy?: string | null): number => {
    if (blockedBy === "gemini") return 3;
    if (blockedBy === "consensus") return 2;
    if (blockedBy === "local") return 2;
    if (blockedBy === "timeout") return 1;
    if (blockedBy === "guard") return 1;
    if (blockedBy) return 1;
    return 0;
  };

  const setStage2AttemptValidation = (
    localPath: string | undefined | null,
    blockedBy: string,
    reasons: string[] | undefined,
  ) => {
    if (!localPath) return;
    const match = stage2AttemptOutputs.find((entry) => entry.localPath === localPath);
    if (!match) return;
    const nextPriority = stage2BlockedByPriority(blockedBy);
    const currentPriority = stage2BlockedByPriority(match.blockedBy ?? null);
    if (nextPriority < currentPriority) return;
    match.blockedBy = blockedBy;
    match.reasons = reasons && reasons.length ? reasons : [];
  };

  const getUnifiedValidatorReasons = (result: UnifiedValidationResult | undefined): string[] => {
    if (!result) return [];
    if (result.reasons && result.reasons.length) return result.reasons;
    const rawEntries = result.raw ? Object.entries(result.raw) : [];
    const failedNames = rawEntries
      .filter(([, verdict]) => verdict && verdict.passed === false)
      .map(([name]) => name);
    return failedNames;
  };

  const logStage2RetrySummary = (selectedPath?: string | null) => {
    if (stage2SummaryLogged || !stage2SummaryEligible) return;
    stage2SummaryLogged = true;
    const selectedFinalAttempt = selectedPath
      ? stage2AttemptOutputs.find((entry) => entry.localPath === selectedPath)?.attempt ?? null
      : null;
    const attemptsSummary = stage2AttemptOutputs.map((entry) => {
      const label = entry.attempt === 0 ? "base" : `retry${entry.attempt}`;
      return {
        attempt: entry.attempt,
        label,
        url: entry.publishedUrl ?? null,
        blockedBy: entry.blockedBy ?? null,
        reasons: entry.reasons ?? null,
      };
    });
    const urls = attemptsSummary
      .filter((entry) => entry.url)
      .map((entry) => ({ label: entry.label, url: entry.url as string }));
    nLog("[STAGE2_RETRY_SUMMARY]", {
      jobId: payload.jobId,
      attemptCount: attemptsSummary.length,
      adoptedAttempt: selectedFinalAttempt ?? null,
      attempts: attemptsSummary,
      urls,
      regenEnabled: stage2MaxAttempts > 1,
      regenMaxAttempts: stage2MaxAttempts,
      completionGuardActive: true,
    });
  };

  const commitStageOutput = (stage: "1A" | "1B" | "2", outputPath: string) => {
    const stageEntry = stage === "1A"
      ? stageLineage.stage1A
      : stage === "1B"
        ? stageLineage.stage1B
        : stageLineage.stage2;
    if (!stageEntry) {
      nLog("[STAGE_OUTPUT_COMMIT_SKIPPED]", { jobId: payload.jobId, stage, path: outputPath });
      return;
    }
    stageEntry.output = outputPath;
    stageEntry.committed = true;
    logStageOutput(stage, outputPath);
  };
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
      if (!VALIDATION_FOCUS_MODE) {
        nLog(`[WORKER] Remote original detected, downloading: ${remoteUrl}\n`);
      }
      origPath = await downloadToTemp(remoteUrl, payload.jobId);
      if (!VALIDATION_FOCUS_MODE) {
        nLog(`[WORKER] Remote original downloaded to: ${origPath}\n`);
      }
    } catch (e) {
      if (!VALIDATION_FOCUS_MODE) {
        nLog(`[WORKER] ERROR: Failed to download remote original: ${(e as any)?.message || e}\n`);
      }
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: `Failed to download original: ${(e as any)?.message || 'unknown error'}` },
        "download_original_failed"
      );
      return;
    }
  } else {
    // Legacy single-service mode: Read from local filesystem
    if (!VALIDATION_FOCUS_MODE) {
      nLog("[WORKER] WARN: Job lacks remoteOriginalUrl. Attempting to read from local filesystem.\n");
      nLog("[WORKER] In production multi-service deployment, server should upload originals to S3 and provide remoteOriginalUrl.\n");
    }
    
    const rec = readImageRecord(payload.imageId);
    if (!rec) {
      nLog(`[WORKER] ERROR: Image record not found for ${payload.imageId} and no remoteOriginalUrl provided.\n`);
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: "image not found - no remote URL and local record missing" },
        "image_record_missing"
      );
      return;
    }
    origPath = getOriginalPath(rec);
    if (!fs.existsSync(origPath)) {
      nLog(`[WORKER] ERROR: Local original file not found at ${origPath}\n`);
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: "original file not accessible in this container" },
        "original_file_missing"
      );
      return;
    }
  }

  // Track primary scene detection (interior/exterior) confidence across all flows
  let scenePrimary: any = undefined;

  // ═══════════ STAGE-2-ONLY RETRY MODE ═══════════
  // ✅ Smart retry: Skip 1A/1B, run only Stage-2 from validated 1B output
  const stage2Requested = requestedStages?.stage2 === true || requestedStages?.stage2 === "true";
  let stage2AttemptId: string | undefined;
  const STAGE2_FORCE_REFRESH_ROOM_TYPES = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);

  const canonicalizeStage2RoomType = (rawRoomType: unknown) => {
    const normalizedRoomType = String(rawRoomType || "")
      .toLowerCase()
      .replace(/-/g, "_")
      .trim();
    return normalizedRoomType === "multiple_living_areas"
      ? "multiple_living"
      : normalizedRoomType;
  };

  const resolveStage2Routing = (ctx: {
    roomType: unknown;
    isExteriorScene: boolean;
    baseStage: "1A" | "1B";
    stage1BMode?: "light" | "stage-ready" | null;
    sourceStageHint?: "1A" | "1B-light" | "1B-stage-ready" | null;
  }) => {
    const canonicalRoomType = canonicalizeStage2RoomType(ctx.roomType);
    const forceRefresh = STAGE2_FORCE_REFRESH_ROOM_TYPES.has(canonicalRoomType);

    let sourceStage: "1A" | "1B-light" | "1B-stage-ready" = "1A";
    let reason = "default_1a";

    if (ctx.isExteriorScene) {
      sourceStage = "1A";
      reason = "exterior_scene";
    } else if (ctx.sourceStageHint === "1A" || ctx.sourceStageHint === "1B-light" || ctx.sourceStageHint === "1B-stage-ready") {
      sourceStage = ctx.sourceStageHint === "1B-stage-ready" ? "1B-light" : ctx.sourceStageHint;
      reason = "hint";
    } else if (ctx.baseStage === "1B") {
      sourceStage = "1B-light";
      reason = ctx.stage1BMode === "stage-ready" ? "stage1b_mode_structured_retain" : "stage1b_mode_light";
    }

    const mode: "refresh" | "full" = ctx.isExteriorScene
      ? "refresh"
      : (sourceStage === "1A" ? "full" : "refresh");
    if (forceRefresh && sourceStage === "1A") {
      reason = `${reason}+force_refresh_room_type`;
    }

    return {
      canonicalRoomType,
      forceRefresh,
      sourceStage,
      mode,
      reason,
    };
  };

  const logMultiZoneFullMode = (ctx: {
    path: "main" | "stage2_only" | "light_declutter_backstop";
    canonicalRoomType: string;
    sourceStage: "1A" | "1B-light" | "1B-stage-ready";
    enforced: boolean;
  }) => {
    if (STAGE2_FORCE_REFRESH_ROOM_TYPES.has(ctx.canonicalRoomType) && ctx.sourceStage === "1A") {
      nLog("[MULTI_ZONE_FULL_MODE]", {
        jobId: payload.jobId,
        imageId: payload.imageId,
        path: ctx.path,
        roomType: ctx.canonicalRoomType,
        sourceStage: ctx.sourceStage,
        enforced: ctx.enforced,
      });
    }
  };

  const getStage2Context = async () => {
    const latestJob = await getJob(payload.jobId);
    return {
      status: latestJob?.status as string | undefined,
      stage2AttemptId: (latestJob as any)?.stage2AttemptId as string | undefined,
      retryPendingStage2: Boolean((latestJob as any)?.retryPendingStage2),
    };
  };

  const ensureStage2AttemptId = async () => {
    if (stage2AttemptId) return stage2AttemptId;
    const current = await getStage2Context();
    if (current.stage2AttemptId) {
      stage2AttemptId = current.stage2AttemptId;
      return stage2AttemptId;
    }
    stage2AttemptId = randomUUID();
    await updateJob(payload.jobId, { stage2AttemptId, retryPendingStage2: false });
    return stage2AttemptId;
  };

  const scheduleStage2Retry = async (reason: string) => {
    const currentAttemptId = await ensureStage2AttemptId();
    const nextAttemptId = randomUUID();
    await updateJob(payload.jobId, { stage2AttemptId: nextAttemptId, retryPendingStage2: true });
    nLog("[STAGE2_RETRY_SCHEDULED]", {
      jobId: payload.jobId,
      reason,
      fromAttemptId: currentAttemptId,
      toAttemptId: nextAttemptId,
    });
    nLog("[RETRY_STATUS_WRITE]", {
      jobId: payload.jobId,
      stage: "2",
      reason,
      attemptId: nextAttemptId,
    });
    await safeWriteJobStatus(
      payload.jobId,
      {
        status: "processing",
        retryingStage: "2",
        retryAttempt: 1,
        message: "Retrying Stage 2 with stricter validation...",
        retryMeta: buildRetryMeta(payload.jobId, {
          attempt: 1,
          reason,
          stage: "2",
        }),
      },
      "stage2_retry_scheduled"
    );
    nLog("[STAGE2_ATTEMPT_SUPERSEDED]", {
      jobId: payload.jobId,
      reason,
      fromAttemptId: currentAttemptId,
      toAttemptId: nextAttemptId,
    });
    stage2AttemptId = nextAttemptId;
    return nextAttemptId;
  };

  const ensureStage2AttemptOwner = async (action: string) => {
    const currentAttemptId = await ensureStage2AttemptId();
    const current = await getStage2Context();
    if (current.stage2AttemptId && current.stage2AttemptId !== currentAttemptId) {
      nLog("[STAGE2_STALE_ATTEMPT_WRITE_BLOCKED]", {
        jobId: payload.jobId,
        action,
        currentAttemptId,
        activeAttemptId: current.stage2AttemptId,
      });
      return false;
    }
    return true;
  };

  const canCompleteStage2 = async (validationPassed: boolean, action: string) => {
    const currentAttemptId = await ensureStage2AttemptId();
    const current = await getStage2Context();
    if (current.stage2AttemptId && current.stage2AttemptId !== currentAttemptId) {
      nLog("[STAGE2_STALE_ATTEMPT_WRITE_BLOCKED]", {
        jobId: payload.jobId,
        action,
        currentAttemptId,
        activeAttemptId: current.stage2AttemptId,
      });
      return false;
    }
    if (isTerminalStatus(current.status)) return false;
    if (current.retryPendingStage2) return false;
    if (!validationPassed) return false;
    nLog("[STAGE2_COMPLETION_ALLOWED]", {
      jobId: payload.jobId,
      action,
      currentAttemptId,
    });
    return true;
  };

  const clearStage2RetryPending = async (action: string) => {
    if (!(await ensureStage2AttemptOwner(action))) return false;
    await updateJob(payload.jobId, { retryPendingStage2: false });
    return true;
  };
  const isManualRetry = (payload as any).retryType === "manual_retry";

  if (isManualRetry) {
    const stage2OnlyBaseStage = ((payload.stage2OnlyMode as any)?.baseStage === "1A") ? "1A" : "1B";
    const hasValidRetryBaseline = stage2OnlyBaseStage === "1A"
      ? (!!(payload.stage2OnlyMode as any)?.base1AUrl && !(payload as any).retryStage1BWasRequested)
      : !!payload.stage2OnlyMode?.base1BUrl;
    const hasDeterministicStage2OnlyPayload =
      stage2Requested &&
      payload.stage2OnlyMode?.enabled &&
      hasValidRetryBaseline;
    if (!hasDeterministicStage2OnlyPayload) {
      nLog("[STAGE2_ONLY_PAYLOAD_INVALID]", {
        jobId: payload.jobId,
        retryType: (payload as any).retryType,
        stage2Requested,
        stage2OnlyEnabled: !!payload.stage2OnlyMode?.enabled,
        baseStage: stage2OnlyBaseStage,
        hasBase1BUrl: !!payload.stage2OnlyMode?.base1BUrl,
        hasBase1AUrl: !!(payload.stage2OnlyMode as any)?.base1AUrl,
        retryStage1BWasRequested: !!(payload as any).retryStage1BWasRequested,
      });
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: "stage2_retry_failed: invalid_manual_retry_payload" },
        "stage2_retry_failed_invalid_payload"
      );
      return;
    }
  }

  if (!stage2Requested && payload.stage2OnlyMode?.enabled) {
    nLog(`[worker] Stage-2-only retry requested but stage2 was not requested; skipping stage2-only mode.`);
  }
  const stage2OnlyBaseStage = ((payload.stage2OnlyMode as any)?.baseStage === "1A") ? "1A" : "1B";
  const stage2OnlyBaseSourceUrl = stage2OnlyBaseStage === "1A"
    ? ((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined)
    : (payload.stage2OnlyMode?.base1BUrl as string | undefined);
  if (isManualRetry && stage2Requested && payload.stage2OnlyMode?.enabled && !!stage2OnlyBaseSourceUrl) {
    nLog(`[worker] 🚀 ═══════════ STAGE-2-ONLY RETRY MODE ACTIVATED ═══════════`);
    nLog(`[worker] Reusing validated Stage-${stage2OnlyBaseStage} output: ${stage2OnlyBaseSourceUrl}`);

    try {
      await ensureStage2AttemptId();
      const timings: Record<string, number> = {};
      const t0 = Date.now();
      const t2 = Date.now();

      // Download deterministic Stage-1A or Stage-1B base image
      const basePath = await downloadToTemp(stage2OnlyBaseSourceUrl, `${payload.jobId}-stage${stage2OnlyBaseStage}`);
      if (!VALIDATION_FOCUS_MODE) {
        nLog(`[worker] Downloaded Stage-${stage2OnlyBaseStage} base to: ${basePath}`);
      }

      // Stage 2 validation baseline must match main pipeline behavior: compare against Stage 1A output
      let stage2OnlyValidationBaseline = basePath;
      if (stage2OnlyBaseStage === "1B" && (payload.stage2OnlyMode as any)?.base1AUrl) {
        try {
          stage2OnlyValidationBaseline = await downloadToTemp((payload.stage2OnlyMode as any).base1AUrl, `${payload.jobId}-stage1A`);
          if (!VALIDATION_FOCUS_MODE) {
            nLog(`[worker] Downloaded Stage-1A validation baseline to: ${stage2OnlyValidationBaseline}`);
          }
        } catch (baselineErr: any) {
          nLog(`[worker] Failed to download Stage-1A validation baseline (fallback=Stage-1B): ${baselineErr?.message || baselineErr}`);
          stage2OnlyValidationBaseline = basePath;
        }
      }
      nLog(`[STAGE2_BASELINE] using=${stage2OnlyValidationBaseline === basePath ? "Stage1B" : "Stage1A"}`);

      // Run Stage-2 only (using 1B as base)
      stage2SummaryEligible = true;
      const stage2OnlyMeta = (payload.stage2OnlyMode as any) || {};
      const stage2OnlyRouting = resolveStage2Routing({
        roomType: payload.options.roomType,
        isExteriorScene: payload.options.sceneType === "exterior",
        baseStage: stage2OnlyBaseStage,
        stage1BMode: stage2OnlyMeta.stage1BMode || undefined,
        sourceStageHint: stage2OnlyMeta.sourceStage || undefined,
      });
      const stage2OnlyValidationMode = getStage2ValidationModeFromPromptMode(stage2OnlyRouting.mode);
      logMultiZoneFullMode({
        path: "stage2_only",
        canonicalRoomType: stage2OnlyRouting.canonicalRoomType,
        sourceStage: stage2OnlyRouting.sourceStage,
        enforced: true,
      });
      nLog("[STAGE2_VALIDATOR_MODE]", {
        jobId: payload.jobId,
        path: "stage2_only",
        validationMode: stage2OnlyValidationMode,
      });
      if (!stage2OnlyMeta.sourceStage && !stage2OnlyMeta.stage1BMode) {
        nLog("[STAGE2_ONLY_MODE_CONTEXT_MISSING]", {
          jobId: payload.jobId,
          warning: "stage2_only payload missing sourceStage/stage1BMode; using deterministic fallback resolver",
          roomType: payload.options.roomType,
          resolvedSourceStage: stage2OnlyRouting.sourceStage,
          resolvedMode: stage2OnlyRouting.mode,
        });
      }
      nLog("[STAGE2_ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "stage2_only",
        baseStage: stage2OnlyBaseStage,
        hasStage1BLineage: stage2OnlyBaseStage === "1B",
        stage1BMode: stage2OnlyMeta.stage1BMode || null,
        roomType: payload.options.roomType,
        canonicalRoomType: stage2OnlyRouting.canonicalRoomType,
        forceRefresh: stage2OnlyRouting.forceRefresh,
        sourceStage: stage2OnlyRouting.sourceStage,
        finalMode: stage2OnlyRouting.mode,
        reason: stage2OnlyRouting.reason,
      });
      nLog("[STAGE2_BASE_PROOF]", {
        jobId: payload.jobId,
        path: "stage2_only",
        stage1APath: stage2OnlyBaseStage === "1A" ? basePath : stageLineage.stage1A.output,
        stage1BPath: stage2OnlyBaseStage === "1B" ? basePath : null,
        chosenBasePath: basePath,
        chosenBaseStage: stage2OnlyBaseStage,
        stage1BRequested: stage2OnlyBaseStage === "1B",
      });
      if (basePath && stageLineage.stage1A.output && basePath === stageLineage.stage1A.output) {
        nLog("[STAGE2_INVARIANT_VIOLATION]", {
          jobId: payload.jobId,
          path: "stage2_only",
          stage1A: stageLineage.stage1A.output,
          stage1B: basePath,
          chosen: basePath,
          chosenBaseStage: stage2OnlyBaseStage,
        });
      }
      const stage2Result = await runStage2(basePath, stage2OnlyBaseStage, {
        stagingStyle: payload.options.stagingStyle || "nz_standard",
        roomType: payload.options.roomType,
        sceneType: payload.options.sceneType as any,
        angleHint: undefined,
        profile: undefined,
        stagingRegion: undefined,
        sourceStage: stage2OnlyRouting.sourceStage,
        promptMode: stage2OnlyRouting.mode,
        jobId: payload.jobId,
        curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
        onAttemptSuperseded: (nextAttemptId) => {
          stage2AttemptId = nextAttemptId;
        },
      });
      const path2 = stage2Result.outputPath;
      recordStage2AttemptsFromResult(basePath, stage2Result.attempts);
      const stage2ValidationPassed = stage2Result.validationRisk !== true;

      timings.stage2Ms = Date.now() - t2;
      nLog(`[worker] Stage-2-only completed in ${timings.stage2Ms}ms`);

      // Run validators on Stage-2 output
      // Baseline: use Stage 1A when available to match normal pipeline validation behavior
      const sceneLabel = payload.options.sceneType === "exterior" ? "exterior" : "interior";
      const validationBaseline = stage2OnlyValidationBaseline;

      // ═══ Unified Validation (primary validator) ═══
      let unifiedRetryValidation: UnifiedValidationResult | undefined;

      // ═══ Phase H: Stage output consistency check ═══
      const stageOutputCheck = checkStageOutput(path2, "2", payload.jobId);
      if (!stageOutputCheck.readable) {
        nLog(`[worker] Stage output missing/unreadable before validation — marking failed`, { jobId: payload.jobId, stage: "2", path: path2 });
        await safeWriteJobStatus(payload.jobId, { status: "failed", errorMessage: "missing_stage_output" }, "missing_stage_output");
        return;
      }

      try {
        const effectiveMode = VALIDATION_BLOCKING_ENABLED ? "enforce" : "log";
        nLog(`[worker] ═══════════ Running Unified Validation (stage2-only retry) mode=${effectiveMode} ═══════════`);
        unifiedRetryValidation = await runUnifiedValidation({
          originalPath: validationBaseline,
          enhancedPath: path2,
          stage: "2",
          sceneType: sceneLabel as any,
          roomType: payload.options.roomType,
          mode: effectiveMode,
          geminiPolicy: VALIDATION_BLOCKING_ENABLED ? "never" : "on_local_fail",
          jobId: payload.jobId,
          stagingStyle: payload.options.stagingStyle || "nz_standard",
          stage1APath: validationBaseline,
          sourceStage: stage2OnlyRouting.sourceStage,
          validationMode: stage2OnlyValidationMode,
        });
        nLog(`[worker] Unified validation (stage2-only): ${unifiedRetryValidation.passed ? "PASSED" : "FAILED"} (score: ${unifiedRetryValidation.score})`);
      } catch (unifiedErr: any) {
        nLog(`[worker] Unified validation error (stage2-only, non-fatal):`, unifiedErr?.message || unifiedErr);
      }

      // ═══ Semantic + Masked Edge Validators (secondary) ═══
      await runSemanticStructureValidator({
        originalImagePath: validationBaseline,
        enhancedImagePath: path2,
        scene: sceneLabel as any,
        mode: "log",
      });

      await runMaskedEdgeValidator({
        originalImagePath: validationBaseline,
        enhancedImagePath: path2,
        scene: sceneLabel as any,
        mode: "log",
        jobId: payload.jobId,
      });

      // ═══ Structural Geometry Check — only if published URLs exist ═══
      // (Don't introduce new publish steps; use URLs available post-publish below)

      // AUDIT FIX: Compliance gate before publish in stage2-only path
      // Respects geminiSemanticValidatorMode: null=skip, "log"=log-only, "block"=blocking
      if (geminiSemanticValidatorMode !== null) {
        try {
          const ai = getGeminiClient();
          const baseRef = toBase64(validationBaseline);
          const enhanced = toBase64(path2);
          const s2oCompliance = await checkCompliance(ai as any, baseRef.data, enhanced.data, {
            validationMode: stage2OnlyValidationMode,
          });
          if (s2oCompliance && s2oCompliance.ok === false) {
            const confidence = s2oCompliance.confidence ?? 0.6;
            const shouldBlock = confidence >= COMPLIANCE_BLOCK_THRESHOLD;
            nLog("[COMPLIANCE_GATE_DECISION]", {
              jobId: payload.jobId,
              path: "stage2_only",
              ok: false,
              confidence,
              mode: geminiSemanticValidatorMode,
              action: (shouldBlock && geminiSemanticValidatorMode === "block") ? "block" : "log-only",
            });
            if (shouldBlock && geminiSemanticValidatorMode === "block") {
              const msg = `Structural violations: ${(s2oCompliance.reasons || ["Compliance failed"]).join("; ")}`;
              const err = new Error(`Compliance failed (stage2-only) confidence=${confidence.toFixed(2)}: ${msg}`);
              (err as any).code = "COMPLIANCE_VALIDATION_FAILED";
              (err as any).violations = s2oCompliance.reasons || [];
              (err as any).confidence = confidence;
              nLog(`[worker] ❌ BLOCKING stage2-only job ${payload.jobId} PRE-PUBLISH: ${msg}`);
              throw err;
            } else if (shouldBlock && geminiSemanticValidatorMode === "log") {
              const msg = `Structural violations: ${(s2oCompliance.reasons || ["Compliance failed"]).join("; ")}`;
              nLog(`[worker] ⚠️  Compliance failure (stage2-only) confidence=${confidence.toFixed(2)} mode=log - ALLOWING job to proceed: ${msg}`);
            } else {
              nLog(`[worker] ⚠️  Compliance soft-fail (stage2-only) confidence=${confidence.toFixed(2)} — proceeding`);
            }
          } else {
            nLog(`[AUDIT FIX] Compliance passed (stage2-only) — proceeding to publish`);
          }
        } catch (compErr: any) {
          if (compErr?.code === "COMPLIANCE_VALIDATION_FAILED") throw compErr;
          nLog("[worker] compliance check skipped (stage2-only):", compErr?.message || compErr);
        }
      } else {
        nLog(`[worker] Compliance check skipped (stage2-only) - geminiSemanticValidatorMode=disabled`);
      }

      // Publish Stage-2 result
      if (!(await ensureStage2AttemptOwner("stage2_only_publish"))) return;
      const pub2 = await publishWithOptionalBlackEdgeGuard(path2, "stage2-only");
      const pub2Url = pub2.url;
      if (pub2Url) {
        attachStage2PublishedUrl(path2, pub2Url);

        // ═══ Structural Geometry Check (post-publish, log-only) ═══
        // Only run if we now have a published Stage 1B URL available
        const base1BPublishedUrl = stage2OnlyBaseStage === "1B" ? payload.stage2OnlyMode.base1BUrl : null;
        if (base1BPublishedUrl) {
          try {
            await runStructuralCheck(base1BPublishedUrl, pub2Url, { stage: "stage2", jobId: payload.jobId });
          } catch (geoErr: any) {
            nLog(`[worker] Structural geometry check error (stage2-only, non-fatal):`, geoErr?.message || geoErr);
          }
        }
      }

      stage2Success = true;
      stage2PublishSuccess = !!pub2Url;
      stage2PublishedUrl = pub2Url;
      
      // Track memory after Stage 2
      updatePeakMemory(payload.jobId);
      if (isMemoryCritical()) {
        nLog(`[MEMORY] WARNING: Memory usage critical after Stage 2 - forcing garbage collection`);
        forceGC();
      }

      timings.totalMs = Date.now() - t0;

      await clearStage2RetryPending("stage2_only_complete_clear_pending");
      if (!(await canCompleteStage2(stage2ValidationPassed, "stage2_only_complete"))) {
        await safeWriteJobStatus(
          payload.jobId,
          { status: "failed", errorMessage: "stage2_retry_failed: completion_guard_blocked_or_validation_failed" },
          "stage2_retry_failed_completion_blocked"
        );
        return;
      }
      if (await checkStage2AlreadyFinal(payload.jobId, "stage2_only")) return;

      // Completion guard
      const s2onlyJob = await getJob(payload.jobId);
      const s2onlyGuard = canMarkJobComplete(s2onlyJob as any, null, {
        outputUrl: pub2Url,
        finalStageRan: "2",
        expectedFinalStage: "2",
      });
      logCompletionGuard(payload.jobId, s2onlyGuard);
      if (!s2onlyGuard.ok) {
        await safeWriteJobStatus(payload.jobId, { status: "failed", errorMessage: `completion_guard_block: ${s2onlyGuard.reason}` }, "completion_guard_block");
        return;
      }

      await safeWriteJobStatus(payload.jobId, {
        status: "complete",
        resultUrl: pub2Url,
        stageUrls: {
          "1A": stage2OnlyBaseStage === "1A" ? ((payload.stage2OnlyMode as any)?.base1AUrl || null) : ((payload.stage2OnlyMode as any)?.base1AUrl || null),
          "1B": stage2OnlyBaseStage === "1B" ? (payload.stage2OnlyMode.base1BUrl || null) : null,
          "2": pub2Url
        },
        meta: {
          stage2OnlyRetry: true,
          timings,
          scene: { label: sceneLabel as any, confidence: scenePrimary?.confidence ?? null },
        }
      }, "stage2_only_complete");

      // Finalize reservation with bundled pricing: Stage1 already done, Stage2 succeeded here
      try {
        const billingStage1BUrl = stage2OnlyBaseStage === "1B" ? (payload.stage2OnlyMode?.base1BUrl || null) : null;
        const billingStage2Url = pub2Url || null;
        const billingStage1AUrl = stage2OnlyBaseStage === "1A"
          ? (((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null)
          : (((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null);
        const billingStage1ASuccess = !!billingStage1AUrl || !!billingStage1BUrl;
        const billingStage1BSuccess = !!billingStage1BUrl;
        const billingStage2Success = !!billingStage2Url;
        const actualCharge = !billingStage1ASuccess
          ? 0
          : (sceneLabel === "exterior"
            ? 1
            : (billingStage1BSuccess && billingStage2Success ? 2 : 1));

        nLog("[BILLING_CHARGE_TELEMETRY]", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          stage1ASuccess: billingStage1ASuccess,
          stage1BSuccess: billingStage1BSuccess,
          stage2Success: billingStage2Success,
          finalCharge: actualCharge,
          path: "stage2_only_retry",
        });

        await finalizeReservationFromWorker({
          jobId: payload.jobId,
          stage12Success: true,
          stage2Success: true,
          actualCharge,
        });
        nLog(`[BILLING] Finalized reservation for stage2-only retry: ${payload.jobId}`);
      } catch (billingErr) {
        nLog("[BILLING] Failed to finalize reservation (stage2-only retry):", (billingErr as any)?.message || billingErr);
      }

      // ✅ BILLING FINALIZATION: Compute final charge based on published outputs
      try {
        const billingStage1BUrl = stage2OnlyBaseStage === "1B" ? (payload.stage2OnlyMode?.base1BUrl || null) : null;
        const billingStage2Url = pub2Url || null;
        const billingStage1AUrl = stage2OnlyBaseStage === "1A"
          ? (((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null)
          : (((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null);
        const billingStage1ASuccess = !!billingStage1AUrl || !!billingStage1BUrl;
        const billingStage1BSuccess = !!billingStage1BUrl;
        const billingStage2Success = !!billingStage2Url;
        await finalizeImageChargeFromWorker({
          jobId: payload.jobId,
          stage1ASuccess: billingStage1ASuccess,
          stage1BSuccess: billingStage1BSuccess,
          stage2Success: billingStage2Success,
          sceneType: sceneLabel || "interior",
        });
      } catch (chargeErr) {
        nLog("[BILLING] Failed to finalize charge (stage2-only retry):", (chargeErr as any)?.message || chargeErr);
      }

      nLog(`[worker] ✅ Stage-2-only retry complete: ${pub2Url}`);
      logStage2RetrySummary(path2);
      return; // ✅ Exit early - full pipeline not needed

    } catch (err: any) {
      nLog(`[worker] ❌ Stage-2-only retry failed: ${err?.message || err}`);
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: `stage2_retry_failed: ${err?.message || "unknown_error"}` },
        "stage2_retry_failed"
      );
      return;
    }
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();
  
  // FIX 6: Track lifecycle timestamps for observability
  const timestamps = {
    queued: t0,
    stage1AStart: null as number | null,
    stage1AEnd: null as number | null,
    stage1BStart: null as number | null,
    stage1BEnd: null as number | null,
    stage2Start: null as number | null,
    stage2End: null as number | null,
    completed: null as number | null
  };

  // UNIFIED VALIDATION CONFIGURATION (env-driven)
  nLog(`[worker] Validator config: structureMode=${structureValidatorMode}, localBlocking=${VALIDATION_BLOCKING_ENABLED ? "ENABLED" : "DISABLED"}, geminiConfirmation=${GEMINI_CONFIRMATION_ENABLED ? "ENABLED" : "DISABLED"}, geminiMode=${geminiValidatorMode}, sharpSemantic=${sharpFinalValidatorMode || "disabled"}, geminiSemantic=${geminiSemanticValidatorMode || "disabled"}`);

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
  await safeWriteJobStatus(
    payload.jobId,
    { status: "processing", currentStage: "upload-original", stage: "upload-original", progress: 10, originalUrl: publishedOriginal?.url },
    "upload_original"
  );

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
    logIfNotFocusMode(`[SCENE] primary=${primary?.label ?? "unknown"} conf=${fmt(primary?.confidence)} sky=${fmt((primary as any)?.skyPct)} grass=${fmt((primary as any)?.grassPct)} deck=${fmt((primary as any)?.woodDeckPct)}`);

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
    await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
    return;
  }

  // CANONICAL PREPROCESS (new) for structural baseline
  let canonicalPath = origPath.replace(/\.(jpg|jpeg|png|webp)$/i, "-canonical.webp");
  try {
    const baseArtifacts = await preprocessToCanonical(origPath, canonicalPath, sceneLabel, {
      buildArtifacts: true,
      smallSize: 512,
    });
    if (baseArtifacts) {
      jobContext.baseArtifacts = baseArtifacts;
      jobContext.baseArtifactsCache.set(canonicalPath, baseArtifacts);
      // Isolate base artifacts per image
      stageLineage.baseArtifacts = baseArtifacts;
    }
    jobContext.canonicalPath = canonicalPath;
    // Precompute structural mask (architecture only) from canonical
    try {
      const mask = await computeStructuralEdgeMask(canonicalPath, baseArtifacts);
      jobContext.structuralMask = mask;
      nLog(`[WORKER] Structural mask computed: ${mask.width}x${mask.height}`);
    } catch (e) {
      nLog('[WORKER] Failed to compute structural mask:', e);
    }
  } catch (e) {
    nLog('[WORKER] Canonical preprocess failed; falling back to original for stages', e);
    canonicalPath = origPath; // fallback
    jobContext.canonicalPath = canonicalPath;
  }

  // STAGE 1A
  const t1A = Date.now();
  timestamps.stage1AStart = t1A; // FIX 6: Track Stage 1A start
  try {
    const stage1AInputMeta = await sharp(canonicalPath).metadata();
    nLog(`[stage0] STAGE1A_INPUT size=${stage1AInputMeta.width || 0}x${stage1AInputMeta.height || 0}`);
  } catch {}
  // Inject per-job tuning into context for pipeline modules (simple dependency injection)
  try {
    const s = (payload.options as any)?.sampling || {};
    jobContext.jobSampling = {
      temperature: typeof s.temperature === 'number' ? s.temperature : undefined,
      topP: typeof s.topP === 'number' ? s.topP : undefined,
      topK: typeof s.topK === 'number' ? s.topK : undefined,
    };
    jobContext.jobDeclutterIntensity = (payload.options as any)?.declutterIntensity;
  stageLineage.stage1A.input = origPath;
  logStageInput("1A", null, origPath);
  } catch {}
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // PATH VARIABLES + STAGELINEAGE (FIX 1.3 - Sprint 1)
  // ═══════════════════════════════════════════════════════════════════════════════
  // path1A, path1B, path2: Function-scoped convenience variables (LOW RISK for cross-contamination)
  // stageLineage: Single source of truth for committed stage outputs
  // 
  // Pattern:
  // 1. Stage executes → assigns to local path variable
  // 2. commitStageOutput(stage, path) → syncs to stageLineage
  // 3. Validation guards read from stageLineage to detect/correct mismatches
  // 
  // Guards in place:
  // - Stage 1B input: synced from stageLineage.stage1A.output (line 1138)
  // - Stage 2 input: validated against stageLineage with mismatch correction (line 1871)
  // - Final output: validated against stageLineage (line 3009)
  // ═══════════════════════════════════════════════════════════════════════════════
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
  logIfNotFocusMode(`[STAGE1A] Final: sceneLabel=${sceneLabel} skyMode=${skyModeForStage1A} safeReplaceSky=${safeReplaceSky}`);
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
    baseArtifacts: jobContext.baseArtifacts,
    baseArtifactsCache: jobContext.baseArtifactsCache,
    jobSampling: jobContext.jobSampling,
  });

  try {
    const mask = jobContext.structuralMask;
    const features = computeCurtainRailFeatures(mask || undefined);
    const curtainRail = detectCurtainRail(features);
    jobContext.curtainRailLikely = curtainRail.railLikely;
    jobContext.curtainRailConfidence = curtainRail.confidence;
    stageLineage.curtainRailLikely = curtainRail.railLikely;
    nLog(`[CURTAIN_RAIL_DETECT] railLikely=${curtainRail.railLikely} conf=${curtainRail.confidence.toFixed(2)}`);
  } catch (err) {
    jobContext.curtainRailLikely = "unknown";
    jobContext.curtainRailConfidence = 0;
    stageLineage.curtainRailLikely = "unknown";
    nLog(`[CURTAIN_RAIL_DETECT] railLikely=unknown conf=0.00 reason=error`);
  }
  logIfNotFocusMode(`[stage1a] Gemini validation skipped by design (local-only sanity checks)`);
  
  commitStageOutput("1A", path1A);
  // Track memory after Stage 1A
  updatePeakMemory(payload.jobId);
  if (isMemoryCritical()) {
    nLog(`[MEMORY] WARNING: Memory usage critical after Stage 1A - forcing garbage collection`);
    forceGC();
  }
  timings.stage1AMs = Date.now() - t1A;
  timestamps.stage1AEnd = Date.now(); // FIX 6: Track Stage 1A completion
  
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
    const pub1A = await publishWithOptionalBlackEdgeGuard(path1A, "1A");
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
  // ✅ FIX 3: Add updatedAt timestamp for stuck detection
  const now = new Date().toISOString();
  await safeWriteJobStatus(
    payload.jobId,
    {
      status: "processing",
      currentStage: "1A",
      stage: "1A",
      progress: 35,
      stageUrls: { "1A": pub1AUrl ?? null },
      updatedAt: now,
      updated_at: now,
    },
    "stage1a_progress"
  );
  if (await isCancelled(payload.jobId)) {
    await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
    return;
  }

  // STAGE 1B (optional declutter)
  const t1B = Date.now();
  timestamps.stage1BStart = t1B; // FIX 6: Track Stage 1B start
  let path1B: string | undefined = undefined;
  let stage1BStructuralSafe = true;
  let stage1BDeclutterReasons: string[] = [];
  let stage1BDeclutterResult: Stage1BDeclutterEffectivenessResult | undefined;

  // ═══ STAGE 1B INPUT LINEAGE GUARD ═══
  if (!stageLineage.stage1A.committed) {
    nLog("[STAGE1B_FAIL_NO_FALLBACK_TO_1A]", {
      jobId: payload.jobId,
      reason: "stage1A_not_committed",
      stage1AOutput: stageLineage.stage1A.output,
    });
    throw new Error("Stage 1A output not committed before Stage 1B start");
  }
  stageLineage.stage1B.input = stageLineage.stage1A.output;
  logStageInput("1B", "1A", stageLineage.stage1A.output!);
  
  // ✅ STRICT PAYLOAD MODE — derive declutterMode if missing but declutter requested (safety net)
  let declutterMode: "light" | "stage-ready" | null = (payload.options as any).declutterMode || null;
  
  // ✅ PER-IMAGE ROUTING: Override for multi-room types (must have virtualStage enabled)
  const roomType = payload.options.roomType;
  const normalizedRoomType = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  const canonicalRoomType = normalizedRoomType === "multiple_living_areas" ? "multiple_living" : normalizedRoomType;
  const forceLightRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);

  // Furnished gate routing after Stage 1A
  // For stage2Only + interior, this gate must run regardless of declutter flag.
  // Order: local empty prefilter -> (if not empty) Gemini furnished confirmation.
  const hasVirtualStage = payload.options.virtualStage;
  const isInteriorScene = sceneLabel === "interior";
  const isStage2Only = hasVirtualStage && (payload.options as any).stage2Only === true;
  const shouldResolveFurnishedGate = hasVirtualStage && isInteriorScene;
  if (shouldResolveFurnishedGate) {
    let stage1BRan = false;
    let furnished = true;
    let gateDecision: "furnished_refresh" | "empty_full_stage" | "needs_declutter_light" = "needs_declutter_light";
    let gateReason = "fail_safe_default";
    let furnishedSource: "local_empty" | "gemini_confirmed" | "gemini_override" | "gemini_fail_closed" | "needs_declutter_light" = "gemini_fail_closed";
    let escalated = false;
    let localResult: "empty" | "not_empty" | "error" = "error";
    let geminiResult: "skipped_local_empty" | "furnished" | "not_furnished" | "needs_declutter_light" | "fail_closed" = "fail_closed";

    try {
      const stage1ABuffer = await fs.promises.readFile(path1A);
      const localEmpty = await isRoomEmpty(stage1ABuffer);
      nLog("[FURNISHED_GATE_LOCAL]", {
        jobId: payload.jobId,
        localEmpty,
        isStage2Only,
      });

      if (localEmpty) {
        localResult = "empty";
        furnished = false;
        gateDecision = "empty_full_stage";
        gateReason = "local_empty_prefilter";
        furnishedSource = "local_empty";
        geminiResult = "skipped_local_empty";
      } else {
        localResult = "not_empty";
        escalated = true;
        try {
          const ai = getGeminiClient();
          const furnishedAnalysis = await detectFurniture(ai as any, toBase64(path1A).data);
          const gate = resolveFurnishedGateDecision({
            analysis: furnishedAnalysis,
            localEmpty: false,
            roomType: canonicalRoomType,
          });
          gateDecision = gate.decision;
          gateReason = gate.reason;
          furnished = gate.decision === "furnished_refresh";
          furnishedSource = gate.decision === "furnished_refresh"
            ? "gemini_confirmed"
            : gate.decision === "empty_full_stage"
              ? "gemini_override"
              : "needs_declutter_light";
          geminiResult = gate.decision === "furnished_refresh"
            ? "furnished"
            : gate.decision === "empty_full_stage"
              ? "not_furnished"
              : "needs_declutter_light";
          nLog("[FURNISHED_GATE_GEMINI]", {
            jobId: payload.jobId,
            hasFurniture: furnishedAnalysis?.hasFurniture ?? false,
            anchors: furnishedAnalysis?.detectedAnchors || [],
            confidence: furnishedAnalysis?.confidence ?? 0,
            hasMovableSeating: furnishedAnalysis?.hasMovableSeating ?? false,
            hasCounterClutter: furnishedAnalysis?.hasCounterClutter ?? false,
            hasSurfaceClutter: furnishedAnalysis?.hasSurfaceClutter ?? false,
            hasLoosePortableItems: furnishedAnalysis?.hasLoosePortableItems ?? false,
            isStageReady: furnishedAnalysis?.isStageReady ?? false,
            gateDecision,
            gateReason,
          });
        } catch (geminiErr: any) {
          // Fail-safe declutter policy: if Gemini detection fails, run light declutter before staging.
          furnished = false;
          gateDecision = "needs_declutter_light";
          gateReason = "gemini_detector_error_fail_safe_light_declutter";
          furnishedSource = "gemini_fail_closed";
          geminiResult = "fail_closed";
          nLog("[FURNISHED_GATE_GEMINI_FAIL_CLOSED]", {
            jobId: payload.jobId,
            error: geminiErr?.message || String(geminiErr),
            gateDecision,
            gateReason,
          });
        }
      }
    } catch (localErr: any) {
      // If local prefilter fails, default to light declutter for safety.
      furnished = false;
      gateDecision = "needs_declutter_light";
      gateReason = "local_prefilter_error_fail_safe_light_declutter";
      furnishedSource = "gemini_fail_closed";
      escalated = false;
      localResult = "error";
      geminiResult = "fail_closed";
      nLog("[FURNISHED_GATE_LOCAL_FAIL_CLOSED]", {
        jobId: payload.jobId,
        error: localErr?.message || String(localErr),
        gateDecision,
        gateReason,
      });
    }

    stage1BRan = gateDecision !== "empty_full_stage";
    (payload.options as any).furnishedState = gateDecision === "furnished_refresh"
      ? "furnished"
      : gateDecision === "empty_full_stage"
        ? "empty"
        : "needs_declutter";
    (payload.options as any).stagingPreference = gateDecision === "empty_full_stage" ? "full" : "refresh";
    (payload.options as any).stage2Variant = gateDecision === "empty_full_stage" ? "2B" : "2A";

    if (gateDecision === "furnished_refresh") {
      payload.options.declutter = true;
      if (!(payload.options as any).declutterMode) {
        (payload.options as any).declutterMode = "stage-ready";
      }
      declutterMode = ((payload.options as any).declutterMode === "light" ? "light" : "stage-ready");
      nLog("[ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "1A->1B->2(refresh)",
        reason: `${furnishedSource}:${gateReason}`,
      });
    } else if (gateDecision === "needs_declutter_light") {
      payload.options.declutter = true;
      (payload.options as any).declutterMode = "light";
      declutterMode = "light";
      nLog("[ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "1A->1B(light)->2(refresh)",
        reason: `${furnishedSource}:${gateReason}`,
      });
    } else {
      payload.options.declutter = false;
      (payload.options as any).declutterMode = null;
      declutterMode = null;
      nLog("[ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "1A->2(full)",
        reason: `${furnishedSource}:${gateReason}`,
      });
    }

    try {
      await updateJob(payload.jobId, {
        meta: {
          ...(sceneLabel ? { ...sceneMeta } : {}),
          furnishedGateResolved: true,
          furnishedGate: {
            enabled: true,
            furnished,
            source: furnishedSource,
            escalated,
            stage1BRan,
            hasVirtualStage,
            isStage2Only,
            gateDecision,
            gateReason,
          },
        },
      });
    } catch (metaErr: any) {
      nLog("[WORKER] Furnished gate metadata update failed (non-blocking)", {
        jobId: payload.jobId,
        error: metaErr?.message || String(metaErr),
      });
    }

    nLog("[FURNISHED_GATE_TELEMETRY]", {
      jobId: payload.jobId,
      imageId: payload.imageId,
      localResult,
      geminiEscalated: escalated,
      geminiResult,
      stage1BRan,
      furnished,
      source: furnishedSource,
      gateDecision,
      gateReason,
      isStage2Only,
    });
  }
  
  if (payload.options.declutter && payload.options.virtualStage && forceLightRoomTypes.has(canonicalRoomType)) {
    declutterMode = "light"; // Override to light for multi-room types
    nLog(`[WORKER] 🔄 Multi-room type detected: ${canonicalRoomType} - forcing declutterMode=light for refresh staging`);
  } else if (!declutterMode && payload.options.declutter) {
    declutterMode = payload.options.virtualStage ? "stage-ready" : "light";
    nLog(`[WORKER] ⚠️ declutterMode missing in payload — derived from flags: ${declutterMode} (declutter=${payload.options.declutter}, virtualStage=${payload.options.virtualStage})`);
  }

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
      await safeWriteJobStatus(
        payload.jobId,
        {
          status: "failed",
          errorMessage: errMsg,
          error: errMsg,
          meta: { ...sceneMeta },
        },
        "invalid_declutter_mode"
      );
      throw new Error(errMsg);
    }

    nLog(`[WORKER] ✅ Stage 1B ENABLED - mode: ${declutterMode}`);
    nLog(`[WORKER] Mode explanation: ${declutterMode === "light" ? "Light declutter (remove clutter, preserve furniture)" : "Structured retain declutter (preserve anchors, remove secondary items)"}`);
    nLog(`[WORKER] virtualStage setting: ${payload.options.virtualStage}`);
    
    // 📊 STRUCTURED ROUTING LOG
    nLog(`[PIPELINE_ROUTING] Image routing decision:`, {
      roomType: canonicalRoomType,
      isMultiRoom: forceLightRoomTypes.has(canonicalRoomType),
      declutterMode,
      virtualStage: payload.options.virtualStage,
      expectedStage2Mode: payload.options.virtualStage ? "refresh" : "none"
    });

      const runStage1BWithValidation = async (mode: "light" | "stage-ready", attempt: number) => {
      const attemptIndex = Math.max(0, attempt - 1);
      const output = await runStage1B(path1A, {
        replaceSky: false,
        sceneType: sceneLabel,
        roomType: payload.options.roomType,
        declutterMode: mode,
        jobId: payload.jobId,
        attempt: attemptIndex,
        canonicalPath: jobContext.canonicalPath,
        baseArtifacts: jobContext.baseArtifacts,
        curtainRailLikely: jobContext.curtainRailLikely,
        jobDeclutterIntensity: jobContext.jobDeclutterIntensity,
        jobSampling: jobContext.jobSampling,
      });
      if (attemptIndex > 0) {
        nLog(`[RETRY_OUTPUT] stage=1B attempt=${attemptIndex} path=${output}`);
      }
      const baseArtifacts = stageLineage.baseArtifacts;

      nLog(`[VALIDATOR_INPUT] stage=1B attempt=${attemptIndex} using=${output}`);

      // ═══ Phase H: Stage output consistency check ═══
      const stage1BOutputCheck = checkStageOutput(output, "1B", payload.jobId);
      if (!stage1BOutputCheck.readable) {
        nLog(`[worker] Stage output missing/unreadable before validation — marking failed`, { jobId: payload.jobId, stage: "1B", path: output });
        throw new Error("missing_stage_output");
      }

      const verdict = await runUnifiedValidation({
        originalPath: path1A,
        enhancedPath: output,
        stage: "1B",
        sceneType: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        roomType: payload.options.roomType,
        mode: VALIDATION_BLOCKING_ENABLED ? "enforce" : "log",
        geminiPolicy: VALIDATION_BLOCKING_ENABLED ? "never" : "on_local_fail",
        jobId: payload.jobId,
        stage1APath: path1A,
        stage1BValidationMode: mode === "stage-ready" ? "STRUCTURED_RETAIN" : "LIGHT_DECLUTTER",
        baseArtifacts,
      });

      const rawResults = verdict?.raw ? Object.values(verdict.raw) : [];
      const anyFailed = rawResults.some((r) => r && r.passed === false);
      const advisoryReasons = (verdict.reasons && verdict.reasons.length)
        ? verdict.reasons
        : (verdict.warnings && verdict.warnings.length)
          ? verdict.warnings
          : [];
      const localIssues = anyFailed || advisoryReasons.length > 0 || verdict.hardFail;
      const needsConfirm = GEMINI_CONFIRMATION_ENABLED ? localIssues : false;
      if (localIssues) {
        const msg = advisoryReasons.length ? advisoryReasons.join("; ") : "Stage 1B structural validation flagged issues";
        logIfNotFocusMode(`[stage1B][attempt=${attempt}] validation advisory: ${msg}`);
      }

      return { output, verdict, needsConfirm, advisoryReasons, localIssues };
    };

    let stage1BAttempts = 0;
    const maxAttempts = STAGE1B_MAX_ATTEMPTS;
    let useLightFallback = false;
    let lastError: string | undefined;
    let stage1BNeedsConfirm = false;
    let stage1BLocalReasons: string[] = [];
    let stage1BLocalIssues = false;
    let stage1BLastVerdict: UnifiedValidationResult | undefined;
    stage1BDeclutterReasons = [];
    stage1BDeclutterResult = undefined;

    while (true) {
      if (Date.now() - t1B > MAX_STAGE_RUNTIME_MS) {
        console.log(`[timeout] stage=1B exceeded_ms=${Date.now() - t1B} jobId=${payload.jobId}`);
        // ═══ FINAL STATUS GUARD ═══
        const latestJob = await getJob(payload.jobId);
        if (isTerminalStatus(latestJob?.status)) {
          nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B timeout fallback`, {
            jobId: payload.jobId,
            stage: "1B",
            status: latestJob?.status
          });
          return;
        }

        const reason = "stage1b_runtime_exceeded";
        await completePartialJob({
          jobId: payload.jobId,
          triggerStage: "1B",
          finalStage: "1A",
          finalPath: path1A,
          pub1AUrl,
          pub1BUrl,
          sceneMeta,
          userMessage: "We enhanced your image but could not safely declutter it.",
          reason,
          stageOutputs: { "1A": path1A },
        });
        return;
      }
      stage1BAttempts += 1;
      const currentMode: "light" | "stage-ready" = useLightFallback ? "light" : declutterMode as any;
      logIfNotFocusMode(`[stage1B] Attempt ${stage1BAttempts}/${useLightFallback ? 1 : maxAttempts} mode=${currentMode}`);
      try {
        const { output, verdict, needsConfirm, advisoryReasons, localIssues } = await runStage1BWithValidation(currentMode, stage1BAttempts);
        if (output === path1A) {
          nLog("[STAGE1B_OUTPUT_MATCHES_1A]", {
            jobId: payload.jobId,
            attempt: stage1BAttempts,
            mode: currentMode,
          });
          throw new Error("Stage 1B output matched Stage 1A");
        }
        path1B = output;
        stage1BStructuralSafe = !localIssues;
        stage1BNeedsConfirm = needsConfirm;
        stage1BLocalReasons = advisoryReasons;
        stage1BLocalIssues = localIssues;
        stage1BLastVerdict = verdict;

        const verdictBlockFromLocal = verdict?.hardFail && verdict?.blockSource === "local" && VALIDATION_BLOCKING_ENABLED;
        const verdictBlockFromGemini = verdict?.hardFail && verdict?.blockSource === "gemini" && geminiBlockingEnabled;
        if (verdictBlockFromLocal || verdictBlockFromGemini) {
          const reason = advisoryReasons.length ? advisoryReasons.join("; ") : "Stage 1B blocked by structural validation";
          const attemptsLeft = maxAttempts - stage1BAttempts;
          logIfNotFocusMode(`[stage1B] HARD FAIL detected (source=${verdict?.blockSource}). Reason: ${reason}. Attempts left: ${attemptsLeft}`);
          if (attemptsLeft > 0) {
            // Retry Stage 1B using last good (Stage1A) baseline
            nLog("[RETRY_STATUS_WRITE]", {
              jobId: payload.jobId,
              stage: "1B",
              reason: verdict?.blockSource,
              attempt: stage1BAttempts + 1,
            });
            await safeWriteJobStatus(
              payload.jobId,
              {
                status: "processing",
                retryingStage: "1B",
                retryAttempt: stage1BAttempts + 1,
                message: `Retrying Stage 1B (attempt ${stage1BAttempts + 1}/${maxAttempts})...`,
                retryMeta: buildRetryMeta(payload.jobId, {
                  attempt: stage1BAttempts + 1,
                  reason: `hard_fail:${verdict?.blockSource ?? "unknown"}`,
                  stage: "1B",
                }),
              },
              "stage1b_retry_scheduled"
            );
            continue;
          }
          // All retries exhausted — try light declutter fallback before giving up
          if (!useLightFallback && declutterMode === "stage-ready") {
            useLightFallback = true;
            stage1BAttempts = 0;
            logIfNotFocusMode(`[stage1B] Switching to light declutter fallback after ${maxAttempts} hard-fail attempt(s) (source=${verdict?.blockSource}) in stage-ready mode`);
            nLog("[RETRY_STATUS_WRITE]", {
              jobId: payload.jobId,
              stage: "1B",
              mode: "light_fallback",
            });
            await safeWriteJobStatus(
              payload.jobId,
              {
                status: "processing",
                retryingStage: "1B",
                retryAttempt: 1,
                message: "Switching to light declutter mode...",
              },
              "stage1b_light_fallback"
            );
            continue;
          }
          // Light fallback already tried or not stage-ready — fail permanently
          // ═══ FINAL STATUS GUARD ═══
          const latestJob = await getJob(payload.jobId);
          if (isTerminalStatus(latestJob?.status)) {
            nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B hard-fail fallback`, {
              jobId: payload.jobId,
              stage: "1B",
              status: latestJob?.status
            });
            return;
          }

          await completePartialJob({
            jobId: payload.jobId,
            triggerStage: "1B",
            finalStage: "1A",
            finalPath: path1A,
            pub1AUrl,
            pub1BUrl,
            sceneMeta: { ...sceneMeta, stage1BAttempts, stage1BLocalReasons, unifiedValidation: verdict },
            userMessage: "We enhanced your image but could not safely declutter it.",
            reason: "stage1b_retries_exhausted",
            stageOutputs: { "1A": path1A },
          });
          return;
        }
        if (localIssues && VALIDATION_BLOCKING_ENABLED) {
          const msg = advisoryReasons.length ? advisoryReasons.join("; ") : "stage1B validation blocked";
          logIfNotFocusMode(`[stage1B] local block failure: ${msg}`);
          const exhausted = useLightFallback || stage1BAttempts >= maxAttempts;
          if (!exhausted && !useLightFallback) {
            logIfNotFocusMode(`[stage1B] retrying after local block failure (${stage1BAttempts}/${maxAttempts})`);
            nLog("[RETRY_STATUS_WRITE]", {
              jobId: payload.jobId,
              stage: "1B",
              reason: "local_block",
              attempt: stage1BAttempts + 1,
            });
            await safeWriteJobStatus(
              payload.jobId,
              {
                status: "processing",
                retryingStage: "1B",
                retryAttempt: stage1BAttempts + 1,
                message: `Retrying Stage 1B after local validation block (attempt ${stage1BAttempts + 1}/${maxAttempts})...`,
                retryMeta: buildRetryMeta(payload.jobId, {
                  attempt: stage1BAttempts + 1,
                  reason: "local_block",
                  stage: "1B",
                }),
              },
              "stage1b_localblock_retry"
            );
            continue;
          }
          if (exhausted && !useLightFallback && declutterMode === "stage-ready") {
            useLightFallback = true;
            stage1BAttempts = 0;
            logIfNotFocusMode(`[stage1B] Switching to light declutter fallback after local block failures in stage-ready mode`);
            nLog("[RETRY_STATUS_WRITE]", {
              jobId: payload.jobId,
              stage: "1B",
              mode: "light_fallback_localblock",
            });
            await safeWriteJobStatus(
              payload.jobId,
              {
                status: "processing",
                retryingStage: "1B",
                retryAttempt: 1,
                message: "Switching to light declutter after local validation blocks...",
              },
              "stage1b_localblock_light_fallback"
            );
            continue;
          }
          // ═══ FINAL STATUS GUARD ═══
          const latestJob = await getJob(payload.jobId);
          if (isTerminalStatus(latestJob?.status)) {
            nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B local-block fallback`, {
              jobId: payload.jobId,
              stage: "1B",
              status: latestJob?.status
            });
            return;
          }

          await completePartialJob({
            jobId: payload.jobId,
            triggerStage: "1B",
            finalStage: "1A",
            finalPath: path1A,
            pub1AUrl,
            pub1BUrl,
            sceneMeta: { ...sceneMeta, stage1BAttempts, stage1BLocalReasons },
            userMessage: "We enhanced your image but could not safely declutter it.",
            reason: "stage1b_local_block_exhausted",
            stageOutputs: { "1A": path1A },
          });
          return;
        }

        if (STAGE1B_DECLUTTER_EFFECTIVENESS_ENABLED) {
          const declutterResult = await runStage1BDeclutterEffectivenessValidator({
            basePath: path1A,
            candidatePath: output,
            roomType: payload.options.roomType,
            sceneType: sceneLabel,
            jobId: payload.jobId,
          });
          stage1BDeclutterResult = declutterResult;
          stage1BDeclutterReasons = declutterResult.blockReasons;

          nLog("[STAGE1B_DECLUTTER_EFFECTIVENESS]", {
            jobId: payload.jobId,
            attempt: stage1BAttempts,
            blocked: declutterResult.blocked,
            confidenceEligible: declutterResult.confidenceEligible,
            metrics: declutterResult.metrics,
            blockReasons: declutterResult.blockReasons,
          });

          if (declutterResult.blocked && VALIDATION_BLOCKING_ENABLED) {
            const declutterReason = declutterResult.blockReasons.join("; ") || "stage1B declutter effectiveness blocked";
            const exhausted = useLightFallback || stage1BAttempts >= maxAttempts;
            logIfNotFocusMode(`[stage1B] declutter effectiveness block failure: ${declutterReason}`);

            if (!exhausted && !useLightFallback) {
              nLog("[RETRY_STATUS_WRITE]", {
                jobId: payload.jobId,
                stage: "1B",
                reason: "declutter_effectiveness_block",
                attempt: stage1BAttempts + 1,
              });
              await safeWriteJobStatus(
                payload.jobId,
                {
                  status: "processing",
                  retryingStage: "1B",
                  retryAttempt: stage1BAttempts + 1,
                  message: `Retrying Stage 1B after declutter effectiveness block (attempt ${stage1BAttempts + 1}/${maxAttempts})...`,
                  retryMeta: buildRetryMeta(payload.jobId, {
                    attempt: stage1BAttempts + 1,
                    reason: "declutter_effectiveness_block",
                    stage: "1B",
                  }),
                },
                "stage1b_declutter_block_retry"
              );
              continue;
            }

            if (exhausted && !useLightFallback && declutterMode === "stage-ready") {
              useLightFallback = true;
              stage1BAttempts = 0;
              logIfNotFocusMode(`[stage1B] Switching to light declutter fallback after declutter effectiveness blocks in stage-ready mode`);
              nLog("[RETRY_STATUS_WRITE]", {
                jobId: payload.jobId,
                stage: "1B",
                mode: "light_fallback_declutter_block",
              });
              await safeWriteJobStatus(
                payload.jobId,
                {
                  status: "processing",
                  retryingStage: "1B",
                  retryAttempt: 1,
                  message: "Switching to light declutter after declutter effectiveness blocks...",
                },
                "stage1b_declutter_block_light_fallback"
              );
              continue;
            }

            const latestJob = await getJob(payload.jobId);
            if (isTerminalStatus(latestJob?.status)) {
              nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B declutter-block fallback`, {
                jobId: payload.jobId,
                stage: "1B",
                status: latestJob?.status
              });
              return;
            }

            await completePartialJob({
              jobId: payload.jobId,
              triggerStage: "1B",
              finalStage: "1A",
              finalPath: path1A,
              pub1AUrl,
              pub1BUrl,
              sceneMeta: {
                ...sceneMeta,
                stage1BAttempts,
                stage1BLocalReasons,
                stage1BDeclutterResult,
              },
              userMessage: "We enhanced your image but could not safely declutter it.",
              reason: "stage1b_declutter_block_exhausted",
              stageOutputs: { "1A": path1A },
            });
            return;
          }
        }
        break;
      } catch (err: any) {
        lastError = err?.message || String(err);
        logIfNotFocusMode(`[stage1B] attempt ${stage1BAttempts} failed: ${lastError}`);
        const exhausted = useLightFallback || stage1BAttempts >= maxAttempts;
        if (exhausted && !useLightFallback && declutterMode === "stage-ready") {
          // Switch to light declutter fallback for one attempt
          useLightFallback = true;
          stage1BAttempts = 0;
          logIfNotFocusMode(`[stage1B] Switching to light declutter fallback after failures in stage-ready mode`);
          nLog("[RETRY_STATUS_WRITE]", {
            jobId: payload.jobId,
            stage: "1B",
            mode: "light_fallback_error",
          });
          await safeWriteJobStatus(
            payload.jobId,
            {
              status: "processing",
              retryingStage: "1B",
              retryAttempt: 1,
              message: "Switching to light declutter after errors...",
            },
            "stage1b_error_light_fallback"
          );
          continue;
        }
        if (exhausted) {
          // ═══ FINAL STATUS GUARD ═══
          const latestJob = await getJob(payload.jobId);
          if (isTerminalStatus(latestJob?.status)) {
            nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B error-exhausted fallback`, {
              jobId: payload.jobId,
              stage: "1B",
              status: latestJob?.status
            });
            return;
          }

          await completePartialJob({
            jobId: payload.jobId,
            triggerStage: "1B",
            finalStage: "1A",
            finalPath: path1A,
            pub1AUrl,
            pub1BUrl,
            sceneMeta: { ...sceneMeta, stage1BAttempts },
            userMessage: "We enhanced your image but could not safely declutter it.",
            reason: "stage1b_error_exhausted",
            stageOutputs: { "1A": path1A },
          });
          return;
        }
        // Implicit retry - not exhausted, will continue loop
        nLog("[RETRY_STATUS_WRITE]", {
          jobId: payload.jobId,
          stage: "1B",
          reason: "error",
          attempt: stage1BAttempts + 1,
        });
        await safeWriteJobStatus(
          payload.jobId,
          {
            status: "processing",
            retryingStage: "1B",
            retryAttempt: stage1BAttempts + 1,
            message: `Retrying Stage 1B after error (attempt ${stage1BAttempts + 1}/${maxAttempts})...`,
            retryMeta: buildRetryMeta(payload.jobId, {
              attempt: stage1BAttempts + 1,
              reason: "stage1b_error",
              stage: "1B",
            }),
          },
          "stage1b_error_retry"
        );
      }
    }

    // Commit Stage 1B output after successful completion
    if (path1B) {
      commitStageOutput("1B", path1B);
      // Record the actual mode used for Stage 1B (for Stage 2 routing)
      const finalMode = useLightFallback ? "light" : declutterMode;
      (sceneMeta as any).stage1BMode = finalMode;
      nLog(`[WORKER] ✅ Recorded stage1BMode in metadata: ${finalMode}`);
    }

    const stage1BLocalStatus = stage1BStructuralSafe
      ? "pass"
      : (VALIDATION_BLOCKING_ENABLED ? "fail" : "needs_confirm");
    nLog(`[LOCAL_VALIDATE] stage=1B status=${stage1BLocalStatus} reasons=${JSON.stringify(stage1BLocalReasons)}`);
    if (stage1BDeclutterResult) {
      nLog(`[DECLUTTER_VALIDATE] stage=1B status=${stage1BDeclutterResult.blocked ? "fail" : "pass"} reasons=${JSON.stringify(stage1BDeclutterReasons)}`);
    }

    // Gemini confirmation layer for Stage1B (only when local mode requires confirm)
    // Includes retry loop: if Gemini blocks, re-run Stage 1B with reduced sampling params
    if (GEMINI_CONFIRMATION_ENABLED && stage1BNeedsConfirm && path1B) {
      const { confirmWithGeminiStructure } = await import("./validators/confirmWithGeminiStructure.js");
      let geminiRetries = 0;
      const geminiMaxRetries = GEMINI_CONFIRM_MAX_RETRIES;
      let geminiRetryTemp = 0.30; // Stage 1B base temperature
      let geminiRetryTopP = 0.70;
      let geminiRetryTopK = 32;
      let lastGeminiConfirm: any = null;
      let geminiRetryPassed = false;
      const stage1BRetryMode: "light" | "stage-ready" = useLightFallback ? "light" : declutterMode as "light" | "stage-ready";

      // Gate evidence injection based on threshold
      const gatedEvidence = shouldInjectEvidence(stage1BLastVerdict?.evidence)
        ? stage1BLastVerdict?.evidence
        : undefined;
      const injectionStatus = gatedEvidence ? "injected" : "suppressed";
      nLog(`[VALIDATION_EVIDENCE_GATE] stage=1B injected=${!!gatedEvidence} reason=${injectionStatus}`);

      // Initial Gemini confirmation check
      let confirm = await confirmWithGeminiStructure({
        baselinePathOrUrl: path1A,
        candidatePathOrUrl: path1B,
        stage: "stage1b",
        roomType: payload.options.roomType,
        sceneType: sceneLabel as any,
        jobId: payload.jobId,
        localReasons: stage1BLocalReasons,
        evidence: gatedEvidence,
        riskLevel: stage1BLastVerdict?.riskLevel,
      });
      nLog(`[GEMINI_CONFIRM] stage=1B status=${confirm.status} confirmedFail=${confirm.confirmedFail} reasons=${JSON.stringify(confirm.reasons)}`);
      lastGeminiConfirm = confirm;

      // Retry loop: if Gemini blocks and blocking is enabled, re-run Stage 1B with reduced params
      while (confirm.confirmedFail && geminiBlockingEnabled && geminiRetries < geminiMaxRetries) {
        geminiRetries++;
        // Reduce sampling parameters by 10% per retry (multiplicative)
        geminiRetryTemp = Math.max(0.05, geminiRetryTemp * 0.9);
        geminiRetryTopP = Math.max(0.3, geminiRetryTopP * 0.9);
        geminiRetryTopK = Math.max(10, Math.round(geminiRetryTopK * 0.9));

        const retryReasons = confirm.reasons.join("; ") || "Gemini confirmation block";
        nLog(`[GEMINI_RETRY] stage=1B attempt=${geminiRetries}/${geminiMaxRetries} reason=gemini_block temp=${geminiRetryTemp.toFixed(3)} topP=${geminiRetryTopP.toFixed(3)} topK=${geminiRetryTopK}`);
        const retryStatus = await getJob(payload.jobId);
        if (isTerminalStatus(retryStatus?.status) || await isJobFailedFinal(payload.jobId)) {
          nLog("[RETRY_BLOCKED_TERMINAL]", { jobId: payload.jobId, stage: "1B" });
          return;
        }
        await safeWriteJobStatus(
          payload.jobId,
          {
            status: "processing",
            message: `Stage 1B blocked by Gemini. Retrying with stricter settings (attempt ${geminiRetries + 1}/${geminiMaxRetries + 1})...`,
            meta: {
              ...sceneMeta,
              stage1BAttempts,
              geminiRetry: true,
              geminiRetryAttempt: geminiRetries,
              geminiRetryMaxAttempts: geminiMaxRetries,
              retryReason: "gemini_block",
              blockedBy: "gemini",
              blockedStage: "stage1b",
            },
          },
          "stage1b_gemini_retry"
        );

        try {
          // Re-run Stage 1B with reduced sampling parameters
          const retryPath1B = await runStage1B(path1A, {
            replaceSky: false,
            sceneType: sceneLabel,
            roomType: payload.options.roomType,
            declutterMode: stage1BRetryMode,
            jobId: payload.jobId,
            attempt: geminiRetries,
            canonicalPath: jobContext.canonicalPath,
            baseArtifacts: jobContext.baseArtifacts,
            curtainRailLikely: jobContext.curtainRailLikely,
            jobDeclutterIntensity: jobContext.jobDeclutterIntensity,
            jobSampling: jobContext.jobSampling,
          });
          if (retryPath1B === path1A) {
            nLog("[STAGE1B_RETRY_OUTPUT_MATCHES_1A]", {
              jobId: payload.jobId,
              attempt: geminiRetries,
            });
            throw new Error("Stage 1B retry output matched Stage 1A");
          }
          nLog(`[RETRY_OUTPUT] stage=1B attempt=${geminiRetries} path=${retryPath1B}`);
          nLog(`[GEMINI_RETRY] stage=1B attempt=${geminiRetries} re-ran Stage 1B: ${retryPath1B}`);

          nLog(`[VALIDATOR_INPUT] stage=1B attempt=${geminiRetries} using=${retryPath1B}`);

          // Re-validate with Gemini Confirmation
          confirm = await confirmWithGeminiStructure({
            baselinePathOrUrl: path1A,
            candidatePathOrUrl: retryPath1B,
            stage: "stage1b",
            roomType: payload.options.roomType,
            sceneType: sceneLabel as any,
            jobId: payload.jobId,
            localReasons: stage1BLocalReasons,
            evidence: stage1BLastVerdict?.evidence,
            riskLevel: stage1BLastVerdict?.riskLevel,
          });
          nLog(`[GEMINI_CONFIRM] stage=1B retry=${geminiRetries} status=${confirm.status} confirmedFail=${confirm.confirmedFail} reasons=${JSON.stringify(confirm.reasons)}`);
          lastGeminiConfirm = confirm;

          if (!confirm.confirmedFail) {
            // ═══ FINAL STATUS GUARD ═══
            const latestJob = await getJob(payload.jobId);
            if (isTerminalStatus(latestJob?.status)) {
              nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B Gemini retry publish`, {
                jobId: payload.jobId,
                stage: "1B",
                attempt: geminiRetries,
                status: latestJob?.status
              });
              return;
            }

            // Retry passed — adopt the retried output and continue pipeline
            path1B = retryPath1B;
            commitStageOutput("1B", retryPath1B);
            geminiRetryPassed = true;
            nLog(`[GEMINI_RETRY] stage=1B attempt=${geminiRetries} PASSED ✅ — continuing pipeline`);
            break;
          }
        } catch (retryErr: any) {
          nLog(`[GEMINI_RETRY] stage=1B attempt=${geminiRetries} error: ${retryErr?.message || retryErr}`);
          // Continue to next retry or exhaust
        }
      }

      if (lastGeminiConfirm?.confirmedFail && geminiBlockingEnabled && !geminiRetryPassed) {
        // ═══ FINAL STATUS GUARD ═══
        const latestJob = await getJob(payload.jobId);
        if (isTerminalStatus(latestJob?.status)) {
          nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B fallback publish`, {
            jobId: payload.jobId,
            stage: "1B",
            attempt: geminiRetries,
            status: latestJob?.status
          });
          return;
        }

        // All retries exhausted — hard fail but publish last known good image (Stage 1A)
        const errMsg = lastGeminiConfirm.reasons.join("; ") || "Stage1B blocked by Gemini confirmation";
        nLog(`[VALIDATE_FINAL] stage=1B decision=block blockedBy=gemini_confirm override=false retries_exhausted=true (publishing Stage 1A as fallback)`);
        nLog(`[GEMINI_RETRY] stage=1B EXHAUSTED after ${geminiRetries} retries — falling back to Stage 1A`);

        // Publish Stage 1A as last known good image
        let fallbackUrl = pub1AUrl;
        if (!fallbackUrl) {
          try {
            const pubFallback = await publishWithOptionalBlackEdgeGuard(path1A, "fallback-1A");
            fallbackUrl = pubFallback.url;
          } catch (pubErr) {
            nLog(`[GEMINI_RETRY] Failed to publish Stage 1A fallback: ${pubErr}`);
          }
        }

        await completePartialJob({
          jobId: payload.jobId,
          triggerStage: "1B",
          finalStage: "1A",
          finalPath: path1A,
          pub1AUrl: fallbackUrl || pub1AUrl,
          pub1BUrl,
          sceneMeta: {
            ...sceneMeta,
            stage1BAttempts,
            stage1BLocalReasons,
            geminiConfirm: lastGeminiConfirm,
            blockedBy: "gemini",
            blockedStage: "stage1b",
            attemptCount: geminiRetries + 1,
            retryReason: "gemini_block",
            fallbackStage: "1A",
            fallbackUrl: fallbackUrl || null,
          },
          userMessage: "We enhanced your image but could not safely declutter it.",
          reason: "stage1b_gemini_exhausted",
          stageOutputs: { "1A": path1A },
        });
        return;
      }

      updateJob(payload.jobId, {
        meta: {
          ...sceneMeta,
          stage1BAttempts,
          stage1BLocalReasons,
          geminiConfirm: { ...lastGeminiConfirm, override: !lastGeminiConfirm.confirmedFail },
          ...(geminiRetries > 0 ? {
            blockedBy: "gemini",
            blockedStage: "stage1b",
            attemptCount: geminiRetries + 1,
            retryReason: "gemini_block",
          } : {}),
        }
      });
      nLog(`[VALIDATE_FINAL] stage=1B decision=accept blockedBy=${lastGeminiConfirm.confirmedFail && geminiBlockingEnabled ? "gemini_confirm" : "none"} override=${lastGeminiConfirm.confirmedFail ? !geminiBlockingEnabled : true} retries=${geminiRetries}`);
    } else {
      nLog(`[VALIDATE_FINAL] stage=1B decision=accept blockedBy=none override=${!stage1BNeedsConfirm}`);
    }

    timings.stage1BMs = Date.now() - t1B;
    timestamps.stage1BEnd = Date.now(); // FIX 6: Track Stage 1B completion
    
    // Track memory after Stage 1B
    updatePeakMemory(payload.jobId);
    if (isMemoryCritical()) {
      nLog(`[MEMORY] WARNING: Memory usage critical after Stage 1B - forcing garbage collection`);
      forceGC();
    }
    
    // ✅ FIX 3: Add updatedAt timestamp for stuck detection
    const now1B = new Date().toISOString();
    await safeWriteJobStatus(
      payload.jobId,
      {
        status: "processing",
        currentStage: "1B",
        progress: 60,
        stageUrls: { "1A": pub1AUrl ?? null, "1B": pub1BUrl ?? null },
        updatedAt: now1B,
        updated_at: now1B,
      },
      "stage1b_progress"
    );
    if (await isCancelled(payload.jobId)) {
      await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
      return;
    }
  }

  // Record Stage 1B publish if it exists and is different from 1A
  // pub1BUrl already declared above; removed duplicate
  if (path1B && path1B !== path1A) {
    // ═══ FINAL STATUS GUARD ═══
    const latestJob = await getJob(payload.jobId);
    if (isTerminalStatus(latestJob?.status)) {
      nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B main publish`, {
        jobId: payload.jobId,
        stage: "1B",
        status: latestJob?.status
      });
      return;
    }

    try {
      const pub1B = await publishWithOptionalBlackEdgeGuard(path1B, "1B");
      pub1BUrl = pub1B.url;
      await safeWriteJobStatus(
        payload.jobId,
        { status: "processing", currentStage: payload.options.declutter ? "1B" : "1A", stage: payload.options.declutter ? "1B" : "1A", progress: 55, stageUrls: { "1B": pub1BUrl }, imageUrl: pub1BUrl },
        "stage1b_publish"
      );
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
    await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
    return;
  }

  if (payload.options.virtualStage && payload.options.declutter && path1B && sceneLabel === "interior") {
    try {
      const ai = getGeminiClient();
      if (ai) {
        const beforeAnalysis = await detectFurniture(ai as any, toBase64(path1A).data);
        const afterAnalysis = await detectFurniture(ai as any, toBase64(path1B).data);
        const beforeAnchors = getAnchorClassSet(beforeAnalysis);
        const afterAnchors = getAnchorClassSet(afterAnalysis);
        const newAnchors = Array.from(afterAnchors).filter((anchor) => !beforeAnchors.has(anchor));

        nLog("[STAGE1B_ANCHOR_DELTA]", {
          jobId: payload.jobId,
          before: Array.from(beforeAnchors),
          after: Array.from(afterAnchors),
          newAnchors,
        });

        if (newAnchors.length > 0) {
          payload.options.virtualStage = false;
          payload.options.declutter = false;
          (payload.options as any).declutterMode = null;
          (payload.options as any).stage2SkipReason = "stage1b_new_anchor_detected";

          nLog("[ROUTING_DECISION]", {
            jobId: payload.jobId,
            path: "1A(final)",
            reason: "stage1b_new_anchor_detected",
            newAnchors,
          });
        }
      }
    } catch (anchorDeltaErr: any) {
      nLog("[WORKER] Stage1B anchor delta safeguard failed (non-blocking)", {
        jobId: payload.jobId,
        error: anchorDeltaErr?.message || String(anchorDeltaErr),
      });
    }
  }

  // STAGE 2 (optional virtual staging via Gemini)
  const t2 = Date.now();
  const profileId = (payload as any)?.options?.stagingProfileId as string | undefined;
  const profile = profileId ? getStagingProfile(profileId) : undefined;
  const angleHint = (payload as any)?.options?.angleHint as any; // "primary" | "secondary" | "other"
  if (!stage2Requested && payload.options.virtualStage) {
    nLog(`[WORKER] Stage 2 was not requested; skipping virtualStage despite payload.options.virtualStage=true`);
    payload.options.virtualStage = false;
    updateJob(payload.jobId, {
      warnings: ["Stage 2 output suppressed (not requested)."],
      meta: { ...(sceneLabel ? { ...sceneMeta } : {}), stage2Skipped: true, stage2SkipReason: "not_requested" }
    });
  }
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
  const exteriorNoStaging = sceneLabel === "exterior" && !allowStaging;
  const stage2Active = payload.options.virtualStage && !stage2Blocked && !exteriorNoStaging;
  if (stage2Active && payload.options.stage2Only === true) {
    const currentJob = await getJob(payload.jobId);
    const furnishedGateResolved = !!(currentJob as any)?.meta?.furnishedGateResolved;
    if (!furnishedGateResolved) {
      throw new Error("Stage 2 invoked without furnished gate resolution");
    }
  }
  // Stage 2 input selection:
  // - Interior: use Stage 1B (decluttered) if declutter enabled; else Stage 1A
  // - Exterior: always use Stage 1A
  const isExteriorScene = sceneLabel === "exterior";
  const retrySourceStageRaw = String((payload as any).retrySourceStage || "").toLowerCase();
  const retryStage1BWasRequested = Boolean((payload as any).retryStage1BWasRequested);
  const isStage2Retry = (payload as any).retryType === "manual_retry"
    && (retrySourceStageRaw === "stage2" || retrySourceStageRaw === "2" || retrySourceStageRaw === "1b-stage-ready");
  const declutterRequested = !!payload.options.declutter;
  const stage1BRequested = declutterRequested || !!payload.stage2OnlyMode?.enabled || isStage2Retry;
  const lineage1A = stageLineage.stage1A?.output;
  const lineage1B = stageLineage.stage1B?.output;
  const hasStage1BOutput = !!lineage1B;

  // CONTRACT: Stage2 must prefer Stage1B lineage over request flags.
  // - If Stage1B output exists, Stage2 must use it.
  // - Request flags must not force Stage1A while Stage1B lineage exists.
  // - Retries may use Stage1A only when Stage1B is truly unavailable and fallback is explicitly allowed.
  const resolveStage2Source = (ctx: {
    stage1BRequested: boolean;
    allowStage1AFallback: boolean;
    stage1BOutputPath?: string | null;
    stage1AOutputPath?: string | null;
  }) => {
    // Source-of-truth routing: if Stage 1B output exists, Stage 2 must use it.
    if (ctx.stage1BOutputPath) {
      return ctx.stage1BOutputPath;
    }
    if (ctx.stage1BRequested) {
      if (ctx.allowStage1AFallback && ctx.stage1AOutputPath) {
        nLog("[stage2-retry] Stage1B baseline missing, falling back to Stage1A", {
          jobId: payload.jobId,
          stage1APath: ctx.stage1AOutputPath,
        });
        return ctx.stage1AOutputPath;
      }
      throw new Error("Stage 2 blocked: Stage 1B requested but no Stage 1B output available");
    }
    return ctx.stage1AOutputPath;
  };

  let stage2InputPath: string | undefined;
  try {
    const allowStage1AFallback = (isStage2Retry || !!payload.stage2OnlyMode?.enabled) && !retryStage1BWasRequested;
    if (!allowStage1AFallback && stage1BRequested && !lineage1B) {
      nLog("[stage2-retry] Stage1B required by retry context; Stage1A fallback disabled", {
        jobId: payload.jobId,
        retryStage1BWasRequested,
      });
    }
    stage2InputPath = resolveStage2Source({
      stage1BRequested,
      allowStage1AFallback,
      stage1BOutputPath: lineage1B,
      stage1AOutputPath: lineage1A,
    }) || undefined;
  } catch (err) {
    stage2Blocked = true;
    stage2BlockedReason = "missing_stage1b_source";
    nLog("[STAGE2_BLOCKED_NO_1B]", {
      jobId: payload.jobId,
      declutterRequested: stage1BRequested,
    });
  }

  if (stage2InputPath) {
    nLog("[STAGE2_SOURCE_LOCK]", {
      jobId: payload.jobId,
      stage1BRequested,
      hasStage1BOutput,
      using: stage2InputPath,
    });
    if ((isStage2Retry || !!payload.stage2OnlyMode?.enabled) && stage2InputPath === lineage1B) {
      nLog(`[stage2-retry] Using Stage1B baseline: ${stage2InputPath}`);
    }
  }

  stage12Success = true;
  let stage2BaseStage: "1A"|"1B" = stage2InputPath && lineage1B && stage2InputPath === lineage1B ? "1B" : "1A";
  const stage2InputUsing = stage2BaseStage === "1B" ? "1B" : "1A";
  const stage2InputSuffix = stage2InputPath ? stage2InputPath.substring(Math.max(0, stage2InputPath.length - 40)) : "";
  nLog("[STAGE2_INPUT_LINEAGE]", {
    jobId: payload.jobId,
    using: stage2InputUsing,
    pathSuffix: stage2InputSuffix,
  });
  
  // ✅ Resolve Stage 2 routing from lineage + effective Stage1B mode + room override
  const recordedStage1BMode = (sceneMeta as any).stage1BMode;
  const effectiveStage1BMode = recordedStage1BMode === "light" || recordedStage1BMode === "stage-ready"
    ? recordedStage1BMode
    : (declutterMode === "light" || declutterMode === "stage-ready"
      ? declutterMode
      : ((payload.options as any).declutterMode === "light" ? "light" : "stage-ready"));
  const stage2Routing = resolveStage2Routing({
    roomType: payload.options.roomType,
    isExteriorScene,
    baseStage: stage2BaseStage,
    stage1BMode: stage2BaseStage === "1B" ? effectiveStage1BMode : undefined,
  });
  const stage2SourceStage = stage2Routing.sourceStage;
  
  const canonicalRoomTypeForStage2 = stage2Routing.canonicalRoomType;
  const forceRefreshPromptMode = stage2Routing.forceRefresh;
  // ✅ FIX: Stage 2 validation must ALWAYS compare against Stage 1A (professional enhancement baseline)
  // Stage 2 input may use Stage 1B (decluttered), but validation compares Stage 2 vs Stage 1A
  const stage2ValidationBaseline = path1A;
  const stage2PromptMode = stage2Routing.mode;
  const stage2ValidationMode = getStage2ValidationModeFromPromptMode(stage2PromptMode);
  logMultiZoneFullMode({
    path: "main",
    canonicalRoomType: canonicalRoomTypeForStage2,
    sourceStage: stage2SourceStage,
    enforced: true,
  });
  nLog(`[STAGE2_PROMPT_MODE] ${stage2PromptMode} sourceStage=${stage2SourceStage}`);
  nLog("[STAGE2_VALIDATOR_MODE]", {
    jobId: payload.jobId,
    path: "main",
    validationMode: stage2ValidationMode,
  });
  nLog(`[WORKER] Stage 2 source: baseStage=${stage2BaseStage}, inputPath=${stage2InputPath}`);
  
  // 📊 STRUCTURED ROUTING LOG - Stage 2
  nLog(`[PIPELINE_ROUTING] Stage 2 routing:`, {
    roomType: canonicalRoomTypeForStage2,
    isMultiRoom: forceRefreshPromptMode,
    hasStage1BOutput,
    stage2InputUsing,
    stage1BModeRecorded: recordedStage1BMode || null,
    stage1BModeEffective: stage2BaseStage === "1B" ? effectiveStage1BMode : null,
    sourceStage: stage2SourceStage,
    promptMode: stage2PromptMode,
    forceRefresh: forceRefreshPromptMode,
    reason: stage2Routing.reason,
  });
  nLog("[STAGE2_ROUTING_DECISION]", {
    jobId: payload.jobId,
    path: "main",
    baseStage: stage2BaseStage,
    hasStage1BLineage: hasStage1BOutput,
    stage1BMode: stage2BaseStage === "1B" ? effectiveStage1BMode : null,
    roomType: payload.options.roomType,
    canonicalRoomType: canonicalRoomTypeForStage2,
    forceRefresh: forceRefreshPromptMode,
    sourceStage: stage2SourceStage,
    finalMode: stage2PromptMode,
    reason: stage2Routing.reason,
  });

  // ═══ STAGE 2 INPUT LINEAGE GUARD ═══
  if (payload.options.virtualStage && !stage2Blocked) {
    const expectedInput = stage2BaseStage === "1B" ? stageLineage.stage1B.output : stageLineage.stage1A.output;
    if (!expectedInput) {
      nLog("[STAGE2_INPUT_GUARD_FAIL]", {
        jobId: payload.jobId,
        stage2BaseStage,
        stage1ACommitted: stageLineage.stage1A.committed,
        stage1BCommitted: stageLineage.stage1B.committed,
        expectedInput,
      });
      throw new Error(`Stage ${stage2BaseStage} output not available for Stage 2 input`);
    }
    if (stage2InputPath !== expectedInput) {
      nLog("[STAGE2_INPUT_MISMATCH_CORRECTED]", {
        jobId: payload.jobId,
        stage2BaseStage,
        attempted: stage2InputPath,
        expected: expectedInput,
      });
      stage2InputPath = expectedInput;
    }
    stageLineage.stage2.input = stage2InputPath;
    logStageInput("2", stage2BaseStage, stage2InputPath);
  }
  let stage2InputResolved = stage2InputPath ?? "";
  let path2: string = stage2InputResolved;
  let stage2TimedOut = false; // FIX 4: Track timeout status
  
  try {
    if (payload.options.virtualStage && !stage2Blocked) {
      await ensureStage2AttemptId();
    }
    // Only allow exterior staging if allowStaging is true
    if (sceneLabel === "exterior" && !allowStaging) {
      const extFallback = stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1A;
      const extFallbackStage = extFallback === path1A ? "1A" : "1B";
      nLog(`[WORKER] Exterior image: No suitable outdoor area detected, skipping staging. Returning ${extFallbackStage} output.`);
      path2 = extFallback; // Only enhancement, no staging
    } else {
      if (payload.options.virtualStage && !stage2Blocked && !(await ensureStage2AttemptOwner("stage2_start"))) return;
      stage2SummaryEligible = true;
      // FIX 6: Track Stage 2 start
      timestamps.stage2Start = Date.now();
      updateJob(payload.jobId, { 'timestamps.stage2Start': timestamps.stage2Start });
      
      // Surface incoming stagingStyle before calling Stage 2
      const stagingStyleRaw: any = (payload as any)?.options?.stagingStyle;
      console.info("[stage2] incoming stagingStyle =", stagingStyleRaw);
      stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === 'string' ? stagingStyleRaw.trim() : undefined;

      // FIX 4: Add Stage 2 timeout with Promise.race
      const STAGE2_TIMEOUT_MS = Number(process.env.STAGE2_TIMEOUT_MS || 180000); // 3 minutes default
      if (payload.options.virtualStage && !stage2Blocked) {
        nLog("[STAGE2_BASE_PROOF]", {
          jobId: payload.jobId,
          path: "main",
          stage1APath: path1A,
          stage1BPath: lineage1B,
          chosenBasePath: stage2InputResolved,
          chosenBaseStage: stage2BaseStage,
          stage1BRequested,
        });
        if (lineage1B && stage2InputResolved === path1A) {
          nLog("[STAGE2_INVARIANT_VIOLATION]", {
            jobId: payload.jobId,
            path: "main",
            stage1A: path1A,
            stage1B: lineage1B,
            chosen: stage2InputResolved,
            chosenBaseStage: stage2BaseStage,
            stage1BRequested,
          });
        }
      }
      const stage2Promise = payload.options.virtualStage && !stage2Blocked
        ? runStage2(stage2InputResolved, stage2BaseStage, {
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
            sourceStage: stage2SourceStage,
            promptMode: stage2PromptMode,
            jobId: payload.jobId,
            validationConfig: { localMode: localValidatorMode },
            stage1APath: stage2ValidationBaseline,
            curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
            onStrictRetry: ({ reasons }) => {
              void (async () => {
                if (stage2Active) {
                  if (!(await ensureStage2AttemptOwner("stage2_strict_retry"))) return;
                }
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
              })();
            },
            onAttemptSuperseded: (nextAttemptId) => {
              stage2AttemptId = nextAttemptId;
            }
          })
        : (stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1A);
      
      // FIX 4: Wrap Stage 2 execution with timeout
      let stage2TimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise((_, reject) => {
        stage2TimeoutHandle = setTimeout(() => reject(new Error('STAGE2_TIMEOUT')), STAGE2_TIMEOUT_MS);
      });
      
      let stage2Outcome: any;
      try {
        stage2Outcome = await Promise.race([stage2Promise, timeoutPromise]);
      } catch (timeoutError: any) {
        if (timeoutError?.message === 'STAGE2_TIMEOUT') {
          stage2TimedOut = true;
          console.log(`[timeout] stage=2 exceeded_ms=${STAGE2_TIMEOUT_MS} jobId=${payload.jobId}`);
          nLog(`[worker] ⏱️ Stage 2 timeout after ${STAGE2_TIMEOUT_MS}ms, falling back to Stage ${stage2BaseStage}`);
          stage2Blocked = true;
          stage2FallbackStage = stage2BaseStage;
          stage2BlockedReason = `Stage 2 processing exceeded ${STAGE2_TIMEOUT_MS / 1000}s timeout. Using best available result.`;
          stage2Outcome = stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1A;
        } else {
          throw timeoutError;
        }
      } finally {
        // Always clear the timeout to avoid timer leak
        if (stage2TimeoutHandle) clearTimeout(stage2TimeoutHandle);
      }
      
      // FIX 6: Track Stage 2 end
      timestamps.stage2End = Date.now();
      if (payload.options.virtualStage && !stage2Blocked && !(await ensureStage2AttemptOwner("stage2_end"))) return;
      updateJob(payload.jobId, { 'timestamps.stage2End': timestamps.stage2End });

      if (typeof stage2Outcome === "string") {
        path2 = stage2Outcome;
        commitStageOutput("2", stage2Outcome);
      } else {
        path2 = stage2Outcome.outputPath;
        commitStageOutput("2", stage2Outcome.outputPath);
        recordStage2AttemptsFromResult(stage2InputResolved, stage2Outcome.attempts);
        stage2AttemptsUsed = stage2Outcome.attempts;
        stage2MaxAttempts = stage2Outcome.maxAttempts;
        stage2ValidationRisk = stage2Outcome.validationRisk;
        stage2LocalReasons = stage2Outcome.localReasons || [];
        stage2NeedsConfirm = GEMINI_CONFIRMATION_ENABLED && stage2ValidationRisk;
      }
    }
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    nLog(`[worker] Stage 2 failed: ${errMsg}`);
    // FIX 6: Track failure timestamp
    timestamps.stage2End = Date.now();
    const fallbackStage = path1B ? "1B" : "1A";
    const fallbackPath = path1B ? path1B : path1A;
    // ═══ FINAL STATUS GUARD ═══
    const latestJob = await getJob(payload.jobId);
    if (isTerminalStatus(latestJob?.status)) {
      nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 2 catch-error fallback`, {
        jobId: payload.jobId,
        stage: "2",
        status: latestJob?.status
      });
      return;
    }

    await clearStage2RetryPending("stage2_error_clear_pending");
    if (!(await canCompleteStage2(true, "stage2_error_complete"))) return;
    logStage2RetrySummary(null);
    await completePartialJob({
      jobId: payload.jobId,
      triggerStage: "2",
      finalStage: fallbackStage,
      finalPath: fallbackPath,
      pub1AUrl,
      pub1BUrl,
      sceneMeta: { ...sceneMeta, 'timestamps.stage2End': timestamps.stage2End },
      userMessage: fallbackStage === "1B"
        ? "We decluttered your image but could not safely stage it."
        : "We enhanced your image but could not safely stage it.",
      reason: "stage2_error",
      stageOutputs: { "1A": path1A, ...(path1B ? { "1B": path1B } : {}) },
    });
    return;
  }

  // Fallback: if structured-retain (stage-ready token) exhausted retries with validation risk, try light declutter then rerun Stage 2
  const declutterModeFallback = (payload.options as any).declutterMode;
  const shouldFallbackLightDeclutter = false;

  if (shouldFallbackLightDeclutter) {
    try {
      nLog(`[worker] [FALLBACK] using light declutter backstop after structured-retain retries exhausted`);
      const lightPath1B = await runStage1B(path1A, {
        replaceSky: false,
        sceneType: sceneLabel,
        roomType: payload.options.roomType,
        declutterMode: "light",
        jobId: payload.jobId,
        attempt: 0,
        canonicalPath: jobContext.canonicalPath,
        baseArtifacts: jobContext.baseArtifacts,
        curtainRailLikely: jobContext.curtainRailLikely,
        jobDeclutterIntensity: jobContext.jobDeclutterIntensity,
        jobSampling: jobContext.jobSampling,
      });

      stage2InputPath = lightPath1B;
      stage2InputResolved = stage2InputPath ?? "";
      stage2BaseStage = "1B";
      const fallbackRouting = resolveStage2Routing({
        roomType: payload.options.roomType,
        isExteriorScene: sceneLabel === "exterior",
        baseStage: "1B",
        stage1BMode: "light",
      });
      logMultiZoneFullMode({
        path: "light_declutter_backstop",
        canonicalRoomType: fallbackRouting.canonicalRoomType,
        sourceStage: fallbackRouting.sourceStage,
        enforced: true,
      });
      nLog("[STAGE2_ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "light_declutter_backstop",
        baseStage: "1B",
        hasStage1BLineage: true,
        stage1BMode: "light",
        roomType: payload.options.roomType,
        canonicalRoomType: fallbackRouting.canonicalRoomType,
        forceRefresh: fallbackRouting.forceRefresh,
        sourceStage: fallbackRouting.sourceStage,
        finalMode: fallbackRouting.mode,
        reason: fallbackRouting.reason,
      });
      nLog("[STAGE2_BASE_PROOF]", {
        jobId: payload.jobId,
        path: "light_declutter_backstop",
        stage1APath: path1A,
        stage1BPath: lightPath1B,
        chosenBasePath: stage2InputResolved,
        chosenBaseStage: stage2BaseStage,
        stage1BRequested,
      });
      if (lightPath1B && stage2InputResolved === path1A) {
        nLog("[STAGE2_INVARIANT_VIOLATION]", {
          jobId: payload.jobId,
          path: "light_declutter_backstop",
          stage1A: path1A,
          stage1B: lightPath1B,
          chosen: stage2InputResolved,
          chosenBaseStage: stage2BaseStage,
          stage1BRequested,
        });
      }
      const stagingStyleFallback = (() => {
        const raw: any = (payload as any)?.options?.stagingStyle;
        return raw && typeof raw === "string" ? raw.trim() : undefined;
      })();

      const stage2Outcome = await runStage2(stage2InputResolved, stage2BaseStage, {
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
        sourceStage: fallbackRouting.sourceStage,
        promptMode: fallbackRouting.mode,
        jobId: payload.jobId,
        validationConfig: { localMode: localValidatorMode },
        stage1APath: stage2ValidationBaseline,
        curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
        onStrictRetry: ({ reasons }) => {
          void (async () => {
            if (stage2Active) {
              if (!(await ensureStage2AttemptOwner("stage2_fallback_strict_retry"))) return;
            }
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
          })();
        },
        onAttemptSuperseded: (nextAttemptId) => {
          stage2AttemptId = nextAttemptId;
        }
      });

      if (typeof stage2Outcome === "string") {
        path2 = stage2Outcome;
        commitStageOutput("2", stage2Outcome);
      } else {
        path2 = stage2Outcome.outputPath;
        commitStageOutput("2", stage2Outcome.outputPath);
        recordStage2AttemptsFromResult(stage2InputResolved, stage2Outcome.attempts);
        stage2AttemptsUsed = stage2Outcome.attempts;
        stage2MaxAttempts = stage2Outcome.maxAttempts;
        stage2ValidationRisk = stage2Outcome.validationRisk;
        stage2LocalReasons = stage2Outcome.localReasons || [];
        stage2NeedsConfirm = GEMINI_CONFIRMATION_ENABLED && stage2ValidationRisk;
      }

      fallbackUsed = "light_declutter_backstop";
    } catch (fallbackErr: any) {
      const errMsg = fallbackErr?.message || String(fallbackErr);
      nLog(`[worker] Fallback light declutter failed: ${errMsg}`);
      if (stage2Active) {
        if (!(await ensureStage2AttemptOwner("stage2_fallback_failed"))) return;
      }
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: errMsg, error: errMsg, meta: { ...sceneMeta }, fallbackUsed: "light_declutter_backstop" },
        "stage2_fallback_failed"
      );
      return;
    }
  }

  // Preserve the staged candidate path before validation decides whether it can ship
  let stage2CandidatePath = path2;

  timings.stage2Ms = Date.now() - t2;
  // ✅ FIX 3: Add updatedAt timestamp for stuck detection
  const now2 = new Date().toISOString();
  if (payload.options.virtualStage && !(await ensureStage2AttemptOwner("stage2_progress"))) return;
  await safeWriteJobStatus(
    payload.jobId,
    {
      status: "processing",
      currentStage: payload.options.virtualStage ? "2" : (payload.options.declutter ? "1B" : "1A"),
      stage: payload.options.virtualStage ? "2" : (payload.options.declutter ? "1B" : "1A"),
      progress: payload.options.virtualStage ? 75 : (payload.options.declutter ? 55 : 45),
      stageUrls: { "1A": pub1AUrl ?? null, "1B": pub1BUrl ?? null },
      updatedAt: now2,
      updated_at: now2,
    },
    "stage2_progress"
  );

  if (await isCancelled(payload.jobId)) {
    await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
    return;
  }

  // Publish Stage 2 after validation (deferred); keep placeholder for URL
  let pub2Url: string | undefined = undefined;

  // ===== STAGE 2 UNIFIED STRUCTURAL RETRY CONTROLLER =====
  let unifiedValidation: UnifiedValidationResult | undefined = undefined;
  let effectiveValidationMode: "log" | "enforce" | undefined = undefined;
  const MAX_STAGE2_RETRIES = Math.max(1, stage2MaxAttempts || 1);

  const hasStage2GeminiSemanticHardFail = (result?: UnifiedValidationResult): boolean => {
    if (!result || !payload.options.virtualStage) return false;
    const category = String((result.raw?.geminiSemantic?.details as any)?.category || "").toLowerCase();
    if (category !== "structure" && category !== "opening_blocked") return false;
    return result.reasons.some((reason) => reason.startsWith("Gemini "));
  };

  let retryTemperature = 0.55;
  let retryTopP = 0.85;
  let retryTopK = 40;

  if (payload.options.virtualStage) {
    for (let attempt = 1; attempt <= MAX_STAGE2_RETRIES; attempt++) {
      if (Date.now() - t2 > MAX_STAGE_RUNTIME_MS) {
        console.log(`[timeout] stage=2_validation_loop exceeded_ms=${Date.now() - t2} jobId=${payload.jobId}`);
        stage2Blocked = true;
        stage2BlockedReason = "stage2_runtime_exceeded";
        await safeWriteJobStatus(
          payload.jobId,
          {
            status: "failed",
            errorMessage: "stage2_runtime_exceeded",
            reason: "stage2_runtime_exceeded",
          },
          "stage2_runtime_exceeded_terminal"
        );
        return;
      }

      if (attempt > 1) {
        const retryOutputPath = siblingOutPath(stage2InputResolved, `-2-retry${attempt - 1}`, ".webp");
        const retryStage2Path = await enhanceWithGemini(stage2InputResolved, {
          ...payload.options,
          stage: "2",
          temperature: retryTemperature,
          topP: retryTopP,
          topK: retryTopK,
          jobId: payload.jobId,
          roomType: payload.options.roomType,
          sceneType: sceneLabel,
          modelReason: `stage2 unified retry ${attempt - 1}`,
          outputPath: retryOutputPath,
        });
        recordStage2AttemptOutput(attempt - 1, retryStage2Path);
        stage2CandidatePath = retryStage2Path;
        path2 = retryStage2Path;
        commitStageOutput("2", retryStage2Path);
      }

      stage2AttemptsUsed = Math.max(stage2AttemptsUsed, attempt);
      stage2LocalReasons = [];
      stage2NeedsConfirm = false;

      const validationStartTime = Date.now();
      const validationStage: "1A" | "1B" | "2" = "2";
      const validationBasePath = stage2ValidationBaseline;

      nLog(`[STAGE2_VALIDATION_BASELINE]`, {
        jobId: payload.jobId,
        stage2InputPath: stage2InputResolved.substring(stage2InputResolved.length - 40),
        validationBasePath: validationBasePath.substring(validationBasePath.length - 40),
        stage2BaseStage,
        declutterEnabled: payload.options.declutter,
        path1BExists: !!path1B,
      });

      nLog(`[worker] ═══════════ Running Unified Structural Validation (attempt ${attempt}/${MAX_STAGE2_RETRIES}) ═══════════`);

      effectiveValidationMode = VALIDATION_BLOCKING_ENABLED ? "enforce" : "log";
      nLog(`[worker] Unified validation mode: configured=${structureValidatorMode} effective=${effectiveValidationMode} blocking=${VALIDATION_BLOCKING_ENABLED ? "ON" : "OFF (advisory)"}`);

      const stage2OutputCheck = checkStageOutput(path2, "2", payload.jobId);
      if (!stage2OutputCheck.readable) {
        nLog(`[worker] Stage output missing/unreadable before validation — marking failed`, { jobId: payload.jobId, stage: "2", path: path2 });
        await safeWriteJobStatus(payload.jobId, { status: "failed", errorMessage: "missing_stage_output" }, "missing_stage_output");
        return;
      }

      unifiedValidation = await runUnifiedValidation({
        originalPath: validationBasePath,
        enhancedPath: path2,
        stage: validationStage,
        sceneType: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
        roomType: payload.options.roomType,
        mode: effectiveValidationMode,
        geminiPolicy: VALIDATION_BLOCKING_ENABLED ? "never" : "on_local_fail",
        jobId: payload.jobId,
        stagingStyle: payload.options.stagingStyle || "nz_standard",
        stage1APath: validationBasePath,
        sourceStage: stage2SourceStage,
        validationMode: stage2ValidationMode,
        baseArtifacts: stageLineage.baseArtifacts,
      });

      const validationElapsed = Date.now() - validationStartTime;
      nLog(`[worker] Unified validation completed in ${validationElapsed}ms`);
      nLog(`[worker] Validation result: ${unifiedValidation.passed ? "PASSED" : "FAILED"} (score: ${unifiedValidation.score})`);

      if (VALIDATOR_FOCUS && unifiedValidation) {
        vLog("");
        logUnifiedValidationCompact(
          payload.jobId,
          unifiedValidation,
          validationStage,
          sceneLabel === "exterior" ? "exterior" : "interior"
        );
      }

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
            localBlockingEnabled: VALIDATION_BLOCKING_ENABLED,
            geminiConfirmationEnabled: GEMINI_CONFIRMATION_ENABLED,
            riskLevel: unifiedValidation.riskLevel,
            riskTriggers: unifiedValidation.riskTriggers,
            modelUsed: unifiedValidation.modelUsed,
            anchorFlags: unifiedValidation.evidence?.anchorChecks,
          },
        },
      });

      const rawResults = unifiedValidation.raw ? Object.values(unifiedValidation.raw) : [];
      const anyFailed = rawResults.some((r) => r && r.passed === false);
      const localNotes = (unifiedValidation.reasons && unifiedValidation.reasons.length)
        ? unifiedValidation.reasons
        : (unifiedValidation.warnings && unifiedValidation.warnings.length)
          ? unifiedValidation.warnings
          : [];
      if (anyFailed || localNotes.length) {
        stage2NeedsConfirm = GEMINI_CONFIRMATION_ENABLED;
        stage2LocalReasons.push(...localNotes);
      }

      if (path2 && SHARP_SEMANTIC_ENABLED) {
        try {
          nLog(`[worker] ═══════════ Running Semantic Structure Validator (Stage-2) mode=${sharpFinalValidatorMode} ═══════════`);
          const semanticResult = await runSemanticStructureValidator({
            originalImagePath: path1A,
            enhancedImagePath: path2,
            scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
            mode: "log",
          });
          if (semanticResult && !semanticResult.passed) {
            stage2LocalReasons.push(
              `semantic_validator_failed: windows ${semanticResult.windows.before}→${semanticResult.windows.after}, doors ${semanticResult.doors.before}→${semanticResult.doors.after}, wall_drift ${(semanticResult.walls.driftRatio * 100).toFixed(2)}%, openings +${semanticResult.openings.created}/-${semanticResult.openings.closed}`
            );
          }
        } catch (semanticError: any) {
          nLog(`[worker] Semantic validation error (non-fatal):`, semanticError);
        }
      } else if (path2 && !SHARP_SEMANTIC_ENABLED) {
        nLog(`[worker] Sharp semantic validator disabled (SHARP_FINAL_VALIDATOR not set)`);
      }

      if (path2) {
        try {
          nLog(`[worker] ═══════════ Running Masked Edge Geometry Validator (Stage-2) ═══════════`);
          const maskedEdgeResult = await runMaskedEdgeValidator({
            originalImagePath: path1A,
            enhancedImagePath: path2,
            scene: (sceneLabel === "exterior" ? "exterior" : "interior") as any,
            mode: "log",
            jobId: payload.jobId,
          });

          if (maskedEdgeResult) {
            const maskedDriftPct = maskedEdgeResult.maskedEdgeDrift * 100;
            const maskedEdgeFailed =
              maskedEdgeResult.createdOpenings > 0 ||
              maskedEdgeResult.closedOpenings > 0 ||
              maskedEdgeResult.maskedEdgeDrift > 0.18;
            if (maskedEdgeFailed) {
              stage2LocalReasons.push(
                `masked_edge_failed: drift ${maskedDriftPct.toFixed(2)}%, openings +${maskedEdgeResult.createdOpenings}/-${maskedEdgeResult.closedOpenings}`
              );
            }
          }

          nLog(`[worker] Masked edge validation completed (log-only, non-blocking)`);
        } catch (maskedEdgeError: any) {
          nLog(`[worker] Masked edge validation error (non-fatal):`, maskedEdgeError);
          nLog(`[worker] Stack:`, maskedEdgeError?.stack);
        }
      }

      const stage2LocalStatus = stage2LocalReasons.length ? "needs_confirm" : "pass";
      nLog(`[LOCAL_VALIDATE] stage=2 status=${stage2LocalStatus} reasons=${JSON.stringify(stage2LocalReasons)}`);

      let lastGeminiConfirm: any = null;
      if (GEMINI_CONFIRMATION_ENABLED && stage2CandidatePath) {
        nLog(`[GEMINI_CONFIRM] stage=2 trigger=local_issues reasons=${JSON.stringify(stage2LocalReasons)}`);
        const { confirmWithGeminiStructure } = await import("./validators/confirmWithGeminiStructure.js");
        const gatedEvidence = shouldInjectEvidence(unifiedValidation?.evidence)
          ? unifiedValidation?.evidence
          : undefined;
        const injectionStatus = gatedEvidence ? "injected" : "suppressed";
        nLog(`[VALIDATION_EVIDENCE_GATE] stage=2 injected=${!!gatedEvidence} reason=${injectionStatus}`);

        lastGeminiConfirm = await confirmWithGeminiStructure({
          baselinePathOrUrl: path1A,
          candidatePathOrUrl: stage2CandidatePath,
          stage: "stage2",
          roomType: payload.options.roomType,
          sceneType: sceneLabel as any,
          jobId: payload.jobId,
          localReasons: stage2LocalReasons,
          sourceStage: stage2SourceStage,
          validationMode: stage2ValidationMode,
          evidence: gatedEvidence,
          riskLevel: unifiedValidation?.riskLevel,
        });
        nLog(`[GEMINI_CONFIRM] stage=2 attempt=${attempt} status=${lastGeminiConfirm.status} confirmedFail=${lastGeminiConfirm.confirmedFail} reasons=${JSON.stringify(lastGeminiConfirm.reasons)}`);
      }

      const unifiedHardFail = unifiedValidation.hardFail === true;
      const geminiSemanticHardFail = hasStage2GeminiSemanticHardFail(unifiedValidation);
      const confirmHardFail = lastGeminiConfirm?.confirmedFail === true;
      const structuralFailDetected = unifiedHardFail || geminiSemanticHardFail || confirmHardFail;

      if (structuralFailDetected) {
        const blockedBy = confirmHardFail ? "gemini" : (unifiedValidation.blockSource || "gemini");
        const failReasons = [
          ...(unifiedValidation.reasons || []),
          ...(lastGeminiConfirm?.reasons || []),
        ];
        setStage2AttemptValidation(path2, blockedBy, failReasons);

        if (attempt >= MAX_STAGE2_RETRIES) {
          stage2Blocked = true;
          stage2BlockedReason = "stage2_structural_exhausted";
          nLog(`[STAGE2_UNIFIED_EXHAUSTED] attempts=${MAX_STAGE2_RETRIES}`);
          await safeWriteJobStatus(
            payload.jobId,
            {
              status: "failed",
              errorMessage: "stage2_structural_exhausted",
              reason: "stage2_structural_exhausted",
              meta: {
                ...(sceneLabel ? { ...sceneMeta } : {}),
                unifiedValidation,
                stage2LocalReasons,
                geminiConfirm: lastGeminiConfirm,
                blockedBy,
                blockedStage: "stage2",
                attemptCount: attempt,
              },
            },
            "stage2_unified_exhausted"
          );
          return;
        }

        retryTemperature = Math.max(0.05, retryTemperature * 0.9);
        retryTopP = Math.max(0.3, retryTopP * 0.9);
        retryTopK = Math.max(10, Math.floor(retryTopK * 0.9));
        nLog(`[STAGE2_UNIFIED_RETRY] attempt=${attempt + 1} structuralFail=true temp=${retryTemperature.toFixed(3)} topP=${retryTopP.toFixed(3)} topK=${retryTopK}`);
        continue;
      }

      nLog(`[STAGE2_UNIFIED_SUCCESS] attempt=${attempt}`);
      updateJob(payload.jobId, {
        meta: {
          ...sceneMeta,
          stage2LocalReasons,
          geminiConfirm: lastGeminiConfirm,
        }
      });
      nLog(`[VALIDATE_FINAL] stage=2 decision=accept blockedBy=none retries=${attempt - 1}`);
      break;
    }
  }

  // AUDIT FIX: Compliance gate moved BEFORE publish — only publish if compliance passes
  // Respects geminiSemanticValidatorMode: null=skip, "log"=log-only, "block"=blocking
  let compliance: any = undefined;
  const tVal = Date.now();
  if (geminiSemanticValidatorMode !== null) {
    try {
      const ai = getGeminiClient();
      const base1A = toBase64(path1A);
      const baseFinal = toBase64(path2);
      compliance = await checkCompliance(ai as any, base1A.data, baseFinal.data, {
        validationMode: stage2ValidationMode,
      });
      if (compliance && compliance.ok === false) {
        const HIGH_CONF = COMPLIANCE_BLOCK_THRESHOLD;
        const MED_CONF = Math.max(0, COMPLIANCE_BLOCK_THRESHOLD - 0.1);
        const confidence = compliance.confidence ?? 0.6;
        const anchorChecks = unifiedValidation?.evidence?.anchorChecks;
        const hasAnchorEvidence = !!anchorChecks && (
          anchorChecks.islandChanged ||
          anchorChecks.cabinetryChanged ||
          anchorChecks.hvacChanged ||
          anchorChecks.lightingChanged
        );
        const structuralViolation = !!compliance.structuralViolation;
        const placementViolation = !!compliance.placementViolation;
        const lastViolationMsg = `Structural violations detected: ${(compliance.reasons || ["Compliance check failed"]).join("; ")}`;
        const shouldBlock = confidence >= HIGH_CONF || (confidence >= MED_CONF && hasAnchorEvidence);

        nLog("[STRUCTURE_COMPLIANCE_AUDIT]", {
          jobId: payload.jobId,
          complianceOk: compliance.ok,
          complianceConfidence: compliance.confidence,
          complianceReasons: compliance.reasons?.length ?? 0,
          hasAnchorEvidence,
          anchorFlags: anchorChecks ?? null,
          maskedIou: (unifiedValidation as any)?.maskedIou ?? null,
          lineDrift: (unifiedValidation as any)?.lineDrift ?? null,
          dimensionDrift: (unifiedValidation as any)?.dimensionDrift ?? null,
          riskLevel: unifiedValidation?.riskLevel ?? null,
          stage2Input: stage2InputResolved ?? null,
          stage1AUrl: pub1AUrl ?? null,
          stage1BUrl: pub1BUrl ?? null,
          finalStage2Url: null, // Not yet published (compliance runs pre-publish)
        });

        nLog("[COMPLIANCE_GATE_DECISION]", {
          jobId: payload.jobId,
          ok: compliance.ok,
          confidence,
          hasAnchorEvidence,
          structuralViolation,
          placementViolation,
          highThreshold: HIGH_CONF,
          medThreshold: MED_CONF,
          mode: geminiSemanticValidatorMode,
          action: (shouldBlock && geminiSemanticValidatorMode === "block") ? "block" : "log-only",
        });

        if (shouldBlock && geminiSemanticValidatorMode === "block") {
          const complianceError = new Error(`Gemini semantic validation failed with confidence ${confidence.toFixed(2)}: ${lastViolationMsg}`);
          (complianceError as any).code = "COMPLIANCE_VALIDATION_FAILED";
          (complianceError as any).violations = compliance.reasons || [];
          (complianceError as any).confidence = confidence;
          nLog(`[worker] ❌ BLOCKING JOB ${payload.jobId}: ${lastViolationMsg} (confidence: ${confidence.toFixed(2)})`);
          nLog(`[worker] Job blocked PRE-PUBLISH - structural integrity cannot be guaranteed`);
          throw complianceError;
        } else if (shouldBlock && geminiSemanticValidatorMode === "log") {
          nLog(`[worker] ⚠️  Compliance failure detected (confidence ${confidence.toFixed(2)}) mode=log - ALLOWING job to proceed: ${lastViolationMsg}`);
        } else {
          nLog("[COMPLIANCE_SOFT_FAIL]", {
            jobId: payload.jobId,
            confidence,
            reasons: compliance.reasons,
            threshold: MED_CONF,
            highThreshold: HIGH_CONF,
          });
          nLog(`[worker] ⚠️  Compliance concerns (confidence ${confidence.toFixed(2)} < ${MED_CONF} threshold) - allowing job to proceed`);
        }
      }
    } catch (e: any) {
      if (e?.code === "COMPLIANCE_VALIDATION_FAILED") {
        throw e;
      }
      nLog("[worker] compliance check skipped or error:", e?.message || e);
    }
  } else {
    nLog(`[worker] Compliance check skipped - geminiSemanticValidatorMode=disabled`);
  }
  timings.validateMs = Date.now() - tVal;
  nLog(`[AUDIT FIX] Compliance passed — proceeding to publish Stage 2 image`);

  // Publish Stage 2 only if it passed blocking validation
  if (payload.options.virtualStage && !stage2Blocked && stage2CandidatePath) {
    if (!(await ensureStage2AttemptOwner("stage2_publish_gate"))) return;
    // ═══ FINAL STATUS GUARD ═══
    const latestJob = await getJob(payload.jobId);
    if (isTerminalStatus(latestJob?.status)) {
      nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 2 main publish`, {
        jobId: payload.jobId,
        stage: "2",
        status: latestJob?.status
      });
      return;
    }

    // If Stage 2 equals Stage 1B (no change), reuse the Stage 1B URL to avoid duplicate uploads
    if (stage2CandidatePath === path1B && pub1BUrl) {
      pub2Url = pub1BUrl;
      stage2Success = true;
      stage2PublishSuccess = true;
      stage2PublishedUrl = pub2Url;
      
      // Track memory after Stage 2 (reused path)
      updatePeakMemory(payload.jobId);
      if (isMemoryCritical()) {
        nLog(`[MEMORY] WARNING: Memory usage critical after Stage 2 (reused) - forcing garbage collection`);
        forceGC();
      }
      
      if (!(await ensureStage2AttemptOwner("stage2_publish_reuse_status"))) return;
      await safeWriteJobStatus(
        payload.jobId,
        { status: "processing", currentStage: "2", stage: "2", progress: 85, stageUrls: { "2": pub2Url }, imageUrl: pub2Url },
        "stage2_publish_reuse"
      );
      vLog(`[VAL][job=${payload.jobId}] stage2Url=${pub2Url} (reused 1B)`);
    } else {
      let v2: any = null;
      try {
        v2 = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "2", filePath: stage2CandidatePath, note: "Virtual staging" });
      } catch (e) {
        nLog(`[worker] Note: Could not record Stage 2 version in images.json (expected in multi-service deployment)\n`);
      }
      try {
        if (!(await ensureStage2AttemptOwner("stage2_publish_upload"))) return;
        const pub2 = await publishWithOptionalBlackEdgeGuard(stage2CandidatePath, "2");
        pub2Url = pub2.url;
        stage2Success = true;
        stage2PublishSuccess = !!pub2?.url;
        stage2PublishedUrl = pub2?.url;
        if (pub2Url) {
          attachStage2PublishedUrl(stage2CandidatePath, pub2Url);
        }
        
        // Track memory after Stage 2 (new path)
        updatePeakMemory(payload.jobId);
        if (isMemoryCritical()) {
          nLog(`[MEMORY] WARNING: Memory usage critical after Stage 2 (new) - forcing garbage collection`);
          forceGC();
        }
        
        if (v2) {
          try {
            setVersionPublicUrl(payload.imageId, v2.versionId, pub2.url);
          } catch (e) {
            // Ignore
          }
        }
        if (!(await ensureStage2AttemptOwner("stage2_publish_status"))) return;
        await safeWriteJobStatus(
          payload.jobId,
          { status: "processing", currentStage: "2", stage: "2", progress: 85, stageUrls: { "2": pub2Url }, imageUrl: pub2Url },
          "stage2_publish"
        );
        // VALIDATOR FOCUS: Log Stage 2 URL
        vLog(`[VAL][job=${payload.jobId}] stage2Url=${pub2Url}`);
        nLog(`[worker] ✅ Stage 2 published: ${pub2Url}`);
      } catch (e) {
        nLog('[worker] failed to publish Stage 2', e);
      }
    }
  }

  if (payload.options.virtualStage) {
    logStage2RetrySummary(stage2Success ? stage2CandidatePath : null);
  }

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
      const confidence = compliance.confidence ?? 0.6;
      nLog(`[worker] Gemini Compliance: ${compliance.ok ? "✓ PASSED" : "✗ FAILED"} (confidence: ${confidence.toFixed(2)})`);
      if (!compliance.ok && compliance.reasons) {
        nLog(`[worker] Compliance issues: ${compliance.reasons.join("; ")}`);
      }
    }
    nLog(`[worker] Blocking mode: Local=${VALIDATION_BLOCKING_ENABLED ? "ENABLED" : "DISABLED"}, GeminiConfirmation=${GEMINI_CONFIRMATION_ENABLED ? "ENABLED" : "DISABLED (log-only)"}`);
    nLog(`[worker] ═══════════════════════════════════════════`);
  }

  // stage 1B publishing was deferred until here; attach URL and surface progress
  // pub1BUrl already declared above; removed duplicate
  if (payload.options.declutter) {
    if (!path1B) {
      throw new Error("Stage 1B path is undefined");
    }

    // ═══ FINAL STATUS GUARD ═══
    const latestJob = await getJob(payload.jobId);
    if (isTerminalStatus(latestJob?.status)) {
      nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B deferred publish`, {
        jobId: payload.jobId,
        stage: "1B",
        status: latestJob?.status
      });
      return;
    }

    let v1B: any = null;
    try {
      v1B = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1B", filePath: path1B, note: "Decluttered / depersonalized" });
    } catch (e) {
      // Silently ignore - images.json is not available in multi-service deployment
    }
    try {
      const pub1B = await publishWithOptionalBlackEdgeGuard(path1B, "1B-deferred");
      pub1BUrl = pub1B.url;
      if (v1B) {
        try {
          setVersionPublicUrl(payload.imageId, v1B.versionId, pub1B.url);
        } catch (e) {
          // Ignore
        }
      }
      await safeWriteJobStatus(
        payload.jobId,
        { stage: "1B", progress: 55, stageUrls: { "1B": pub1BUrl } },
        "stage1b_deferred_publish"
      );
      // VALIDATOR FOCUS: Log Stage 1B URL
      vLog(`[VAL][job=${payload.jobId}] stage1BUrl=${pub1BUrl}`);
    } catch (e) {
      nLog('[worker] failed to publish 1B', e);
    }
  }

  // Recover Stage 2 publication if output exists and validation passed but URL wasn't persisted.
  // This prevents "complete" jobs from missing selectable/downloadable staged output in the UI.
  if (payload.options.virtualStage && !stage2Blocked && stage2CandidatePath && !pub2Url) {
    try {
      const stage2OutputCheck = checkStageOutput(stage2CandidatePath, "2", payload.jobId);
      if (stage2OutputCheck.readable) {
        nLog("[STAGE2_RECOVERY] Stage 2 candidate exists but URL missing — attempting recovery publish", {
          jobId: payload.jobId,
          stage2CandidatePath: stage2CandidatePath.substring(Math.max(0, stage2CandidatePath.length - 80)),
        });
        const recoveredPub2 = await publishWithOptionalBlackEdgeGuard(stage2CandidatePath, "2-recovery");
        if (recoveredPub2?.url) {
          pub2Url = recoveredPub2.url;
          stage2Success = true;
          stage2PublishSuccess = true;
          stage2PublishedUrl = recoveredPub2.url;
          attachStage2PublishedUrl(stage2CandidatePath, recoveredPub2.url);
          await safeWriteJobStatus(
            payload.jobId,
            { stage: "2", stageUrls: { "2": recoveredPub2.url }, imageUrl: recoveredPub2.url },
            "stage2_recovery_publish"
          );
          nLog("[STAGE2_RECOVERY] Stage 2 URL recovered", { jobId: payload.jobId, stage2Url: recoveredPub2.url });
        }
      }
    } catch (recoverErr) {
      nLog("[STAGE2_RECOVERY] Recovery publish failed (non-blocking)", {
        jobId: payload.jobId,
        error: (recoverErr as any)?.message || String(recoverErr),
      });
    }
  }

  // Decide final base path for versioning + final publish.
  // Preference order:
  //   1) Stage 2 (if virtualStage requested AND not blocked)
  //   2) Stage 1B (decluttered) if available
  //   3) Stage 1A
  const hasStage2 = payload.options.virtualStage && !stage2Blocked && !!pub2Url;
  let finalBasePath = hasStage2 ? stage2CandidatePath : (payload.options.declutter && path1B ? path1B! : path1A);
  const finalStageLabel = hasStage2 ? "2" : (payload.options.declutter ? "1B" : "1A");
  
  // ═══ FINAL OUTPUT LINEAGE VALIDATION (FIX 1.3) ═══
  // Verify final output path matches committed stageLineage to ensure no stale local variable usage
  const lineageOutput = finalStageLabel === "2" 
    ? stageLineage.stage2.output 
    : finalStageLabel === "1B" 
      ? stageLineage.stage1B.output 
      : stageLineage.stage1A.output;
  
  if (lineageOutput && finalBasePath !== lineageOutput) {
    nLog("[FINAL_OUTPUT_LINEAGE_MISMATCH]", {
      jobId: payload.jobId,
      finalStageLabel,
      localPath: finalBasePath,
      lineagePath: lineageOutput,
    });
    // ✅ FIX: Apply lineage correction (was logging but not applying)
    finalBasePath = lineageOutput;
    nLog("[FINAL_OUTPUT_CORRECTED]", { correctedPath: finalBasePath.substring(finalBasePath.length - 40) });
  }
  
  nLog(`[FINAL_STAGE_DECISION] finalStageLabel=${finalStageLabel} hasStage2=${hasStage2} stage2Blocked=${stage2Blocked} pub2Url=${!!pub2Url} virtualStage=${payload.options.virtualStage} declutter=${payload.options.declutter}`);

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

  // ═══ FINAL STATUS GUARD ═══
  const latestJobBeforeFinal = await getJob(payload.jobId);
  if (isTerminalStatus(latestJobBeforeFinal?.status)) {
    nLog(`[FINAL_STATUS_GUARD] Skipping late final publish`, {
      jobId: payload.jobId,
      stage: "final",
      status: latestJobBeforeFinal?.status
    });
    return;
  }

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
  } else if (finalBasePath === stage2CandidatePath && pub2Url) {
    // Fix B: Reuse already-published Stage 2 URL instead of double-uploading
    // This ensures stageUrls["2"] and resultUrl are the same URL
    nLog(`\n[WORKER] ═══════════ Final image same as Stage 2 - reusing URL ═══════════\n`);
    pubFinalUrl = pub2Url;
    publishedFinal = { url: pub2Url, kind: 's3' };
    nLog(`[WORKER] Final URL (reused from Stage 2): ${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
    vLog(`[VAL][job=${payload.jobId}] finalUrl=${pubFinalUrl} (reused stage2)`);
  } else {
    try {
      nLog(`\n[WORKER] ═══════════ Publishing final enhanced image ═══════════\n`);
      publishedFinal = await publishWithOptionalBlackEdgeGuard(finalBasePath, "final");
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
  // Only run on Stage 1B and Stage 2, NOT on Stage 1A
  // Stage 1A is the base enhancement and doesn't need structural validation
  // Stage 1B has its own validation at line 896
  const shouldRunFinalValidation = finalStageLabel === "1B" || finalStageLabel === "2";
  
  nLog(`[FINAL_VALIDATION_CHECK] finalStageLabel=${finalStageLabel} shouldRunFinalValidation=${shouldRunFinalValidation} hasPubFinalUrl=${!!pubFinalUrl} hasOriginalUrl=${!!publishedOriginal?.url}`);
  
  if (shouldRunFinalValidation && pubFinalUrl && publishedOriginal?.url) {
    try {
      nLog(`[worker] ═══════════ Running final structural validation for stage ${finalStageLabel} ═══════════`);
      structuralValidationResult = await runStructuralCheck(
        publishedOriginal.url,
        pubFinalUrl,
        { stage: finalStageLabel, jobId: payload.jobId }
      );
      nLog(`[worker] ═══════════ Final structural validation completed for stage ${finalStageLabel} ═══════════`);
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
    if (!shouldRunFinalValidation) {
      nLog(`[worker] Skipping final structural validation for stage ${finalStageLabel} (only runs for 1B and 2)`);
    } else {
      nLog("[worker] Skipping structural validation (no public URLs available)");
    }
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

      // Fix C: Also record intermediate stage URLs that differ from pubFinalUrl
      // This ensures any stageUrl the client might send to /region-edit will be found
      const extraUrls: Array<{ url: string; stage: "1A" | "1B" | "2" }> = [];
      if (pub1AUrl && pub1AUrl !== pubFinalUrl) extraUrls.push({ url: pub1AUrl, stage: "1A" });
      if (pub1BUrl && pub1BUrl !== pubFinalUrl && pub1BUrl !== pub1AUrl) extraUrls.push({ url: pub1BUrl, stage: "1B" });
      if (pub2Url && pub2Url !== pubFinalUrl && pub2Url !== pub1BUrl) extraUrls.push({ url: pub2Url, stage: "2" });

      for (const extra of extraUrls) {
        try {
          const extraBaseKey = extra.url.split("?")[0].split("/").pop() || "";
          const extraPathKey = (() => {
            try { return new URL(extra.url).pathname.replace(/^\/+/, ""); } catch { return extraBaseKey; }
          })();
          await recordEnhancedImageRedis({
            userId: payload.userId,
            imageId: payload.imageId,
            publicUrl: extra.url,
            baseKey: extraBaseKey,
            versionId: computeFallbackVersionKey(extraPathKey) || "",
            stage: extra.stage,
          });
          nLog(`[worker] Redis image history recorded for stage ${extra.stage}`, { url: extra.url.substring(0, 80) });
        } catch (stageErr) {
          nLog(`[worker] Failed to record stage ${extra.stage} in Redis (non-critical):`, (stageErr as any)?.message || stageErr);
        }
      }
    } else {
      nLog("[worker] No pubFinalUrl, skipping Redis history record");
    }
  } catch (err) {
    nLog(
      "[worker] Failed to record image history in Redis:",
      (err as any)?.message || err
    );
  }

  const stage2OutputCheckAtCommit = (payload.options.virtualStage && stage2CandidatePath)
    ? checkStageOutput(stage2CandidatePath, "2", payload.jobId)
    : { exists: false, readable: false, reason: "missing_stage_output" as const };
  const stage2LineageConsistent = !!(
    payload.options.virtualStage
    && stage2CandidatePath
    && stageLineage.stage2.committed
    && stageLineage.stage2.output === stage2CandidatePath
  );
  const stage2PublishConfirmed = !!(
    stage2PublishSuccess
    && stage2PublishedUrl
    && pub2Url
    && stage2PublishedUrl === pub2Url
  );
  const stage2ArtifactReady = !!(
    pub2Url
    && stage2OutputCheckAtCommit.readable
    && stage2LineageConsistent
    && stage2PublishConfirmed
  );

  const stage1BOutputCheckAtCommit = path1B
    ? checkStageOutput(path1B, "1B", payload.jobId)
    : { exists: false, readable: false, reason: "missing_stage_output" as const };
  const stage1BLineageConsistent = !!(
    path1B
    && stageLineage.stage1B.committed
    && stageLineage.stage1B.output === path1B
  );
  const stage1BReady = !!(pub1BUrl && stage1BOutputCheckAtCommit.readable && stage1BLineageConsistent);

  const stage1AOutputCheckAtCommit = checkStageOutput(path1A, "1A", payload.jobId);
  const stage1ALineageConsistent = !!(
    stageLineage.stage1A.committed
    && stageLineage.stage1A.output === path1A
  );
  const stage1AReady = !!(pub1AUrl && stage1AOutputCheckAtCommit.readable && stage1ALineageConsistent);

  const committedFinalStageLabel: "1A" | "1B" | "2" = stage2ArtifactReady
    ? "2"
    : stage1BReady
      ? "1B"
      : "1A";
  const committedStage2Url = stage2ArtifactReady ? (pub2Url ?? null) : null;
  const committedStage1BUrl = stage1BReady ? (pub1BUrl ?? null) : null;
  const committedStage1AUrl = stage1AReady ? (pub1AUrl ?? null) : null;
  const committedResultUrl = committedFinalStageLabel === "2"
    ? (committedStage2Url || pubFinalUrl)
    : committedFinalStageLabel === "1B"
      ? (committedStage1BUrl || pubFinalUrl)
      : (committedStage1AUrl || pubFinalUrl);
  const stage2AdvertisedButMissing = finalStageLabel === "2" && committedFinalStageLabel !== "2";

  nLog("[FINAL_STAGE2_ARTIFACT_GUARD]", {
    jobId: payload.jobId,
    stage2ArtifactReady,
    stage2UrlPresent: !!pub2Url,
    stage2Readable: stage2OutputCheckAtCommit.readable,
    stage2LineageConsistent,
    stage2PublishConfirmed,
    stage2PublishedUrlMatchesStored: !!(stage2PublishedUrl && pub2Url && stage2PublishedUrl === pub2Url),
    finalStageBeforeGuard: finalStageLabel,
    finalStageAfterGuard: committedFinalStageLabel,
    stage2AdvertisedButMissing,
  });

  console.assert(
    committedFinalStageLabel !== "2" || !!committedStage2Url,
    "[INVARIANT] resultStage=2 requires readable Stage 2 artifact URL",
    {
      jobId: payload.jobId,
      committedFinalStageLabel,
      committedStage2Url,
      stage2ArtifactReady,
    }
  );

  // Build metadata BEFORE any async operations that could fail
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
    ...(stage1BDeclutterResult ? { stage1BDeclutterResult } : {}),
    ...(unifiedValidation ? { unifiedValidation } : {}),
    ...(stage2Blocked ? { stage2Blocked: true, stage2BlockedReason, validationNote: stage2BlockedReason, fallbackStage: stage2FallbackStage } : {}),
    ...(stage2AdvertisedButMissing ? { stage2AdvertisedButMissing: true } : {}),
  };

  // ⚡ CRITICAL: Mark job as complete IMMEDIATELY with final URL
  // This must happen BEFORE any non-essential operations (usage tracking, billing)
  // to prevent jobs getting stuck in "processing" if those operations fail/timeout
  
  // Extract retry information from payload to preserve parent job linkage
  const retryInfo = (payload as any).retryType ? {
    retryType: (payload as any).retryType,
    sourceStage: (payload as any).retrySourceStage,
    sourceUrl: (payload as any).retrySourceUrl,
    sourceKey: (payload as any).retrySourceKey,
    parentImageId: (payload as any).retryParentImageId,
    parentJobId: (payload as any).retryParentJobId,
    clientBatchId: (payload as any).retryClientBatchId,
  } : undefined;

  // FIX 6: Mark completion timestamp
  timestamps.completed = Date.now();
  
  nLog("[worker] Marking job complete", {
    jobId: payload.jobId,
    finalStageLabel: committedFinalStageLabel,
    resultUrl: committedResultUrl,
    originalUrl: publishedOriginal?.url,
    stageUrls: {
      "1A": committedStage1AUrl,
      "1B": committedStage1BUrl,
      "2": committedStage2Url,
    },
    stage2Blocked,
    fallbackStage: stage2Blocked ? stage2FallbackStage : undefined,
    parentJobId: (payload as any).retryParentJobId || undefined,
    timestamps,
  });

  // ═══ FINAL STATUS GUARD ═══
  const latestJobBeforeCompletion = await getJob(payload.jobId);
  if (isTerminalStatus(latestJobBeforeCompletion?.status)) {
    nLog(`[FINAL_STATUS_GUARD] Skipping late job completion update`, {
      jobId: payload.jobId,
      stage: "completion",
      status: latestJobBeforeCompletion?.status
    });
    return;
  }

  const stage2ValidationPassed = !payload.options.virtualStage
    || unifiedValidation?.passed === true
    || (!unifiedValidation && !stage2ValidationRisk);

  if (hasStage2 && !(await canCompleteStage2(stage2ValidationPassed, "stage2_final_complete"))) return;

  // Completion guard — full pipeline
  const mainGuard = canMarkJobComplete(latestJobBeforeCompletion as any, unifiedValidation as any, {
    outputUrl: committedResultUrl || pubFinalUrl,
    finalStageRan: committedFinalStageLabel,
    expectedFinalStage: hasStage2 ? "2" : (payload.options.declutter ? "1B" : "1A"),
  });
  logCompletionGuard(payload.jobId, mainGuard);
  if (!mainGuard.ok) {
    await safeWriteJobStatus(payload.jobId, { status: "failed", errorMessage: `completion_guard_block: ${mainGuard.reason}` }, "completion_guard_block");
    return;
  }

  // FIX 1: ATOMIC completion write - all fields in single updateJob call
  // This prevents race conditions where status API sees partial state
  await safeWriteJobStatus(payload.jobId, {
    // Core completion flags (written atomically)
    status: "complete",
    success: true,
    completed: true,
    currentStage: "finalizing",
    finalStage: committedFinalStageLabel,
    resultStage: committedFinalStageLabel,
    
    // URLs (all written together, no partial state possible)
    originalUrl: publishedOriginal?.url,
    resultUrl: committedResultUrl,
    imageUrl: committedResultUrl,
    stageUrls: {
      "1A": committedStage1AUrl,
      "1B": committedStage1BUrl,
      "2": committedStage2Url
    },
    
    // Stage outputs
    stageOutputs: {
      "1A": path1A,
      "1B": stage1BReady ? path1B : undefined,
      "2": stage2ArtifactReady ? stage2CandidatePath : undefined
    },
    
    // Version tracking
    resultVersionId: finalPathVersion?.versionId || undefined,
    
    // Metadata
    meta,
    parentJobId: (payload as any).retryParentJobId || undefined,
    retryInfo,
    
    // FIX 6: Lifecycle timestamps (for observability)
    timestamps: {
      queued: timestamps.queued,
      stage1AStart: timestamps.stage1AStart,
      stage1AEnd: timestamps.stage1AEnd,
      stage1BStart: timestamps.stage1BStart,
      stage1BEnd: timestamps.stage1BEnd,
      stage2Start: timestamps.stage2Start,
      stage2End: timestamps.stage2End,
      completed: timestamps.completed
    },
    
    // FIX 4: Timeout metadata
    stage2TimedOut: stage2TimedOut || undefined,
    
    // Validation results
    validation: (() => {
      const normalizedFlag = unifiedValidation?.normalized;
      if (unifiedValidation) {
        return {
          hardFail: unifiedValidation.hardFail,
          warnings: unifiedValidation.warnings,
          normalized: normalizedFlag,
          modeConfigured: structureValidatorMode,
          modeEffective: VALIDATION_BLOCKING_ENABLED ? "block" : "log",
          localBlockingEnabled: VALIDATION_BLOCKING_ENABLED,
          geminiConfirmationEnabled: GEMINI_CONFIRMATION_ENABLED,
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
          localBlockingEnabled: VALIDATION_BLOCKING_ENABLED,
          geminiConfirmationEnabled: GEMINI_CONFIRMATION_ENABLED,
          blockedStage: "2",
          fallbackStage: stage2FallbackStage,
          note: stage2BlockedReason,
        };
      }
      return undefined;
    })(),
    
    // Attempt tracking
    attempts: stage2AttemptsUsed || stage2MaxAttempts
      ? { current: stage2AttemptsUsed || undefined, max: stage2MaxAttempts || undefined }
      : undefined,
    fallbackUsed,
    blockedStage: stage2Blocked ? "2" : undefined,
    fallbackStage: stage2Blocked ? stage2FallbackStage : undefined,
    validationNote: stage2Blocked ? (stage2BlockedReason || "Stage 2 blocked") : undefined
  }, "final_complete");

  nLog("[worker] ✅ ATOMIC completion write completed", {
    jobId: payload.jobId,
    status: "complete",
    resultUrl: committedResultUrl,
    finalStage: committedFinalStageLabel,
    stage2TimedOut,
    timestamps: {
      total: timestamps.completed - timestamps.queued,
      stage1A: timestamps.stage1AEnd && timestamps.stage1AStart ? timestamps.stage1AEnd - timestamps.stage1AStart : null,
      stage2: timestamps.stage2End && timestamps.stage2Start ? timestamps.stage2End - timestamps.stage2Start : null
    }
  });

  // ===== POST-COMPLETION OPERATIONS (BEST-EFFORT, NON-BLOCKING) =====
  // These run AFTER marking the job complete to ensure the user sees results even if these fail

  // ===== USAGE TRACKING =====
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
  const billingStage1ASuccess = !!(pub1AUrl || pub1BUrl);
  const billingStage1BSuccess = (finalStageLabel === "1B" || finalStageLabel === "2")
    ? !!pub1BUrl
    : false;
  const billingStage2Success = committedFinalStageLabel === "2" ? !!committedStage2Url : false;
  const actualCharge = !billingStage1ASuccess
    ? 0
    : (sceneLabel === "exterior"
      ? 1
      : (billingStage1BSuccess && billingStage2Success ? 2 : 1));

  nLog("[BILLING_CHARGE_TELEMETRY]", {
    jobId: payload.jobId,
    imageId: payload.imageId,
    stage1ASuccess: billingStage1ASuccess,
    stage1BSuccess: billingStage1BSuccess,
    stage2Success: billingStage2Success,
    finalCharge: actualCharge,
    path: "main_pipeline",
  });

  try {
    await finalizeReservationFromWorker({
      jobId: payload.jobId,
      stage12Success,
      stage2Success,
      actualCharge,
    });
    nLog(`[BILLING] Finalized reservation for ${payload.jobId}: stage12=${stage12Success}, stage2=${stage2Success}`);
  } catch (billingErr) {
    // Billing must never block job completion, but log error for reconciliation
    nLog("[BILLING] Failed to finalize reservation (non-blocking):", (billingErr as any)?.message || billingErr);
    // In production, you might want to queue this for retry or manual reconciliation
  }

  // ✅ BILLING FINALIZATION: Compute final charge based on final output
  // This runs AFTER job is marked complete to ensure idempotent charging
  try {
    await finalizeImageChargeFromWorker({
      jobId: payload.jobId,
      stage1ASuccess: billingStage1ASuccess,
      stage1BSuccess: billingStage1BSuccess,
      stage2Success: billingStage2Success,
      sceneType: sceneLabel || "interior",
    });
  } catch (chargeErr) {
    // Billing errors must not crash the worker
    nLog("[BILLING] Failed to finalize charge (non-blocking):", (chargeErr as any)?.message || chargeErr);
  }

  // Persist finalized metadata with longer history TTL
  try {
    const existingMeta = await getJobMetadata(payload.jobId);
    const existingStageUrls = (existingMeta?.stageUrls || {}) as Record<string, string | null | undefined>;
    const stageUrlsMeta = mergeStageUrls(existingStageUrls, {
      "1A": pub1AUrl || null,
      stage1a: pub1AUrl || null,
      "1B": pub1BUrl || null,
      stage1b: pub1BUrl || null,
      "2": committedStage2Url,
      stage2: committedStage2Url,
      publish: committedResultUrl || null,
    });
    const resolvedResultFallback =
      resolveStageUrl(stageUrlsMeta, "2")
      || resolveStageUrl(stageUrlsMeta, "1B")
      || resolveStageUrl(stageUrlsMeta, "1A");
    const stage2ModeUsed: "refresh" | "empty" | undefined = hasStage2
      ? ((payload as any).options?.stagingPreference === "refresh"
        ? "refresh"
        : (payload as any).options?.stagingPreference === "full"
          ? "empty"
          : undefined)
      : undefined;

    const debugMeta = {
      ...(existingMeta?.debug || {}),
      stage2ModeUsed,
      validatorSummary: unifiedValidation || (stage2Blocked ? { blocked: true, reason: stage2BlockedReason } : undefined),
    };

    const mergedMeta: JobOwnershipMetadata = {
      userId: existingMeta?.userId || payload.userId,
      imageId: existingMeta?.imageId || payload.imageId,
      jobId: payload.jobId,
      createdAt: existingMeta?.createdAt || payload.createdAt || new Date().toISOString(),
      requestedStages: existingMeta?.requestedStages || buildRequestedStages(),
      stageUrls: stageUrlsMeta,
      resultUrl: pubFinalUrl || existingMeta?.resultUrl || resolvedResultFallback || undefined,
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
  
  // End memory tracking and log memory usage for this job
  const memoryReport = endMemoryTracking(payload.jobId);
  nLog(`[MEMORY] Job ${payload.jobId} completed - ${memoryReport}`);
  
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
    await safeWriteJobStatus(jobId, { status: "failed", errorMessage: "No mask provided for edit" }, "edit_no_mask");
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
  if (await checkStage2AlreadyFinal(jobId, "edit")) return;

  // Completion guard — edit jobs have no validator result
  const editJob = await getJob(jobId);
  const editGuard = canMarkJobComplete(editJob as any, null, {
    outputUrl: pub.url,
    finalStageRan: "edit",
    expectedFinalStage: "edit",
  });
  logCompletionGuard(jobId, editGuard);
  if (!editGuard.ok) {
    await safeWriteJobStatus(jobId, { status: "failed", errorMessage: `completion_guard_block: ${editGuard.reason}` }, "completion_guard_block");
    return;
  }

  // ===== EDIT FORK SAFETY =====
  // Edit jobs must never overwrite parent outputs — they always create a new
  // output record.  parentJobId + baselineStageUsed are stored for lineage.
  const editParentJobId = (payload as any).parentJobId || (payload as any).sourceJobId || undefined;
  const baselineStageUsed: string = (payload as any).baselineStage || "unknown";

  nLog(`[edit] parentJobId=${editParentJobId ?? "none"} baselineStage=${baselineStageUsed}`);

  // Guard: if pub.key collides with a parent output key, generate a new one
  // (in practice this never happens because publishImage uses Date.now() keys)
  if (pub.key && editParentJobId) {
    nLog(`[edit] output key=${pub.key} (unique per-publish, no overwrite risk)`);
  }

  await safeWriteJobStatus(
    jobId,
    {
      status: "complete",
      success: true,
      imageUrl: pub.url,
      meta: {
        ...payload,
        parentJobId: editParentJobId,
        baselineStageUsed,
        jobType: "edit",
      },
    },
    "edit_complete"
  );
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
    const jobId = (payload as any).jobId;
    await safeWriteJobStatus(jobId, { status: "processing" }, "job_start");
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
              stage: "edit", // ✅ PATCH 6: Mark as edit stage
              family: "edit" as any, // ✅ PATCH 6: Separate edit lineage from stage pipeline
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
          if (await checkStage2AlreadyFinal(regionPayload.jobId, "region-edit")) return;

          // Completion guard — region-edit jobs have no validator result
          const reJob = await getJob(regionPayload.jobId);
          const reGuard = canMarkJobComplete(reJob as any, null, {
            outputUrl: pub.url,
            finalStageRan: "edit",
            expectedFinalStage: "edit",
          });
          logCompletionGuard(regionPayload.jobId, reGuard);
          if (!reGuard.ok) {
            await safeWriteJobStatus(regionPayload.jobId, { status: "failed", errorMessage: `completion_guard_block: ${reGuard.reason}` }, "completion_guard_block");
            return;
          }

          await safeWriteJobStatus(
            regionPayload.jobId,
            {
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
                // ✅ PATCH 3: Tag edit jobs explicitly to prevent billing/retry confusion
                jobType: "region_edit",
                retryEligible: false, // Edit outputs cannot be retry baselines
                consumesCredits: false, // Edits are always FREE
                // Edit fork metadata
                parentJobId: (regionPayload as any).parentJobId || (regionPayload as any).sourceJobId || undefined,
                baselineStageUsed: (regionPayload as any).baselineStage || "unknown",
              },
            },
            "region_edit_complete"
          );
          nLog(`[edit] parentJobId=${(regionPayload as any).parentJobId ?? "none"} baselineStage=${(regionPayload as any).baselineStage ?? "unknown"}`);
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
          await safeWriteJobStatus((payload as any).jobId, { status: "failed", errorMessage: "unknown job type" }, "unknown_job_type");
        }
      } else {
        throw new Error("Job payload missing 'type' property or is not an object");
      }
    } catch (err: any) {
      nLog("[worker] job failed", err);
      
      // ✅ CHECK 1: Release reservation on job failure to prevent credit leaks
      // If job fails before reaching finalization, refund the reserved credits
      try {
        await finalizeReservationFromWorker({
          jobId,
          stage12Success: false, // Job failed - refund Stage 1/2 credits
          stage2Success: false,  // Job failed - refund Stage 2 credits
        });
        nLog(`[BILLING] Released reservation for failed job: ${jobId}`);
      } catch (billingErr) {
        nLog("[BILLING] Failed to release reservation on job failure (non-blocking):", (billingErr as any)?.message || billingErr);
      }
      
      await safeWriteJobStatus(jobId, { status: "failed", errorMessage: err?.message || "unhandled worker error" }, "worker_error");
      throw err;
    } finally {
      // Best-effort temp file cleanup — prevents /tmp from filling up
      try {
        if (jobId) cleanupTempFiles(jobId);
      } catch { /* ignore */ }
    }
  },
  {
    connection: { url: REDIS_URL },
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
    lockDuration: Number(process.env.BULLMQ_LOCK_DURATION_MS || 300_000), // 5 min — jobs run 2–5 min
  }
);

// Wire up shutdown handler reference
_workerRef = worker;

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

worker.on("error", (err) => {
  nLog(`[worker] ERROR event:`, err);
});

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
