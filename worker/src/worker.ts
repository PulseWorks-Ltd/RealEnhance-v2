import type { ComplianceVerdict } from "./ai/compliance";
import { Worker, Job } from "bullmq";
import { Queue, QueueEvents } from "bullmq";
import * as BullMQ from "bullmq";
import { JOB_QUEUE_NAME } from "@realenhance/shared/constants";
import {
  AnyJobPayload,
  EnhanceJobPayload,
  EditJobPayload,
  RegionEditJobPayload
} from "@realenhance/shared/types";
import { evaluateFairShare, markJobFinished, markJobStarted } from "@realenhance/shared";

import fs from "fs";
import sharp from "sharp";
import { randomUUID } from "crypto";

import { runStage1A } from "./pipeline/stage1A";
import { runStage1B } from "./pipeline/stage1B";
import { planStage2Layout, type Stage2LayoutPlan } from "./pipeline/layoutPlanner";
import {
  isStage2RetryableGenerationError,
  runGeminiStructuralReviewPro,
  resolveStage2MaxAttempts,
  resolveStage2Model,
  runStage2,
  runStage2GenerationAttempt,
} from "./pipeline/stage2";
import { classifyStructuralFailure, type StructuralFailureType } from "./pipeline/structuralRetryHelpers";
import { classifyStructuralConsensusCase } from "./pipeline/stage2StructuralConsensusBackstop";
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
import { getGeminiClient } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64, siblingOutPath } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";
import { publishImage } from "./utils/publish";
import { createDebugSignedUrl, isDebugImageUrlLoggingEnabled, logBaselineImageUrl } from "./utils/debugImageUrls";
import { downloadToTemp } from "./utils/remote";
import { isTerminalStatus, safeWriteJobStatus } from "./utils/statusUtils";
import { canMarkJobComplete, logCompletionGuard } from "./utils/completionGuard";
import { checkStageOutput } from "./utils/stageOutputGuard";
import { runStructuralCheck } from "./validators/structureValidatorClient";
import { getLocalValidatorMode, getGeminiValidatorMode, isGeminiBlockingEnabled, logValidationModes } from "./validators/validationModes";
import { validateStage1BStructure } from "./validators/geminiSemanticValidator";
import {
  runUnifiedValidation,
  logUnifiedValidationCompact,
  shouldInjectEvidence,
  type UnifiedValidationResult
} from "./validators/runValidation";
import { getStage2ValidationModeFromPromptMode } from "./validators/stage2ValidationMode";
import { shouldRetry as evidenceShouldRetry, classifyRisk, type ValidationEvidence } from "./validators/validationEvidence";
import { isEvidenceGatingEnabledForJob } from "./validators/evidenceGating";
import { isJobFailedFinal } from "./validators/stageRetryManager";
import {
  STAGE1B_OPENING_DELTA_STRUCTURAL_THRESHOLD,
  STAGE1B_NEW_WALL_RATIO_STRUCTURAL_THRESHOLD,
  hasStage1BStructuralSignal,
  isStage1BMinorReconstructionSignal,
} from "./validators/stageAwareConfig";
import { computeOpeningGeometrySignal } from "./validators/signalMetrics";
const STAGE1B_MAX_ATTEMPTS = Math.max(1, Number(process.env.STAGE1B_MAX_ATTEMPTS || 2));
const GEMINI_CONFIRM_MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_CONFIRM_MAX_RETRIES || 2));
const MAX_STAGE_RUNTIME_MS = Number(process.env.MAX_STAGE_RUNTIME_MS || 300000);
const SIGN_ALL_STAGE_OUTPUTS_ENABLED = isDebugImageUrlLoggingEnabled();
const STAGE_OUTPUT_SIGNED_URL_TTL_SECONDS = Math.max(
  1,
  Number(process.env.STAGE_OUTPUT_SIGNED_URL_TTL_SECONDS || 86400)
);
const VALIDATOR_LOGS_FOCUS = process.env.VALIDATOR_LOGS_FOCUS === "1";
const VALIDATOR_AUDIT_ENABLED = process.env.VALIDATOR_AUDIT === "1";
const STAGE2_ANCHOR_PLANNER_ENABLED = String(process.env.STAGE2_ANCHOR_PLANNER_ENABLED || "1") !== "0";
const STAGE2_ANCHOR_MIN_CONFIDENCE = Number(process.env.STAGE2_ANCHOR_MIN_CONFIDENCE || 0.7);
const STRUCTURAL_INVARIANT_MODEL = String(process.env.STRUCTURAL_INVARIANT_MODEL || "gemini-2.5-flash");
const COMPOSITE_LOCAL_VALIDATOR_FAIL_MODE: "log" | "block" =
  String(process.env.COMPOSITE_LOCAL_VALIDATOR_FAIL || "log").toLowerCase() === "block"
    ? "block"
    : "log";
const ENABLE_FINAL_STRUCTURAL_REVIEW = String(process.env.ENABLE_FINAL_STRUCTURAL_REVIEW ?? "true").toLowerCase() !== "false";
const STAGE1B_BLANK_STDDEV_MAX = Math.max(
  0.01,
  Number(process.env.STAGE1B_BLANK_STDDEV_MAX || 0.35)
);
const STAGE1B_BLANK_RANGE_MAX = Math.max(
  0,
  Number(process.env.STAGE1B_BLANK_RANGE_MAX || 4)
);
import { runSemanticStructureValidator } from "./validators/semanticStructureValidator";
import { runMaskedEdgeValidator } from "./validators/maskedEdgeValidator";
import { runUnifiedValidator, type Stage2LocalSignals } from "./validators/unifiedValidator";
import { detectCurtainRail } from "./validators/curtainRailDetector";
import {
  detectRelocation,
  extractStructuralBaseline,
  validateOpeningPreservation,
  type StructuralBaseline,
} from "./validators/openingPreservationValidator";
import { runEditOpeningsValidator } from "./validators/editOpeningsValidator";
import { canStage, logStagingBlocked, type SceneType } from "../../shared/staging-guard";
import type { StructuralInvariantViolationType } from "./validators/structuralInvariantDecision";
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
import { finalizeImageChargeFromWorker, startBillingFinalizationRetryLoop } from "./utils/billingFinalization.js";
import { applyFinalBlackEdgeGuard, assertNoDarkBorder, detectBlackCornerArtifact } from "./utils/finalBlackEdgeGuard";
import { buildStructuralConstraintBlock } from "./utils/structuralConstraintBuilder";
import { normalizeMaskBase64, normalizeMaskBufferToPng } from "./utils/mask";

const FINAL_BLACK_EDGE_GUARD_ENABLED = String(process.env.FINAL_BLACK_EDGE_GUARD || "").toLowerCase() === "true";
const STAGE1A_MAX_ATTEMPTS = Math.max(1, Number(process.env.STAGE1A_MAX_ATTEMPTS || 3));
// Temporary hard-disable until fairness flow is redesigned for BullMQ active-claim semantics.
const FAIR_SCHEDULER_ENABLED = false;
const logger = console;

function jobLogContext(job: any, extra: Record<string, any> = {}) {
  const source = (job && typeof job === "object" && "data" in job ? (job as any).data : job) || {};
  const fallbackImageName =
    source?.fileName ||
    source?.name ||
    source?.label ||
    source?.originalFilename ||
    source?.imageId ||
    "unknown";

  return {
    jobId: String(source?.jobId || (job as any)?.id || "unknown"),
    imageName: source?.input?.fileName || source?.input?.name || fallbackImageName,
    stage: source?.stage || source?.currentStage || "unknown",
    ...extra,
  };
}

function logJobErrorAndThrow(job: any, reason: string, extra: Record<string, any> = {}): never {
  logger.error("JOB_ERROR", jobLogContext(job, {
    event: "JOB_ERROR",
    reason,
    ...extra,
  }));
  throw new Error(reason);
}

function shouldLog(eventType?: string): boolean {
  if (!VALIDATOR_LOGS_FOCUS) return true;

  const allowedEvents = new Set([
    "SYSTEM_START",
    "SYSTEM_ERROR",
    "UNHANDLED_EXCEPTION",
    "AWS_S3_FAILURE",
    "MODEL_FAILURE",
    "FATAL_RETRY_EXHAUSTION",
    "STAGE_OUTPUT_SIGNED",
    "VALIDATION_RESULT",
    "STAGE_RETRY",
    "JOB_ATTEMPT_SUMMARY",
  ]);

  return eventType ? allowedEvents.has(eventType) : false;
}

function logEvent(eventType: string, payload: Record<string, any> = {}) {
  if (!shouldLog(eventType)) return;
  console.log(JSON.stringify({ event: eventType, ...payload }));
}

function logStructured(event: string, payload: Record<string, any>) {
  try {
    logEvent(event, payload);
  } catch (err) {
    if (!VALIDATOR_LOGS_FOCUS) {
      nLog("[STRUCTURED_LOG_ERROR]", {
        event,
        error: (err as any)?.message || String(err),
      });
    }
    console.error("[SYSTEM_ERROR] structured log failure", err);
  }
}

type ForensicAttemptEntry = {
  attemptNumber: number;
  pipelineStage: "1A" | "2";
  model: string;
  retryReason: string;
  retryTrigger: string;
  validatorWarnings: string[];
  decisionSource: "local" | "gemini" | "consensus";
  compositeDecision: string;
  geminiConfirmation: boolean;
  geminiResult: "pass" | "fail";
  candidateUrl: string | null;
  outputUrl: string | null;
  artifactUrls: string[];
};

type ForensicJobEntry = {
  jobId: string;
  imageName: string;
  stagingStyle: string;
  uploadUrl: string | null;
  stage1AUrl: string | null;
  attempts: ForensicAttemptEntry[];
  finalStatus: string;
  warningsCount: number;
  hardFail: boolean;
  completionGuard: string;
  finalOutputUrl: string | null;
};

type ForensicBatchState = {
  batchId: string;
  jobs: Map<string, ForensicJobEntry>;
  activeJobIds: Set<string>;
};

const batchForensicCollectors = new Map<string, ForensicBatchState>();
const forensicJobBatchIndex = new Map<string, string>();

const DEFAULT_STAGING_STYLE = "standard_listing";

const regionEditRolloutTelemetry = {
  total: 0,
  openingsPass: 0,
  openingsFail: 0,
  retries: 0,
};

function classifyOutsideLeakPct(pct: number | null): "none" | "soft_anomaly" | "real_leak" | "unknown" {
  if (!Number.isFinite(pct as number)) return "unknown";
  const value = Number(pct);
  if (value <= 0.2) return "none";
  if (value <= 1) return "soft_anomaly";
  return "real_leak";
}

async function computeOutsideMaskChangedPct(opts: {
  baseImagePath: string;
  editedImagePath: string;
  mask: Buffer;
}): Promise<number | null> {
  try {
    const projectionDilatePx = (width: number, height: number): number => {
      const scaled = Math.round(Math.max(width, height) * 0.006);
      return Math.max(3, Math.min(12, scaled || 5));
    };

    const baseRaw = await sharp(opts.baseImagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const editedRaw = await sharp(opts.editedImagePath)
      .resize(baseRaw.info.width, baseRaw.info.height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const allowedMaskArtifactPath = `${opts.editedImagePath}.allowed-mask.png`;
    const hasAllowedMaskArtifact = fs.existsSync(allowedMaskArtifactPath);
    const allowedMaskSource = hasAllowedMaskArtifact
      ? await fs.promises.readFile(allowedMaskArtifactPath)
      : opts.mask;

    let allowedMaskPipeline = sharp(allowedMaskSource)
      .removeAlpha()
      .grayscale()
      .resize(baseRaw.info.width, baseRaw.info.height, {
        fit: "contain",
        position: "top-left",
        background: { r: 0, g: 0, b: 0, alpha: 1 },
        kernel: sharp.kernel.nearest,
      })
      .threshold(127, { grayscale: true });

    if (!hasAllowedMaskArtifact) {
      allowedMaskPipeline = allowedMaskPipeline.dilate(projectionDilatePx(baseRaw.info.width, baseRaw.info.height));
    }

    const allowedMaskRaw = await allowedMaskPipeline
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = baseRaw.info.width * baseRaw.info.height;
    if (pixels === 0) return null;

    let outsideCount = 0;
    let outsideChanged = 0;
    const changeThreshold = 14;
    for (let i = 0; i < pixels; i += 1) {
      const allowedValue = allowedMaskRaw.data[i] ?? 0;
      if (allowedValue > 127) continue;
      outsideCount += 1;

      const idx = i * 3;
      const dr = Math.abs((baseRaw.data[idx] ?? 0) - (editedRaw.data[idx] ?? 0));
      const dg = Math.abs((baseRaw.data[idx + 1] ?? 0) - (editedRaw.data[idx + 1] ?? 0));
      const db = Math.abs((baseRaw.data[idx + 2] ?? 0) - (editedRaw.data[idx + 2] ?? 0));
      if (dr + dg + db >= changeThreshold) {
        outsideChanged += 1;
      }
    }

    if (outsideCount === 0) return 0;
    return Number(((outsideChanged / outsideCount) * 100).toFixed(3));
  } catch (err) {
    nLog("[region-edit-telemetry] outside-mask delta calc failed:", (err as any)?.message || err);
    return null;
  }
}

function normalizeForensicStagingStyle(raw: unknown): string {
  const base = String(raw ?? "").trim().toLowerCase();
  if (!base) return DEFAULT_STAGING_STYLE;

  const aliases: Record<string, string> = {
    standard_listing: "standard_listing",
    standard: "standard_listing",
    "standard listing": "standard_listing",
    family_home: "family_home",
    "family home": "family_home",
    urban_apartment: "urban_apartment",
    "urban apartment": "urban_apartment",
    high_end_luxury: "high_end_luxury",
    "high end luxury": "high_end_luxury",
    "high-end luxury": "high_end_luxury",
    country_lifestyle: "country_lifestyle",
    "country lifestyle": "country_lifestyle",
    "country / lifestyle": "country_lifestyle",
    lived_in_rental: "lived_in_rental",
    "lived in rental": "lived_in_rental",
    "lived-in rental": "lived_in_rental",
  };

  return aliases[base] || DEFAULT_STAGING_STYLE;
}

function normalizeWorkerUrl(urlValue?: string | null): string {
  if (!urlValue) return "";
  try {
    const parsed = new URL(urlValue);
    ["v", "t", "ts", "cb", "cacheBust"].forEach((key) => parsed.searchParams.delete(key));
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(urlValue);
  }
}

function resolveStage1AFromWorkerJob(jobRec: any): string | undefined {
  const stageUrls = (jobRec?.stageUrls || {}) as Record<string, string | null | undefined>;
  const candidates = [stageUrls.stage1A, stageUrls["1A"], stageUrls["1"]]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (candidates.length > 0) return candidates[0];
  return undefined;
}

function inferForensicBatchId(payload: any): string {
  const fromPayload =
    payload?.retryClientBatchId || payload?.clientBatchId || payload?.batchId || payload?.listingId;
  if (fromPayload) return String(fromPayload);

  const jobId = String(payload?.jobId || "");
  const batchPrefix = jobId.match(/^(batch_[^_]+_[^_]+)/)?.[1];
  if (batchPrefix) return batchPrefix;

  return `single_${jobId || Date.now()}`;
}

function beginBatchForensicForJob(payload: any) {
  const jobId = String(payload?.jobId || "");
  if (!jobId) return;
  const batchId = inferForensicBatchId(payload);
  let batch = batchForensicCollectors.get(batchId);
  if (!batch) {
    batch = {
      batchId,
      jobs: new Map<string, ForensicJobEntry>(),
      activeJobIds: new Set<string>(),
    };
    batchForensicCollectors.set(batchId, batch);
  }

  if (!batch.jobs.has(jobId)) {
    batch.jobs.set(jobId, {
      jobId,
      imageName: String(payload?.label || payload?.originalFilename || payload?.imageId || "unknown"),
      stagingStyle: normalizeForensicStagingStyle(payload?.options?.stagingStyle),
      uploadUrl: payload?.remoteOriginalUrl || null,
      stage1AUrl: null,
      attempts: [],
      finalStatus: "processing",
      warningsCount: 0,
      hardFail: false,
      completionGuard: "unknown",
      finalOutputUrl: null,
    });
  }

  batch.activeJobIds.add(jobId);
  forensicJobBatchIndex.set(jobId, batchId);
}

function upsertForensicJobSnapshot(jobId: string, patch: Partial<ForensicJobEntry>) {
  const batchId = forensicJobBatchIndex.get(jobId);
  if (!batchId) return;
  const batch = batchForensicCollectors.get(batchId);
  if (!batch) return;

  const current = batch.jobs.get(jobId) || {
    jobId,
    imageName: "unknown",
    stagingStyle: DEFAULT_STAGING_STYLE,
    uploadUrl: null,
    stage1AUrl: null,
    attempts: [],
    finalStatus: "processing",
    warningsCount: 0,
    hardFail: false,
    completionGuard: "unknown",
    finalOutputUrl: null,
  };

  const next: ForensicJobEntry = {
    ...current,
    ...patch,
    attempts: patch.attempts ?? current.attempts,
  };
  batch.jobs.set(jobId, next);
}

function emitBatchForensicSummary(batch: ForensicBatchState) {
  const jobs = [...batch.jobs.values()].sort((a, b) => a.jobId.localeCompare(b.jobId));
  const safeStyle = (style: unknown) => normalizeForensicStagingStyle(style);
  const jobsTotal = jobs.length;
  const jobsCompleted = jobs.filter((j) => {
    const status = String(j.finalStatus).toLowerCase();
    return status === "complete" || status === "completed";
  }).length;
  const jobsFailed = jobs.filter((j) => String(j.finalStatus).toLowerCase() === "failed").length;
  const avgStage2Attempts =
    jobsTotal > 0
      ? jobs.reduce((sum, job) => sum + (job.attempts?.length || 0), 0) / jobsTotal
      : 0;

  nLog("[BATCH_FORENSIC_SUMMARY]");
  nLog(`batch=${batch.batchId}`);
  nLog(`jobs=${jobsTotal}`);
  nLog(`completed=${jobsCompleted}`);
  nLog(`failed=${jobsFailed}`);
  nLog(`avg_attempts=${avgStage2Attempts.toFixed(2)}`);

  const styleDistribution = jobs.reduce<Record<string, number>>((acc, job) => {
    const style = safeStyle(job.stagingStyle);
    acc[style] = (acc[style] || 0) + 1;
    return acc;
  }, {});
  nLog("STAGING STYLE DISTRIBUTION");
  for (const [style, count] of Object.entries(styleDistribution).sort((a, b) => a[0].localeCompare(b[0]))) {
    nLog(`${style}: ${count}`);
  }

  for (const job of jobs) {
    nLog(`JOB ${job.jobId}`);
    nLog(`image=${job.imageName || "unknown"}`);
    nLog(`stagingStyle=${safeStyle(job.stagingStyle)}`);
    nLog(`upload=${job.uploadUrl || ""}`);
    nLog(`stage1A=${job.stage1AUrl || ""}`);

    const attempts = [...(job.attempts || [])].sort((a, b) => a.attemptNumber - b.attemptNumber);
    for (const attempt of attempts) {
      nLog(`ATTEMPT ${attempt.attemptNumber}`);
      nLog(`stagingStyle=${safeStyle(job.stagingStyle)}`);
      nLog(`stage=${attempt.pipelineStage}`);
      nLog(`model=${attempt.model}`);
      nLog(`retry_reason=${attempt.retryReason}`);
      nLog(`retry_trigger=${attempt.retryTrigger}`);
      nLog(`validator_warnings=${attempt.validatorWarnings.join("|")}`);
      nLog(`decision_source=${attempt.decisionSource}`);
      nLog(`composite=${attempt.compositeDecision}`);
      nLog(`gemini_confirmation=${attempt.geminiConfirmation}`);
      nLog(`gemini_result=${attempt.geminiResult}`);
      nLog(`candidate=${attempt.candidateUrl || ""}`);
      nLog(`output=${attempt.outputUrl || ""}`);
      nLog(`artifact_urls=${(attempt.artifactUrls || []).join(",")}`);
    }

    nLog("FINAL");
    nLog(`status=${job.finalStatus}`);
    nLog(`warnings=${job.warningsCount}`);
    nLog(`completion_guard=${job.completionGuard}`);
    nLog(`output=${job.finalOutputUrl || ""}`);
  }
}

async function finalizeBatchForensicForJob(jobId: string, payload: any) {
  const batchId = forensicJobBatchIndex.get(jobId);
  if (!batchId) return;
  const batch = batchForensicCollectors.get(batchId);
  if (!batch) return;

  try {
    const current = await getJob(jobId);
    const status = String((current as any)?.status || "unknown").toLowerCase();
    const stageUrls = ((current as any)?.stageUrls || {}) as Record<string, string | null | undefined>;
    const validation = ((current as any)?.validation || {}) as any;
    const errorMessage = String((current as any)?.errorMessage || "");

    const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
    const completionGuard = errorMessage.includes("completion_guard_block")
      ? "blocked"
      : (status === "complete" ? "passed" : "unknown");

    upsertForensicJobSnapshot(jobId, {
      uploadUrl: (current as any)?.originalUrl || payload?.remoteOriginalUrl || null,
      stage1AUrl: stageUrls["1A"] || stageUrls["stage1a"] || null,
      finalStatus: status,
      warningsCount: warnings.length,
      hardFail: validation?.hardFail === true || status === "failed",
      completionGuard,
      finalOutputUrl: (current as any)?.finalOutputUrl || (current as any)?.resultUrl || (current as any)?.imageUrl || null,
    });
  } catch {
    // Non-blocking forensic path.
  }

  batch.activeJobIds.delete(jobId);
  if (batch.activeJobIds.size === 0) {
    try {
      emitBatchForensicSummary(batch);
    } catch (err) {
      console.warn("[FORENSIC_SUMMARY_ERROR]", err);
    }
    batchForensicCollectors.delete(batchId);
    for (const key of batch.jobs.keys()) {
      forensicJobBatchIndex.delete(key);
    }
  }
}

async function signS3Object(params: { bucket: string; key: string; expiresIn: number }): Promise<string> {
  const rawRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const region = rawRegion.match(/([a-z]{2}-[a-z0-9-]+-\d)/i)?.[1]?.toLowerCase() ?? rawRegion.toLowerCase();
  const importer: any = new Function("p", "return import(p)");
  const s3Mod: any = await importer("@aws-sdk/client-s3");
  const presignMod: any = await importer("@aws-sdk/s3-request-presigner");
  const { S3Client, GetObjectCommand } = s3Mod;
  const { getSignedUrl } = presignMod;
  const clientConfig: any = { region };
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  const s3 = new S3Client(clientConfig);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: params.bucket, Key: params.key }), {
    expiresIn: params.expiresIn,
  });
}

type Stage1BClutterHeuristicResult = {
  score: number;
  level: "low" | "medium" | "high";
};

type Stage1BWallDeltaResult = {
  hardFail: boolean;
  violationType?: "wall_plane_expansion";
  baselineArea: number;
  candidateArea: number;
  deltaRatio: number;
  newWallRatio: number;
  planeExpansionRatio: number;
};

type CompositeLocalMetrics = {
  structuralDeviationDeg: number | null;
  maskedDriftPct: number;
  semanticWallDriftPct: number;
  semanticOpeningsDeltaTotal: number;
  maskedOpeningsDeltaTotal: number;
};

type CompositeLocalEvaluation = {
  failed: boolean;
  maskedHigh: boolean;
  semanticHigh: boolean;
  openingsChanged: boolean;
  reason: string;
  structDegMissing: boolean;
};

type Stage2StructuralDegreeMetric = {
  valueDeg: number | null;
  source: "line_edge_evidence" | "unified_drift_evidence" | "opencv_deviation_score" | "none";
  available: boolean;
  reasonIfUnavailable: string | null;
};

type StructuralTopologyCheckResult = {
  result: "PASS" | "FAIL";
  explanation: string;
  rawText: string;
};

type OpeningProfile = "declutter_to_stage" | "empty_to_stage";

type OpeningPolicySignals = {
  structuralDegree: number;
  maskedDriftPct: number;
  semanticWallDriftPct: number;
  structuralMaskFailure: boolean;
  geminiStructuredHighConfidence: boolean;
  windowsBefore: number;
  windowsAfter: number;
  doorsBefore: number;
  doorsAfter: number;
};

function determineOpeningProfile(payload: EnhanceJobPayload): OpeningProfile {
  const declutterSelected = payload.options?.declutter === true;
  const declutterMode = String((payload.options as any)?.declutterMode || "").toLowerCase();
  const stage2SourceStage = String((payload.options as any)?.sourceStage || "").toLowerCase();
  const stage2Variant = String((payload.options as any)?.stage2Variant || "").toLowerCase();

  const cameFromStage1B =
    declutterSelected ||
    declutterMode === "light" ||
    declutterMode === "stage-ready" ||
    stage2SourceStage.startsWith("1b") ||
    stage2Variant === "2a";

  return cameFromStage1B ? "declutter_to_stage" : "empty_to_stage";
}

function applyDeclutterOpeningPolicy(signals: OpeningPolicySignals): { hardFail: boolean; reasons: string[] } {
  const openingDelta =
    signals.windowsBefore !== signals.windowsAfter ||
    signals.doorsBefore !== signals.doorsAfter;

  if (signals.structuralDegree >= 90) {
    return { hardFail: true, reasons: ["declutter_extreme_structural_destruction"] };
  }

  if (signals.structuralMaskFailure && signals.maskedDriftPct >= 75) {
    return { hardFail: true, reasons: ["declutter_structural_mask_collapse"] };
  }

  if (openingDelta) {
    return { hardFail: false, reasons: ["opening_count_drop_detected"] };
  }

  return { hardFail: false, reasons: [] };
}

function applyEmptyOpeningPolicy(signals: OpeningPolicySignals): { hardFail: boolean; reasons: string[] } {
  const openingDelta =
    signals.windowsBefore !== signals.windowsAfter ||
    signals.doorsBefore !== signals.doorsAfter;

  if (signals.structuralDegree >= 35) {
    return { hardFail: true, reasons: ["empty_moderate_structural_deviation"] };
  }

  if (signals.maskedDriftPct >= 45 && signals.structuralMaskFailure) {
    return { hardFail: true, reasons: ["empty_structural_mask_degradation"] };
  }

  if (openingDelta) {
    return { hardFail: false, reasons: ["opening_count_drop_detected"] };
  }

  if (signals.maskedDriftPct >= 45 && signals.structuralDegree >= 25) {
    return { hardFail: true, reasons: ["empty_combined_drift_rule"] };
  }

  return { hardFail: false, reasons: [] };
}

async function runStructuralTopologyCheck(opts: {
  stage1APath: string;
  stage2Path: string;
  model: string;
}): Promise<StructuralTopologyCheckResult> {
  const prompt = `You are performing a structural topology verification.

Compare the ORIGINAL image (Stage 1A) and the STAGED image (Stage 2).

You must ignore furniture, decor, lighting, styling, rugs, and props.

If furniture overlaps walls, assume the wall behind remains unchanged unless there is clear visible architectural alteration.

Evaluate ONLY architectural structure that is visible in both images.

Check for clear, unambiguous structural changes:

1. Recess depth preservation  
   - Has a recessed wall been flattened or pushed back?

2. Column or return wall projection  
   - Has a projecting column or wall return disappeared or been made flush?

3. Plane adjacency relationships  
   - Has a wall plane extended into previously open space?

4. Built-in spatial integrity  
   - Has a kitchen island shifted relative to floor tile grid, ceiling fixtures, or surrounding walls?

5. Corner topology  
   - Have inside or outside corners changed position or depth?

Only return FAIL if architectural change is clearly visible and cannot be explained by furniture placement.

Do NOT fail if:
- Furniture sits near a corner
- Furniture partially obscures a recess
- Decor visually bridges a wall edge
- Minor perspective compression occurs

If uncertain, return PASS.

Return ONLY:
PASS or FAIL
plus one short explanation sentence.`;

  const ai = getGeminiClient();
  const before = toBase64(opts.stage1APath).data;
  const after = toBase64(opts.stage2Path).data;

  const response = await (ai as any).models.generateContent({
    model: opts.model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "IMAGE_BEFORE:" },
          { inlineData: { mimeType: "image/webp", data: before } },
          { text: "IMAGE_AFTER:" },
          { inlineData: { mimeType: "image/webp", data: after } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.5,
      maxOutputTokens: 512,
    },
  } as any);

  const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
  const rawText = textParts.map((p: any) => p?.text || "").join(" ").trim();
  const normalized = rawText.replace(/\s+/g, " ").trim();
  const firstToken = (normalized.match(/^\s*(PASS|FAIL)\b/i)?.[1] || "PASS").toUpperCase();
  const result: "PASS" | "FAIL" = firstToken === "FAIL" ? "FAIL" : "PASS";
  const explanation = normalized
    .replace(/^\s*(PASS|FAIL)\s*[:\-]?\s*/i, "")
    .trim() || (result === "PASS" ? "No clear structural topology change detected." : "Structural topology change detected.");

  return {
    result,
    explanation,
    rawText,
  };
}

function evaluateCompositeLocalValidator(metrics: CompositeLocalMetrics): CompositeLocalEvaluation {
  const maskedHigh = metrics.maskedDriftPct > 85;
  const semanticHigh = metrics.semanticWallDriftPct > 50;
  const maskedArchitecturalDriftPct = metrics.maskedDriftPct;
  const semanticWallDriftPct = metrics.semanticWallDriftPct;
  const openingsChanged =
    metrics.semanticOpeningsDeltaTotal !== 0 ||
    metrics.maskedOpeningsDeltaTotal !== 0;

  const structDegMissing = metrics.structuralDeviationDeg === null || !Number.isFinite(metrics.structuralDeviationDeg);
  const moderateDrift = maskedArchitecturalDriftPct >= 60 || semanticWallDriftPct >= 60;
  const reason = openingsChanged
    ? "opening_delta_detected"
    : moderateDrift
      ? "moderate_wall_drift"
      : "none";

  return {
    failed: false,
    maskedHigh,
    semanticHigh,
    openingsChanged,
    reason,
    structDegMissing,
  };
}

function resolveStage2StructuralDegree(unifiedValidation: any): Stage2StructuralDegreeMetric {
  const rawLineEdge = unifiedValidation?.raw?.lineEdge?.details;
  const lineVertical = rawLineEdge?.verticalDeviation;
  const lineHorizontal = rawLineEdge?.horizontalDeviation;
  const hasLineVertical = typeof lineVertical === "number" && Number.isFinite(lineVertical);
  const hasLineHorizontal = typeof lineHorizontal === "number" && Number.isFinite(lineHorizontal);

  const lineEdgeAngleDeg = (hasLineVertical || hasLineHorizontal)
    ? Math.max(
        hasLineVertical ? Number(lineVertical) : 0,
        hasLineHorizontal ? Number(lineHorizontal) : 0,
      )
    : null;

  const unifiedDriftAngleRaw =
    unifiedValidation?.evidence?.drift?.angleDegrees ??
    unifiedValidation?.evidence?.drift?.angleDeg;
  const unifiedDriftAngleDeg =
    typeof unifiedDriftAngleRaw === "number" && Number.isFinite(unifiedDriftAngleRaw)
      ? Number(unifiedDriftAngleRaw)
      : null;

  const opencvDeviationRaw =
    unifiedValidation?.raw?.structureValidator?.details?.deviationScore ??
    unifiedValidation?.raw?.structure?.details?.deviationScore ??
    unifiedValidation?.raw?.opencvStructure?.details?.deviationScore;
  const opencvDeviationDeg =
    typeof opencvDeviationRaw === "number" && Number.isFinite(opencvDeviationRaw)
      ? Number(opencvDeviationRaw)
      : null;

  const logResolverInputs = (
    selectedSource: Stage2StructuralDegreeMetric["source"],
    valueDeg: number | null
  ) => {
    nLog("[STAGE2_STRUCTURAL_DEGREE_RESOLVER_INPUTS]", {
      lineEdgeAngleDeg,
      unifiedDriftAngleDeg,
      opencvDeviationDeg,
      selectedSource,
      valueDeg,
    });
  };

  if ((hasLineVertical || hasLineHorizontal) && lineEdgeAngleDeg !== null && lineEdgeAngleDeg > 0) {
    const valueDeg = lineEdgeAngleDeg;
    logResolverInputs("line_edge_evidence", valueDeg);
    return {
      valueDeg,
      source: "line_edge_evidence",
      available: true,
      reasonIfUnavailable: null,
    };
  }

  if (unifiedDriftAngleDeg !== null && unifiedDriftAngleDeg > 0) {
    logResolverInputs("unified_drift_evidence", unifiedDriftAngleDeg);
    return {
      valueDeg: unifiedDriftAngleDeg,
      source: "unified_drift_evidence",
      available: true,
      reasonIfUnavailable: null,
    };
  }

  if (opencvDeviationDeg !== null) {
    logResolverInputs("opencv_deviation_score", opencvDeviationDeg);
    return {
      valueDeg: opencvDeviationDeg,
      source: "opencv_deviation_score",
      available: true,
      reasonIfUnavailable: null,
    };
  }

  logResolverInputs("none", null);

  return {
    valueDeg: null,
    source: "none",
    available: false,
    reasonIfUnavailable: "no_structural_signal",
  };
}

// --- STAGE 2 STRUCTURAL ESCALATION GATE ---
// Deterministic invariant-based escalation to Gemini structural review
function shouldEscalateToGeminiStructuralReview(params: {
  windowsBefore?: number | null;
  windowsAfter?: number | null;
  doorsBefore?: number | null;
  doorsAfter?: number | null;
  closetDoorsBefore?: number | null;
  closetDoorsAfter?: number | null;
  builtInRemovalDetected?: boolean;
  wallDriftPct?: number | null;
  maskedEdgeDriftPct?: number | null;
}): boolean {
  const {
    windowsBefore,
    windowsAfter,
    doorsBefore,
    doorsAfter,
    closetDoorsBefore,
    closetDoorsAfter,
    builtInRemovalDetected,
    wallDriftPct,
    maskedEdgeDriftPct,
  } = params;

  const normalizeCount = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const hasOpeningCountSignal =
    typeof windowsBefore === "number" ||
    typeof windowsAfter === "number" ||
    typeof doorsBefore === "number" ||
    typeof doorsAfter === "number" ||
    typeof closetDoorsBefore === "number" ||
    typeof closetDoorsAfter === "number";

  const totalOpeningsBefore =
    normalizeCount(windowsBefore) +
    normalizeCount(doorsBefore) +
    normalizeCount(closetDoorsBefore);

  const totalOpeningsAfter =
    normalizeCount(windowsAfter) +
    normalizeCount(doorsAfter) +
    normalizeCount(closetDoorsAfter);

  const openingCountDecrease =
    hasOpeningCountSignal && totalOpeningsAfter < totalOpeningsBefore;

  const extremeEnvelopeContraction =
    typeof wallDriftPct === "number" &&
    typeof maskedEdgeDriftPct === "number" &&
    wallDriftPct >= 70 &&
    maskedEdgeDriftPct >= 40;

  return (
    openingCountDecrease ||
    builtInRemovalDetected === true ||
    extremeEnvelopeContraction
  );
}

type Stage1BGeminiResult = Awaited<ReturnType<typeof validateStage1BStructure>>;
type GeminiVoteDecision = "pass" | "fail";
type Stage1BPolicyMode = "DECLUTTER" | "FULL_FURNITURE_REMOVAL";

type Stage1BPolicyDecision = {
  effectiveHardFail: boolean;
  effectiveViolationType?: string;
  effectiveReasons: string[];
  openingSignal?: boolean;
  layoutRisk?: boolean;
  openingViolationType?: "door_state_changed" | "opening_aperture_expanded" | null;
};

type Stage1BFullGeminiValidationResult = {
  passed: boolean;
  failReasons: string[];
  confidence: number;
  notes: string;
};

const STAGE1B_FULL_FURNITURE_VALIDATOR_PROMPT = `You are validating Stage 1B FULL_FURNITURE_REMOVAL output against Stage 1A baseline.

You will receive two images:
- IMAGE_STAGE1A_BASELINE: original enhanced image (before full furniture removal)
- IMAGE_STAGE1B_RESULT: full furniture removal result

Validation scope:
1) Structural identity
- Same room layout and envelope
- No wall additions/removals/reshaping
- No camera/viewpoint shift that changes room identity

CRITICAL VALIDATION CRITERION: Would a buyer who has physically walked through this property recognize the resulting image as the exact same room? If the proportions, window sizes, or architectural layout have been altered such that the room feels "different" or "enhanced" rather than just "emptied," you must return a FAIL.

2) Openings integrity
- Openings must still exist (windows, doors, walk-throughs)
- Ignore occlusion by generated content
- Fail if an opening appears or expands beyond the confidently visible boundary in the input
- Any opening not 100% identifiable in the input is hallucination in this stage
- Closed doors must remain closed; open doors must remain open
- If an existing opening's visible aperture increases materially, return FAIL

3) Fixture preservation
- Fixed fixtures/built-ins should remain (lights, vents, fixed joinery)

4) Catastrophic reconstruction
- Output must still be clearly the same physical room

Return JSON only with exactly:
{
  "passed": boolean,
  "failReasons": string[],
  "confidence": number,
  "notes": string
}

Guidance:
- Use confidence from 0 to 1.
- Keep failReasons concise machine-friendly tokens.
- If opening-boundary evidence is ambiguous, return passed=false with failReasons including "ambiguous_opening_change".
- Recommended failReasons when applicable: "opening_hallucination", "opening_aperture_expanded", "door_state_changed", "ambiguous_opening_change".`;

