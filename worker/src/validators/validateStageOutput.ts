/**
 * Two-Lane Validation Orchestrator
 *
 * Implements Option A: Local validators first, Gemini semantic second.
 * Produces a unified ValidatorReport with a single final decision.
 *
 * Flow:
 * 1. Run local validators (cheap/fast)
 * 2. If local hard-fail (fatal/risk) => skip Gemini (cost saving)
 * 3. Otherwise run Gemini stage-aware semantic validator
 * 4. Stage 2 only: run Gemini placement validator if semantic passes
 * 5. Combine results into final decision
 */

import { validateStructureStageAware } from "./structural/stageAwareValidator";
import { runMaskedEdgeValidator } from "./maskedEdgeValidator";
import { runSemanticStructureValidator } from "./semanticStructureValidator";
import { loadStageAwareConfig, type StageAwareConfig, type ValidationSummary as LocalValidationSummary } from "./stageAwareConfig";
import { getValidatorMode, shouldValidatorBlock } from "./validatorMode";
import {
  validateSemanticStageCompliance,
  validatePlacement,
  type SemanticStage,
  type SemanticValidationResult,
  type PlacementValidationResult,
} from "./geminiSemanticValidator";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type StageKey = "1A" | "1B_LIGHT" | "1B_FULL" | "2";

export interface ValidatorTrigger {
  id: string;
  fatal?: boolean;
  message?: string;
  value?: number;
  threshold?: number;
}

export interface LocalLaneResult {
  pass: boolean;
  risk: boolean;
  fatal: boolean;
  triggers: ValidatorTrigger[];
  metrics: Record<string, any>;
  summary: string;
}

export interface GeminiSemanticResult {
  pass: boolean;
  confidence: number;
  allowed_changes_only: boolean;
  reason: string;
  fail_reasons: string[];
  checks: {
    crop_or_reframe?: "pass" | "fail" | "unclear";
    perspective_change?: "pass" | "fail" | "unclear";
    architecture_preserved?: "pass" | "fail" | "unclear";
    openings_preserved?: "pass" | "fail" | "unclear";
    curtains_blinds_preserved?: "pass" | "fail" | "unclear";
    fixed_cabinetry_joinery_preserved?: "pass" | "fail" | "unclear";
    flooring_pattern_preserved?: "pass" | "fail" | "unclear";
    wall_ceiling_floor_boundaries?: "pass" | "fail" | "unclear";
    new_objects_added?: "pass" | "fail" | "unclear";
    furniture_removed_only?: "pass" | "fail" | "unclear";
    intent_match?: "pass" | "fail" | "unclear";
    [key: string]: "pass" | "fail" | "unclear" | undefined;
  };
  violations?: any[];
  raw?: string;
}

export interface GeminiPlacementResult {
  pass: boolean;
  verdict?: "pass" | "soft_fail" | "hard_fail";
  reasons?: string[];
  confidence?: number;
  reason?: string;
  raw?: string;
}

export interface GeminiLaneResult {
  semantic?: GeminiSemanticResult;
  placement?: GeminiPlacementResult;
  summary: string;
}

export type BlockedBy = "local" | "gemini_semantic" | "gemini_placement" | "gemini_parse_error" | "none";

export interface FinalDecision {
  pass: boolean;
  blockedBy: BlockedBy;
  reason: string;
  details?: any;
}

