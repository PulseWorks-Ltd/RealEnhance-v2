// Types for the experimental Stage 2 "generate then extract and merge" provider.
// See the implementation directive for feature/stage2-gemini-staging-merge for
// full background: generate a complete staged candidate with the existing
// Gemini/Nano Banana staging path, then extract only the newly-introduced
// staging layer (furniture + its shadows) as an alpha mask, and composite that
// layer onto the original Stage 1A/1B image deterministically.

export class GeminiMergeError extends Error {
  reasonCode: string;
  constructor(message: string, reasonCode: string) {
    super(message);
    this.name = "GeminiMergeError";
    this.reasonCode = reasonCode;
  }
}

export class StagingGenerationError extends GeminiMergeError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "StagingGenerationError";
  }
}

export class ExtractionError extends GeminiMergeError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "ExtractionError";
  }
}

export class MaskValidationError extends GeminiMergeError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "MaskValidationError";
  }
}

export class CompositeError extends GeminiMergeError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "CompositeError";
  }
}

export type ExtractionMaskMetrics = {
  width: number;
  height: number;
  nonZeroPixelCount: number;
  nonZeroPixelRatio: number;
  meanAlpha: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  connectedComponentCount: number;
};

export type MaskValidationResult = {
  valid: boolean;
  reason: string | null;
  metrics: ExtractionMaskMetrics;
};

export type GeminiMergeStagingRequest = {
  basePath: string; // local path to the Stage 1A/1B output (structural authority)
  roomType: string;
  sceneType?: "interior" | "exterior";
  stagingStyle?: string;
  sourceStage: "1A" | "1B-light" | "1B-stage-ready";
  jobId: string;
  imageId: string;
};

export type GeminiMergeStagingResult = {
  finalLocalPath: string;
  stagedCandidatePath: string;
  extractionMaskPath: string;
  overlayDebugPath: string;
  maskMetrics: ExtractionMaskMetrics;
  stagingModel: string;
  extractionModel: string;
  generationDurationMs: number;
  extractionDurationMs: number;
  compositeDurationMs: number;
};