async function runStage1BFullFurnitureGeminiValidation(opts: {
  stage1APath: string;
  stage1BPath: string;
  promptAppend?: string;
  modelOverride?: string;
}): Promise<Stage1BFullGeminiValidationResult> {
  const ai = getGeminiClient();
  const existingModelSelection =
    process.env.GEMINI_STAGE1B_FULL_VALIDATOR_MODEL ||
    process.env.GEMINI_VALIDATOR_MODEL_STRONG ||
    "gemini-2.5-pro";
  const model = opts.modelOverride || existingModelSelection;
  const stage1A = toBase64(opts.stage1APath).data;
  const stage1B = toBase64(opts.stage1BPath).data;
  const validationPrompt = opts.promptAppend
    ? `${STAGE1B_FULL_FURNITURE_VALIDATOR_PROMPT}\n\n${opts.promptAppend}`
    : STAGE1B_FULL_FURNITURE_VALIDATOR_PROMPT;

  try {
    const response = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: validationPrompt },
            { text: "IMAGE_STAGE1A_BASELINE:" },
            { inlineData: { mimeType: "image/webp", data: stage1A } },
            { text: "IMAGE_STAGE1B_RESULT:" },
            { inlineData: { mimeType: "image/webp", data: stage1B } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        topP: 1,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    } as any);

    const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
    const rawText = textParts.map((p: any) => p?.text || "").join("\n").trim();
    const cleaned = rawText.replace(/```json|```/gi, "").trim();
    const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
    const parsed = JSON.parse(jsonCandidate);

    const passed = parsed?.passed === true;
    const failReasons = Array.isArray(parsed?.failReasons)
      ? parsed.failReasons.map((r: any) => String(r)).filter((r: string) => r.length > 0)
      : [];
    const rawConfidence = Number(parsed?.confidence ?? 0);
    const confidence = Number.isFinite(rawConfidence)
      ? (rawConfidence > 1 ? Math.max(0, Math.min(1, rawConfidence / 100)) : Math.max(0, Math.min(1, rawConfidence)))
      : 0;
    const notes = typeof parsed?.notes === "string" ? parsed.notes : "";

    return {
      passed,
      failReasons,
      confidence,
      notes,
    };
  } catch (err: any) {
    return {
      passed: false,
      failReasons: ["full_validator_invalid_response"],
      confidence: 0,
      notes: err?.message || "invalid validator response",
    };
  }
}

async function evaluateStage1BLightPolicy(input: {
  jobId: string;
  attemptNo: number;
  path1A: string;
  candidate: string;
  stage1BStructuralDeviationDeg: number;
  structureResult: Awaited<ReturnType<typeof validateStage1BStructure>>;
  wallDelta: { deltaRatio: number; newWallRatio: number; hardFail: boolean; planeExpansionRatio: number };
  openingCountDelta: number;
  suspiciousWallExpansion: boolean;
  stage1BSemanticWallDriftPct: number;
  stage1BMaskedDriftPct: number;
  stage1BConsensusClassification: { mode: string; derivedWarnings: number };
  stage1BMinorReconstructionSignal: boolean;
}): Promise<Stage1BPolicyDecision> {
  const beforeOpeningCount = input.structureResult?.beforeOpeningCount;
  const afterOpeningCount = input.structureResult?.afterOpeningCount;

  const openingRemovalDetected =
    typeof beforeOpeningCount === "number" &&
    typeof afterOpeningCount === "number" &&
    afterOpeningCount < beforeOpeningCount;

  const openingChangeSignificant = input.structureResult?.openingChangeSignificant !== false;
  const openingMinorDriftTolerated =
    (input.structureResult?.openingToleranceReason === "opening_minor_drift") ||
    (!openingChangeSignificant && (input.structureResult?.violationType === "opening_change" || openingRemovalDetected));

  const openingRemovalHardFail = openingRemovalDetected && openingChangeSignificant;

  if (openingRemovalHardFail) {
    nLog("[STAGE1B_OPENING_REMOVAL_DETECTED]", {
      beforeOpeningCount,
      afterOpeningCount,
    });
  }

  if (openingMinorDriftTolerated) {
    nLog("[STAGE1B_OPENING_TOLERATED_DRIFT]", {
      beforeOpeningCount,
      afterOpeningCount,
      openingDriftMetrics: input.structureResult?.openingDriftMetrics || null,
      reason: "opening_minor_drift",
    });
  }

  if (input.suspiciousWallExpansion) {
    nLog("[STAGE1B_SUSPICIOUS_WALL_EXPANSION]", {
      ratio: input.wallDelta.planeExpansionRatio,
    });
  }

  const stage1BCalibratedStructuralHardFail = hasStage1BStructuralSignal({
    newWallRatio: input.wallDelta.newWallRatio,
    suspiciousWallExpansion: input.suspiciousWallExpansion,
    openingCountDelta: input.openingCountDelta,
  });
  const stage1BIsExtremeDeviation =
    Number.isFinite(input.stage1BStructuralDeviationDeg) && input.stage1BStructuralDeviationDeg >= 90;
  const stage1BIsExtremeMaskCollapse =
    input.stage1BMaskedDriftPct >= 95 && input.stage1BSemanticWallDriftPct >= 95;
  const stage1BCatastrophicConsensusBackstop =
    input.stage1BConsensusClassification.mode === "CATASTROPHIC_BACKSTOP";

  const stage1BLocalSignals: Stage2LocalSignals = {
    structuralDegreeChange: Math.max(0, Math.min(1, Math.max(input.stage1BMaskedDriftPct, input.stage1BSemanticWallDriftPct) / 100)),
    wallDrift: Math.max(0, Math.min(1, input.stage1BSemanticWallDriftPct / 100)),
    maskedEdgeDrift: Math.max(0, Math.min(1, input.stage1BMaskedDriftPct / 100)),
    edgeOpeningRisk: 0,
    openingCountMismatch: input.openingCountDelta !== 0 ? 1 : 0,
    floorPlaneShift: 0,
    fixtureMismatch: 0,
    islandDetectionDrift: 0,
  };

  const stage1BLocalPrecheckResult = runUnifiedValidator(stage1BLocalSignals);
  const stage1BIsCatastrophicLocalFail = stage1BLocalPrecheckResult.severity === "CATASTROPHIC";

  const stage1BExtremeHardFail =
    stage1BIsExtremeDeviation ||
    stage1BIsExtremeMaskCollapse ||
    stage1BCatastrophicConsensusBackstop ||
    stage1BIsCatastrophicLocalFail;

  nLog("[STAGE1B_EXTREME_GATE]", {
    jobId: input.jobId,
    attempt: input.attemptNo,
    structuralDeviationDeg: input.stage1BStructuralDeviationDeg,
    maskedDriftPct: input.stage1BMaskedDriftPct,
    semanticWallDriftPct: input.stage1BSemanticWallDriftPct,
    isExtremeDeviation: stage1BIsExtremeDeviation,
    isExtremeMaskCollapse: stage1BIsExtremeMaskCollapse,
    isCatastrophicLocalFail: stage1BIsCatastrophicLocalFail,
    consensusDerivedWarnings: input.stage1BConsensusClassification.derivedWarnings,
    consensusMode: input.stage1BConsensusClassification.mode,
    catastrophicConsensusBackstop: stage1BCatastrophicConsensusBackstop,
    policyMode: "DECLUTTER",
  });

  const originalHardFail =
    !input.stage1BMinorReconstructionSignal &&
    (input.structureResult.hardFail || stage1BCalibratedStructuralHardFail || openingRemovalHardFail);
  let effectiveHardFail = originalHardFail || stage1BExtremeHardFail;
  let effectiveViolationType =
    stage1BCatastrophicConsensusBackstop
      ? "structural_consensus"
      : stage1BIsExtremeDeviation || stage1BIsExtremeMaskCollapse || stage1BIsCatastrophicLocalFail
        ? "extreme_structural_violation"
        : input.structureResult.violationType;
  const effectiveReasons = [
    ...((Array.isArray(input.structureResult.reasons) ? input.structureResult.reasons : []) as string[]),
    ...(stage1BIsExtremeDeviation ? [`extreme_deviation:deg=${input.stage1BStructuralDeviationDeg}`] : []),
    ...(stage1BIsExtremeMaskCollapse
      ? [
          `extreme_mask_collapse:maskedDriftPct=${input.stage1BMaskedDriftPct.toFixed(2)}`,
          `extreme_mask_collapse:semanticWallDriftPct=${input.stage1BSemanticWallDriftPct.toFixed(2)}`,
        ]
      : []),
    ...(stage1BCatastrophicConsensusBackstop
      ? [`consensus_derived_warnings=${input.stage1BConsensusClassification.derivedWarnings}`]
      : []),
    ...(openingRemovalHardFail
      ? [
          `opening_count_removed:before=${beforeOpeningCount}`,
          `opening_count_removed:after=${afterOpeningCount}`,
        ]
      : []),
    ...(openingMinorDriftTolerated ? ["opening_minor_drift"] : []),
    ...(input.suspiciousWallExpansion
      ? [`suspicious_wall_expansion:planeExpansionRatio=${input.wallDelta.planeExpansionRatio.toFixed(4)}`]
      : []),
    ...(input.wallDelta.hardFail
      ? [
          `wall_plane_expansion:newWallRatio=${input.wallDelta.newWallRatio.toFixed(4)}`,
          `wall_plane_expansion:deltaRatio=${input.wallDelta.deltaRatio.toFixed(4)}`,
        ]
      : []),
  ];

  if (!effectiveHardFail && ENABLE_FINAL_STRUCTURAL_REVIEW) {
    if (input.stage1BSemanticWallDriftPct >= 60 || input.stage1BMaskedDriftPct >= 60) {
      effectiveHardFail = true;
      effectiveViolationType = "extreme_drift_pre_review";
      effectiveReasons.push(
        `extreme_drift_pre_review:semantic=${input.stage1BSemanticWallDriftPct.toFixed(2)},masked=${input.stage1BMaskedDriftPct.toFixed(2)}`
      );
      nLog("[STAGE1B_DRIFT_GATE_FAIL]", {
        jobId: input.jobId,
        attempt: input.attemptNo,
        semanticDrift: input.stage1BSemanticWallDriftPct,
        maskedDrift: input.stage1BMaskedDriftPct,
        policyMode: "DECLUTTER",
      });
    } else {
      const structuralReview = await runGeminiStructuralReviewPro(input.path1A, input.candidate);
      if (structuralReview.result === "FAIL") {
        effectiveHardFail = true;
        effectiveViolationType = "final_structural_review";
        const reviewReason = structuralReview.explanation || "stage1b_structural_review_failed";
        effectiveReasons.push(`final_review:${reviewReason}`);
        nLog("[STAGE1B_FINAL_REVIEW_FAIL]", {
          jobId: input.jobId,
          attempt: input.attemptNo,
          reason: reviewReason,
          policyMode: "DECLUTTER",
        });
      }
    }
  }

  return {
    effectiveHardFail,
    effectiveViolationType,
    effectiveReasons,
  };
}

async function evaluateStage1BFullPolicy(input: {
  jobId: string;
  attemptNo: number;
  path1A: string;
  candidate: string;
  structuralBaseline?: StructuralBaseline | null;
  stage1BStructuralDeviationDeg: number;
  openingCountDelta: number;
  stage1BSemanticWallDriftPct: number;
  stage1BMaskedDriftPct: number;
  stage1BConsensusClassification: { mode: string; derivedWarnings: number };
  outputCorrupt: boolean;
}): Promise<Stage1BPolicyDecision> {
  nLog("[STAGE1B_POLICY]", {
    mode: "FULL_FURNITURE_REMOVAL",
    localValidators: "LOG_ONLY",
    decisionSource: "GEMINI_ONLY",
    attempt: input.attemptNo,
    jobId: input.jobId,
  });

  const stage1BIsExtremeDeviation =
    Number.isFinite(input.stage1BStructuralDeviationDeg) && input.stage1BStructuralDeviationDeg >= 90;
  const stage1BIsExtremeMaskCollapse =
    input.stage1BMaskedDriftPct >= 95 && input.stage1BSemanticWallDriftPct >= 95;
  const stage1BCatastrophicConsensusBackstop =
    input.stage1BConsensusClassification.mode === "CATASTROPHIC_BACKSTOP";

  const stage1BLocalSignals: Stage2LocalSignals = {
    structuralDegreeChange: Math.max(0, Math.min(1, Math.max(input.stage1BMaskedDriftPct, input.stage1BSemanticWallDriftPct) / 100)),
    wallDrift: Math.max(0, Math.min(1, input.stage1BSemanticWallDriftPct / 100)),
    maskedEdgeDrift: Math.max(0, Math.min(1, input.stage1BMaskedDriftPct / 100)),
    edgeOpeningRisk: 0,
    openingCountMismatch: input.openingCountDelta !== 0 ? 1 : 0,
    floorPlaneShift: 0,
    fixtureMismatch: 0,
    islandDetectionDrift: 0,
  };

  const stage1BIsCatastrophicLocalFail =
    input.outputCorrupt === true;
  let openingSignal = false;
  let openingAreaDelta = 0;
  let openingStateChanged = false;
  let openingApertureExpanded = false;
  let openingViolationType: "door_state_changed" | "opening_aperture_expanded" | null = null;

  nLog("[STAGE1B_EXTREME_GATE]", {
    jobId: input.jobId,
    attempt: input.attemptNo,
    structuralDeviationDeg: input.stage1BStructuralDeviationDeg,
    maskedDriftPct: input.stage1BMaskedDriftPct,
    semanticWallDriftPct: input.stage1BSemanticWallDriftPct,
    isExtremeDeviation: stage1BIsExtremeDeviation,
    isExtremeMaskCollapse: stage1BIsExtremeMaskCollapse,
    isCatastrophicLocalFail: stage1BIsCatastrophicLocalFail,
    consensusDerivedWarnings: input.stage1BConsensusClassification.derivedWarnings,
    consensusMode: input.stage1BConsensusClassification.mode,
    catastrophicConsensusBackstop: stage1BCatastrophicConsensusBackstop,
    policyMode: "FULL_FURNITURE_REMOVAL",
  });

  if (input.outputCorrupt) {
    nLog("[STAGE1B_FULL_GEMINI_DECISION]", {
      passed: false,
      failReasons: ["invalid_output_corrupt"],
      confidence: 0,
      source: "LOCAL_CATASTROPHIC",
      jobId: input.jobId,
      attempt: input.attemptNo,
    });
    return {
      effectiveHardFail: true,
      effectiveViolationType: "invalid_output_corrupt",
      effectiveReasons: ["invalid_output_corrupt"],
      openingSignal,
      openingViolationType,
    };
  }

  if (input.structuralBaseline && input.structuralBaseline.openings.length > 0) {
    try {
      const openingValidation = await validateOpeningPreservation(input.structuralBaseline, input.candidate, {
        mode: "default",
      });

      openingStateChanged = openingValidation.summary.openingStateChanged === true;
      openingApertureExpanded = openingValidation.summary.openingApertureExpanded === true;
      openingSignal = openingStateChanged || openingApertureExpanded;
      openingViolationType = openingStateChanged
        ? "door_state_changed"
        : openingApertureExpanded
          ? "opening_aperture_expanded"
          : null;

      logger.info("STAGE1B_OPENING_SIGNAL", {
        jobId: input.jobId,
        openingSignal,
        openingStateChanged,
        openingApertureExpanded,
      });

      if (openingSignal) {
        nLog("[STAGE1B_FULL_OPENING_VETO]", {
          jobId: input.jobId,
          attempt: input.attemptNo,
          openingStateChanged,
          openingApertureExpanded,
          confidence: openingValidation.summary.confidence,
          openingCount: openingValidation.summary.openingCount,
        });
      }
    } catch (openingErr: any) {
      nLog("[STAGE1B_FULL_OPENING_VETO_ERROR]", {
        jobId: input.jobId,
        attempt: input.attemptNo,
        error: openingErr?.message || String(openingErr),
      });
    }
  }

  try {
    const stage1ABase64 = toBase64(input.path1A).data;
    const stage1BCandidateBase64 = toBase64(input.candidate).data;
    const openingGeometrySignal = await computeOpeningGeometrySignal(stage1ABase64, stage1BCandidateBase64);
    openingAreaDelta = Math.max(0, Math.min(1, Number(openingGeometrySignal?.openingAreaDelta ?? 0)));
  } catch {
    openingAreaDelta = 0;
  }

  const localSignals: Stage2LocalSignals & { openingAreaDelta?: number } = {
    ...stage1BLocalSignals,
    openingAreaDelta,
  };

  let layoutScore = 0;

  if ((localSignals?.structuralDegreeChange ?? 0) > 0.12) layoutScore++;
  if ((localSignals?.wallDrift ?? 0) > 0.10) layoutScore++;
  if ((localSignals?.maskedEdgeDrift ?? 0) > 0.10) layoutScore++;
  if ((localSignals?.openingAreaDelta ?? 0) > 0.15) layoutScore++;

  const layoutRisk = layoutScore >= 2;
  const layoutSevere = layoutScore >= 3;

  logger.info("STAGE1B_LAYOUT_SIGNAL", {
    jobId: input.jobId,
    layoutRisk,
    layoutScore,
    structuralDegreeChange: localSignals?.structuralDegreeChange,
    wallDrift: localSignals?.wallDrift,
    maskedEdgeDrift: localSignals?.maskedEdgeDrift,
    openingAreaDelta: localSignals?.openingAreaDelta,
  });

  const openingSignalPromptAppend = openingSignal
    ? `STRUCTURAL ATTENTION SIGNAL:

Local analysis detected a potential change in opening state or geometry.

Focus specifically on:
- whether any doors have changed open/closed state
- whether any openings (windows, sliding doors) have changed size, shape, or visible area
- whether wall surfaces have expanded into former openings

If any such change is present:
→ return passed=false
→ failReasons=["opening_state_or_geometry_changed"]`
    : undefined;

  const layoutRiskPromptAppend = layoutRisk
    ? `${layoutSevere ? "HIGH CONFIDENCE STRUCTURAL DRIFT DETECTED.\n\n" : ""}LAYOUT PRESERVATION CHECK (CRITICAL)

You are NOT evaluating general similarity.

You must determine whether the spatial layout and camera framing are IDENTICAL to the input image.

FAIL if ANY of the following occurred:

* The apparent size, depth, or proportions of the room have changed
* Large empty regions appear where structure or furniture previously defined space
* The camera viewpoint appears shifted, widened, or reinterpreted
* Walls, floors, or open space appear expanded, reconstructed, or repositioned

IMPORTANT:
A room that "looks similar" is NOT sufficient.

The question is:
Does this appear to be the EXACT SAME photograph with objects removed?

If layout has changed in any way → hardFail = true`
    : undefined;

  const promptAppend = [openingSignalPromptAppend, layoutRiskPromptAppend]
    .filter((value): value is string => Boolean(value))
    .join("\n\n") || undefined;

  const modelToUse = layoutRisk
    ? "gemini-2.5-pro"
    : undefined;

  const geminiResult = await runStage1BFullFurnitureGeminiValidation({
    stage1APath: input.path1A,
    stage1BPath: input.candidate,
    promptAppend,
    modelOverride: modelToUse,
  });

  nLog("[STAGE1B_FULL_GEMINI_RESULT]", {
    jobId: input.jobId,
    attempt: input.attemptNo,
    policyMode: "FULL_FURNITURE_REMOVAL",
    passed: geminiResult.passed,
    failReasons: geminiResult.failReasons,
    confidence: geminiResult.confidence,
    notes: geminiResult.notes,
  });

  nLog("[STAGE1B_FULL_GEMINI_DECISION]", {
    passed: geminiResult.passed,
    failReasons: geminiResult.failReasons,
    confidence: geminiResult.confidence,
    source: "GEMINI",
    jobId: input.jobId,
    attempt: input.attemptNo,
  });

  if (geminiResult.passed) {
    return {
      effectiveHardFail: false,
      effectiveViolationType: "accept",
      effectiveReasons: [],
      openingSignal,
      layoutRisk,
      openingViolationType,
    };
  }

  return {
    effectiveHardFail: true,
    effectiveViolationType: "full_gemini_validation_failed",
    effectiveReasons: geminiResult.failReasons.length > 0
      ? geminiResult.failReasons.map((reason) => `full_gemini:${reason}`)
      : ["full_gemini:failed_without_reason"],
    openingSignal,
    layoutRisk,
    openingViolationType,
  };
}

function toGeminiVoteDecision(result: Stage1BGeminiResult): GeminiVoteDecision {
  return result?.hardFail === true ? "fail" : "pass";
}

function pickStage1BConsensusResult(
  results: Stage1BGeminiResult[],
  targetDecision: GeminiVoteDecision
): Stage1BGeminiResult {
  const matches = results.filter((result) => toGeminiVoteDecision(result) === targetDecision);
  if (matches.length === 0) return results[0];

  return matches.reduce((best, candidate) => {
    const bestConfidence = Number.isFinite(best.confidence) ? best.confidence : 0;
    const candidateConfidence = Number.isFinite(candidate.confidence) ? candidate.confidence : 0;
    return candidateConfidence > bestConfidence ? candidate : best;
  }, matches[0]);
}

async function runStage1BGeminiConsensus(params: {
  beforeImage: string;
  afterImage: string;
  evidence: ValidationEvidence;
  derivedWarnings: number;
}): Promise<{
  result: Stage1BGeminiResult;
  validatorResults: { v1: GeminiVoteDecision; v2?: GeminiVoteDecision; v3?: GeminiVoteDecision };
  consensusEnabled: boolean;
  validatorConfidence: number;
  derivedWarnings: number;
}> {
  const resultA = await validateStage1BStructure(params.beforeImage, params.afterImage, params.evidence);
  const validatorResults: { v1: GeminiVoteDecision; v2?: GeminiVoteDecision; v3?: GeminiVoteDecision } = {
    v1: toGeminiVoteDecision(resultA),
  };

  const validatorConfidence = Number.isFinite(resultA.confidence) ? resultA.confidence : 0;
  const consensusEnabled = params.derivedWarnings >= 3 || validatorConfidence < 0.7;
  if (!consensusEnabled) {
    return {
      result: resultA,
      validatorResults,
      consensusEnabled,
      validatorConfidence,
      derivedWarnings: params.derivedWarnings,
    };
  }

  let resultB: Stage1BGeminiResult;
  try {
    resultB = await validateStage1BStructure(params.beforeImage, params.afterImage, params.evidence);
  } catch (err) {
    console.warn("[worker] Stage1B Gemini consensus second call failed; falling back to first call", err);
    return {
      result: resultA,
      validatorResults,
      consensusEnabled,
      validatorConfidence,
      derivedWarnings: params.derivedWarnings,
    };
  }
  validatorResults.v2 = toGeminiVoteDecision(resultB);

  if (validatorResults.v1 === validatorResults.v2) {
    return {
      result: pickStage1BConsensusResult([resultA, resultB], validatorResults.v1),
      validatorResults,
      consensusEnabled,
      validatorConfidence,
      derivedWarnings: params.derivedWarnings,
    };
  }

  let resultC: Stage1BGeminiResult;
  try {
    resultC = await validateStage1BStructure(params.beforeImage, params.afterImage, params.evidence);
  } catch (err) {
    console.warn("[worker] Stage1B Gemini consensus tie-breaker failed; falling back to first call", err);
    return {
      result: resultA,
      validatorResults,
      consensusEnabled,
      validatorConfidence,
      derivedWarnings: params.derivedWarnings,
    };
  }
  validatorResults.v3 = toGeminiVoteDecision(resultC);
  const failVotes = [resultA, resultB, resultC].filter((result) => result.hardFail).length;
  const finalDecision: GeminiVoteDecision = failVotes >= 2 ? "fail" : "pass";

  return {
    result: pickStage1BConsensusResult([resultA, resultB, resultC], finalDecision),
    validatorResults,
    consensusEnabled,
    validatorConfidence,
    derivedWarnings: params.derivedWarnings,
  };
}

function detectBuiltInRemoval(localReasons: string[] | undefined): boolean {
  if (!Array.isArray(localReasons)) return false;

  const text = localReasons.join(" ").toLowerCase();

  const builtInKeywords = [
    "built-in",
    "built in",
    "built-in wardrobe",
    "built-in cabinet",
    "fixed cabinetry",
    "closet system",
    "wall-integrated shelving",
  ];

  const removalKeywords = [
    "removed",
    "replaced",
    "deleted",
    "walled over",
  ];

  const hasBuiltInRef = builtInKeywords.some((k) => text.includes(k));
  const hasRemovalRef = removalKeywords.some((k) => text.includes(k));

  return hasBuiltInRef && hasRemovalRef;
}

function detectFurnitureAgainstWallSignal(input: {
  localReasons?: string[];
  warnings?: string[];
  geminiDetails?: any;
}): boolean {
  const details = input.geminiDetails && typeof input.geminiDetails === "object"
    ? input.geminiDetails
    : {};

  const explicitFlag =
    details.bedAgainstWall === true ||
    details.sofaAgainstWall === true ||
    details.cabinetAgainstWall === true ||
    details.furnitureAgainstWall === true;

  if (explicitFlag) return true;

  const textParts: string[] = [];
  if (Array.isArray(input.localReasons)) textParts.push(...input.localReasons);
  if (Array.isArray(input.warnings)) textParts.push(...input.warnings);
  textParts.push(
    String(details.reason ?? ""),
    String(details.explanation ?? ""),
    String(details.summary ?? ""),
    String(details.message ?? "")
  );

  const text = textParts.join(" ").toLowerCase();
  const hasLargeFurniture = /(bed|sofa|couch|cabinet|wardrobe|dresser)/.test(text);
  const hasWallContact = /(against\s+wall|flush\s+against\s+wall|touch(ing)?\s+wall|wall\s+plane)/.test(text);

  return hasLargeFurniture && hasWallContact;
}

type ClosetRegionDescriptor = {
  id: string;
  wallPosition: string;
  horizontalBand: string;
  verticalBand: string;
  widthBand: string;
  bboxText?: string;
};

function normalizeOpeningTypeForComparison(type: unknown): string {
  const raw = String(type || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "closet" || raw === "closet_door" || raw === "closet door" || raw === "wardrobe sliding door" || raw === "wardrobe_door") {
    return "closet_door";
  }
  if (raw === "archway" || raw === "walk-through" || raw === "walkthrough" || raw === "walk_through" || raw === "passthrough" || raw === "pass_through") {
    return "walkthrough";
  }
  return raw;
}

type DecorObjectCandidate = {
  type: string;
  bbox?: [number, number, number, number] | null;
};

type GrayFrame = {
  data: Uint8Array;
  width: number;
  height: number;
};

type FloorlineBreakSignal = {
  detected: boolean;
  floorY: number | null;
  baselineMaxGapPx: number;
  candidateMaxGapPx: number;
  gapDeltaPx: number;
  openingBbox: [number, number, number, number] | null;
};

type CornerRectangleSignal = {
  lost: boolean;
  baselineRectangles: number;
  candidateRectangles: number;
  representativeBbox: [number, number, number, number] | null;
};

function normalizeDecorObjectType(type: unknown): string {
  const raw = String(type || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "wall art" || raw === "wall-art") return "wall_art";
  if (raw === "wall decor" || raw === "wall-decoration" || raw === "wall decoration") return "wall_decor";
  if (raw === "picture frame" || raw === "framed art" || raw === "framed_art") return "picture_frame";
  return raw.replace(/\s+/g, "_");
}

function normalizeBboxCandidate(input: any): [number, number, number, number] | null {
  if (!Array.isArray(input) || input.length !== 4) return null;
  const nums = input.map((v: any) => Number(v));
  if (nums.some((v: number) => !Number.isFinite(v))) return null;
  let [x1, y1, x2, y2] = nums;
  const maybePixel = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) > 1.5;
  if (maybePixel) return null;
  x1 = Math.max(0, Math.min(1, x1));
  y1 = Math.max(0, Math.min(1, y1));
  x2 = Math.max(0, Math.min(1, x2));
  y2 = Math.max(0, Math.min(1, y2));
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  if (x2 - x1 < 0.01 || y2 - y1 < 0.01) return null;
  return [x1, y1, x2, y2];
}

function bboxOverlapRatio(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const interArea = iw * ih;
  if (interArea <= 0) return 0;
  const aArea = Math.max(0.0001, (a[2] - a[0]) * (a[3] - a[1]));
  return interArea / aArea;
}

function extractDecorObjectCandidates(geminiDetails: any): DecorObjectCandidate[] {
  if (!geminiDetails || typeof geminiDetails !== "object") return [];

  const buckets = [
    geminiDetails.detectedObjects,
    geminiDetails.objects,
    geminiDetails.wallObjects,
    geminiDetails.decorObjects,
  ];

  const fromArrays: DecorObjectCandidate[] = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (!item || typeof item !== "object") continue;
      const type = normalizeDecorObjectType(item.type || item.label || item.name || item.objectType);
      if (!type) continue;
      const bbox = normalizeBboxCandidate(item.bbox || item.box || item.region || item.bounds);
      fromArrays.push({ type, bbox });
    }
  }

  const summaryText = [
    String(geminiDetails.reason ?? ""),
    String(geminiDetails.explanation ?? ""),
    String(geminiDetails.summary ?? ""),
    String(geminiDetails.message ?? ""),
  ].join(" ").toLowerCase();

  const textHits: DecorObjectCandidate[] = [];
  if (/mirror/.test(summaryText)) textHits.push({ type: "mirror", bbox: null });
  if (/painting/.test(summaryText)) textHits.push({ type: "painting", bbox: null });
  if (/artwork|wall\s*art/.test(summaryText)) textHits.push({ type: "artwork", bbox: null });
  if (/wall\s*decor|wall\s*decoration/.test(summaryText)) textHits.push({ type: "wall_decor", bbox: null });
  if (/picture\s*frame|framed\s*art/.test(summaryText)) textHits.push({ type: "picture_frame", bbox: null });

  return [...fromArrays, ...textHits];
}

async function loadGrayFrame(imagePath: string, maxDim = 512): Promise<GrayFrame> {
  const meta = await sharp(imagePath).metadata();
  const srcW = meta.width || 0;
  const srcH = meta.height || 0;
  if (!srcW || !srcH) {
    return { data: new Uint8Array(0), width: 0, height: 0 };
  }

  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const width = Math.max(96, Math.round(srcW * scale));
  const height = Math.max(96, Math.round(srcH * scale));
  const { data } = await sharp(imagePath)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width,
    height,
  };
}

function sobelEdgeMap(gray: Uint8Array, width: number, height: number, threshold: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (!width || !height || gray.length !== width * height) return out;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx =
        gray[idx - width - 1] + 2 * gray[idx - 1] + gray[idx + width - 1] -
        gray[idx - width + 1] - 2 * gray[idx + 1] - gray[idx + width + 1];
      const gy =
        gray[idx - width - 1] + 2 * gray[idx - width] + gray[idx - width + 1] -
        gray[idx + width - 1] - 2 * gray[idx + width] - gray[idx + width + 1];
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag >= threshold) out[idx] = 1;
    }
  }

  return out;
}

function findDominantFloorlineY(edges: Uint8Array, width: number, height: number): number | null {
  if (!width || !height || edges.length !== width * height) return null;
  const yStart = Math.max(0, Math.floor(height * 0.55));
  const yEnd = Math.max(yStart + 1, Math.floor(height * 0.95));

  let bestY = -1;
  let bestScore = -1;

  for (let y = yStart; y < yEnd; y += 1) {
    const rowOffset = y * width;
    let rowEdges = 0;
    for (let x = 0; x < width; x += 1) {
      if (edges[rowOffset + x]) rowEdges += 1;
    }

    const prev = y > 0 ? y - 1 : y;
    const next = y < height - 1 ? y + 1 : y;
    const neighborBoost = (() => {
      let count = 0;
      for (const yy of [prev, next]) {
        const off = yy * width;
        for (let x = 0; x < width; x += 1) {
          if (edges[off + x]) count += 1;
        }
      }
      return count * 0.25;
    })();

    const score = rowEdges + neighborBoost;
    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  if (bestY < 0) return null;
  if (bestScore < Math.max(12, width * 0.05)) return null;
  return bestY;
}

function rowSegments(edges: Uint8Array, width: number, y: number, minLen: number): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  if (y < 0) return segments;
  const off = y * width;
  let start = -1;

  for (let x = 0; x < width; x += 1) {
    const on = edges[off + x] === 1;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      const end = x - 1;
      if (end - start + 1 >= minLen) segments.push({ start, end });
      start = -1;
    }
  }

  if (start >= 0) {
    const end = width - 1;
    if (end - start + 1 >= minLen) segments.push({ start, end });
  }

  return segments;
}

function maxSegmentGap(
  segments: Array<{ start: number; end: number }>,
  width: number
): { maxGap: number; gapStart: number; gapEnd: number } {
  if (!segments.length) {
    return { maxGap: width, gapStart: 0, gapEnd: Math.max(0, width - 1) };
  }

  let maxGap = 0;
  let gapStart = 0;
  let gapEnd = 0;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const start = segments[i].end + 1;
    const end = segments[i + 1].start - 1;
    const gap = Math.max(0, end - start + 1);
    if (gap > maxGap) {
      maxGap = gap;
      gapStart = start;
      gapEnd = end;
    }
  }

  return { maxGap, gapStart, gapEnd };
}

async function detectFloorlineBreakSignal(
  baselinePath: string,
  candidatePath: string
): Promise<FloorlineBreakSignal> {
  const [baseline, candidate] = await Promise.all([
    loadGrayFrame(baselinePath, 512),
    loadGrayFrame(candidatePath, 512),
  ]);

  if (!baseline.width || !candidate.width || baseline.width !== candidate.width || baseline.height !== candidate.height) {
    return {
      detected: false,
      floorY: null,
      baselineMaxGapPx: 0,
      candidateMaxGapPx: 0,
      gapDeltaPx: 0,
      openingBbox: null,
    };
  }

  const width = baseline.width;
  const height = baseline.height;
  const baseEdges = sobelEdgeMap(baseline.data, width, height, 48);
  const candEdges = sobelEdgeMap(candidate.data, width, height, 48);

  const floorY = findDominantFloorlineY(baseEdges, width, height);
  if (floorY === null) {
    return {
      detected: false,
      floorY: null,
      baselineMaxGapPx: 0,
      candidateMaxGapPx: 0,
      gapDeltaPx: 0,
      openingBbox: null,
    };
  }

  const minLen = Math.max(6, Math.floor(width * 0.03));
  const baselineSegments = rowSegments(baseEdges, width, floorY, minLen);
  const candidateSegments = rowSegments(candEdges, width, floorY, minLen);

  const baselineGap = maxSegmentGap(baselineSegments, width);
  const candidateGap = maxSegmentGap(candidateSegments, width);
  const gapDeltaPx = candidateGap.maxGap - baselineGap.maxGap;
  const minGapThresholdPx = Math.max(40, Math.floor(width * 0.08));
  const detected = candidateGap.maxGap > minGapThresholdPx && gapDeltaPx > Math.max(8, Math.floor(width * 0.02));

  const openingBbox: [number, number, number, number] | null = detected
    ? [
        Math.max(0, Math.min(1, candidateGap.gapStart / width)),
        Math.max(0, Math.min(1, (floorY - Math.max(10, Math.floor(height * 0.12))) / height)),
        Math.max(0, Math.min(1, candidateGap.gapEnd / width)),
        Math.max(0, Math.min(1, Math.min(height - 1, floorY + Math.max(8, Math.floor(height * 0.04))) / height)),
      ]
    : null;

  return {
    detected,
    floorY,
    baselineMaxGapPx: baselineGap.maxGap,
    candidateMaxGapPx: candidateGap.maxGap,
    gapDeltaPx,
    openingBbox,
  };
}

