import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { nLog } from "../../logger";
import type { ContinuityRenderMode, PlacementPlan } from "../../continuity/types";
import { VertexSecondaryContinuityError } from "../../continuity/types";
import { toVertexImagePayload } from "../imageTransport";
import type { ImageRendererProvider, ImageRenderRequest, ImageRenderResponse } from "../types";
import { getVertexGenAiClient, getVertexProjectConfig } from "./adc";

export type VertexWireImagePayload = {
  bytesBase64Encoded?: string;
  gcsUri?: string;
  mimeType?: string;
};

export type VertexReferenceType = typeof VERTEX_REFERENCE_TYPE_RAW | typeof VERTEX_REFERENCE_TYPE_MASK;
export type VertexMaskMode = typeof VERTEX_MASK_MODE_USER_PROVIDED;
export type VertexEditMode = "EDIT_MODE_DEFAULT" | "EDIT_MODE_INPAINT_INSERTION" | "EDIT_MODE_INPAINT_REMOVAL" | "EDIT_MODE_OUTPAINT";

// Wire-format constants — declared before types that use typeof on them.
const SUPPORTED_VERTEX_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VERTEX_EDIT_REFERENCE_ORDER = ["source", "mask"] as const;
const VERTEX_REFERENCE_TYPE_RAW = "REFERENCE_TYPE_RAW" as const;
const VERTEX_REFERENCE_TYPE_MASK = "REFERENCE_TYPE_MASK" as const;
const VERTEX_MASK_MODE_USER_PROVIDED = "MASK_MODE_USER_PROVIDED" as const;
const VERTEX_EDIT_MODE_DEFAULT = "EDIT_MODE_DEFAULT" as const;
const VERTEX_EDIT_MODE_INPAINT_INSERTION = "EDIT_MODE_INPAINT_INSERTION" as const;
const VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA_ENV = "VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA" as const;
const VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION_ENV = "VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION" as const;
const VERTEX_CONTINUITY_STRICT_INSERTION_ENV = "VERTEX_CONTINUITY_STRICT_INSERTION" as const;
const VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_MAE_ENV = "VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_MAE" as const;
const VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_CHANGED_RATIO_ENV = "VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_CHANGED_RATIO" as const;
const VERTEX_CONTINUITY_OUTSIDE_MASK_CHANGE_THRESHOLD_ENV = "VERTEX_CONTINUITY_OUTSIDE_MASK_CHANGE_THRESHOLD" as const;

const SUPPORTED_IMAGEN_ASPECT_RATIOS = [
  { label: "1:1", widthUnits: 1, heightUnits: 1, value: 1 },
  { label: "4:3", widthUnits: 4, heightUnits: 3, value: 4 / 3 },
  { label: "3:4", widthUnits: 3, heightUnits: 4, value: 3 / 4 },
  { label: "16:9", widthUnits: 16, heightUnits: 9, value: 16 / 9 },
  { label: "9:16", widthUnits: 9, heightUnits: 16, value: 9 / 16 },
] as const;

export type VertexPayloadSchemaMode = "wrapper" | "flat";

export type ContinuityRendererIsolationMode = "CONTINUITY_STRICT_INSERTION" | "CONTINUITY_RELAXED_DEFAULT";

type ContinuityRendererProfile = {
  isolationMode: ContinuityRendererIsolationMode;
  editMode: VertexEditMode;
  maskDilation: number;
  outsideMaskMaxMae: number;
  outsideMaskMaxChangedRatio: number;
  outsideMaskChangeThreshold: number;
};

export type ImagenAspectRatioNormalizationMetadata = {
  originalWidth: number;
  originalHeight: number;
  originalRatio: number;
  targetWidth: number;
  targetHeight: number;
  paddedWidth: number;
  paddedHeight: number;
  targetRatio: number;
  targetAspectRatio: (typeof SUPPORTED_IMAGEN_ASPECT_RATIOS)[number]["label"];
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  normalizationApplied: boolean;
};

export interface VertexMaskImageConfig {
  maskMode: VertexMaskMode;
  maskDilation?: number;
}

export interface VertexReferenceImageContainer {
  referenceId: number;
  referenceType: VertexReferenceType;
  referenceImage: VertexWireImagePayload;
  maskImageConfig?: VertexMaskImageConfig;
}

export interface VertexImagenInstance {
  prompt: string;
  referenceImages: VertexReferenceImageContainer[];
}

export interface VertexImagenParameters {
  editMode: VertexEditMode;
  aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
  numberOfImages?: number;
  outputMimeType?: "image/jpeg" | "image/png";
}

export interface VertexImagenPredictionRequest {
  instances: VertexImagenInstance[];
  parameters: VertexImagenParameters;
}

type VertexEditPredictPayload = VertexImagenPredictionRequest;

function resolveVertexPayloadSchemaMode(): VertexPayloadSchemaMode {
  const rawValue = String(process.env[VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA_ENV] || "").trim().toLowerCase();
  return rawValue === "wrapper" ? "wrapper" : "flat";
}

function isVertexImagenAspectRatioNormalizationEnabled(): boolean {
  return String(process.env[VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION_ENV] || "").trim().toLowerCase() === "true";
}

