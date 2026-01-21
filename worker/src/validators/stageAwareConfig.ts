/**
 * Stage-Aware Structural Validation Configuration
 *
 * This module provides configuration for the stage-aware structural validation system.
 * All settings are configurable via environment variables with sensible defaults.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENV VAR DOCUMENTATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * EXISTING ENV VARS (backward compatible):
 * - STRUCTURE_VALIDATOR_MODE: "off" | "log" | "retry" | "block" (default: "off")
 * - STRUCTURE_VALIDATOR_SENSITIVITY: Line deviation in degrees (default: 5.0)
 * - STRUCT_VALIDATION_STAGE_AWARE: "0" | "1" (default: "0")
 * - STRUCT_VALIDATION_LOG_ARTIFACTS_ON_FAIL: "0" | "1" (default: "1")
 * - STRUCT_VALIDATION_MAX_RETRY_ATTEMPTS: number (default: 3)
 *
 * NEW STAGE 1A THRESHOLD ENV VARS:
 * - STRUCT_VALIDATION_STAGE1A_EDGE_IOU_MIN: 0.0-1.0 (default: 0.60)
 * - STRUCT_VALIDATION_STAGE1A_STRUCT_IOU_MIN: 0.0-1.0 (default: 0.30)
 *
 * NEW STAGE 1B THRESHOLD ENV VARS (declutter/furniture removal):
 * - STRUCT_VALIDATION_STAGE1B_EDGE_IOU_MIN: 0.0-1.0 (default: 0.50)
 * - STRUCT_VALIDATION_STAGE1B_STRUCT_IOU_MIN: 0.0-1.0 (default: 0.40)
 * - STRUCT_VALIDATION_STAGE1B_LINEEDGE_MIN: 0.0-1.0 (default: 0.60)
 * - STRUCT_VALIDATION_STAGE1B_UNIFIED_MIN: 0.0-1.0 (default: 0.55)
 * - STRUCT_VALIDATION_STAGE1B_EDGE_MODE: "global" | "structure_only" | "exclude_lower" (default: "structure_only")
 * - STRUCT_VALIDATION_STAGE1B_EXCLUDE_LOWER_PCT: 0.0-1.0 (default: 0.20)
 *
 * STAGE 1B HARD-FAIL SWITCHES (separate from global, defaults tuned for furniture removal):
 * - STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_COUNT_CHANGE: "0" | "1" (default: "1" - ON)
 * - STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_POSITION_CHANGE: "0" | "1" (default: "0" - OFF)
 * - STRUCT_VALIDATION_STAGE1B_BLOCK_ON_OPENINGS_DELTA: "0" | "1" (default: "0" - OFF, furniture near doors can trigger false positives)
 *
 * NEW STAGE 2 THRESHOLD ENV VARS:
 * - STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN: 0.0-1.0 (default: 0.60)
 * - STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN: 0.0-1.0 (default: 0.55)
 * - STRUCT_VALIDATION_STAGE2_LINEEDGE_MIN: 0.0-1.0 (default: 0.70)
 * - STRUCT_VALIDATION_STAGE2_UNIFIED_MIN: 0.0-1.0 (default: 0.65)
 *
 * HARD-FAIL SWITCHES (Stage2 global defaults):
 * - STRUCT_VALIDATION_BLOCK_ON_WINDOW_COUNT_CHANGE: "0" | "1" (default: "1")
 * - STRUCT_VALIDATION_BLOCK_ON_WINDOW_POSITION_CHANGE: "0" | "1" (default: "0")
 * - STRUCT_VALIDATION_BLOCK_ON_OPENINGS_DELTA: "0" | "1" (default: "0")
 * - STRUCT_VALIDATION_BLOCK_ON_DIMENSION_MISMATCH: "0" | "1" (default: "1")
 *
 * LINE + OPENINGS + LOW-EDGE ENHANCEMENTS:
 * - STRUCT_VALIDATION_STAGE1B_MASKED_DRIFT_MAX: 0.0-1.0 (default: 0.30)
 * - STRUCT_VALIDATION_STAGE1B_OPENINGS_CREATE_MAX: 0.0-5.0 (default: 0)
 * - STRUCT_VALIDATION_STAGE1B_OPENINGS_CLOSE_MAX: 0.0-5.0 (default: 0)
 * - STRUCT_VALIDATION_STAGE2_MASKED_DRIFT_MAX: 0.0-1.0 (default: 0.30)
 * - STRUCT_VALIDATION_STAGE2_OPENINGS_CREATE_MAX: 0.0-5.0 (default: 0)
 * - STRUCT_VALIDATION_STAGE2_OPENINGS_CLOSE_MAX: 0.0-5.0 (default: 0)
 * - STRUCT_VALIDATION_LOWEDGE_ENABLE: "0" | "1" (default: "1")
 * - STRUCT_VALIDATION_LOWEDGE_DENSITY_MAX: 0.0-1.0 (default: 0.045)
 * - STRUCT_VALIDATION_LOWEDGE_CENTER_CROP_RATIO: 0.0-1.0 (default: 0.6)
 * - STRUCT_VALIDATION_LOWEDGE_SKIP_EDGE_IOU: "0" | "1" (default: "1")
 */