function connectedComponents(
  map: Uint8Array,
  width: number,
  height: number,
  minPixels: number
): Array<{ points: number; bbox: { x1: number; y1: number; x2: number; y2: number } }> {
  const visited = new Uint8Array(map.length);
  const out: Array<{ points: number; bbox: { x1: number; y1: number; x2: number; y2: number } }> = [];
  const neighbors = [
    -width - 1, -width, -width + 1,
    -1, 1,
    width - 1, width, width + 1,
  ];

  for (let i = 0; i < map.length; i += 1) {
    if (!map[i] || visited[i]) continue;
    const stack = [i];
    visited[i] = 1;

    let points = 0;
    let x1 = width;
    let y1 = height;
    let x2 = 0;
    let y2 = 0;

    while (stack.length > 0) {
      const idx = stack.pop() as number;
      points += 1;
      const y = Math.floor(idx / width);
      const x = idx - y * width;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;

      for (const offset of neighbors) {
        const next = idx + offset;
        if (next < 0 || next >= map.length) continue;
        if (!map[next] || visited[next]) continue;
        const ny = Math.floor(next / width);
        const nx = next - ny * width;
        if (Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }

    if (points >= minPixels) {
      out.push({ points, bbox: { x1, y1, x2, y2 } });
    }
  }

  return out;
}

function detectCornerRectangles(frame: GrayFrame): Array<[number, number, number, number]> {
  const { data, width, height } = frame;
  if (!width || !height || data.length !== width * height) return [];

  const cornerMap = new Uint8Array(width * height);
  const gxThreshold = 28;
  const gyThreshold = 28;
  const yStart = Math.floor(height * 0.12);
  const yEnd = Math.floor(height * 0.92);

  for (let y = Math.max(1, yStart); y < Math.min(height - 1, yEnd); y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx = Math.abs(data[idx + 1] - data[idx - 1]);
      const gy = Math.abs(data[idx + width] - data[idx - width]);
      if (gx >= gxThreshold && gy >= gyThreshold) {
        cornerMap[idx] = 1;
      }
    }
  }

  const comps = connectedComponents(cornerMap, width, height, Math.max(8, Math.floor(width * height * 0.00005)));
  const rectangles: Array<[number, number, number, number]> = [];

  for (const comp of comps) {
    const bw = comp.bbox.x2 - comp.bbox.x1 + 1;
    const bh = comp.bbox.y2 - comp.bbox.y1 + 1;
    if (bw < width * 0.06 || bh < height * 0.10) continue;

    const aspect = bw / Math.max(1, bh);
    if (aspect < 0.35 || aspect > 3.2) continue;

    const area = bw * bh;
    const density = comp.points / Math.max(1, area);
    if (density > 0.30) continue;

    rectangles.push([
      comp.bbox.x1 / width,
      comp.bbox.y1 / height,
      comp.bbox.x2 / width,
      comp.bbox.y2 / height,
    ]);
  }

  return rectangles;
}

async function detectCornerRectangleLossSignal(
  baselinePath: string,
  candidatePath: string
): Promise<CornerRectangleSignal> {
  const [baseline, candidate] = await Promise.all([
    loadGrayFrame(baselinePath, 512),
    loadGrayFrame(candidatePath, 512),
  ]);

  if (!baseline.width || !candidate.width || baseline.width !== candidate.width || baseline.height !== candidate.height) {
    return {
      lost: false,
      baselineRectangles: 0,
      candidateRectangles: 0,
      representativeBbox: null,
    };
  }

  const baselineRects = detectCornerRectangles(baseline);
  const candidateRects = detectCornerRectangles(candidate);
  const lost = baselineRects.length > 0 && candidateRects.length < baselineRects.length;

  return {
    lost,
    baselineRectangles: baselineRects.length,
    candidateRectangles: candidateRects.length,
    representativeBbox: lost ? baselineRects[0] ?? null : null,
  };
}

function collectClosetRegionDescriptors(baseline: StructuralBaseline | null | undefined): ClosetRegionDescriptor[] {
  if (!baseline || !Array.isArray(baseline.openings)) return [];

  return baseline.openings
    .filter((opening) => normalizeOpeningTypeForComparison((opening as any)?.type) === "closet_door")
    .map((opening) => {
      const maybeBbox = (opening as any)?.bbox;
      const bboxText = Array.isArray(maybeBbox) && maybeBbox.length === 4
        ? `bbox=[${maybeBbox.map((value: any) => Number(value)).join(",")}]`
        : undefined;
      return {
        id: String(opening.id || "closet"),
        wallPosition: String(opening.wallPosition || opening.wallIndex || "unknown"),
        horizontalBand: String(opening.horizontalBand || opening.relativeHorizontalPosition || "unknown"),
        verticalBand: String(opening.verticalBand || "unknown"),
        widthBand: String(opening.widthBand || "unknown"),
        bboxText,
      };
    });
}

function buildClosetSurfaceExclusionConstraintBlock(
  baseline: StructuralBaseline | null | undefined,
  mode: "soft" | "hard"
): { block: string; regionCount: number } {
  const regions = collectClosetRegionDescriptors(baseline);
  if (!regions.length) return { block: "", regionCount: 0 };

  const regionLines = regions.map((region) => {
    const bboxSuffix = region.bboxText ? `, ${region.bboxText}` : "";
    return `- ${region.id}: wall=${region.wallPosition}, horizontal=${region.horizontalBand}, vertical=${region.verticalBand}, width=${region.widthBand}${bboxSuffix}`;
  });

  const modeRules = mode === "soft"
    ? [
        "Treat these closet-door wall bands as no-go placement surfaces for large furniture.",
        "Do not place beds, sofas, wardrobes, or cabinets directly in front of these regions.",
        "Preserve closet-door visibility and operability.",
      ]
    : [
        "You MUST treat these closet-door regions as strict no-placement surfaces.",
        "Do not place or align large furniture against these regions.",
        "Keep closet-door openings visibly intact and operable.",
      ];

  const block = `
================ CLOSET PRESERVATION SURFACE EXCLUSION ================
Closet door regions detected from structural baseline:

${regionLines.join("\n")}

${modeRules.join("\n")}
=======================================================================
`;

  return { block, regionCount: regions.length };
}

function buildInvariantHints(localSignals: {
  windowsBefore?: number | null;
  windowsAfter?: number | null;
  doorsBefore?: number | null;
  doorsAfter?: number | null;
  closetDoorsBefore?: number | null;
  closetDoorsAfter?: number | null;
  builtInRemovalDetected?: boolean;
  wallDriftPct?: number | null;
  maskedEdgeDriftPct?: number | null;
}): string[] {
  const hints: string[] = [];

  const normalizeCount = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const hasOpeningCountSignal =
    typeof localSignals.windowsBefore === "number" ||
    typeof localSignals.windowsAfter === "number" ||
    typeof localSignals.doorsBefore === "number" ||
    typeof localSignals.doorsAfter === "number" ||
    typeof localSignals.closetDoorsBefore === "number" ||
    typeof localSignals.closetDoorsAfter === "number";

  const totalOpeningsBefore =
    normalizeCount(localSignals.windowsBefore) +
    normalizeCount(localSignals.doorsBefore) +
    normalizeCount(localSignals.closetDoorsBefore);

  const totalOpeningsAfter =
    normalizeCount(localSignals.windowsAfter) +
    normalizeCount(localSignals.doorsAfter) +
    normalizeCount(localSignals.closetDoorsAfter);

  const openingCountDecrease =
    hasOpeningCountSignal && totalOpeningsAfter < totalOpeningsBefore;

  const builtInRemovalDetected = localSignals.builtInRemovalDetected === true;
  const wallDriftHigh =
    typeof localSignals.wallDriftPct === "number" &&
    localSignals.wallDriftPct >= 35;
  const maskedEdgeDriftHigh =
    typeof localSignals.maskedEdgeDriftPct === "number" &&
    localSignals.maskedEdgeDriftPct >= 35;

  const wallDriftLow =
    typeof localSignals.wallDriftPct !== "number" ||
    localSignals.wallDriftPct < 20;
  const maskedEdgeDriftLow =
    typeof localSignals.maskedEdgeDriftPct !== "number" ||
    localSignals.maskedEdgeDriftPct < 20;

  const suspectOpeningAlteration =
    openingCountDecrease ||
    builtInRemovalDetected ||
    wallDriftHigh ||
    maskedEdgeDriftHigh;

  if (suspectOpeningAlteration) {
    hints.push(
      "Local structural signals indicate a potential change to a wall opening or built-in element. Carefully verify whether any doors, windows, or closet openings have been removed, reduced, relocated, or infilled. Do not assume occlusion — confirm visually whether the wall plane has become continuous where an opening previously existed."
    );
  } else if (!openingCountDecrease && !builtInRemovalDetected && wallDriftLow && maskedEdgeDriftLow) {
    hints.push("Local structural signals do not indicate a clear opening identity issue, but still verify wall-plane continuity and opening identity visually between BEFORE and AFTER.");
  }

  return hints;
}

const STRUCTURAL_INVARIANT_BASE_PROMPT = `
You are a structural architectural validator.

Your task is to detect removal, infill, relocation, or structural alteration
of wall openings between BEFORE and AFTER images.

A wall opening is defined as:

Any framed, recessed, or penetrative void through a wall plane.
This includes (but is not limited to):
- windows
- doors
- sliding doors
- closet doors
- internal pass-throughs
- recessed cavities
- any visible framed penetration of a wall surface

OPENING SIZE INVARIANT

For each wall opening identified in BEFORE, the corresponding opening in AFTER
must remain approximately the same perceptual width and height relative to the wall.

An opening is considered structurally altered if:

- its width appears noticeably wider or narrower than in BEFORE
- its height appears noticeably taller or shorter than in BEFORE
- the width-to-height proportion of the opening changes
- the opening occupies a significantly larger or smaller portion of the wall

Minor perspective normalization, lighting adjustments, or camera correction
are acceptable and should NOT be considered resizing.

Curtains, blinds, furniture, or decor may partially occlude an opening,
but they must NOT alter the perceived structural size of the opening frame.

If the opening frame is still present but appears noticeably resized,
treat this as a structural alteration.

Large architectural openings such as sliding glass doors or wide windows
are structural anchors and must remain identical in perceptual size
and position relative to the wall.

GLOBAL LIGHT ANCHOR (MANDATORY)

Identify the primary external light-source opening in BEFORE
(for example: a large sliding door or dominant exterior-facing window).

If that light-source opening in AFTER is no longer a penetrative opening
and appears replaced by continuous wall surface, decor, or an artificial
light source (such as a lamp), classify this as infill/removal.

Do NOT classify as valid occlusion when the wall plane behind furniture
becomes continuous and opaque across the previous opening region.

Occlusion by furniture, window treatments (curtains, blinds, drapes, shutters),
or temporary movable objects is NOT removal ONLY IF ALL of the following remain true:

- The structural frame edges are still visibly present,
- The depth void or light cavity of the opening remains visible,
- The wall plane does NOT become continuous across the prior opening boundary.

Translucent or sheer window treatments that allow light through and clearly
maintain the silhouette of the opening should be treated as occlusion,
not removal.

If any of the above conditions are not satisfied, treat it as structural removal.

Replacement of an opening with continuous wall surface IS removal.
Loss of visible frame continuity IS removal.
Loss of depth void/light cavity IS removal.
Expansion of wall plane into a former opening cavity IS removal.

You must:

1) Count total structural wall openings in BEFORE.
2) Count total structural wall openings in AFTER.
3) Compare approximate wall locations of each opening.
4) Determine whether any opening present in BEFORE is:
   - missing in AFTER
   - replaced by continuous wall
   - relocated
  - structurally resized
   - merely occluded (meeting ALL occlusion conditions above)
5) Detect if any wall plane expanded into a previous opening cavity.

IMPORTANT:
If opening count decreases, you must assume removal UNLESS you can clearly
verify preserved frame continuity AND preserved depth void.

If an opening is partially obscured by a new object (e.g., a tall plant or a lamp),
but the wall boundary behind it is logically intact, do NOT flag as removal.

Do not speculate. If uncertain between occlusion and removal, prefer removal.

Return STRICT JSON only. No prose outside JSON.

Required JSON format:

{
  "openingRemoved": boolean,
  "openingRelocated": boolean,
  "openingInfilled": boolean,
  "openingResized": boolean,
  "analysis": string,
  "confidence": number
}

Set openingRelocated=true if the opening appears moved to a different wall location.
Set openingInfilled=true if a former opening area is now continuous wall.
Set openingRemoved=true if an opening present in BEFORE is absent in AFTER.
Set openingResized=true if the opening frame remains present but its width, height, or proportions differ noticeably from BEFORE.
Set analysis to a short reason (<= 140 chars) naming the key opening decision.
Set confidence to a number between 0 and 1.
`;

async function runStructuralInvariantGeminiCheck(
  beforeImageUrl: string,
  afterImageUrl: string,
  hintFlags: string[] = []
): Promise<{
  fail: boolean;
  confidence: number;
  reason: string;
  openingViolationDetected: boolean;
  violationType?: StructuralInvariantViolationType;
  raw: any;
}> {
  const hintBlock =
    hintFlags.length > 0
      ? `\n\nLocal structural review note (informative only, not authoritative):\n- ${hintFlags.join("\n- ")}`
      : "";
  const prompt = `${STRUCTURAL_INVARIANT_BASE_PROMPT}${hintBlock}`;

  logger.info(
    `[STRUCTURAL_INVARIANT_PROMPT] model=${STRUCTURAL_INVARIANT_MODEL} hints=${JSON.stringify(hintFlags)} promptChars=${prompt.length}`
  );

  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const response = await (ai as any).models.generateContent({
    model: STRUCTURAL_INVARIANT_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
          {
            text: "IMAGE_BEFORE:",
          },
          { inlineData: { mimeType: "image/webp", data: before } },
          {
            text: "IMAGE_AFTER:",
          },
          { inlineData: { mimeType: "image/webp", data: after } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 1,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  } as any);

  const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
  const rawText = textParts.map((p: any) => p?.text || "").join("\n").trim();

  const failClosed = (reason: string, raw: any) => ({
    fail: true,
    confidence: 0,
    reason,
    openingViolationDetected: false,
    violationType: "other" as const,
    raw,
  });

  const extractJsonCandidate = (text: string): string => {
    if (!text) return "";
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return fenced;

    let start = -1;
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") {
        if (start === -1) start = index;
        depth += 1;
      } else if (char === "}" && start !== -1) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, index + 1);
        }
      }
    }

    return text.trim();
  };

  const jsonCandidate = extractJsonCandidate(rawText);

  let parsed: any = {};
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    logger.error(`[STRUCTURAL_INVARIANT_PARSE_ERROR] rawText=${rawText}`);
    return failClosed("Invariant JSON parsing failed", {
      parse_error: true,
      rawText,
      jsonCandidate,
    });
  }

  const requiredKeys = [
    "openingRemoved",
    "openingRelocated",
    "openingInfilled",
    "openingResized",
    "confidence",
  ];

  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      logger.error("[STRUCTURAL_INVARIANT_SCHEMA_ERROR]", { missingKey: key });
      return {
        fail: true,
        confidence: 0,
        reason: "Invariant schema invalid",
        openingViolationDetected: false,
        violationType: "other",
        raw: parsed,
      };
    }
  }

  const openingRemoved = parsed.openingRemoved === true;
  const openingRelocated = parsed.openingRelocated === true;
  const openingInfilled = parsed.openingInfilled === true;
  const openingResized = parsed.openingResized === true;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const analysis = typeof parsed.analysis === "string"
    ? parsed.analysis.trim().slice(0, 140)
    : "";
  const fail = openingRemoved || openingRelocated || openingInfilled || openingResized;
  const violationType: StructuralInvariantViolationType = openingRemoved
    ? "opening_removed"
    : openingRelocated
      ? "opening_relocated"
      : openingInfilled
        ? "opening_infilled"
        : openingResized
          ? "opening_resized"
        : "other";
  const reason = openingRemoved
    ? "openingRemoved=true"
    : openingRelocated
      ? "openingRelocated=true"
      : openingInfilled
        ? "openingInfilled=true"
        : openingResized
          ? "openingResized=true"
        : "no_opening_change";

  const normalizedParsed = {
    openingRemoved,
    openingRelocated,
    openingInfilled,
    openingResized,
    analysis,
    confidence,
    reason,
    violationType,
  };

  return {
    fail,
    confidence,
    reason,
    openingViolationDetected: fail,
    violationType,
    raw: normalizedParsed,
  };
}

async function debugRunInvariantReplay() {
  const cases = [
    {
      name: "job_362_attempt1",
      originalPath:
        "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772346967215-realenhance-job_362deb34-ecc6-4b40-9191-e116791e41d1-1772346955084-0kxwsaeturoh-canonical-1A.webp",
      generatedPath:
        "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772346982136-realenhance-job_362deb34-ecc6-4b40-9191-e116791e41d1-1772346955084-0kxwsaeturoh-canonical-1A-2.webp",
    },
    {
      name: "job_362_retry1",
      originalPath:
        "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772346967215-realenhance-job_362deb34-ecc6-4b40-9191-e116791e41d1-1772346955084-0kxwsaeturoh-canonical-1A.webp",
      generatedPath:
        "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772347011051-realenhance-job_362deb34-ecc6-4b40-9191-e116791e41d1-1772346955084-0kxwsaeturoh-canonical-1A-2-retry1.webp",
    },
    {
      name: "job_362_retry2",
      originalPath:
        "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772346967215-realenhance-job_362deb34-ecc6-4b40-9191-e116791e41d1-1772346955084-0kxwsaeturoh-canonical-1A.webp",
      generatedPath:
        "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772347039436-realenhance-job_362deb34-ecc6-4b40-9191-e116791e41d1-1772346955084-0kxwsaeturoh-canonical-1A-2-retry2.webp",
    },
  ];

  for (const c of cases) {
    console.log(`\n=== INVARIANT REPLAY: ${c.name} ===`);

    const result = await runStructuralInvariantGeminiCheck(
      c.originalPath,
      c.generatedPath,
      ["debug_replay"]
    );

    console.log("Raw Result:", result.raw);
    console.log("opening_removed:", result.raw?.opening_removed);
    console.log("wall_plane_continuity:", result.raw?.wall_plane_continuity);
    console.log("opening_occluded:", result.raw?.opening_occluded);
    console.log(
      "frame_continuity_preserved:",
      result.raw?.frame_continuity_preserved
    );
    console.log("confidence:", result.confidence);
    console.log("computed_fail:", result.fail);
  }
}

function getStage1BGeminiConfig(attempt: number) {
  const baseTemp = 33;
  const baseTopP = 0.70;
  const baseTopK = 30;

  const decayFactor = Math.pow(0.9, Math.max(0, attempt));

  return {
    temperature: Math.round(baseTemp * decayFactor),
    topP: parseFloat((baseTopP * decayFactor).toFixed(2)),
    topK: Math.round(baseTopK * decayFactor),
  };
}

async function estimateClutterHeuristic(imagePath: string): Promise<Stage1BClutterHeuristicResult> {
  const { data, info } = await sharp(imagePath)
    .rotate()
    .resize(128, 128, { fit: "inside" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  if (!width || !height || data.length === 0) {
    return { score: 0, level: "low" };
  }

  let deltaSum = 0;
  let comparisons = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = data[idx];
      if (x + 1 < width) {
        deltaSum += Math.abs(center - data[idx + 1]);
        comparisons += 1;
      }
      if (y + 1 < height) {
        deltaSum += Math.abs(center - data[idx + width]);
        comparisons += 1;
      }
    }
  }

  const avgDelta = comparisons > 0 ? deltaSum / comparisons : 0;
  const score = Math.max(0, Math.min(1, avgDelta / 255));
  const roundedScore = Number(score.toFixed(3));
  const level: Stage1BClutterHeuristicResult["level"] =
    roundedScore >= 0.60 ? "high" : roundedScore >= 0.35 ? "medium" : "low";

  return { score: roundedScore, level };
}

function computeLaplacianMap(luma: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const center = luma[index];
      const left = luma[index - 1];
      const right = luma[index + 1];
      const up = luma[index - width];
      const down = luma[index + width];
      out[index] = Math.abs(4 * center - left - right - up - down);
    }
  }
  return out;
}

function runKMeansLab(
  lab: Float32Array,
  width: number,
  height: number,
  clusterCount: number,
  maxIterations = 8
): Uint8Array {
  const pixelCount = width * height;
  const labels = new Uint8Array(pixelCount);
  const centers = new Float32Array(clusterCount * 3);

  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
    const sampleIndex = Math.min(
      pixelCount - 1,
      Math.floor(((clusterIndex + 1) / (clusterCount + 1)) * pixelCount)
    );
    const pixelOffset = sampleIndex * 3;
    const centerOffset = clusterIndex * 3;
    centers[centerOffset] = lab[pixelOffset];
    centers[centerOffset + 1] = lab[pixelOffset + 1];
    centers[centerOffset + 2] = lab[pixelOffset + 2];
  }

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const sums = new Float64Array(clusterCount * 3);
    const counts = new Uint32Array(clusterCount);

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const pixelOffset = pixelIndex * 3;
      const l = lab[pixelOffset];
      const a = lab[pixelOffset + 1];
      const b = lab[pixelOffset + 2];

      let bestCluster = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
        const centerOffset = clusterIndex * 3;
        const dl = l - centers[centerOffset];
        const da = a - centers[centerOffset + 1];
        const db = b - centers[centerOffset + 2];
        const distance = dl * dl + da * da + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = clusterIndex;
        }
      }

      labels[pixelIndex] = bestCluster;
      counts[bestCluster] += 1;
      const sumOffset = bestCluster * 3;
      sums[sumOffset] += l;
      sums[sumOffset + 1] += a;
      sums[sumOffset + 2] += b;
    }

    for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
      const count = counts[clusterIndex];
      if (count === 0) {
        continue;
      }
      const centerOffset = clusterIndex * 3;
      const sumOffset = clusterIndex * 3;
      centers[centerOffset] = sums[sumOffset] / count;
      centers[centerOffset + 1] = sums[sumOffset + 1] / count;
      centers[centerOffset + 2] = sums[sumOffset + 2] / count;
    }
  }

  return labels;
}

function countMask(mask: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      count += 1;
    }
  }
  return count;
}

function filterMaskComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minAreaRatio: number,
  requireVerticalDominance: boolean
): Uint8Array {
  const filtered = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const minArea = Math.max(1, Math.floor(width * height * minAreaRatio));

  for (let startIndex = 0; startIndex < mask.length; startIndex += 1) {
    if (!mask[startIndex] || visited[startIndex]) {
      continue;
    }

    const queue: number[] = [startIndex];
    const component: number[] = [];
    visited[startIndex] = 1;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (queue.length > 0) {
      const index = queue.pop()!;
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const left = x > 0 ? index - 1 : -1;
      const right = x + 1 < width ? index + 1 : -1;
      const up = y > 0 ? index - width : -1;
      const down = y + 1 < height ? index + width : -1;

      if (left >= 0 && mask[left] && !visited[left]) {
        visited[left] = 1;
        queue.push(left);
      }
      if (right >= 0 && mask[right] && !visited[right]) {
        visited[right] = 1;
        queue.push(right);
      }
      if (up >= 0 && mask[up] && !visited[up]) {
        visited[up] = 1;
        queue.push(up);
      }
      if (down >= 0 && mask[down] && !visited[down]) {
        visited[down] = 1;
        queue.push(down);
      }
    }

    const componentArea = component.length;
    const componentWidth = Math.max(1, maxX - minX + 1);
    const componentHeight = Math.max(1, maxY - minY + 1);
    const verticalDominance = componentHeight / componentWidth;
    const keep =
      componentArea >= minArea &&
      (!requireVerticalDominance || verticalDominance > 1.05);

    if (keep) {
      for (const index of component) {
        filtered[index] = 1;
      }
    }
  }

  return filtered;
}

function buildWallMaskFromLab(
  lab: Float32Array,
  luma: Float32Array,
  width: number,
  height: number,
  clusterCount = 5
): Uint8Array {
  const labels = runKMeansLab(lab, width, height, clusterCount);
  const laplacian = computeLaplacianMap(luma, width, height);
  const pixelCount = width * height;

  const stats = new Array(clusterCount).fill(0).map(() => ({
    area: 0,
    sumLap: 0,
    sumLapSq: 0,
    minX: width,
    maxX: 0,
    minY: height,
    maxY: 0,
  }));

  let globalLapSum = 0;
  let globalLapSq = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const cluster = labels[index];
    const x = index % width;
    const y = Math.floor(index / width);
    const lap = laplacian[index];

    const stat = stats[cluster];
    stat.area += 1;
    stat.sumLap += lap;
    stat.sumLapSq += lap * lap;
    if (x < stat.minX) stat.minX = x;
    if (x > stat.maxX) stat.maxX = x;
    if (y < stat.minY) stat.minY = y;
    if (y > stat.maxY) stat.maxY = y;

    globalLapSum += lap;
    globalLapSq += lap * lap;
  }

  const globalLapMean = globalLapSum / Math.max(1, pixelCount);
  const globalLapVariance =
    globalLapSq / Math.max(1, pixelCount) - globalLapMean * globalLapMean;
  const maxClusterLapVariance = Math.max(120, globalLapVariance * 0.65);

  const eligibleClusters = new Set<number>();
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const stat = stats[cluster];
    if (stat.area <= 0) {
      continue;
    }

    const areaRatio = stat.area / pixelCount;
    if (areaRatio <= 0.15) {
      continue;
    }

    const meanLap = stat.sumLap / stat.area;
    const varianceLap = stat.sumLapSq / stat.area - meanLap * meanLap;
    const bboxWidth = Math.max(1, stat.maxX - stat.minX + 1);
    const bboxHeight = Math.max(1, stat.maxY - stat.minY + 1);
    const verticalDominance = bboxHeight / bboxWidth;

    if (varianceLap <= maxClusterLapVariance && verticalDominance > 1.05) {
      eligibleClusters.add(cluster);
    }
  }

  const rawMask = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    if (eligibleClusters.has(labels[index])) {
      rawMask[index] = 1;
    }
  }

  return filterMaskComponents(rawMask, width, height, 0.01, true);
}

async function loadLabFeatureMap(
  imagePath: string,
  width: number,
  height: number
): Promise<{ lab: Float32Array; luma: Float32Array; width: number; height: number }> {
  const { data, info } = await sharp(imagePath)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .toColorspace("lab")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels || 3;
  const pixelCount = info.width * info.height;
  const lab = new Float32Array(pixelCount * 3);
  const luma = new Float32Array(pixelCount);

  for (let index = 0; index < pixelCount; index += 1) {
    const srcOffset = index * channels;
    const dstOffset = index * 3;
    const l = data[srcOffset] ?? 0;
    const a = data[srcOffset + 1] ?? 0;
    const b = data[srcOffset + 2] ?? 0;
    lab[dstOffset] = l;
    lab[dstOffset + 1] = a;
    lab[dstOffset + 2] = b;
    luma[index] = l;
  }

  return { lab, luma, width: info.width, height: info.height };
}

async function detectWallPlaneExpansion(
  baselinePath: string,
  candidatePath: string
): Promise<Stage1BWallDeltaResult> {
  const baselineMeta = await sharp(baselinePath).metadata();
  const baselineWidth = baselineMeta.width || 0;
  const baselineHeight = baselineMeta.height || 0;
  if (!baselineWidth || !baselineHeight) {
    return {
      hardFail: false,
      baselineArea: 0,
      candidateArea: 0,
      deltaRatio: 0,
      newWallRatio: 0,
      planeExpansionRatio: 0,
    };
  }

  const maxDimension = 640;
  const scale = Math.min(1, maxDimension / Math.max(baselineWidth, baselineHeight));
  const analysisWidth = Math.max(96, Math.round(baselineWidth * scale));
  const analysisHeight = Math.max(96, Math.round(baselineHeight * scale));

  const baseline = await loadLabFeatureMap(baselinePath, analysisWidth, analysisHeight);
  const candidate = await loadLabFeatureMap(candidatePath, analysisWidth, analysisHeight);

  const baselineMask = buildWallMaskFromLab(
    baseline.lab,
    baseline.luma,
    baseline.width,
    baseline.height,
    5
  );
  const candidateMask = buildWallMaskFromLab(
    candidate.lab,
    candidate.luma,
    candidate.width,
    candidate.height,
    5
  );

  const baselineArea = countMask(baselineMask);
  const candidateArea = countMask(candidateMask);

  const newWallMask = new Uint8Array(candidateMask.length);
  for (let index = 0; index < candidateMask.length; index += 1) {
    newWallMask[index] = candidateMask[index] && !baselineMask[index] ? 1 : 0;
  }

  const filteredNewWallMask = filterMaskComponents(
    newWallMask,
    analysisWidth,
    analysisHeight,
    0.002,
    false
  );
  const newWallArea = countMask(filteredNewWallMask);
  const baselineSafeArea = Math.max(1, baselineArea);
  const deltaRatio = (candidateArea - baselineArea) / baselineSafeArea;
  const newWallRatio = newWallArea / baselineSafeArea;
  const hardFail = newWallRatio > 0.03;

  return {
    hardFail,
    violationType: hardFail ? "wall_plane_expansion" : undefined,
    baselineArea,
    candidateArea,
    deltaRatio,
    newWallRatio,
    planeExpansionRatio: newWallRatio,
  };
}

async function publishWithOptionalBlackEdgeGuard(localPath: string, stageLabel: string) {
  if (FINAL_BLACK_EDGE_GUARD_ENABLED) {
    const guard = await applyFinalBlackEdgeGuard(localPath);
    if (guard.changed) {
      nLog(`[BLACK_EDGE_GUARD] stage=${stageLabel} action=cropped reason=${guard.reason}`);
    } else if (guard.reason !== "not_detected") {
      nLog(`[BLACK_EDGE_GUARD] stage=${stageLabel} action=skipped reason=${guard.reason}`);
    }
  }

  // Removed assertNoDarkBorder as per user request
  return publishImage(localPath);
}

