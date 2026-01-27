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
import { runGlobalEdgeMetrics } from "./globalStructuralValidator";
import { validateStage2Structural } from "./stage2StructuralValidator";
import { validateLineStructure } from "./lineEdgeValidator";
import { loadOrComputeStructuralMask } from "./structuralMask";
import { getValidatorMode, isValidatorEnabled } from "./validatorMode";
import { vLog, nLog } from "../logger";
import { loadStageAwareConfig, ValidationSummary } from "./stageAwareConfig";
import { validateStructureStageAware } from "./structural/stageAwareValidator";
import { runGeminiSemanticValidator } from "./geminiSemanticValidator";

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
  hardFail: boolean;         // true only when enforcement mode blocks the image
  score: number;             // aggregate structural score 0–1
  reasons: string[];         // human-readable hard-fail reasons
  warnings: string[];        // non-fatal warnings
  normalized?: boolean;      // whether dimensions were normalized
  raw: Record<string, ValidatorResult>;  // per-validator raw results
  profile?: "SOFT" | "STRICT";  // Geometry profile used
};

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
 *
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
  } = params;

  const validatorMode = getValidatorMode("structure");
  const stageAwareConfig = loadStageAwareConfig();
  const warnings: string[] = [];

  // VALIDATOR SAFETY TIE-IN: NZ Standard gets strictest protection
  const isNZStandard = !stagingStyle ||
    stagingStyle.toLowerCase().includes('nz_standard') ||
    stagingStyle.toLowerCase().includes('nz standard');

  if (isNZStandard) {
    nLog(`[unified-validator] ✅ NZ STANDARD mode detected - enforcing strict structural protection`);
  }

  nLog(`[unified-validator] === Starting Unified Structural Validation ===`);
  nLog(`[unified-validator] Stage: ${stage}`);
  nLog(`[unified-validator] Scene: ${sceneType}`);
  nLog(`[unified-validator] Mode: ${mode} (validator config: ${validatorMode})`);
  nLog(`[unified-validator] Staging Style: ${stagingStyle || 'nz_standard (default)'}`);
  nLog(`[unified-validator] Stage-Aware: ${stageAwareConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
  nLog(`[unified-validator] Original: ${originalPath}`);
  nLog(`[unified-validator] Enhanced: ${enhancedPath}`);
  if (stage1APath) {
    nLog(`[unified-validator] Stage1A Path: ${stage1APath}`);
  }

  // Check if validators are enabled
  if (!isValidatorEnabled("structure")) {
    nLog(`[unified-validator] Structural validators disabled (mode=off)`);
    return {
      passed: true,
      hardFail: false,
      score: 1.0,
      reasons: [],
      warnings: ["Validators disabled"],
      normalized: false,
      raw: {},
    };
  }

  // ===== STAGE-AWARE VALIDATION PATH =====
  // When enabled, use the new stage-aware validator for Stage 2
  if (stageAwareConfig.enabled && stage === "2") {
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
      });

      // Convert stage-aware result to UnifiedValidationResult format
      const reasons: string[] = [];
      if (stageAwareResult.risk) {
        stageAwareResult.triggers.forEach(t => {
          reasons.push(`${t.id}: ${t.message}`);
        });
      }

      const results: Record<string, ValidatorResult> = {
        stageAware: {
          name: "stageAware",
          passed: mode === "enforce" ? !stageAwareResult.risk : true,
          score: stageAwareResult.score,
          message: stageAwareResult.risk
            ? `Risk detected: ${stageAwareResult.triggers.length} triggers`
            : "Stage-aware validation passed",
          details: {
            triggers: stageAwareResult.triggers,
            metrics: stageAwareResult.metrics,
            debug: stageAwareResult.debug,
          },
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

      const hardFail = mode === "enforce" && stageAwareResult.risk;

      if (!hardFail) {
        stageAwareResult.triggers.forEach(t => warnings.push(`${t.id}: ${t.message}`));
      }

      return {
        passed: hardFail ? false : true,
        hardFail,
        score: stageAwareResult.score,
        reasons: hardFail ? reasons : [],
        warnings,
        normalized: stageAwareResult.debug?.dimensionNormalized,
        raw: results,
        profile: "STRICT", // Stage-aware always uses strict mode
      };
    } catch (err) {
      nLog(`[unified-validator] Stage-aware validation error: ${err}`);
      // Fall through to legacy validation on error
    }
  }

  const results: Record<string, ValidatorResult> = {};
  const reasons: string[] = [];

  // ===== SOFT GEOMETRY DETECTION =====
  // We'll collect metadata as we run validators, then determine soft/strict mode
  let windowCount = 0;
  let originalLineCount = 0;
  let enhancedLineCount = 0;

  // ===== 1. WINDOW VALIDATION =====
  // Critical for real estate: windows must not be blocked or altered
  if (stage === "1B" || stage === "2") {
    try {
      const windowResult = await validateWindows(originalPath, enhancedPath);

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
    const edgeResult = await runGlobalEdgeMetrics(originalPath, enhancedPath);
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
      const mask = await loadOrComputeStructuralMask(jobId || "default", originalPath);
      const structResult = await validateStage2Structural(originalPath, enhancedPath, {
        structuralMask: mask,
      });

      const minStructIoU = 0.30; // Relaxed for staging (allows furniture addition)

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
          reasons.push(`Structural IoU too low: ${structIoU.toFixed(3)} < ${minStructIoU}`);
          if (structResult.reason) {
            reasons.push(`Reason: ${structResult.reason}`);
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

  // ===== 4b. GEMINI SEMANTIC STRUCTURE CHECK =====
  // Harden only on architectural/walkway violations; ignore style/furniture changes
  try {
    const geminiResult = await runGeminiSemanticValidator({
      basePath: originalPath,
      candidatePath: enhancedPath,
      stage,
      sceneType,
    });

    const semanticPassed = !geminiResult.hard_fail;
    const details = {
      structural_ok: geminiResult.structural_ok,
      walkway_ok: geminiResult.walkway_ok,
      confidence: geminiResult.confidence,
      reasons: geminiResult.reasons,
      notes: geminiResult.notes,
    };

    results.geminiSemantic = {
      name: "geminiSemantic",
      passed: semanticPassed,
      score: geminiResult.confidence || 0,
      message: semanticPassed ? "Gemini semantic OK" : "Gemini structural violation",
      details,
    };

    // Hard fail only when Gemini is confident and flags structure/walkway
    if (geminiResult.hard_fail) {
      reasons.push("Gemini semantic hard fail: " + (geminiResult.reasons?.join(", ") || geminiResult.notes || "structural"));
    } else {
      // Collect warnings when soft issues present
      if (geminiResult.structural_ok === false || geminiResult.walkway_ok === false) {
        const warnLabel = geminiResult.reasons?.length ? geminiResult.reasons.join(", ") : "semantic_warning";
        warnings.push(warnLabel);
      }
      if (geminiResult.notes) warnings.push(geminiResult.notes);
    }
  } catch (err) {
    console.warn("[unified-validator] Gemini semantic check failed open", err);
    results.geminiSemantic = {
      name: "geminiSemantic",
      passed: true,
      score: 0.5,
      message: "Gemini semantic error (fail-open)",
      details: { error: String(err) },
    };
  }

  // ===== 5. LINE/EDGE DETECTION (Sharp-based Hough) =====
  // Detects line shifts using Hough transform
  try {
    const lineResult = await validateLineStructure({
      originalPath,
      enhancedPath,
      sensitivity: 0.70, // 70% similarity threshold
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
      reasons.push(`Line/edge validation failed: score ${lineResult.score.toFixed(3)}`);
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
  // For soft geometry scenes (bedrooms, studies), downgrade certain failures to warnings
  if (softScene) {
    // Window size changes in bedrooms are often acceptable (curtains, furniture partially blocking)
    if (results.windows && !results.windows.passed) {
      const reason = results.windows.details?.reason;
      if (reason === "window_size_change") {
        nLog(`[unified-validator] Soft geometry override: downgrading window_size_change to warning`);
        results.windows.passed = true;
        results.windows.score = 0.8; // Slight penalty but not a failure
        results.windows.message = "Window size variation (acceptable for bedroom)";
        // Remove from failure reasons
        const idx = reasons.findIndex(r => r.includes("Window validation failed"));
        if (idx !== -1) reasons.splice(idx, 1);
      }
    }
  }

  // ===== AGGREGATE RESULTS =====

  // Compute weighted aggregate score
  // Weights prioritize critical structural elements
  const weights = {
    windows: 0.25,        // Critical: must not block windows/doors
    walls: 0.20,          // Important: wall structure must be preserved
    globalEdge: 0.20,     // Important: overall geometry consistency
    structuralMask: 0.20, // Important: architectural elements (Stage 2)
    lineEdge: 0.15,       // Useful: line deviation detection
  };

  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, result] of Object.entries(results)) {
    const weight = weights[key as keyof typeof weights] || 0.1;
    const score = result.score !== undefined ? result.score : (result.passed ? 1.0 : 0.0);
    totalScore += score * weight;
    totalWeight += weight;
  }

  const aggregateScore = totalWeight > 0 ? totalScore / totalWeight : 1.0;

  // Determine overall pass/fail
  // In log-only mode, we still compute passed for metric collection
  const failedValidators = Object.values(results).filter(r => !r.passed);
  const allPassed = failedValidators.length === 0;

  // Log detailed results (normal mode)
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

  // Handle blocking logic
  if (mode === "enforce" && !allPassed) {
    console.error(`[unified-validator] ❌ WOULD BLOCK IMAGE (mode=enforce)`);
  } else if (!allPassed) {
    nLog(`[unified-validator] ⚠️ Validation failed but not blocking (mode=log)`);
  }

  nLog(`[unified-validator] ===============================`);

  const hardFail = mode === "enforce" && !allPassed;
  const uniqueWarnings = Array.from(new Set(warnings));

  const finalResult: UnifiedValidationResult = {
    passed: hardFail ? false : true,
    hardFail,
    score: Math.round(aggregateScore * 1000) / 1000,
    reasons: hardFail ? reasons : [],
    warnings: uniqueWarnings,
    normalized: uniqueWarnings.includes("dimension_normalized"),
    raw: results,
    profile: softScene ? "SOFT" : "STRICT",
  };

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
  vLog(
    `[VAL][job=${jobId}] UnifiedStructural: ${result.passed ? "PASSED" : "FAILED"} ` +
    `(score=${result.score.toFixed(3)}, profile=${profile})`
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

  // Failures
  if (!result.passed && result.reasons.length > 0) {
    vLog(`[VAL][job=${jobId}]   failures=${result.reasons.join("; ")}`);
  }

  if (result.warnings.length > 0) {
    vLog(`[VAL][job=${jobId}]   warnings=${result.warnings.join("; ")}`);
  }
}
