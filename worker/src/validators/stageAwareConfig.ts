/**
 * Stage-Aware Structural Validation Configuration
 *
 * This module provides configuration for the stage-aware structural validation system.
 * All settings are configurable via environment variables with sensible defaults.
 */

export type StageId = "stage1A" | "stage1B" | "stage2";

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

  /** Paint-over / opening suppression detector (Stage2) */
  paintOverEnable: boolean;
  paintOverEdgeRatioMin: number;
  paintOverTexRatioMin: number;
  paintOverMinRoiArea: number;
}

/**
 * Load stage-aware configuration from environment variables
 */
export function loadStageAwareConfig(): StageAwareConfig {
  return {
    enabled: process.env.STRUCT_VALIDATION_STAGE_AWARE === "1",
    stage2EdgeMode: parseEdgeMode(process.env.STRUCT_VALIDATION_STAGE2_EDGE_MODE),
    stage2ExcludeLowerPct: parseFloat(process.env.STRUCT_VALIDATION_STAGE2_EXCLUDE_LOWER_PCT || "0.40"),
    gateMinSignals: parseInt(process.env.STRUCT_VALIDATION_GATE_MIN_SIGNALS || "2", 10),
    iouMinPixelsRatio: parseFloat(process.env.STRUCT_VALIDATION_IOU_MIN_PIXELS_RATIO || "0.005"),
    logArtifactsOnFail: process.env.STRUCT_VALIDATION_LOG_ARTIFACTS_ON_FAIL !== "0",
    maxRetryAttempts: parseInt(process.env.STRUCT_VALIDATION_MAX_RETRY_ATTEMPTS || "3", 10),

    paintOverEnable: process.env.STRUCT_VALIDATION_PAINTOVER_ENABLE !== "0",
    paintOverEdgeRatioMin: parseFloat(process.env.STRUCT_VALIDATION_PAINTOVER_EDGE_RATIO_MIN || "0.35"),
    paintOverTexRatioMin: parseFloat(process.env.STRUCT_VALIDATION_PAINTOVER_TEX_RATIO_MIN || "0.45"),
    paintOverMinRoiArea: parseFloat(process.env.STRUCT_VALIDATION_PAINTOVER_MIN_ROI_AREA || "0.005"),
  };
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
  },
  stage2: {
    lineDeviationDegMax: 5.0,
    // edgeIouMin depends on edgeMode - use getStage2EdgeIouMin()
    structuralMaskIouMin: 0.15,
    windowCountChangeFatal: false, // staging should not fail on tiny window artifacts
    semanticWallDriftMax: 0.25,
    semanticOpeningsMax: 0,
    maskedDriftMax: 0.30,
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
  };
  /** Debug information */
  debug: {
    dimsBaseline: { w: number; h: number };
    dimsCandidate: { w: number; h: number };
    dimensionMismatch: boolean;
    dimensionNormalized?: boolean;
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
