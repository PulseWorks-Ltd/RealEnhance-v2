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
//   { referenceId: 1, referenceType: "REFERENCE_TYPE_RAW", rawReferenceImage: { referenceImage: {...} } }
type VertexRawReferenceEntry = {
  referenceId: number;
  referenceType: typeof VERTEX_REFERENCE_TYPE_RAW;
  rawReferenceImage: {
    referenceImage: VertexWireImagePayload;
  };
};

// Proto3 JSON wire format for EditableReferenceImage.mask_reference_image variant.
// maskMode lives directly inside maskReferenceImage — NOT in a nested "config" sub-object.
type VertexMaskReferenceEntry = {
  referenceId: number;
  referenceType: typeof VERTEX_REFERENCE_TYPE_MASK;
  maskReferenceImage: {
    maskMode: string;
    referenceImage: VertexWireImagePayload;
  };
};

type VertexEditReferenceImage = VertexRawReferenceEntry | VertexMaskReferenceEntry;

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
              referenceImage: params.sourcePayload,
            },
          },
          {
            referenceId: 2,
            referenceType: VERTEX_REFERENCE_TYPE_MASK,
            maskReferenceImage: {
              maskMode: VERTEX_MASK_MODE_USER_PROVIDED,
              referenceImage: params.maskPayload,
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

function redactVertexEditPredictPayload(payload: VertexEditPredictPayload): Record<string, unknown> {
  return {
    instances: payload.instances.map((instance) => ({
      prompt: instance.prompt,
      referenceImages: instance.referenceImages.map((entry, index) => {
        const auditRole = VERTEX_EDIT_REFERENCE_ORDER[index] || `reference_${index}`;
        const base = {
          auditRole,
          referenceId: entry.referenceId,
          referenceType: entry.referenceType,
        };
        if (entry.referenceType === VERTEX_REFERENCE_TYPE_RAW) {
          const raw = entry as VertexRawReferenceEntry;
          return {
            ...base,
            rawReferenceImage: {
              referenceImage: redactVertexWireImagePayload(raw.rawReferenceImage.referenceImage),
            },
          };
        }
        const mask = entry as VertexMaskReferenceEntry;
        return {
          ...base,
          maskReferenceImage: {
            maskMode: mask.maskReferenceImage.maskMode,
            referenceImage: redactVertexWireImagePayload(mask.maskReferenceImage.referenceImage),
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

function buildSerializedVertexEditPredictPayloadAudit(serializedPayload: string): {
  parsedPayload: Record<string, unknown>;
  parsedPayloadJson: string;
} {
  const parsedPayload = safeJsonParse<VertexEditPredictPayload>(serializedPayload);
  const redactedParsedPayload = redactVertexEditPredictPayload(parsedPayload);
  return {
    parsedPayload: redactedParsedPayload,
    parsedPayloadJson: JSON.stringify(redactedParsedPayload),
  };
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
  const sourceInnerImage = sourceRawWrapper.referenceImage as Record<string, unknown> | undefined;
  if (!sourceInnerImage || typeof sourceInnerImage !== "object" || Object.keys(sourceInnerImage).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.referenceImage is missing or empty after serialization",
      "imagen_edit_payload_serialization_missing_source_inner_image"
    );
  }
  if (!isSupportedVertexImageMimeType(sourceInnerImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source referenceImage lost a valid mimeType during serialization`,
      "imagen_edit_payload_serialization_invalid_source_mime_type"
    );
  }
  const sourceBytesB64 = typeof sourceInnerImage.bytesBase64Encoded === "string" ? sourceInnerImage.bytesBase64Encoded : "";
  if (!sourceInnerImage.gcsUri && sourceBytesB64.length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.referenceImage lost bytes and uri during serialization",
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
  const maskInnerImage = maskWrapper.referenceImage as Record<string, unknown> | undefined;
  if (!maskInnerImage || typeof maskInnerImage !== "object" || Object.keys(maskInnerImage).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.referenceImage is missing or empty after serialization",
      "imagen_edit_payload_serialization_missing_mask_inner_image"
    );
  }
  if (!isSupportedVertexImageMimeType(maskInnerImage.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask referenceImage lost a valid mimeType during serialization`,
      "imagen_edit_payload_serialization_invalid_mask_mime_type"
    );
  }
  const maskBytesB64 = typeof maskInnerImage.bytesBase64Encoded === "string" ? maskInnerImage.bytesBase64Encoded : "";
  if (!maskInnerImage.gcsUri && maskBytesB64.length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.referenceImage lost bytes and uri during serialization",
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
  const sourceInnerImage = sourceWrapper.referenceImage;
  if (!sourceInnerImage || typeof sourceInnerImage !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.referenceImage is missing",
      "imagen_edit_payload_missing_source_inner_image"
    );
  }
  const sourceBytesLength = typeof sourceInnerImage.bytesBase64Encoded === "string"
    ? sourceInnerImage.bytesBase64Encoded.length : 0;
  if (!sourceInnerImage.gcsUri && sourceBytesLength <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source rawReferenceImage.referenceImage is missing bytes and uri",
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
  const maskInnerImage = maskWrapper.referenceImage;
  if (!maskInnerImage || typeof maskInnerImage !== "object") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.referenceImage is missing",
      "imagen_edit_payload_missing_mask_inner_image"
    );
  }
  const maskBytesLength = typeof maskInnerImage.bytesBase64Encoded === "string"
    ? maskInnerImage.bytesBase64Encoded.length : 0;
  if (!maskInnerImage.gcsUri && maskBytesLength <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask maskReferenceImage.referenceImage is missing bytes and uri",
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

    const sourcePrepared = await buildVerifiedVertexImagePayload(sourceReference, "source");
    const maskPrepared = await buildVerifiedVertexImagePayload(maskReference, "mask");
    const sourceArtifact = sourcePrepared.artifact;
    const maskArtifact = maskPrepared.artifact;
    const sourcePayload = sourcePrepared.payload;
    const maskPayload = maskPrepared.payload;
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
      sourceArtifact,
      maskArtifact,
      sourceSnapshotPath: sourceSnapshot.snapshotPath,
      maskSnapshotPath: maskSnapshot.snapshotPath,
      sourcePayloadSummary,
      maskPayloadSummary,
    });

    const payload = buildVertexEditPredictPayload({
      prompt,
      sourcePayload: sourcePayload as VertexWireImagePayload,
      maskPayload: maskPayload as VertexWireImagePayload,
      guidanceScale,
    });
    validateVertexEditPredictPayload({
      payload,
      sourceArtifact,
      maskArtifact,
    });
    const serializedPayload = JSON.stringify(payload);
    validateSerializedVertexEditPredictPayload({
      serializedPayload,
    });
    const serializedPayloadAudit = buildSerializedVertexEditPredictPayloadAudit(serializedPayload);

    nLog("[VERTEX_CONTINUITY_RENDER_PAYLOAD]", {
      phase: "created",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
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
    });

    nLog("[VERTEX_CONTINUITY_RENDER_SDK_REQUEST]", {
      phase: "before-execution",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
      sdkRequest: {
        path: `${resolveModelResource(model)}:predict`,
        httpMethod: "POST",
        body: redactVertexEditPredictPayload(payload),
        bodyJsonRedacted: serializedPayloadAudit.parsedPayloadJson,
      },
      parsedSerializedBody: serializedPayloadAudit.parsedPayload,
      serializedBodyBytes: Buffer.byteLength(serializedPayload, "utf8"),
    });

    nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
      phase: "start",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
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
      guidanceScale,
    });

    try {
      const apiClient = (ai as any).apiClient;
      const rawResponse = await apiClient.request({
        path: `${resolveModelResource(model)}:predict`,
        body: serializedPayload,
        httpMethod: "POST",
        httpOptions: {
          timeout: 120000,
        },
      }).then((response: any) => response.json());

      const generated = extractGeneratedImage(rawResponse);
      const imageBuffer = Buffer.from(generated.imageBytes, "base64");
      await sharp(imageBuffer).webp({ quality: 95 }).toFile(request.outputPath);
      await fs.access(request.outputPath);
      const latencyMs = Date.now() - startedAt;

      nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
        phase: "complete",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        model,
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
        guidanceScale,
        error: error?.message || String(error),
        vertexErrorBody,
      });
      throw error;
    }
  }
}