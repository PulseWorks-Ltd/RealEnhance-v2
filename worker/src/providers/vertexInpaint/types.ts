// Types for the experimental Vertex mask-constrained inpainting Stage 2 provider.
// See VERTEX_INPAINTING_INVESTIGATION.md for the proven Vertex Imagen contract this
// is built against (§3) and the reuse map this file's shape follows (§5).

export class VertexInpaintError extends Error {
  reasonCode: string;
  constructor(message: string, reasonCode: string) {
    super(message);
    this.name = "VertexInpaintError";
    this.reasonCode = reasonCode;
  }
}

export class VertexAuthError extends VertexInpaintError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "VertexAuthError";
  }
}

export class VertexApiError extends VertexInpaintError {
  status?: number;
  body?: string;
  constructor(message: string, reasonCode: string, status?: number, body?: string) {
    super(message, reasonCode);
    this.name = "VertexApiError";
    this.status = status;
    this.body = body;
  }
}

export class GeminiMaskGenerationError extends VertexInpaintError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "GeminiMaskGenerationError";
  }
}

export class MaskValidationError extends VertexInpaintError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "MaskValidationError";
  }
}

export class OutsideMaskDriftError extends VertexInpaintError {
  constructor(message: string, reasonCode: string) {
    super(message, reasonCode);
    this.name = "OutsideMaskDriftError";
  }
}

// ── Wire-format types (mirrors the proven Vertex Imagen contract, §3) ──

export type VertexWireImagePayload = {
  bytesBase64Encoded: string;
  mimeType: string;
};

export interface VertexMaskImageConfig {
  maskMode: "MASK_MODE_USER_PROVIDED";
  maskDilation: number;
}

export interface VertexReferenceImageContainer {
  referenceId: number;
  referenceType: "REFERENCE_TYPE_RAW" | "REFERENCE_TYPE_MASK";
  referenceImage: VertexWireImagePayload;
  maskImageConfig?: VertexMaskImageConfig;
}

export interface VertexImagenInstance {
  prompt: string;
  referenceImages: VertexReferenceImageContainer[];
}

export interface VertexImagenParameters {
  editMode: "EDIT_MODE_INPAINT_INSERTION";
  numberOfImages: 1;
}

export interface VertexEditPredictPayload {
  instances: VertexImagenInstance[];
  parameters: VertexImagenParameters;
}

// ── Aspect ratio normalization (ported from imageRendererProvider.ts, §19) ──

export const SUPPORTED_IMAGEN_ASPECT_RATIOS = [
  { label: "1:1", widthUnits: 1, heightUnits: 1, value: 1 },
  { label: "4:3", widthUnits: 4, heightUnits: 3, value: 4 / 3 },
  { label: "3:4", widthUnits: 3, heightUnits: 4, value: 3 / 4 },
  { label: "16:9", widthUnits: 16, heightUnits: 9, value: 16 / 9 },
  { label: "9:16", widthUnits: 9, heightUnits: 16, value: 9 / 16 },
] as const;

export type ImagenAspectRatioLabel = (typeof SUPPORTED_IMAGEN_ASPECT_RATIOS)[number]["label"];

export type ImagenAspectRatioNormalization = {
  originalWidth: number;
  originalHeight: number;
  originalRatio: number;
  targetAspectRatio: ImagenAspectRatioLabel;
  paddedWidth: number;
  paddedHeight: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  normalizationApplied: boolean;
};

// ── Mask generation / validation ──

export type MaskQualityMetrics = {
  width: number;
  height: number;
  whitePixelCount: number;
  whitePixelRatio: number;
  blackPixelRatio: number;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  connectedComponentCount: number;
};

export type MaskValidationResult = {
  valid: boolean;
  reason: string | null;
  metrics: MaskQualityMetrics;
};

// ── Outside-mask structural drift ──

export type OutsideMaskDriftMetrics = {
  width: number;
  height: number;
  threshold: number;
  outsidePixelCount: number;
  changedPixelCount: number;
  meanAbsoluteDelta: number;
  changedPixelRatio: number;
};

export type OutsideMaskDriftResult = {
  passed: boolean;
  failureReason: string | null;
  metrics: OutsideMaskDriftMetrics;
  maxMae: number;
  maxChangedRatio: number;
};

// ── Top-level orchestration request/result ──

export type VertexInpaintStagingRequest = {
  basePath: string; // local path to the Stage 1A/1B output (source of truth image)
  roomType: string;
  stagingStyle?: string;
  jobId: string;
  imageId: string;
};

export type VertexInpaintStagingResult = {
  localPath: string;
  maskPath: string;
  maskMetrics: MaskQualityMetrics;
  aspectRatioNormalization: ImagenAspectRatioNormalization;
  driftResult: OutsideMaskDriftResult;
  model: string;
  submittedAt: string;
  completedAt: string;
  maskGenerationDurationMs: number;
  vertexRenderDurationMs: number;
};