function parseFiniteEnvNumber(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function isContinuityStrictInsertionEnabled(): boolean {
  const raw = String(process.env[VERTEX_CONTINUITY_STRICT_INSERTION_ENV] || "").trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return raw === "1" || raw === "true";
}

function hasSemanticAddLeakage(intent: ImageRenderRequest["intent"]): boolean {
  const signature = [
    String(intent?.operationLabel || ""),
    String(intent?.promptScope || ""),
    String(intent?.rendererIsolationMode || ""),
  ]
    .join(" ")
    .toLowerCase();
  return signature.includes("semantic add") || signature.includes("semantic_add") || signature.includes("semantic-add");
}

function resolveContinuityRendererProfile(request: ImageRenderRequest): ContinuityRendererProfile {
  if (hasSemanticAddLeakage(request.intent)) {
    throw new VertexSecondaryContinuityError(
      "Semantic-add intent leaked into the continuity renderer path",
      "continuity_semantic_add_leakage_blocked"
    );
  }

  const strictInsertion = isContinuityStrictInsertionEnabled();
  const isStrictIsolationRequested = strictInsertion
    || String(request.intent?.rendererIsolationMode || "").trim().toLowerCase() === "continuity_strict_insertion";

  return {
    isolationMode: isStrictIsolationRequested ? "CONTINUITY_STRICT_INSERTION" : "CONTINUITY_RELAXED_DEFAULT",
    editMode: isStrictIsolationRequested ? VERTEX_EDIT_MODE_INPAINT_INSERTION : VERTEX_EDIT_MODE_DEFAULT,
    maskDilation: isStrictIsolationRequested ? 0 : 0.1,
    outsideMaskMaxMae: parseFiniteEnvNumber(VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_MAE_ENV, 6),
    outsideMaskMaxChangedRatio: parseFiniteEnvNumber(VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_CHANGED_RATIO_ENV, 0.035),
    outsideMaskChangeThreshold: parseFiniteEnvNumber(VERTEX_CONTINUITY_OUTSIDE_MASK_CHANGE_THRESHOLD_ENV, 18),
  };
}

function findSupportedImagenAspectRatio(width: number, height: number) {
  return SUPPORTED_IMAGEN_ASPECT_RATIOS.find((candidate) => width * candidate.heightUnits === height * candidate.widthUnits);
}

export function resolveNearestImagenAspectRatio(width: number, height: number): ImagenAspectRatioNormalizationMetadata {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid image dimensions for Imagen aspect ratio normalization: ${width}x${height}`);
  }

  const originalRatio = width / height;
  const exactMatch = findSupportedImagenAspectRatio(width, height);
  if (exactMatch) {
    return {
      originalWidth: width,
      originalHeight: height,
      originalRatio,
      targetWidth: width,
      targetHeight: height,
      paddedWidth: width,
      paddedHeight: height,
      targetRatio: exactMatch.value,
      targetAspectRatio: exactMatch.label,
      padLeft: 0,
      padRight: 0,
      padTop: 0,
      padBottom: 0,
      normalizationApplied: false,
    };
  }

  const bestCandidate = [...SUPPORTED_IMAGEN_ASPECT_RATIOS]
    .map((candidate) => {
      const scale = Math.max(
        Math.ceil(width / candidate.widthUnits),
        Math.ceil(height / candidate.heightUnits)
      );
      const targetWidth = scale * candidate.widthUnits;
      const targetHeight = scale * candidate.heightUnits;
      const totalPadWidth = targetWidth - width;
      const totalPadHeight = targetHeight - height;
      const padLeft = Math.floor(totalPadWidth / 2);
      const padRight = totalPadWidth - padLeft;
      const padTop = Math.floor(totalPadHeight / 2);
      const padBottom = totalPadHeight - padTop;
      return {
        candidate,
        targetWidth,
        targetHeight,
        totalAddedPixels: (targetWidth * targetHeight) - (width * height),
        ratioDelta: Math.abs(originalRatio - candidate.value),
        padLeft,
        padRight,
        padTop,
        padBottom,
      };
    })
    .sort((left, right) => {
      if (left.ratioDelta !== right.ratioDelta) {
        return left.ratioDelta - right.ratioDelta;
      }
      if (left.totalAddedPixels !== right.totalAddedPixels) {
        return left.totalAddedPixels - right.totalAddedPixels;
      }
      if (left.targetWidth !== right.targetWidth) {
        return left.targetWidth - right.targetWidth;
      }
      return left.targetHeight - right.targetHeight;
    })[0];

  return {
    originalWidth: width,
    originalHeight: height,
    originalRatio,
    targetWidth: bestCandidate.targetWidth,
    targetHeight: bestCandidate.targetHeight,
    paddedWidth: bestCandidate.targetWidth,
    paddedHeight: bestCandidate.targetHeight,
    targetRatio: bestCandidate.candidate.value,
    targetAspectRatio: bestCandidate.candidate.label,
    padLeft: bestCandidate.padLeft,
    padRight: bestCandidate.padRight,
    padTop: bestCandidate.padTop,
    padBottom: bestCandidate.padBottom,
    normalizationApplied: true,
  };
}

function compactPromptSegment(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function buildImagenInsertionPrompt(params: {
  plan: PlacementPlan;
  stagingStyle?: string;
  materialPalette: string[];
  lightingHint: string;
}): string {
  const furniture = compactPromptSegment(
    params.plan.furnitureZones.map((zone) => {
      const material = params.materialPalette[0] || "natural wood and textile finishes";
      return `${zone.furnitureType} with ${material}`;
    })
  );
  const materials = compactPromptSegment(params.materialPalette);
  return [
    furniture.join(", "),
    materials.length > 0 ? `${materials.join(", ")} textures` : "realistic material textures",
    params.stagingStyle ? `${params.stagingStyle} staging finish` : "listing-ready styling",
    "consistent scale",
    "realistic shadow grounding",
    params.lightingHint,
    "high-quality staging photography",
  ].filter(Boolean).join(", ");
}

function buildModeScopedPrompt(params: {
  renderMode: ContinuityRenderMode;
  basePrompt: string;
  intentInstruction?: string;
}): string {
  const normalizedIntent = String(params.intentInstruction || "").trim();
  const strictPreservationPrelude = [
    "STRICT CONTINUITY PRESERVATION MODE.",
    "Preserve room geometry, perspective lines, architectural boundaries, and scene identity.",
    "Preserve furniture proportions, spacing, and relational layout unless the mask requires a direct continuity repair.",
    "Do not reinterpret the full scene, redesign composition, or mutate unrelated objects outside the mask.",
  ].join(" ");
  if (params.renderMode === "full_secondary_continuity") {
    return [
      strictPreservationPrelude,
      "Use the approved master as the furnishing identity source for visible secondary-view staging.",
      "Preserve architecture, openings, perspective, framing, and all content outside the compiled mask with minimal drift.",
      params.basePrompt,
    ].join(", ");
  }
  if (params.renderMode === "continuity_refresh") {
    return [
      strictPreservationPrelude,
      "Refresh only mismatched or incomplete continuity details visible from this secondary angle.",
      "Do not restage the room broadly, rewrite protected architecture, or reposition unrelated furniture.",
      params.basePrompt,
    ].join(", ");
  }
  if (params.renderMode === "missing_object_insert") {
    return [
      strictPreservationPrelude,
      normalizedIntent || "Insert only the missing approved furnishing implied by continuity.",
      "Keep the change localized to the compiled continuity mask.",
      "Do not reposition unrelated furniture, mutate room geometry, or redesign the room.",
      params.basePrompt,
    ].join(", ");
  }
  return [
    strictPreservationPrelude,
    normalizedIntent || "Perform only the localized secondary continuity repair requested.",
    "Keep the change surgical and restricted to the compiled continuity mask.",
    "Preserve unrelated furnishings, architecture, and composition with strict off-mask stability.",
    params.basePrompt,
  ].join(", ");
}

function resolveModelResource(model: string): string {
  const { project, location } = getVertexProjectConfig();
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

function extractGeneratedImage(response: any): { imageBytes: string; mimeType: string } {
  const prediction = response?.predictions?.[0] || response?.generatedImages?.[0] || null;
  const imageBytes = prediction?.bytesBase64Encoded || prediction?.image?.bytesBase64Encoded || prediction?.image?.imageBytes;
  const mimeType = prediction?.mimeType || prediction?.image?.mimeType || "image/png";
  if (!imageBytes || typeof imageBytes !== "string") {
    throw new VertexSecondaryContinuityError("Imagen response did not include image bytes", "imagen_missing_image");
  }
  return { imageBytes, mimeType };
}

async function inspectRenderArtifact(
  reference: ImageRenderRequest["sourceImage"],
  role: "source" | "mask"
): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {
    role,
    kind: reference.kind,
    sourceLabel: reference.sourceLabel,
    uri: reference.uri || null,
    localPath: reference.localPath || null,
    mimeType: reference.mimeType || null,
  };

  if (!reference.localPath) {
    return {
      ...summary,
      exists: null,
      sizeBytes: null,
      width: null,
      height: null,
    };
  }

  let stats;
  try {
    stats = await fs.stat(reference.localPath);
  } catch {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image local artifact is missing: ${reference.localPath}`,
      `imagen_${role}_image_missing_local_file`
    );
  }

  if (stats.size <= 0) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image local artifact is empty: ${reference.localPath}`,
      `imagen_${role}_image_empty_local_file`
    );
  }

  const metadata = await sharp(reference.localPath).metadata().catch(() => ({ width: 0, height: 0, format: null }));
  const normalizedFormat = String(metadata.format || "").trim().toLowerCase();
  const decodedMimeType = normalizedFormat === "png"
    ? "image/png"
    : normalizedFormat === "webp"
      ? "image/webp"
      : normalizedFormat === "jpeg" || normalizedFormat === "jpg"
        ? "image/jpeg"
        : null;
  if (!decodedMimeType) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image local artifact decoded to unsupported format: ${metadata.format || "unknown"}`,
      `imagen_${role}_image_invalid_format`
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image local artifact has invalid dimensions: ${reference.localPath}`,
      `imagen_${role}_image_invalid_dimensions`
    );
  }

  return {
    ...summary,
    exists: true,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    width: metadata.width || null,
    height: metadata.height || null,
    format: metadata.format || null,
    decodedMimeType,
  };
}

async function inspectLocalRenderDimensions(localPath: string, role: "source" | "mask"): Promise<{
  width: number;
  height: number;
  format: string | null;
}> {
  const metadata = await sharp(localPath).metadata().catch(() => ({ width: 0, height: 0, format: null }));
  if (!metadata.width || !metadata.height) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image local artifact has invalid dimensions: ${localPath}`,
      `imagen_${role}_image_invalid_dimensions`
    );
  }
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format || null,
  };
}