async function detectStage1ABorderOrCornerArtifact(imagePath: string): Promise<boolean> {
  return false; // Disabled by user request
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
      if (!VALIDATOR_LOGS_FOCUS) {
        console.log(`[COMPLETION_GUARD_BLOCKED] job=${jobId} attemptId=${attemptedBy} incomingType=${incomingType} finalStatusAlreadySet=true`);
      }
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
  billingContext?: {
    payload?: any;
    sceneType?: string;
    stage1BUserSelected?: boolean;
    geminiHasFurniture?: boolean | null;
  };
}) {
  const { jobId, triggerStage, finalStage, finalPath, pub1AUrl, pub1BUrl, sceneMeta, userMessage, reason, stageOutputs, billingContext } = params;

  if (finalStage === "1A") {
    try {
      const stage1ATainted = await detectStage1ABorderOrCornerArtifact(finalPath);
      if (stage1ATainted) {
        nLog("[STAGE1A_TAINTED_FALLBACK_BLOCKED]", {
          jobId,
          triggerStage,
          reason,
          finalPath,
        });
        await safeWriteJobStatus(
          jobId,
          {
            status: "failed",
            errorMessage: "stage1a_tainted_fallback_blocked",
            currentStage: "1A",
            stage: "1A",
            meta: {
              stage1ATainted: true,
              stage1ATaintReason: "black_corner_or_border_detected",
              fallbackBlocked: true,
            },
          },
          "stage1a_tainted_fallback_blocked"
        );
        return;
      }
    } catch (taintErr: any) {
      nLog("[STAGE1A_TAINT_CHECK_ERROR]", {
        jobId,
        reason: taintErr?.message || String(taintErr),
      });
    }
  }

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
    finalOutputUrl: resultUrl,
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

  const finalizedJob = await getJob(jobId);
  const finalizedStatus = String((finalizedJob as any)?.status || "").toLowerCase();
  const isTerminalComplete = finalizedStatus === "complete" || finalizedStatus === "completed";
  const hasUsableFinalOutput = typeof resultUrl === "string" && resultUrl.length > 0;
  const billableFinalSuccess = isTerminalComplete && hasUsableFinalOutput;
  const isEnhancementJob = (billingContext?.payload as any)?.type === "enhance";
  const isFreeManualRetry = (billingContext?.payload as any)?.retryType === "manual_retry";
  const billingStage1ASuccess = !!(pub1AUrl || pub1BUrl || resultUrl);
  const billingStage1BSuccess = finalStage === "1B" ? !!(pub1BUrl || resultUrl) : false;
  const billingStage2Success = false;
  const billingEffectiveStage1B =
    billingStage1BSuccess &&
    ((billingContext?.stage1BUserSelected === true) || (billingContext?.geminiHasFurniture === true));
  const actualCharge = billableFinalSuccess && !isFreeManualRetry && isEnhancementJob ? 1 : 0;

  try {
    const agencyId = (billingContext?.payload as any)?.agencyId || null;
    const imagesUsed = billableFinalSuccess && !isFreeManualRetry && isEnhancementJob ? 1 : 0;
    if (billingContext?.payload) {
      await recordEnhanceBundleUsage(billingContext.payload, imagesUsed, agencyId);
    }
  } catch (usageErr) {
    nLog("[USAGE] Failed to record usage for partial completion (non-blocking):", (usageErr as any)?.message || usageErr);
  }

  nLog("[BILLING_CHARGE_TELEMETRY]", {
    jobId,
    imageId: (billingContext?.payload as any)?.imageId,
    stage1ASuccess: billingStage1ASuccess,
    stage1BSuccess: billingStage1BSuccess,
    stage2Success: billingStage2Success,
    finalCharge: actualCharge,
    path: "partial_fallback",
    stage1BUserSelected: billingContext?.stage1BUserSelected === true,
    geminiHasFurniture: billingContext?.geminiHasFurniture ?? null,
    billingEffectiveStage1B,
    billableFinalSuccess,
    completedStatus: finalizedStatus,
    isEnhancementJob,
    freeRetryNoAdditionalCharge: isFreeManualRetry,
  });

  try {
    await finalizeReservationFromWorker({
      jobId,
      stage12Success: true,
      stage2Success: false,
      actualCharge,
    });
    nLog(`[BILLING] Finalized reservation for partial completion ${jobId}: stage12=true, stage2=false`);
  } catch (billingErr) {
    nLog("[BILLING] Failed to finalize reservation for partial completion (non-blocking):", (billingErr as any)?.message || billingErr);
  }

  if (!isFreeManualRetry && isEnhancementJob) {
    try {
      await finalizeImageChargeFromWorker({
        jobId,
        stage1ASuccess: billingStage1ASuccess,
        stage1BSuccess: billingStage1BSuccess,
        stage2Success: billingStage2Success,
        sceneType: billingContext?.sceneType || "interior",
        stage1BUserSelected: billingContext?.stage1BUserSelected === true,
        geminiHasFurniture: billingContext?.geminiHasFurniture ?? undefined,
      });
    } catch (chargeErr) {
      nLog("[BILLING] Failed to finalize charge for partial completion (non-blocking):", (chargeErr as any)?.message || chargeErr);
    }
  } else {
    nLog(`[BILLING] Skipping charge finalization for partial completion non-billable job type or free manual retry: ${jobId}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRITICAL: Global error handlers to prevent silent crashes (bus errors)
// ═══════════════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (error, origin) => {
  logEvent("UNHANDLED_EXCEPTION", {
    kind: "uncaughtException",
    message: error?.message || String(error),
    origin,
  });
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
  logEvent("UNHANDLED_EXCEPTION", {
    kind: "unhandledRejection",
    reason: String((reason as any)?.message || reason),
  });
  console.error('[FATAL] Unhandled Promise Rejection:', {
    reason,
    promise
  });
  // Don't exit - just log for debugging
});

// Module-level ref so shutdown handlers can access the BullMQ worker
// (assigned after the Worker constructor at the bottom of the file)
let _workerRef: import('bullmq').Worker | null = null;
let _queueEventsRef: QueueEvents | null = null;
let _queueSchedulerRef: { close?: () => Promise<void> } | null = null;

async function gracefulShutdown(signal: string) {
  logEvent("SYSTEM_START", { phase: "shutdown", signal });
  const FORCE_EXIT_MS = 10_000;
  const forceTimer = setTimeout(() => {
    console.error(`[WORKER] Forced exit after ${FORCE_EXIT_MS}ms`);
    process.exit(1);
  }, FORCE_EXIT_MS);
  // Prevent the timer from keeping the process alive
  forceTimer.unref();

  try {
    if (_queueEventsRef) {
      await _queueEventsRef.close();
      _queueEventsRef = null;
    }
    if (_queueSchedulerRef?.close) {
      await _queueSchedulerRef.close();
      _queueSchedulerRef = null;
    }
    if (_workerRef) {
      await _workerRef.close();
      logEvent("SYSTEM_START", { phase: "shutdown_complete" });
    }
  } catch (err) {
    logEvent("SYSTEM_ERROR", {
      phase: "shutdown",
      error: (err as any)?.message || String(err),
    });
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

  logger.info("JOB_START", jobLogContext(payload, {
    event: "JOB_START",
    stage: "enhance",
  }));

  if (isValidationFocusMode()) {
    if (!VALIDATOR_LOGS_FOCUS) {
      console.log("[VALIDATION_FOCUS_MODE] enabled — suppressing non-validator logs");
    }
  }

  nLog(`========== PROCESSING JOB ${payload.jobId} ==========`);
  const imageLabel = (payload as any).label || (payload as any).originalFilename || payload.imageId || "unknown";
  let stagingStyleNorm: string | undefined =
    typeof (payload as any)?.options?.stagingStyle === "string"
      ? String((payload as any).options.stagingStyle).trim()
      : undefined;
  nLog(`[JOB_START] job=${payload.jobId} image=${imageLabel} stagingStyle=${normalizeForensicStagingStyle(stagingStyleNorm)}`);
  if ((payload as any).retryType === "manual_retry") {
    nLog(`[JOB_START] retryType=manual_retry sourceStage=${(payload as any).retrySourceStage || 'upload'} sourceUrl=${(payload as any).retrySourceUrl || 'n/a'} sourceKey=${(payload as any).retrySourceKey || 'n/a'} parentJobId=${(payload as any).retryParentJobId || 'n/a'} stagingStyle=${normalizeForensicStagingStyle(stagingStyleNorm)}`);
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
  let preflightCancelIntent = false;
  let preflightCancelSource: "job_record" | "redis" | "job_record+redis" | null = null;

  type RoutingSnapshot = {
    authority: "localEmptyBypass" | "gemini";
    localEmpty: boolean;
    geminiHasFurniture: boolean | null;
    geminiConfidence: number | null;
    declutterMode: "light" | "stage-ready" | null;
    stage1BRequired: boolean;
  };
  let frozenRoutingSnapshot: RoutingSnapshot | null = null;

  try {
    const [liveJob, savedMeta] = await Promise.all([
      getJob(payload.jobId),
      getJobMetadata(payload.jobId),
    ]);

    const existingMeta = (liveJob as any)?.metadata as JobOwnershipMetadata | undefined;
    const existingRoutingSnapshot = (liveJob as any)?.meta?.routingSnapshot || (liveJob as any)?.metadata?.routingSnapshot;
    if (existingRoutingSnapshot && typeof existingRoutingSnapshot === "object") {
      frozenRoutingSnapshot = existingRoutingSnapshot as RoutingSnapshot;
    }
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

    const liveStatus = String((liveJob as any)?.status || "").toLowerCase();
    const hasJobCancelIntent =
      liveStatus === "cancelling" ||
      liveStatus === "cancelled" ||
      (liveJob as any)?.cancelRequested === true ||
      String((liveJob as any)?.errorMessage || "").toLowerCase() === "cancel_requested";
    if (hasJobCancelIntent) {
      preflightCancelIntent = true;
      preflightCancelSource = "job_record";
    }

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

  let hasRedisCancelFlag = false;
  try {
    hasRedisCancelFlag = await isCancelled(payload.jobId);
  } catch {
    hasRedisCancelFlag = false;
  }
  if (hasRedisCancelFlag) {
    preflightCancelIntent = true;
    preflightCancelSource = preflightCancelSource === "job_record" ? "job_record+redis" : "redis";
  }
  if (preflightCancelIntent) {
    nLog("[CANCEL_PREFLIGHT_EXIT]", {
      jobId: payload.jobId,
      source: preflightCancelSource,
    });
    await safeWriteJobStatus(
      payload.jobId,
      { status: "cancelled", errorMessage: "cancelled" },
      "cancel_preflight"
    );
    return;
  }

  const stopIfCancelled = async (reason: string): Promise<boolean> => {
    if (!(await isCancelled(payload.jobId))) return false;
    nLog("[CANCEL_CHECKPOINT_HIT]", { jobId: payload.jobId, reason });
    await safeWriteJobStatus(
      payload.jobId,
      { status: "cancelled", errorMessage: "cancelled" },
      `cancel_${reason}`
    );
    return true;
  };

  let stage12Success = false;
  let stage2Success = false;
  let stage2PublishSuccess = false;
  let stage2PublishedUrl: string | undefined = undefined;
  let stage2AttemptsUsed = 0;
  let stage2MaxAttempts = 1;
  let stage2ValidationRisk = false;
  let stage2Blocked = false;
  let stage2BlockedReason: string | undefined;
  let stage2Skipped = false;
  let stage2SkipReason: string | undefined;
  let stage2FallbackStage: "1A" | "1B" | null = null;
  let fallbackUsed: string | null = null;
  let stage2NeedsConfirm = false;
  let stage2LocalReasons: string[] = [];
  let stage2ConsensusCaseACount = 0;
  let stage2ConsensusCaseBCount = 0;
  let stage2ConsensusCaseCCount = 0;
  let compliance: any = undefined;
  const stage2AttemptOutputs: Array<{
    attempt: number;
    localPath: string;
    publishedUrl?: string;
    signedUrl?: string;
    imageKey?: string;
    blockedBy?: string | null;
    reasons?: string[] | null;
  }> = [];
  const stageOutputSigningCache = new Map<string, { signedUrl: string | null; imageKey: string | null; publishedUrl: string | null }>();
  const jobAttemptLog = {
    jobId: payload.jobId,
    roomType: payload.options.roomType || null,
    stagingStyle: stagingStyleNorm,
    stageLogs: {
      "1B": [] as Array<{
        attempt: number;
        signedUrl: string | null;
        imageKey: string | null;
        publishedUrl: string | null;
        validation: {
          local: Record<string, any>;
          gemini: Record<string, any>;
          confirm: Record<string, any> | null;
          final: Record<string, any>;
        };
      }>,
      "2": [] as Array<{
        attempt: number;
        signedUrl: string | null;
        imageKey: string | null;
        publishedUrl: string | null;
        validation: {
          local: Record<string, any>;
          gemini: Record<string, any>;
          confirm: Record<string, any> | null;
          final: Record<string, any>;
        };
      }>,
    },
  };
  let jobAttemptSummaryEmitted = false;
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
    structuralBaseline: StructuralBaseline | null;
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
    structuralBaseline: null,
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

  const stage2LayoutPlanCache = new Map<string, Stage2LayoutPlan>();
  const isPersistableLayoutPlan = (value: any): value is Stage2LayoutPlan => {
    return !!(
      value &&
      typeof value === "object" &&
      typeof value.room_type === "string" &&
      Array.isArray(value.layout) &&
      Array.isArray(value.avoid_zones)
    );
  };

  let structuralBaseline: StructuralBaseline | null = null;
  let structuralBaselinePromise: Promise<StructuralBaseline | null> | null = null;
  try {
    const existingJobState: any = await getJob(payload.jobId);
    const persistedBaseline = existingJobState?.structuralBaseline || existingJobState?.meta?.structuralBaseline;
    if (persistedBaseline && Array.isArray(persistedBaseline.openings)) {
      structuralBaseline = persistedBaseline as StructuralBaseline;
      jobContext.structuralBaseline = structuralBaseline;
      structuralBaselinePromise = Promise.resolve(structuralBaseline);
      nLog(`[STRUCTURAL_BASELINE_HYDRATED] jobId=${payload.jobId} openings=${structuralBaseline.openings.length}`);
    }

    const persistedLayoutPlans =
      existingJobState?.meta?.stage2LayoutPlans ||
      existingJobState?.metadata?.stage2LayoutPlans;
    if (persistedLayoutPlans && typeof persistedLayoutPlans === "object") {
      for (const [cacheKey, maybePlan] of Object.entries(persistedLayoutPlans as Record<string, any>)) {
        if (!isPersistableLayoutPlan(maybePlan)) continue;
        stage2LayoutPlanCache.set(cacheKey, maybePlan as Stage2LayoutPlan);
      }
      if (stage2LayoutPlanCache.size > 0) {
        nLog("[STAGE2_LAYOUT_PLAN_HYDRATED]", {
          jobId: payload.jobId,
          entries: stage2LayoutPlanCache.size,
        });
      }
    }
  } catch (hydrateErr: any) {
    nLog(`[STRUCTURAL_BASELINE_HYDRATE_ERROR] jobId=${payload.jobId} reason=${hydrateErr?.message || hydrateErr}`);
  }

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

  const ensureAttemptLogEntry = (stage: "1B" | "2", attempt: number) => {
    let entry = jobAttemptLog.stageLogs[stage].find((item) => item.attempt === attempt);
    if (!entry) {
      entry = {
        attempt,
        signedUrl: null,
        imageKey: null,
        publishedUrl: null,
        validation: {
          local: {},
          gemini: {},
          confirm: null,
          final: {},
        },
      };
      jobAttemptLog.stageLogs[stage].push(entry);
      jobAttemptLog.stageLogs[stage].sort((a, b) => a.attempt - b.attempt);
    }
    return entry;
  };

  const mergeAttemptValidation = (
    stage: "1B" | "2",
    attempt: number,
    patch: {
      local?: Record<string, any>;
      gemini?: Record<string, any>;
      confirm?: Record<string, any> | null;
      final?: Record<string, any>;
    }
  ) => {
    const entry = ensureAttemptLogEntry(stage, attempt);
    if (patch.local) {
      entry.validation.local = { ...entry.validation.local, ...patch.local };
    }
    if (patch.gemini) {
      entry.validation.gemini = { ...entry.validation.gemini, ...patch.gemini };
    }
    if (patch.confirm !== undefined) {
      entry.validation.confirm = patch.confirm;
    }
    if (patch.final) {
      entry.validation.final = { ...entry.validation.final, ...patch.final };
    }
  };

  const annotateAttemptSignedUrl = (
    stage: "1B" | "2",
    attempt: number,
    signed: { signedUrl: string | null; imageKey: string | null; publishedUrl: string | null }
  ) => {
    const entry = ensureAttemptLogEntry(stage, attempt);
    entry.signedUrl = signed.signedUrl;
    entry.imageKey = signed.imageKey;
    entry.publishedUrl = signed.publishedUrl;
  };

  const captureSignedStageOutput = async (
    stage: "1B" | "2",
    attempt: number,
    localPath: string,
  ): Promise<{ signedUrl: string | null; imageKey: string | null; publishedUrl: string | null }> => {
    if (!SIGN_ALL_STAGE_OUTPUTS_ENABLED) {
      return { signedUrl: null, imageKey: null, publishedUrl: null };
    }

    if (stageOutputSigningCache.has(localPath)) {
      const cached = stageOutputSigningCache.get(localPath)!;
      annotateAttemptSignedUrl(stage, attempt, cached);
      console.log(
        `[IMAGE_ATTEMPT_URL] stage=${stage} attempt=${attempt} job_id=${payload.jobId} file=${localPath.split("/").pop() || localPath} signed_url=${cached.signedUrl || ""}`
      );
      logStructured("STAGE_OUTPUT_SIGNED", {
        jobId: payload.jobId,
        stage,
        attempt,
        imageKey: cached.imageKey,
        signedUrl: cached.signedUrl,
      });
      return cached;
    }

    const signed = await createDebugSignedUrl(localPath, payload.jobId);
    const imageKey = signed.key;
    const signedUrl = signed.signedUrl;

    console.log(
      `[IMAGE_ATTEMPT_URL] stage=${stage} attempt=${attempt} job_id=${payload.jobId} file=${localPath.split("/").pop() || localPath} signed_url=${signedUrl || ""}`
    );

    const snapshot = {
      signedUrl,
      imageKey,
      publishedUrl: signedUrl,
    };
    stageOutputSigningCache.set(localPath, snapshot);
    annotateAttemptSignedUrl(stage, attempt, snapshot);

    const stage2Match = stage === "2"
      ? stage2AttemptOutputs.find((entry) => entry.localPath === localPath)
      : null;
    if (stage2Match) {
      stage2Match.signedUrl = signedUrl || undefined;
      stage2Match.imageKey = imageKey || undefined;
      stage2Match.publishedUrl = stage2Match.publishedUrl || signedUrl || undefined;
    }

    logStructured("STAGE_OUTPUT_SIGNED", {
      jobId: payload.jobId,
      stage,
      attempt,
      imageKey,
      signedUrl,
    });

    return snapshot;
  };

  const emitJobAttemptSummary = (finalStatus: "SUCCESS" | "EXHAUSTED" | "BLOCKED") => {
    if (jobAttemptSummaryEmitted) return;
    jobAttemptSummaryEmitted = true;

    logStructured("JOB_ATTEMPT_SUMMARY", {
      ...jobAttemptLog,
      finalStatus,
    });

    const lines: string[] = [];
    lines.push("==============================");
    lines.push("IMAGE JOB SUMMARY");
    lines.push("==============================");
    lines.push(`Image: ${payload.jobId}`);
    lines.push(`Room: ${jobAttemptLog.roomType || payload.options.roomType || "unknown"}`);
    lines.push(`Staging Style: ${normalizeForensicStagingStyle(jobAttemptLog.stagingStyle)}`);
    lines.push("");

    const renderStage = (stageLabel: "1B" | "2") => {
      lines.push(`Stage ${stageLabel}:`);
      const attempts = [...jobAttemptLog.stageLogs[stageLabel]].sort((a, b) => a.attempt - b.attempt);
      if (!attempts.length) {
        lines.push("  (no attempts)");
        lines.push("");
        return;
      }
      for (const attemptEntry of attempts) {
        lines.push(`  Attempt ${attemptEntry.attempt}:`);
        lines.push(`    URL: ${attemptEntry.signedUrl || "N/A"}`);
        const result = String(attemptEntry.validation.final?.result || "UNKNOWN").toUpperCase();
        lines.push(`    Result: ${result}`);
        const reason = attemptEntry.validation.final?.reason || attemptEntry.validation.gemini?.violationType;
        if (reason) {
          const confidence = attemptEntry.validation.gemini?.confidence;
          lines.push(
            `    Reason: ${reason}${typeof confidence === "number" ? ` (confidence ${confidence})` : ""}`
          );
        }
        lines.push("");
      }
    };

    renderStage("1B");
    renderStage("2");
    lines.push(`Final Status: ${finalStatus}`);
    lines.push("==============================");

    for (const line of lines) {
      nLog(line);
    }
  };

  const inferForensicRetryReason = (attemptNumber: number, reasonText: string): "initial" | "structural_violation" | "opening_removed" | "cosmetic" | "unknown" => {
    if (attemptNumber <= 1) return "initial";
    const normalized = String(reasonText || "").toLowerCase();
    if (!normalized) return "unknown";
    if (/(opening|window|door|closet|infilled|relocat)/.test(normalized)) return "opening_removed";
    if (/(structural|invariant|topology|wall|drift|distortion|orientation)/.test(normalized)) return "structural_violation";
    if (/(style|cosmetic|lighting|decor|furniture)/.test(normalized)) return "cosmetic";
    return "unknown";
  };

  const normalizeForensicDecisionSource = (blockedBy?: string | null): "local" | "gemini" | "consensus" => {
    const normalized = String(blockedBy || "").toLowerCase();
    if (normalized === "gemini") return "gemini";
    if (normalized === "consensus") return "consensus";
    return "local";
  };

  const inferForensicRetryTrigger = (params: {
    attemptNumber: number;
    blockedBy?: string | null;
    finalReason?: string | null;
    localReasons?: string[];
    localWarnings?: string[];
  }): string => {
    if (params.attemptNumber <= 1) return "initial";

    const blockedBy = String(params.blockedBy || "").toLowerCase();
    if (blockedBy === "consensus") return "validator_consensus";
    if (blockedBy === "gemini") return "gemini_structural_fail";

    const joined = [
      params.finalReason || "",
      ...(params.localReasons || []),
      ...(params.localWarnings || []),
      blockedBy,
    ].join(" ").toLowerCase();

    if (/(opening_removed|opening_removal|opening removed|opening removal)/.test(joined)) {
      return "opening_removed";
    }
    if (/(geometry|drift|topology|opening_preservation|structural_invariant|topology_violation)/.test(joined)) {
      return "opening_geometry_drift";
    }
    if (/(consensus|case_a|case_b|case_c)/.test(joined)) {
      return "validator_consensus";
    }
    if (/(gemini|semantic|compliance)/.test(joined)) {
      return "gemini_structural_fail";
    }
    return "unknown";
  };

  const isHttpUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    return /^https?:\/\//i.test(value.trim());
  };

  const toLikelyDebugUrlFromKey = (key?: string | null): string | null => {
    if (!key || !key.startsWith("debug-attempts/")) return null;
    const base = String(process.env.S3_PUBLIC_BASEURL || "").replace(/\/$/, "");
    if (!base) return null;
    return `${base}/${key}`;
  };

  const flushEnhanceForensicSnapshot = (params: {
    uploadUrl?: string | null;
    stage1AUrl?: string | null;
    finalStatus?: string;
    warningsCount?: number;
    hardFail?: boolean;
    completionGuard?: string;
    finalOutputUrl?: string | null;
  }) => {
    const attempts = [...jobAttemptLog.stageLogs["2"]]
      .sort((a, b) => a.attempt - b.attempt)
      .map((attemptEntry) => {
        const outputMatches = stage2AttemptOutputs.filter((entry) => entry.attempt === attemptEntry.attempt - 1);
        const outputMatch = outputMatches[0];
        const localReasons = Array.isArray(attemptEntry.validation.local?.reasons)
          ? attemptEntry.validation.local.reasons.map((x: any) => String(x))
          : [];
        const localWarnings = Array.isArray(attemptEntry.validation.local?.warnings)
          ? attemptEntry.validation.local.warnings.map((x: any) => String(x))
          : [];
        const finalReason = String(attemptEntry.validation.final?.reason || localReasons.join(";") || "");
        const retryKind = inferForensicRetryReason(attemptEntry.attempt, finalReason);
        const model = resolveStage2Model(attemptEntry.attempt, retryKind as any);
        const candidateUrl = attemptEntry.signedUrl || outputMatch?.signedUrl || outputMatch?.publishedUrl || null;
        const outputUrl = attemptEntry.publishedUrl || outputMatch?.publishedUrl || null;

        const outputUrls = outputMatches.flatMap((entry) => [
          entry.signedUrl,
          entry.publishedUrl,
        ]);
        const debugUrlsFromKeys = [
          toLikelyDebugUrlFromKey(attemptEntry.imageKey),
          ...outputMatches.map((entry) => toLikelyDebugUrlFromKey(entry.imageKey)),
        ];
        const artifactUrls = [
          candidateUrl,
          outputUrl,
          attemptEntry.signedUrl,
          attemptEntry.publishedUrl,
          ...outputUrls,
          ...debugUrlsFromKeys,
          outputMatch?.signedUrl,
          outputMatch?.publishedUrl,
        ].filter((value, index, arr): value is string => isHttpUrl(value) && arr.indexOf(value) === index);

        const decisionSource = normalizeForensicDecisionSource(
          outputMatch?.blockedBy
          || attemptEntry.validation.final?.decisionSource
          || (attemptEntry.validation.gemini?.hardFail === true ? "gemini" : null)
          || (attemptEntry.validation.final?.result === "FAILED" && attemptEntry.validation.local?.hardFail === true ? "local" : null)
          || null
        );
        const retryTrigger = inferForensicRetryTrigger({
          attemptNumber: attemptEntry.attempt,
          blockedBy: outputMatch?.blockedBy || null,
          finalReason,
          localReasons,
          localWarnings,
        });

        return {
          attemptNumber: attemptEntry.attempt,
          pipelineStage: "2" as const,
          model,
          retryReason: finalReason || retryKind,
          retryTrigger,
          validatorWarnings: [...localReasons, ...localWarnings].filter((value, index, arr) => arr.indexOf(value) === index),
          decisionSource,
          compositeDecision:
            attemptEntry.validation.final?.result === "FAILED" || attemptEntry.validation.local?.hardFail === true
              ? "FAIL"
              : "PASS",
          geminiConfirmation: attemptEntry.validation.confirm !== null,
          geminiResult: (attemptEntry.validation.gemini?.hardFail === true ? "fail" : "pass") as "pass" | "fail",
          candidateUrl,
          outputUrl,
          artifactUrls,
        };
      });

    upsertForensicJobSnapshot(payload.jobId, {
      stagingStyle: normalizeForensicStagingStyle(stagingStyleNorm),
      uploadUrl: params.uploadUrl ?? null,
      stage1AUrl: params.stage1AUrl ?? null,
      attempts,
      finalStatus: params.finalStatus || "processing",
      warningsCount: Number.isFinite(Number(params.warningsCount)) ? Number(params.warningsCount) : 0,
      hardFail: params.hardFail === true,
      completionGuard: params.completionGuard || "unknown",
      finalOutputUrl: params.finalOutputUrl ?? null,
    });
  };

  const flushStage1AFailureForensicSnapshot = (reason: string) => {
    upsertForensicJobSnapshot(payload.jobId, {
      stagingStyle: normalizeForensicStagingStyle(stagingStyleNorm),
      uploadUrl: (payload as any).remoteOriginalUrl || null,
      attempts: [
        {
          attemptNumber: 1,
          pipelineStage: "1A",
          model: "stage1A",
          retryReason: reason,
          retryTrigger: reason,
          validatorWarnings: [reason],
          decisionSource: "local",
          compositeDecision: "FAIL",
          geminiConfirmation: false,
          geminiResult: "pass",
          candidateUrl: null,
          outputUrl: null,
          artifactUrls: [],
        },
      ],
      finalStatus: "failed",
      warningsCount: 1,
      hardFail: true,
      completionGuard: "stage1a_blocked",
      finalOutputUrl: null,
    });
  };

  const completePartialJobWithSummary = async (params: Parameters<typeof completePartialJob>[0]) => {
    emitJobAttemptSummary("EXHAUSTED");
    flushEnhanceForensicSnapshot({
      uploadUrl: (payload as any).remoteOriginalUrl || null,
      stage1AUrl: params.pub1AUrl || null,
      finalStatus: "partial",
      warningsCount: 0,
      hardFail: true,
      completionGuard: "fallback",
      finalOutputUrl: (params.finalStage === "1A" ? params.pub1AUrl : params.pub1BUrl) || null,
    });
    await completePartialJob(params);
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
        signedUrl: entry.signedUrl ?? null,
        imageKey: entry.imageKey ?? null,
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
  const stage2SupersededActions = new Set<string>();
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

  const resolveStage2LayoutPlan = async (ctx: {
    basePath: string;
    path: "main" | "stage2_only" | "light_declutter_backstop";
    promptMode: "full" | "refresh";
    sourceStage: "1A" | "1B-light" | "1B-stage-ready";
    isExteriorScene: boolean;
  }): Promise<Stage2LayoutPlan | null> => {
    const plannerEnabled = String(process.env.USE_GEMINI_LAYOUT_PLANNER || "1") !== "0";
    if (!plannerEnabled) return null;
    if (!ctx.basePath) return null;
    if (ctx.isExteriorScene) return null;

    const layoutPlanCacheKey = `${ctx.path}|${ctx.promptMode}|${ctx.sourceStage}|${ctx.basePath}`;
    const cachedLayoutPlan = stage2LayoutPlanCache.get(layoutPlanCacheKey);
    if (cachedLayoutPlan) {
      nLog("[STAGE2_LAYOUT_PLANNER_CACHE_HIT]", {
        jobId: payload.jobId,
        path: ctx.path,
        promptMode: ctx.promptMode,
        sourceStage: ctx.sourceStage,
      });
      return cachedLayoutPlan;
    }

    const anchorPlannerEligible =
      STAGE2_ANCHOR_PLANNER_ENABLED &&
      ctx.promptMode === "full";

    let anchorBaseline: StructuralBaseline | null = null;
    if (anchorPlannerEligible) {
      if (structuralBaseline) {
        anchorBaseline = structuralBaseline;
      } else if (structuralBaselinePromise) {
        const waitStart = Date.now();
        nLog("[ANCHOR_BASELINE_SYNC_WAIT_START]", {
          jobId: payload.jobId,
          path: ctx.path,
        });
        try {
          anchorBaseline = await structuralBaselinePromise;
          if (anchorBaseline) {
            structuralBaseline = anchorBaseline;
            jobContext.structuralBaseline = anchorBaseline;
          }
          nLog("[ANCHOR_BASELINE_SYNC_WAIT_DONE]", {
            jobId: payload.jobId,
            path: ctx.path,
            elapsedMs: Date.now() - waitStart,
            openings: anchorBaseline?.openings?.length || 0,
          });
        } catch (baselineSyncErr: any) {
          nLog("[ANCHOR_BASELINE_SYNC_WAIT_FAILED]", {
            jobId: payload.jobId,
            path: ctx.path,
            elapsedMs: Date.now() - waitStart,
            error: baselineSyncErr?.message || String(baselineSyncErr),
          });
        }
      } else {
        nLog("[ANCHOR_BASELINE_SYNC_UNAVAILABLE]", {
          jobId: payload.jobId,
          path: ctx.path,
        });
      }
    }

    try {
      const plan = await planStage2Layout(ctx.basePath, {
        jobId: payload.jobId,
        roomType: String(payload.options.roomType || ""),
        anchorPlannerEnabled: anchorPlannerEligible,
        structuralBaseline: anchorBaseline,
        anchorConfidenceThreshold: STAGE2_ANCHOR_MIN_CONFIDENCE,
        useGeminiFallback: true,
      });

      if (plan) {
        stage2LayoutPlanCache.set(layoutPlanCacheKey, plan);
        try {
          const existingDurableMeta = await getJobMetadata(payload.jobId);
          const persistedLayoutPlans = {
            ...((existingDurableMeta as any)?.stage2LayoutPlans || {}),
            [layoutPlanCacheKey]: plan,
          };
          const durableMetaWithPlans = {
            ...(existingDurableMeta || {}),
            stage2LayoutPlans: persistedLayoutPlans,
          } as JobOwnershipMetadata & { stage2LayoutPlans: Record<string, Stage2LayoutPlan> };

          await Promise.all([
            updateJob(payload.jobId, {
              metadata: durableMetaWithPlans,
              meta: {
                ...(sceneLabel ? { ...sceneMeta } : {}),
                stage2LayoutPlans: persistedLayoutPlans,
              },
            }),
            saveJobMetadata(durableMetaWithPlans, JOB_META_TTL_PROCESSING_SECONDS),
          ]);
        } catch (persistErr: any) {
          nLog("[STAGE2_LAYOUT_PLAN_PERSIST_ERROR]", {
            jobId: payload.jobId,
            path: ctx.path,
            error: persistErr?.message || String(persistErr),
          });
        }
      }

      nLog("[STAGE2_LAYOUT_PLANNER]", {
        jobId: payload.jobId,
        path: ctx.path,
        promptMode: ctx.promptMode,
        sourceStage: ctx.sourceStage,
        status: plan ? "ready" : "fallback",
        roomType: plan?.room_type || null,
        layoutItems: plan?.layout?.length || 0,
        anchorPlannerEnabled: anchorPlannerEligible,
        anchorItem: plan?.anchorItem || null,
        anchorWall: plan?.anchorWall || null,
        anchorOrientation: plan?.anchorOrientation || null,
      });
      if (anchorPlannerEligible && !plan?.anchorItem) {
        nLog("[ANCHOR_PLAN_FALLBACK]", {
          jobId: payload.jobId,
          path: ctx.path,
          reason: "anchor_unavailable_or_low_confidence",
        });
      }
      return plan;
    } catch (plannerError: any) {
      nLog("[STAGE2_LAYOUT_PLANNER]", {
        jobId: payload.jobId,
        path: ctx.path,
        promptMode: ctx.promptMode,
        sourceStage: ctx.sourceStage,
        status: "failed",
        error: plannerError?.message || String(plannerError),
      });
      return null;
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

      if (!stage2SupersededActions.has(action)) {
        stage2SupersededActions.add(action);
        try {
          await safeWriteJobStatus(
            payload.jobId,
            {
              status: "processing",
              message: "Stage 2 retry superseded by a newer attempt. Continuing latest attempt.",
              retryPendingStage2: true,
              stage2Superseded: {
                action,
                staleAttemptId: currentAttemptId,
                activeAttemptId: current.stage2AttemptId,
                at: new Date().toISOString(),
              },
            },
            "stage2_attempt_superseded"
          );
        } catch (supersededWriteErr: any) {
          nLog("[STAGE2_SUPERSEDED_STATUS_WRITE_FAILED]", {
            jobId: payload.jobId,
            action,
            error: supersededWriteErr?.message || String(supersededWriteErr),
          });
        }
      }

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

      if (!stage2SupersededActions.has(action)) {
        stage2SupersededActions.add(action);
        try {
          await safeWriteJobStatus(
            payload.jobId,
            {
              status: "processing",
              message: "Stage 2 completion skipped because a newer retry attempt is active.",
              retryPendingStage2: true,
              stage2Superseded: {
                action,
                staleAttemptId: currentAttemptId,
                activeAttemptId: current.stage2AttemptId,
                at: new Date().toISOString(),
              },
            },
            "stage2_completion_superseded"
          );
        } catch (supersededWriteErr: any) {
          nLog("[STAGE2_SUPERSEDED_STATUS_WRITE_FAILED]", {
            jobId: payload.jobId,
            action,
            error: supersededWriteErr?.message || String(supersededWriteErr),
          });
        }
      }

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
  const retryExecutionPlan = ((payload as any).executionPlan && typeof (payload as any).executionPlan === "object")
    ? ((payload as any).executionPlan as {
        runStage1A?: boolean;
        runStage1B?: boolean;
        runStage2?: boolean;
        stage2Baseline?: "1A" | "1B" | "original_upload";
        baselineUrl?: string;
        sourceStage?: string;
      })
    : undefined;
  const retryStagesToRunRaw = Array.isArray((payload as any).retryStagesToRun)
    ? ((payload as any).retryStagesToRun as string[])
    : [];
  const retryStagesToRun = Array.from(
    new Set(
      retryStagesToRunRaw
        .map((stage) => String(stage || "").trim().toUpperCase())
        .filter((stage): stage is "1A" | "1B" | "2" => stage === "1A" || stage === "1B" || stage === "2")
    )
  );
  const retryPlanIsStage2Only = retryExecutionPlan
    ? (!!retryExecutionPlan.runStage2 && !retryExecutionPlan.runStage1A && !retryExecutionPlan.runStage1B)
    : (retryStagesToRun.length
      ? (retryStagesToRun.length === 1 && retryStagesToRun[0] === "2")
      : true);

  if (isManualRetry && retryExecutionPlan?.runStage2) {
    const hasBaselineUrl = !!retryExecutionPlan.baselineUrl;
    const hasBaselineStage =
      retryExecutionPlan.stage2Baseline === "1A"
      || retryExecutionPlan.stage2Baseline === "1B"
      || retryExecutionPlan.stage2Baseline === "original_upload";
    if (!hasBaselineUrl || !hasBaselineStage) {
      nLog("[STAGE2_EXECUTION_PLAN_INVALID]", {
        jobId: payload.jobId,
        retryType: (payload as any).retryType,
        executionPlan: retryExecutionPlan,
      });
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: "stage2_retry_failed: invalid_execution_plan" },
        "stage2_retry_failed_invalid_execution_plan"
      );
      return;
    }
  }

  if (isManualRetry && retryExecutionPlan && retryPlanIsStage2Only && !payload.stage2OnlyMode?.enabled) {
    const planBaseline = retryExecutionPlan.stage2Baseline;
    const planBaselineUrl = retryExecutionPlan.baselineUrl;
    if ((planBaseline === "1A" || planBaseline === "1B") && !!planBaselineUrl) {
      const inferredStage1BMode: "light" | "stage-ready" = payload.options?.declutterMode === "light" ? "light" : "stage-ready";
      (payload as any).stage2OnlyMode = {
        enabled: true,
        baseStage: planBaseline,
        base1AUrl: planBaseline === "1A" ? planBaselineUrl : undefined,
        base1BUrl: planBaseline === "1B" ? planBaselineUrl : undefined,
        sourceStage: retryExecutionPlan.sourceStage || (planBaseline === "1A" ? "1A" : "1B-stage-ready"),
        stage1BMode: inferredStage1BMode,
      };

      const derivedBaselineSourceCount = Number(planBaseline === "1A" && !!(payload as any).stage2OnlyMode.base1AUrl)
        + Number(planBaseline === "1B" && !!(payload as any).stage2OnlyMode.base1BUrl);
      if (derivedBaselineSourceCount !== 1) {
        nLog("[STAGE2_ONLY_DERIVATION_INVALID]", {
          jobId: payload.jobId,
          executionPlan: retryExecutionPlan,
          derivedStage2OnlyMode: (payload as any).stage2OnlyMode,
          derivedBaselineSourceCount,
        });
        await safeWriteJobStatus(
          payload.jobId,
          { status: "failed", errorMessage: "stage2_retry_failed: invalid_derived_stage2_baseline" },
          "stage2_retry_failed_invalid_derived_stage2_baseline"
        );
        return;
      }
    }
  }

  if (isManualRetry && retryPlanIsStage2Only) {
    const stage2OnlyBaseStage = retryExecutionPlan?.stage2Baseline === "1A"
      ? "1A"
      : ((payload.stage2OnlyMode as any)?.baseStage === "1A")
        ? "1A"
        : "1B";
    const hasValidRetryBaseline = stage2OnlyBaseStage === "1A"
      ? (
        !!(retryExecutionPlan?.baselineUrl || (payload.stage2OnlyMode as any)?.base1AUrl)
        && !(payload as any).retryStage1BWasRequested
      )
      : !!(retryExecutionPlan?.baselineUrl || payload.stage2OnlyMode?.base1BUrl);
    const hasDeterministicStage2OnlyPayload =
      stage2Requested &&
      ((retryExecutionPlan && retryExecutionPlan.runStage2 === true) || payload.stage2OnlyMode?.enabled) &&
      hasValidRetryBaseline;
    if (!hasDeterministicStage2OnlyPayload) {
      nLog("[STAGE2_ONLY_PAYLOAD_INVALID]", {
        jobId: payload.jobId,
        retryType: (payload as any).retryType,
        hasExecutionPlan: !!retryExecutionPlan,
        executionPlan: retryExecutionPlan || null,
        stage2Requested,
        stage2OnlyEnabled: !!payload.stage2OnlyMode?.enabled,
        baseStage: stage2OnlyBaseStage,
        hasBase1BUrl: !!(retryExecutionPlan?.baselineUrl || payload.stage2OnlyMode?.base1BUrl),
        hasBase1AUrl: !!(retryExecutionPlan?.baselineUrl || (payload.stage2OnlyMode as any)?.base1AUrl),
        retryStage1BWasRequested: !!(payload as any).retryStage1BWasRequested,
      });
      await safeWriteJobStatus(
        payload.jobId,
        { status: "failed", errorMessage: "stage2_retry_failed: invalid_manual_retry_payload" },
        "stage2_retry_failed_invalid_payload"
      );
      flushEnhanceForensicSnapshot({
        uploadUrl: (payload as any).remoteOriginalUrl || null,
        stage1AUrl: (payload.stage2OnlyMode as any)?.base1AUrl || null,
        finalStatus: "failed",
        warningsCount: 1,
        hardFail: true,
        completionGuard: "invalid_manual_retry_payload",
        finalOutputUrl: null,
      });
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
  if (isManualRetry && retryPlanIsStage2Only && stage2Requested && payload.stage2OnlyMode?.enabled && !!stage2OnlyBaseSourceUrl) {
    nLog(`[worker] 🚀 ═══════════ STAGE-2-ONLY RETRY MODE ACTIVATED ═══════════`);
    nLog(`[worker] Reusing validated Stage-${stage2OnlyBaseStage} output: ${stage2OnlyBaseSourceUrl}`);

    try {
      await ensureStage2AttemptId();
      if (await stopIfCancelled("stage2_only_start")) return;
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
      if (await stopIfCancelled("stage2_only_pre_stage2")) return;

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
      nLog("[STAGE2_PROMPT_SOURCE]", {
        source: "pipeline",
        retryType: "initial",
      });
      const stage2OnlyLayoutPlan = await resolveStage2LayoutPlan({
        basePath,
        path: "stage2_only",
        promptMode: stage2OnlyRouting.mode,
        sourceStage: stage2OnlyRouting.sourceStage,
        isExteriorScene: payload.options.sceneType === "exterior",
      });
      const stage2Result = await runStage2(basePath, stage2OnlyBaseStage, {
        stagingStyle: payload.options.stagingStyle || "standard_listing",
        roomType: payload.options.roomType,
        sceneType: payload.options.sceneType as any,
        angleHint: undefined,
        profile: undefined,
        stagingRegion: undefined,
        sourceStage: stage2OnlyRouting.sourceStage,
        promptMode: stage2OnlyRouting.mode,
        jobId: payload.jobId,
        layoutPlan: stage2OnlyLayoutPlan,
        curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
        onAttemptSuperseded: (nextAttemptId) => {
          stage2AttemptId = nextAttemptId;
        },
      });
      const path2 = stage2Result.outputPath;
      if (await stopIfCancelled("stage2_only_post_stage2")) return;
      recordStage2AttemptsFromResult(basePath, stage2Result.attempts);
      const stage2OnlyAttemptsUsed = Math.max(1, Number(stage2Result.attempts || 1));
      for (let attemptIndex = 0; attemptIndex < stage2OnlyAttemptsUsed; attemptIndex++) {
        const attemptNo = attemptIndex + 1;
        const attemptPath = attemptIndex === stage2OnlyAttemptsUsed - 1
          ? path2
          : siblingOutPath(basePath, attemptIndex === 0 ? "-2" : `-2-retry${attemptIndex}`, ".webp");
        try {
          const signed = await captureSignedStageOutput("2", attemptNo, attemptPath);
          annotateAttemptSignedUrl("2", attemptNo, signed);
        } catch (signErr) {
          nLog("[STAGE_OUTPUT_SIGNED] stage=2 stage2-only sign failed", {
            jobId: payload.jobId,
            attempt: attemptNo,
            error: (signErr as any)?.message || String(signErr),
          });
        }
      }
      const stage2ValidationPassed = stage2Result.validationRisk !== true;
      let stage2OnlyBlockedReason: string | null = null;
      let stage2OnlyFallbackStage: "1A" | "1B" = stage2OnlyBaseStage;
      const stage2OnlyAttemptNo = stage2OnlyAttemptsUsed;

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
        nLog(`[worker] Stage output missing/unreadable before validation — falling back to best available prior stage`, {
          jobId: payload.jobId,
          stage: "2",
          path: path2,
          fallbackStage: stage2OnlyBaseStage,
        });
        await completePartialJobWithSummary({
          jobId: payload.jobId,
          triggerStage: "2",
          finalStage: stage2OnlyBaseStage,
          finalPath: basePath,
          pub1AUrl: (payload.stage2OnlyMode as any)?.base1AUrl || undefined,
          pub1BUrl: payload.stage2OnlyMode?.base1BUrl || undefined,
          sceneMeta: {
            timings,
            scene: { label: sceneLabel as any, confidence: scenePrimary?.confidence ?? null },
            stage2OnlyRetry: true,
          },
          userMessage: stage2OnlyBaseStage === "1B"
            ? "We preserved your Stage 1B result because Stage 2 output was unavailable."
            : "We preserved your Stage 1A result because Stage 2 output was unavailable.",
          reason: "missing_stage_output",
          stageOutputs: {
            "1A": ((payload.stage2OnlyMode as any)?.base1APath || stageLineage.stage1A.output || basePath),
            ...(stage2OnlyBaseStage === "1B" ? { "1B": basePath } : {}),
          },
          billingContext: {
            payload,
            sceneType: sceneLabel || "interior",
            stage1BUserSelected: !!(payload.options as any)?.declutter,
            geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
          },
        });
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
          imageId: payload.imageId,
          stagingStyle: payload.options.stagingStyle || "standard_listing",
          stage1APath: validationBaseline,
          sourceStage: stage2OnlyRouting.sourceStage,
          validationMode: stage2OnlyValidationMode,
        });
        nLog(`[worker] Unified validation (stage2-only): ${unifiedRetryValidation.passed ? "PASSED" : "FAILED"} (score: ${unifiedRetryValidation.score})`);
        const stage2OnlyGeminiRaw = (unifiedRetryValidation.raw?.geminiSemantic as any)?.details || {};
        mergeAttemptValidation("2", stage2OnlyAttemptNo, {
          local: {
            passed: unifiedRetryValidation.passed,
            hardFail: unifiedRetryValidation.hardFail,
            score: unifiedRetryValidation.score,
            reasons: unifiedRetryValidation.reasons,
            warnings: unifiedRetryValidation.warnings,
          },
          gemini: {
            category: stage2OnlyGeminiRaw.category || "unknown",
            violationType: stage2OnlyGeminiRaw.violationType || "other",
            hardFail: stage2OnlyGeminiRaw.hardFail === true,
            confidence: Number.isFinite(stage2OnlyGeminiRaw.confidence) ? stage2OnlyGeminiRaw.confidence : 0,
            builtInDetected: stage2OnlyGeminiRaw.builtInDetected ?? false,
            structuralAnchorCount: stage2OnlyGeminiRaw.structuralAnchorCount ?? 0,
            builtInLowConfidence: stage2OnlyGeminiRaw.builtInLowConfidence ?? false,
            builtInDowngradeAllowed: stage2OnlyGeminiRaw.builtInDowngradeAllowed ?? false,
          },
          confirm: null,
        });
        logEvent("VALIDATION_RESULT", {
          jobId: payload.jobId,
          stage: "2",
          attempt: stage2OnlyAttemptNo,
          localPass: unifiedRetryValidation.passed === true,
          geminiPass: ((stage2OnlyGeminiRaw.hardFail === true) ? false : true),
          confirmPass: null,
          finalPass: stage2ValidationPassed,
          violationType: stage2OnlyGeminiRaw.violationType || null,
          retriesRemaining: 0,
        });
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

      if (!stage2ValidationPassed) {
        const usedAttempts = Number.isFinite((stage2Result as any)?.attempts)
          ? Math.max(1, Math.floor((stage2Result as any).attempts))
          : 1;
        const maxAttempts = Number.isFinite((stage2Result as any)?.maxAttempts)
          ? Math.max(1, Math.floor((stage2Result as any).maxAttempts))
          : usedAttempts;
        stage2OnlyBlockedReason = `stage2_structural_exhausted after ${usedAttempts}/${maxAttempts} attempts`;
        nLog(`[STAGE2_STRUCTURE_EXHAUSTED] attempts=${usedAttempts} fallback=${stage2OnlyFallbackStage}`);
        nLog(`[FALLBACK_TO_STAGE${stage2OnlyFallbackStage}] reason=${stage2OnlyBlockedReason}`);
        mergeAttemptValidation("2", stage2OnlyAttemptNo, {
          final: {
            result: "FAILED",
            finalHard: true,
            finalCategory: "structure",
            retryTriggered: false,
            retriesExhausted: true,
            reason: stage2OnlyBlockedReason,
          },
        });
      }

      // AUDIT FIX: Compliance gate before publish in stage2-only path
      // Respects geminiSemanticValidatorMode: null=skip, "log"=log-only, "block"=blocking
      if (!stage2OnlyBlockedReason && geminiSemanticValidatorMode !== null) {
        try {
          const ai = getGeminiClient();
          const baseRef = toBase64(validationBaseline);
          const enhanced = toBase64(path2);
          const s2oCompliance = await checkCompliance(ai as any, baseRef.data, enhanced.data, {
            validationMode: stage2OnlyValidationMode,
          });
          if (s2oCompliance && s2oCompliance.ok === false) {
            const confidence = s2oCompliance.confidence ?? 0.6;
            const tier = Number.isFinite((s2oCompliance as any).tier)
              ? Math.max(1, Math.min(3, Math.floor((s2oCompliance as any).tier)))
              : 1;
            const reasonText = String((s2oCompliance as any).reason || (s2oCompliance.reasons || ["Compliance failed"]).join("; "));
            const shouldBlock = (s2oCompliance as any).blocking === true || confidence >= COMPLIANCE_BLOCK_THRESHOLD;
            nLog("[COMPLIANCE_GATE_DECISION]", {
              jobId: payload.jobId,
              path: "stage2_only",
              ok: false,
              confidence,
              tier,
              reason: reasonText,
              mode: geminiSemanticValidatorMode,
              action: (shouldBlock && geminiSemanticValidatorMode === "block") ? "fallback" : "log-only",
            });
            if (shouldBlock && geminiSemanticValidatorMode === "block") {
              stage2OnlyBlockedReason = `stage2_compliance_exhausted after ${Math.max(1, Number((stage2Result as any)?.attempts || 1))} attempts: ${reasonText}`;
              nLog(`[STAGE2_COMPLIANCE_EXHAUSTED] attempts=${Math.max(1, Number((stage2Result as any)?.attempts || 1))} fallback=${stage2OnlyFallbackStage}`);
              nLog(`[FALLBACK_TO_STAGE${stage2OnlyFallbackStage}] reason=${stage2OnlyBlockedReason}`);
              mergeAttemptValidation("2", stage2OnlyAttemptNo, {
                final: {
                  result: "FAILED",
                  finalHard: true,
                  finalCategory: "compliance",
                  retryTriggered: false,
                  retriesExhausted: true,
                  reason: stage2OnlyBlockedReason,
                },
              });
            } else if (shouldBlock && geminiSemanticValidatorMode === "log") {
              nLog(`[worker] ⚠️  Compliance failure (stage2-only) confidence=${confidence.toFixed(2)} mode=log - ALLOWING job to proceed: ${reasonText}`);
            } else {
              nLog(`[worker] ⚠️  Compliance soft-fail (stage2-only) confidence=${confidence.toFixed(2)} — proceeding`);
            }
          } else {
            nLog(`[AUDIT FIX] Compliance passed (stage2-only) — proceeding to publish`);
          }
        } catch (compErr: any) {
          nLog("[worker] compliance check skipped (stage2-only):", compErr?.message || compErr);
        }
      } else if (geminiSemanticValidatorMode === null) {
        nLog(`[worker] Compliance check skipped (stage2-only) - geminiSemanticValidatorMode=disabled`);
      }

      if (stage2OnlyBlockedReason) {
        const fallbackPath = basePath;
        await clearStage2RetryPending("stage2_only_fallback_clear_pending");
        await completePartialJobWithSummary({
          jobId: payload.jobId,
          triggerStage: "2",
          finalStage: stage2OnlyFallbackStage,
          finalPath: fallbackPath,
          pub1AUrl: (payload.stage2OnlyMode as any)?.base1AUrl || undefined,
          pub1BUrl: payload.stage2OnlyMode?.base1BUrl || undefined,
          sceneMeta: {
            timings,
            scene: { label: sceneLabel as any, confidence: scenePrimary?.confidence ?? null },
            stage2OnlyRetry: true,
          },
          userMessage: stage2OnlyFallbackStage === "1B"
            ? "We preserved your Stage 1B result because Stage 2 could not be validated safely."
            : "We preserved your Stage 1A result because Stage 2 could not be validated safely.",
          reason: stage2OnlyBlockedReason,
          stageOutputs: {
            "1A": ((payload.stage2OnlyMode as any)?.base1APath || stageLineage.stage1A.output || basePath),
            ...(stage2OnlyFallbackStage === "1B" ? { "1B": fallbackPath } : {}),
          },
          billingContext: {
            payload,
            sceneType: sceneLabel || "interior",
            stage1BUserSelected: !!(payload.options as any)?.declutter,
            geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
          },
        });
        return;
      }

      // Publish Stage-2 result
      if (!(await ensureStage2AttemptOwner("stage2_only_publish"))) return;
      if (await stopIfCancelled("stage2_only_pre_publish")) return;
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
      mergeAttemptValidation("2", stage2OnlyAttemptNo, {
        final: {
          result: "PASSED",
          finalHard: false,
          finalCategory: "accept",
          retryTriggered: false,
          retriesExhausted: false,
        },
      });
      
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
        finalOutputUrl: pub2Url,
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

      flushEnhanceForensicSnapshot({
        uploadUrl: (payload as any).remoteOriginalUrl || null,
        stage1AUrl: ((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null,
        finalStatus: "completed",
        warningsCount: 0,
        hardFail: false,
        completionGuard: "passed",
        finalOutputUrl: pub2Url || null,
      });

      emitJobAttemptSummary("SUCCESS");

      // Finalize reservation with bundled pricing: Stage1 already done, Stage2 succeeded here
      try {
        const isEnhancementJob = (payload as any).type === "enhance";
        const isFreeManualRetry = (payload as any).retryType === "manual_retry";
        const billingStage1BUrl = stage2OnlyBaseStage === "1B" ? (payload.stage2OnlyMode?.base1BUrl || null) : null;
        const billingStage2Url = pub2Url || null;
        const billingStage1AUrl = stage2OnlyBaseStage === "1A"
          ? (((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null)
          : (((payload.stage2OnlyMode as any)?.base1AUrl as string | undefined) || null);
        const billingStage1ASuccess = !!billingStage1AUrl || !!billingStage1BUrl;
        const billingStage1BSuccess = !!billingStage1BUrl;
        const billingStage2Success = !!billingStage2Url;
        const completedJob = await getJob(payload.jobId);
        const completedStatus = String((completedJob as any)?.status || "").toLowerCase();
        const isTerminalComplete = completedStatus === "complete" || completedStatus === "completed";
        const hasUsableFinalOutput = typeof pub2Url === "string" && pub2Url.length > 0;
        const billableFinalSuccess = isTerminalComplete && hasUsableFinalOutput;
        const actualCharge = billableFinalSuccess && !isFreeManualRetry && isEnhancementJob ? 1 : 0;

        nLog("[BILLING_CHARGE_TELEMETRY]", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          stage1ASuccess: billingStage1ASuccess,
          stage1BSuccess: billingStage1BSuccess,
          stage2Success: billingStage2Success,
          finalCharge: actualCharge,
          path: "stage2_only_retry",
          billableFinalSuccess,
          completedStatus,
          isEnhancementJob,
          freeRetryNoAdditionalCharge: isFreeManualRetry,
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
      if ((payload as any).retryType !== "manual_retry" && (payload as any).type === "enhance") {
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
      } else {
        nLog(`[BILLING] Skipping charge finalization for non-billable job type or free manual retry: ${payload.jobId}`);
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
      if (!VALIDATOR_LOGS_FOCUS) {
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

  const sceneMeta: Record<string, any> = { scene: { label: sceneLabel as any, confidence: scenePrimary?.confidence ?? null }, scenePrimary };

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
      jobId: payload.jobId,
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
  } catch (e: any) {
    nLog('[WORKER] Canonical preprocess failed; falling back to original for stages', e);
    canonicalPath = origPath; // fallback
    jobContext.canonicalPath = canonicalPath;
  }

  // STAGE 1A
  const t1A = Date.now();
  logger.info("STAGE_ENTER", jobLogContext(payload, {
    event: "STAGE_ENTER",
    stage: "Stage1A",
  }));
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
  const autoSceneRequested = !payload.options.sceneType || payload.options.sceneType === "auto";
  const stage1AProbableExterior = (() => {
    if (!autoSceneRequested || sceneLabel === "exterior") return false;
    const p: any = scenePrimary || {};
    const conf = typeof p.confidence === "number" ? p.confidence : 0;
    const skyTop40 = typeof p.skyTop40 === "number" ? p.skyTop40 : 0;
    const blueOverall = typeof p.blueOverall === "number" ? p.blueOverall : 0;
    const grassPct = typeof p.grassPct === "number" ? p.grassPct : 0;
    const woodDeckPct = typeof p.woodDeckPct === "number" ? p.woodDeckPct : 0;
    const clientSuggestsExterior = clientScenePrediction?.scene === "exterior";
    const visualExteriorSignals = skyTop40 >= 0.10 || blueOverall >= 0.06 || grassPct >= 0.08 || woodDeckPct >= 0.12;
    return clientSuggestsExterior || (conf < SCENE_CONF_THRESHOLD && visualExteriorSignals);
  })();
  const stage1ASceneLabel = stage1AProbableExterior ? "exterior" : sceneLabel;
  if (stage1AProbableExterior) {
    nLog(`[WORKER] Stage1A probable exterior fallback: resolvedScene=${sceneLabel} -> stage1AScene=exterior`);
  }

  // Stage 1A: Always run Gemini for quality enhancement (HDR, color, sharpness)
  // SKY SAFEGUARD: compute safeReplaceSky using manual override + pergola/roof detection
  let safeReplaceSky: boolean = ((): boolean => {
    const explicit = (payload.options.replaceSky as any);
    const explicitBool = typeof explicit === 'boolean' ? explicit : undefined;
    const defaultExterior = stage1ASceneLabel === "exterior";
    return explicitBool === undefined ? defaultExterior : explicitBool;
  })();

  // Hard lock: only exterior scenes can use sky replacement.
  if (stage1ASceneLabel !== "exterior") {
    safeReplaceSky = false;
  }

  // Additional safety: if detector is confidently interior, never allow sky replacement,
  // even if an upstream flag attempted to force it on.
  const detectorConfidentInterior =
    scenePrimary?.label === "interior" &&
    typeof scenePrimary?.confidence === "number" &&
    scenePrimary.confidence >= SCENE_CONF_THRESHOLD;
  if (detectorConfidentInterior && safeReplaceSky) {
    safeReplaceSky = false;
    nLog(`[WORKER] Sky Safeguard: confident interior detection (${scenePrimary.confidence.toFixed(3)}) -> disable sky replacement`);
  }

  // Force-safe when user was involved (uncertain scene or manual override)
  const effectiveSceneForSafe = stage1ASceneLabel !== "auto" ? stage1ASceneLabel : (scenePrimary?.label || "interior");
  const forceSkySafeForReplace = effectiveSceneForSafe === "exterior" && (requiresSceneConfirm || hasManualSceneOverride);
  if (forceSkySafeForReplace) {
    safeReplaceSky = false;
    nLog(`[WORKER] Sky Safeguard: forceSkySafe=1 (requiresSceneConfirm=${requiresSceneConfirm}, hasManualSceneOverride=${hasManualSceneOverride}) → disable sky replacement`);
  }

  if (manualSceneOverride) {
    safeReplaceSky = false;
    nLog(`[WORKER] Sky Safeguard: manualSceneOverride=1 → disable sky replacement`);
  }
  if (stage1ASceneLabel === "exterior") {
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
  const stage1ASkyModeResult = stage1ASceneLabel === "exterior"
    ? ((scenePrimary as any)?.skyModeResult || (scenePrimary ? determineSkyMode(scenePrimary as any) : null))
    : null;
  const skyModeForStage1A = stage1ASkyModeResult?.mode || "safe";
  logIfNotFocusMode(`[STAGE1A] Final: sceneLabel=${sceneLabel} stage1AScene=${stage1ASceneLabel} skyMode=${skyModeForStage1A} safeReplaceSky=${safeReplaceSky}`);
  path1A = await runStage1A(canonicalPath, {
    replaceSky: safeReplaceSky,
    declutter: false, // Never declutter in Stage 1A - that's Stage 1B's job
    sceneType: stage1ASceneLabel,
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

  if (structuralBaseline) {
    nLog(`[STRUCTURAL_BASELINE_SKIPPED] jobId=${payload.jobId} reason=already_hydrated`);
  } else if (process.env.GEMINI_API_KEY || process.env.REALENHANCE_API_KEY) {
    structuralBaselinePromise = (async () => {
      try {
        const extractedBaseline = await extractStructuralBaseline(path1A);
        structuralBaseline = extractedBaseline;
        jobContext.structuralBaseline = extractedBaseline;
        await updateJob(payload.jobId, {
          structuralBaseline: extractedBaseline as any,
          meta: {
            structuralBaseline: extractedBaseline as any,
          } as any,
        });
        nLog(`[STRUCTURAL_BASELINE_EXTRACTED] jobId=${payload.jobId} openings=${extractedBaseline.openings.length}`);
        return extractedBaseline;
      } catch (baselineErr: any) {
        nLog(`[STRUCTURAL_BASELINE_ERROR] jobId=${payload.jobId} reason=${baselineErr?.message || baselineErr}`);
        return null;
      }
    })();
    nLog(`[STRUCTURAL_BASELINE_STARTED] jobId=${payload.jobId}`);
  } else {
    nLog(`[STRUCTURAL_BASELINE_SKIPPED] jobId=${payload.jobId} reason=missing_gemini_key`);
  }

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
  logger.info("STAGE_COMPLETE", jobLogContext(payload, {
    event: "STAGE_COMPLETE",
    stage: "Stage1A",
  }));
  
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
  flushEnhanceForensicSnapshot({
    uploadUrl: (payload as any).remoteOriginalUrl || null,
    stage1AUrl: pub1AUrl || null,
    finalStatus: "processing",
    warningsCount: 0,
    hardFail: false,
    completionGuard: "in_progress",
    finalOutputUrl: null,
  });
  if (await isCancelled(payload.jobId)) {
    await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
    return;
  }

  // STAGE 1B (optional declutter)
  const t1B = Date.now();
  logger.info("STAGE_ENTER", jobLogContext(payload, {
    event: "STAGE_ENTER",
    stage: "Stage1B",
  }));
  timestamps.stage1BStart = t1B; // FIX 6: Track Stage 1B start
  let path1B: string | undefined = undefined;
  let stage1BValidatedForCommit = false;
  let stage1BStructuralSafe = true;
  let stage1BDeclutterReasons: string[] = [];
  let stage1BDeclutterResult: Stage1BClutterHeuristicResult | undefined;

  // ═══ STAGE 1B INPUT LINEAGE GUARD ═══
  if (!stageLineage.stage1A.committed) {
    nLog("[STAGE1B_FAIL_NO_FALLBACK_TO_1A]", {
      jobId: payload.jobId,
      reason: "stage1A_not_committed",
      stage1AOutput: stageLineage.stage1A.output,
    });
    logJobErrorAndThrow(payload, "Stage 1A output not committed before Stage 1B start", {
      stage: "Stage1B",
    });
  }
  stageLineage.stage1B.input = stageLineage.stage1A.output;
  logStageInput("1B", "1A", stageLineage.stage1A.output!);
  
  // ✅ STRICT PAYLOAD MODE — derive declutterMode if missing but declutter requested (safety net)
  let declutterMode: "light" | "stage-ready" | null = (payload.options as any).declutterMode || null;

  // Capture user's original declutter intent BEFORE any gate override may mutate payload.options.declutter.
  // This is used to distinguish user-requested Stage1B from gate-triggered-only Stage1B.
  const originalUserDeclutter = !!payload.options.declutter;
  
  // ✅ PER-IMAGE ROUTING: Override for multi-room types (must have virtualStage enabled)
  const roomType = payload.options.roomType;
  const normalizedRoomType = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  const canonicalRoomType = normalizedRoomType === "multiple_living_areas" ? "multiple_living" : normalizedRoomType;
  const forceLightRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);

  const snapshotImpliesResolvedFurnishedGate = (snapshot: any): boolean => {
    if (!snapshot || typeof snapshot !== "object") return false;
    const policyMode = String(snapshot?.policyMode || "");
    const mode = String(snapshot?.mode || snapshot?.gateDecision || "");
    const stageReady = snapshot?.stageReady === true;
    const declutterMode = String(snapshot?.declutterMode || "");
    const stage1BRequired = snapshot?.stage1BRequired === true;

    return (
      policyMode === "FULL_FURNITURE_REMOVAL" ||
      mode === "furnished_refresh" ||
      stageReady ||
      declutterMode === "stage-ready" ||
      stage1BRequired
    );
  };

  const reassertFurnishedGateResolvedFromSnapshot = async (
    snapshot: any,
    source: string
  ): Promise<boolean> => {
    if (!snapshotImpliesResolvedFurnishedGate(snapshot)) return false;

    const currentJob = await getJob(payload.jobId);
    const currentMeta = ((currentJob as any)?.meta && typeof (currentJob as any).meta === "object")
      ? (currentJob as any).meta
      : {};
    if (currentMeta?.furnishedGateResolved === true) return true;

    const inferredGateDecision = snapshot?.declutterMode === "stage-ready"
      ? "furnished_refresh"
      : snapshot?.declutterMode === "light"
        ? "needs_declutter_light"
        : "empty_full_stage";

    await updateJob(payload.jobId, {
      meta: {
        ...currentMeta,
        furnishedGateResolved: true,
        routingSnapshot: currentMeta?.routingSnapshot || snapshot,
        furnishedGate: {
          ...(currentMeta?.furnishedGate || {}),
          enabled: true,
          source: currentMeta?.furnishedGate?.source || snapshot?.authority || "snapshot_reassert",
          gateDecision: currentMeta?.furnishedGate?.gateDecision || inferredGateDecision,
        },
      },
    });

    nLog("[FURNISHED_GATE_REASSERTED]", {
      jobId: payload.jobId,
      source,
      policyMode: snapshot?.policyMode || null,
      mode: snapshot?.mode || snapshot?.gateDecision || null,
      stageReady: snapshot?.stageReady === true,
      declutterMode: snapshot?.declutterMode || null,
      stage1BRequired: snapshot?.stage1BRequired === true,
    });

    return true;
  };

  // Furnished gate routing after Stage 1A
  // For stage2Only + interior, this gate must run regardless of declutter flag.
  // Order: local empty prefilter -> (if not empty) Gemini furnished confirmation.
  const hasVirtualStage = payload.options.virtualStage;
  const isInteriorScene = sceneLabel === "interior";
  const isStage2Only = hasVirtualStage && (payload.options as any).stage2Only === true;
  const shouldResolveFurnishedGate = hasVirtualStage && isInteriorScene;
  if (shouldResolveFurnishedGate) {
    let routingSnapshot = frozenRoutingSnapshot;

    if (routingSnapshot) {
      nLog("[ROUTING] Using frozen routing snapshot", {
        jobId: payload.jobId,
      });
      nLog("[ROUTING] Reusing frozen routing snapshot");
      await reassertFurnishedGateResolvedFromSnapshot(routingSnapshot, "frozen_routing_snapshot");
    } else {
      const latestBeforeDetect = await getJob(payload.jobId);
      const latestFrozenSnapshot = ((latestBeforeDetect as any)?.meta?.routingSnapshot
        || (latestBeforeDetect as any)?.metadata?.routingSnapshot
        || frozenRoutingSnapshot) as RoutingSnapshot | null;
      if (latestFrozenSnapshot) {
        routingSnapshot = latestFrozenSnapshot;
        nLog("[ROUTING] Using frozen routing snapshot", {
          jobId: payload.jobId,
        });
        nLog("[ROUTING] Reusing frozen routing snapshot");
        await reassertFurnishedGateResolvedFromSnapshot(routingSnapshot, "job_meta_routing_snapshot");
      } else {
        const stage1ABuffer = await fs.promises.readFile(path1A);
        const localEmpty = await isRoomEmpty(stage1ABuffer);

        if (localEmpty) {
          routingSnapshot = {
            authority: "localEmptyBypass",
            localEmpty: true,
            geminiHasFurniture: null,
            geminiConfidence: null,
            declutterMode: null,
            stage1BRequired: false,
          };
          nLog("[ROUTING] authority=localEmptyBypass | stage1BRequired=false");
        } else {
          const ai = getGeminiClient();
          const geminiAnalysis = await detectFurniture(ai as any, toBase64(path1A).data);
          const gateDecision = resolveFurnishedGateDecision({
            analysis: geminiAnalysis,
            localEmpty: false,
            roomType: canonicalRoomType,
            userSelectedDeclutter: originalUserDeclutter,
          });

          const resolvedDeclutterMode: "light" | "stage-ready" | null = gateDecision.decision === "needs_declutter_light"
            ? "light"
            : gateDecision.decision === "furnished_refresh"
              ? "stage-ready"
              : null;

          routingSnapshot = {
            authority: "gemini",
            localEmpty: false,
            geminiHasFurniture: geminiAnalysis ? geminiAnalysis.hasFurniture === true : false,
            geminiConfidence: geminiAnalysis && typeof geminiAnalysis.confidence === "number" ? geminiAnalysis.confidence : null,
            declutterMode: resolvedDeclutterMode,
            stage1BRequired: resolvedDeclutterMode !== null,
          };

          nLog(
            `[ROUTING] authority=gemini | localEmpty=false | hasFurniture=${routingSnapshot.geminiHasFurniture === true} | confidence=${routingSnapshot.geminiConfidence === null ? "null" : routingSnapshot.geminiConfidence.toFixed(2)} | stage1BRequired=${routingSnapshot.stage1BRequired}`
          );
        }

        const existingDurableMeta = await getJobMetadata(payload.jobId);
        const durableMetaWithSnapshot = {
          ...(existingDurableMeta || {}),
          routingSnapshot,
        } as JobOwnershipMetadata & { routingSnapshot: RoutingSnapshot };

        await Promise.all([
          updateJob(payload.jobId, {
            metadata: durableMetaWithSnapshot,
            meta: {
              ...(sceneLabel ? { ...sceneMeta } : {}),
              furnishedGateResolved: true,
              furnishedGate: {
                enabled: true,
                furnished: routingSnapshot.geminiHasFurniture === true,
                source: routingSnapshot.authority,
                escalated: routingSnapshot.authority === "gemini",
                stage1BRan: routingSnapshot.stage1BRequired,
                hasVirtualStage,
                isStage2Only,
                gateDecision: routingSnapshot.declutterMode === "stage-ready"
                  ? "furnished_refresh"
                  : routingSnapshot.declutterMode === "light"
                    ? "needs_declutter_light"
                    : "empty_full_stage",
                gateReason: routingSnapshot.authority,
              },
              routingSnapshot,
            },
          }),
          saveJobMetadata(durableMetaWithSnapshot, JOB_META_TTL_PROCESSING_SECONDS),
        ]);
      }

      frozenRoutingSnapshot = routingSnapshot;
    }

    if (routingSnapshot.declutterMode === "stage-ready") {
      nLog("[ROUTING_OVERRIDE] Furniture detected — auto-enabling Stage1B regardless of user declutter selection", {
        jobId: payload.jobId,
        originalUserDeclutter,
        hasFurniture: routingSnapshot.geminiHasFurniture,
      });
      payload.options.declutter = true;
      (payload.options as any).declutterMode = "stage-ready";
      declutterMode = "stage-ready";
      (payload.options as any).furnishedState = "furnished";
      (payload.options as any).stagingPreference = "refresh";
      (payload.options as any).stage2Variant = "2A";
      nLog("[ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "1A->1B->2(refresh)",
        reason: routingSnapshot.authority,
      });
    } else if (routingSnapshot.declutterMode === "light") {
      if (!originalUserDeclutter && routingSnapshot.geminiHasFurniture === false) {
        // User did NOT select declutter and Gemini confirms no true furniture present.
        // Clutter-only signals must NOT auto-escalate Stage1B — treat as empty-room path.
        nLog("[ROUTING_RECOMMENDATION] Light declutter recommended but user did not select declutter — skipping Stage1B override", {
          jobId: payload.jobId,
          roomType: canonicalRoomType,
          authority: routingSnapshot.authority,
        });
        payload.options.declutter = false;
        (payload.options as any).declutterMode = null;
        declutterMode = null;
        (payload.options as any).furnishedState = "empty";
        (payload.options as any).stagingPreference = "full";
        (payload.options as any).stage2Variant = "2B";
      } else {
        // User explicitly selected declutter OR Gemini detected furniture — proceed with light declutter.
        payload.options.declutter = true;
        (payload.options as any).declutterMode = "light";
        declutterMode = "light";
        // Stage 2 variant depends on whether furniture remains post-declutter.
        // Clutter-only rooms are empty after light cleanup → use full empty-room stage (2B).
        // Rooms with furniture after declutter still need refresh mode (2A).
        const postDeclutterHasFurniture = routingSnapshot.geminiHasFurniture === true;
        (payload.options as any).furnishedState = postDeclutterHasFurniture ? "needs_declutter" : "empty";
        (payload.options as any).stagingPreference = postDeclutterHasFurniture ? "refresh" : "full";
        (payload.options as any).stage2Variant = postDeclutterHasFurniture ? "2A" : "2B";
        nLog("[ROUTING_DECISION]", {
          jobId: payload.jobId,
          path: postDeclutterHasFurniture ? "1A->1B(light)->2(refresh)" : "1A->1B(light)->2(full)",
          reason: routingSnapshot.authority,
        });
      }
    } else {
      payload.options.declutter = false;
      (payload.options as any).declutterMode = null;
      declutterMode = null;
      (payload.options as any).furnishedState = "empty";
      (payload.options as any).stagingPreference = "full";
      (payload.options as any).stage2Variant = "2B";
      nLog("[ROUTING_DECISION]", {
        jobId: payload.jobId,
        path: "1A->2(full)",
        reason: routingSnapshot.authority,
      });
    }
  }

  if (!frozenRoutingSnapshot) {
    const inferredDeclutterMode: "light" | "stage-ready" | null =
      declutterMode === "light" || declutterMode === "stage-ready"
        ? declutterMode
        : null;
    const inferredSnapshot: RoutingSnapshot = {
      authority: "localEmptyBypass",
      localEmpty: false,
      geminiHasFurniture: null,
      geminiConfidence: null,
      declutterMode: inferredDeclutterMode,
      stage1BRequired: inferredDeclutterMode !== null,
    };

    const existingDurableMeta = await getJobMetadata(payload.jobId);
    const durableMetaWithSnapshot = {
      ...(existingDurableMeta || {}),
      routingSnapshot: inferredSnapshot,
    } as JobOwnershipMetadata & { routingSnapshot: RoutingSnapshot };

    await Promise.all([
      updateJob(payload.jobId, {
        metadata: durableMetaWithSnapshot,
        meta: {
          ...(sceneLabel ? { ...sceneMeta } : {}),
          routingSnapshot: inferredSnapshot,
        },
      }),
      saveJobMetadata(durableMetaWithSnapshot, JOB_META_TTL_PROCESSING_SECONDS),
    ]);

    frozenRoutingSnapshot = inferredSnapshot;
  }

  const stage1BRequired = frozenRoutingSnapshot.stage1BRequired === true;

  nLog(`[WORKER] Checking Stage 1B: payload.options.declutter=${payload.options.declutter}`);
  nLog(`[WORKER] Stage 1B declutterMode from payload: ${declutterMode || 'null'}`);
  nLog(`[WORKER] Stage 1B virtualStage: ${payload.options.virtualStage}`);

  if (!stage1BRequired) {
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
      logJobErrorAndThrow(payload, errMsg, {
        stage: "Stage1B",
      });
    }

    nLog(`[WORKER] ✅ Stage 1B ENABLED - mode: ${declutterMode}`);
    nLog(`[WORKER] Mode explanation: ${declutterMode === "light" ? "Light declutter (remove clutter, preserve furniture)" : "Structured retain declutter (preserve anchors, remove secondary items)"}`);
    nLog(`[WORKER] virtualStage setting: ${payload.options.virtualStage}`);
    const stage1BPolicyMode: Stage1BPolicyMode =
      declutterMode === "light" ? "DECLUTTER" : "FULL_FURNITURE_REMOVAL";
    nLog(`[STAGE1B_POLICY_ROUTE] mode=${declutterMode} policyMode=${stage1BPolicyMode}`);
    
    // 📊 STRUCTURED ROUTING LOG
    nLog(`[PIPELINE_ROUTING] Image routing decision:`, {
      roomType: canonicalRoomType,
      isMultiRoom: forceLightRoomTypes.has(canonicalRoomType),
      declutterMode,
      virtualStage: payload.options.virtualStage,
      expectedStage2Mode: payload.options.virtualStage ? "refresh" : "none"
    });

    let attempt = 0;
    const maxAttempts = Math.max(1, Number(process.env.STAGE1B_MAX_ATTEMPTS ?? 2));
    stage1BDeclutterReasons = [];
    stage1BDeclutterResult = undefined;

    while (attempt < maxAttempts) {
      if (await stopIfCancelled("stage1b_retry_loop")) return;
      if (Date.now() - t1B > MAX_STAGE_RUNTIME_MS) {
        logEvent("SYSTEM_ERROR", { jobId: payload.jobId, stage: "1B", kind: "timeout", elapsedMs: Date.now() - t1B });
        const latestJob = await getJob(payload.jobId);
        if (isTerminalStatus(latestJob?.status)) {
          nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B timeout fallback`, {
            jobId: payload.jobId,
            stage: "1B",
            status: latestJob?.status,
          });
          return;
        }

        await completePartialJobWithSummary({
          jobId: payload.jobId,
          triggerStage: "1B",
          finalStage: "1A",
          finalPath: path1A,
          pub1AUrl,
          pub1BUrl,
          sceneMeta,
          userMessage: "We enhanced your image but could not safely declutter it.",
          reason: "stage1b_runtime_exceeded",
          stageOutputs: { "1A": path1A },
          billingContext: {
            payload,
            sceneType: sceneLabel || "interior",
            stage1BUserSelected: originalUserDeclutter,
            geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
          },
        });
        return;
      }

      nLog(`[STAGE1B_ATTEMPT] attempt=${attempt} max=${maxAttempts}`);
      const geminiConfig = getStage1BGeminiConfig(attempt);
      nLog(`[STAGE1B_DECAY_CONFIG] temp=${geminiConfig.temperature} topP=${geminiConfig.topP.toFixed(2)} topK=${geminiConfig.topK}`);

      const candidate = await runStage1B(path1A, {
        replaceSky: false,
        sceneType: sceneLabel,
        roomType: payload.options.roomType,
        declutterMode,
        jobId: payload.jobId,
        attempt,
        canonicalPath: jobContext.canonicalPath,
        baseArtifacts: jobContext.baseArtifacts,
        curtainRailLikely: jobContext.curtainRailLikely,
        jobDeclutterIntensity: jobContext.jobDeclutterIntensity,
        jobSampling: {
          ...(jobContext.jobSampling || {}),
          ...geminiConfig,
        },
      });

      nLog(`[VALIDATOR_INPUT] stage=1B attempt=${attempt} using=${candidate}`);
      const stage1BOutputCheck = checkStageOutput(candidate, "1B", payload.jobId);
      if (!stage1BOutputCheck.readable) {
        nLog(`[worker] Stage output missing/unreadable before validation — marking failed`, { jobId: payload.jobId, stage: "1B", path: candidate });
        logJobErrorAndThrow(payload, "missing_stage_output", {
          stage: "Stage1B",
        });
      }

      const stage1BAttemptNo = attempt + 1;
      const stage1BSigned = await captureSignedStageOutput("1B", stage1BAttemptNo, candidate);
      let stage1BOutputCorrupt = false;
      let stage1BOutputAvgStdDev: number | null = null;
      let stage1BOutputBlankLike = false;
      let stage1BOutputMaxRange: number | null = null;
      try {
        const outputStats = fs.statSync(candidate);
        const outputSharp = sharp(candidate);
        const outputMeta = await outputSharp.metadata();
        const outputSignalStats = await outputSharp.stats();
        const hasValidDims =
          Number.isFinite(outputMeta?.width) && Number.isFinite(outputMeta?.height) &&
          Number(outputMeta.width) > 0 && Number(outputMeta.height) > 0;
        const channelStdDevs = (outputSignalStats?.channels || [])
          .map((c: any) => Number(c?.stdev))
          .filter((v: number) => Number.isFinite(v));
        const channelRanges = (outputSignalStats?.channels || [])
          .map((c: any) => Number(c?.max) - Number(c?.min))
          .filter((v: number) => Number.isFinite(v));
        stage1BOutputAvgStdDev = channelStdDevs.length > 0
          ? channelStdDevs.reduce((acc: number, v: number) => acc + v, 0) / channelStdDevs.length
          : null;
        stage1BOutputMaxRange = channelRanges.length > 0
          ? Math.max(...channelRanges)
          : null;
        stage1BOutputBlankLike =
          Number.isFinite(stage1BOutputAvgStdDev) &&
          Number.isFinite(stage1BOutputMaxRange) &&
          Number(stage1BOutputAvgStdDev) <= STAGE1B_BLANK_STDDEV_MAX &&
          Number(stage1BOutputMaxRange) <= STAGE1B_BLANK_RANGE_MAX;

        stage1BOutputCorrupt = !(outputStats.size > 0 && hasValidDims) || stage1BOutputBlankLike;
      } catch {
        stage1BOutputCorrupt = true;
      }
      nLog("[STAGE1B_OUTPUT_INTEGRITY]", {
        jobId: payload.jobId,
        attempt: stage1BAttemptNo,
        corrupt: stage1BOutputCorrupt,
        blankLike: stage1BOutputBlankLike,
        avgStdDev: stage1BOutputAvgStdDev,
        maxRange: stage1BOutputMaxRange,
        blankStdDevMax: STAGE1B_BLANK_STDDEV_MAX,
        blankRangeMax: STAGE1B_BLANK_RANGE_MAX,
      });

      const wallDelta = await detectWallPlaneExpansion(path1A, candidate);
      nLog(
        `[STAGE1B_WALL_DELTA] baselineArea=${wallDelta.baselineArea} candidateArea=${wallDelta.candidateArea} deltaRatio=${wallDelta.deltaRatio.toFixed(4)} newWallRatio=${wallDelta.newWallRatio.toFixed(4)}`
      );

      const stage1BSemanticSignals = await runSemanticStructureValidator({
        originalImagePath: path1A,
        enhancedImagePath: candidate,
        scene: sceneLabel === "exterior" ? "exterior" : "interior",
        mode: "log",
      });

      const stage1BMaskedEdgeResult = await runMaskedEdgeValidator({
        originalImagePath: path1A,
        enhancedImagePath: candidate,
        scene: sceneLabel === "exterior" ? "exterior" : "interior",
        mode: "log",
        jobId: payload.jobId,
      });
      const stage1BMaskedDriftPct = Number(((stage1BMaskedEdgeResult?.maskedEdgeDrift ?? 0) * 100).toFixed(2));
      const stage1BMaskedOpeningsDeltaTotal =
        (stage1BMaskedEdgeResult?.createdOpenings ?? 0) +
        (stage1BMaskedEdgeResult?.closedOpenings ?? 0);

      const stage1BOpeningsBefore =
        (stage1BSemanticSignals?.windows?.before ?? 0) +
        (stage1BSemanticSignals?.doors?.before ?? 0);
      const stage1BOpeningsAfter =
        (stage1BSemanticSignals?.windows?.after ?? 0) +
        (stage1BSemanticSignals?.doors?.after ?? 0);
      const openingCountDelta = stage1BOpeningsAfter - stage1BOpeningsBefore;
      const openingDeltaAbs = Math.abs(openingCountDelta);
      const openingRemovalDetectedForEvidence =
        openingCountDelta <= -STAGE1B_OPENING_DELTA_STRUCTURAL_THRESHOLD;

      // Subtractive mode safety: new large flat wall patches are suspicious
      const suspiciousWallExpansion =
        !!wallDelta?.planeExpansionRatio &&
        wallDelta.planeExpansionRatio > 0.15; // keep threshold conservative

      const stage1BStructuralSignalPresent = hasStage1BStructuralSignal({
        newWallRatio: wallDelta.newWallRatio,
        suspiciousWallExpansion,
        openingCountDelta,
      });
      const stage1BMinorReconstructionSignal = isStage1BMinorReconstructionSignal({
        newWallRatio: wallDelta.newWallRatio,
        suspiciousWallExpansion,
        openingCountDelta,
      });

      const stage1BStructuralEvidence: ValidationEvidence = {
        jobId: payload.jobId,
        stage: "1B",
        roomType: payload.options.roomType,
        ssim: 1,
        ssimThreshold: 0,
        ssimPassed: true,
        openings: {
          windowsBefore: stage1BSemanticSignals?.windows?.before ?? 0,
          windowsAfter: stage1BSemanticSignals?.windows?.after ?? 0,
          doorsBefore: stage1BSemanticSignals?.doors?.before ?? 0,
          doorsAfter: stage1BSemanticSignals?.doors?.after ?? 0,
        },
        drift: {
          wallPercent: (stage1BSemanticSignals?.walls?.driftRatio ?? 0) * 100,
          maskedEdgePercent: stage1BMaskedDriftPct,
          angleDegrees: 0,
        },
        anchorChecks: {
          islandChanged: false,
          hvacChanged: false,
          cabinetryChanged: false,
          lightingChanged: false,
        },
        geometryProfile: "SOFT",
        localFlags: [
          ...(openingRemovalDetectedForEvidence ? ["opening_removal_detected"] : []),
          ...(wallDelta.newWallRatio > STAGE1B_NEW_WALL_RATIO_STRUCTURAL_THRESHOLD
            ? ["new_wall_ratio_gt_0_01"]
            : []),
          ...(suspiciousWallExpansion ? ["suspicious_wall_expansion"] : []),
        ],
        unifiedScore: 1,
        unifiedPassed: true,
      };

      const stage1BEvidenceInjected =
        isEvidenceGatingEnabledForJob(payload.jobId) &&
        stage1BStructuralSignalPresent;

      const stage1BRiskClassification = classifyRisk(stage1BStructuralEvidence);

      if (VALIDATOR_AUDIT_ENABLED) {
        const auditEscalationReasons: string[] = [];
        if (openingRemovalDetectedForEvidence) auditEscalationReasons.push("opening_removal_detected");
        if (suspiciousWallExpansion) auditEscalationReasons.push("suspicious_wall_expansion");
        if (openingDeltaAbs >= STAGE1B_OPENING_DELTA_STRUCTURAL_THRESHOLD) {
          auditEscalationReasons.push(`opening_count_delta=${openingCountDelta}`);
        }
        console.log(`[VALIDATOR AUDIT]\nJob: ${payload.jobId}\nImage: ${payload.imageId || "unknown"}\nStage: 1B\nAttempt: ${stage1BAttemptNo}\n\nLocal validator metrics:\nWallDeltaRatio: ${wallDelta.deltaRatio.toFixed(4)}\nNewWallRatio: ${wallDelta.newWallRatio.toFixed(4)}\nPlaneExpansionRatio: ${wallDelta.planeExpansionRatio.toFixed(4)}\nWindowsBefore: ${stage1BStructuralEvidence.openings.windowsBefore}\nWindowsAfter: ${stage1BStructuralEvidence.openings.windowsAfter}\nDoorsBefore: ${stage1BStructuralEvidence.openings.doorsBefore}\nDoorsAfter: ${stage1BStructuralEvidence.openings.doorsAfter}\nOpeningCountDelta: ${openingCountDelta}\nWallDriftPct: ${stage1BStructuralEvidence.drift.wallPercent.toFixed(2)}\n\nSeverity: ${stage1BRiskClassification.level}\nHardFail: ${wallDelta.hardFail}\n\nEscalated to Gemini: YES\nReason: stage1b_structural_validation + ${auditEscalationReasons.length ? auditEscalationReasons.join(", ") : "policy_always"}`);
      }

      nLog("[STAGE1B_EVIDENCE_INJECTION]", {
        jobId: payload.jobId,
        injected: stage1BEvidenceInjected,
        openingRemovalDetected: openingRemovalDetectedForEvidence,
        suspiciousWallExpansion,
        openingCountDelta,
      });

      const stage1BSemanticWallDriftPct = (stage1BSemanticSignals?.walls?.driftRatio ?? 0) * 100;
      const stage1BStructuralDeviationDeg = Number(stage1BStructuralEvidence?.drift?.angleDegrees ?? 0);
      const stage1BSemanticConsensus = {
        windowsStatus: stage1BOpeningsBefore !== stage1BOpeningsAfter ? "FAIL" : "PASS",
        wallDriftStatus: (stage1BSemanticSignals?.walls?.driftRatio ?? 0) >= 0.12 ? "FAIL" : "PASS",
      };
      const stage1BMaskedConsensus = {
        maskedDriftStatus: (stage1BMaskedEdgeResult?.maskedEdgeDrift ?? 0) > 0.18 ? "FAIL" : "PASS",
        openingsStatus: stage1BMaskedOpeningsDeltaTotal > 0 ? "FAIL" : "PASS",
      };
      const stage1BCompositeEvaluation = evaluateCompositeLocalValidator({
        structuralDeviationDeg: Number.isFinite(stage1BStructuralDeviationDeg)
          ? stage1BStructuralDeviationDeg
          : null,
        maskedDriftPct: stage1BMaskedDriftPct,
        semanticWallDriftPct: stage1BSemanticWallDriftPct,
        semanticOpeningsDeltaTotal: openingCountDelta,
        maskedOpeningsDeltaTotal: stage1BMaskedOpeningsDeltaTotal,
      });
      const stage1BConsensusClassification = classifyStructuralConsensusCase({
        stage: "1B",
        validationMode: "FULL_STAGE_ONLY",
        jobId: payload.jobId,
        semantic: stage1BSemanticConsensus,
        masked: stage1BMaskedConsensus,
        composite: {
          decision: stage1BCompositeEvaluation.failed === true ? "FAIL" : "PASS",
        },
      });

      let structureResult: Awaited<ReturnType<typeof validateStage1BStructure>>;
      if (stage1BMinorReconstructionSignal) {
        nLog("[STAGE1B_GEMINI_ESCALATION_SKIPPED]", {
          reason: "minor_surface_reconstruction",
          openingCountDelta,
          newWallRatio: wallDelta.newWallRatio,
          suspiciousWallExpansion,
        });
        structureResult = {
          hardFail: false,
          category: "structure",
          reasons: ["stage1b_minor_reconstruction_warning"],
          confidence: 0,
          violationType: "other",
          builtInDetected: false,
          structuralAnchorCount: 0,
          openingChangeSignificant: false,
          openingToleranceReason: "opening_minor_drift",
        };
      } else {
        const stage1BGeminiConsensus = await runStage1BGeminiConsensus({
          beforeImage: path1A,
          afterImage: candidate,
          evidence: stage1BStructuralEvidence,
          derivedWarnings: stage1BConsensusClassification.derivedWarnings,
        });
        structureResult = stage1BGeminiConsensus.result;
        nLog("[STAGE1B_GEMINI_VALIDATOR_RESULTS]", {
          jobId: payload.jobId,
          attempt: stage1BAttemptNo,
          validator_results: stage1BGeminiConsensus.validatorResults,
          consensusMode: stage1BGeminiConsensus.consensusEnabled,
          derivedWarnings: stage1BGeminiConsensus.derivedWarnings,
          validatorConfidence: stage1BGeminiConsensus.validatorConfidence,
        });
      }
      nLog(
        `[STAGE1B_STRUCTURE_RESULT] hardFail=${structureResult.hardFail} violationType=${structureResult.violationType || "none"}`
      );

      if (VALIDATOR_AUDIT_ENABLED) {
        console.log(`[VALIDATOR AUDIT]\nJob: ${payload.jobId}\nImage: ${payload.imageId || "unknown"}\nStage: 1B\nAttempt: ${stage1BAttemptNo}\n\nGemini response:\nCategory: ${structureResult.category || "unknown"}\nViolationType: ${structureResult.violationType || "other"}\nConfidence: ${Number.isFinite(structureResult.confidence) ? structureResult.confidence : 0}\nHardFail: ${structureResult.hardFail}\nReasons: ${JSON.stringify(Array.isArray(structureResult.reasons) ? structureResult.reasons : [])}`);
      }

      let effectiveHardFail = false;
      let effectiveViolationType: string | undefined = undefined;
      let effectiveReasons: string[] = [];

      if (stage1BPolicyMode === "DECLUTTER") {
        const lightPolicyDecision = await evaluateStage1BLightPolicy({
          jobId: payload.jobId,
          attemptNo: stage1BAttemptNo,
          path1A,
          candidate,
          stage1BStructuralDeviationDeg,
          structureResult,
          wallDelta,
          openingCountDelta,
          suspiciousWallExpansion,
          stage1BSemanticWallDriftPct,
          stage1BMaskedDriftPct,
          stage1BConsensusClassification,
          stage1BMinorReconstructionSignal,
        });
        effectiveHardFail = lightPolicyDecision.effectiveHardFail;
        effectiveViolationType = lightPolicyDecision.effectiveViolationType;
        effectiveReasons = lightPolicyDecision.effectiveReasons;
      } else {
        const fullPolicyDecision = await evaluateStage1BFullPolicy({
          jobId: payload.jobId,
          attemptNo: stage1BAttemptNo,
          path1A,
          candidate,
          structuralBaseline,
          stage1BStructuralDeviationDeg,
          openingCountDelta,
          stage1BSemanticWallDriftPct,
          stage1BMaskedDriftPct,
          stage1BConsensusClassification,
          outputCorrupt: stage1BOutputCorrupt,
        });
        effectiveHardFail = fullPolicyDecision.effectiveHardFail;
        effectiveViolationType = fullPolicyDecision.effectiveViolationType;
        effectiveReasons = fullPolicyDecision.effectiveReasons;
      }

      if (wallDelta.hardFail) {
        nLog(`[STAGE1B_STRUCTURE_RESULT] hardFail=true violationType=wall_plane_expansion`);
      }

      if (VALIDATOR_AUDIT_ENABLED) {
        const finalDecision = effectiveHardFail ? "BLOCK" : "PASS";
        const finalReason = effectiveViolationType || "none";
        console.log(`[VALIDATOR AUDIT]\nJob: ${payload.jobId}\nImage: ${payload.imageId || "unknown"}\nStage: 1B\nAttempt: ${stage1BAttemptNo}\n\nFinal decision: ${finalDecision}\nFinal reason: ${finalReason}\nEffectiveHardFail: ${effectiveHardFail}`);
      }

      nLog("[STAGE1B_VALIDATOR_CALIBRATION]", {
        openingCountDelta,
        newWallRatio: Number(wallDelta.newWallRatio.toFixed(4)),
        suspiciousWallExpansion,
        hardFailDecision: effectiveHardFail,
        policyMode: stage1BPolicyMode,
      });

      mergeAttemptValidation("1B", stage1BAttemptNo, {
        local: {
          hardFail: effectiveHardFail,
          violationType: effectiveViolationType || null,
          reasons: effectiveReasons,
          wallDelta: {
            baselineArea: wallDelta.baselineArea,
            candidateArea: wallDelta.candidateArea,
            deltaRatio: wallDelta.deltaRatio,
            newWallRatio: wallDelta.newWallRatio,
            hardFail: wallDelta.hardFail,
          },
        },
        gemini: {
          category: structureResult.category,
          violationType: structureResult.violationType || null,
          hardFail: structureResult.hardFail === true,
          confidence: structureResult.confidence,
          builtInDetected: structureResult.builtInDetected ?? false,
          structuralAnchorCount: structureResult.structuralAnchorCount ?? 0,
          builtInLowConfidence: false,
          builtInDowngradeAllowed: false,
        },
        confirm: null,
      });

      annotateAttemptSignedUrl("1B", stage1BAttemptNo, stage1BSigned);
      logEvent("VALIDATION_RESULT", {
        jobId: payload.jobId,
        stage: "1B",
        attempt: stage1BAttemptNo,
        localPass: !effectiveHardFail,
        geminiPass: structureResult.hardFail !== true,
        confirmPass: null,
        finalPass: !effectiveHardFail,
        violationType: effectiveViolationType || null,
        retriesRemaining: Math.max(0, maxAttempts - stage1BAttemptNo),
      });

      if (effectiveHardFail) {
        logger.error("VALIDATION_FAIL", jobLogContext(payload, {
          event: "VALIDATION_FAIL",
          stage: "Stage1B",
          validator: "gemini_semantic",
          reason: effectiveViolationType || "hard_fail",
          details: effectiveReasons,
        }));
        mergeAttemptValidation("1B", stage1BAttemptNo, {
          final: {
            result: "FAILED",
            finalHard: true,
            finalCategory: "structure",
            retryTriggered: attempt + 1 < maxAttempts,
            retriesExhausted: attempt + 1 >= maxAttempts,
            reason: effectiveViolationType || "structure_hard_fail",
          },
        });

        attempt += 1;
        if (attempt >= maxAttempts) {
          nLog(`[STAGE1B_FALLBACK] triggered after attempts exhausted`);
          logEvent("FATAL_RETRY_EXHAUSTION", {
            jobId: payload.jobId,
            stage: "1B",
            attempts: attempt,
            reason: effectiveViolationType || "structure_hard_fail",
          });
          const latestJob = await getJob(payload.jobId);
          if (isTerminalStatus(latestJob?.status)) {
            nLog(`[FINAL_STATUS_GUARD] Skipping late Stage 1B structure-exhausted fallback`, {
              jobId: payload.jobId,
              stage: "1B",
              status: latestJob?.status,
            });
            return;
          }

          // If we requested virtual stage, we gracefully break out and proceed to Stage 2 with path1A baseline
          if (payload.options.virtualStage) {
            nLog("[STAGE1B_FALLBACK] Exhausted retries. Proceeding to Stage 2 with Stage 1A baseline.");
            sceneMeta.stage1BAttempts = attempt;
            sceneMeta.structureHardFail = true;
            sceneMeta.structureViolationType = effectiveViolationType;
            sceneMeta.structureReasons = effectiveReasons;
            break;
          }

          // Otherwise it's a declutter-only request and we must gracefully end the job
          await completePartialJobWithSummary({
            jobId: payload.jobId,
            triggerStage: "1B",
            finalStage: "1A",
            finalPath: path1A,
            pub1AUrl,
            pub1BUrl,
            sceneMeta: {
              ...sceneMeta,
              stage1BAttempts: attempt,
              structureHardFail: true,
              structureViolationType: effectiveViolationType,
              structureReasons: effectiveReasons,
            },
            userMessage: "We enhanced your image but could not safely declutter it.",
            reason: "stage1b_structure_hardfail_exhausted",
            stageOutputs: { "1A": path1A },
            billingContext: {
              payload,
              sceneType: sceneLabel || "interior",
              stage1BUserSelected: originalUserDeclutter,
              geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
            },
          });
          return;
        }
        logEvent("STAGE_RETRY", {
          jobId: payload.jobId,
          stage: "1B",
          retry: attempt,
          retriesRemaining: Math.max(0, maxAttempts - attempt),
          reason: effectiveViolationType || "structure_hard_fail",
        });
        continue;
      }

      path1B = candidate;
      stage1BValidatedForCommit = true;
      stage1BStructuralSafe = true;
      mergeAttemptValidation("1B", stage1BAttemptNo, {
        final: {
          result: "PASSED",
          finalHard: false,
          finalCategory: "accept",
          retryTriggered: false,
          retriesExhausted: false,
        },
      });
      break;
    }

    if (!path1B || !stage1BValidatedForCommit) {
      nLog(`[STAGE1B_FALLBACK] triggered after attempts exhausted`);
      await completePartialJobWithSummary({
        jobId: payload.jobId,
        triggerStage: "1B",
        finalStage: "1A",
        finalPath: path1A,
        pub1AUrl,
        pub1BUrl,
        sceneMeta: { ...sceneMeta, stage1BAttempts: maxAttempts, structureHardFail: true },
        userMessage: "We enhanced your image but could not safely declutter it.",
        reason: "stage1b_structure_hardfail_exhausted",
        stageOutputs: { "1A": path1A },
        billingContext: {
          payload,
          sceneType: sceneLabel || "interior",
          stage1BUserSelected: originalUserDeclutter,
          geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
        },
      });
      return;
    }

    stage1BDeclutterResult = await estimateClutterHeuristic(path1B);
    stage1BDeclutterReasons = [
      `heuristic_score:${stage1BDeclutterResult.score.toFixed(3)}`,
      `heuristic_level:${stage1BDeclutterResult.level}`,
    ];
    nLog(
      `[STAGE1B_CLUTTER_HEURISTIC] score=${stage1BDeclutterResult.score.toFixed(3)} level=${stage1BDeclutterResult.level} blocking=false retry=false`
    );

    commitStageOutput("1B", path1B);
    (sceneMeta as any).stage1BMode = declutterMode;
    nLog(`[WORKER] ✅ Recorded stage1BMode in metadata: ${declutterMode}`);

    nLog(`[LOCAL_VALIDATE] stage=1B status=pass reasons=[]`);
    nLog(`[DECLUTTER_VALIDATE] stage=1B status=log-only reasons=${JSON.stringify(stage1BDeclutterReasons)}`);
    nLog(`[VALIDATE_FINAL] stage=1B decision=accept blockedBy=none override=false retries=${attempt}`);

    timings.stage1BMs = Date.now() - t1B;
    timestamps.stage1BEnd = Date.now(); // FIX 6: Track Stage 1B completion
    logger.info("STAGE_COMPLETE", jobLogContext(payload, {
      event: "STAGE_COMPLETE",
      stage: "Stage1B",
    }));
    
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
  if (path1B && stage1BValidatedForCommit && path1B !== path1A) {
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
      nLog(`[STAGE1B_PUBLISH] starting jobId=${payload.jobId}`);
      const pub1B = await publishWithOptionalBlackEdgeGuard(path1B, "1B");
      pub1BUrl = pub1B.url;
      nLog(`[STAGE1B_PUBLISH] completed jobId=${payload.jobId} url=${pub1BUrl}`);
      await safeWriteJobStatus(
        payload.jobId,
        { status: "processing", currentStage: payload.options.declutter ? "1B" : "1A", stage: payload.options.declutter ? "1B" : "1A", progress: 55, stageUrls: { "1B": pub1BUrl }, imageUrl: pub1BUrl },
        "stage1b_publish"
      );
    } catch (e) {
      nLog('[worker] failed to publish 1B', e);
    }
  }

  if (await isCancelled(payload.jobId)) {
    await safeWriteJobStatus(payload.jobId, { status: "cancelled", errorMessage: "cancelled" }, "cancel");
    return;
  }

  if (payload.options.virtualStage && payload.options.declutter && path1B && sceneLabel === "interior") {
    nLog("[STAGE1B_FURNITURE_HEURISTIC]", {
      jobId: payload.jobId,
      score: stage1BDeclutterResult?.score ?? null,
      level: stage1BDeclutterResult?.level ?? null,
      mode: "local_non_blocking",
      retryTriggered: false,
      blocking: false,
    });
  }

  // STAGE 2 (optional virtual staging via Gemini)
  const t2 = Date.now();
  logger.info("STAGE_ENTER", jobLogContext(payload, {
    event: "STAGE_ENTER",
    stage: "Stage2",
  }));
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

  const exteriorNoStaging = sceneLabel === "exterior" && !allowStaging;
  const imageSourceRaw = String(
    (payload as any)?.image?.source
    || (payload as any)?.imageSource
    || (payload as any)?.source
    || (payload as any)?.meta?.source
    || (payload as any)?.options?.imageSource
    || ""
  ).trim().toLowerCase();
  const isExternalImage = imageSourceRaw === "external";
  const stage2Allowed = stagingGuardResult.allowed && !exteriorNoStaging && !isExternalImage;
  const shouldSkipStage2ForExternal = isExternalImage && stage2Requested && !stage2Allowed;

  if (shouldSkipStage2ForExternal) {
    stage2Skipped = true;
    stage2SkipReason = "external_images_not_supported_for_staging";
    payload.options.virtualStage = false;
    payload.options.declutter = false;
    stage2Blocked = false;
    stage2BlockedReason = undefined;
    stage2FallbackStage = "1A";
    nLog("[PIPELINE] Stage-2 skipped - external image", {
      jobId: payload.jobId,
      stage2Requested,
      stage2Allowed,
      reason: stage2SkipReason,
      imageSource: imageSourceRaw || null,
    });
    updateJob(payload.jobId, {
      warnings: ["Stage 2 skipped for external image; completed at Stage-1A."],
      stageCompleted: "1A",
      stage2Skipped: true,
      stage2SkipReason,
      meta: {
        ...(sceneLabel ? { ...sceneMeta } : {}),
        stageCompleted: "1A",
        stage2Skipped: true,
        stage2SkipReason,
      },
    });
  }

  // If staging was requested but not allowed, log and skip
  if (!stage2Skipped && payload.options.virtualStage && !stagingGuardResult.allowed) {
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
  const stage2Active = payload.options.virtualStage && !stage2Blocked && !exteriorNoStaging;
  if (stage2Active && payload.options.stage2Only === true) {
    let currentJob = await getJob(payload.jobId);
    let furnishedGateResolved = !!(currentJob as any)?.meta?.furnishedGateResolved;
    const routingSnapshot = (currentJob as any)?.meta?.routingSnapshot || (currentJob as any)?.metadata?.routingSnapshot;
    let gateResolutionPath: "direct" | "reconstructed" | "failed" = furnishedGateResolved ? "direct" : "failed";

    nLog("[STAGE2_GATE_CHECK]", {
      jobId: payload.jobId,
      furnishedGateResolved,
      hasRoutingSnapshot: !!routingSnapshot,
      policyMode: routingSnapshot?.policyMode ?? null,
      mode: routingSnapshot?.mode ?? routingSnapshot?.gateDecision ?? null,
      stageReady: routingSnapshot?.stageReady ?? (routingSnapshot?.declutterMode === "stage-ready"),
      declutterMode: routingSnapshot?.declutterMode ?? null,
      stage1BRequired: routingSnapshot?.stage1BRequired ?? null,
    });

    if (!furnishedGateResolved) {
      const reconstructed = await reassertFurnishedGateResolvedFromSnapshot(routingSnapshot, "stage2_guard_reconstruction");
      if (reconstructed) {
        currentJob = await getJob(payload.jobId);
        furnishedGateResolved = !!(currentJob as any)?.meta?.furnishedGateResolved;
        if (furnishedGateResolved) {
          gateResolutionPath = "reconstructed";
        }
      }
      if (!furnishedGateResolved) {
        nLog("[STAGE2_GATE_METRIC]", {
          jobId: payload.jobId,
          result: "failed",
          gateResolutionPath,
          hasRoutingSnapshot: !!routingSnapshot,
        });
        logJobErrorAndThrow(payload, "Stage 2 invoked without furnished gate resolution", {
          stage: "Stage2",
        });
      }
    }

    nLog("[STAGE2_GATE_METRIC]", {
      jobId: payload.jobId,
      result: "ok",
      gateResolutionPath,
      hasRoutingSnapshot: !!routingSnapshot,
    });
  }
  // Stage 2 input selection:
  // - Interior: use Stage 1B (decluttered) if declutter enabled; else Stage 1A
  // - Exterior: always use Stage 1A
  const isExteriorScene = sceneLabel === "exterior";
  const retrySourceStageRaw = String((payload as any).retrySourceStage || "").toLowerCase();
  const retryStage1BWasRequested = Boolean((payload as any).retryStage1BWasRequested);
  const isStage2Retry = (payload as any).retryType === "manual_retry"
    && (retryExecutionPlan
      ? !!retryExecutionPlan.runStage2
      : (retrySourceStageRaw === "stage2" || retrySourceStageRaw === "2" || retrySourceStageRaw === "1b-stage-ready"));
  const declutterRequested = !!payload.options.declutter;
  const stage1BRequested = declutterRequested
    || !!payload.stage2OnlyMode?.enabled
    || (isStage2Retry && (retryExecutionPlan ? (!!retryExecutionPlan.runStage1B || retryExecutionPlan.stage2Baseline === "1B") : true));
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
      logJobErrorAndThrow(payload, "Stage 2 blocked: Stage 1B requested but no Stage 1B output available", {
        stage: "Stage2",
      });
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
      logJobErrorAndThrow(payload, `Stage ${stage2BaseStage} output not available for Stage 2 input`, {
        stage: "Stage2",
      });
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
  let stage2LayoutPlan: Stage2LayoutPlan | null = null;
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
      if (!VALIDATOR_LOGS_FOCUS) {
        console.info("[stage2] incoming stagingStyle =", stagingStyleRaw);
      }
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
        stage2LayoutPlan = await resolveStage2LayoutPlan({
          basePath: stage2InputResolved,
          path: "main",
          promptMode: stage2PromptMode,
          sourceStage: stage2SourceStage,
          isExteriorScene: sceneLabel === "exterior",
        });
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
            layoutPlan: stage2LayoutPlan,
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
      if (payload.options.virtualStage && !stage2Blocked) {
        nLog("[STAGE2_PROMPT_SOURCE]", {
          source: "pipeline",
          retryType: "initial",
        });
      }
      
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
          logEvent("SYSTEM_ERROR", { jobId: payload.jobId, stage: "2", kind: "timeout", elapsedMs: STAGE2_TIMEOUT_MS });
          nLog(`[worker] ⏱️ Stage 2 timeout after ${STAGE2_TIMEOUT_MS}ms, falling back to Stage ${stage2BaseStage}`);
          stage2Blocked = true;
          stage2FallbackStage = stage2BaseStage;
          stage2BlockedReason = `Stage 2 processing exceeded ${STAGE2_TIMEOUT_MS / 1000}s timeout. Using best available result.`;
          stage2Outcome = stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1A;
        } else if (isStage2RetryableGenerationError(timeoutError)) {
          nLog("[STAGE2_GENERATION_RETRYABLE]", {
            jobId: payload.jobId,
            reason: (timeoutError as any)?.code || timeoutError?.message || String(timeoutError),
            fallback: "defer_to_unified_retry_loop",
          });
          stage2Outcome = {
            outputPath: stage2InputResolved,
            attempts: 1,
            maxAttempts: resolveStage2MaxAttempts(),
            validationRisk: true,
            fallbackUsed: false,
            localReasons: [(timeoutError as any)?.code || "stage2_generation_retryable"],
          };
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
        const generatedAttempts = Math.max(1, Number(stage2Outcome.attempts || 1));
        for (let attemptIndex = 0; attemptIndex < generatedAttempts; attemptIndex++) {
          const attemptNo = attemptIndex + 1;
          const attemptPath = siblingOutPath(
            stage2InputResolved,
            attemptIndex === 0 ? "-2" : `-2-retry${attemptIndex}`,
            ".webp"
          );
          try {
            const signed = await captureSignedStageOutput("2", attemptNo, attemptPath);
            annotateAttemptSignedUrl("2", attemptNo, signed);
          } catch (signErr) {
            nLog("[STAGE_OUTPUT_SIGNED] stage=2 sign failed", {
              jobId: payload.jobId,
              attempt: attemptNo,
              error: (signErr as any)?.message || String(signErr),
            });
          }
        }
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
    logger.error("JOB_ERROR", jobLogContext(payload, {
      event: "JOB_ERROR",
      stage: "Stage2",
      reason: errMsg,
    }));
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
    await completePartialJobWithSummary({
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
      billingContext: {
        payload,
        sceneType: sceneLabel || "interior",
        stage1BUserSelected: originalUserDeclutter,
        geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
      },
    });
    return;
  }

  logger.info("STAGE_COMPLETE", jobLogContext(payload, {
    event: "STAGE_COMPLETE",
    stage: "Stage2",
  }));

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

      nLog("[STAGE2_PROMPT_SOURCE]", {
        source: "pipeline",
        retryType: "light_declutter_backstop",
      });
      stage2LayoutPlan = await resolveStage2LayoutPlan({
        basePath: stage2InputResolved,
        path: "light_declutter_backstop",
        promptMode: fallbackRouting.mode,
        sourceStage: fallbackRouting.sourceStage,
        isExteriorScene: sceneLabel === "exterior",
      });
      let stage2Outcome: any;
      try {
        stage2Outcome = await runStage2(stage2InputResolved, stage2BaseStage, {
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
          layoutPlan: stage2LayoutPlan,
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
      } catch (stage2GenErr: any) {
        if (!isStage2RetryableGenerationError(stage2GenErr)) {
          throw stage2GenErr;
        }
        nLog("[STAGE2_GENERATION_RETRYABLE]", {
          jobId: payload.jobId,
          reason: stage2GenErr?.code || stage2GenErr?.message || String(stage2GenErr),
          fallback: "defer_to_unified_retry_loop",
        });
        stage2Outcome = {
          outputPath: stage2InputResolved,
          attempts: 1,
          maxAttempts: resolveStage2MaxAttempts(),
          validationRisk: true,
          fallbackUsed: false,
          localReasons: [stage2GenErr?.code || "stage2_generation_retryable"],
        };
      }

      if (typeof stage2Outcome === "string") {
        path2 = stage2Outcome;
        commitStageOutput("2", stage2Outcome);
      } else {
        path2 = stage2Outcome.outputPath;
        commitStageOutput("2", stage2Outcome.outputPath);
        recordStage2AttemptsFromResult(stage2InputResolved, stage2Outcome.attempts);
        const generatedAttempts = Math.max(1, Number(stage2Outcome.attempts || 1));
        for (let attemptIndex = 0; attemptIndex < generatedAttempts; attemptIndex++) {
          const attemptNo = attemptIndex + 1;
          const attemptPath = siblingOutPath(
            stage2InputResolved,
            attemptIndex === 0 ? "-2" : `-2-retry${attemptIndex}`,
            ".webp"
          );
          try {
            const signed = await captureSignedStageOutput("2", attemptNo, attemptPath);
            annotateAttemptSignedUrl("2", attemptNo, signed);
          } catch (signErr) {
            nLog("[STAGE_OUTPUT_SIGNED] stage=2 sign failed", {
              jobId: payload.jobId,
              attempt: attemptNo,
              error: (signErr as any)?.message || String(signErr),
            });
          }
        }
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
  let unifiedValidation: any = undefined;
  let effectiveValidationMode: "log" | "enforce" | undefined = undefined;
  const MAX_STAGE2_RETRIES = Math.max(1, stage2MaxAttempts || 1);
  const tVal = Date.now();

  const hasStage2GeminiSemanticHardFail = (result?: UnifiedValidationResult): boolean => {
    if (!result || !payload.options.virtualStage) return false;
    const category = String((result.raw?.geminiSemantic?.details as any)?.category || "").toLowerCase();
    if (category !== "structure" && category !== "opening_blocked") return false;
    return result.reasons.some((reason) => reason.startsWith("Gemini "));
  };

  const hasPrimaryStructuralViolation = (result?: UnifiedValidationResult): boolean => {
    if (!result) return false;
    const geminiDetails = (result.raw?.geminiSemantic?.details as any) || {};
    const violationType = String(geminiDetails.violationType || "").toLowerCase();
    const category = String(geminiDetails.category || "").toLowerCase();
    const confidence = Number(geminiDetails.confidence ?? 0);
    const builtInDetected = geminiDetails.builtInDetected === true;
    const structuralAnchorCount = Number(geminiDetails.structuralAnchorCount ?? 0);

    const roomTypeLower = String(payload.options.roomType || "").toLowerCase();
    const kitchenContext = roomTypeLower.includes("kitchen");

    const evidence = result.evidence;
    const windowsDelta = evidence
      ? Math.abs((evidence.openings.windowsAfter ?? 0) - (evidence.openings.windowsBefore ?? 0))
      : 0;
    const doorsDelta = evidence
      ? Math.abs((evidence.openings.doorsAfter ?? 0) - (evidence.openings.doorsBefore ?? 0))
      : 0;
    const hasOpeningChange =
      violationType === "opening_change" ||
      category === "opening_blocked" ||
      windowsDelta > 0 ||
      doorsDelta > 0;

    const reasonText = [
      ...(result.reasons || []),
      ...(Array.isArray(geminiDetails.reasons) ? geminiDetails.reasons.map(String) : []),
    ].join(" ").toLowerCase();

    const hasWallGeometryDrift =
      violationType === "wall_change" ||
      violationType === "structural_consensus" ||
      ["wall removed", "wall added", "wall plane", "wall geometry", "load-bearing"].some((token) => reasonText.includes(token));

    const hasCameraShift =
      violationType === "camera_shift" ||
      ["camera shift", "camera angle", "viewpoint shift", "perspective shift", "field of view", "fov"].some((token) => reasonText.includes(token));

    const hasEnvelopeDeformation =
      ["room envelope", "envelope geometry", "room volume changed", "room width", "room depth", "architectural footprint", "ceiling plane"].some((token) => reasonText.includes(token));

    const hasConfirmedBuiltInRelocation =
      (violationType === "built_in_moved" || builtInDetected) &&
      structuralAnchorCount >= 2 &&
      confidence >= 0.85;

    const hasKitchenIslandPrimary = kitchenContext && evidence?.anchorChecks?.islandChanged === true;

    return (
      hasOpeningChange ||
      hasWallGeometryDrift ||
      hasCameraShift ||
      hasEnvelopeDeformation ||
      hasConfirmedBuiltInRelocation ||
      hasKitchenIslandPrimary
    );
  };

  if (payload.options.virtualStage) {
    let pendingStage2StructuralFailureType: StructuralFailureType | null = null;
    let pendingStage2RetryStrategy: string | null = null;
    let pendingStage2RetryReason: string | null = null;
    let stage2ReinforcedRetryUsed = false;
    const stage2DecisionImageUrl = (payload as any).imageUrl ?? (payload as any).baseImageUrl ?? null;

    type Stage2ValidatorLogArgs = {
      jobId?: string;
      imageId?: string;
      attempt?: number;
      validator: string;
      result: "PASS" | "FAIL";
      reason?: string;
    };

    const logValidatorContextError = (validator: string): void => {
      nLog(
        `[VALIDATOR_CONTEXT_ERROR]\nvalidator=${validator}\nmessage="validator executed without job context"`
      );
    };

    const logValidatorResult = ({ jobId, imageId, attempt, validator, result, reason }: Stage2ValidatorLogArgs): void => {
      if (!jobId || !imageId || !Number.isFinite(attempt)) {
        logValidatorContextError(validator);
        return;
      }

      logger.info("VALIDATOR_RESULT", jobLogContext(payload, {
        event: "VALIDATOR_RESULT",
        stage: "Stage2",
        validator,
        passed: result === "PASS",
        attempt,
      }));

      nLog(
        `[VALIDATOR_RESULT]\njob_id=${jobId}\nimage_id=${imageId}\nattempt=${attempt}\nvalidator=${validator}\nresult=${result}\nreason=${reason && reason.trim().length > 0 ? reason : "none"}`
      );

      if (result === "FAIL") {
        logger.error("VALIDATION_FAIL", jobLogContext(payload, {
          event: "VALIDATION_FAIL",
          stage: "Stage2",
          validator,
          reason: reason && reason.trim().length > 0 ? reason : "validator_fail",
        }));
      }
    };

    const logStage2AttemptAnchor = (attempt: number): void => {
      nLog(
        `[STAGE2_ATTEMPT]\njob_id=${payload.jobId}\nimage_id=${payload.imageId}\nattempt=${attempt}`
      );
    };

    const logStage2Candidate = (attempt: number, candidatePath: string): void => {
      nLog(
        `[STAGE2_CANDIDATE]\njob_id=${payload.jobId}\nimage_id=${payload.imageId}\nattempt=${attempt}\ncandidate_path=${candidatePath}`
      );
    };

    const logStage2Retry = (attempt: number, reason: string): void => {
      nLog(
        `[STAGE2_RETRY]\njob_id=${payload.jobId}\nimage_id=${payload.imageId}\nattempt=${attempt}\nreason=${reason}`
      );
    };

    const logValidateFinal = (attempt: number, decision: "accept" | "retry" | "reject", retries: number): void => {
      nLog(
        `[VALIDATE_FINAL]\njob_id=${payload.jobId}\nimage_id=${payload.imageId}\nattempt=${attempt}\ndecision=${decision}\nretries=${retries}`
      );
    };

    for (let attempt = 1; attempt <= MAX_STAGE2_RETRIES; attempt++) {
      logStage2AttemptAnchor(attempt);
      const emitStage2DecisionBreakdown = (params: {
        extremeLocalFail: boolean;
        topologyFail: boolean;
        invariantFail: boolean;
        compositeDecision: string;
        geminiConfirmStatus: string;
        complianceDecision: string;
        stage2Blocked: boolean;
        decisionPoint: "retry_schedule" | "final_block";
        reason: string;
      }) => {
        logger.info("STAGE2_DECISION_BREAKDOWN", {
          jobId: payload.jobId,
          imageurl: stage2DecisionImageUrl,
          attempt,
          extremeLocalFail: params.extremeLocalFail,
          topologyFail: params.topologyFail,
          invariantFail: params.invariantFail,
          compositeDecision: params.compositeDecision,
          geminiConfirmStatus: params.geminiConfirmStatus,
          complianceDecision: params.complianceDecision,
          stage2Blocked: params.stage2Blocked,
          decisionPoint: params.decisionPoint,
          reason: params.reason,
        });
      };

      logger.info("[STAGE2_RETRY_CONTEXT]", {
        jobId: payload.jobId,
        attempt,
        stagingStyle: normalizeForensicStagingStyle(stagingStyleNorm),
        failureType: pendingStage2StructuralFailureType,
        retryStrategy: pendingStage2RetryStrategy,
      });

      if (await stopIfCancelled("stage2_validation_loop")) return;
      if (Date.now() - t2 > MAX_STAGE_RUNTIME_MS) {
        logEvent("SYSTEM_ERROR", { jobId: payload.jobId, stage: "2_validation_loop", kind: "timeout", elapsedMs: Date.now() - t2 });
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
        const retryFailureType = pendingStage2StructuralFailureType;
        const useReinforcedRetry = pendingStage2RetryStrategy === "REINFORCED" && !stage2ReinforcedRetryUsed;
        let structuralConstraintBlock = "";
        if (pendingStage2RetryReason && structuralBaseline && attempt >= 3) {
          const mode: "soft" | "hard" = attempt === 3 ? "soft" : "hard";
          const openingConstraintBlock = buildStructuralConstraintBlock(structuralBaseline, mode);
          const closetConstraint = buildClosetSurfaceExclusionConstraintBlock(structuralBaseline, mode);
          structuralConstraintBlock = [openingConstraintBlock, closetConstraint.block]
            .filter((part) => typeof part === "string" && part.trim().length > 0)
            .join("\n\n");

          if (structuralConstraintBlock) {
            logger.info({
              event: "STRUCTURAL_CONSTRAINT_INJECTED",
              jobId: payload.jobId,
              attempt,
              mode,
              retryReason: pendingStage2RetryReason,
              closetRegionCount: closetConstraint.regionCount,
            });
          }

          if (closetConstraint.regionCount > 0) {
            nLog(
              `[CLOSET][stage2] surface excluded – closet door region(s)=${closetConstraint.regionCount} attempt=${attempt} mode=${mode}`
            );
          }
        }
        if (useReinforcedRetry) {
          console.log("[STAGE2] Retry-1 using reinforced structural prompt");
        } else {
          console.log("[STAGE2] Retry using corrective structural prompt");
        }
        if (await stopIfCancelled("stage2_pre_retry_generation")) return;
        const retryOutputPath = siblingOutPath(stage2InputResolved, `-2-retry${attempt - 1}`, ".webp");
        // IMPORTANT:
        // Retry-1 must remain identical to initial Stage-2 generation.
        // It exists purely as a stochastic second attempt.
        // Do not introduce modified structural or eligibility behavior here.
        nLog("[STAGE2_PROMPT_SOURCE]", {
          source: "pipeline",
          retryType: "validator_forced_retry",
        });
        let retryStage2Path: string;
        try {
          retryStage2Path = await runStage2GenerationAttempt(stage2InputResolved, {
            roomType: payload.options.roomType,
            sceneType: sceneLabel as any,
            profile,
            referenceImagePath: undefined,
            stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
            stagingStyle: payload.options.stagingStyle || "standard_listing",
            sourceStage: stage2SourceStage,
            promptMode: stage2PromptMode,
            curtainRailLikely: jobContext.curtainRailLikely,
            jobId: payload.jobId,
            outputPath: retryOutputPath,
            attempt,
            structuralRetryContext: {
                compositeFail: useReinforcedRetry,
                failureType: retryFailureType,
                attemptNumber: useReinforcedRetry ? 1 : attempt - 1,
              },
            layoutPlan: stage2LayoutPlan,
            structuralConstraintBlock,
            modelReason: `stage2 unified retry ${attempt - 1}`,
          });
        } catch (retryGenerationErr: any) {
          if (!isStage2RetryableGenerationError(retryGenerationErr)) {
            throw retryGenerationErr;
          }
          nLog("[STAGE2_GENERATION_RETRYABLE]", {
            jobId: payload.jobId,
            attempt,
            reason: retryGenerationErr?.code || retryGenerationErr?.message || String(retryGenerationErr),
          });
          stage2LocalReasons.push(retryGenerationErr?.code || "stage2_generation_retryable");
          pendingStage2StructuralFailureType = "STRUCTURAL_INVARIANT";
          pendingStage2RetryStrategy = "NORMAL";
          pendingStage2RetryReason = "opening_preservation";
          if (attempt < MAX_STAGE2_RETRIES) {
            logValidateFinal(attempt, "retry", attempt);
            logStage2Retry(attempt, "stage2_generation_retryable");
            continue;
          }

          const fallbackPath = stageLineage.stage1B.committed && stageLineage.stage1B.output
            ? stageLineage.stage1B.output
            : path1A;
          const fallbackStage: "1A" | "1B" = fallbackPath === path1A ? "1A" : "1B";
          stage2Blocked = true;
          stage2FallbackStage = fallbackStage;
          stage2BlockedReason = retryGenerationErr?.code || "stage2_generation_retryable_exhausted";
          fallbackUsed = fallbackStage === "1B" ? "stage2_structure_fallback_1b" : "stage2_structure_fallback_1a";
          path2 = fallbackPath;
          stage2CandidatePath = fallbackPath;
          break;
        }
        if (useReinforcedRetry) {
          stage2ReinforcedRetryUsed = true;
        }
        pendingStage2StructuralFailureType = null;
        pendingStage2RetryStrategy = null;
        pendingStage2RetryReason = null;
        recordStage2AttemptOutput(attempt - 1, retryStage2Path);
        stage2CandidatePath = retryStage2Path;
        path2 = retryStage2Path;
        commitStageOutput("2", retryStage2Path);
      }

      logStage2Candidate(attempt, path2);
      stage2AttemptsUsed = Math.max(stage2AttemptsUsed, attempt);
      stage2LocalReasons = [];
      let openingIdentityWarnings: string[] = [];
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

      try {
        await logBaselineImageUrl({
          stage: "2",
          jobId: payload.jobId,
          localPath: validationBasePath,
        });
      } catch (baselineSignErr: any) {
        nLog("[BASELINE_IMAGE_URL] sign failed", {
          jobId: payload.jobId,
          stage: "2",
          error: baselineSignErr?.message || String(baselineSignErr),
        });
      }

      nLog(`[VALIDATOR_INPUT] stage=2 attempt=${attempt} base=${validationBasePath} candidate=${path2}`);

      if (path2 === validationBasePath) {
        console.warn("[STAGE2_ERROR] Candidate equals baseline — Stage-2 output missing", {
          jobId: payload.jobId,
          attempt,
          base: validationBasePath,
          candidate: path2,
        });
        stage2LocalReasons.push("stage2_candidate_equals_baseline");
        pendingStage2StructuralFailureType = "STRUCTURAL_INVARIANT";
        pendingStage2RetryStrategy = "NORMAL";
        pendingStage2RetryReason = "opening_preservation";

        if (attempt < MAX_STAGE2_RETRIES) {
          logValidateFinal(attempt, "retry", attempt);
          logStage2Retry(attempt, "stage2_candidate_equals_baseline");
          continue;
        }

        const fallbackPath = stageLineage.stage1B.committed && stageLineage.stage1B.output
          ? stageLineage.stage1B.output
          : path1A;
        const fallbackStage: "1A" | "1B" = fallbackPath === path1A ? "1A" : "1B";
        stage2Blocked = true;
        stage2FallbackStage = fallbackStage;
        stage2BlockedReason = "stage2_candidate_equals_baseline";
        fallbackUsed = fallbackStage === "1B" ? "stage2_structure_fallback_1b" : "stage2_structure_fallback_1a";
        path2 = fallbackPath;
        stage2CandidatePath = fallbackPath;
        nLog(`[FALLBACK_TO_STAGE${fallbackStage}] reason=stage2_candidate_equals_baseline`);
        break;
      }

      effectiveValidationMode = VALIDATION_BLOCKING_ENABLED ? "enforce" : "log";
      const stage2GeminiPolicy: "never" | "on_local_fail" = VALIDATION_BLOCKING_ENABLED ? "never" : "on_local_fail";
      nLog(`[worker] Unified validation mode: configured=${structureValidatorMode} effective=${effectiveValidationMode} blocking=${VALIDATION_BLOCKING_ENABLED ? "ON" : "OFF (advisory)"}`);

      const stage2OutputCheck = checkStageOutput(path2, "2", payload.jobId);
      if (!stage2OutputCheck.readable) {
        const fallbackPath = stageLineage.stage1B.committed && stageLineage.stage1B.output
          ? stageLineage.stage1B.output
          : path1A;
        const fallbackStage: "1A" | "1B" = fallbackPath === path1A ? "1A" : "1B";
        nLog(`[worker] Stage output missing/unreadable before validation — falling back to best available prior stage`, {
          jobId: payload.jobId,
          stage: "2",
          path: path2,
          fallbackStage,
        });
        await completePartialJobWithSummary({
          jobId: payload.jobId,
          triggerStage: "2",
          finalStage: fallbackStage,
          finalPath: fallbackPath,
          pub1AUrl,
          pub1BUrl,
          sceneMeta: { ...sceneMeta },
          userMessage: fallbackStage === "1B"
            ? "We decluttered your image but could not safely stage it."
            : "We enhanced your image but could not safely stage it.",
          reason: "missing_stage_output",
          stageOutputs: { "1A": path1A, ...(path1B ? { "1B": path1B } : {}) },
          billingContext: {
            payload,
            sceneType: sceneLabel || "interior",
            stage1BUserSelected: originalUserDeclutter,
            geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
          },
        });
        return;
      }

      try {
        const stage2AttemptSigned = await captureSignedStageOutput("2", attempt, path2);
        annotateAttemptSignedUrl("2", attempt, stage2AttemptSigned);
      } catch (signErr) {
        nLog("[STAGE_OUTPUT_SIGNED] stage=2 prevalidation sign failed", {
          jobId: payload.jobId,
          attempt,
          error: (signErr as any)?.message || String(signErr),
        });
      }

      const normalizeValidatorReason = (reason: string): string => {
        const normalized = String(reason || "unknown")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
        return normalized || "unknown";
      };

      const clamp01 = (value: number): number => {
        if (!Number.isFinite(value)) return 0;
        return Math.max(0, Math.min(1, value));
      };

      type OpeningSignals = {
        removed: boolean;
        relocated: boolean;
        resized: boolean;
        resizeDelta: number;
        bandMismatch: boolean;
        classMismatch: boolean;
      };

      type OpeningStructuralSignalLevel = "none" | "advisory" | "strong" | "extreme";

      type OpeningStructuralSignalReason =
        | "opening_removed"
        | "opening_removed_and_relocated"
        | "opening_resize_extreme"
        | "opening_relocated_and_resized";

      type OpeningStructuralSignal = {
        type: OpeningStructuralSignalReason;
        confidence: Exclude<OpeningStructuralSignalLevel, "none">;
        resizeDelta?: number;
      };

      const extractOpeningSignals = (openingResult: { reason?: string; advisorySignals?: string[] }): OpeningSignals => {
        const reasonTokens = String(openingResult.reason || "")
          .split("|")
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
        const advisoryTokens = Array.isArray(openingResult.advisorySignals)
          ? openingResult.advisorySignals.map((token) => String(token || "").trim().toLowerCase()).filter(Boolean)
          : [];

        const tokens = [...reasonTokens, ...advisoryTokens];
        const joined = tokens.join("|");

        const extractResizeDelta = (): number => {
          const resizeMatch = joined.match(/opening_resize(?:d_minor|_ge_0_30)?:(\d+(?:\.\d+)?)/i);
          if (resizeMatch && Number.isFinite(Number(resizeMatch[1]))) {
            return Number(resizeMatch[1]);
          }
          return 0;
        };

        const resizeDelta = extractResizeDelta();
        const resized =
          /(^|\|)opening_resized($|\|)/.test(joined) ||
          joined.includes("opening_resize_ge_0_30") ||
          joined.includes("opening_resized_minor:");

        return {
          removed: /(^|\|)opening_removed($|\|)/.test(joined),
          relocated: /(^|\|)opening_relocated($|\|)/.test(joined),
          resized,
          resizeDelta,
          bandMismatch: /(^|\|)opening_band_mismatch($|\|)/.test(joined),
          classMismatch: /(^|\|)opening_class_mismatch($|\|)/.test(joined),
        };
      };

      const evaluateOpeningStructuralConfidence = (
        signals: OpeningSignals
      ): { level: OpeningStructuralSignalLevel; reason?: OpeningStructuralSignalReason } => {
        if (signals.removed && signals.relocated) {
          return { level: "strong", reason: "opening_removed_and_relocated" };
        }

        if (signals.removed) {
          return { level: "strong", reason: "opening_removed" };
        }

        if (signals.relocated && signals.resized) {
          return { level: "strong", reason: "opening_relocated_and_resized" };
        }

        if (signals.resized && signals.resizeDelta >= 0.6) {
          return { level: "extreme", reason: "opening_resize_extreme" };
        }

        if (
          signals.relocated ||
          signals.resized ||
          signals.bandMismatch ||
          signals.classMismatch
        ) {
          return { level: "advisory" };
        }

        return { level: "none" };
      };

      let semanticWallDriftNorm = 0;
      let semanticOpeningsDeltaNorm = 0;
      let maskedEdgeDriftNorm = 0;
      let edgeOpeningRiskNorm = 0;

      try {
        const [semanticSignals, maskedSignals] = await Promise.all([
          runSemanticStructureValidator({
            originalImagePath: validationBasePath,
            enhancedImagePath: path2,
            scene: sceneLabel as any,
            mode: "log",
          }),
          runMaskedEdgeValidator({
            originalImagePath: validationBasePath,
            enhancedImagePath: path2,
            scene: sceneLabel as any,
            mode: "log",
            jobId: payload.jobId,
          }),
        ]);

        semanticWallDriftNorm = clamp01(Number(semanticSignals?.walls?.driftRatio ?? 0));
        semanticOpeningsDeltaNorm = clamp01(
          Math.abs(semanticSignals?.windows?.change ?? 0) +
          Math.abs(semanticSignals?.doors?.change ?? 0) +
          Math.abs(semanticSignals?.openings?.created ?? 0) +
          Math.abs(semanticSignals?.openings?.closed ?? 0)
        );
        maskedEdgeDriftNorm = clamp01(Number(maskedSignals?.maskedEdgeDrift ?? 0));
        edgeOpeningRiskNorm = clamp01(Number(maskedSignals?.edgeOpeningRisk ?? 0));

        nLog("[STAGE2_LOCAL_SIGNALS]", {
          jobId: payload.jobId,
          attempt,
          semanticWallDrift: semanticWallDriftNorm,
          semanticOpeningsDelta: semanticOpeningsDeltaNorm,
          maskedEdgeDrift: maskedEdgeDriftNorm,
          edgeOpeningRisk: edgeOpeningRiskNorm,
        });
      } catch (localGateErr: any) {
        nLog("[STAGE2_LOCAL_SIGNALS_ERROR]", {
          jobId: payload.jobId,
          attempt,
          error: localGateErr?.message || String(localGateErr),
        });
      }


      const localPrecheckSignals: Stage2LocalSignals = {
        structuralDegreeChange: clamp01(Math.max(semanticWallDriftNorm, maskedEdgeDriftNorm)),
        wallDrift: clamp01(semanticWallDriftNorm),
        maskedEdgeDrift: clamp01(maskedEdgeDriftNorm),
        edgeOpeningRisk: clamp01(edgeOpeningRiskNorm),
        openingCountMismatch: clamp01(semanticOpeningsDeltaNorm),
        floorPlaneShift: 0,
        fixtureMismatch: 0,
        islandDetectionDrift: 0,
      };

      const localPrecheckResult = runUnifiedValidator(localPrecheckSignals);
      if (localPrecheckResult.decision === "RETRY") {
        const localPrecheckReason = localPrecheckResult.warnings[0] || "local_precheck_severe";
        nLog("[STAGE2_VALIDATION_FAIL] local_precheck");
        stage2LocalReasons.push("local_precheck_severe");
        nLog("[STAGE2_VALIDATION_ADVISORY] local_precheck mode=log-only action=proceed_to_gemini", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          reason: localPrecheckReason,
          score: localPrecheckResult.score,
          severity: localPrecheckResult.severity,
          warnings: localPrecheckResult.warnings,
        });
      }

      let envelopePass = true;
      let openingPass = true;
      let fixturePass = true;
      let floorPass = true;
      const stage2AdvisorySignals: string[] = [];
      let openingSignatureSignalDetected = false;
      let openingStructuralSignal: OpeningStructuralSignal | undefined;
      let openingStructuralSignalDetected = false;

      type Stage2GateValidator = "openings" | "fixtures" | "floor" | "envelope";
      let currentValidator: Stage2GateValidator = "openings";
      let stage2GateFailure: { validator: Stage2GateValidator; reason: string } | null = null;

      const appendAdvisories = (validator: Stage2GateValidator, advisories: string[]) => {
        if (!Array.isArray(advisories) || advisories.length === 0) return;
        const normalized = advisories.map((signal) => `${validator}:${normalizeValidatorReason(String(signal || "advisory"))}`);
        stage2AdvisorySignals.push(...normalized);
        nLog("[VALIDATOR_ADVISORY]", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          validator,
          advisorySignals: normalized,
        });
      };

      try {
        const { runEnvelopeValidator } = await import("./validators/envelopeValidator.js");
        const { runOpeningValidator } = await import("./validators/openingValidator.js");
        const { runFixtureValidator } = await import("./validators/fixtureValidator.js");
        const { runFloorIntegrityValidator } = await import("./validators/floorIntegrityValidator.js");

        // Stage-A gate: openings -> fixtures
        currentValidator = "openings";
        const opRes = await runOpeningValidator(validationBasePath, path2, structuralBaseline || null);
        appendAdvisories("openings", opRes.advisorySignals || []);
        openingSignatureSignalDetected = (opRes.advisorySignals || [])
          .map((signal) => normalizeValidatorReason(String(signal || "")))
          .some((signal) => signal === "opening_signature_mismatch");
        openingPass = true;
        const openingSignals = extractOpeningSignals(opRes);
        const openingConfidence = evaluateOpeningStructuralConfidence(openingSignals);
        const openingReason = openingConfidence.reason;
        openingStructuralSignalDetected =
          openingConfidence.level === "strong" || openingConfidence.level === "extreme";

        nLog("[OPENING_STRUCTURAL_SIGNAL]", {
          openingStructuralSignal: openingStructuralSignalDetected,
          signalLevel: openingConfidence.level,
          reason: openingReason || "none",
          removed: openingSignals.removed,
          relocated: openingSignals.relocated,
          resized: openingSignals.resized,
          resizeDelta: openingSignals.resizeDelta,
          bandMismatch: openingSignals.bandMismatch,
          classMismatch: openingSignals.classMismatch,
        });

        if (openingStructuralSignalDetected && openingReason) {
          const confidenceLevel = openingConfidence.level;
          appendAdvisories("openings", [
            "opening_structural_signal:true",
            `opening_structural_signal_reason:${openingReason}`,
          ]);

          openingStructuralSignal = {
            type: openingReason,
            confidence: confidenceLevel === "strong" || confidenceLevel === "extreme" ? confidenceLevel : "advisory",
            resizeDelta: Number.isFinite(openingSignals.resizeDelta)
              ? openingSignals.resizeDelta
              : undefined,
          };
        }

        if (openingConfidence.level === "extreme") {
          nLog("[OPENING_STRUCTURAL_CANDIDATE]", {
            jobId: payload.jobId,
            imageId: payload.imageId,
            attempt,
            signalLevel: openingConfidence.level,
            reason: openingReason,
            action: "escalate_gemini_confirmation",
          });
        }

        if (openingConfidence.level === "strong") {
          nLog("[OPENING_STRUCTURAL_ESCALATION]", {
            jobId: payload.jobId,
            imageId: payload.imageId,
            attempt,
            signalLevel: openingConfidence.level,
            reason: openingReason,
            action: "escalate_gemini_strong_cue",
          });
        }

        if (openingConfidence.level === "advisory") {
          nLog("[OPENING_STRUCTURAL_ADVISORY]", {
            jobId: payload.jobId,
            imageId: payload.imageId,
            attempt,
            signalLevel: openingConfidence.level,
            reason: openingReason,
            action: "advisory_only",
          });
        }

        nLog("[STAGE2_VALIDATION_A] openings sensor pass (Gemini adjudicates structural cues)");
        nLog("[OPENING_SIGNATURE_TELEMETRY]", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          signalDetected: openingSignatureSignalDetected,
          decision: "proceed",
          decisionPath: "post_opening_validator",
          stage2Blocked,
        });
        logValidatorResult({
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          validator: "openingValidator",
          result: "PASS",
          reason:
            openingConfidence.level !== "none"
              ? normalizeValidatorReason(`sensor_${openingReason || "opening_signal"}`)
              : "none",
        });

        if (!stage2GateFailure) {
          currentValidator = "fixtures";
          const fixRes = await runFixtureValidator(validationBasePath, path2);
          appendAdvisories("fixtures", fixRes.advisorySignals || []);
          fixturePass = fixRes.hardFail !== true;
          if (fixRes.hardFail === true) {
            stage2GateFailure = { validator: "fixtures", reason: fixRes.reason };
            nLog("[VALIDATOR_HARD_FAIL]", {
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "fixtures",
              reason: fixRes.reason,
              confidence: fixRes.confidence,
            });
            nLog("[STAGE2_VALIDATION_FAIL] fixtures");
            nLog("[STAGE2_VALIDATION_SKIP] skipping remaining validators");
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "fixtureValidator",
              result: "FAIL",
              reason: normalizeValidatorReason(fixRes.reason),
            });
          } else {
            nLog("[STAGE2_VALIDATION_A] fixtures pass");
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "fixtureValidator",
              result: "PASS",
              reason: "none",
            });
          }
        }

        // Stage-B gate: floor -> envelope (only if Stage-A passed)
        if (!stage2GateFailure) {
          currentValidator = "floor";
          const floorRes = await runFloorIntegrityValidator(validationBasePath, path2);
          appendAdvisories("floor", floorRes.advisorySignals || []);
          floorPass = floorRes.hardFail !== true;
          if (floorRes.hardFail === true) {
            stage2GateFailure = { validator: "floor", reason: floorRes.reason };
            nLog("[VALIDATOR_HARD_FAIL]", {
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "floor",
              reason: floorRes.reason,
              confidence: floorRes.confidence,
            });
            nLog("[STAGE2_VALIDATION_FAIL] floor");
            nLog("[STAGE2_VALIDATION_SKIP] skipping remaining validators");
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "floorIntegrityValidator",
              result: "FAIL",
              reason: normalizeValidatorReason(floorRes.reason),
            });
          } else {
            nLog("[STAGE2_VALIDATION_B] floor pass");
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "floorIntegrityValidator",
              result: "PASS",
              reason: "none",
            });
          }
        }

        if (!stage2GateFailure) {
          currentValidator = "envelope";
          const envRes = await runEnvelopeValidator(validationBasePath, path2);
          appendAdvisories("envelope", envRes.advisorySignals || []);
          envelopePass = envRes.hardFail !== true;
          if (envRes.hardFail === true) {
            stage2GateFailure = { validator: "envelope", reason: envRes.reason };
            nLog("[VALIDATOR_HARD_FAIL]", {
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "envelope",
              reason: envRes.reason,
              confidence: envRes.confidence,
            });
            nLog("[STAGE2_VALIDATION_FAIL] envelope");
            nLog("[STAGE2_VALIDATION_SKIP] skipping remaining validators");
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "envelopeValidator",
              result: "FAIL",
              reason: normalizeValidatorReason(envRes.reason),
            });
          } else {
            nLog("[STAGE2_VALIDATION_B] envelope pass");
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "envelopeValidator",
              result: "PASS",
              reason: "none",
            });
          }
        }
      } catch (err: any) {
        const gateErrorMessage = err?.message || String(err);
        stage2GateFailure = stage2GateFailure || { validator: currentValidator, reason: gateErrorMessage };
        nLog(`[STAGE2_VALIDATION_FAIL] ${stage2GateFailure.validator}`);
        nLog("[STAGE2_VALIDATION_SKIP] skipping remaining validators");
        logValidatorResult({
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          validator: `${stage2GateFailure.validator}Validator`,
          result: "FAIL",
          reason: normalizeValidatorReason(gateErrorMessage),
        });
        if (stage2GateFailure.validator === "openings") openingPass = false;
        if (stage2GateFailure.validator === "fixtures") fixturePass = false;
        if (stage2GateFailure.validator === "floor") floorPass = false;
        if (stage2GateFailure.validator === "envelope") envelopePass = false;
      }

      if (stage2GateFailure) {
        const gateRetryReason = `stage2_validation_${stage2GateFailure.validator}`;
        stage2LocalReasons.push(gateRetryReason);
        pendingStage2StructuralFailureType = "STRUCTURAL_INVARIANT";
        pendingStage2RetryStrategy = "NORMAL";
        pendingStage2RetryReason = gateRetryReason;

        setStage2AttemptValidation(path2, "local", [
          gateRetryReason,
          stage2GateFailure.reason,
        ]);

        mergeAttemptValidation("2", attempt, {
          final: {
            result: "FAILED",
            finalHard: true,
            finalCategory: stage2GateFailure.validator,
            retryTriggered: attempt < MAX_STAGE2_RETRIES,
            retriesExhausted: attempt >= MAX_STAGE2_RETRIES,
            retryStrategy: "NORMAL",
            reason: stage2GateFailure.reason,
          },
        });

        if (attempt < MAX_STAGE2_RETRIES) {
          nLog("[OPENING_SIGNATURE_TELEMETRY]", {
            jobId: payload.jobId,
            imageId: payload.imageId,
            attempt,
            signalDetected: openingSignatureSignalDetected,
            decision: "retry",
            decisionPath: "stage2_gate_failure",
            validator: stage2GateFailure.validator,
            reason: normalizeValidatorReason(stage2GateFailure.reason),
          });
          logValidateFinal(attempt, "retry", attempt);
          logStage2Retry(attempt, gateRetryReason);
          logEvent("STAGE_RETRY", {
            jobId: payload.jobId,
            stage: "2",
            retry: attempt + 1,
            retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
            reason: gateRetryReason,
          });
          continue;
        }

        const fallbackPath = stageLineage.stage1B.committed && stageLineage.stage1B.output
          ? stageLineage.stage1B.output
          : path1A;
        const fallbackStage = fallbackPath === path1A ? "1A" : "1B";
        stage2Blocked = true;
        stage2FallbackStage = fallbackStage;
        stage2BlockedReason = `${gateRetryReason}_exhausted`;
        fallbackUsed = fallbackStage === "1B" ? "stage2_structure_fallback_1b" : "stage2_structure_fallback_1a";
        path2 = fallbackPath;
        stage2CandidatePath = fallbackPath;
        nLog("[OPENING_SIGNATURE_TELEMETRY]", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          signalDetected: openingSignatureSignalDetected,
          decision: "reject",
          decisionPath: "stage2_gate_failure_exhausted",
          validator: stage2GateFailure.validator,
          reason: normalizeValidatorReason(stage2GateFailure.reason),
        });
        logValidateFinal(attempt, "reject", attempt - 1);
        break;
      }

      const localSignals: Stage2LocalSignals = {
        structuralDegreeChange: clamp01(Math.max(semanticWallDriftNorm, maskedEdgeDriftNorm, envelopePass ? 0 : 1)),
        wallDrift: clamp01(semanticWallDriftNorm),
        maskedEdgeDrift: clamp01(maskedEdgeDriftNorm),
        edgeOpeningRisk: clamp01(edgeOpeningRiskNorm),
        openingCountMismatch: clamp01(Math.max(semanticOpeningsDeltaNorm, openingPass ? 0 : 1)),
        floorPlaneShift: floorPass ? 0 : 1,
        fixtureMismatch: fixturePass ? 0 : 1,
        islandDetectionDrift: 0,
      };

      const unifiedLocalResult = runUnifiedValidator(localSignals);
      const formattedSignals = `structuralDegreeChange:${localSignals.structuralDegreeChange.toFixed(4)},wallDrift:${localSignals.wallDrift.toFixed(4)},maskedEdgeDrift:${localSignals.maskedEdgeDrift.toFixed(4)},edgeOpeningRisk:${localSignals.edgeOpeningRisk.toFixed(4)},openingCountMismatch:${localSignals.openingCountMismatch.toFixed(4)},floorPlaneShift:${localSignals.floorPlaneShift.toFixed(4)},fixtureMismatch:${localSignals.fixtureMismatch.toFixed(4)},islandDetectionDrift:${localSignals.islandDetectionDrift.toFixed(4)}`;

      if (unifiedLocalResult.severity === "CATASTROPHIC") {
        const catastrophicReason = unifiedLocalResult.warnings[0] || "catastrophic_structural_change";
        nLog(
          `[UNIFIED_VALIDATOR]\njob_id=${payload.jobId}\nimage_id=${payload.imageId}\nattempt=${attempt}\nseverity=CATASTROPHIC\nreason=${catastrophicReason}\ndecision=${unifiedLocalResult.decision}`
        );
      } else {
        nLog(
          `[UNIFIED_VALIDATOR]\njob_id=${payload.jobId}\nimage_id=${payload.imageId}\nattempt=${attempt}\nseverity=${unifiedLocalResult.severity}\nscore=${unifiedLocalResult.score.toFixed(4)}\nsignals={${formattedSignals}}\ndecision=${unifiedLocalResult.decision}`
        );
      }

      unifiedValidation = {
        passed: true,
        hardFail: false,
        score: unifiedLocalResult.score,
        reasons: unifiedLocalResult.warnings,
        warnings: unifiedLocalResult.warnings,
        evidence: { anchorChecks: {} },
      } as any;

      if (unifiedLocalResult.decision === "RETRY") {
        nLog("[OPENING_SIGNATURE_TELEMETRY]", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          signalDetected: openingSignatureSignalDetected,
          decision: "proceed",
          decisionPath: "unified_validator_log_only",
          reason: normalizeValidatorReason(unifiedLocalResult.severity.toLowerCase()),
        });
        nLog("[STAGE2_VALIDATION_ADVISORY] unified_validator mode=log-only action=proceed_to_gemini", {
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          severity: unifiedLocalResult.severity,
          score: unifiedLocalResult.score,
          warnings: unifiedLocalResult.warnings,
        });
      }

      let compositeDecision = "pass";
      let complianceDecision = "not_run";
      let geminiConfirmStatus = "not_run";
      let derivedWarnings = 0;
      // END NEW SEQUENTIAL VALIDATORS
      // Compliance gate is part of Stage 2 retry flow.
      // A blocking compliance verdict triggers retry; it does not fail the job directly.
      const finalConfirmMode: "block" | "log" = geminiSemanticValidatorMode === "log" ? "log" : "block";
      if (validationStage === "2") {
        try {
          if (stage2AdvisorySignals.length === 0) {
            nLog("[GEMINI_ESCALATION]", {
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              action: "skip",
              reason: "no_advisories",
            });
          } else {
            const ai = getGeminiClient();
            const base1A = toBase64(path1A);
            const baseFinal = toBase64(path2);
            nLog("[GEMINI_ESCALATION]", {
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              action: "run",
              model: "gemini-2.5-pro",
              advisoryCount: stage2AdvisorySignals.length,
              advisorySignals: stage2AdvisorySignals,
              openingStructuralSignalFlag: openingStructuralSignalDetected,
              openingStructuralSignal: openingStructuralSignal || null,
            });
            compliance = await checkCompliance(ai as any, base1A.data, baseFinal.data, {
              validationMode: stage2ValidationMode,
              advisorySignals: stage2AdvisorySignals,
              openingStructuralSignal: openingStructuralSignalDetected,
              openingStructuralSignalContext: openingStructuralSignal,
              modelOverride: "gemini-2.5-pro",
            });
          }

          if (compliance && compliance.ok === false) {
            const HIGH_CONF = COMPLIANCE_BLOCK_THRESHOLD;
            const MED_CONF = Math.max(0, COMPLIANCE_BLOCK_THRESHOLD - 0.1);
            const confidence = compliance.confidence ?? 0.6;
            const anchorChecks = unifiedValidation?.evidence?.anchorChecks;
              const roomTypeLower = String(payload.options.roomType || "").toLowerCase();
              const kitchenContext = roomTypeLower.includes("kitchen");
              const islandAnchorStructural = kitchenContext && !!anchorChecks?.islandChanged;
            const hasAnchorEvidence = !!anchorChecks && (
                islandAnchorStructural ||
              anchorChecks.cabinetryChanged ||
              anchorChecks.hvacChanged ||
              anchorChecks.lightingChanged
            );
              const primaryStructuralViolationDetected = hasPrimaryStructuralViolation(unifiedValidation);
            const structuralViolation = !!compliance.structuralViolation;
            const placementViolation = !!compliance.placementViolation;
            const tier = Number.isFinite(compliance.tier)
              ? Math.max(1, Math.min(3, Math.floor(compliance.tier)))
              : 1;
            const reasonText = String(
              compliance.reason
              || (Array.isArray(compliance.reasons) ? compliance.reasons.join("; ") : "Compliance check failed")
            );
            const legacyBlock = confidence >= HIGH_CONF || (confidence >= MED_CONF && hasAnchorEvidence);
            const complianceBlocking = compliance.blocking === true || legacyBlock;
            const complianceRetryEligible = primaryStructuralViolationDetected;
            let complianceDecision = "not_run";

            nLog("[STRUCTURE_COMPLIANCE_AUDIT]", {
              jobId: payload.jobId,
              complianceOk: compliance.ok,
              complianceConfidence: compliance.confidence,
              complianceTier: tier,
              complianceReason: reasonText,
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
              finalStage2Url: null,
            });

            nLog("[COMPLIANCE_GATE_DECISION]", {
              jobId: payload.jobId,
              ok: compliance.ok,
              confidence,
              tier,
              reason: reasonText,
              hasAnchorEvidence,
              primaryStructuralViolationDetected,
              structuralViolation,
              placementViolation,
              highThreshold: HIGH_CONF,
              medThreshold: MED_CONF,
              mode: finalConfirmMode,
              action: (complianceBlocking && complianceRetryEligible && finalConfirmMode === "block") ? "retry" : "log-only",
            });

            if (!complianceRetryEligible && complianceBlocking) {
              stage2Blocked = false;
              complianceDecision = "allow_pass_secondary_only";
              nLog("[STAGE2_COMPLIANCE_SKIP_RETRY] secondary_only_signals=true action=allow_pass");
            }

            if (complianceBlocking && complianceRetryEligible && finalConfirmMode === "block") {
              complianceDecision = "retry";
              const lastViolationMsg = `Compliance blocking detected: ${reasonText}`;
              nLog(`[worker] ⚠️  COMPLIANCE RETRY TRIGGER job=${payload.jobId} attempt=${attempt}/${MAX_STAGE2_RETRIES}: ${lastViolationMsg} (confidence: ${confidence.toFixed(2)}, tier: ${tier})`);
              setStage2AttemptValidation(path2, "gemini", compliance.reasons || [reasonText]);
              mergeAttemptValidation("2", attempt, {
                final: {
                  result: "FAILED",
                  finalHard: true,
                  finalCategory: "compliance",
                  retryTriggered: attempt < MAX_STAGE2_RETRIES,
                  retriesExhausted: attempt >= MAX_STAGE2_RETRIES,
                  retryStrategy: "NORMAL",
                  reason: reasonText,
                },
              });
              logEvent("VALIDATION_RESULT", {
                jobId: payload.jobId,
                stage: "2",
                attempt,
                localPass: unifiedValidation.passed === true,
                geminiPass: false,
                confirmPass: null,
                finalPass: false,
                violationType: "compliance",
                retryStrategy: "NORMAL",
                retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
              });

              if (attempt >= MAX_STAGE2_RETRIES) {
                const fallback1B = stageLineage.stage1B.committed && stageLineage.stage1B.output
                  ? stageLineage.stage1B.output
                  : path1B;
                const fallbackPath = fallback1B || path1A;
                const fallbackStage: "1A" | "1B" = fallback1B ? "1B" : "1A";

                stage2Blocked = true;
                stage2FallbackStage = fallbackStage;
                stage2BlockedReason = `stage2_compliance_exhausted after ${MAX_STAGE2_RETRIES} attempts: ${reasonText}`;
                fallbackUsed = fallbackStage === "1B" ? "stage2_compliance_fallback_1b" : "stage2_compliance_fallback_1a";
                path2 = fallbackPath;
                stage2CandidatePath = fallbackPath;
                nLog(`[STAGE2_COMPLIANCE_EXHAUSTED] attempts=${MAX_STAGE2_RETRIES} fallback=${fallbackStage}`);
                logEvent("FATAL_RETRY_EXHAUSTION", {
                  jobId: payload.jobId,
                  stage: "2",
                  attempts: attempt,
                  blockedBy: "compliance",
                  reason: stage2BlockedReason,
                });
                emitStage2DecisionBreakdown({
                  extremeLocalFail: false,
                  topologyFail: false,
                  invariantFail: false,
                  compositeDecision,
                  geminiConfirmStatus,
                  complianceDecision,
                  stage2Blocked,
                  decisionPoint: "final_block",
                  reason: "compliance",
                });
                nLog(`[FALLBACK_TO_STAGE${fallbackStage}] reason=${stage2BlockedReason}`);
                logValidateFinal(attempt, "reject", attempt - 1);
                break;
              }

              emitStage2DecisionBreakdown({
                extremeLocalFail: false,
                topologyFail: false,
                invariantFail: false,
                compositeDecision,
                geminiConfirmStatus,
                complianceDecision,
                stage2Blocked,
                decisionPoint: "retry_schedule",
                reason: reasonText,
              });
              logValidateFinal(attempt, "retry", attempt);
              logStage2Retry(attempt, normalizeValidatorReason(reasonText));
              logEvent("STAGE_RETRY", {
                jobId: payload.jobId,
                stage: "2",
                retry: attempt + 1,
                retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
                reason: reasonText,
              });
              continue;
            }

            if (complianceBlocking && finalConfirmMode === "log") {
              nLog(`[worker] ⚠️  Compliance failure detected (confidence ${confidence.toFixed(2)}) mode=log - ALLOWING job to proceed: ${reasonText}`);
            } else {
              nLog("[COMPLIANCE_SOFT_FAIL]", {
                jobId: payload.jobId,
                confidence,
                tier,
                reason: reasonText,
                reasons: compliance.reasons,
                threshold: MED_CONF,
                highThreshold: HIGH_CONF,
              });
              nLog(`[worker] ⚠️  Compliance concerns (confidence ${confidence.toFixed(2)} < ${MED_CONF} threshold) - allowing job to proceed`);
            }
          }
        } catch (e: any) {
          nLog("[worker] compliance check skipped or error:", e?.message || e);
        }
      }

      // --- NEW FIXTURE VALIDATOR (Conditions A & B) ---
      const fixtureKeywordsAB = ["ceiling", "fan", "light", "fixture", "downlight", "vent", "smoke"];
      const hasCeilingDrift = Array.isArray(unifiedValidation.warnings) && 
        unifiedValidation.warnings.some(w => {
          const lowerW = w.toLowerCase();
          return fixtureKeywordsAB.some((kw) => lowerW.includes(kw));
        });
      const conditionA = typeof derivedWarnings === "number" && derivedWarnings >= 3 && derivedWarnings < 5;
      const conditionB = hasCeilingDrift;

      if (false && (conditionA || conditionB)) {
        nLog(`[FIXTURE_VALIDATOR_TRIGGER] reason=${conditionA ? "uncertain_drift" : "ceiling_drift"} job_id=${payload.jobId}`);
        try {
          const { runFixtureValidator } = await import("./validators/fixtureValidator.js");
          let passCandidateBase64 = "";
          let passBaselineBase64 = "";
          try {
             passCandidateBase64 = `data:image/jpeg;base64,${(await fs.promises.readFile(path2)).toString("base64")}`;
             passBaselineBase64 = `data:image/jpeg;base64,${(await fs.promises.readFile(path1A)).toString("base64")}`;
          } catch (err) {}
          if (passCandidateBase64 && passBaselineBase64) {
             const fixtureResult = await runFixtureValidator(passBaselineBase64, passCandidateBase64);
             if (fixtureResult.status === "fail") {
               nLog(`[FIXTURE_VALIDATOR_RESULT] ok=false detected_changes=${JSON.stringify(fixtureResult.reason)}`);
               
               const failReasons = ["fixture_validator_fail", fixtureResult.reason];
               setStage2AttemptValidation(path2, "fixture", failReasons);
               mergeAttemptValidation("2", attempt, {
                 final: {
                   result: "FAILED",
                   finalHard: true,
                   finalCategory: "fixture",
                   retryTriggered: attempt < MAX_STAGE2_RETRIES,
                   retriesExhausted: attempt >= MAX_STAGE2_RETRIES,
                   retryStrategy: "NORMAL",
                   reason: fixtureResult.reason,
                 },
               });
               
               if (attempt < MAX_STAGE2_RETRIES) {
                 emitStage2DecisionBreakdown({
                   extremeLocalFail: false,
                   topologyFail: false,
                   invariantFail: false,
                   compositeDecision,
                   geminiConfirmStatus,
                   complianceDecision: "not_run",
                   stage2Blocked: false,
                   decisionPoint: "retry_schedule",
                   reason: "fixture_validator_fail",
                 });
                 logEvent("STAGE_RETRY", {
                   jobId: payload.jobId,
                   stage: "2",
                   retry: attempt + 1,
                   retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
                   reason: "fixture_validation_fail",
                 });
                 continue;
               } else {
                 const fallback1B = stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1B;
                 const fallbackStage = fallback1B ? "1B" : "1A";
                 stage2Blocked = true;
                 stage2FallbackStage = fallbackStage;
                 stage2BlockedReason = `stage2_fixture_exhausted after ${MAX_STAGE2_RETRIES} attempts`;
                 fallbackUsed = fallbackStage === "1B" ? "stage2_fixture_fallback_1b" : "stage2_fixture_fallback_1a";
                 path2 = fallback1B || path1A;
                 stage2CandidatePath = path2;
                 emitStage2DecisionBreakdown({
                   extremeLocalFail: false,
                   topologyFail: false,
                   invariantFail: false,
                   compositeDecision,
                   geminiConfirmStatus,
                   complianceDecision: "not_run",
                   stage2Blocked,
                   decisionPoint: "final_block",
                   reason: "fixture_validator_fail",
                 });
                 logValidateFinal(attempt, "reject", attempt - 1);
                 break;
               }
             } else {
               nLog(`[FIXTURE_VALIDATOR_PASS]`);
             }
          }
        } catch (e) {
           nLog(`[FIXTURE_VALIDATOR_ERROR] ${e}`);
        }
      }

      // Final pre-publish identity gate: Gemini structural review runs last.
      let seePass = true;
      let finalFailValidator: "structural_review" | "unknown" = "unknown";
      let finalFailReason = "";

      try {
        const structuralReview = ENABLE_FINAL_STRUCTURAL_REVIEW
          ? await runGeminiStructuralReviewPro(validationBasePath, path2)
          : { result: "PASS" as const, confidence: 100, explanation: "final_structural_review_disabled" };

        if (ENABLE_FINAL_STRUCTURAL_REVIEW) {
          if (structuralReview.result === "FAIL") {
            finalFailValidator = "structural_review";
            seePass = false;
            finalFailReason = structuralReview.explanation || "structural_review_failed";
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "structuralIdentityReview",
              result: "FAIL",
              reason: normalizeValidatorReason(finalFailReason),
            });
          } else {
            logValidatorResult({
              jobId: payload.jobId,
              imageId: payload.imageId,
              attempt,
              validator: "structuralIdentityReview",
              result: "PASS",
              reason: "none",
            });
          }
        }
      } catch (finalGateErr: any) {
        finalFailValidator = finalFailValidator === "unknown" ? "structural_review" : finalFailValidator;
        seePass = false;
        finalFailReason = finalGateErr?.message || String(finalGateErr);
        logValidatorResult({
          jobId: payload.jobId,
          imageId: payload.imageId,
          attempt,
          validator: "structuralIdentityReview",
          result: "FAIL",
          reason: normalizeValidatorReason(finalFailReason),
        });
      }

      if (!seePass) {
        const normalizedFinalReason = String(finalFailReason || "final_identity_review_failed")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || "final_identity_review_failed";
        const retryReason = "structural_review_failed";

        stage2LocalReasons.push(retryReason);
        setStage2AttemptValidation(path2, finalFailValidator, [retryReason, normalizedFinalReason]);
        pendingStage2StructuralFailureType = "STRUCTURAL_INVARIANT";
        pendingStage2RetryStrategy = "NORMAL";
        pendingStage2RetryReason = retryReason;

        mergeAttemptValidation("2", attempt, {
          final: {
            result: "FAILED",
            finalHard: true,
            finalCategory: finalFailValidator,
            retryTriggered: attempt < MAX_STAGE2_RETRIES,
            retriesExhausted: attempt >= MAX_STAGE2_RETRIES,
            retryStrategy: "NORMAL",
            reason: `${retryReason}:${normalizedFinalReason}`,
          },
        });

        if (attempt < MAX_STAGE2_RETRIES) {
          logValidateFinal(attempt, "retry", attempt);
          logStage2Retry(attempt, `${retryReason}:${normalizedFinalReason}`);
          logEvent("STAGE_RETRY", {
            jobId: payload.jobId,
            stage: "2",
            retry: attempt + 1,
            retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
            reason: `${retryReason}:${normalizedFinalReason}`,
          });
          continue;
        }

        const fallback1B = stageLineage.stage1B.committed && stageLineage.stage1B.output ? stageLineage.stage1B.output : path1B;
        const fallbackStage = fallback1B ? "1B" : "1A";
        stage2Blocked = true;
        stage2FallbackStage = fallbackStage;
        stage2BlockedReason = `${retryReason}_exhausted`;
        fallbackUsed = fallbackStage === "1B" ? "stage2_structure_fallback_1b" : "stage2_structure_fallback_1a";
        path2 = fallback1B || path1A;
        stage2CandidatePath = path2;
        logValidateFinal(attempt, "reject", attempt - 1);
        break;
      }

      nLog(`[STAGE2_UNIFIED_SUCCESS] attempt=${attempt}`);
      mergeAttemptValidation("2", attempt, {
        final: {
          result: "PASSED",
          finalHard: false,
          finalCategory: "accept",
          retryTriggered: false,
          retriesExhausted: false,
          retryStrategy: "NORMAL",
        },
      });
      logEvent("VALIDATION_RESULT", {
        jobId: payload.jobId,
        stage: "2",
        attempt,
        localPass: unifiedValidation.passed === true,
        geminiPass: true,
        confirmPass: null,
        finalPass: true,
        violationType: null,
        retriesRemaining: Math.max(0, MAX_STAGE2_RETRIES - attempt),
      });
      updateJob(payload.jobId, {
        meta: {
          ...sceneMeta,
          stage2LocalReasons,
          geminiConfirm: null,
        }
      });
      logValidateFinal(attempt, "accept", attempt - 1);
      break;
    }
  }

  timings.validateMs = Date.now() - tVal;
  nLog(`[AUDIT FIX] Compliance evaluated in retry flow — proceeding to publish Stage 2 image or fallback`);

  if (payload.options.virtualStage && stage2Blocked && stage2BlockedReason === "composite_validation_exhausted") {
    const fallbackStage: "1A" | "1B" = path1B ? "1B" : "1A";
    const fallbackPath = fallbackStage === "1B" ? path1B! : path1A;
    await completePartialJobWithSummary({
      jobId: payload.jobId,
      triggerStage: "2",
      finalStage: fallbackStage,
      finalPath: fallbackPath,
      pub1AUrl,
      pub1BUrl,
      sceneMeta: { ...sceneMeta },
      userMessage: fallbackStage === "1B"
        ? "We decluttered your image but could not safely stage it."
        : "We enhanced your image but could not safely stage it.",
      reason: "composite_validation_exhausted",
      stageOutputs: { "1A": path1A, ...(path1B ? { "1B": path1B } : {}) },
      billingContext: {
        payload,
        sceneType: sceneLabel || "interior",
        stage1BUserSelected: originalUserDeclutter,
        geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
      },
    });
    return;
  }

  // Publish Stage 2 only if it passed blocking validation
  if (payload.options.virtualStage && !stage2Blocked && stage2CandidatePath) {
    if (stage2CandidatePath === path1A) {
      nLog("[STAGE2_PUBLISH_GUARD] Stage-2 candidate equals Stage-1A; suppressing Stage-2 publish and forcing fallback", {
        jobId: payload.jobId,
        candidate: stage2CandidatePath,
        stage1A: path1A,
      });
      stage2Blocked = true;
      stage2FallbackStage = path1B ? "1B" : "1A";
      stage2BlockedReason = "stage2_candidate_equals_stage1a";
      fallbackUsed = path1B ? "stage2_structure_fallback_1b" : "stage2_structure_fallback_1a";
    }

    if (stage2Blocked) {
      nLog("[STAGE2_PUBLISH_GUARD] Skipping Stage-2 publish due to guarded fallback", {
        jobId: payload.jobId,
        reason: stage2BlockedReason,
      });
    } else {
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
      logJobErrorAndThrow(payload, "Stage 1B path is undefined", {
        stage: "Stage1B",
      });
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
        logJobErrorAndThrow(payload, "publishImage returned no URL", {
          stage: "publish",
        });
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
    ...(stage2Skipped ? { stage2Skipped: true, stage2SkipReason, stageCompleted: "1A" } : {}),
    ...(stage2Blocked ? { stage2Blocked: true, stage2BlockedReason, validationNote: stage2BlockedReason, fallbackStage: stage2FallbackStage, partial: true } : {}),
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

  if (hasStage2 && !stage2ValidationPassed) {
    const fallbackStage: "1A" | "1B" = (payload.options.declutter && !!path1B) ? "1B" : "1A";
    const fallbackPath = fallbackStage === "1B" ? path1B! : path1A;
    await completePartialJobWithSummary({
      jobId: payload.jobId,
      triggerStage: "2",
      finalStage: fallbackStage,
      finalPath: fallbackPath,
      pub1AUrl,
      pub1BUrl,
      sceneMeta: { ...sceneMeta },
      userMessage: fallbackStage === "1B"
        ? "We decluttered your image but could not safely stage it."
        : "We enhanced your image but could not safely stage it.",
      reason: "stage2_validation_exhausted",
      stageOutputs: { "1A": path1A, ...(path1B ? { "1B": path1B } : {}) },
      billingContext: {
        payload,
        sceneType: sceneLabel || "interior",
        stage1BUserSelected: originalUserDeclutter,
        geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
      },
    });
    return;
  }

  if (hasStage2 && !(await canCompleteStage2(true, "stage2_final_complete"))) return;

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

  const finalHardFail = Boolean(unifiedValidation?.hardFail) || Boolean(stage2Blocked);

  // FIX 1: ATOMIC completion write - all fields in single updateJob call
  // This prevents race conditions where status API sees partial state
  await safeWriteJobStatus(payload.jobId, {
    // Core completion flags (written atomically)
    status: "complete",
    success: true,
    completed: true,
    stageCompleted: committedFinalStageLabel,
    stage2Skipped: stage2Skipped || undefined,
    stage2SkipReason: stage2Skipped ? stage2SkipReason : undefined,
    completionReason: stage2Skipped && stage2SkipReason ? stage2SkipReason : undefined,
    currentStage: "finalizing",
    finalStage: committedFinalStageLabel,
    resultStage: committedFinalStageLabel,
    
    // URLs (all written together, no partial state possible)
    originalUrl: publishedOriginal?.url,
    finalOutputUrl: committedResultUrl,
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
          hardFail: finalHardFail,
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
          hardFail: finalHardFail,
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
  if (stage2Skipped) {
    nLog("[PIPELINE] Job completed at Stage-1A", {
      jobId: payload.jobId,
      stageCompleted: "1A",
      stage2Skipped: true,
      reason: stage2SkipReason,
    });
  }

  // ===== POST-COMPLETION OPERATIONS (BEST-EFFORT, NON-BLOCKING) =====
  // These run AFTER marking the job complete to ensure the user sees results even if these fail

  // ===== RESERVATION FINALIZATION =====
  // Finalize reservation based on actual stage completion
  // IMPORTANT: These signals must be derived from published output URLs (execution reality),
  // NOT from routing intent flags (declutterMode, routingSnapshot.stage1BRequired, etc.).
  const billingStage1ASuccess = !!(pub1AUrl || pub1BUrl);
  const billingStage1BSuccess = (finalStageLabel === "1B" || finalStageLabel === "2")
    ? !!pub1BUrl
    : false;
  const billingStage2Success = committedFinalStageLabel === "2" ? !!committedStage2Url : false;

  // ===== USAGE TRACKING =====
  // Record usage from authoritative terminal job state only.
  const finalizedJob = await getJob(payload.jobId);
  const finalizedStatus = String((finalizedJob as any)?.status || "").toLowerCase();
  const isTerminalComplete = finalizedStatus === "complete" || finalizedStatus === "completed";
  const hasUsableFinalOutput = typeof committedResultUrl === "string" && committedResultUrl.length > 0;
  const billableFinalSuccess = isTerminalComplete && hasUsableFinalOutput;
  const isEnhancementJob = (payload as any).type === "enhance";
  const isFreeManualRetry = (payload as any).retryType === "manual_retry";

  try {
    const agencyId = (payload as any).agencyId || null;
    const imagesUsed = billableFinalSuccess && !isFreeManualRetry && isEnhancementJob ? 1 : 0;
    await recordEnhanceBundleUsage(payload, imagesUsed, agencyId);
  } catch (usageErr) {
    // Usage tracking must never block job completion
    nLog("[USAGE] Failed to record usage (non-blocking):", (usageErr as any)?.message || usageErr);
  }
  // Stage1B is billing-effective only when user explicitly selected declutter OR Gemini confirmed furniture.
  // Gate-triggered light-declutter on clutter-only empty rooms runs the stage but does not escalate billing.
  const billingEffectiveStage1B =
    billingStage1BSuccess &&
    (originalUserDeclutter || (frozenRoutingSnapshot?.geminiHasFurniture === true));

  const actualCharge = billableFinalSuccess && !isFreeManualRetry && isEnhancementJob ? 1 : 0;

  nLog("[BILLING_CHARGE_TELEMETRY]", {
    jobId: payload.jobId,
    imageId: payload.imageId,
    stage1ASuccess: billingStage1ASuccess,
    stage1BSuccess: billingStage1BSuccess,
    stage2Success: billingStage2Success,
    finalCharge: actualCharge,
    path: "main_pipeline",
    stage1BUserSelected: originalUserDeclutter,
    geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? null,
    billingEffectiveStage1B,
    billableFinalSuccess,
    completedStatus: finalizedStatus,
    isEnhancementJob,
    freeRetryNoAdditionalCharge: isFreeManualRetry,
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
  if (!isFreeManualRetry && isEnhancementJob) {
    try {
      await finalizeImageChargeFromWorker({
        jobId: payload.jobId,
        stage1ASuccess: billingStage1ASuccess,
        stage1BSuccess: billingStage1BSuccess,
        stage2Success: billingStage2Success,
        sceneType: sceneLabel || "interior",
        stage1BUserSelected: originalUserDeclutter,
        geminiHasFurniture: frozenRoutingSnapshot?.geminiHasFurniture ?? undefined,
      });
    } catch (chargeErr) {
      // Billing errors must not crash the worker
      nLog("[BILLING] Failed to finalize charge (non-blocking):", (chargeErr as any)?.message || chargeErr);
    }
  } else {
    nLog(`[BILLING] Skipping charge finalization for non-billable job type or free manual retry: ${payload.jobId}`);
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
      structuralConsensusDistribution: {
        CASE_A_COUNT: stage2ConsensusCaseACount,
        CASE_B_COUNT: stage2ConsensusCaseBCount,
        CASE_C_COUNT: stage2ConsensusCaseCCount,
      },
      finalHardFail,
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
  nLog(`[JOB_FINAL][job=${payload.jobId}] status=complete hardFail=${finalHardFail} warnings=${finalWarningCount} normalized=${unifiedValidation?.normalized ?? false}`);
  nLog("[STRUCTURAL_CONSENSUS_DISTRIBUTION]", {
    jobId: payload.jobId,
    CASE_A_COUNT: stage2ConsensusCaseACount,
    CASE_B_COUNT: stage2ConsensusCaseBCount,
    CASE_C_COUNT: stage2ConsensusCaseCCount,
  });
  emitJobAttemptSummary(stage2Blocked ? "EXHAUSTED" : "SUCCESS");

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
      propertyId: (payload as any).propertyId || null,
      parentImageId: (payload as any).retryParentImageId || null,
      source: 'stage2',
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
    finalOutputUrl: pubFinalUrl || null,
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
    try {
      const normalizedMask = normalizeMaskBase64(maskBase64);
      mask = await normalizeMaskBufferToPng(normalizedMask);
    } catch (maskErr: any) {
      nLog("[worker-edit] Mask decode failed:", maskErr?.message || String(maskErr));
      await safeWriteJobStatus(jobId, { status: "failed", errorMessage: "Invalid mask provided for edit" }, "edit_invalid_mask");
      return;
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

  // Also record in enhanced_images gallery history (non-blocking)
  if ((payload as any).agencyId && pub.url) {
    const extractKey = (url?: string | null) => {
      if (!url) return null;
      try {
        const u = new URL(url);
        return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
      } catch {
        return null;
      }
    };
    const auditRef = generateAuditRef();
    const traceId = generateTraceId(jobId);
    const originalKey = extractKey(baseImageUrl || null);
    const enhancedKey = extractKey(pub.url || null);
    recordEnhancedImageHistory({
      agencyId: (payload as any).agencyId,
      userId,
      jobId,
      propertyId: (payload as any).propertyId || null,
      parentImageId: (payload as any).sourceImageId || null,
      source: 'region-edit',
      stagesCompleted: ["edit"],
      publicUrl: pub.url,
      thumbnailUrl: pub.url,
      originalUrl: baseImageUrl || null,
      originalS3Key: originalKey,
      enhancedS3Key: enhancedKey,
      thumbS3Key: enhancedKey,
      auditRef,
      traceId,
    }).catch((err) => {
      nLog(`[enhanced-images] Failed to record edit image: ${err}`);
    });
  }

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
      finalOutputUrl: pub.url,
      resultUrl: pub.url,
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
logEvent("SYSTEM_START", {
  build: BUILD_VERSION,
  queue: JOB_QUEUE_NAME,
  validatorLogsFocus: VALIDATOR_LOGS_FOCUS ? "1" : "0",
  signAllStageOutputs: SIGN_ALL_STAGE_OUTPUTS_ENABLED ? "1" : "0",
  signedUrlTtlSeconds: STAGE_OUTPUT_SIGNED_URL_TTL_SECONDS,
});
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
nLog('  SIGN_ALL_STAGE_OUTPUTS:', process.env.SIGN_ALL_STAGE_OUTPUTS === '1' ? '1 (enabled)' : `${process.env.SIGN_ALL_STAGE_OUTPUTS || '0'} (disabled)`);
nLog('  STAGE_OUTPUT_SIGNED_URL_TTL_SECONDS:', String(STAGE_OUTPUT_SIGNED_URL_TTL_SECONDS));
nLog('╚════════════════════════════════════════════════════════════════╝');
nLog('\n'); // Force flush

if (process.env.DEBUG_INVARIANT_REPLAY === "true") {
  debugRunInvariantReplay()
    .then(() => console.log("Invariant replay complete"))
    .catch((err) => console.error("Invariant replay error:", err));
}

// Log validator configuration on startup
logValidationModes();
nLog('\n'); // Force flush

// Keep billing eventually consistent via non-blocking ledger retries.
startBillingFinalizationRetryLoop();

// BullMQ stalled detection instrumentation.
_queueEventsRef = new QueueEvents(JOB_QUEUE_NAME, {
  connection: { url: REDIS_URL },
});
_queueEventsRef.on("stalled", ({ jobId }) => {
  nLog(`[BULLMQ_STALLED] jobId=${jobId || "unknown"}`);
  logEvent("SYSTEM_ERROR", { phase: "bullmq_stalled", jobId: jobId || null });
});
_queueEventsRef.on("error", (err) => {
  nLog("[BULLMQ_QUEUE_EVENTS_ERROR]", (err as any)?.message || String(err));
});

// QueueScheduler is available in BullMQ v4; BullMQ v5 handles stalled checks within Worker.
const QueueSchedulerCtor = (BullMQ as any).QueueScheduler;
if (typeof QueueSchedulerCtor === "function") {
  _queueSchedulerRef = new QueueSchedulerCtor(JOB_QUEUE_NAME, {
    connection: { url: REDIS_URL },
  });
} else {
  // Best-effort compatibility bootstrap for BullMQ v5.
  const schedulerCompatQueue = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
  _queueSchedulerRef = schedulerCompatQueue as any;
  nLog("[BULLMQ] QueueScheduler not exported by this BullMQ version; using Worker stalled recovery.");
}

// BullMQ worker
const worker = new Worker(
  JOB_QUEUE_NAME,
  async (job: Job) => {
    const payload = job.data as AnyJobPayload;
    const jobId = (payload as any).jobId;
    const userId = String((payload as any)?.userId || "").trim();
    let fairSlotAcquired = false;

    logger.info("JOB_START", jobLogContext(job, {
      event: "JOB_START",
      stage: "worker_dispatch",
    }));

    const existingJob = await getJob(jobId);
    const existingStatus = String((existingJob as any)?.status || "").toLowerCase();
    if (existingStatus === "awaiting_payment") {
      nLog("[WORKER] Skipping awaiting_payment job execution", {
        jobId,
        status: existingStatus,
      });
      return;
    }
    if (existingStatus === "failed" || existingStatus === "complete" || existingStatus === "completed") {
      nLog("[WORKER] Skipping terminal job execution", {
        jobId,
        status: existingStatus,
      });
      return;
    }

    try {
      if (FAIR_SCHEDULER_ENABLED && userId) {
        const fairDecision = await evaluateFairShare(userId);
        nLog(
          `[FAIR-SCHEDULER] userId=${userId} activeUsers=${fairDecision.activeUsers} maxJobsPerUser=${fairDecision.maxJobsPerUser} userActiveJobs=${fairDecision.userActiveJobs}`
        );

        if (!fairDecision.canStart) {
          logJobErrorAndThrow(payload, "fair-share-limit", {
            stage: "worker_dispatch",
          });
        }

        await markJobStarted(userId);
        fairSlotAcquired = true;
      }

      beginBatchForensicForJob(payload as any);

      await safeWriteJobStatus(jobId, { status: "processing" }, "job_start");

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
            logJobErrorAndThrow(regionPayload, "Missing base image URL for region-edit job", {
              stage: "region-edit",
            });
          }

          nLog("[worker-region-edit] Downloading base from:", baseImageUrl);
          const basePath = await downloadToTemp(baseImageUrl, regionPayload.jobId + "-base");
          nLog("[worker-region-edit] Downloaded to:", basePath);

          // ✅ FIX: Get mask from payload (it's a base64 string)
          const maskBase64 = regionAny.mask;
          if (!maskBase64) {
            nLog("[worker-region-edit] No mask data in payload");
            logJobErrorAndThrow(regionPayload, "Missing mask data for region-edit job", {
              stage: "region-edit",
            });
          }

          // Convert mask base64 to Buffer
          let maskBuf: Buffer;
          try {
            const normalizedMask = normalizeMaskBase64(maskBase64);
            maskBuf = await normalizeMaskBufferToPng(normalizedMask);
          } catch (maskErr: any) {
            nLog("[worker-region-edit] Mask decode failed:", maskErr?.message || String(maskErr));
            logJobErrorAndThrow(regionPayload, "Invalid mask data for region-edit job", {
              stage: "region-edit",
            });
          }
          nLog("[worker-region-edit] Mask buffer size:", maskBuf.length);

          // Get the instruction/prompt
          const prompt = regionAny.prompt || regionAny.instruction || "";

          // Normalize mode to capitalized form ("add" -> "Add", "remove" -> "Remove", etc.)
          const rawMode = regionAny.mode || "replace";
          const mode = rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase();

          nLog("[worker-region-edit] Calling applyEdit with mode:", mode);

          const openingProtectedPromptSuffix =
            "Additional constraint:\nDo not modify windows, doors, or architectural openings.";

          // Download restore source if provided (for pixel-level restoration)
          let restoreFromPath: string | undefined;
          if (mode === "Restore" && regionAny.restoreFromUrl) {
            nLog("[worker-region-edit] Downloading restore source from:", regionAny.restoreFromUrl);
            restoreFromPath = await downloadToTemp(regionAny.restoreFromUrl, regionPayload.jobId + "-restore");
            nLog("[worker-region-edit] Restore source downloaded to:", restoreFromPath);
          }

          let stage1AReferencePath: string | undefined;
          if (regionAny.stage1AReferenceUrl) {
            try {
              const sourceJobId = String(regionAny.sourceJobId || "").trim();
              const requestedRef = normalizeWorkerUrl(String(regionAny.stage1AReferenceUrl || ""));
              let lineageVerified = false;

              if (sourceJobId) {
                const sourceJob = await getJob(sourceJobId);
                const sourceImageId = String((sourceJob as any)?.imageId || "").trim();
                const currentImageId = String(regionPayload.imageId || "").trim();
                const resolvedStage1A = normalizeWorkerUrl(resolveStage1AFromWorkerJob(sourceJob as any) || "");

                lineageVerified =
                  !!sourceJob &&
                  !!sourceImageId &&
                  !!currentImageId &&
                  sourceImageId === currentImageId &&
                  !!resolvedStage1A &&
                  resolvedStage1A === requestedRef;

                if (!lineageVerified) {
                  nLog("[worker-region-edit] Stage-1A lineage verification failed; ignoring reference", {
                    jobId: regionPayload.jobId,
                    sourceJobId,
                    sourceImageId,
                    currentImageId,
                    requestedRef,
                    resolvedStage1A,
                  });
                }
              } else {
                nLog("[worker-region-edit] Missing sourceJobId; ignoring Stage-1A reference for lineage safety", {
                  jobId: regionPayload.jobId,
                });
              }

              if (lineageVerified) {
                nLog("[worker-region-edit] Downloading Stage-1A reference from:", regionAny.stage1AReferenceUrl);
                stage1AReferencePath = await downloadToTemp(regionAny.stage1AReferenceUrl, regionPayload.jobId + "-stage1a-ref");
                nLog("[worker-region-edit] Stage-1A reference downloaded to:", stage1AReferencePath);
              }
            } catch (stage1AErr) {
              nLog("[worker-region-edit] Failed to download Stage-1A reference (non-blocking):", (stage1AErr as any)?.message || stage1AErr);
            }
          }

          let outPath: string;
          let openingsValidationSummary: any = null;
          let openingsValidationRequiredForPublish = false;
          let openingsValidationPassedForPublish = mode === "Restore";

          if (mode === "Restore") {
            // Restore mode intentionally remains pixel restoration with no model retry loop.
            outPath = await applyEdit({
              baseImagePath: basePath,
              mask: maskBuf,
              mode: mode as any,
              instruction: prompt,
              restoreFromPath: restoreFromPath || basePath,
              stage1AReferencePath,
            });
          } else {
            const lowerMode = String(rawMode || "").toLowerCase();
            const isAddMode = lowerMode === "add";
            const isReplaceMode = lowerMode === "replace";
            const isRemoveMode = lowerMode === "remove";
            const runEditOpeningsValidation = isAddMode || isReplaceMode || isRemoveMode;
            openingsValidationRequiredForPublish = isAddMode || isReplaceMode;
            let attempt = 1;
            const maxAttempts = 2;
            let lastSummary: any = null;

            while (true) {
              const attemptInstruction =
                attempt === 1
                  ? prompt
                  : `${prompt}\n\n${openingProtectedPromptSuffix}`;

              outPath = await applyEdit({
                baseImagePath: basePath,
                mask: maskBuf,
                mode: mode as any,
                instruction: attemptInstruction,
                restoreFromPath: restoreFromPath || basePath,
                stage1AReferencePath,
              });

              const outsideMaskChangedPct = await computeOutsideMaskChangedPct({
                baseImagePath: basePath,
                editedImagePath: outPath,
                mask: maskBuf,
              });
              const outsideMaskLeakSeverity = classifyOutsideLeakPct(outsideMaskChangedPct);

              let openingFail = false;
              if (runEditOpeningsValidation) {
                const comparedAgainst = isRemoveMode ? "stage1a" : "edit_input";
                const validationBaselinePath = isRemoveMode ? stage1AReferencePath : basePath;

                if (!validationBaselinePath) {
                  logJobErrorAndThrow(regionPayload, "region_edit_openings_validation_failed: stage1a_reference_missing_for_remove_mode", {
                    stage: "region-edit",
                  });
                }

                const openingsValidation = await runEditOpeningsValidator(
                  validationBaselinePath,
                  outPath,
                  maskBuf,
                  comparedAgainst,
                );
                openingsValidationSummary = {
                  ...openingsValidation,
                  mode,
                };
                openingFail = openingsValidation.passed !== true;
                if (!openingFail && openingsValidationRequiredForPublish) {
                  openingsValidationPassedForPublish = true;
                }
              } else {
                openingsValidationSummary = {
                  validator: "edit_openings",
                  passed: true,
                  comparedAgainst: "stage1a",
                  reason: "validator_not_required_for_mode",
                  mode,
                };
              }

              lastSummary = openingsValidationSummary;

              regionEditRolloutTelemetry.total += 1;
              if (openingFail) {
                regionEditRolloutTelemetry.openingsFail += 1;
              } else {
                regionEditRolloutTelemetry.openingsPass += 1;
              }

              nLog("[region-edit-telemetry] sample", {
                jobId: regionPayload.jobId,
                attempt,
                mode,
                outsideMaskChangedPct,
                outsideMaskLeakSeverity,
                openingFail,
                openingSummary: openingsValidationSummary,
                totals: {
                  total: regionEditRolloutTelemetry.total,
                  pass: regionEditRolloutTelemetry.openingsPass,
                  fail: regionEditRolloutTelemetry.openingsFail,
                  retryRate:
                    regionEditRolloutTelemetry.total > 0
                      ? Number(((regionEditRolloutTelemetry.retries / regionEditRolloutTelemetry.total) * 100).toFixed(2))
                      : 0,
                  passRate:
                    regionEditRolloutTelemetry.total > 0
                      ? Number(((regionEditRolloutTelemetry.openingsPass / regionEditRolloutTelemetry.total) * 100).toFixed(2))
                      : 0,
                },
              });

              if (!openingFail) {
                break;
              }

              if (attempt >= maxAttempts) {
                let failedReviewUrl: string | null = null;
                let failedMaskUrl: string | null = null;
                try {
                  const failedPub = await publishImage(outPath);
                  failedReviewUrl = failedPub.url || null;
                } catch (publishErr) {
                  nLog("[worker-region-edit] Failed to publish failed attempt image (non-blocking):", (publishErr as any)?.message || publishErr);
                }
                try {
                  const failedMaskPath = `/tmp/${regionPayload.jobId}-mask-failed.png`;
                  await sharp(maskBuf).toFile(failedMaskPath);
                  const failedMaskPub = await publishImage(failedMaskPath);
                  failedMaskUrl = failedMaskPub.url || null;
                } catch (maskPublishErr) {
                  nLog("[worker-region-edit] Failed to publish failed attempt mask (non-blocking):", (maskPublishErr as any)?.message || maskPublishErr);
                }

                const regionEditErr: any = new Error(
                  `region_edit_openings_validation_failed: reason=${String(openingsValidationSummary?.reason || "unknown")}`
                );
                regionEditErr.regionEditReview = {
                  resultUrl: failedReviewUrl,
                  imageUrl: failedReviewUrl,
                  finalOutputUrl: failedReviewUrl,
                  reviewUrl: failedReviewUrl,
                  maskUrl: failedMaskUrl,
                  openingSummary: openingsValidationSummary,
                  attempt,
                };
                throw regionEditErr;
              }

              regionEditRolloutTelemetry.retries += 1;
              nLog("[worker-region-edit] Openings validation failed, retrying with reinforced prompt", {
                jobId: regionPayload.jobId,
                attempt,
                nextAttempt: attempt + 1,
              });
              attempt += 1;
            }

            openingsValidationSummary = openingsValidationSummary || lastSummary;
            if (openingsValidationRequiredForPublish) {
              openingsValidationPassedForPublish = openingsValidationSummary?.passed === true;
            }
          }

          if (openingsValidationRequiredForPublish && !openingsValidationPassedForPublish) {
            logJobErrorAndThrow(regionPayload, "region_edit_publish_blocked: openings_validation_not_passed", {
              stage: "region-edit",
            });
          }

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

          // Also record in enhanced_images gallery history (non-blocking)
          if ((regionPayload as any).agencyId && pub.url) {
            const extractKey = (url?: string | null) => {
              if (!url) return null;
              try {
                const u = new URL(url);
                return u.pathname.startsWith('/') ? u.pathname.slice(1) : u.pathname;
              } catch {
                return null;
              }
            };
            const auditRef = generateAuditRef();
            const traceId = generateTraceId(regionPayload.jobId);
            const originalKey = extractKey(baseImageUrl || null);
            const enhancedKey = extractKey(pub.url || null);
            recordEnhancedImageHistory({
              agencyId: (regionPayload as any).agencyId,
              userId: regionPayload.userId,
              jobId: regionPayload.jobId,
              propertyId: (regionPayload as any).propertyId || null,
              parentImageId: (regionPayload as any).sourceImageId || null,
              source: 'region-edit',
              stagesCompleted: ["edit"],
              publicUrl: pub.url,
              thumbnailUrl: pub.url,
              originalUrl: baseImageUrl || null,
              originalS3Key: originalKey,
              enhancedS3Key: enhancedKey,
              thumbS3Key: enhancedKey,
              auditRef,
              traceId,
            }).catch((err) => {
              nLog(`[enhanced-images] Failed to record region-edit image: ${err}`);
            });
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
              finalOutputUrl: pub.url,
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
                openingsValidation: openingsValidationSummary,
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
        logJobErrorAndThrow(payload, "Job payload missing 'type' property or is not an object", {
          stage: "worker_dispatch",
        });
      }
    } catch (err: any) {
      if (FAIR_SCHEDULER_ENABLED && (err as any)?.message === "fair-share-limit") {
        nLog("[FAIR-SCHEDULER] delaying job due to per-user share", {
          jobId,
          userId,
          delayMs: 2000,
        });
        await job.moveToDelayed(Date.now() + 2000);
        return;
      }

      nLog("[worker] job failed", err);
      logger.error("JOB_ERROR", jobLogContext(payload, {
        event: "JOB_ERROR",
        stage: "worker_dispatch",
        reason: err?.message || "unhandled worker error",
      }));

      // Do not downgrade a job that already reached terminal completion.
      // This protects successful Stage 1A/1B outcomes from late non-critical errors.
      try {
        const latest = jobId ? await getJob(jobId) : null;
        const latestStatus = String((latest as any)?.status || "").toLowerCase();
        if (latestStatus === "complete" || latestStatus === "completed") {
          nLog("[worker] ignoring late error after completion", {
            jobId,
            status: latestStatus,
            error: err?.message || String(err),
          });
          return;
        }
      } catch (statusErr) {
        nLog("[worker] failed to read latest job status in catch (continuing fail path)", {
          jobId,
          error: (statusErr as any)?.message || String(statusErr),
        });
      }
      
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
      
      const regionEditReview = (err as any)?.regionEditReview as
        | {
            resultUrl?: string | null;
            imageUrl?: string | null;
            finalOutputUrl?: string | null;
            reviewUrl?: string | null;
            maskUrl?: string | null;
            openingSummary?: any;
            attempt?: number;
          }
        | undefined;

      const failedStatusPayload: any = {
        status: "failed",
        errorMessage: err?.message || "unhandled worker error",
      };

      if (regionEditReview) {
        if (regionEditReview.resultUrl) {
          failedStatusPayload.resultUrl = regionEditReview.resultUrl;
          failedStatusPayload.imageUrl = regionEditReview.imageUrl || regionEditReview.resultUrl;
          failedStatusPayload.finalOutputUrl = regionEditReview.finalOutputUrl || regionEditReview.resultUrl;
          failedStatusPayload.reviewUrl = regionEditReview.reviewUrl || regionEditReview.resultUrl;
        }
        if (regionEditReview.maskUrl) {
          failedStatusPayload.maskUrl = regionEditReview.maskUrl;
        }
        failedStatusPayload.meta = {
          type: "region-edit",
          failedReview: true,
          attempt: regionEditReview.attempt,
          openingsValidation: regionEditReview.openingSummary,
        };
      }

      await safeWriteJobStatus(jobId, failedStatusPayload, "worker_error");
      throw err;
    } finally {
      if (fairSlotAcquired && userId) {
        try {
          await markJobFinished(userId);
        } catch (fairErr) {
          nLog("[FAIR-SCHEDULER] failed to release active slot (non-blocking)", {
            jobId,
            userId,
            error: (fairErr as any)?.message || String(fairErr),
          });
        }
      }

      try {
        if (jobId) {
          await finalizeBatchForensicForJob(jobId, payload as any);
        }
      } catch (forensicErr) {
        nLog("[BATCH_FORENSIC] finalize failed (non-blocking)", {
          jobId,
          error: (forensicErr as any)?.message || String(forensicErr),
        });
      }

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
    logEvent("SYSTEM_START", { phase: "ready" });
  } catch (e) {
    logEvent("SYSTEM_ERROR", { phase: "ready", error: (e as any)?.message || String(e) });
    nLog("[worker] failed to initialize", e);
  }
})();

worker.on("error", (err) => {
  logEvent("SYSTEM_ERROR", { phase: "worker_event", error: (err as any)?.message || String(err) });
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
  const failedJobId = String(job?.id || "").trim();
  if (!failedJobId) return;
  void (async () => {
    try {
      await finalizeReservationFromWorker({
        jobId: failedJobId,
        stage12Success: false,
        stage2Success: false,
      });
      nLog(`[BILLING] Failed-event reservation release attempted for ${failedJobId}`);
    } catch (releaseErr) {
      nLog("[BILLING] Failed-event reservation release failed (non-blocking):", (releaseErr as any)?.message || releaseErr);
    }
  })();
});
