/**
 * Unified Structural Validation Pipeline for RealEnhance v2.0
 *
 * This module provides a single entry point for all structural validation,
 * aggregating results from multiple validators into a unified verdict.
 *
 * Design:
 * - Runs selected structural validators (window, wall, edge, line detection)
 * - Skips cosmetic validators (brightness, size, landcover)
 * - Aggregates results into pass/fail + score
 * - Operates in log-only mode by default (never blocks images)
 * - Easy to enable blocking later with one-line change
 */

import { validateWindows } from "./windowValidator";
import { validateWallStructure } from "./wallValidator";
import { runGlobalEdgeMetrics, runGlobalEdgeMetricsFromBuffers } from "./globalStructuralValidator";
import { validateStage2Structural } from "./stage2StructuralValidator";
import { validateLineStructure } from "./lineEdgeValidator";
import { runPerceptualDiff } from "./perceptualDiff";
import { loadOrComputeStructuralMask } from "./structuralMask";
import { getGeminiValidatorMode, getLocalValidatorMode } from "./validationModes";
import { vLog, nLog } from "../logger";
import { loadStageAwareConfig, ValidationSummary } from "./stageAwareConfig";
import { STAGE1B_OPENING_DELTA_TOLERANCE } from "./stageAwareConfig";
import { validateStructureStageAware } from "./structural/stageAwareValidator";
import { runGeminiSemanticValidator } from "./geminiSemanticValidator";
import type { GeminiSemanticVerdict } from "./geminiSemanticValidator";
import type { Stage1BValidationMode } from "./geminiSemanticValidator";
import { buildValidationBuffers, type ValidationBuffers } from "./validationBuffers";
import { runAnchorRegionValidators } from "./anchorRegionValidators";
import { createEmptyEvidence, classifyRisk, type ValidationEvidence, type RiskLevel, type RiskClassification } from "./validationEvidence";
import type { Stage2ValidationMode } from "./stage2ValidationMode";
import { classifyIssueTier, ISSUE_TYPES, splitIssueTokens, type ValidationIssueTier, type ValidationIssueType } from "./issueTypes";
import {
  LOCAL_VALIDATOR_TIER,
  LocalValidatorTier,
  STRUCTURAL_SIGNALS_ACTIVE,
  STRUCTURAL_SIGNALS_MODE,
  STAGE2_ENABLE_SPECIALIST_ADVISORY,
} from "../config";

// Re-export the normalized adapter for downstream consumers
export { normalizeValidatorResult, type NormalizedValidatorResult, type NormalizedCheck } from "./normalizedResult";

/**
 * Result from a single validator
 */
export type ValidatorResult = {
  name: string;
  passed: boolean;
  score?: number;        // 0.0-1.0 if available
  message?: string;
  details?: any;
};

/**
 * Unified validation result
 */
export type UnifiedValidationResult = {
  passed: boolean;
  hardFail: boolean;         // true only when enforcement or Gemini block the image
  blockSource?: "local" | "gemini" | null; // where the hard fail originated
  score: number;             // aggregate structural score 0–1
  reasons: string[];         // human-readable hard-fail reasons
  warnings: string[];        // non-fatal warnings
  normalized?: boolean;      // whether dimensions were normalized
  raw: Record<string, ValidatorResult>;  // per-validator raw results
  profile?: "SOFT" | "STRICT";  // Geometry profile used
  evidence?: ValidationEvidence;  // Full evidence packet for downstream consumers
  riskLevel?: RiskLevel;     // Deterministic risk classification
  riskTriggers?: string[];   // Risk trigger reasons
  modelUsed?: string;        // Which Gemini model was used
  /** true when cheap gate (SSIM) failed and heuristic validators were skipped */
  earlyExit?: boolean;
  /** true when Gemini escalation was triggered */
  escalated?: boolean;
  /** Ordered list of validators that executed (e.g. ["perceptualDiff","gemini"]) */
  validatorPath?: string[];
  /** Canonical issue type for the aggregate unified decision */
  issueType?: ValidationIssueType;
  /** Canonical issue tier for the aggregate unified decision */
  issueTier?: ValidationIssueTier;
  /** Per-claim adjudication results from structural signal investigation (Step 2). */
  adjudicatedClaims?: import("./structuralSignal").AdjudicatedClaim[];
};

export function summarizeGeminiSemantic(verdict: GeminiSemanticVerdict) {
  const category = verdict.category || "unknown";
  const reasonsList = (verdict.reasons && verdict.reasons.length ? verdict.reasons : [category]).map(String);

  const hard = verdict.hardFail && (category === "structure" || category === "opening_blocked");

  const summary = {
    category,
    hardFail: hard,
    passed: !hard,
    reasons: hard ? [`Gemini ${category}: ${reasonsList.join(", ")}`] : [],
    warnings: hard ? [] : reasonsList,
    message: hard
      ? `Gemini flagged ${category}`
      : `Gemini warning: ${category}`,
  };

  return summary;
}

function inferUnifiedIssueType(params: {
  hardFail: boolean;
  geminiVerdict?: GeminiSemanticVerdict | null;
  reasons: string[];
}): ValidationIssueType {
  if (!params.hardFail) return ISSUE_TYPES.NONE;

  const verdict = params.geminiVerdict;
  const combinedReasons = Array.isArray(params.reasons) ? params.reasons.join("|") : "";
  const tokens = splitIssueTokens(combinedReasons);
  const has = (prefix: string): boolean =>
    tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));
  const hasAny = (values: string[]): boolean => values.some((value) => has(value));
  const hasMajorResizeSignal =
    has("opening_size_reduction_ge") ||
    has("opening_resized_major") ||
    has("opening_resize_ge_0_30");
  const hasMinorResizeSignal =
    has("opening_resized_minor") ||
    has("opening_resized") ||
    (
      hasAny(["window", "opening", "door", "resize", "resized", "smaller", "reduced", "narrower"]) &&
      hasAny(["slight", "slightly", "minor", "small"])
    );

  if (verdict?.openingRemoved === true || has("opening_removed")) return ISSUE_TYPES.OPENING_REMOVED;
  if (verdict?.openingInfilled === true || has("opening_infilled") || has("opening_sealed")) return ISSUE_TYPES.OPENING_INFILLED;
  if (verdict?.openingRelocated === true || has("opening_relocated")) return ISSUE_TYPES.OPENING_RELOCATED;
  if (hasMajorResizeSignal) return ISSUE_TYPES.OPENING_RESIZED_MAJOR;
  if (hasMinorResizeSignal) return ISSUE_TYPES.OPENING_RESIZED_MINOR;

  if (verdict?.violationType === "opening_change") return ISSUE_TYPES.OPENING_REMOVED;
  if (verdict?.violationType === "wall_change") return ISSUE_TYPES.WALL_CHANGED;
  if (verdict?.violationType === "camera_shift") return ISSUE_TYPES.ROOM_ENVELOPE_CHANGED;
  if (
    verdict?.violationType === "fixture_change" ||
    verdict?.violationType === "ceiling_fixture_change" ||
    verdict?.violationType === "plumbing_change" ||
    verdict?.violationType === "faucet_change"
  ) {
    return ISSUE_TYPES.FIXTURE_CHANGED;
  }

  if (verdict?.category === "opening_blocked") return ISSUE_TYPES.OPENING_REMOVED;
  if (verdict?.category === "structure") return ISSUE_TYPES.ROOM_ENVELOPE_CHANGED;

  if (has("wall") || has("room_envelope_changed")) return ISSUE_TYPES.WALL_CHANGED;
  if (has("fixture") || has("ceiling") || has("light") || has("faucet") || has("plumbing")) return ISSUE_TYPES.FIXTURE_CHANGED;
  if (has("floor")) return ISSUE_TYPES.FLOOR_CHANGED;
  if (has("opening")) return ISSUE_TYPES.OPENING_ANOMALY;

  return ISSUE_TYPES.ROOM_ENVELOPE_CHANGED;
}

type GeminiPassFail = "pass" | "fail";

type GeminiValidatorResults = {
  v1: GeminiPassFail;
  v2?: GeminiPassFail;
  v3?: GeminiPassFail;
};

type GeminiConsensusResult = {
  verdict: GeminiSemanticVerdict;
  validatorResults: GeminiValidatorResults;
  consensusEnabled: boolean;
  derivedWarnings: number;
  flashVerdict: GeminiSemanticVerdict;
  proVerdict?: GeminiSemanticVerdict;
  flashConfidence: number;
  proConfidence?: number;
  fallbackToFlash: boolean;
  finalModelUsed: string;
};

const PRIMARY_VALIDATOR_MODEL = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const ESCALATION_VALIDATOR_MODEL = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const FLASH_ACCEPT_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_FLASH_ACCEPT_CONFIDENCE || 0.7);
const PRO_MIN_CONFIDENCE = Number(process.env.GEMINI_VALIDATOR_PRO_MIN_CONFIDENCE || 0.7);

function toGeminiPassFail(verdict: GeminiSemanticVerdict): GeminiPassFail {
  return verdict.hardFail ? "fail" : "pass";
}

