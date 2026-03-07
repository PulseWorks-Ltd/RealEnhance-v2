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
  /** true when cheap gate (SSIM) failed and local validators were skipped */
  earlyExit?: boolean;
  /** true when Gemini escalation was triggered */
  escalated?: boolean;
  /** Ordered list of validators that executed (e.g. ["perceptualDiff","gemini"]) */
  validatorPath?: string[];
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
};

function toGeminiPassFail(verdict: GeminiSemanticVerdict): GeminiPassFail {
  return verdict.hardFail ? "fail" : "pass";
}

function pickConsensusVerdict(
  verdicts: GeminiSemanticVerdict[],
  targetDecision: GeminiPassFail
): GeminiSemanticVerdict {
  const matches = verdicts.filter((verdict) => toGeminiPassFail(verdict) === targetDecision);
  if (matches.length === 0) return verdicts[0];

  return matches.reduce((best, candidate) => {
    const bestConfidence = Number.isFinite(best.confidence) ? best.confidence : 0;
    const candidateConfidence = Number.isFinite(candidate.confidence) ? candidate.confidence : 0;
    return candidateConfidence > bestConfidence ? candidate : best;
  }, matches[0]);
}

async function runGeminiWithConsensus(
  input: Parameters<typeof runGeminiSemanticValidator>[0],
  derivedWarnings: number
): Promise<GeminiConsensusResult> {
  const resultA = await runGeminiSemanticValidator(input);
  const validatorResults: GeminiValidatorResults = {
    v1: toGeminiPassFail(resultA),
  };

  const validatorConfidence = Number.isFinite(resultA.confidence) ? resultA.confidence : 0;
  const consensusEnabled = derivedWarnings >= 3 || validatorConfidence < 0.7;
  if (!consensusEnabled) {
    return {
      verdict: resultA,
      validatorResults,
      consensusEnabled,
      derivedWarnings,
    };
  }

  let resultB: GeminiSemanticVerdict;
  try {
    resultB = await runGeminiSemanticValidator(input);
  } catch (err) {
    console.warn("[unified-validator] Gemini consensus second call failed; falling back to first call", err);
    return {
      verdict: resultA,
      validatorResults,
      consensusEnabled,
      derivedWarnings,
    };
  }

  validatorResults.v2 = toGeminiPassFail(resultB);
  if (validatorResults.v1 === validatorResults.v2) {
    return {
      verdict: pickConsensusVerdict([resultA, resultB], validatorResults.v1),
      validatorResults,
      consensusEnabled,
      derivedWarnings,
    };
  }

  let resultC: GeminiSemanticVerdict;
  try {
    resultC = await runGeminiSemanticValidator(input);
  } catch (err) {
    console.warn("[unified-validator] Gemini consensus tie-breaker failed; using first call", err);
    return {
      verdict: resultA,
      validatorResults,
      consensusEnabled,
      derivedWarnings,
    };
  }

  validatorResults.v3 = toGeminiPassFail(resultC);
  const failVotes = [resultA, resultB, resultC].filter((verdict) => verdict.hardFail).length;
  const finalDecision: GeminiPassFail = failVotes >= 2 ? "fail" : "pass";

  return {
    verdict: pickConsensusVerdict([resultA, resultB, resultC], finalDecision),
    validatorResults,
    consensusEnabled,
    derivedWarnings,
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
  originalPath: string;
  enhancedPath: string;
  stage: "1A" | "1B" | "2";
  sceneType?: "interior" | "exterior";
  roomType?: string;
  mode?: "log" | "enforce";
  jobId?: string;
  stagingStyle?: string;  // Staging style used (for safety coupling)
  /**
   * Stage1A output path for Stage2 validation baseline.
   * CRITICAL: Stage2 should validate against Stage1A output, NOT original.
   * If not provided, falls back to originalPath (legacy behavior).
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
    stagingStyle,
    stage1APath,
    sourceStage,
    validationMode,
    stage1BValidationMode,
    baseArtifacts,
    geminiPolicy = "always",
  } = params;

  const validatorMode = getLocalValidatorMode();
  const stageAwareConfig = loadStageAwareConfig();
  const warnings: string[] = [];
  const geminiMode = getGeminiValidatorMode();
  const results: Record<string, ValidatorResult> = {};
  const reasons: string[] = [];
  let geminiVerdict: GeminiSemanticVerdict | null = null;
  let stage2AnchorDirectReasons: string[] = [];
  let stage2AnchorDirectEvents: Array<{ source: "anchor"; confidence: number; reasonCode: string }> = [];
  let stage2LightingAnchorChanged = false;
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
  nLog(`[unified-validator] Stage-Aware: ${stageAwareConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
  nLog(`[unified-validator] Original: ${originalPath}`);
  nLog(`[unified-validator] Enhanced: ${enhancedPath}`);
  if (stage1APath) {
    nLog(`[unified-validator] Stage1A Path: ${stage1APath}`);
  }

  // ===== PERCEPTUAL DIFF (SSIM) GATE — FIRST STEP =====
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

      if (!perceptual.passed) {
        perceptualFailed = true;
        forceGemini = true;
        reasons.push(`Perceptual diff failed: SSIM ${perceptual.score.toFixed(3)} < ${perceptual.threshold.toFixed(2)}`);
        evidence.localFlags.push(`ssim_failed: ${perceptual.score.toFixed(3)} < ${perceptual.threshold.toFixed(2)}`);
        nLog(`[perceptual-diff] FAIL → early exit, escalating directly to Gemini`);
      }
    } catch (err) {
      console.warn("[perceptual-diff] Error computing SSIM (fail-open):", err);
    }
  }

  // ===== EARLY EXIT TRACKING =====
  // When the cheap gate (SSIM) fails, skip local validators 1–2 and go straight to Gemini.
  const earlyExit = perceptualFailed;
  const validatorPath: string[] = ["perceptualDiff"];
  if (earlyExit) {
    validatorPath.push("gemini");
    nLog(`[validator] early_exit=true path=${validatorPath.join(",")}`);
  }

  // ===== STAGE-AWARE VALIDATION PATH =====
  // When enabled, use the new stage-aware validator for Stage 2
  // Skipped on early exit (SSIM gate fail → direct Gemini escalation)
  if (!earlyExit && stageAwareConfig.enabled && stage === "2") {
    nLog(`[unified-validator] Using stage-aware validator for Stage 2`);

    // CRITICAL: Use Stage1A output as baseline for Stage2, NOT original
    const validationBaseline = stage1APath || originalPath;
    if (!stage1APath) {
      nLog(`[unified-validator] ⚠️ No stage1APath provided - using originalPath as baseline (may cause false positives)`);
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

  // Run local validators for evidence collection — skipped on early exit (SSIM gate fail).
  if (!earlyExit) {
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
        console.warn("[unified-validator] Window validation error:", err);
        results.windows = {
          name: "windows",
          passed: true, // Fail-open
          score: 0.5,
          message: "Window validator error (fail-open)",
          details: { error: String(err) },
        };
      }
    }

    // ===== 2. WALL VALIDATION =====
    // Validates wall structure and openings
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
      console.warn("[unified-validator] Wall validation error:", err);
      results.walls = {
        name: "walls",
        passed: true, // Fail-open
        score: 0.5,
        message: "Wall validator error (fail-open)",
        details: { error: String(err) },
      };
    }

    // ===== 3. GLOBAL EDGE IoU =====
    // Overall geometry consistency check
    try {
      const edgeResult = buffers
        ? runGlobalEdgeMetricsFromBuffers(
            buffers.baseBlur,
            buffers.candBlur,
            buffers.width,
            buffers.height,
            Number(process.env.LOCAL_EDGE_MAG_THRESHOLD || 35)
          )
        : await runGlobalEdgeMetrics(originalPath, enhancedPath);
      const edgeIoU = edgeResult.edgeIoU;

      // Thresholds by stage
      const minEdgeIoU = stage === "1A" ? 0.70 : stage === "1B" ? 0.65 : 0.60;
      const passed = edgeIoU >= minEdgeIoU;

      results.globalEdge = {
        name: "globalEdge",
        passed,
        score: edgeIoU,
        message: `Edge IoU: ${edgeIoU.toFixed(3)} (threshold: ${minEdgeIoU})`,
        details: { edgeIoU, minEdgeIoU },
      };
      if (!passed) {
        reasons.push(`Global edge IoU too low: ${edgeIoU.toFixed(3)} < ${minEdgeIoU}`);
      }
    } catch (err) {
      console.warn("[unified-validator] Global edge validation error:", err);
      results.globalEdge = {
        name: "globalEdge",
        passed: true, // Fail-open
        score: 0.5,
        message: "Global edge validator error (fail-open)",
        details: { error: String(err) },
      };
    }

    // ===== 4. STRUCTURAL IoU WITH MASK (Stage 2 only) =====
    // Focused check on architectural elements during staging
    if (stage === "2") {
      try {
        const baseDimTolerance = 8;
        const dimThreshold = Math.round(baseDimTolerance * 1.2);
        const mask = await loadOrComputeStructuralMask(jobId || "default", originalPath, baseArtifacts);
        const structResult = await validateStage2Structural(
          originalPath,
          enhancedPath,
          { structuralMask: mask },
          buffers ? { baseGray: buffers.baseGray, candGray: buffers.candGray, width: buffers.width, height: buffers.height } : undefined,
          { dimensionTolerance: dimThreshold }
        );

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
        } else {
          // IoU was skipped - do NOT treat as failure
          const skipReason = structResult.structuralIoUSkipReason || "unknown";
          passed = structResult.ok; // Pass based on semantic checks only
          score = 0.5; // Neutral score (not 0!)
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
          },
        };

        if (structResult.debug?.dimensionNormalized) {
          warnings.push("dimension_normalized");
        }
      } catch (err) {
        console.warn("[unified-validator] Structural mask validation error:", err);
        results.structuralMask = {
          name: "structuralMask",
          passed: true, // Fail-open
          score: 0.5,
          message: "Structural mask validator error (fail-open)",
          details: { error: String(err) },
        };
      }
    }

    // ===== 5. LINE/EDGE DETECTION (Sharp-based Hough) =====
    // Detects line shifts using Hough transform
    try {
      const baseLineSensitivity = 0.70;
      const lineDriftThreshold = stage === "2"
        ? baseLineSensitivity * 0.75
        : baseLineSensitivity;
      const lineResult = await validateLineStructure({
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
      });

      // Capture line counts for soft geometry detection
      if (lineResult.details?.originalEdgeCount) {
        originalLineCount = lineResult.details.originalEdgeCount;
      }
      if (lineResult.details?.enhancedEdgeCount) {
        enhancedLineCount = lineResult.details.enhancedEdgeCount;
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
        const openingsIntact = (results.windows?.passed !== false) && (results.walls?.passed !== false) && (results.structuralMask?.passed !== false);
        if (openingsIntact) {
          // Downgrade to warning when openings/boundaries still pass
          warnings.push(`Line/edge deviation (openings intact): ${lineResult.score.toFixed(3)}`);
          results.lineEdge.message = `Line deviation warning (openings intact)`;
          results.lineEdge.passed = true;
        } else {
          reasons.push(`Line/edge validation failed: score ${lineResult.score.toFixed(3)}`);
        }
      }
    } catch (err) {
      console.warn("[unified-validator] Line/edge validation error:", err);
      results.lineEdge = {
        name: "lineEdge",
        passed: true, // Fail-open
        score: 0.5,
        message: "Line/edge validator error (fail-open)",
        details: { error: String(err) },
      };
    }
  } // end if (!earlyExit)

  // Track which local validators were actually executed
  if (!earlyExit) {
    validatorPath.push("structural", "geometry");
  }

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
      console.warn("[unified-validator] Anchor validation error (fail-open):", err);
      results.anchors = {
        name: "anchors",
        passed: true,
        score: 0.5,
        message: "Anchor validator error (fail-open)",
        details: { error: String(err) },
      };
    }
  }

  if (stage === "2" && stage2OcclusionAllowance && results.structuralMask) {
    const anchorEvidencePresent = evidence.anchorChecks && Object.values(evidence.anchorChecks).some(Boolean);
    if (!anchorEvidencePresent) {
      nLog("[STAGE2_OCCLUSION_ALLOWANCE]", {
        maskedIoU: stage2OcclusionAllowance.structIoU,
        threshold: stage2OcclusionAllowance.threshold,
      });
      warnings.push(`Structural IoU near threshold: ${stage2OcclusionAllowance.structIoU.toFixed(3)} < ${stage2OcclusionAllowance.threshold}`);
      results.structuralMask.passed = true;
      results.structuralMask.message = "Structural IoU near threshold (Stage 2 allowance)";
      reasons.splice(0, reasons.length, ...reasons.filter(r => !stage2OcclusionAllowance?.reasons.includes(r)));
    }
  }

  // ===== BUILD EVIDENCE PACKET =====
  // Populate evidence from all validator results
  {
    // Opening counts from semantic structure or local validators
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
    if (results.globalEdge?.details) {
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
  if (softScene) {
    nLog(`[unified-validator] Soft geometry detected - applying relaxed thresholds for bedroom-type scene`);
    nLog(`[unified-validator]   - roomType: ${roomType}`);
    nLog(`[unified-validator]   - windowCount: ${windowCount}`);
    nLog(`[unified-validator]   - originalLineCount: ${originalLineCount}`);
    nLog(`[unified-validator]   - enhancedLineCount: ${enhancedLineCount}`);
  }

  // ===== APPLY SOFT GEOMETRY OVERRIDES =====
  if (softScene) {
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
  if (results.globalEdge?.details) {
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
  const localFailed = Object.entries(results)
    .filter(([key]) => key !== "geminiSemantic")
    .some(([, r]) => r && r.passed === false);

  const shouldRunGemini =
    forceGemini ||
    geminiPolicy === "always" ||
    (geminiPolicy === "on_local_fail" && localFailed);

  let escalated = false;
  if (!shouldRunGemini) {
    nLog(`[unified-validator] [Gemini] skipped (policy=${geminiPolicy}, localFailed=${localFailed})`);
  } else {
    escalated = true;
    if (!earlyExit) validatorPath.push("gemini");
    nLog(`[validator] escalated=${escalated} earlyExit=${earlyExit}`);
    try {
      nLog(`[unified-validator] [Gemini] start stage=${stage} scene=${sceneType} mode=${geminiMode} risk=${riskLevel} base=${originalPath} cand=${enhancedPath}`);
      const geminiConsensus = await runGeminiWithConsensus({
        basePath: originalPath,
        candidatePath: enhancedPath,
        stage,
        sceneType,
        sourceStage,
        validationMode,
        stage1BValidationMode,
        evidence,
        riskLevel,
      }, warnings.length);
      const geminiResult = geminiConsensus.verdict;
      geminiVerdict = geminiResult;
      nLog(`[unified-validator] [Gemini] validator_results=${JSON.stringify(geminiConsensus.validatorResults)} consensus=${geminiConsensus.consensusEnabled} derivedWarnings=${geminiConsensus.derivedWarnings}`);

      const semantic = summarizeGeminiSemantic(geminiResult);
      const geminiHardFail = semantic.hardFail && geminiMode === "block";

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
      console.warn("[unified-validator] Gemini semantic check failed open", err);
      results.geminiSemantic = {
        name: "geminiSemantic",
        passed: true,
        score: 0.5,
        message: "Gemini semantic error (fail-open)",
        details: { error: String(err), mode: geminiMode },
      };
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
  const geminiHardFail = results.geminiSemantic && results.geminiSemantic.details && (results.geminiSemantic.details as any).mode === "block" && results.geminiSemantic.passed === false;
  const localFailures = failedValidators.length;

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

  let blockSource: "local" | "gemini" | null = geminiHardFail
    ? "gemini"
    : ((mode === "enforce" && !allPassed) ? "local" : null);

  if (stage2DirectHardFail) {
    blockSource = "local";
  }

  // ===== STAGE2 SEMANTIC OVERRIDE GATE =====
  // Allow Gemini semantic PASS to downgrade local failures when structural evidence is clean.
  if (blockSource === "local" && stage === "2") {
    const semanticKnown = typeof results.geminiSemantic?.passed === "boolean";
    const semanticPass = semanticKnown && results.geminiSemantic?.passed === true;

    const anchorChecks = evidence.anchorChecks;
    const anchorValues = anchorChecks ? Object.values(anchorChecks) : null;
    const anchorsChanged = (!anchorValues || anchorValues.some((v) => typeof v !== "boolean"))
      ? null
      : anchorValues.some((v) => v === true);

    const windowsBefore = evidence.openings.windowsBefore;
    const windowsAfter = evidence.openings.windowsAfter;
    const doorsBefore = evidence.openings.doorsBefore;
    const doorsAfter = evidence.openings.doorsAfter;
    const openingsChanged = (typeof windowsBefore !== "number" || typeof windowsAfter !== "number" || typeof doorsBefore !== "number" || typeof doorsAfter !== "number")
      ? null
      : (Math.abs(windowsBefore - windowsAfter) !== 0 || Math.abs(doorsBefore - doorsAfter) !== 0);

    const structuralMaskPassed = (typeof results.structuralMask?.passed !== "boolean") ? null : results.structuralMask.passed === true;
    const wallsPassed = (typeof results.walls?.passed !== "boolean") ? null : results.walls.passed === true;

    let rejectReason: "anchors" | "openings" | "removal" | "semantic_fail" | "missing_signal" | null = null;
    if (!semanticKnown) {
      rejectReason = "missing_signal";
    } else if (!semanticPass) {
      rejectReason = "semantic_fail";
    } else if (anchorsChanged === null) {
      rejectReason = "missing_signal";
    } else if (anchorsChanged) {
      rejectReason = "anchors";
    } else if (openingsChanged === null) {
      rejectReason = "missing_signal";
    } else if (openingsChanged) {
      rejectReason = "openings";
    } else if (structuralMaskPassed === null || wallsPassed === null) {
      rejectReason = "missing_signal";
    } else if (!structuralMaskPassed || !wallsPassed) {
      rejectReason = "removal";
    }

    if (rejectReason) {
      nLog(`[STAGE2_SEMANTIC_OVERRIDE_GATE] rejected reason=${rejectReason}`);
    } else {
      blockSource = null;
      nLog(`[STAGE2_SEMANTIC_OVERRIDE_GATE] activated localFailures=${localFailures} anchorsChanged=false openingsChanged=false semantic=PASS`);
    }
  }

  // Handle blocking logic
  if (blockSource) {
    console.error(`[unified-validator] ❌ WOULD BLOCK IMAGE (source=${blockSource})`);
  } else if (!allPassed) {
    nLog(`[unified-validator] ⚠️ Validation failed but not blocking (mode=log)`);
  }

  nLog(`[unified-validator] ===============================`);

  const hardFail = blockSource !== null;
  const uniqueWarnings = Array.from(new Set(warnings));

  const finalResult: UnifiedValidationResult = {
    passed: hardFail ? false : true,
    hardFail,
    blockSource,
    score: Math.round(aggregateScore * 1000) / 1000,
    reasons: hardFail ? reasons : [],
    warnings: uniqueWarnings,
    normalized: uniqueWarnings.includes("dimension_normalized"),
    raw: results,
    profile: softScene ? "SOFT" : "STRICT",
    evidence,
    riskLevel,
    riskTriggers: riskClassification.triggers,
    modelUsed: riskLevel === "LOW"
      ? (process.env.GEMINI_VALIDATOR_MODEL_FAST || "gemini-2.0-flash")
      : (process.env.GEMINI_VALIDATOR_MODEL_STRONG || "gemini-2.5-flash"),
    earlyExit: earlyExit || undefined,
    escalated: escalated || undefined,
    validatorPath,
  };

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