async function padLocalRenderImageInPlace(params: {
  localPath: string;
  role: "source" | "mask";
  metadata: ImagenAspectRatioNormalizationMetadata;
}): Promise<void> {
  const tempPath = `${params.localPath}.vertex-aspect-normalized.tmp`;
  await sharp(params.localPath)
    .extend({
      left: params.metadata.padLeft,
      right: params.metadata.padRight,
      top: params.metadata.padTop,
      bottom: params.metadata.padBottom,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(tempPath);
  await fs.rename(tempPath, params.localPath);
}

async function maybeNormalizeVertexAspectRatio(params: {
  request: ImageRenderRequest;
  sourceReference: ImageRenderRequest["sourceImage"];
  maskReference: ImageRenderRequest["maskImage"];
}): Promise<ImagenAspectRatioNormalizationMetadata | null> {
  const featureEnabled = isVertexImagenAspectRatioNormalizationEnabled();
  if (!featureEnabled) {
    nLog("[VERTEX_ASPECT_RATIO_NORMALIZATION]", {
      continuityGroupId: params.request.continuityGroupId || null,
      imageId: params.request.imageId,
      jobId: params.request.jobId,
      renderMode: params.request.renderMode,
      featureEnabled: false,
      normalizationApplied: false,
      originalDimensions: null,
      maskDimensions: null,
      originalRatio: null,
      targetRatio: null,
      paddedDimensions: null,
      paddingApplied: null,
      skippedReason: "feature_disabled",
    });
    return null;
  }

  if (
    params.sourceReference.kind !== "local" ||
    !params.sourceReference.localPath ||
    params.maskReference.kind !== "local" ||
    !params.maskReference.localPath
  ) {
    nLog("[VERTEX_ASPECT_RATIO_NORMALIZATION]", {
      continuityGroupId: params.request.continuityGroupId || null,
      imageId: params.request.imageId,
      jobId: params.request.jobId,
      renderMode: params.request.renderMode,
      featureEnabled,
      normalizationApplied: false,
      originalDimensions: null,
      maskDimensions: null,
      originalRatio: null,
      targetRatio: null,
      paddedDimensions: null,
      paddingApplied: null,
      skippedReason: "non_local_reference",
    });
    return null;
  }

  const [sourceDimensions, maskDimensions] = await Promise.all([
    inspectLocalRenderDimensions(params.sourceReference.localPath, "source"),
    inspectLocalRenderDimensions(params.maskReference.localPath, "mask"),
  ]);

  if (sourceDimensions.width !== maskDimensions.width || sourceDimensions.height !== maskDimensions.height) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source/mask dimensions diverged before Imagen normalization: source=${sourceDimensions.width}x${sourceDimensions.height} mask=${maskDimensions.width}x${maskDimensions.height}`,
      "imagen_aspect_ratio_normalization_dimension_mismatch"
    );
  }

  const metadata = resolveNearestImagenAspectRatio(sourceDimensions.width, sourceDimensions.height);
  const normalizationApplied = featureEnabled && metadata.normalizationApplied;

  if (normalizationApplied) {
    // Padding is symmetric so planner-space coordinates translate by fixed offsets and
    // are restored by subtracting the same offsets from the generated canvas.
    await Promise.all([
      padLocalRenderImageInPlace({
        localPath: params.sourceReference.localPath,
        role: "source",
        metadata,
      }),
      padLocalRenderImageInPlace({
        localPath: params.maskReference.localPath,
        role: "mask",
        metadata,
      }),
    ]);
  }

  nLog("[VERTEX_ASPECT_RATIO_NORMALIZATION]", {
    continuityGroupId: params.request.continuityGroupId || null,
    imageId: params.request.imageId,
    jobId: params.request.jobId,
    renderMode: params.request.renderMode,
    featureEnabled,
    normalizationApplied,
    originalDimensions: {
      width: metadata.originalWidth,
      height: metadata.originalHeight,
    },
    maskDimensions: {
      width: maskDimensions.width,
      height: maskDimensions.height,
    },
    originalRatio: metadata.originalRatio,
    targetRatio: metadata.targetAspectRatio,
    paddedDimensions: {
      width: metadata.paddedWidth,
      height: metadata.paddedHeight,
    },
    paddingApplied: {
      left: normalizationApplied ? metadata.padLeft : 0,
      right: normalizationApplied ? metadata.padRight : 0,
      top: normalizationApplied ? metadata.padTop : 0,
      bottom: normalizationApplied ? metadata.padBottom : 0,
    },
  });

  return normalizationApplied ? metadata : null;
}

async function snapshotLocalRenderReference(params: {
  reference: ImageRenderRequest["sourceImage"];
  role: "source" | "mask";
  outputPath: string;
}): Promise<{ reference: ImageRenderRequest["sourceImage"]; snapshotPath: string | null }> {
  if (params.reference.kind !== "local" || !params.reference.localPath) {
    return {
      reference: params.reference,
      snapshotPath: null,
    };
  }

  const sourceExt = path.extname(params.reference.localPath) || ".img";
  const snapshotPath = path.join(
    path.dirname(params.outputPath),
    `${path.basename(params.outputPath, path.extname(params.outputPath))}-vertex-${params.role}-snapshot${sourceExt}`
  );
  await fs.copyFile(params.reference.localPath, snapshotPath);

  return {
    reference: {
      ...params.reference,
      localPath: snapshotPath,
    },
    snapshotPath,
  };
}

function summarizeVertexImagePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const imageBytes = typeof payload.bytesBase64Encoded === "string"
    ? payload.bytesBase64Encoded
    : "";
  const gcsUri = typeof payload.gcsUri === "string"
    ? payload.gcsUri
    : null;

  return {
    hasInlineBytes: imageBytes.length > 0,
    inlineBytesLength: imageBytes.length,
    hasGcsUri: Boolean(gcsUri),
    gcsUri,
    mimeType: typeof payload.mimeType === "string" ? payload.mimeType : null,
    keys: Object.keys(payload),
    payloadImageMode: gcsUri ? "gcsUri" : imageBytes.length > 0 ? "inline_bytes" : "missing",
  };
}

function isSupportedVertexImageMimeType(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_VERTEX_IMAGE_MIME_TYPES.has(value);
}

export function buildVertexEditPredictPayload(params: {
  prompt: string;
  sourcePayload: VertexWireImagePayload;
  maskPayload: VertexWireImagePayload;
  guidanceScale: number;
  renderProfile: ContinuityRendererProfile;
}): VertexEditPredictPayload {
  return {
    instances: [
      {
        prompt: params.prompt,
        referenceImages: [
          {
            referenceId: 1,
            referenceType: VERTEX_REFERENCE_TYPE_RAW,
            referenceImage: params.sourcePayload,
          },
          {
            referenceId: 2,
            referenceType: VERTEX_REFERENCE_TYPE_MASK,
            referenceImage: params.maskPayload,
            maskImageConfig: {
              maskMode: VERTEX_MASK_MODE_USER_PROVIDED,
              maskDilation: params.renderProfile.maskDilation,
            },
          },
        ],
      },
    ],
    parameters: {
      editMode: params.renderProfile.editMode,
      numberOfImages: 1,
    },
  };
}

export function buildVertexEditPredictPayloadFlat(params: {
  prompt: string;
  sourcePayload: VertexWireImagePayload;
  maskPayload: VertexWireImagePayload;
  guidanceScale: number;
  renderProfile: ContinuityRendererProfile;
}): VertexEditPredictPayload {
  return buildVertexEditPredictPayload(params);
}

export function buildVertexEditPredictPayloadForMode(params: {
  prompt: string;
  sourcePayload: VertexWireImagePayload;
  maskPayload: VertexWireImagePayload;
  guidanceScale: number;
  renderProfile: ContinuityRendererProfile;
  payloadSchemaMode: VertexPayloadSchemaMode;
}): VertexEditPredictPayload {
  return params.payloadSchemaMode === "flat"
    ? buildVertexEditPredictPayloadFlat(params)
    : buildVertexEditPredictPayload(params);
}

function redactVertexWireImagePayload(payload: VertexWireImagePayload): Record<string, unknown> {
  return {
    ...("gcsUri" in payload && payload.gcsUri ? { gcsUri: payload.gcsUri } : {}),
    ...("mimeType" in payload && payload.mimeType ? { mimeType: payload.mimeType } : {}),
    ...("bytesBase64Encoded" in payload
      ? {
          bytesBase64Encoded: typeof payload.bytesBase64Encoded === "string"
            ? `<base64:${payload.bytesBase64Encoded.length}>`
            : payload.bytesBase64Encoded,
        }
      : {}),
  };
}

function redactVertexEditPredictPayload(payload: VertexEditPredictPayload, payloadSchemaMode: VertexPayloadSchemaMode): Record<string, unknown> {
  return {
    payloadSchemaMode,
    instances: payload.instances.map((instance) => ({
      prompt: instance.prompt,
      referenceImages: instance.referenceImages.map((entry, index) => {
        const auditRole = VERTEX_EDIT_REFERENCE_ORDER[index] || `reference_${index}`;
        const base = {
          auditRole,
          referenceId: entry.referenceId,
          referenceType: entry.referenceType,
        };
        return {
          ...base,
          referenceImage: redactVertexWireImagePayload(entry.referenceImage),
          ...(entry.maskImageConfig
            ? {
                maskImageConfig: {
                  maskMode: entry.maskImageConfig.maskMode,
                  ...(entry.maskImageConfig.maskDilation !== undefined
                    ? { maskDilation: entry.maskImageConfig.maskDilation }
                    : {}),
                },
              }
            : {}),
        };
      }),
    })),
    parameters: payload.parameters,
  };
}

function safeJsonParse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function buildSerializedVertexEditPredictPayloadAudit(
  serializedPayload: string,
  payloadSchemaMode: VertexPayloadSchemaMode
): {
  parsedPayload: Record<string, unknown>;
  parsedPayloadJson: string;
} {
  const parsedPayload = safeJsonParse<VertexEditPredictPayload>(serializedPayload);
  const redactedParsedPayload = redactVertexEditPredictPayload(parsedPayload, payloadSchemaMode);
  return {
    parsedPayload: redactedParsedPayload,
    parsedPayloadJson: JSON.stringify(redactedParsedPayload),
  };
}

function getFinalPayloadReferenceImages(payload: VertexEditPredictPayload): Array<Record<string, unknown>> | undefined {
  const firstInstance = payload.instances?.[0] as { referenceImages?: unknown } | undefined;
  return Array.isArray(firstInstance?.referenceImages)
    ? firstInstance.referenceImages as Array<Record<string, unknown>>
    : undefined;
}

function getFinalReferenceImagePayload(reference: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!reference || typeof reference !== "object") {
    return undefined;
  }

  const flatImage = reference.referenceImage;
  if (flatImage && typeof flatImage === "object") {
    return flatImage as Record<string, unknown>;
  }

  return undefined;
}

function logFinalImagenRequestBoundary(params: {
  endpoint: string;
  model: string;
  serializedPayload: string;
}): VertexEditPredictPayload {
  const payload = safeJsonParse<VertexEditPredictPayload>(params.serializedPayload);
  const referenceImages = getFinalPayloadReferenceImages(payload);

  console.log("[IMAGEN_FINAL_PAYLOAD]", JSON.stringify({
    endpoint: params.endpoint,
    model: params.model,
    payload,
  }, null, 2));

  console.log("[REFERENCE_SCHEMA_DEBUG]", {
    flatSchemaEnabled: process.env.VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA,
    hasReferenceImages: !!referenceImages,
    referenceImagesCount: referenceImages?.length,
    firstReferenceKeys: Object.keys(referenceImages?.[0] || {}),
    nestedImageKeys: Object.keys(getFinalReferenceImagePayload(referenceImages?.[0]) || {}),
    firstReferencePreview: referenceImages?.[0]
      ? JSON.stringify(referenceImages[0], null, 2).slice(0, 4000)
      : null,
  });

  console.log("[REFERENCE_IMAGE_VALIDATION]", referenceImages?.map((reference, index) => {
    const imagePayload = getFinalReferenceImagePayload(reference);
    const bytesBase64Encoded = typeof imagePayload?.bytesBase64Encoded === "string"
      ? imagePayload.bytesBase64Encoded
      : "";

    return {
      index,
      topLevelKeys: Object.keys(reference || {}),
      imageKeys: Object.keys(imagePayload || {}),
      hasBytesBase64Encoded: bytesBase64Encoded.length > 0,
      bytesLength: bytesBase64Encoded.length,
      mimeType: typeof imagePayload?.mimeType === "string" ? imagePayload.mimeType : undefined,
      referenceType: reference?.referenceType,
    };
  }));

  console.log("[IMAGEN_PAYLOAD_FINGERPRINT]", {
    hasInstances: !!payload.instances,
    hasParameters: !!payload.parameters,
    hasReferenceImages: !!referenceImages,
    topLevelKeys: Object.keys(payload || {}),
  });

  if (!referenceImages?.length) {
    throw new Error("No referenceImages present before Imagen submission");
  }

  for (const [idx, reference] of referenceImages.entries()) {
    const imagePayload = getFinalReferenceImagePayload(reference);
    if (!imagePayload?.bytesBase64Encoded) {
      throw new Error(`Reference image ${idx} missing bytesBase64Encoded`);
    }
  }

  return payload;
}

function validateSerializedVertexEditPredictPayload(params: {
  serializedPayload: string;
}): void {
  validateSerializedVertexEditPredictPayloadFlat(params);
}

function validateSerializedVertexEditPredictPayloadFlat(params: {
  serializedPayload: string;
}): void {
  let parsedPayload: VertexEditPredictPayload;
  try {
    parsedPayload = safeJsonParse<VertexEditPredictPayload>(params.serializedPayload);
  } catch (error) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat edit payload failed JSON serialization integrity check: ${error instanceof Error ? error.message : String(error)}`,
      "imagen_edit_payload_flat_serialization_invalid_json"
    );
  }

  const firstInstance = parsedPayload.instances?.[0];
  if (!firstInstance || !Array.isArray(firstInstance.referenceImages)) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat edit payload lost referenceImages during serialization",
      "imagen_edit_payload_flat_serialization_missing_reference_images"
    );
  }
  if (firstInstance.referenceImages.length !== VERTEX_EDIT_REFERENCE_ORDER.length) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat edit payload serialized with invalid reference image count: ${firstInstance.referenceImages.length}`,
      "imagen_edit_payload_flat_serialization_invalid_reference_image_count"
    );
  }

  const sourceEntry = firstInstance.referenceImages[0] as unknown as Record<string, unknown>;
  if (!sourceEntry || typeof sourceEntry !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference entry is missing after serialization",
      "imagen_edit_payload_flat_serialization_missing_source_entry"
    );
  }
  if (sourceEntry.referenceType !== VERTEX_REFERENCE_TYPE_RAW) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat source reference lost referenceType ${VERTEX_REFERENCE_TYPE_RAW} during serialization`,
      "imagen_edit_payload_flat_serialization_invalid_source_reference_type"
    );
  }
  if (typeof sourceEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference lost required referenceId during serialization",
      "imagen_edit_payload_flat_serialization_missing_source_reference_id"
    );
  }
  if (sourceEntry.rawReferenceImage !== undefined || sourceEntry.maskReferenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference contains wrapper keys after serialization",
      "imagen_edit_payload_flat_serialization_source_wrapper_leak"
    );
  }
  if (sourceEntry.config !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference unexpectedly contains config",
      "imagen_edit_payload_flat_serialization_source_unexpected_config"
    );
  }
  const sourceImage = sourceEntry.referenceImage as Record<string, unknown> | undefined;
  if (!sourceImage || typeof sourceImage !== "object" || Object.keys(sourceImage).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source referenceImage is missing or empty after serialization",
      "imagen_edit_payload_flat_serialization_missing_source_reference_image"
    );
  }
  if (!isSupportedVertexImageMimeType(sourceImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source image lost a valid mimeType during serialization",
      "imagen_edit_payload_flat_serialization_invalid_source_mime_type"
    );
  }
  const sourceBytesB64 = typeof sourceImage.bytesBase64Encoded === "string" ? sourceImage.bytesBase64Encoded : "";
  if (!sourceImage.gcsUri && sourceBytesB64.length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source referenceImage lost bytes and uri during serialization",
      "imagen_edit_payload_flat_serialization_missing_source_image_data"
    );
  }

  const maskEntry = firstInstance.referenceImages[1] as unknown as Record<string, unknown>;
  if (!maskEntry || typeof maskEntry !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference entry is missing after serialization",
      "imagen_edit_payload_flat_serialization_missing_mask_entry"
    );
  }
  if (maskEntry.referenceType !== VERTEX_REFERENCE_TYPE_MASK) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat mask reference lost referenceType ${VERTEX_REFERENCE_TYPE_MASK} during serialization`,
      "imagen_edit_payload_flat_serialization_invalid_mask_reference_type"
    );
  }
  if (typeof maskEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference lost required referenceId during serialization",
      "imagen_edit_payload_flat_serialization_missing_mask_reference_id"
    );
  }
  if (maskEntry.rawReferenceImage !== undefined || maskEntry.maskReferenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference contains wrapper keys after serialization",
      "imagen_edit_payload_flat_serialization_mask_wrapper_leak"
    );
  }
  if (maskEntry.image !== undefined || maskEntry.rawReferenceImage !== undefined || maskEntry.maskReferenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference contains legacy image or wrapper keys after serialization",
      "imagen_edit_payload_flat_serialization_mask_wrapper_leak"
    );
  }
  const maskConfig = maskEntry.maskImageConfig as Record<string, unknown> | undefined;
  if (!maskConfig || maskConfig.maskMode !== VERTEX_MASK_MODE_USER_PROVIDED) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat maskImageConfig is missing required maskMode ${VERTEX_MASK_MODE_USER_PROVIDED}`,
      "imagen_edit_payload_flat_serialization_invalid_mask_mode"
    );
  }
  const maskImage = maskEntry.referenceImage as Record<string, unknown> | undefined;
  if (!maskImage || typeof maskImage !== "object" || Object.keys(maskImage).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask referenceImage is missing or empty after serialization",
      "imagen_edit_payload_flat_serialization_missing_mask_reference_image"
    );
  }
  if (!isSupportedVertexImageMimeType(maskImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask image lost a valid mimeType during serialization",
      "imagen_edit_payload_flat_serialization_invalid_mask_mime_type"
    );
  }
  const maskBytesB64 = typeof maskImage.bytesBase64Encoded === "string" ? maskImage.bytesBase64Encoded : "";
  if (!maskImage.gcsUri && maskBytesB64.length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask referenceImage lost bytes and uri during serialization",
      "imagen_edit_payload_flat_serialization_missing_mask_image_data"
    );
  }

  if (sourceEntry.image !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference contains legacy image key after serialization",
      "imagen_edit_payload_flat_serialization_source_legacy_image_key"
    );
  }
  if ((parsedPayload.parameters as unknown as Record<string, unknown>).maskMode !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat parameters contains maskMode — it must only be inside referenceImages[1].maskImageConfig",
      "imagen_edit_payload_flat_serialization_parameters_has_mask_mode"
    );
  }
}