async function runGeminiWithConsensus(
  input: Parameters<typeof runGeminiSemanticValidator>[0],
  derivedWarnings: number
): Promise<GeminiConsensusResult> {
  const effectiveDerivedWarnings = Number.isFinite(derivedWarnings)
    ? Math.max(0, Math.floor(derivedWarnings))
    : 0;
  const resultA = await runGeminiSemanticValidator({
    ...input,
    modelOverride: PRIMARY_VALIDATOR_MODEL,
  });
  const validatorResults: GeminiValidatorResults = {
    v1: toGeminiPassFail(resultA),
  };

  const validatorConfidence = Number.isFinite(resultA.confidence) ? resultA.confidence : 0;
  const consensusEnabled = validatorConfidence < FLASH_ACCEPT_CONFIDENCE;
  if (!consensusEnabled) {
    return {
      verdict: resultA,
      validatorResults,
      consensusEnabled,
      derivedWarnings: effectiveDerivedWarnings,
      flashVerdict: resultA,
      flashConfidence: validatorConfidence,
      fallbackToFlash: false,
      finalModelUsed: PRIMARY_VALIDATOR_MODEL,
    };
  }

  let resultB: GeminiSemanticVerdict;
  try {
    resultB = await runGeminiSemanticValidator({
      ...input,
      modelOverride: ESCALATION_VALIDATOR_MODEL,
    });
  } catch (err) {
    console.warn("[unified-validator] Gemini Pro escalation failed; falling back to primary Flash verdict", err);
    return {
      verdict: resultA,
      validatorResults,
      consensusEnabled,
      derivedWarnings: effectiveDerivedWarnings,
      flashVerdict: resultA,
      flashConfidence: validatorConfidence,
      fallbackToFlash: true,
      finalModelUsed: PRIMARY_VALIDATOR_MODEL,
    };
  }

  validatorResults.v2 = toGeminiPassFail(resultB);
  const proConfidence = Number.isFinite(resultB.confidence) ? resultB.confidence : 0;
  if (proConfidence < PRO_MIN_CONFIDENCE) {
    return {
      verdict: resultA,
      validatorResults,
      consensusEnabled,
      derivedWarnings: effectiveDerivedWarnings,
      flashVerdict: resultA,
      proVerdict: resultB,
      flashConfidence: validatorConfidence,
      proConfidence,
      fallbackToFlash: true,
      finalModelUsed: PRIMARY_VALIDATOR_MODEL,
    };
  }

  return {
    // Escalation verdict is authoritative unless Pro is low-confidence.
    verdict: resultB,
    validatorResults,
    consensusEnabled,
    derivedWarnings: effectiveDerivedWarnings,
    flashVerdict: resultA,
    proVerdict: resultB,
    flashConfidence: validatorConfidence,
    proConfidence,
    fallbackToFlash: false,
    finalModelUsed: ESCALATION_VALIDATOR_MODEL,
  };
}

function normalizeStagingStyleToken(style?: string): string {
  if (!style) return "nz_standard";

  const s = style.trim().toLowerCase();
  if (["nz_standard", "standard_listing", "standard", "default"].includes(s)) {
    return "nz_standard";
  }

  return s;
}

/**
 * Evidence injection gate - only inject evidence when thresholds indicate HIGH structural risk.
 * 
 * Purpose: Prevent noisy MEDIUM risk signals from biasing Gemini adjudicator.
 * Only inject evidence when structural violations are clear and severe.
 * 
 * HIGH risk triggers:
 * - Opening count changed (windows or doors delta >= 1)
 * - Any anchor flag true (island/HVAC/cabinetry/lighting changed)
 * - Extreme drift: wall > 35%, masked edge > 55%, angle > 25°
 */
export function shouldInjectEvidence(evidence?: ValidationEvidence): boolean {
  if (!evidence) return false;

  const isStage1B = evidence.stage === "1B";

  // Opening delta check
  const openingsDelta = evidence.openings
    ? Math.abs(evidence.openings.windowsAfter - evidence.openings.windowsBefore) +
      Math.abs(evidence.openings.doorsAfter - evidence.openings.doorsBefore)
    : 0;
  if (isStage1B ? openingsDelta > STAGE1B_OPENING_DELTA_TOLERANCE : openingsDelta !== 0) return true;

  // Anchor checks - any true is HIGH risk
  if (evidence.anchorChecks && Object.values(evidence.anchorChecks).some((v) => v === true)) {
    return true;
  }

  // Extreme drift thresholds (aligned with PATCH 5 MEDIUM thresholds)
  if ((evidence.drift?.wallPercent ?? 0) > 35) return true;
  if ((evidence.drift?.maskedEdgePercent ?? 0) > 55) return true;
  if ((evidence.drift?.angleDegrees ?? 0) > 25) return true;

  return false;
}

/**
 * Parameters for unified validation
 */
export interface UnifiedValidationParams {
  /**
   * Authoritative validation baseline path.
   * This must be the exact input image used to generate `enhancedPath`.
   */
  originalPath: string;
  enhancedPath: string;
  stage: "1A" | "1B" | "2";
  sceneType?: "interior" | "exterior";
  roomType?: string;
  mode?: "log" | "enforce";
  jobId?: string;
  imageId?: string;
  stagingStyle?: string;  // Staging style used (for safety coupling)
  /**
   * Legacy audit field only. Validation baseline is always `originalPath`.
   */
  stage1APath?: string;
  sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
  topologyResult?: "PASS" | "FAIL";
  validationMode?: Stage2ValidationMode;
  stage1BValidationMode?: Stage1BValidationMode;
  baseArtifacts?: import("./baseArtifacts").BaseArtifacts;
  /**
   * Gemini invocation policy:
   * - "always" (default): run Gemini semantic validator every time
   * - "on_local_fail": run Gemini only when any local validator fails
   * - "never": skip Gemini semantic validator entirely
   */
  geminiPolicy?: "always" | "on_local_fail" | "never";
  /** Stage2 specialist (Gemini-based) advisory signals for non-binding prompt awareness */
  specialistAdvisorySignals?: string[];
  /** Structured spatial observations from specialists for Investigation Task prompting */
  specialistAdvisoryObservations?: AdvisoryObservation[];
  /** Deduplicated structural signals for per-claim Gemini adjudication (Step 2). */
  structuralSignals?: import("./structuralSignal").StructuralSignal[];
}

/**
 * Structured advisory observation from a specialist validator.
 * Carries spatial context (bbox, location) and a targeted investigation task
 * for the Unified Validator to verify visually.
 */
export type AdvisoryObservation = {
  validator: "openings" | "fixtures" | "floor" | "envelope";
  issueType: string;
  approximateLocation?: "left" | "center-left" | "center" | "center-right" | "right" | "rear";
  bbox?: [number, number, number, number];
  confidence: number;
  investigationTask: string;
};

function buildSpatialInvestigationBlock(observations: AdvisoryObservation[]): string[] {
  if (!Array.isArray(observations) || observations.length === 0) return [];

  return observations
    .filter((obs) => obs && obs.investigationTask)
    .slice(0, 6)
    .map((obs) => {
      const loc = obs.approximateLocation
        ? `[${obs.approximateLocation.toUpperCase()}]`
        : "[UNKNOWN]";
      const conf = Number.isFinite(obs.confidence) ? obs.confidence.toFixed(2) : "n/a";
      return `${loc} ${obs.validator} specialist detected ${obs.issueType} (conf=${conf}). Task: ${obs.investigationTask}`;
    });
}

function buildSpecialistObservationHints(signals?: string[]): string[] {
  if (!Array.isArray(signals) || signals.length === 0) return [];

  const hints = new Set<string>();

  for (const raw of signals) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value) continue;

    const domain = value.includes(":") ? value.split(":", 1)[0] : "";
    const normalized = value
      .replace(/[0-9]+(\.[0-9]+)?/g, "")
      .replace(/[_|:]+/g, " ")
      .replace(/\b(confidence|hardfail|hard fail|fail|failed|error|invalid|retry|threshold|score|status)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (domain === "fixtures" || /fixture|ceiling|light|pendant|downlight/.test(normalized)) {
      hints.add("There may be a change in fixed ceiling fixtures worth a closer look.");
      continue;
    }

    if (domain === "openings" || /opening|window|door|aperture/.test(normalized)) {
      hints.add("There may be a change around architectural openings worth a closer look.");
      continue;
    }

    if (domain === "floor" || /floor|surface|plane/.test(normalized)) {
      hints.add("There may be a subtle change around floor surfaces worth a closer look.");
      continue;
    }

    if (domain === "envelope" || /envelope|wall|boundary|layout/.test(normalized)) {
      hints.add("There may be a subtle change around room envelope boundaries worth a closer look.");
      continue;
    }

    hints.add("There may be a subtle structural consistency change worth a closer look.");
  }

  return Array.from(hints).slice(0, 6);
}

/**
 * Soft Geometry Detection Helper
 *
 * Detects bedroom-type scenes with soft geometry that should use relaxed thresholds.
 * Prevents false failures in bedroom/study scenes with fewer structural lines.
 *
 * Scoring criteria (need 2+ to qualify as soft):
 * - Low original line count (< 90)
 * - Low enhanced line count (< 120)
 * - Bedroom-type room (bedroom, study, nursery)
 * - Single window (typical bedroom)
 */
function isSoftGeometryScene(meta: {
  roomType?: string;
  originalLineCount?: number;
  enhancedLineCount?: number;
  windowCount?: number;
}): boolean {
  let score = 0;

  if ((meta.originalLineCount ?? 999) < 90) score++;
  if ((meta.enhancedLineCount ?? 999) < 120) score++;
  if (["bedroom", "study", "nursery"].includes((meta.roomType || "").toLowerCase())) score++;
  if (meta.windowCount === 1) score++;

  return score >= 2;
}

/**
 * Run unified structural validation across multiple validators
 *
 * This is the single entry point for all structural validation.
 * It runs a curated set of structural validators and aggregates their results.
      baseArtifacts,
    } = params;
 * Validators included:
 * - Window validation (window/door obstruction, blocking natural light)
 * - Wall validation (wall geometry, openings)
 * - Global edge IoU (overall geometry consistency)
 * - Structural IoU with mask (Stage 2 only)
 * - Line/edge detection (Hough-based structural deviation)
 *
 * Validators excluded (cosmetic, not structural):
 * - Brightness validator
 * - Size validator
 * - Landcover validator
 *
 * @param params Validation parameters
 * @returns Unified validation result with aggregate score and per-validator details
 */