export interface ValidatorReport {
  stage: StageKey;
  baselinePath: string;
  candidatePath: string;
  ran: {
    localStructural: boolean;
    localMaskedEdge: boolean;
    localSemanticFallback: boolean;
    geminiSemantic: boolean;
    geminiPlacement: boolean;
  };
  skipped: {
    gemini: boolean;
    geminiReason?: "disabled" | "local_blocked" | "skip_requested";
  };
  latencyMs: {
    local: number;
    gemini: number;
    total: number;
  };
  local?: LocalLaneResult;
  gemini?: GeminiLaneResult;
  final: FinalDecision;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENV CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

function getSemanticConfig() {
  return {
    failClosed: process.env.SEMANTIC_VALIDATOR_FAIL_CLOSED !== "0", // default: true
    highConfThreshold: parseFloat(process.env.SEMANTIC_VALIDATOR_HIGH_CONF_THRESHOLD || "0.85"),
    logRaw: process.env.SEMANTIC_VALIDATOR_LOG_RAW === "1",
    enabled: process.env.SEMANTIC_VALIDATOR_ENABLED !== "0", // default: enabled
  };
}

function getLocalConfig() {
  return {
    // If "1" (default), local risk triggers (non-fatal but multi-signal) block in block mode
    // If "0", only fatal triggers block (more permissive)
    blockOnRisk: process.env.LOCAL_VALIDATOR_BLOCK_ON_RISK !== "0", // default: true (strict Option A)
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

function mapToSemanticStage(stage: StageKey): SemanticStage {
  switch (stage) {
    case "1B_LIGHT":
      return "1B_LIGHT";
    case "1B_FULL":
      return "1B_FULL";
    case "2":
      return "2";
    case "1A":
      // Stage 1A doesn't use semantic validator typically, but default to strictest
      return "1B_LIGHT";
    default:
      return "2";
  }
}

function mapToLocalStage(stage: StageKey): "stage1A" | "stage1B" | "stage2" {
  switch (stage) {
    case "1A":
      return "stage1A";
    case "1B_LIGHT":
    case "1B_FULL":
      return "stage1B";
    case "2":
      return "stage2";
    default:
      return "stage2";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL LANE
// ═══════════════════════════════════════════════════════════════════════════════

async function runLocalValidators(args: {
  stage: StageKey;
  baselinePath: string;
  candidatePath: string;
  sceneType?: "interior" | "exterior";
  roomType?: string;
  jobId?: string;
  config?: StageAwareConfig;
}): Promise<{
  result: LocalLaneResult;
  ran: { structural: boolean; maskedEdge: boolean; semanticFallback: boolean };
}> {
  const { stage, baselinePath, candidatePath, sceneType, roomType, jobId, config } = args;
  const stageAwareConfig = config || loadStageAwareConfig();
  const localStage = mapToLocalStage(stage);

  const triggers: ValidatorTrigger[] = [];
  const metrics: Record<string, any> = {};
  let ran = { structural: false, maskedEdge: false, semanticFallback: false };
  let structRisk = false;

  // Run stage-aware structural validator if enabled
  if (stageAwareConfig.enabled) {
    try {
      ran.structural = true;
      const mode = shouldValidatorBlock("structure") ? "block" : "log";
      const structResult: LocalValidationSummary = await validateStructureStageAware({
        stage: localStage,
        baselinePath,
        candidatePath,
        mode,
        jobId,
        sceneType,
        roomType,
        config: stageAwareConfig,
      });

      // Extract triggers
      for (const t of structResult.triggers) {
        triggers.push({
          id: t.id,
          fatal: t.fatal,
          message: t.message,
          value: t.value,
          threshold: t.threshold,
        });
      }

      // Extract metrics
      metrics.structuralIoU = structResult.metrics.structuralIoU;
      metrics.edgeIoU = structResult.metrics.edgeIoU;
      metrics.globalEdgeIoU = structResult.metrics.globalEdgeIoU;
      metrics.dimensionMismatch = structResult.debug?.dimensionMismatch;
      metrics.structuralScore = structResult.score;
      metrics.risk = structResult.risk;

      structRisk = !!structResult.risk;
    } catch (err: any) {
      console.error(`[VALIDATE_LOCAL] Structural validator error:`, err?.message);
      // Don't add fatal trigger for validator errors (fail-open for errors)
    }
  }

  // Run masked edge validator
  try {
    ran.maskedEdge = true;
    const maskedResult = await runMaskedEdgeValidator({
      originalImagePath: baselinePath,
      enhancedImagePath: candidatePath,
      scene: sceneType || "interior",
      mode: "log",
      stage: localStage === "stage1B" ? "stage1B" : "stage2",
    });

    if (maskedResult) {
      metrics.maskedEdgeDrift = maskedResult.maskedEdgeDrift;
      metrics.createdOpenings = maskedResult.createdOpenings;
      metrics.closedOpenings = maskedResult.closedOpenings;

      const openingsMinDelta = stage === "2" ? stageAwareConfig.stage2Thresholds.openingsMinDelta : 1;
      const openingsDelta = Math.abs(maskedResult.createdOpenings) + Math.abs(maskedResult.closedOpenings);

      // Add triggers for openings changes (significant for Stage 1B/2)
      if (maskedResult.createdOpenings > 0 && openingsDelta >= openingsMinDelta) {
        triggers.push({
          id: "masked_edge_openings_created",
          message: `${maskedResult.createdOpenings} openings created`,
          value: maskedResult.createdOpenings,
          threshold: 0,
        });
      }
      if (maskedResult.closedOpenings > 0 && openingsDelta >= openingsMinDelta) {
        triggers.push({
          id: "masked_edge_openings_closed",
          message: `${maskedResult.closedOpenings} openings closed`,
          value: maskedResult.closedOpenings,
          threshold: 0,
        });
      }
    }
  } catch (err: any) {
    console.error(`[VALIDATE_LOCAL] Masked edge validator error:`, err?.message);
  }

  // Run semantic structure validator as fallback check
  try {
    ran.semanticFallback = true;
    const semResult = await runSemanticStructureValidator({
      originalImagePath: baselinePath,
      enhancedImagePath: candidatePath,
      scene: sceneType || "interior",
      mode: "log",
    });

    if (semResult) {
      metrics.windowsBefore = semResult.windows.before;
      metrics.windowsAfter = semResult.windows.after;
      metrics.windowsChange = semResult.windows.change;
      metrics.semanticPassed = semResult.passed;

      // Window count change is a significant trigger
      if (semResult.windows.change !== 0) {
        triggers.push({
          id: "semantic_window_count_change",
          fatal: stage !== "1A", // Fatal for 1B and 2
          message: `Window count changed: ${semResult.windows.before} -> ${semResult.windows.after}`,
          value: Math.abs(semResult.windows.change),
          threshold: 0,
        });
      }
    }
  } catch (err: any) {
    console.error(`[VALIDATE_LOCAL] Semantic structure validator error:`, err?.message);
  }

  // Determine pass/risk/fatal
  const hasFatal = triggers.some((t) => t.fatal === true);
  const hasRisk = structRisk || hasFatal || triggers.length >= (stageAwareConfig.gateMinSignals || 2);
  const pass = !hasRisk;

  // Build summary
  const topTriggers = triggers
    .filter((t) => t.fatal || t.value !== undefined)
    .slice(0, 3)
    .map((t) => t.id)
    .join(", ");

  const summary = pass
    ? `Local OK: score=${metrics.structuralScore?.toFixed(2) || "N/A"}`
    : `Local FAIL: fatal=${hasFatal}, triggers=[${topTriggers}]`;

  return {
    result: {
      pass,
      risk: hasRisk,
      fatal: hasFatal,
      triggers,
      metrics,
      summary,
    },
    ran,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI LANE
// ═══════════════════════════════════════════════════════════════════════════════

async function runGeminiValidators(args: {
  stage: StageKey;
  baselinePath: string;
  candidatePath: string;
}): Promise<{
  result: GeminiLaneResult;
  ran: { semantic: boolean; placement: boolean };
  semanticRaw?: SemanticValidationResult;
  placementRaw?: PlacementValidationResult;
}> {
  const { stage, baselinePath, candidatePath } = args;
  const semanticStage = mapToSemanticStage(stage);
  const config = getSemanticConfig();

  let ran = { semantic: false, placement: false };
  let semanticResult: GeminiSemanticResult | undefined;
  let placementResult: GeminiPlacementResult | undefined;
  let semanticRaw: SemanticValidationResult | undefined;
  let placementRaw: PlacementValidationResult | undefined;

  // Run semantic validator
  ran.semantic = true;
  semanticRaw = await validateSemanticStageCompliance({
    stage: semanticStage,
    baselineImagePath: baselinePath,
    candidateImagePath: candidatePath,
  });

  if (semanticRaw.parsed) {
    semanticResult = {
      pass: semanticRaw.parsed.pass,
      confidence: semanticRaw.parsed.confidence,
      allowed_changes_only: semanticRaw.parsed.allowed_changes_only,
      reason: semanticRaw.parsed.reason,
      fail_reasons: semanticRaw.parsed.fail_reasons,
      checks: { ...semanticRaw.parsed.checks } as GeminiSemanticResult["checks"],
      violations: semanticRaw.parsed.violations,
      raw: config.logRaw ? semanticRaw.rawText : undefined,
    };
  }

  // Run placement validator for Stage 2 only, and only if semantic passed
  if (stage === "2" && semanticResult?.pass) {
    ran.placement = true;
    placementRaw = await validatePlacement({
      baselineImagePath: baselinePath,
      candidateImagePath: candidatePath,
    });

    placementResult = {
      pass: placementRaw.pass,
      verdict: placementRaw.verdict,
      reasons: placementRaw.reasons,
      confidence: placementRaw.confidence,
      reason: placementRaw.reason,
      raw: config.logRaw ? placementRaw.rawText : undefined,
    };
  }

  // Build summary
  let summary: string;
  if (!semanticResult) {
    summary = "Gemini: parse failed";
  } else if (!semanticResult.pass) {
    summary = `Gemini semantic FAIL: conf=${semanticResult.confidence.toFixed(2)}, reason=${semanticResult.reason}`;
  } else if (placementResult && placementResult.verdict === "hard_fail") {
    summary = `Gemini placement FAIL: ${placementResult.reason || "unknown"}`;
  } else if (placementResult && placementResult.verdict === "soft_fail") {
    summary = `Gemini placement WARN (soft_fail): ${placementResult.reason || "minor issue"}`;
  } else {
    summary = `Gemini OK: semantic conf=${semanticResult.confidence.toFixed(2)}`;
  }

  return {
    result: {
      semantic: semanticResult,
      placement: placementResult,
      summary,
    },
    ran,
    semanticRaw,
    placementRaw,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

export async function validateStageOutput(args: {
  stage: StageKey;
  baselinePath: string;
  candidatePath: string;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  jobId?: string;
  config?: StageAwareConfig;
  skipGemini?: boolean; // For testing or cost control
}): Promise<ValidatorReport> {
  const {
    stage,
    baselinePath,
    candidatePath,
    roomType,
    sceneType,
    jobId,
    config,
    skipGemini = false,
  } = args;

  const semanticConfig = getSemanticConfig();
  const localConfig = getLocalConfig();
  const totalStart = Date.now();

  const report: ValidatorReport = {
    stage,
    baselinePath,
    candidatePath,
    ran: {
      localStructural: false,
      localMaskedEdge: false,
      localSemanticFallback: false,
      geminiSemantic: false,
      geminiPlacement: false,
    },
    skipped: {
      gemini: false,
    },
    latencyMs: {
      local: 0,
      gemini: 0,
      total: 0,
    },
    final: {
      pass: false,
      blockedBy: "none",
      reason: "",
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LANE 1: LOCAL VALIDATORS
  // ─────────────────────────────────────────────────────────────────────────────
  const localStart = Date.now();
  const localResult = await runLocalValidators({
    stage,
    baselinePath,
    candidatePath,
    sceneType,
    roomType,
    jobId,
    config,
  });
  report.latencyMs.local = Date.now() - localStart;

  report.ran.localStructural = localResult.ran.structural;
  report.ran.localMaskedEdge = localResult.ran.maskedEdge;
  report.ran.localSemanticFallback = localResult.ran.semanticFallback;
  report.local = localResult.result;

  // Check if local validators block
  const blockMode = shouldValidatorBlock("structure");

  if (localResult.result.fatal) {
    // Fatal trigger always blocks
    const topTriggers = localResult.result.triggers
      .filter((t) => t.fatal)
      .slice(0, 2)
      .map((t) => t.id)
      .join(", ");

    report.skipped = { gemini: true, geminiReason: "local_blocked" };
    report.latencyMs.total = Date.now() - totalStart;
    report.final = {
      pass: false,
      blockedBy: "local",
      reason: `Fatal local trigger: ${topTriggers}`,
      details: { fatalTriggers: localResult.result.triggers.filter((t) => t.fatal) },
    };

    console.log(
      `[VALIDATE_LOCAL_FAIL] stage=${stage} fatal=true triggers=[${topTriggers}]`
    );
    console.log(
      `[VALIDATE_FINAL_FAIL] stage=${stage} blockedBy=local reason="${report.final.reason}"`
    );

    return report;
  }

  if (blockMode && localConfig.blockOnRisk && localResult.result.risk && stage !== "2") {
    // Risk in block mode blocks (controlled by LOCAL_VALIDATOR_BLOCK_ON_RISK)
    const topTriggers = localResult.result.triggers
      .slice(0, 2)
      .map((t) => t.id)
      .join(", ");

    report.skipped = { gemini: true, geminiReason: "local_blocked" };
    report.latencyMs.total = Date.now() - totalStart;
    report.final = {
      pass: false,
      blockedBy: "local",
      reason: `Local risk detected in block mode: ${topTriggers}`,
      details: { triggers: localResult.result.triggers },
    };

    console.log(
      `[VALIDATE_LOCAL_FAIL] stage=${stage} fatal=false risk=true triggers=[${topTriggers}]`
    );
    console.log(
      `[VALIDATE_FINAL_FAIL] stage=${stage} blockedBy=local reason="${report.final.reason}"`
    );

    return report;
  }

  // Local passed
  console.log(`[VALIDATE_LOCAL_OK] stage=${stage} ${report.local?.summary || ""}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // LANE 2: GEMINI VALIDATORS (only if local passes)
  // ─────────────────────────────────────────────────────────────────────────────
  if (skipGemini) {
    report.skipped = { gemini: true, geminiReason: "skip_requested" };
    report.latencyMs.total = Date.now() - totalStart;
    report.final = {
      pass: true,
      blockedBy: "none",
      reason: "Local passed, Gemini skipped (skip_requested)",
    };

    console.log(
      `[VALIDATE_FINAL_OK] stage=${stage} ranLocal=1 ranGem=0 placement=0 geminiSkipped=skip_requested`
    );

    return report;
  }

  if (!semanticConfig.enabled) {
    report.skipped = { gemini: true, geminiReason: "disabled" };
    report.latencyMs.total = Date.now() - totalStart;
    report.final = {
      pass: true,
      blockedBy: "none",
      reason: "Local passed, Gemini skipped (disabled)",
    };

    console.log(
      `[VALIDATE_FINAL_OK] stage=${stage} ranLocal=1 ranGem=0 placement=0 geminiSkipped=disabled`
    );

    return report;
  }

  // Run Gemini validators
  const geminiStart = Date.now();
  const geminiResult = await runGeminiValidators({
    stage,
    baselinePath,
    candidatePath,
  });
  report.latencyMs.gemini = Date.now() - geminiStart;

  report.ran.geminiSemantic = geminiResult.ran.semantic;
  report.ran.geminiPlacement = geminiResult.ran.placement;
  report.gemini = geminiResult.result;

  // Check Gemini semantic result
  const semantic = geminiResult.result.semantic;

  if (!semantic) {
    // Parse failed
    if (semanticConfig.failClosed && (stage === "1B_LIGHT" || stage === "1B_FULL" || stage === "2")) {
      report.latencyMs.total = Date.now() - totalStart;
      report.final = {
        pass: false,
        blockedBy: "gemini_parse_error",
        reason: "Gemini semantic JSON parse failed (fail-closed)",
        details: { error: geminiResult.semanticRaw?.error },
      };

      console.log(
        `[VALIDATE_FINAL_FAIL] stage=${stage} blockedBy=gemini_parse_error reason="JSON parse failed"`
      );

      return report;
    } else {
      // Stage 1A or fail-open: pass with warning
      console.warn(`[SEMANTIC_VALIDATOR] Parse failed but allowing (stage=${stage}, failClosed=${semanticConfig.failClosed})`);
    }
  } else if (!semantic.pass) {
    // Semantic failed
    const highConf = semantic.confidence >= semanticConfig.highConfThreshold;

    // Pattern A (strict): Block if fail-closed OR high confidence
    // Pattern B (lenient): Would require high confidence AND fail-closed, but we use A by default
    // Current behavior: If failClosed=true (default), we block on any semantic fail
    // If failClosed=false AND confidence < threshold, we warn but allow
    if (highConf || semanticConfig.failClosed) {
      report.latencyMs.total = Date.now() - totalStart;
      report.final = {
        pass: false,
        blockedBy: "gemini_semantic",
        reason: `Gemini semantic failed: ${semantic.reason} (conf=${semantic.confidence.toFixed(2)})`,
        details: {
          confidence: semantic.confidence,
          fail_reasons: semantic.fail_reasons,
          checks: semantic.checks,
        },
      };

      console.log(
        `[SEMANTIC_FAIL] stage=${stage} confidence=${semantic.confidence.toFixed(2)} ` +
          `fail_reasons=[${semantic.fail_reasons.slice(0, 3).join(", ")}] ` +
          `keyChecks={arch=${semantic.checks.architecture_preserved},open=${semantic.checks.openings_preserved}}`
      );
      console.log(
        `[VALIDATE_FINAL_FAIL] stage=${stage} blockedBy=gemini_semantic reason="${report.final.reason}"`
      );

      return report;
    } else {
      // Low confidence AND fail-closed=false: warn but continue (Pattern B behavior)
      console.warn(
        `[SEMANTIC_WARN] stage=${stage} semantic.pass=false but conf=${semantic.confidence.toFixed(2)} < threshold and failClosed=false, allowing`
      );
    }
  } else {
    // Semantic passed
    console.log(
      `[SEMANTIC_OK] stage=${stage} confidence=${semantic.confidence.toFixed(2)}`
    );
  }

  // Check placement for Stage 2
  if (stage === "2" && geminiResult.ran.placement) {
    const placement = geminiResult.result.placement;

    if (placement && placement.verdict === "hard_fail") {
      report.latencyMs.total = Date.now() - totalStart;
      report.final = {
        pass: false,
        blockedBy: "gemini_placement",
        reason: `Gemini placement failed: ${placement.reason || "unknown"}`,
        details: { confidence: placement.confidence },
      };

      console.log(
        `[VALIDATE_FINAL_FAIL] stage=${stage} blockedBy=gemini_placement reason="${report.final.reason}"`
      );

      return report;
    }
  }

  // All checks passed
  report.latencyMs.total = Date.now() - totalStart;
  report.final = {
    pass: true,
    blockedBy: "none",
    reason: "All validators passed",
  };

  console.log(
    `[VALIDATE_FINAL_OK] stage=${stage} ranLocal=1 ranGem=${report.ran.geminiSemantic ? 1 : 0} placement=${report.ran.geminiPlacement ? 1 : 0} latencyMs=${report.latencyMs.total}`
  );

  return report;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { validateSemanticStageCompliance, validatePlacement } from "./geminiSemanticValidator";
