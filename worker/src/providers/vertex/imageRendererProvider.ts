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

// Wire-format constants — declared before types that use typeof on them.
const SUPPORTED_VERTEX_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VERTEX_EDIT_REFERENCE_ORDER = ["source", "mask"] as const;
const VERTEX_REFERENCE_TYPE_RAW = "REFERENCE_TYPE_RAW" as const;
const VERTEX_REFERENCE_TYPE_MASK = "REFERENCE_TYPE_MASK" as const;
const VERTEX_MASK_MODE_USER_PROVIDED = "MASK_MODE_USER_PROVIDED" as const;
const VERTEX_EDIT_MODE_INPAINT_INSERTION = "EDIT_MODE_INPAINT_INSERTION" as const;
const VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA_ENV = "VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA" as const;
const VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION_ENV = "VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION" as const;

const SUPPORTED_IMAGEN_ASPECT_RATIOS = [
  { label: "1:1", widthUnits: 1, heightUnits: 1, value: 1 },
  { label: "4:3", widthUnits: 4, heightUnits: 3, value: 4 / 3 },
  { label: "3:4", widthUnits: 3, heightUnits: 4, value: 3 / 4 },
  { label: "16:9", widthUnits: 16, heightUnits: 9, value: 16 / 9 },
  { label: "9:16", widthUnits: 9, heightUnits: 16, value: 9 / 16 },
] as const;

export type VertexPayloadSchemaMode = "wrapper" | "flat";

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

// Proto3 JSON wire format for EditableReferenceImage.raw_reference_image variant.
//
// IMPORTANT: The @google/genai SDK TypeScript types (RawReferenceImage, MaskReferenceImage)
// are user-facing abstractions. Had the SDK supported editing, it would transform them
// into these type-specific wrappers before the REST call. We bypass SDK serialization
// via raw apiClient.request(), so we MUST produce the proto3 JSON wire shape directly.
//
// Wrong (TypeScript SDK shape, NOT wire format):
//   { referenceImage: {...}, referenceId: 1, referenceType: "REFERENCE_TYPE_RAW" }
//
// Correct (proto3 JSON wire format):
//   { referenceId: 1, referenceType: "REFERENCE_TYPE_RAW", rawReferenceImage: { image: {...} } }
type VertexRawReferenceEntry = {
  referenceId: number;
  referenceType: typeof VERTEX_REFERENCE_TYPE_RAW;
  rawReferenceImage: {
    image: VertexWireImagePayload;
  };
};

// Proto3 JSON wire format for EditableReferenceImage.mask_reference_image variant.
// maskMode lives directly inside maskReferenceImage — NOT in a nested "config" sub-object.
type VertexMaskReferenceEntry = {
  referenceId: number;
  referenceType: typeof VERTEX_REFERENCE_TYPE_MASK;
  maskReferenceImage: {
    maskMode: string;
    image: VertexWireImagePayload;
  };
};

type VertexFlatRawReferenceEntry = {
  referenceId: number;
  referenceType: typeof VERTEX_REFERENCE_TYPE_RAW;
  referenceImage: VertexWireImagePayload;
};

type VertexFlatMaskReferenceEntry = {
  referenceId: number;
  referenceType: typeof VERTEX_REFERENCE_TYPE_MASK;
  referenceImage: VertexWireImagePayload;
  config: {
    maskMode: string;
  };
};

type VertexEditReferenceImage =
  | VertexRawReferenceEntry
  | VertexMaskReferenceEntry
  | VertexFlatRawReferenceEntry
  | VertexFlatMaskReferenceEntry;

type VertexEditPredictPayload = {
  instances: Array<{
    prompt: string;
    referenceImages: VertexEditReferenceImage[];
  }>;
  parameters: {
    sampleCount: number;
    guidanceScale: number;
    addWatermark: boolean;
    editMode: string;
    outputOptions: {
      mimeType: string;
    };
  };
};