export async function runUnifiedValidation(
  params: UnifiedValidationParams
): Promise<UnifiedValidationResult> {
  const {
    originalPath,
    enhancedPath,
    stage,
    sceneType = "interior",
    roomType,
    mode = "log",
    jobId,
    imageId,
    stagingStyle,
    stage1APath,
    sourceStage,
    validationMode,
    stage1BValidationMode,
    baseArtifacts,
    geminiPolicy = "always",
    specialistAdvisorySignals,
    specialistAdvisoryObservations,
    structuralSignals,
  } = params;

  if (!String(originalPath || "").trim() || !String(enhancedPath || "").trim()) {
    throw new Error("VALIDATION_INPUT_MISSING");
  }

  const validatorMode = getLocalValidatorMode();
  const localValidatorsFull = LOCAL_VALIDATOR_TIER === LocalValidatorTier.FULL;
  const stageAwareConfig = loadStageAwareConfig();
  const warnings: string[] = [];
  const geminiMode = getGeminiValidatorMode();
  const results: Record<string, ValidatorResult> = {};
  const reasons: string[] = [];
  let geminiVerdict: GeminiSemanticVerdict | null = null;
  let stage2AnchorDirectReasons: string[] = [];
  let stage2AnchorDirectEvents: Array<{ source: "anchor"; confidence: number; reasonCode: string }> = [];
  let stage2LightingAnchorChanged = false;
  const disableIouDecisionSignals = stage === "2" && validationMode === "REFRESH_OR_DIRECT";
  const normalizedStagingStyle = normalizeStagingStyleToken(stagingStyle);

  // VALIDATOR SAFETY TIE-IN: NZ Standard gets strictest protection
  const isNZStandard = normalizedStagingStyle === "nz_standard";

  if (isNZStandard) {
    nLog(`[unified-validator] ✅ NZ STANDARD mode detected - enforcing strict structural protection`);
  }

  nLog(`[unified-validator] === Starting Unified Structural Validation ===`);
  // Structured log for pipeline observability
  console.log(`[validator] start jobId=${jobId ?? "unknown"} stage=${stage}`);
  nLog(`[unified-validator] Stage: ${stage}`);
  nLog(`[unified-validator] Scene: ${sceneType}`);
  nLog(`[unified-validator] Staging Style: ${normalizedStagingStyle || 'nz_standard (default)'}`);
  nLog(`[unified-validator] Modes: local=${validatorMode} gemini=${geminiMode}`);
  nLog(`[unified-validator] Local validator tier: ${LOCAL_VALIDATOR_TIER}`);
  nLog(`[unified-validator] Stage-Aware: ${stageAwareConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
  nLog(`[unified-validator] Original: ${originalPath}`);
  nLog(`[unified-validator] Enhanced: ${enhancedPath}`);
  if (stage1APath) {
    nLog(`[unified-validator] Stage1A Path (audit only): ${stage1APath}`);
  }

  // ===== PERCEPTUAL DIFF (SSIM) TELEMETRY — FIRST STEP =====
  let perceptualFailed = false;
  let forceGemini = false;

  // Initialize evidence packet
  const evidence = createEmptyEvidence(
    jobId || "unknown",
    (stage === "1B" || stage === "2") ? stage : "1B",
    roomType
  );

  if (params.topologyResult) {
    (evidence as any).topologyResult = params.topologyResult;
  }

  if (stage === "1B" || stage === "2") {
    if (!localValidatorsFull) {
      results.perceptualDiff = {
        name: "perceptualDiff",
        passed: true,
        score: 1,
        message: `Perceptual diff skipped (tier=${LOCAL_VALIDATOR_TIER})`,
        details: {
          skipped: true,
          tier: LOCAL_VALIDATOR_TIER,
          score: 1,
          threshold: 0,
        },
      };
      evidence.ssim = 1;
      evidence.ssimThreshold = 0;
      evidence.ssimPassed = true;
      nLog(`[perceptual-diff] skipped (tier=${LOCAL_VALIDATOR_TIER})`);
    } else {
    try {
      const perceptual = await runPerceptualDiff({
        originalPath,
        enhancedPath,
        stage,
      });

      results.perceptualDiff = {
        name: "perceptualDiff",
        passed: perceptual.passed,
        score: perceptual.score,
        message: `SSIM ${perceptual.score.toFixed(3)} (threshold ${perceptual.threshold.toFixed(2)})`,
        details: perceptual,
      };

      nLog(`[perceptual-diff] stage=${stage} ssim=${perceptual.score.toFixed(3)} threshold=${perceptual.threshold.toFixed(2)} passed=${perceptual.passed}`);

      // Populate evidence
      evidence.ssim = perceptual.score;
      evidence.ssimThreshold = perceptual.threshold;
      evidence.ssimPassed = perceptual.passed;

      console.log("[PERCEPTUAL_METRICS]", {
        stage,
        ssim: Number(perceptual.score.toFixed(4)),
        ssimThreshold: Number(perceptual.threshold.toFixed(4)),
        ssimPassed: perceptual.passed,
      });

      if (!perceptual.passed) {
        perceptualFailed = true;
        forceGemini = true;
        evidence.localFlags.push(`ssim_failed: ${perceptual.score.toFixed(3)} < ${perceptual.threshold.toFixed(2)}`);
        nLog(`[perceptual-diff] FAIL → continue full validator chain and escalate to Gemini`);
      }
    } catch (err) {
      console.warn("[perceptual-diff] Error computing SSIM (fail-closed):", err);
      perceptualFailed = true;
      forceGemini = true;
      warnings.push("perceptual_diff_validator_error");
      evidence.localFlags.push("ssim_validator_error");
      results.perceptualDiff = {
        name: "perceptualDiff",
        passed: false,
        score: 0,
        message: "Perceptual diff validator error",
        details: { error: String(err) },
      };
    }
    }
  }

  // ===== EARLY EXIT TRACKING =====
  // Deterministic mode: never skip structural validators based on SSIM.
  const earlyExit = false;
  const validatorPath: string[] = ["perceptualDiff"];
  if (earlyExit) {
    validatorPath.push("gemini");
    nLog(`[validator] early_exit=true path=${validatorPath.join(",")}`);
  }

  // ===== STAGE-AWARE VALIDATION PATH =====
  // When enabled, use the new stage-aware validator for Stage 2.
  if (stageAwareConfig.enabled && stage === "2") {
    nLog(`[unified-validator] Using stage-aware validator for Stage 2`);

    // Validation baseline must always match the exact input image for this candidate.
    const validationBaseline = originalPath;
    if (stage1APath && stage1APath !== originalPath) {
      nLog(`[unified-validator] Ignoring legacy stage1APath for baseline selection; using originalPath instead`);
    }

    try {
      const stageAwareResult = await validateStructureStageAware({
        stage: "stage2",
        baselinePath: validationBaseline,
        candidatePath: enhancedPath,
        mode: mode === "enforce" ? "block" : "log",
        jobId,
        sceneType,
        roomType,
        config: stageAwareConfig,
        baseArtifacts,
      });

      // Convert stage-aware result to UnifiedValidationResult format
      const reasons: string[] = [];
      if (stageAwareResult.risk) {
        stageAwareResult.triggers.forEach(t => {
          reasons.push(`${t.id}: ${t.message}`);
        });
      }

      results.stageAware = {
        name: "stageAware",
        // In log mode we still surface risk as a failure (non-blocking) so Gemini-on-local-fail can trigger
        passed: !stageAwareResult.risk,
        score: stageAwareResult.score,
        message: stageAwareResult.risk
          ? `Risk detected: ${stageAwareResult.triggers.length} triggers`
          : "Stage-aware validation passed",
        details: {
          triggers: stageAwareResult.triggers,
          metrics: stageAwareResult.metrics,
          debug: stageAwareResult.debug,
        },
      };

      if (stageAwareResult.debug?.dimensionNormalized) {
        warnings.push("dimension_normalized");
      }

      nLog(`[unified-validator] Stage-aware result: risk=${stageAwareResult.risk}, score=${stageAwareResult.score.toFixed(3)}`);
      if (stageAwareResult.risk) {
        nLog(`[unified-validator] Triggers (${stageAwareResult.triggers.length}/${stageAwareConfig.gateMinSignals} required):`);
        stageAwareResult.triggers.forEach((t, i) => {
          nLog(`[unified-validator]   ${i + 1}. ${t.id}: ${t.message}`);
        });
      }

      const stageAwareHardFail = mode === "enforce" && stageAwareResult.risk;

      if (stageAwareResult.risk) {
        stageAwareResult.triggers.forEach(t => warnings.push(`${t.id}: ${t.message}`));
        if (stageAwareHardFail) {
          stageAwareResult.triggers.forEach(t => reasons.push(`${t.id}: ${t.message}`));
        }
      }
    } catch (err) {
      nLog(`[unified-validator] Stage-aware validation error: ${err}`);
      // Fall through to legacy validation on error
    }
  }

  let buffers: ValidationBuffers | null = null;
  let windowCount = 0;
  let originalLineCount = 0;
  let enhancedLineCount = 0;
  let stage2OcclusionAllowance: { structIoU: number; threshold: number; reasons: string[] } | null = null;

  // Run heuristic validators for evidence collection.
  {
    try {
      buffers = await buildValidationBuffers(originalPath, enhancedPath, {
        blurSigma: Number(process.env.GLOBAL_EDGE_PREBLUR || 0.8),
        smallSize: 512,
      }, baseArtifacts);
    } catch (err) {
      console.warn("[unified-validator] Failed to build shared buffers, falling back to per-validator Sharp calls", err);
      buffers = null;
    }

    // ===== SOFT GEOMETRY DETECTION =====
    // We'll collect metadata as we run validators, then determine soft/strict mode

    // ===== 1. WINDOW VALIDATION =====
    // Critical for real estate: windows must not be blocked or altered
    if (stage === "1B" || stage === "2") {
      try {
        const windowResult = await validateWindows(
          originalPath,
          enhancedPath,
          buffers ? { baseGray: buffers.baseGray, candGray: buffers.candGray, width: buffers.width, height: buffers.height } : undefined
        );

        // Capture window count for soft geometry detection
        if ((windowResult as any).windowCount !== undefined) {
          windowCount = (windowResult as any).windowCount;
        } else if ((windowResult as any).baseWindowCount !== undefined) {
          windowCount = (windowResult as any).baseWindowCount;
        }

        const passed = windowResult.ok;
        results.windows = {
          name: "windows",
          passed,
          score: passed ? 1.0 : 0.0,
          message: windowResult.reason || (passed ? "Windows preserved" : "Window issues detected"),
          details: { ...windowResult, windowCount },
        };
        if (!passed) {
          reasons.push(`Window validation failed: ${windowResult.reason}`);
        }
      } catch (err) {
        console.warn("[unified-validator] Window validation error (fail-closed):", err);
        results.windows = {
          name: "windows",
          passed: false,
          score: 0,
          message: "Window validator error",
          details: { error: String(err) },
        };
        reasons.push("Window validation error");
      }
    }

    // ===== 2. WALL VALIDATION =====
    // Validates wall structure and openings
    if (localValidatorsFull) {
      try {
        const wallResult = await validateWallStructure(originalPath, enhancedPath);
        const passed = wallResult.ok;
        results.walls = {
          name: "walls",
          passed,
          score: passed ? 1.0 : 0.0,
          message: wallResult.reason || (passed ? "Wall structure preserved" : "Wall structure issues"),
          details: wallResult,
        };
        if (!passed) {
          reasons.push(`Wall validation failed: ${wallResult.reason}`);
        }
      } catch (err) {
        console.warn("[unified-validator] Wall validation error (fail-closed):", err);
        results.walls = {
          name: "walls",
          passed: false,
          score: 0,
          message: "Wall validator error",
          details: { error: String(err) },
        };
        reasons.push("Wall validation error");
      }
    } else {
      results.walls = {
        name: "walls",
        passed: true,
        score: 1,
        message: `Wall validation skipped (tier=${LOCAL_VALIDATOR_TIER})`,
        details: { skipped: true, tier: LOCAL_VALIDATOR_TIER },
      };
      nLog(`[unified-validator] Wall validation skipped (tier=${LOCAL_VALIDATOR_TIER})`);
    }

    // ===== 3. GLOBAL EDGE IoU =====
    // Overall geometry consistency check
    try {
      const edgeIoU = localValidatorsFull
        ? (buffers
            ? runGlobalEdgeMetricsFromBuffers(
                buffers.baseBlur,
                buffers.candBlur,
                buffers.width,
                buffers.height,
                Number(process.env.LOCAL_EDGE_MAG_THRESHOLD || 35)
              ).edgeIoU
            : (await runGlobalEdgeMetrics(originalPath, enhancedPath)).edgeIoU)
        : 1;

      // Thresholds by stage
      const minEdgeIoU = stage === "1A" ? 0.70 : stage === "1B" ? 0.65 : 0.60;
      const passed = disableIouDecisionSignals ? true : edgeIoU >= minEdgeIoU;
      const score = disableIouDecisionSignals ? 1.0 : edgeIoU;
      const message = disableIouDecisionSignals
        ? `Edge IoU telemetry: ${edgeIoU.toFixed(3)} (threshold: ${minEdgeIoU})`
        : `Edge IoU: ${edgeIoU.toFixed(3)} (threshold: ${minEdgeIoU})`;

      results.globalEdge = {
        name: "globalEdge",
        passed,
        score,
        message,
        details: { edgeIoU, minEdgeIoU, skipped: !localValidatorsFull, tier: LOCAL_VALIDATOR_TIER },
      };
      nLog("[IOU_TELEMETRY]", {
        stage,
        metric: "edgeIoU",
        value: edgeIoU,
        threshold: minEdgeIoU,
        decisionInfluence: disableIouDecisionSignals ? "none" : "active",
      });
      if (!passed && !disableIouDecisionSignals) {
        reasons.push(`Global edge IoU too low: ${edgeIoU.toFixed(3)} < ${minEdgeIoU}`);
      }
      if (!localValidatorsFull) {
        nLog(`[unified-validator] Global edge validation skipped (tier=${LOCAL_VALIDATOR_TIER})`);
      }
    } catch (err) {
      if (disableIouDecisionSignals) {
        console.warn("[unified-validator] Global edge validation error (telemetry-only):", err);
        results.globalEdge = {
          name: "globalEdge",
          passed: true,
          score: 1.0,
          message: "Global edge IoU telemetry unavailable",
          details: { error: String(err) },
        };
      } else {
        console.warn("[unified-validator] Global edge validation error (fail-closed):", err);
        results.globalEdge = {
          name: "globalEdge",
          passed: false,
          score: 0,
          message: "Global edge validator error",
          details: { error: String(err) },
        };
        reasons.push("Global edge validation error");
      }
    }

    // ===== 4. STRUCTURAL IoU WITH MASK (Stage 2 only) =====
    // Focused check on architectural elements during staging
    if (stage === "2") {
      try {
        const baseDimTolerance = 8;
        const dimThreshold = Math.round(baseDimTolerance * 1.2);
        const structResult = localValidatorsFull
          ? await (async () => {
              const mask = await loadOrComputeStructuralMask(jobId || "default", originalPath, baseArtifacts);
              return validateStage2Structural(
                originalPath,
                enhancedPath,
                { structuralMask: mask },
                buffers ? { baseGray: buffers.baseGray, candGray: buffers.candGray, width: buffers.width, height: buffers.height } : undefined,
                { dimensionTolerance: dimThreshold }
              );
            })()
          : {
              ok: true,
              structuralIoU: 1,
              structuralIoUSkipReason: `tier_${LOCAL_VALIDATOR_TIER}`,
              reason: `tier_${LOCAL_VALIDATOR_TIER}_skip`,
              debug: undefined,
            } as any;

        const baseStructIoU = 0.30; // Relaxed for staging (allows furniture addition)
        const minStructIoU = baseStructIoU - 0.05;

        nLog("[STAGE2_THRESHOLD_MODE]", {
          lineDriftThreshold: stage === "2" ? 0.70 * 0.75 : 0.70,
          dimThreshold,
          iouThreshold: minStructIoU,
        });

        // CRITICAL FIX: Do NOT default undefined IoU to 0 - handle explicitly
        let passed: boolean;
        let score: number;
        let message: string;

        if (structResult.structuralIoU !== undefined && structResult.structuralIoU !== null) {
          // IoU was computed successfully
          const structIoU = structResult.structuralIoU;
          if (disableIouDecisionSignals) {
            passed = structResult.ok;
            score = structResult.ok ? 1.0 : 0.0;
            message = `Structural IoU telemetry: ${structIoU.toFixed(3)} (threshold: ${minStructIoU})`;
            if (!structResult.ok && structResult.reason) {
              reasons.push(`Reason: ${structResult.reason}`);
            }
          } else {
            passed = structResult.ok && structIoU >= minStructIoU;
            score = structIoU;
            message = `Structural IoU: ${structIoU.toFixed(3)} (threshold: ${minStructIoU})`;

            if (!passed) {
              const iouReason = `Structural IoU too low: ${structIoU.toFixed(3)} < ${minStructIoU}`;
              reasons.push(iouReason);
              if (structResult.reason) {
                reasons.push(`Reason: ${structResult.reason}`);
              }
              if (structIoU >= minStructIoU - 0.05) {
                stage2OcclusionAllowance = {
                  structIoU,
                  threshold: minStructIoU,
                  reasons: [iouReason, ...(structResult.reason ? [`Reason: ${structResult.reason}`] : [])],
                };
              }
            }
          }
          nLog("[IOU_TELEMETRY]", {
            stage,
            metric: "structuralIoU",
            value: structIoU,
            threshold: minStructIoU,
            decisionInfluence: disableIouDecisionSignals ? "none" : "active",
          });
        } else {
          // IoU was skipped - do NOT treat as failure
          const skipReason = structResult.structuralIoUSkipReason || "unknown";
          passed = structResult.ok; // Pass based on semantic checks only
          score = disableIouDecisionSignals ? (structResult.ok ? 1.0 : 0.0) : 0.5;
          message = `Structural IoU skipped: ${skipReason}`;

          nLog(`[unified-validator] Structural IoU computation skipped: ${skipReason}`);
          if (structResult.debug) {
            nLog(`[unified-validator]   - dims: base=${structResult.debug.baseWidth}x${structResult.debug.baseHeight}, cand=${structResult.debug.candWidth}x${structResult.debug.candHeight}`);
            nLog(`[unified-validator]   - maskPixels: ${structResult.debug.maskPixels}`);
            if (structResult.debug.intersectionPixels !== undefined) {
              nLog(`[unified-validator]   - intersection: ${structResult.debug.intersectionPixels}, union: ${structResult.debug.unionPixels}`);
            }
          }
        }

        results.structuralMask = {
          name: "structuralMask",
          passed,
          score,
          message,
          details: {
            structIoU: structResult.structuralIoU,
            structIoUSkipReason: structResult.structuralIoUSkipReason,
            minStructIoU,
            reason: structResult.reason,
            debug: structResult.debug,
            skipped: !localValidatorsFull,
            tier: LOCAL_VALIDATOR_TIER,
          },
        };

        if (!localValidatorsFull) {
          nLog(`[unified-validator] Structural IoU validation skipped (tier=${LOCAL_VALIDATOR_TIER})`);
        }

        if (structResult.debug?.dimensionNormalized) {
          warnings.push("dimension_normalized");
        }
      } catch (err) {
        if (disableIouDecisionSignals) {
          console.warn("[unified-validator] Structural mask validation error (IoU telemetry-only mode):", err);
          results.structuralMask = {
            name: "structuralMask",
            passed: true,
            score: 1.0,
            message: "Structural IoU telemetry unavailable",
            details: { error: String(err) },
          };
        } else {
          console.warn("[unified-validator] Structural mask validation error (fail-closed):", err);
          results.structuralMask = {
            name: "structuralMask",
            passed: false,
            score: 0,
            message: "Structural mask validator error",
            details: { error: String(err) },
          };
          reasons.push("Structural mask validation error");
        }
      }
    }

    // ===== 5. LINE/EDGE DETECTION (Sharp-based Hough) =====
    // Detects line shifts using Hough transform
    try {
      const baseLineSensitivity = 0.70;
      const lineDriftThreshold = stage === "2"
        ? baseLineSensitivity * 0.75
        : baseLineSensitivity;
      const lineResult = localValidatorsFull
        ? await validateLineStructure({
            originalPath,
            enhancedPath,
            sensitivity: lineDriftThreshold, // 70% baseline, looser for Stage 2
            buffers: buffers
              ? {
                  baseSmall: buffers.baseSmall,
                  candSmall: buffers.candSmall,
                  width: buffers.smallWidth,
                  height: buffers.smallHeight,
                }
              : undefined,
          })
        : {
            passed: true,
            score: 1,
            message: `Line/edge validation skipped (tier=${LOCAL_VALIDATOR_TIER})`,
            edgeLoss: 0,
            edgeShift: 0,
            verticalDeviation: 0,
            horizontalDeviation: 0,
            details: { skipped: true, tier: LOCAL_VALIDATOR_TIER },
          };

      // Capture line counts for soft geometry detection
      if (
        lineResult.details &&
        typeof lineResult.details === "object" &&
        "originalEdgeCount" in lineResult.details &&
        typeof (lineResult.details as any).originalEdgeCount === "number"
      ) {
        originalLineCount = (lineResult.details as any).originalEdgeCount;
      }
      if (
        lineResult.details &&
        typeof lineResult.details === "object" &&
        "enhancedEdgeCount" in lineResult.details &&
        typeof (lineResult.details as any).enhancedEdgeCount === "number"
      ) {
        enhancedLineCount = (lineResult.details as any).enhancedEdgeCount;
      }

      results.lineEdge = {
        name: "lineEdge",
        passed: lineResult.passed,
        score: lineResult.score,
        message: lineResult.message,
        details: {
          edgeLoss: lineResult.edgeLoss,
          edgeShift: lineResult.edgeShift,
          verticalDeviation: lineResult.verticalDeviation,
          horizontalDeviation: lineResult.horizontalDeviation,
          ...lineResult.details,
        },
      };
      if (!lineResult.passed) {
        reasons.push(`Line/edge validation failed: score ${lineResult.score.toFixed(3)}`);
      }
      if (!localValidatorsFull) {
        nLog(`[unified-validator] Line/edge validation skipped (tier=${LOCAL_VALIDATOR_TIER})`);
      }
    } catch (err) {
      console.warn("[unified-validator] Line/edge validation error (fail-closed):", err);
      results.lineEdge = {
        name: "lineEdge",
        passed: false,
        score: 0,
        message: "Line/edge validator error",
        details: { error: String(err) },
      };
      reasons.push("Line/edge validation error");
    }
  }

  // Track which heuristic validators were actually executed
  validatorPath.push("structural", "geometry");

  // ===== ANCHOR REGION VALIDATORS =====
  // Binary flag detectors for high-value structural anchors
  // ALWAYS run — these are critical evidence signals
  if (stage === "1B" || stage === "2") {
    try {
      nLog(`[unified-validator] Running anchor region validators...`);
      const anchorResult = await runAnchorRegionValidators({
        originalImagePath: originalPath,
        enhancedImagePath: enhancedPath,
        jobId,
      });

      const normalizedRoomType = String(roomType || "").toLowerCase();
      const isKitchenBaseline = normalizedRoomType === "kitchen";
      const structuralDegree = Number(evidence?.drift?.angleDegrees ?? 0);
      const openingViolationPresent =
        results.windows?.passed === false ||
        results.walls?.passed === false ||
        results.structuralMask?.passed === false;
      const islandCorroborated =
        structuralDegree > 0 ||
        openingViolationPresent;
      const islandChangedForDecision =
        anchorResult.islandChanged &&
        isKitchenBaseline &&
        islandCorroborated;

      // Populate evidence anchor flags
      evidence.anchorChecks = {
        islandChanged: islandChangedForDecision,
        hvacChanged: anchorResult.hvacChanged,
        cabinetryChanged: anchorResult.cabinetryChanged,
        lightingChanged: anchorResult.lightingChanged,
      };

      const stage2AnchorViolation =
        stage === "2" &&
        (islandChangedForDecision || anchorResult.hvacChanged || anchorResult.cabinetryChanged || anchorResult.lightingChanged);

      // Add anchor flags to localFlags for logging
      if (anchorResult.islandChanged) evidence.localFlags.push("anchor:island_changed");
      if (anchorResult.hvacChanged) evidence.localFlags.push("anchor:hvac_changed");
      if (anchorResult.cabinetryChanged) evidence.localFlags.push("anchor:cabinetry_changed");
      if (anchorResult.lightingChanged) evidence.localFlags.push("anchor:lighting_changed");

      results.anchors = {
        name: "anchors",
        passed: stage2AnchorViolation
          ? true
          : (!islandChangedForDecision && !anchorResult.hvacChanged &&
             !anchorResult.cabinetryChanged && !anchorResult.lightingChanged),
        score: stage2AnchorViolation
          ? 1.0
          : ((islandChangedForDecision || anchorResult.hvacChanged ||
              anchorResult.cabinetryChanged || anchorResult.lightingChanged) ? 0.0 : 1.0),
        message: evidence.localFlags.filter(f => f.startsWith("anchor:")).join(", ") || "All anchors intact",
        details: anchorResult,
      };

      // Deterministic Stage2 kitchen-island enforcement.
      // Applies only for interior kitchen-related contexts when island is confidently detected in BEFORE image.
      if (stage === "2" && sceneType === "interior" && isKitchenBaseline && islandChangedForDecision) {
        const islandDetectedBefore = anchorResult.details?.islandDetectedBefore === true;
        const islandDetectedConfidenceBefore = Number(anchorResult.details?.islandDetectedConfidenceBefore ?? 0);
        const areaDelta = Number(anchorResult.details?.islandAreaDeltaRatio ?? anchorResult.details?.islandRectMassDelta ?? 0);
        const drift = Number(anchorResult.details?.islandMaskedEdgeDrift ?? anchorResult.details?.islandEdgeClusterDrift ?? 0);

        const confidenceGatePass = islandDetectedBefore && islandDetectedConfidenceBefore >= 0.9;

        let islandBand: "noise" | "review" | "hard_fail" = "noise";
        if (areaDelta > 0.15) {
          islandBand = "hard_fail";
        } else if (areaDelta >= 0.08 || drift >= 0.12) {
          islandBand = "review";
        } else if (areaDelta < 0.08 && drift < 0.12) {
          islandBand = "noise";
        }

        const reviewReasonText = "The kitchen island is a built-in architectural element. Any increase in footprint, depth, overhang, or cabinet mass may constitute structural modification. Confirm whether this change represents functional geometry expansion rather than visual variation.";

        if (confidenceGatePass && islandBand === "review") {
          const reviewReason = `island_anchor_review category=structure violationType=built_in_review areaDelta=${areaDelta.toFixed(3)} drift=${drift.toFixed(3)} reason=\"${reviewReasonText}\"`;
          reasons.push(reviewReason);
          warnings.push(reviewReason);
          evidence.localFlags.push(`anchor:island_anchor_review`);
          evidence.localFlags.push(`anchor:island_violation_type:built_in_review`);
          evidence.localFlags.push(`anchor:island_review_reason:${reviewReasonText}`);
          forceGemini = true;
        }

        if (confidenceGatePass && islandBand === "hard_fail") {
          const enforcementReason = `island_anchor_advisory category=structure violationType=built_in_moved areaDeltaRatio=${areaDelta.toFixed(3)} islandMaskedEdgeDrift=${drift.toFixed(3)}`;
          warnings.push(enforcementReason);
          evidence.localFlags.push(`anchor:island_anchor_advisory`);
          evidence.localFlags.push(`anchor:island_violation_type:built_in_moved`);
          forceGemini = true;

          nLog(`[ISLAND_ANCHOR_ENFORCED]`, {
            stage,
            sceneType,
            roomType: roomType || "unknown",
            islandBand,
            category: "structure",
            violationType: "built_in_moved",
            islandDetectedBefore,
            islandDetectedConfidenceBefore,
            areaDelta,
            drift,
            areaDeltaRatio: areaDelta,
            islandMaskedEdgeDrift: drift,
            thresholdAreaDeltaRatio: 0.05,
            thresholdIslandMaskedEdgeDrift: 0.12,
            enforced: false,
          });
        } else if (confidenceGatePass) {
          nLog(`[ISLAND_ANCHOR_ENFORCED]`, {
            stage,
            sceneType,
            roomType: roomType || "unknown",
            islandBand,
            category: "structure",
            violationType: islandBand === "review" ? "built_in_review" : "none",
            islandDetectedBefore,
            islandDetectedConfidenceBefore,
            areaDelta,
            drift,
            areaDeltaRatio: areaDelta,
            islandMaskedEdgeDrift: drift,
            thresholdAreaDeltaRatio: 0.05,
            thresholdIslandMaskedEdgeDrift: 0.12,
            enforced: false,
          });
        }
      }

      if (stage === "2") {
        if (stage2AnchorViolation) {
          forceGemini = true;
        }
        if (anchorResult.hvacChanged) {
          stage2AnchorDirectReasons.push("stage2_direct_advisory: anchor_hvac_changed");
          stage2AnchorDirectEvents.push({ source: "anchor", confidence: 0.5, reasonCode: "anchor_hvac_changed" });
        }
        if (anchorResult.cabinetryChanged) {
          stage2AnchorDirectReasons.push("stage2_direct_advisory: anchor_cabinetry_changed");
          stage2AnchorDirectEvents.push({ source: "anchor", confidence: 0.5, reasonCode: "anchor_cabinetry_changed" });
        }
        if (islandChangedForDecision) {
          stage2AnchorDirectReasons.push("stage2_direct_advisory: anchor_island_changed");
          stage2AnchorDirectEvents.push({ source: "anchor", confidence: 0.5, reasonCode: "anchor_island_changed" });
        }
        stage2LightingAnchorChanged = anchorResult.lightingChanged;
      }

      nLog(`[unified-validator] Anchors: island=${anchorResult.islandChanged} hvac=${anchorResult.hvacChanged} cabinetry=${anchorResult.cabinetryChanged} lighting=${anchorResult.lightingChanged}`);
    } catch (err) {
      console.warn("[unified-validator] Anchor validation error (fail-closed):", err);
      results.anchors = {
        name: "anchors",
        passed: false,
        score: 0,
        message: "Anchor validator error",
        details: { error: String(err) },
      };
      reasons.push("Anchor validation error");
    }
  }

  if (false && stage === "2" && stage2OcclusionAllowance && results.structuralMask) {
    const anchorEvidencePresent = evidence.anchorChecks && Object.values(evidence.anchorChecks).some(Boolean);
    if (!anchorEvidencePresent) {
      const allowance = stage2OcclusionAllowance!;
      nLog("[STAGE2_OCCLUSION_ALLOWANCE]", {
        maskedIoU: allowance.structIoU,
        threshold: allowance.threshold,
      });
      warnings.push(`Structural IoU near threshold: ${allowance.structIoU.toFixed(3)} < ${allowance.threshold}`);
      results.structuralMask.passed = true;
      results.structuralMask.message = "Structural IoU near threshold (Stage 2 allowance)";
      reasons.splice(0, reasons.length, ...reasons.filter(r => !allowance.reasons.includes(r)));
    }
  }

  // ===== BUILD EVIDENCE PACKET =====
  // Populate evidence from all validator results
  {
    // Opening counts from semantic structure or heuristic validators
    if (results.windows?.details) {
      const wd = results.windows.details;
      if (typeof wd.baseWindowCount === "number") {
        evidence.openings.windowsBefore = wd.baseWindowCount;
        evidence.openings.windowsAfter = wd.windowCount ?? wd.baseWindowCount;
      }
    }

    // Drift metrics from wall validator
    if (results.walls?.details) {
      const wallDetails = results.walls.details;
      if (typeof wallDetails.driftRatio === "number") {
        evidence.drift.wallPercent = wallDetails.driftRatio * 100;
      } else if (typeof wallDetails.openingDriftPct === "number") {
        evidence.drift.wallPercent = wallDetails.openingDriftPct;
      }
    }

    // Edge drift from global edge
    if (!disableIouDecisionSignals && results.globalEdge?.details) {
      const edgeDetails = results.globalEdge.details;
      if (typeof edgeDetails.edgeIoU === "number") {
        // Convert IoU to drift percentage (lower IoU = higher drift)
        evidence.drift.maskedEdgePercent = (1 - edgeDetails.edgeIoU) * 100;
      }
    }

    // Line angle deviation
    if (results.lineEdge?.details) {
      const lineDetails = results.lineEdge.details;
      if (typeof lineDetails.verticalDeviation === "number") {
        evidence.drift.angleDegrees = Math.max(
          lineDetails.verticalDeviation || 0,
          lineDetails.horizontalDeviation || 0
        );
      }
    }

    // Collect all failure reasons as local flags
    for (const [key, result] of Object.entries(results)) {
      if (key !== "geminiSemantic" && !result.passed && result.message && !evidence.localFlags.includes(result.message)) {
        evidence.localFlags.push(`${key}: ${result.message}`);
      }
    }
  }

  // ===== SOFT GEOMETRY PROFILE DETECTION =====
  // Determine if this scene should use relaxed thresholds (bedroom-type scenes)
  const softScene = isSoftGeometryScene({
    roomType,
    originalLineCount,
    enhancedLineCount,
    windowCount,
  });

  nLog(`[unified-validator] Geometry Profile: ${softScene ? "SOFT" : "STRICT"}`);
  if (false && softScene) {
    nLog(`[unified-validator] Soft geometry detected - applying relaxed thresholds for bedroom-type scene`);
    nLog(`[unified-validator]   - roomType: ${roomType}`);
    nLog(`[unified-validator]   - windowCount: ${windowCount}`);
    nLog(`[unified-validator]   - originalLineCount: ${originalLineCount}`);
    nLog(`[unified-validator]   - enhancedLineCount: ${enhancedLineCount}`);
  }

  // ===== APPLY SOFT GEOMETRY OVERRIDES =====
  // Deterministic mode: never downgrade structural failures.
  if (false && softScene) {
    if (results.windows && !results.windows.passed) {
      const reason = results.windows.details?.reason;
      if (reason === "window_size_change") {
        nLog(`[unified-validator] Soft geometry override: downgrading window_size_change to warning`);
        results.windows.passed = true;
        results.windows.score = 0.8;
        results.windows.message = "Window size variation (acceptable for bedroom)";
        const idx = reasons.findIndex(r => r.includes("Window validation failed"));
        if (idx !== -1) reasons.splice(idx, 1);
      }
    }
  }

  // ===== PRE-GEMINI AGGREGATE (for evidence packet) =====
  const preGeminiWeights: Record<string, number> = {
    windows: 0.25,
    walls: 0.20,
    globalEdge: 0.20,
    structuralMask: 0.20,
    lineEdge: 0.10,
    anchors: 0.05,
  };

  let preGeminiTotalScore = 0;
  let preGeminiTotalWeight = 0;
  for (const [key, result] of Object.entries(results)) {
    if (key === "geminiSemantic") continue;
    const weight = preGeminiWeights[key] || 0.1;
    const score = result.score !== undefined ? result.score : (result.passed ? 1.0 : 0.0);
    preGeminiTotalScore += score * weight;
    preGeminiTotalWeight += weight;
  }
  const preGeminiScore = preGeminiTotalWeight > 0 ? preGeminiTotalScore / preGeminiTotalWeight : 1.0;

  // Finalize evidence
  evidence.geometryProfile = softScene ? "SOFT" : "STRONG";
  evidence.unifiedScore = preGeminiScore;
  evidence.unifiedPassed = !Object.values(results).some(r => r.name !== "perceptualDiff" && !r.passed);

  // Populate opening counts from semantic or window validators
  if (results.windows?.details) {
    const wd = results.windows.details;
    if (typeof wd.baseWindowCount === "number") {
      evidence.openings.windowsBefore = wd.baseWindowCount;
      evidence.openings.windowsAfter = wd.windowCount ?? wd.baseWindowCount;
    }
  }

  // Drift from wall validator
  if (results.walls?.details) {
    const wallDetails = results.walls.details;
    if (typeof wallDetails.driftRatio === "number") {
      evidence.drift.wallPercent = wallDetails.driftRatio * 100;
    } else if (typeof wallDetails.openingDriftPct === "number") {
      evidence.drift.wallPercent = wallDetails.openingDriftPct;
    }
  }

  // Edge drift
  if (!disableIouDecisionSignals && results.globalEdge?.details) {
    const edgeDetails = results.globalEdge.details;
    if (typeof edgeDetails.edgeIoU === "number") {
      evidence.drift.maskedEdgePercent = (1 - edgeDetails.edgeIoU) * 100;
    }
  }

  // Angle deviation
  if (results.lineEdge?.details) {
    const lineDetails = results.lineEdge.details;
    evidence.drift.angleDegrees = Math.max(
      lineDetails.verticalDeviation || 0,
      lineDetails.horizontalDeviation || 0
    );
  }

  // ===== DETERMINISTIC RISK CLASSIFICATION =====
  const riskClassification = classifyRisk(evidence);
  const riskLevel = riskClassification.level;
  nLog(`[unified-validator] Risk Classification: ${riskLevel}`);
  if (riskClassification.triggers.length > 0) {
    riskClassification.triggers.forEach(t => nLog(`[unified-validator]   → ${t}`));
  }

  // ===== 4b. GEMINI SEMANTIC STRUCTURE CHECK (policy-driven) =====
  // Harden only on architectural/walkway violations; ignore style/furniture changes
  const heuristicFailed = Object.entries(results)
    .filter(([key]) => key !== "geminiSemantic")
    .some(([, r]) => r && r.passed === false);

  const shouldRunGemini =
    stage === "2" ||
    forceGemini ||
    geminiPolicy === "always" ||
    (geminiPolicy === "on_local_fail" && heuristicFailed);

  let escalated = false;
  let geminiModelUsed: string | undefined;
  if (!shouldRunGemini) {
    nLog(`[unified-validator] [Gemini] skipped (policy=${geminiPolicy}, heuristicFailed=${heuristicFailed})`);
  } else {
    if (!earlyExit) validatorPath.push("gemini");
    try {
      const geminiEvidence = STRUCTURAL_SIGNALS_ACTIVE ? evidence : undefined;
      const geminiRiskLevel = STRUCTURAL_SIGNALS_ACTIVE ? riskLevel : undefined;
      const stage2SpecialistAdvisoriesEnabled =
        STAGE2_ENABLE_SPECIALIST_ADVISORY && stage === "2";
      const hasStructuredObservations = stage2SpecialistAdvisoriesEnabled
        && Array.isArray(specialistAdvisoryObservations)
        && specialistAdvisoryObservations.length > 0;
      const specialistObservationHints = hasStructuredObservations
        ? buildSpatialInvestigationBlock(specialistAdvisoryObservations!)
        : stage2SpecialistAdvisoriesEnabled
          ? buildSpecialistObservationHints(specialistAdvisorySignals)
          : [];
      const consensusDerivedWarnings = specialistObservationHints.length;
      if (!STRUCTURAL_SIGNALS_ACTIVE) {
        nLog("[STRUCTURAL_SIGNALS_LOG_ONLY]", {
          mode: STRUCTURAL_SIGNALS_MODE,
          stage,
          jobId: jobId || "unknown",
          action: "strip_heuristic_signal_influence_for_gemini",
          originalDerivedWarnings: warnings.length,
          effectiveDerivedWarnings: consensusDerivedWarnings,
        });
      }
      if (stage === "2") {
        nLog("[STAGE2_ADVISORY_INJECTION]", {
          enabled: stage2SpecialistAdvisoriesEnabled,
          advisoryCount: specialistObservationHints.length,
          sourceSpecialistSignals: Array.isArray(specialistAdvisorySignals)
            ? specialistAdvisorySignals
            : [],
          advisories: specialistObservationHints,
        });
      }
      // IMPORTANT:
      // "local" refers ONLY to heuristic validators (OpenCV/Sharp).
      // Specialist validators (Gemini-based) must NOT be treated as local.
      // Keep suppression terminology scoped to heuristic signals only.
      nLog(`[unified-validator] [Gemini] start stage=${stage} scene=${sceneType} mode=${geminiMode} risk=${riskLevel} base=${originalPath} cand=${enhancedPath}`);
      // IMPORTANT:
      // Stage2 specialist advisory visibility is feature-flagged and non-binding.
      // Decision logic and thresholds remain unchanged.
      const geminiConsensus = await runGeminiWithConsensus({
        basePath: originalPath,
        candidatePath: enhancedPath,
        stage,
        sceneType,
        sourceStage,
        validationMode,
        stage1BValidationMode,
        specialistAdvisoryObservations: specialistObservationHints,
        structuralSignals: structuralSignals as import("./structuralSignal").StructuralSignal[] | undefined,
      }, consensusDerivedWarnings);
      const geminiResult = geminiConsensus.verdict;
      geminiVerdict = geminiResult;
      escalated = geminiConsensus.consensusEnabled;
      geminiModelUsed = geminiConsensus.finalModelUsed;
      nLog(`[validator] escalated=${escalated} earlyExit=${earlyExit}`);
      nLog(`[unified-validator] [Gemini] validator_results=${JSON.stringify(geminiConsensus.validatorResults)} consensus=${geminiConsensus.consensusEnabled} derivedWarnings=${geminiConsensus.derivedWarnings}`);
      if (geminiConsensus.consensusEnabled) {
        const escalationImageId = imageId || jobId || "unknown";
        const flashVerdict = toGeminiPassFail(geminiConsensus.flashVerdict);
        const proVerdict = geminiConsensus.proVerdict ? toGeminiPassFail(geminiConsensus.proVerdict) : "unavailable";
        nLog(
          `[VALIDATOR_ESCALATION] imageId=${escalationImageId} ` +
          `derivedWarnings=${geminiConsensus.derivedWarnings} ` +
          `confidence=${geminiConsensus.flashConfidence.toFixed(3)} ` +
          `flashVerdict=${flashVerdict} ` +
          `proVerdict=${proVerdict} ` +
          `proConfidence=${typeof geminiConsensus.proConfidence === "number" ? geminiConsensus.proConfidence.toFixed(3) : "n/a"} ` +
          `fallbackToFlash=${geminiConsensus.fallbackToFlash}`
        );
      }

      const semantic = summarizeGeminiSemantic(geminiResult);
      const geminiHardFail = semantic.hardFail;

      results.geminiSemantic = {
        name: "geminiSemantic",
        passed: geminiHardFail ? false : semantic.passed,
        score: geminiResult.confidence || 0,
        message: semantic.message,
        details: {
          category: geminiResult.category,
          reasons: geminiResult.reasons,
          confidence: geminiResult.confidence,
          mode: geminiMode,
          validator_results: geminiConsensus.validatorResults,
          consensusMode: geminiConsensus.consensusEnabled,
          derivedWarnings: geminiConsensus.derivedWarnings,
          rawText: geminiResult.rawText,
        },
      };

      if (geminiHardFail || semantic.hardFail) {
        reasons.push(...semantic.reasons);
      } else {
        warnings.push(...semantic.warnings);
      }

      nLog(`[unified-validator] [Gemini] verdict cat=${geminiResult.category} hardFail=${semantic.hardFail} geminiMode=${geminiMode} conf=${geminiResult.confidence}`);
    } catch (err) {
      console.warn("[unified-validator] Gemini semantic check failed (fail-closed)", err);
      results.geminiSemantic = {
        name: "geminiSemantic",
        passed: false,
        score: 0,
        message: "Gemini semantic error (fail-closed)",
        details: { error: String(err), mode: "block" },
      };
      reasons.push("Gemini semantic validation unavailable");
    }
  }

  // ===== FINAL AGGREGATE RESULTS (including Gemini) =====
  const weights: Record<string, number> = {
    windows: 0.25,
    walls: 0.20,
    globalEdge: 0.20,
    structuralMask: 0.20,
    lineEdge: 0.10,
    anchors: 0.05,
  };

  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, result] of Object.entries(results)) {
    const weight = weights[key] || 0.1;
    const score = result.score !== undefined ? result.score : (result.passed ? 1.0 : 0.0);
    totalScore += score * weight;
    totalWeight += weight;
  }

  const aggregateScore = totalWeight > 0 ? totalScore / totalWeight : 1.0;

  const failedValidators = Object.values(results).filter(r => !r.passed && r.name !== "perceptualDiff");
  const allPassed = failedValidators.length === 0;
  const geminiHardFail = results.geminiSemantic && results.geminiSemantic.passed === false;

  // Update evidence with final aggregate
  evidence.unifiedScore = aggregateScore;
  evidence.unifiedPassed = allPassed;

  // Log detailed results
  nLog(`[unified-validator] === Validation Results ===`);
  for (const [key, result] of Object.entries(results)) {
    const icon = result.passed ? "✓" : "✗";
    const scoreStr = result.score !== undefined ? ` (score: ${result.score.toFixed(3)})` : "";
    nLog(`[unified-validator]   ${icon} ${result.name}${scoreStr}: ${result.message}`);
  }
  nLog(`[unified-validator] Aggregate Score: ${aggregateScore.toFixed(3)}`);
  nLog(`[unified-validator] Overall: ${allPassed ? "PASSED" : "FAILED"}`);

  if (reasons.length > 0) {
    nLog(`[unified-validator] Failure Reasons:`);
    reasons.forEach(reason => nLog(`[unified-validator]   - ${reason}`));
  }

  if (warnings.length > 0) {
    nLog(`[unified-validator] Warnings:`);
    warnings.forEach(w => nLog(`[unified-validator]   - ${w}`));
  }

  // Collect non-fatal warnings when in log mode
  if (mode !== "enforce" && failedValidators.length > 0) {
    failedValidators.forEach((r) => {
      if (r.message) warnings.push(r.message);
    });
  }

  // ===== STAGE2 DIRECT STRUCTURAL CHECKS =====
  // Stage 2 direct gate is advisory-only for anchor/fixture/floor signals.
  // Extreme structural auto-fail remains enforced in worker.ts tier gate.
  let stage2DirectHardFail = false;
  if (stage === "2") {
    const directAdvisories = [...stage2AnchorDirectReasons];
    const directEvents: Array<{ source: "anchor" | "fixture" | "floor"; confidence: number; reasonCode: string }> = [
      ...stage2AnchorDirectEvents,
    ];

    const structuralDegree = Number(evidence?.drift?.angleDegrees ?? 0);
    const windowsBefore = evidence.openings.windowsBefore;
    const windowsAfter = evidence.openings.windowsAfter;
    const doorsBefore = evidence.openings.doorsBefore;
    const doorsAfter = evidence.openings.doorsAfter;
    const openingsDeltaDetected =
      typeof windowsBefore === "number" &&
      typeof windowsAfter === "number" &&
      typeof doorsBefore === "number" &&
      typeof doorsAfter === "number"
        ? (Math.abs(windowsBefore - windowsAfter) !== 0 || Math.abs(doorsBefore - doorsAfter) !== 0)
        : false;
    const openingViolationDetected =
      openingsDeltaDetected ||
      results.windows?.passed === false ||
      results.walls?.passed === false ||
      results.structuralMask?.passed === false;
    const geminiStructuredConfidence =
      geminiVerdict?.category === "structure"
        ? Number(geminiVerdict?.confidence ?? 0)
        : 0;

    const violationType = geminiVerdict?.violationType;
    const geminiConfidence = Number(geminiVerdict?.confidence ?? 0);
    const geminiStructuredHardSignal =
      geminiVerdict?.category === "structure" && geminiVerdict?.hardFail === true;
    const hasCriticalFixtureViolation =
      (violationType === "faucet_change" ||
        violationType === "plumbing_change" ||
        violationType === "fixture_change" ||
        violationType === "ceiling_fixture_change") &&
      geminiConfidence >= 0.9 &&
      geminiStructuredHardSignal;

    if (hasCriticalFixtureViolation) {
      directAdvisories.push(`stage2_direct_advisory: ${violationType} confidence=${geminiConfidence.toFixed(3)}`);
      directEvents.push({
        source: "fixture",
        confidence: 0.5,
        reasonCode: String(violationType || "fixture_change"),
      });
    }

    const localStructuralReason = String(results.structuralMask?.details?.reason || "").toLowerCase();
    const floorCoveringMaterialChanged =
      localStructuralReason === "floor_material_changed" ||
      localStructuralReason.startsWith("floor_");

    if (floorCoveringMaterialChanged) {
      directAdvisories.push("stage2_direct_advisory: floor_covering_material_changed");
      directEvents.push({
        source: "floor",
        confidence: 0.5,
        reasonCode: localStructuralReason || "floor_material_changed",
      });
    }

    if (stage2LightingAnchorChanged) {
      directAdvisories.push("stage2_direct_advisory: anchor_fixed_lighting_changed");
      directEvents.push({
        source: "anchor",
        confidence: 0.5,
        reasonCode: "anchor_fixed_lighting_changed",
      });
      warnings.push("stage2_direct_advisory: anchor_fixed_lighting_changed_uncorroborated");
      evidence.localFlags.push("anchor:lighting_advisory_uncorroborated");
      console.log("[STAGE2_DIRECT_GATE_ADVISORY]", {
        source: "anchor",
        reasonCode: "anchor_fixed_lighting_changed",
        corroborated: false,
        structuralDegree,
        geminiStructuredConfidence,
        openingViolationDetected,
      });
    }

    if (directAdvisories.length > 0) {
      warnings.push(...directAdvisories);
      directEvents.forEach((event) => {
        console.log("[STAGE2_DIRECT_GATE]", {
          source: event.source,
          confidence: event.confidence,
          reasonCode: event.reasonCode,
        });
      });
      nLog(`[STAGE2_DIRECT_STRUCTURAL_CHECK] hardFail=false reasons=${directAdvisories.join(" | ")}`);
    }
  }

  let blockSource: "local" | "gemini" | null = geminiHardFail ? "gemini" : null;

  // Deterministic mode: no semantic override of local failures.

  // Handle blocking logic
  if (blockSource) {
    console.error(`[unified-validator] ❌ WOULD BLOCK IMAGE (source=${blockSource})`);
  } else if (!allPassed) {
    nLog(`[unified-validator] ⚠️ Validation failed but not blocking (mode=log)`);
  }

  nLog(`[unified-validator] ===============================`);

  const hardFail = blockSource !== null;
  const uniqueWarnings = Array.from(new Set(warnings));
  const stage2ReasonScope = stage === "2"
    ? reasons.filter((reason) =>
        reason.startsWith("Gemini ") || reason.toLowerCase().includes("gemini")
      )
    : reasons;
  const issueInferenceReasons = stage2ReasonScope.length > 0 ? stage2ReasonScope : reasons;
  const issueType: ValidationIssueType = inferUnifiedIssueType({
    hardFail,
    geminiVerdict,
    reasons: issueInferenceReasons,
  });

  const finalResult: UnifiedValidationResult = {
    passed: hardFail ? false : true,
    hardFail,
    blockSource,
    score: Math.round(aggregateScore * 1000) / 1000,
    reasons: hardFail ? issueInferenceReasons : [],
    warnings: uniqueWarnings,
    normalized: uniqueWarnings.includes("dimension_normalized"),
    raw: results,
    profile: softScene ? "SOFT" : "STRICT",
    evidence,
    riskLevel,
    riskTriggers: riskClassification.triggers,
    modelUsed: geminiModelUsed,
    earlyExit: earlyExit || undefined,
    escalated: escalated || undefined,
    validatorPath,
    issueType,
    issueTier: classifyIssueTier(issueType),
    adjudicatedClaims: geminiVerdict?.adjudicatedClaims,
  };

  // ── Structural claim adjudication logging (Step 2) ──
  if (Array.isArray(geminiVerdict?.adjudicatedClaims) && geminiVerdict!.adjudicatedClaims!.length > 0) {
    nLog("[STRUCTURAL_CLAIMS_ADJUDICATED]", {
      jobId: jobId || "unknown",
      stage,
      claimCount: geminiVerdict!.adjudicatedClaims!.length,
      claims: geminiVerdict!.adjudicatedClaims!.map((c) => ({
        claim: c.claim,
        result: c.result,
        detail: c.detail,
        region: c.region,
      })),
      confirmedClaims: geminiVerdict!.adjudicatedClaims!
        .filter((c) => c.result === "CONFIRMED")
        .map((c) => c.claim),
      uncertainClaims: geminiVerdict!.adjudicatedClaims!
        .filter((c) => c.result === "UNCERTAIN")
        .map((c) => c.claim),
    });
  }

  // ===== STRUCTURED PER-CHECK + VERDICT LOGS =====
  for (const [, result] of Object.entries(results)) {
    const sc = result.score !== undefined ? result.score.toFixed(3) : "N/A";
    console.log(`[validator] check=${result.name} pass=${result.passed} score=${sc}`);
  }
  if (earlyExit) console.log(`[validator] early_exit=true`);
  if (escalated) console.log(`[validator] escalated=true`);
  console.log(`[validator] verdict=${finalResult.passed ? "PASS" : "FAIL"} score=${finalResult.score.toFixed(3)} jobId=${jobId ?? "unknown"}`);

  return finalResult;
}

