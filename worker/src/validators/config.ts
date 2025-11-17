export type StageId = "1A" | "1B" | "2";

export type SceneType = "interior" | "exterior";

export type ValidationReason =
  | "ok"
  | "structural_geometry"
  | "landcover"
  | "window_change"
  | "size_mismatch"
  | "brightness_out_of_range"
  | "validator_error";

export interface ValidationResult {
  ok: boolean;
  stage: StageId;
  sceneType: SceneType;
  structuralIoU?: number; // for structure-only comparisons
  globalEdgeIoU?: number; // optional for debug
  brightnessDiff?: number;
  reason: ValidationReason;
  message?: string;
}

export interface StageValidationProfile {
  stage: StageId;
  sceneType: SceneType | "any";
  // thresholds
  minStructuralIoU?: number;
  minGlobalEdgeIoU?: number;
  maxBrightnessDiff?: number; // absolute delta in normalized brightness metric (0..1)
  enforceSizeMatch?: boolean;
  enforceLandcover?: boolean; // exteriors only
  enforceWindowIoU?: boolean;
}

// Defaults are tuned to current product behavior; adjust via env or future config as needed.
export const VALIDATION_PROFILES: StageValidationProfile[] = [
  // Stage 1A – interior: no content changes allowed, only tone changes
  {
    stage: "1A",
    sceneType: "interior",
    minGlobalEdgeIoU: 0.75,
    maxBrightnessDiff: 0.50,
    enforceSizeMatch: true,
  },
  // Stage 1A – exterior: no geometry changes, but sky/grass may shift
  {
    stage: "1A",
    sceneType: "exterior",
    minGlobalEdgeIoU: 0.70,
    enforceSizeMatch: true,
    enforceLandcover: true,
  },

  // Stage 1B – interior: architecture must match; furniture edges may vanish
  {
    stage: "1B",
    sceneType: "interior",
    minStructuralIoU: 0.85,
    maxBrightnessDiff: 0.40,
    enforceSizeMatch: true,
    enforceWindowIoU: true,
  },

  // Stage 2 – interior: only ADD furniture; architecture must be unchanged
  {
    stage: "2",
    sceneType: "interior",
    // Note: aligned with current relaxed threshold per product request
    minStructuralIoU: 0.30,
    maxBrightnessDiff: 0.60,
    enforceSizeMatch: true,
    enforceWindowIoU: true,
  },

  // Stage 2 – exterior: only add outdoor furniture; structure & landcover fixed
  {
    stage: "2",
    sceneType: "exterior",
    minStructuralIoU: 0.30,
    maxBrightnessDiff: 0.60,
    enforceSizeMatch: true,
    enforceLandcover: true,
  },
];