function resolveVertexPayloadSchemaMode(): VertexPayloadSchemaMode {
  const rawValue = String(process.env[VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA_ENV] || "").trim().toLowerCase();
  return rawValue === "true" ? "flat" : "wrapper";
}

function isVertexImagenAspectRatioNormalizationEnabled(): boolean {
  return String(process.env[VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION_ENV] || "").trim().toLowerCase() === "true";
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
  if (params.renderMode === "full_secondary_continuity") {
    return [
      "Use the approved master as the furnishing identity source for visible secondary-view staging.",
      "Preserve architecture, openings, perspective, framing, and all content outside the compiled mask.",
      params.basePrompt,
    ].join(", ");
  }
  if (params.renderMode === "continuity_refresh") {
    return [
      "Refresh only mismatched or incomplete continuity details visible from this secondary angle.",
      "Do not restage the room broadly or rewrite protected architecture.",
      params.basePrompt,
    ].join(", ");
  }
  if (params.renderMode === "missing_object_insert") {
    return [
      normalizedIntent || "Insert only the missing approved furnishing implied by continuity.",
      "Keep the change localized to the compiled continuity mask.",
      "Do not reposition unrelated furniture or redesign the room.",
      params.basePrompt,
    ].join(", ");
  }
  return [
    normalizedIntent || "Perform only the localized secondary continuity repair requested.",
    "Keep the change surgical and restricted to the compiled continuity mask.",
    "Preserve unrelated furnishings, architecture, and composition.",
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
}): VertexEditPredictPayload {
  return {
    instances: [
      {
        prompt: params.prompt,
        referenceImages: [
          {
            referenceId: 1,
            referenceType: VERTEX_REFERENCE_TYPE_RAW,
            rawReferenceImage: {
              image: params.sourcePayload,
            },
          },
          {
            referenceId: 2,
            referenceType: VERTEX_REFERENCE_TYPE_MASK,
            maskReferenceImage: {
              maskMode: VERTEX_MASK_MODE_USER_PROVIDED,
              image: params.maskPayload,
            },
          },
        ],
      },
    ],
    parameters: {
      sampleCount: 1,
      guidanceScale: params.guidanceScale,
      addWatermark: false,
      editMode: VERTEX_EDIT_MODE_INPAINT_INSERTION,
      outputOptions: {
        mimeType: "image/png",
      },
    },
  };
}

export function buildVertexEditPredictPayloadFlat(params: {
  prompt: string;
  sourcePayload: VertexWireImagePayload;
  maskPayload: VertexWireImagePayload;
  guidanceScale: number;
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
            config: {
              maskMode: VERTEX_MASK_MODE_USER_PROVIDED,
            },
          },
        ],
      },
    ],
    parameters: {
      sampleCount: 1,
      guidanceScale: params.guidanceScale,
      addWatermark: false,
      editMode: VERTEX_EDIT_MODE_INPAINT_INSERTION,
      outputOptions: {
        mimeType: "image/png",
      },
    },
  };
}