/**
 * Output compact unified validation logs for VALIDATOR_FOCUS mode
 *
 * This function is called from worker.ts when VALIDATOR_FOCUS is enabled.
 * It produces concise, structured output matching the specified format.
 *
 * @param jobId Job ID for log prefix
 * @param result Unified validation result
 * @param stage Stage being validated
 * @param sceneType Scene type
 */
export function logUnifiedValidationCompact(
  jobId: string,
  result: UnifiedValidationResult,
  stage: string,
  sceneType: string
) {
  const profile = result.profile || "STRICT";
  const risk = result.riskLevel || "N/A";
  const model = result.modelUsed || "N/A";
  vLog(
    `[VAL][job=${jobId}] UnifiedStructural: ${result.passed ? "PASSED" : "FAILED"} ` +
    `(score=${result.score.toFixed(3)}, profile=${profile}, risk=${risk}, model=${model})`
  );

  vLog(`[VAL][job=${jobId}]   stage=${stage} scene=${sceneType}`);

  // Windows
  const windows = result.raw.windows;
  if (windows) {
    const windowsScore = windows.score !== undefined ? windows.score.toFixed(3) : "N/A";
    const windowsReason = windows.passed ? "(ok)" : `(${windows.details?.reason || "failed"})`;
    vLog(`[VAL][job=${jobId}]   windows=${windowsScore} ${windowsReason}`);
  }

  // Walls
  const walls = result.raw.walls;
  if (walls) {
    const wallsScore = walls.score !== undefined ? walls.score.toFixed(3) : "N/A";
    const wallsReason = walls.passed ? "(ok)" : `(${walls.details?.reason || "failed"})`;
    vLog(`[VAL][job=${jobId}]   walls=${wallsScore} ${wallsReason}`);
  }

  // Global Edge
  const globalEdge = result.raw.globalEdge;
  if (globalEdge) {
    const edgeScore = globalEdge.score !== undefined ? globalEdge.score.toFixed(3) : "N/A";
    const edgeThreshold = globalEdge.details?.minEdgeIoU !== undefined
      ? globalEdge.details.minEdgeIoU.toFixed(3)
      : "N/A";
    vLog(`[VAL][job=${jobId}]   globalEdge=${edgeScore}/${edgeThreshold}`);
  }

  // Structural IoU with Mask
  const structuralMask = result.raw.structuralMask;
  if (structuralMask) {
    const structScore = structuralMask.score !== undefined ? structuralMask.score.toFixed(3) : "N/A";
    const structThreshold = structuralMask.details?.minStructIoU !== undefined
      ? structuralMask.details.minStructIoU.toFixed(3)
      : "N/A";
    vLog(`[VAL][job=${jobId}]   structuralIoU=${structScore}/${structThreshold}`);
  }

  // Line/Edge
  const lineEdge = result.raw.lineEdge;
  if (lineEdge) {
    const lineScore = lineEdge.score !== undefined ? lineEdge.score.toFixed(3) : "N/A";
    const lineMsg = lineEdge.message || "N/A";
    vLog(`[VAL][job=${jobId}]   lineEdgeScore=${lineScore} – ${lineMsg}`);
  }

  // Anchors
  const anchors = result.raw.anchors;
  if (anchors) {
    const anchorFlags = anchors.details
      ? Object.entries(anchors.details)
          .filter(([k, v]) => k !== "details" && v === true)
          .map(([k]) => k)
      : [];
    vLog(`[VAL][job=${jobId}]   anchors=${anchors.passed ? "intact" : anchorFlags.join(",") || "changed"}`);
  }

  // Risk
  if (result.riskLevel) {
    const triggers = result.riskTriggers?.length ? result.riskTriggers.join("; ") : "none";
    vLog(`[VAL][job=${jobId}]   risk=${result.riskLevel} triggers=${triggers}`);
  }

  // Failures
  if (!result.passed && result.reasons.length > 0) {
    vLog(`[VAL][job=${jobId}]   failures=${result.reasons.join("; ")}`);
  }

  if (result.warnings.length > 0) {
    vLog(`[VAL][job=${jobId}]   warnings=${result.warnings.join("; ")}`);
  }
}