function validateSerializedVertexEditPredictPayloadForMode(params: {
  serializedPayload: string;
  payloadSchemaMode: VertexPayloadSchemaMode;
}): void {
  if (params.payloadSchemaMode === "flat") {
    validateSerializedVertexEditPredictPayloadFlat({ serializedPayload: params.serializedPayload });
    return;
  }
  validateSerializedVertexEditPredictPayload({ serializedPayload: params.serializedPayload });
}

function validateVertexEditPredictPayload(params: {
  payload: VertexEditPredictPayload;
  sourceArtifact: Record<string, unknown>;
  maskArtifact: Record<string, unknown>;
  expectedEditMode: VertexEditMode;
}): void {
  validateVertexEditPredictPayloadFlat(params);
}

function validateVertexEditPredictPayloadFlat(params: {
  payload: VertexEditPredictPayload;
  sourceArtifact: Record<string, unknown>;
  maskArtifact: Record<string, unknown>;
  expectedEditMode: VertexEditMode;
}): void {
  const firstInstance = params.payload.instances[0];
  if (!firstInstance) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat edit payload is missing instances[0]",
      "imagen_edit_payload_flat_missing_instance"
    );
  }

  if (typeof firstInstance.prompt !== "string" || firstInstance.prompt.trim().length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat edit payload is missing a prompt",
      "imagen_edit_payload_flat_missing_prompt"
    );
  }

  if (!Array.isArray(firstInstance.referenceImages) || firstInstance.referenceImages.length < 2) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat edit payload is missing required reference images",
      "imagen_edit_payload_flat_missing_reference_images"
    );
  }
  if (firstInstance.referenceImages.length !== VERTEX_EDIT_REFERENCE_ORDER.length) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat edit payload has invalid reference image count: ${firstInstance.referenceImages.length}`,
      "imagen_edit_payload_flat_invalid_reference_image_count"
    );
  }

  const sourceEntry = firstInstance.referenceImages[0] as VertexReferenceImageContainer & Record<string, unknown>;
  if (sourceEntry.referenceType !== VERTEX_REFERENCE_TYPE_RAW) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat source reference is missing required referenceType ${VERTEX_REFERENCE_TYPE_RAW}`,
      "imagen_edit_payload_flat_invalid_source_reference_type"
    );
  }
  if (typeof sourceEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference is missing required referenceId",
      "imagen_edit_payload_flat_missing_source_reference_id"
    );
  }
  if (sourceEntry.rawReferenceImage !== undefined || sourceEntry.maskReferenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference unexpectedly contains wrapper keys",
      "imagen_edit_payload_flat_source_wrapper_leak"
    );
  }
  if (sourceEntry.config !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source reference must not include config",
      "imagen_edit_payload_flat_source_unexpected_config"
    );
  }
  const sourceImage = sourceEntry.referenceImage;
  if (!sourceImage || typeof sourceImage !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source referenceImage is missing",
      "imagen_edit_payload_flat_missing_source_reference_image"
    );
  }
  const sourceBytesLength = typeof sourceImage.bytesBase64Encoded === "string"
    ? sourceImage.bytesBase64Encoded.length : 0;
  if (!sourceImage.gcsUri && sourceBytesLength <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat source referenceImage is missing bytes and uri",
      "imagen_edit_payload_flat_missing_source_image"
    );
  }
  if (!isSupportedVertexImageMimeType(sourceImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat source image MIME type is invalid for edit payload: ${String(sourceImage.mimeType || "unknown")}`,
      "imagen_edit_payload_flat_invalid_source_mime_type"
    );
  }

  const maskEntry = firstInstance.referenceImages[1] as VertexReferenceImageContainer & Record<string, unknown>;
  if (maskEntry.referenceType !== VERTEX_REFERENCE_TYPE_MASK) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat mask reference is missing required referenceType ${VERTEX_REFERENCE_TYPE_MASK}`,
      "imagen_edit_payload_flat_invalid_mask_reference_type"
    );
  }
  if (typeof maskEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference is missing required referenceId",
      "imagen_edit_payload_flat_missing_mask_reference_id"
    );
  }
  if (maskEntry.image !== undefined || maskEntry.rawReferenceImage !== undefined || maskEntry.maskReferenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference unexpectedly contains legacy image or wrapper keys",
      "imagen_edit_payload_flat_mask_wrapper_leak"
    );
  }
  const maskImage = maskEntry.referenceImage;
  if (!maskImage || typeof maskImage !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask referenceImage is missing",
      "imagen_edit_payload_flat_missing_mask_reference_image"
    );
  }
  const maskBytesLength = typeof maskImage.bytesBase64Encoded === "string"
    ? maskImage.bytesBase64Encoded.length : 0;
  if (!maskImage.gcsUri && maskBytesLength <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask referenceImage is missing bytes and uri",
      "imagen_edit_payload_flat_missing_mask_image"
    );
  }
  if (!isSupportedVertexImageMimeType(maskImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat mask image MIME type is invalid for edit payload: ${String(maskImage.mimeType || "unknown")}`,
      "imagen_edit_payload_flat_invalid_mask_mime_type"
    );
  }
  if (!maskEntry.maskImageConfig || maskEntry.maskImageConfig.maskMode !== VERTEX_MASK_MODE_USER_PROVIDED) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat maskImageConfig is missing required maskMode ${VERTEX_MASK_MODE_USER_PROVIDED}`,
      "imagen_edit_payload_flat_missing_mask_mode"
    );
  }

  if (params.payload.parameters.editMode !== params.expectedEditMode) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat edit payload is missing ${params.expectedEditMode}`,
      "imagen_edit_payload_flat_missing_edit_mode"
    );
  }
  if (Number(params.sourceArtifact.sizeBytes || 0) <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source image artifact is empty before SDK execution",
      "imagen_source_image_empty_before_sdk_execution"
    );
  }
  if (Number(params.maskArtifact.sizeBytes || 0) <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask image artifact is empty before SDK execution",
      "imagen_mask_image_empty_before_sdk_execution"
    );
  }
}

function validateVertexEditPredictPayloadForMode(params: {
  payload: VertexEditPredictPayload;
  sourceArtifact: Record<string, unknown>;
  maskArtifact: Record<string, unknown>;
  expectedEditMode: VertexEditMode;
  payloadSchemaMode: VertexPayloadSchemaMode;
}): void {
  if (params.payloadSchemaMode === "flat") {
    validateVertexEditPredictPayloadFlat(params);
    return;
  }
  validateVertexEditPredictPayload(params);
}

async function buildVerifiedVertexImagePayload(
  reference: ImageRenderRequest["sourceImage"],
  role: "source" | "mask"
): Promise<{ payload: Record<string, unknown>; artifact: Record<string, unknown> }> {
  const artifact = await inspectRenderArtifact(reference, role);

  if (reference.kind === "gcs" && reference.uri) {
    return {
      payload: toVertexImagePayload(reference),
      artifact,
    };
  }

  if (!reference.localPath) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image payload is missing local artifact data`,
      `imagen_${role}_image_missing_local_file`
    );
  }

  const fileBuffer = await fs.readFile(reference.localPath);
  if (fileBuffer.length <= 0) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity ${role} image local artifact serialized to empty bytes: ${reference.localPath}`,
      `imagen_${role}_image_empty_serialized_bytes`
    );
  }

  return {
    payload: {
      bytesBase64Encoded: fileBuffer.toString("base64"),
      mimeType: (artifact.decodedMimeType as string) || reference.mimeType,
    },
    artifact,
  };
}

type OutsideMaskDriftMetrics = {
  outsidePixelCount: number;
  meanAbsoluteDelta: number;
  changedPixelCount: number;
  changedPixelRatio: number;
};

async function measureOutsideMaskDrift(params: {
  sourcePath: string;
  candidatePath: string;
  maskPath: string;
  changeThreshold: number;
}): Promise<OutsideMaskDriftMetrics> {
  const sourceMeta = await sharp(params.sourcePath).metadata();
  const width = Number(sourceMeta.width || 0);
  const height = Number(sourceMeta.height || 0);
  if (!width || !height) {
    throw new VertexSecondaryContinuityError(
      `Unable to read source dimensions for outside-mask drift validation: ${params.sourcePath}`,
      "continuity_drift_missing_source_dimensions"
    );
  }

  const [sourceRaw, candidateRaw, maskRaw] = await Promise.all([
    sharp(params.sourcePath)
      .removeAlpha()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer(),
    sharp(params.candidatePath)
      .removeAlpha()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer(),
    sharp(params.maskPath)
      .removeAlpha()
      .grayscale()
      .resize(width, height, { fit: "fill", kernel: sharp.kernel.nearest })
      .raw()
      .toBuffer(),
  ]);

  let outsidePixelCount = 0;
  let changedPixelCount = 0;
  let deltaSum = 0;
  const threshold = Math.max(0, Number(params.changeThreshold));

  for (let index = 0; index < maskRaw.length; index += 1) {
    const maskValue = maskRaw[index] ?? 0;
    if (maskValue >= 128) {
      continue;
    }
    outsidePixelCount += 1;
    const sourceOffset = index * 3;
    const dr = Math.abs((sourceRaw[sourceOffset] ?? 0) - (candidateRaw[sourceOffset] ?? 0));
    const dg = Math.abs((sourceRaw[sourceOffset + 1] ?? 0) - (candidateRaw[sourceOffset + 1] ?? 0));
    const db = Math.abs((sourceRaw[sourceOffset + 2] ?? 0) - (candidateRaw[sourceOffset + 2] ?? 0));
    const meanDelta = (dr + dg + db) / 3;
    deltaSum += meanDelta;
    if (Math.max(dr, dg, db) >= threshold) {
      changedPixelCount += 1;
    }
  }

  const meanAbsoluteDelta = outsidePixelCount > 0 ? deltaSum / outsidePixelCount : 0;
  const changedPixelRatio = outsidePixelCount > 0 ? changedPixelCount / outsidePixelCount : 0;

  return {
    outsidePixelCount,
    meanAbsoluteDelta,
    changedPixelCount,
    changedPixelRatio,
  };
}

async function validateOutsideMaskDrift(params: {
  request: ImageRenderRequest;
  sourcePath?: string;
  maskPath?: string;
  candidatePath: string;
  profile: ContinuityRendererProfile;
}): Promise<void> {
  if (!params.sourcePath || !params.maskPath) {
    nLog("[VERTEX_CONTINUITY_OUTSIDE_MASK_DRIFT]", {
      continuityGroupId: params.request.continuityGroupId || null,
      imageId: params.request.imageId,
      jobId: params.request.jobId,
      renderMode: params.request.renderMode,
      isolationMode: params.profile.isolationMode,
      skipped: true,
      reason: "missing_source_or_mask_local_path",
    });
    return;
  }

  const metrics = await measureOutsideMaskDrift({
    sourcePath: params.sourcePath,
    candidatePath: params.candidatePath,
    maskPath: params.maskPath,
    changeThreshold: params.profile.outsideMaskChangeThreshold,
  });

  const meanAbsoluteDelta = Number(metrics.meanAbsoluteDelta.toFixed(4));
  const changedPixelRatio = Number(metrics.changedPixelRatio.toFixed(6));
  const exceedsMae = meanAbsoluteDelta > params.profile.outsideMaskMaxMae;
  const exceedsChangedRatio = changedPixelRatio > params.profile.outsideMaskMaxChangedRatio;

  nLog("[VERTEX_CONTINUITY_OUTSIDE_MASK_DRIFT]", {
    continuityGroupId: params.request.continuityGroupId || null,
    imageId: params.request.imageId,
    jobId: params.request.jobId,
    renderMode: params.request.renderMode,
    isolationMode: params.profile.isolationMode,
    outsidePixelCount: metrics.outsidePixelCount,
    changedPixelCount: metrics.changedPixelCount,
    meanAbsoluteDelta,
    changedPixelRatio,
    maxMae: params.profile.outsideMaskMaxMae,
    maxChangedRatio: params.profile.outsideMaskMaxChangedRatio,
    changeThreshold: params.profile.outsideMaskChangeThreshold,
    status: exceedsMae || exceedsChangedRatio ? "failed" : "passed",
  });

  if (exceedsMae || exceedsChangedRatio) {
    throw new VertexSecondaryContinuityError(
      `Outside-mask drift exceeded thresholds (mae=${meanAbsoluteDelta}, ratio=${changedPixelRatio})`,
      "continuity_outside_mask_drift_exceeded"
    );
  }
}

export class VertexImageRendererProvider implements ImageRendererProvider {
  async render(request: ImageRenderRequest): Promise<ImageRenderResponse> {
    const rendererFlag = String(process.env.SECONDARY_CONTINUITY_RENDERER || "imagen3").trim().toLowerCase();
    const model = rendererFlag === "imagen3" ? "imagen-3.0-capability-001" : rendererFlag;
    const guidanceScale = request.guidanceScale ?? Number(process.env.VERTEX_CONTINUITY_GUIDANCE_SCALE || 12);
    const renderProfile = resolveContinuityRendererProfile(request);
    const ai = getVertexGenAiClient();
    const startedAt = Date.now();
    const prompt = buildModeScopedPrompt({
      renderMode: request.renderMode,
      basePrompt: request.prompt,
      intentInstruction: request.intent?.userInstruction,
    });
    const sourceSnapshot = await snapshotLocalRenderReference({
      reference: request.sourceImage,
      role: "source",
      outputPath: request.outputPath,
    });
    const maskSnapshot = await snapshotLocalRenderReference({
      reference: request.maskImage,
      role: "mask",
      outputPath: request.outputPath,
    });
    const sourceReference = sourceSnapshot.reference;
    const maskReference = maskSnapshot.reference;
    const aspectRatioNormalization = await maybeNormalizeVertexAspectRatio({
      request,
      sourceReference,
      maskReference,
    });

    const sourcePrepared = await buildVerifiedVertexImagePayload(sourceReference, "source");
    const maskPrepared = await buildVerifiedVertexImagePayload(maskReference, "mask");
    const sourceArtifact = sourcePrepared.artifact;
    const maskArtifact = maskPrepared.artifact;
    const sourcePayload = sourcePrepared.payload;
    const maskPayload = maskPrepared.payload;
    const payloadSchemaMode = resolveVertexPayloadSchemaMode();
    const sourcePayloadSummary = summarizeVertexImagePayload(sourcePayload);
    const maskPayloadSummary = summarizeVertexImagePayload(maskPayload);

    if (!sourcePayloadSummary.hasInlineBytes && !sourcePayloadSummary.hasGcsUri) {
      throw new VertexSecondaryContinuityError(
        "Vertex continuity source image payload resolved without raw bytes or gs:// URI",
        "imagen_source_image_payload_missing"
      );
    }
    if (!maskPayloadSummary.hasInlineBytes && !maskPayloadSummary.hasGcsUri) {
      throw new VertexSecondaryContinuityError(
        "Vertex continuity mask image payload resolved without raw bytes or gs:// URI",
        "imagen_mask_image_payload_missing"
      );
    }

    nLog("[VERTEX_CONTINUITY_RENDER_SOURCE_PREFLIGHT]", {
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
      isolationMode: renderProfile.isolationMode,
      payloadSchemaMode,
      sourceArtifact,
      maskArtifact,
      sourceSnapshotPath: sourceSnapshot.snapshotPath,
      maskSnapshotPath: maskSnapshot.snapshotPath,
      sourcePayloadSummary,
      maskPayloadSummary,
    });

    const payload = buildVertexEditPredictPayloadForMode({
      prompt,
      sourcePayload: sourcePayload as VertexWireImagePayload,
      maskPayload: maskPayload as VertexWireImagePayload,
      guidanceScale,
      renderProfile,
      payloadSchemaMode,
    });
    validateVertexEditPredictPayloadForMode({
      payload,
      sourceArtifact,
      maskArtifact,
      expectedEditMode: renderProfile.editMode,
      payloadSchemaMode,
    });
    const serializedPayload = JSON.stringify(payload);
    validateSerializedVertexEditPredictPayloadForMode({
      serializedPayload,
      payloadSchemaMode,
    });
    const serializedPayloadAudit = buildSerializedVertexEditPredictPayloadAudit(serializedPayload, payloadSchemaMode);

    nLog("[VERTEX_CONTINUITY_RENDER_PAYLOAD]", {
      phase: "created",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
      isolationMode: renderProfile.isolationMode,
      payloadSchemaMode,
      sourceImage: {
        kind: sourceReference.kind,
        localPath: sourceReference.localPath || null,
        uri: sourceReference.uri || null,
      },
      maskImage: {
        kind: maskReference.kind,
        localPath: maskReference.localPath || null,
        uri: maskReference.uri || null,
      },
      sourceArtifact,
      maskArtifact,
      sourceSnapshotPath: sourceSnapshot.snapshotPath,
      maskSnapshotPath: maskSnapshot.snapshotPath,
      sourcePayloadSummary,
      maskPayloadSummary,
      promptLength: prompt.length,
      guidanceScale,
      outputPath: request.outputPath,
      payloadValidation: {
        payloadSchemaMode,
        expectedEditMode: renderProfile.editMode,
        expectedMaskDilation: renderProfile.maskDilation,
        status: "passed",
      },
    });

    nLog("[VERTEX_CONTINUITY_RENDER_SDK_REQUEST]", {
      phase: "before-execution",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
      isolationMode: renderProfile.isolationMode,
      payloadSchemaMode,
      sdkRequest: {
        path: `${resolveModelResource(model)}:predict`,
        httpMethod: "POST",
        body: redactVertexEditPredictPayload(payload, payloadSchemaMode),
        bodyJsonRedacted: serializedPayloadAudit.parsedPayloadJson,
      },
      parsedSerializedBody: serializedPayloadAudit.parsedPayload,
      serializedBodyBytes: Buffer.byteLength(serializedPayload, "utf8"),
      payloadValidation: {
        payloadSchemaMode,
        expectedEditMode: renderProfile.editMode,
        expectedMaskDilation: renderProfile.maskDilation,
        status: "passed",
      },
    });

    nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
      phase: "start",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
      isolationMode: renderProfile.isolationMode,
      payloadSchemaMode,
      prompt,
      sourceTransport: request.sourceImage.kind,
      maskTransport: request.maskImage.kind,
    });

    nLog("[VERTEX_CONTINUITY_RENDER]", {
      phase: "start",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      workerIdentity: request.workerIdentity || null,
      model,
      isolationMode: renderProfile.isolationMode,
      payloadSchemaMode,
      guidanceScale,
    });

    try {
      const apiClient = (ai as any).apiClient;
      const endpoint = `${resolveModelResource(model)}:predict`;
      logFinalImagenRequestBoundary({
        endpoint,
        model,
        serializedPayload,
      });
      const rawResponse = await apiClient.request({
        path: endpoint,
        body: serializedPayload,
        httpMethod: "POST",
        httpOptions: {
          timeout: 120000,
        },
      }).then((response: any) => response.json());

      const generated = extractGeneratedImage(rawResponse);
      const imageBuffer = Buffer.from(generated.imageBytes, "base64");
      if (aspectRatioNormalization) {
        const generatedMetadata = await sharp(imageBuffer).metadata();
        if (
          !generatedMetadata.width ||
          !generatedMetadata.height ||
          generatedMetadata.width < aspectRatioNormalization.paddedWidth ||
          generatedMetadata.height < aspectRatioNormalization.paddedHeight
        ) {
          throw new VertexSecondaryContinuityError(
            `Vertex generated image dimensions cannot restore original framing: generated=${generatedMetadata.width || 0}x${generatedMetadata.height || 0} expected_at_least=${aspectRatioNormalization.paddedWidth}x${aspectRatioNormalization.paddedHeight}`,
            "imagen_aspect_ratio_restoration_invalid_dimensions"
          );
        }

        await sharp(imageBuffer)
          .extract({
            left: aspectRatioNormalization.padLeft,
            top: aspectRatioNormalization.padTop,
            width: aspectRatioNormalization.originalWidth,
            height: aspectRatioNormalization.originalHeight,
          })
          .webp({ quality: 95 })
          .toFile(request.outputPath);

        nLog("[VERTEX_ASPECT_RATIO_RESTORATION]", {
          continuityGroupId: request.continuityGroupId || null,
          imageId: request.imageId,
          jobId: request.jobId,
          renderMode: request.renderMode,
          normalizationApplied: true,
          originalDimensions: {
            width: aspectRatioNormalization.originalWidth,
            height: aspectRatioNormalization.originalHeight,
          },
          paddedDimensions: {
            width: aspectRatioNormalization.paddedWidth,
            height: aspectRatioNormalization.paddedHeight,
          },
          generatedDimensions: {
            width: generatedMetadata.width,
            height: generatedMetadata.height,
          },
          crop: {
            left: aspectRatioNormalization.padLeft,
            top: aspectRatioNormalization.padTop,
            width: aspectRatioNormalization.originalWidth,
            height: aspectRatioNormalization.originalHeight,
          },
          targetRatio: aspectRatioNormalization.targetAspectRatio,
        });
      } else {
        await sharp(imageBuffer).webp({ quality: 95 }).toFile(request.outputPath);
        nLog("[VERTEX_ASPECT_RATIO_RESTORATION]", {
          continuityGroupId: request.continuityGroupId || null,
          imageId: request.imageId,
          jobId: request.jobId,
          renderMode: request.renderMode,
          normalizationApplied: false,
          originalDimensions: null,
          paddedDimensions: null,
          generatedDimensions: null,
          crop: null,
          targetRatio: null,
        });
      }

      await validateOutsideMaskDrift({
        request,
        sourcePath: request.sourceImage.localPath,
        maskPath: request.maskImage.localPath,
        candidatePath: request.outputPath,
        profile: renderProfile,
      });

      await fs.access(request.outputPath);
      const latencyMs = Date.now() - startedAt;

      nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        model,
        isolationMode: renderProfile.isolationMode,
        payloadSchemaMode,
        latencyMs,
        outputPath: request.outputPath,
        mimeType: generated.mimeType,
      });

      nLog("[VERTEX_CONTINUITY_RENDER]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        workerIdentity: request.workerIdentity || null,
        model,
        isolationMode: renderProfile.isolationMode,
        payloadSchemaMode,
        guidanceScale,
        latencyMs,
        outputPath: request.outputPath,
      });

      return {
        outputPath: request.outputPath,
        model,
        latencyMs,
        mimeType: generated.mimeType,
        guidanceScale,
        payload: payload as unknown as Record<string, unknown>,
      };
    } catch (error: any) {
      // Extract structured Vertex error body from the SDK ClientError message string
      let vertexErrorBody: Record<string, unknown> | null = null;
      try {
        const msgStr = typeof error?.message === "string" ? error.message : "";
        const jsonMatch = msgStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          vertexErrorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        }
      } catch {
        // ignore parse failures — raw message is still logged below
      }

      nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
        phase: "failure",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        model,
        isolationMode: renderProfile.isolationMode,
        payloadSchemaMode,
        outputPath: request.outputPath,
        error: error?.message || String(error),
        vertexErrorBody,
        stack: error instanceof Error ? error.stack || null : null,
      });

      nLog("[VERTEX_CONTINUITY_RENDER]", {
        phase: "failure",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        workerIdentity: request.workerIdentity || null,
        model,
        isolationMode: renderProfile.isolationMode,
        payloadSchemaMode,
        guidanceScale,
        error: error?.message || String(error),
        vertexErrorBody,
      });
      throw error;
    }
  }
}