export function buildVertexEditPredictPayloadForMode(params: {
  prompt: string;
  sourcePayload: VertexWireImagePayload;
  maskPayload: VertexWireImagePayload;
  guidanceScale: number;
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
        if (payloadSchemaMode === "flat") {
          const flatEntry = entry as VertexFlatRawReferenceEntry | VertexFlatMaskReferenceEntry;
          return {
            ...base,
            referenceImage: redactVertexWireImagePayload(flatEntry.referenceImage),
            ...(flatEntry.referenceType === VERTEX_REFERENCE_TYPE_MASK
              ? {
                  config: {
                    maskMode: (flatEntry as VertexFlatMaskReferenceEntry).config?.maskMode,
                  },
                }
              : {}),
          };
        }
        if (entry.referenceType === VERTEX_REFERENCE_TYPE_RAW) {
          const raw = entry as VertexRawReferenceEntry;
          return {
            ...base,
            rawReferenceImage: {
              image: redactVertexWireImagePayload(raw.rawReferenceImage.image),
            },
          };
        }
        const mask = entry as VertexMaskReferenceEntry;
        return {
          ...base,
          maskReferenceImage: {
            maskMode: mask.maskReferenceImage.maskMode,
            image: redactVertexWireImagePayload(mask.maskReferenceImage.image),
          },
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

  const directImage = reference.image;
  if (directImage && typeof directImage === "object") {
    return directImage as Record<string, unknown>;
  }

  const flatImage = reference.referenceImage;
  if (flatImage && typeof flatImage === "object") {
    return flatImage as Record<string, unknown>;
  }

  const rawWrapper = reference.rawReferenceImage;
  if (rawWrapper && typeof rawWrapper === "object") {
    const rawImage = (rawWrapper as Record<string, unknown>).image;
    if (rawImage && typeof rawImage === "object") {
      return rawImage as Record<string, unknown>;
    }
  }

  const maskWrapper = reference.maskReferenceImage;
  if (maskWrapper && typeof maskWrapper === "object") {
    const maskImage = (maskWrapper as Record<string, unknown>).image;
    if (maskImage && typeof maskImage === "object") {
      return maskImage as Record<string, unknown>;
    }
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
    nestedImageKeys: Object.keys((referenceImages?.[0] as { image?: Record<string, unknown> } | undefined)?.image || {}),
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
  let parsedPayload: VertexEditPredictPayload;
  try {
    parsedPayload = safeJsonParse<VertexEditPredictPayload>(params.serializedPayload);
  } catch (error) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity edit payload failed JSON serialization integrity check: ${error instanceof Error ? error.message : String(error)}`,
      "imagen_edit_payload_serialization_invalid_json"
    );
  }

  const firstInstance = parsedPayload.instances?.[0];
  if (!firstInstance || !Array.isArray(firstInstance.referenceImages)) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload lost referenceImages during serialization",
      "imagen_edit_payload_serialization_missing_reference_images"
    );
  }

  if (firstInstance.referenceImages.length !== VERTEX_EDIT_REFERENCE_ORDER.length) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity edit payload serialized with invalid reference image count: ${firstInstance.referenceImages.length}`,
      "imagen_edit_payload_serialization_invalid_reference_image_count"
    );
  }

  // Guard: source must use rawReferenceImage wrapper (proto3 wire format)
  const sourceEntry = firstInstance.referenceImages[0] as Record<string, unknown>;
  if (!sourceEntry || typeof sourceEntry !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference entry is missing after serialization",
      "imagen_edit_payload_serialization_missing_source_entry"
    );
  }
  if (sourceEntry.referenceType !== VERTEX_REFERENCE_TYPE_RAW) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source reference lost referenceType ${VERTEX_REFERENCE_TYPE_RAW} during serialization`,
      "imagen_edit_payload_serialization_invalid_source_reference_type"
    );
  }
  if (typeof sourceEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference lost required referenceId during serialization",
      "imagen_edit_payload_serialization_missing_source_reference_id"
    );
  }
  const sourceRawWrapper = sourceEntry.rawReferenceImage as Record<string, unknown> | undefined;
  if (!sourceRawWrapper || typeof sourceRawWrapper !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference lost rawReferenceImage wrapper during serialization",
      "imagen_edit_payload_serialization_missing_source_raw_wrapper"
    );
  }
  const sourceInnerImage = sourceRawWrapper.image as Record<string, unknown> | undefined;
  if (!sourceInnerImage || typeof sourceInnerImage !== "object" || Object.keys(sourceInnerImage).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.image is missing or empty after serialization",
      "imagen_edit_payload_serialization_missing_source_inner_image"
    );
  }
  if (sourceRawWrapper.referenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage contains legacy referenceImage key after serialization",
      "imagen_edit_payload_serialization_source_legacy_inner_reference_image"
    );
  }
  if (!isSupportedVertexImageMimeType(sourceInnerImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source image lost a valid mimeType during serialization`,
      "imagen_edit_payload_serialization_invalid_source_mime_type"
    );
  }
  const sourceBytesB64 = typeof sourceInnerImage.bytesBase64Encoded === "string" ? sourceInnerImage.bytesBase64Encoded : "";
  if (!sourceInnerImage.gcsUri && sourceBytesB64.length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.image lost bytes and uri during serialization",
      "imagen_edit_payload_serialization_missing_source_image_data"
    );
  }
  // Guard: source must NOT have legacy flat referenceImage at outer level
  if (sourceEntry.referenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference contains legacy flat referenceImage at outer level — must use rawReferenceImage wrapper",
      "imagen_edit_payload_serialization_source_legacy_flat_reference_image"
    );
  }

  // Guard: mask must use maskReferenceImage wrapper (proto3 wire format)
  const maskEntry = firstInstance.referenceImages[1] as Record<string, unknown>;
  if (!maskEntry || typeof maskEntry !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference entry is missing after serialization",
      "imagen_edit_payload_serialization_missing_mask_entry"
    );
  }
  if (maskEntry.referenceType !== VERTEX_REFERENCE_TYPE_MASK) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask reference lost referenceType ${VERTEX_REFERENCE_TYPE_MASK} during serialization`,
      "imagen_edit_payload_serialization_invalid_mask_reference_type"
    );
  }
  if (typeof maskEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference lost required referenceId during serialization",
      "imagen_edit_payload_serialization_missing_mask_reference_id"
    );
  }
  const maskWrapper = maskEntry.maskReferenceImage as Record<string, unknown> | undefined;
  if (!maskWrapper || typeof maskWrapper !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference lost maskReferenceImage wrapper during serialization",
      "imagen_edit_payload_serialization_missing_mask_wrapper"
    );
  }
  if (maskWrapper.maskMode !== VERTEX_MASK_MODE_USER_PROVIDED) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity maskReferenceImage.maskMode lost ${VERTEX_MASK_MODE_USER_PROVIDED} during serialization`,
      "imagen_edit_payload_serialization_invalid_mask_mode"
    );
  }
  const maskInnerImage = maskWrapper.image as Record<string, unknown> | undefined;
  if (!maskInnerImage || typeof maskInnerImage !== "object" || Object.keys(maskInnerImage).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.image is missing or empty after serialization",
      "imagen_edit_payload_serialization_missing_mask_inner_image"
    );
  }
  if (maskWrapper.referenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage contains legacy referenceImage key after serialization",
      "imagen_edit_payload_serialization_mask_legacy_inner_reference_image"
    );
  }
  if (!isSupportedVertexImageMimeType(maskInnerImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask image lost a valid mimeType during serialization`,
      "imagen_edit_payload_serialization_invalid_mask_mime_type"
    );
  }
  const maskBytesB64 = typeof maskInnerImage.bytesBase64Encoded === "string" ? maskInnerImage.bytesBase64Encoded : "";
  if (!maskInnerImage.gcsUri && maskBytesB64.length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.image lost bytes and uri during serialization",
      "imagen_edit_payload_serialization_missing_mask_image_data"
    );
  }
  // Guard: mask must NOT have legacy flat referenceImage at outer level
  if (maskEntry.referenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference contains legacy flat referenceImage at outer level — must use maskReferenceImage wrapper",
      "imagen_edit_payload_serialization_mask_legacy_flat_reference_image"
    );
  }
  // Guard: mask must NOT have legacy config object at outer level
  if (maskEntry.config !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference contains legacy config object at outer level — maskMode must be inside maskReferenceImage",
      "imagen_edit_payload_serialization_mask_legacy_config"
    );
  }
  // Guard: parameters must NOT contain maskMode (belongs in maskReferenceImage, not parameters)
  if ((parsedPayload.parameters as Record<string, unknown>).maskMode !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity parameters contains maskMode — it must only be inside maskReferenceImage",
      "imagen_edit_payload_serialization_parameters_has_mask_mode"
    );
  }
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

  const sourceEntry = firstInstance.referenceImages[0] as Record<string, unknown>;
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

  const maskEntry = firstInstance.referenceImages[1] as Record<string, unknown>;
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
  const maskConfig = maskEntry.config as Record<string, unknown> | undefined;
  if (!maskConfig || maskConfig.maskMode !== VERTEX_MASK_MODE_USER_PROVIDED) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat mask config is missing required maskMode ${VERTEX_MASK_MODE_USER_PROVIDED}`,
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

  if ((parsedPayload.parameters as Record<string, unknown>).maskMode !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat parameters contains maskMode — it must only be inside referenceImages[1].config",
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
}): void {
  const firstInstance = params.payload.instances[0];
  if (!firstInstance) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing instances[0]",
      "imagen_edit_payload_missing_instance"
    );
  }

  if (typeof firstInstance.prompt !== "string" || firstInstance.prompt.trim().length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing a prompt",
      "imagen_edit_payload_missing_prompt"
    );
  }

  if (!Array.isArray(firstInstance.referenceImages) || firstInstance.referenceImages.length < 2) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing required reference images",
      "imagen_edit_payload_missing_reference_images"
    );
  }
  if (firstInstance.referenceImages.length !== VERTEX_EDIT_REFERENCE_ORDER.length) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity edit payload has invalid reference image count: ${firstInstance.referenceImages.length}`,
      "imagen_edit_payload_invalid_reference_image_count"
    );
  }

  // Validate source entry — must use rawReferenceImage wrapper (proto3 wire format)
  const sourceEntry = firstInstance.referenceImages[0] as VertexRawReferenceEntry;
  if (sourceEntry.referenceType !== VERTEX_REFERENCE_TYPE_RAW) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source reference is missing required referenceType ${VERTEX_REFERENCE_TYPE_RAW}`,
      "imagen_edit_payload_invalid_source_reference_type"
    );
  }
  if (typeof sourceEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference is missing required referenceId",
      "imagen_edit_payload_missing_source_reference_id"
    );
  }
  const sourceWrapper = sourceEntry.rawReferenceImage;
  if (!sourceWrapper || typeof sourceWrapper !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference is missing rawReferenceImage wrapper",
      "imagen_edit_payload_missing_source_raw_wrapper"
    );
  }
  const sourceInnerImage = sourceWrapper.image;
  if (!sourceInnerImage || typeof sourceInnerImage !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.image is missing",
      "imagen_edit_payload_missing_source_inner_image"
    );
  }
  if ((sourceWrapper as Record<string, unknown>).referenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage contains legacy referenceImage key",
      "imagen_edit_payload_legacy_source_inner_reference_image"
    );
  }
  const sourceBytesLength = typeof sourceInnerImage.bytesBase64Encoded === "string"
    ? sourceInnerImage.bytesBase64Encoded.length : 0;
  if (!sourceInnerImage.gcsUri && sourceBytesLength <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.image is missing bytes and uri",
      "imagen_edit_payload_missing_raw_source_image"
    );
  }
  if (!isSupportedVertexImageMimeType(sourceInnerImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source image MIME type is invalid for edit payload: ${String(sourceInnerImage.mimeType || "unknown")}`,
      "imagen_edit_payload_invalid_source_mime_type"
    );
  }

  // Validate mask entry — must use maskReferenceImage wrapper (proto3 wire format)
  const maskEntry = firstInstance.referenceImages[1] as VertexMaskReferenceEntry;
  if (maskEntry.referenceType !== VERTEX_REFERENCE_TYPE_MASK) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask reference is missing required referenceType ${VERTEX_REFERENCE_TYPE_MASK}`,
      "imagen_edit_payload_invalid_mask_reference_type"
    );
  }
  if (typeof maskEntry.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference is missing required referenceId",
      "imagen_edit_payload_missing_mask_reference_id"
    );
  }
  const maskWrapper = maskEntry.maskReferenceImage;
  if (!maskWrapper || typeof maskWrapper !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference is missing maskReferenceImage wrapper",
      "imagen_edit_payload_missing_mask_wrapper"
    );
  }
  if (maskWrapper.maskMode !== VERTEX_MASK_MODE_USER_PROVIDED) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity maskReferenceImage is missing required maskMode ${VERTEX_MASK_MODE_USER_PROVIDED}`,
      "imagen_edit_payload_missing_mask_mode"
    );
  }
  const maskInnerImage = maskWrapper.image;
  if (!maskInnerImage || typeof maskInnerImage !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.image is missing",
      "imagen_edit_payload_missing_mask_inner_image"
    );
  }
  if ((maskWrapper as Record<string, unknown>).referenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage contains legacy referenceImage key",
      "imagen_edit_payload_legacy_mask_inner_reference_image"
    );
  }
  const maskBytesLength = typeof maskInnerImage.bytesBase64Encoded === "string"
    ? maskInnerImage.bytesBase64Encoded.length : 0;
  if (!maskInnerImage.gcsUri && maskBytesLength <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.image is missing bytes and uri",
      "imagen_edit_payload_missing_mask_image"
    );
  }
  if (!isSupportedVertexImageMimeType(maskInnerImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask image MIME type is invalid for edit payload: ${String(maskInnerImage.mimeType || "unknown")}`,
      "imagen_edit_payload_invalid_mask_mime_type"
    );
  }

  if (params.payload.parameters.editMode !== VERTEX_EDIT_MODE_INPAINT_INSERTION) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity edit payload is missing ${VERTEX_EDIT_MODE_INPAINT_INSERTION}`,
      "imagen_edit_payload_missing_edit_mode"
    );
  }
  if (params.payload.parameters.outputOptions?.mimeType !== "image/png") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing the required PNG output mime type",
      "imagen_edit_payload_invalid_output_mime_type"
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

function validateVertexEditPredictPayloadFlat(params: {
  payload: VertexEditPredictPayload;
  sourceArtifact: Record<string, unknown>;
  maskArtifact: Record<string, unknown>;
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

  const sourceEntry = firstInstance.referenceImages[0] as VertexFlatRawReferenceEntry & Record<string, unknown>;
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

  const maskEntry = firstInstance.referenceImages[1] as VertexFlatMaskReferenceEntry & Record<string, unknown>;
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
  if (maskEntry.rawReferenceImage !== undefined || maskEntry.maskReferenceImage !== undefined) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat mask reference unexpectedly contains wrapper keys",
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
  if (!maskEntry.config || maskEntry.config.maskMode !== VERTEX_MASK_MODE_USER_PROVIDED) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat mask config is missing required maskMode ${VERTEX_MASK_MODE_USER_PROVIDED}`,
      "imagen_edit_payload_flat_missing_mask_mode"
    );
  }

  if (params.payload.parameters.editMode !== VERTEX_EDIT_MODE_INPAINT_INSERTION) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity flat edit payload is missing ${VERTEX_EDIT_MODE_INPAINT_INSERTION}`,
      "imagen_edit_payload_flat_missing_edit_mode"
    );
  }
  if (params.payload.parameters.outputOptions?.mimeType !== "image/png") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity flat edit payload is missing the required PNG output mime type",
      "imagen_edit_payload_flat_invalid_output_mime_type"
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

export class VertexImageRendererProvider implements ImageRendererProvider {
  async render(request: ImageRenderRequest): Promise<ImageRenderResponse> {
    const rendererFlag = String(process.env.SECONDARY_CONTINUITY_RENDERER || "imagen3").trim().toLowerCase();
    const model = rendererFlag === "imagen3" ? "imagen-3.0-capability-001" : rendererFlag;
    const guidanceScale = request.guidanceScale ?? Number(process.env.VERTEX_CONTINUITY_GUIDANCE_SCALE || 12);
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
      payloadSchemaMode,
    });
    validateVertexEditPredictPayloadForMode({
      payload,
      sourceArtifact,
      maskArtifact,
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
      await fs.access(request.outputPath);
      const latencyMs = Date.now() - startedAt;

      nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        model,
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
        payload,
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
        payloadSchemaMode,
        guidanceScale,
        error: error?.message || String(error),
        vertexErrorBody,
      });
      throw error;
    }
  }
}