export type StageId = "stage1A" | "stage1B" | "stage2";

// ═══════════════════════════════════════════════════════════════════════════════
// ENV PARSING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a float from env var with default, clamped to [0,1] range with warning
 */
export function parseEnvFloat01(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`[stageAwareConfig] Invalid float for ${envKey}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < 0 || parsed > 1) {
    const clamped = Math.max(0, Math.min(1, parsed));
    console.warn(`[stageAwareConfig] ${envKey}=${parsed} out of range [0,1], clamping to ${clamped}`);
    return clamped;
  }
  return parsed;
}

/**
 * Parse a boolean from env var (truthy if "1" or "true")
 */
export function parseEnvBool(envKey: string, defaultValue: boolean): boolean {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Parse an integer from env var with default
 */
export function parseEnvInt(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`[stageAwareConfig] Invalid int for ${envKey}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a float from env var with default (no range clamping)
 */
export function parseEnvFloat(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`[stageAwareConfig] Invalid float for ${envKey}="${raw}", using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 1A THRESHOLD CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface Stage1AThresholds {
  /** Minimum global edge IoU for Stage 1A */
  edgeIouMin: number;
  /** Minimum structural mask IoU for Stage 1A */
  structIouMin: number;
}

/**
 * Load Stage 1A thresholds from environment variables
 */
export function loadStage1AThresholds(): Stage1AThresholds {
  return {
    edgeIouMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE1A_EDGE_IOU_MIN", 0.60),
    structIouMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE1A_STRUCT_IOU_MIN", 0.30),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 1B THRESHOLD CONFIGURATION (declutter/furniture removal)
// ═══════════════════════════════════════════════════════════════════════════════

export interface Stage1BThresholds {
  /** Minimum global edge IoU for Stage 1B (looser than 1A since furniture removal changes edges) */
  edgeIouMin: number;
  /** Minimum structural mask IoU for Stage 1B */
  structIouMin: number;
  /** Minimum line/edge score for Stage 1B */
  lineEdgeMin: number;
  /** Minimum unified structural score for Stage 1B */
  unifiedMin: number;
  /** Edge comparison mode: "global" | "structure_only" | "exclude_lower" */
  edgeMode: "global" | "structure_only" | "exclude_lower";
  /** Percentage of image bottom to exclude when edgeMode=exclude_lower */
  excludeLowerPct: number;
  /** Maximum allowed masked edge drift before triggering */
  maskedDriftMax: number;
  /** Maximum allowed created openings */
  openingsCreateMax: number;
  /** Maximum allowed closed openings */
  openingsCloseMax: number;
}

/**
 * Load Stage 1B thresholds from environment variables
 * Defaults are looser than Stage 1A since furniture removal legitimately changes edges
 */
export function loadStage1BThresholds(): Stage1BThresholds {
  return {
    edgeIouMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE1B_EDGE_IOU_MIN", 0.50),
    structIouMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE1B_STRUCT_IOU_MIN", 0.40),
    lineEdgeMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE1B_LINEEDGE_MIN", 0.60),
    unifiedMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE1B_UNIFIED_MIN", 0.55),
    edgeMode: parseEdgeMode(process.env.STRUCT_VALIDATION_STAGE1B_EDGE_MODE),
    excludeLowerPct: parseEnvFloat01("STRUCT_VALIDATION_STAGE1B_EXCLUDE_LOWER_PCT", 0.20),
    maskedDriftMax: parseEnvFloat01("STRUCT_VALIDATION_STAGE1B_MASKED_DRIFT_MAX", 0.30),
    openingsCreateMax: parseEnvFloat("STRUCT_VALIDATION_STAGE1B_OPENINGS_CREATE_MAX", 0),
    openingsCloseMax: parseEnvFloat("STRUCT_VALIDATION_STAGE1B_OPENINGS_CLOSE_MAX", 0),
  };
}

/**
 * Stage 1B hard-fail switches (separate from global switches)
 * Defaults tuned for furniture removal: window count ON, others OFF
 */
export interface Stage1BHardFailSwitches {
  /** Block on window count change (default: true - windows should not disappear during declutter) */
  blockOnWindowCountChange: boolean;
  /** Block on window position change (default: false - furniture near windows can affect detection) */
  blockOnWindowPositionChange: boolean;
  /** Block on openings delta (default: false - furniture near doorways can trigger false positives) */
  blockOnOpeningsDelta: boolean;
}

/**
 * Load Stage 1B hard-fail switches from environment variables
 */
export function loadStage1BHardFailSwitches(): Stage1BHardFailSwitches {
  return {
    blockOnWindowCountChange: parseEnvBool("STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_COUNT_CHANGE", true),
    blockOnWindowPositionChange: parseEnvBool("STRUCT_VALIDATION_STAGE1B_BLOCK_ON_WINDOW_POSITION_CHANGE", false),
    blockOnOpeningsDelta: parseEnvBool("STRUCT_VALIDATION_STAGE1B_BLOCK_ON_OPENINGS_DELTA", false),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 2 THRESHOLD CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface Stage2Thresholds {
  /** Minimum global edge IoU for Stage 2 */
  edgeIouMin: number;
  /** Minimum structural mask IoU for Stage 2 */
  structIouMin: number;
  /** Minimum line/edge score for Stage 2 */
  lineEdgeMin: number;
  /** Minimum unified structural score for Stage 2 */
  unifiedMin: number;
  /** Maximum allowed masked edge drift before triggering */
  maskedDriftMax: number;
  /** Maximum allowed created openings */
  openingsCreateMax: number;
  /** Maximum allowed closed openings */
  openingsCloseMax: number;
}

/**
 * Load Stage 2 thresholds from environment variables
 */
export function loadStage2Thresholds(): Stage2Thresholds {
  return {
    edgeIouMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE2_EDGE_IOU_MIN", 0.60),
    structIouMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE2_STRUCT_IOU_MIN", 0.55),
    lineEdgeMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE2_LINEEDGE_MIN", 0.70),
    unifiedMin: parseEnvFloat01("STRUCT_VALIDATION_STAGE2_UNIFIED_MIN", 0.65),
    maskedDriftMax: parseEnvFloat01("STRUCT_VALIDATION_STAGE2_MASKED_DRIFT_MAX", 0.30),
    openingsCreateMax: parseEnvFloat("STRUCT_VALIDATION_STAGE2_OPENINGS_CREATE_MAX", 0),
    openingsCloseMax: parseEnvFloat("STRUCT_VALIDATION_STAGE2_OPENINGS_CLOSE_MAX", 0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HARD-FAIL SWITCHES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HardFailSwitches {
  /** Block on window count change (default: false for safety) */
  blockOnWindowCountChange: boolean;
  /** Block on window position change (default: false for safety) */
  blockOnWindowPositionChange: boolean;
  /** Block on openings delta (+1 or -1 openings) (default: false for safety) */
  blockOnOpeningsDelta: boolean;
}

/**
 * Load hard-fail switches from environment variables
 * Default to false for safety - only enable when explicitly set
 */
export function loadHardFailSwitches(): HardFailSwitches {
  return {
    blockOnWindowCountChange: parseEnvBool("STRUCT_VALIDATION_BLOCK_ON_WINDOW_COUNT_CHANGE", true),
    blockOnWindowPositionChange: parseEnvBool("STRUCT_VALIDATION_BLOCK_ON_WINDOW_POSITION_CHANGE", false),
    blockOnOpeningsDelta: parseEnvBool("STRUCT_VALIDATION_BLOCK_ON_OPENINGS_DELTA", false),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CONFIG INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

export interface StageAwareConfig {
  /** Feature flag - when disabled, uses legacy validators */
  enabled: boolean;
  /** Edge comparison mode for Stage2: "global" | "structure_only" | "exclude_lower" */
  stage2EdgeMode: "global" | "structure_only" | "exclude_lower";
  /** Percentage of image bottom to exclude when edgeMode=exclude_lower (0.0-1.0) */
  stage2ExcludeLowerPct: number;
  /** Minimum number of independent triggers required to mark risk */
  gateMinSignals: number;
  /** Minimum ratio of nonzero structural pixels required to compute IoU */
  iouMinPixelsRatio: number;
  /** Save debug artifacts to /tmp when risk triggers */
  logArtifactsOnFail: boolean;
  /** Maximum retry attempts per stage */
  maxRetryAttempts: number;

  /** Low-edge handling */
  lowEdgeEnable: boolean;
  lowEdgeEdgeDensityMax: number;
  lowEdgeCenterCropRatio: number;
  lowEdgeSkipEdgeIoU: boolean;

  /** Paint-over / opening suppression detector (Stage2) */
  paintOverEnable: boolean;
  paintOverEdgeRatioMin: number;
  paintOverTexRatioMin: number;
  paintOverMinRoiArea: number;

  /** Stage 1A thresholds */
  stage1AThresholds: Stage1AThresholds;

  /** Stage 1B thresholds (declutter/furniture removal) */
  stage1BThresholds: Stage1BThresholds;

  /** Stage 1B hard-fail switches (separate from global) */
  stage1BHardFailSwitches: Stage1BHardFailSwitches;

  /** Stage 2 thresholds */
  stage2Thresholds: Stage2Thresholds;

  /** Hard-fail switches (global, used by Stage 2) */
  hardFailSwitches: HardFailSwitches;

  /** Whether dimension mismatch should be fatal (default: true) */
  blockOnDimensionMismatch: boolean;
}

/**
 * Load stage-aware configuration from environment variables
 */
// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 2 BASELINE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chooses the correct baseline for Stage 2 structural validation.
 *
 * POLICY:
 * - If Stage 1B ran and produced valid output → compare Stage 2 vs Stage 1B
 * - Otherwise → compare Stage 2 vs Stage 1A
 *
 * This ensures we're comparing against the most recent predecessor stage,
 * since 1B's changes (furniture removal) are expected and shouldn't be
 * flagged as structural issues in Stage 2.
 */
export function chooseStage2Baseline(opts: {
  stage1APath: string;
  stage1BPath?: string | null;
}): { baselinePath: string; baselineStage: "1A" | "1B" } {
  const { stage1APath, stage1BPath } = opts;

  // If Stage 1B ran and produced valid output, use it as baseline
  if (stage1BPath && stage1BPath !== stage1APath) {
    return {
      baselinePath: stage1BPath,
      baselineStage: "1B",
    };
  }

  // Otherwise use Stage 1A
  return {
    baselinePath: stage1APath,
    baselineStage: "1A",
  };
}

export function loadStageAwareConfig(): StageAwareConfig {
  const config: StageAwareConfig = {
    enabled: parseEnvBool("STRUCT_VALIDATION_STAGE_AWARE", false),
    stage2EdgeMode: parseEdgeMode(process.env.STRUCT_VALIDATION_STAGE2_EDGE_MODE),
    stage2ExcludeLowerPct: parseEnvFloat01("STRUCT_VALIDATION_STAGE2_EXCLUDE_LOWER_PCT", 0.40),
    gateMinSignals: parseEnvInt("STRUCT_VALIDATION_GATE_MIN_SIGNALS", 2),
    iouMinPixelsRatio: parseEnvFloat01("STRUCT_VALIDATION_IOU_MIN_PIXELS_RATIO", 0.005),
    logArtifactsOnFail: parseEnvBool("STRUCT_VALIDATION_LOG_ARTIFACTS_ON_FAIL", true),
    maxRetryAttempts: parseEnvInt("STRUCT_VALIDATION_MAX_RETRY_ATTEMPTS", 3),

    lowEdgeEnable: parseEnvBool("STRUCT_VALIDATION_LOWEDGE_ENABLE", true),
    lowEdgeEdgeDensityMax: parseEnvFloat01("STRUCT_VALIDATION_LOWEDGE_DENSITY_MAX", 0.045),
    lowEdgeCenterCropRatio: parseEnvFloat01("STRUCT_VALIDATION_LOWEDGE_CENTER_CROP_RATIO", 0.6),
    lowEdgeSkipEdgeIoU: parseEnvBool("STRUCT_VALIDATION_LOWEDGE_SKIP_EDGE_IOU", true),

    paintOverEnable: parseEnvBool("STRUCT_VALIDATION_PAINTOVER_ENABLE", true),
    paintOverEdgeRatioMin: parseEnvFloat01("STRUCT_VALIDATION_PAINTOVER_EDGE_RATIO_MIN", 0.35),
    paintOverTexRatioMin: parseEnvFloat01("STRUCT_VALIDATION_PAINTOVER_TEX_RATIO_MIN", 0.45),
    paintOverMinRoiArea: parseEnvFloat01("STRUCT_VALIDATION_PAINTOVER_MIN_ROI_AREA", 0.005),

    // Stage 1A thresholds
    stage1AThresholds: loadStage1AThresholds(),

    // Stage 1B thresholds (declutter/furniture removal)
    stage1BThresholds: loadStage1BThresholds(),

    // Stage 1B hard-fail switches
    stage1BHardFailSwitches: loadStage1BHardFailSwitches(),

    // Stage 2 thresholds
    stage2Thresholds: loadStage2Thresholds(),

    // Hard-fail switches (global, used by Stage 2)
    hardFailSwitches: loadHardFailSwitches(),

    // Dimension mismatch fatal toggle (default ON)
    blockOnDimensionMismatch: parseEnvBool("STRUCT_VALIDATION_BLOCK_ON_DIMENSION_MISMATCH", true),
  };

  // Log config on first load for debugging
  console.log(`[stageAwareConfig] Loaded config:`, {
    enabled: config.enabled,
    stage2EdgeMode: config.stage2EdgeMode,
    gateMinSignals: config.gateMinSignals,
    stage1AThresholds: config.stage1AThresholds,
    stage1BThresholds: config.stage1BThresholds,
    stage1BHardFailSwitches: config.stage1BHardFailSwitches,
    stage2Thresholds: config.stage2Thresholds,
    hardFailSwitches: config.hardFailSwitches,
    blockOnDimensionMismatch: config.blockOnDimensionMismatch,
    lowEdge: {
      enable: config.lowEdgeEnable,
      densityMax: config.lowEdgeEdgeDensityMax,
      centerCrop: config.lowEdgeCenterCropRatio,
      skipEdgeIoU: config.lowEdgeSkipEdgeIoU,
    },
  });

  return config;
}

function parseEdgeMode(value: string | undefined): "global" | "structure_only" | "exclude_lower" {
  if (value === "global" || value === "structure_only" || value === "exclude_lower") {
    return value;
  }
  return "structure_only"; // default
}

/**
 * Stage-specific thresholds for structural validation
 */
export interface StageThresholds {
  /** Maximum line deviation in degrees */
  lineDeviationDegMax: number;
  /** Minimum global edge IoU (Stage1A) */
  globalEdgeIouMin?: number;
  /** Minimum structural mask IoU */
  structuralMaskIouMin: number;
  /** Whether window count change is fatal (blocks) vs contributes to gating */
  windowCountChangeFatal: boolean;
  /** Maximum wall drift percentage before triggering */
  semanticWallDriftMax: number;
  /** Maximum allowed new openings before triggering */
  semanticOpeningsMax: number;
  /** Maximum masked drift percentage before triggering */
  maskedDriftMax: number;
  /** Maximum allowed created openings (masked edge) */
  openingsCreateMax?: number;
  /** Maximum allowed closed openings (masked edge) */
  openingsCloseMax?: number;
}

/**
 * Stage-specific thresholds
 * - Stage1A: Stricter (enhancement should not change structure)
 * - Stage2: Looser (staging adds furniture, edges change)
 */
export const STAGE_THRESHOLDS: Record<"stage1A" | "stage2", StageThresholds> = {
  stage1A: {
    lineDeviationDegMax: 5.0,
    globalEdgeIouMin: 0.60,
    structuralMaskIouMin: 0.30,
    windowCountChangeFatal: true,
    semanticWallDriftMax: 0.20,
    semanticOpeningsMax: 0,
    maskedDriftMax: 0.25,
    openingsCreateMax: 0,
    openingsCloseMax: 0,
  },
  stage2: {
    lineDeviationDegMax: 5.0,
    // edgeIouMin depends on edgeMode - use getStage2EdgeIouMin()
    structuralMaskIouMin: 0.15,
    windowCountChangeFatal: false, // staging should not fail on tiny window artifacts
    semanticWallDriftMax: 0.25,
    semanticOpeningsMax: 0,
    maskedDriftMax: 0.30,
    openingsCreateMax: 0,
    openingsCloseMax: 0,
  },
};

/**
 * Get the minimum edge IoU threshold for Stage2 based on edge mode
 */
export function getStage2EdgeIouMin(edgeMode: "global" | "structure_only" | "exclude_lower"): number {
  switch (edgeMode) {
    case "structure_only":
      return 0.45;
    case "exclude_lower":
      return 0.35;
    case "global":
      return 0.25;
    default:
      return 0.35;
  }
}

/**
 * IoU computation result with metadata for proper handling
 */
export interface IoUResult {
  /** The computed IoU value, or null if computation was skipped */
  value: number | null;
  /** If value is null, explains why computation was skipped */
  skipReason?: "union_zero" | "mask_too_small" | "dimension_mismatch" | "computation_error";
  /** Debug metrics */
  debug: {
    intersectionPixels?: number;
    unionPixels?: number;
    maskAPixels?: number;
    maskBPixels?: number;
    maskARatio?: number;
    maskBRatio?: number;
  };
}

/**
 * Validation trigger from an individual check
 */
export interface ValidationTrigger {
  /** Unique identifier for the trigger type */
  id: string;
  /** Human-readable description of what triggered */
  message: string;
  /** The actual value that triggered */
  value: number;
  /** The threshold that was exceeded */
  threshold: number;
  /** Stage where this trigger was raised */
  stage: StageId;
  /** If true, this trigger bypasses multi-signal gating and forces risk=true */
  fatal?: boolean;
  /** Optional metadata (e.g., ROI coords, metrics) for debugging */
  meta?: Record<string, unknown>;
}

/**
 * Complete validation summary returned by stage-aware validator
 */
export interface ValidationSummary {
  /** Stage that was validated */
  stage: StageId;
  /** Mode used: "log" (non-blocking) or "block" (blocking) */
  mode: "log" | "block";
  /** Whether validation passed (false only if mode=block and risk=true) */
  passed: boolean;
  /** Whether risk was detected (triggers >= gateMinSignals) */
  risk: boolean;
  /** Aggregate structural score 0-1 */
  score: number;
  /** List of triggered checks */
  triggers: ValidationTrigger[];
  /** Raw metric values */
  metrics: {
    structuralIoU?: number;
    edgeIoU?: number;
    globalEdgeIoU?: number;
    lineDeviation?: number;
    wallDrift?: number;
    maskedDrift?: number;
    maskedEdgeDrift?: number;
    windowValidationPassed?: number;
    openingsCreated?: number;
    openingsClosed?: number;
    lineScore?: number;
    edgeLoss?: number;
    edgeDensity?: number;
  };
  /** Debug information */
  debug: {
    dimsBaseline: { w: number; h: number };
    dimsCandidate: { w: number; h: number };
    dimensionMismatch: boolean;
    maskAPixels: number;
    maskBPixels: number;
    maskARatio: number;
    maskBRatio: number;
    edgeMode?: "global" | "structure_only" | "exclude_lower";
    excludedLowerPct?: number;
    structuralIoUSkipped?: boolean;
    structuralIoUSkipReason?: string;
    intersectionPixels?: number;
    unionPixels?: number;
    baselineUrl?: string;
    candidateUrl?: string;
    lowEdgeDetected?: boolean;
    lowEdgeThreshold?: number;
  };
}

/**
 * Parameters for stage-aware validation
 */
export interface ValidateParams {
  /** Stage being validated */
  stage: StageId;
  /** Local file path to baseline image (NOT remote URL) */
  baselinePath: string;
  /** Local file path to candidate image (NOT remote URL) */
  candidatePath: string;
  /** Validation mode: "log" (non-blocking) or "block" (blocking) */
  mode?: "log" | "block";
  /** Job ID for cache keys and logging */
  jobId?: string;
  /** Scene type */
  sceneType?: "interior" | "exterior";
  /** Room type */
  roomType?: string;
  /** Retry attempt number (0-based, used for tightening) */
  retryAttempt?: number;
  /** Override config (for testing) */
  config?: StageAwareConfig;
}

/**
 * Stage retry tracking
 */
export interface StageRetryState {
  stage1AAttempts: number;
  stage1BAttempts: number;
  stage2Attempts: number;
  lastFailedStage: StageId | null;
  failedFinal: boolean;
  failureReasons: ValidationTrigger[];
}

/**
 * Create initial retry state
 */
export function createInitialRetryState(): StageRetryState {
  return {
    stage1AAttempts: 0,
    stage1BAttempts: 0,
    stage2Attempts: 0,
    lastFailedStage: null,
    failedFinal: false,
    failureReasons: [],
  };
}

/**
 * Get current attempt count for a stage
 */
export function getStageAttempts(state: StageRetryState, stage: StageId): number {
  switch (stage) {
    case "stage1A": return state.stage1AAttempts;
    case "stage1B": return state.stage1BAttempts;
    case "stage2": return state.stage2Attempts;
  }
}

/**
 * Increment attempt count for a stage
 */
export function incrementStageAttempts(state: StageRetryState, stage: StageId): StageRetryState {
  const newState = { ...state };
  switch (stage) {
    case "stage1A":
      newState.stage1AAttempts++;
      break;
    case "stage1B":
      newState.stage1BAttempts++;
      break;
    case "stage2":
      newState.stage2Attempts++;
      break;
  }
  return newState;
}
