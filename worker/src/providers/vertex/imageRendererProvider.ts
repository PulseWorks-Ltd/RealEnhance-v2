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

type VertexEditReferenceImage = {
  referenceImage: VertexWireImagePayload;
  referenceId?: number;
  referenceType?: string;
  config?: {
    maskMode?: string;
  };
};

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

const SUPPORTED_VERTEX_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VERTEX_EDIT_REFERENCE_ORDER = ["source", "mask"] as const;
const VERTEX_REFERENCE_TYPE_RAW = "REFERENCE_TYPE_RAW";
const VERTEX_REFERENCE_TYPE_MASK = "REFERENCE_TYPE_MASK";

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
            referenceImage: params.sourcePayload,
            referenceId: 1,
            referenceType: VERTEX_REFERENCE_TYPE_RAW,
          },
          {
            referenceImage: params.maskPayload,
            referenceId: 2,
            referenceType: VERTEX_REFERENCE_TYPE_MASK,
            config: {
              maskMode: "MASK_MODE_USER_PROVIDED",
            },
          },
        ],
      },
    ],
    parameters: {
      sampleCount: 1,
      guidanceScale: params.guidanceScale,
      addWatermark: false,
      editMode: "EDIT_MODE_INPAINT_INSERTION",
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
      referenceImages: instance.referenceImages.map((referenceImage, index) => ({
        auditRole: VERTEX_EDIT_REFERENCE_ORDER[index] || `reference_${index}`,
        referenceImage: redactVertexWireImagePayload(referenceImage.referenceImage),
        ...(typeof referenceImage.referenceId === "number" ? { referenceId: referenceImage.referenceId } : {}),
        ...(typeof referenceImage.referenceType === "string" ? { referenceType: referenceImage.referenceType } : {}),
        ...(referenceImage.config ? { config: referenceImage.config } : {}),
      })),
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

  firstInstance.referenceImages.forEach((referenceImage, index) => {
    const expectedRole = VERTEX_EDIT_REFERENCE_ORDER[index] || `reference_${index}`;
    if (!referenceImage || typeof referenceImage !== "object") {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} reference entry became null or non-object during serialization`,
        `imagen_edit_payload_serialization_invalid_${expectedRole}_entry`
      );
    }
    if (!referenceImage.referenceImage || typeof referenceImage.referenceImage !== "object") {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} referenceImage is missing after serialization`,
        `imagen_edit_payload_serialization_missing_${expectedRole}_reference_image`
      );
    }
    if (Object.keys(referenceImage.referenceImage).length <= 0) {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} referenceImage serialized as an empty object`,
        `imagen_edit_payload_serialization_empty_${expectedRole}_reference_image`
      );
    }
    if (!isSupportedVertexImageMimeType(referenceImage.referenceImage.mimeType)) {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} referenceImage lost a valid mimeType during serialization`,
        `imagen_edit_payload_serialization_invalid_${expectedRole}_mime_type`
      );
    }
    const expectedReferenceType = index === 0 ? VERTEX_REFERENCE_TYPE_RAW : VERTEX_REFERENCE_TYPE_MASK;
    if (referenceImage.referenceType !== expectedReferenceType) {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} referenceImage lost required referenceType ${expectedReferenceType} during serialization`,
        `imagen_edit_payload_serialization_invalid_${expectedRole}_reference_type`
      );
    }
    const imageBytes = typeof referenceImage.referenceImage.bytesBase64Encoded === "string"
      ? referenceImage.referenceImage.bytesBase64Encoded
      : "";
    if (!referenceImage.referenceImage.gcsUri && imageBytes.length <= 0) {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} referenceImage lost bytes and uri during serialization`,
        `imagen_edit_payload_serialization_missing_${expectedRole}_image_data`
      );
    }
    if (typeof referenceImage.referenceId !== "number") {
      throw new VertexSecondaryContinuityError(
        `Vertex continuity ${expectedRole} referenceImage lost required referenceId during serialization`,
        `imagen_edit_payload_serialization_missing_${expectedRole}_reference_id`
      );
    }
  });

  if (firstInstance.referenceImages[0]?.config) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference must be first and must not include mask config",
      "imagen_edit_payload_serialization_invalid_source_reference_order"
    );
  }
  if (firstInstance.referenceImages[1]?.config?.maskMode !== "MASK_MODE_USER_PROVIDED") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference must be second and must preserve MASK_MODE_USER_PROVIDED after serialization",
      "imagen_edit_payload_serialization_invalid_mask_reference_order"
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

  const sourceReference = firstInstance.referenceImages[0]?.referenceImage;
  const maskReference = firstInstance.referenceImages[1]?.referenceImage;
  const maskConfig = firstInstance.referenceImages[1]?.config;
  const sourceReferenceType = firstInstance.referenceImages[0]?.referenceType;
  const maskReferenceType = firstInstance.referenceImages[1]?.referenceType;

  const sourceBytesLength = typeof sourceReference?.bytesBase64Encoded === "string"
    ? sourceReference.bytesBase64Encoded.length
    : 0;
  const maskBytesLength = typeof maskReference?.bytesBase64Encoded === "string"
    ? maskReference.bytesBase64Encoded.length
    : 0;

  if (!sourceReference || (!sourceReference.gcsUri && sourceBytesLength <= 0)) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing the raw source image in referenceImages[0].referenceImage",
      "imagen_edit_payload_missing_raw_source_image"
    );
  }
  if (Object.keys(sourceReference || {}).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source referenceImage is empty before SDK execution",
      "imagen_edit_payload_empty_source_reference_image"
    );
  }
  if (!maskReference || (!maskReference.gcsUri && maskBytesLength <= 0)) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing the user-provided mask in referenceImages[1].referenceImage",
      "imagen_edit_payload_missing_mask_image"
    );
  }
  if (Object.keys(maskReference || {}).length <= 0) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask referenceImage is empty before SDK execution",
      "imagen_edit_payload_empty_mask_reference_image"
    );
  }
  if (!isSupportedVertexImageMimeType(sourceReference.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source image MIME type is invalid for edit payload: ${String(sourceReference?.mimeType || "unknown")}`,
      "imagen_edit_payload_invalid_source_mime_type"
    );
  }
  if (!isSupportedVertexImageMimeType(maskReference.mimeType)) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask image MIME type is invalid for edit payload: ${String(maskReference?.mimeType || "unknown")}`,
      "imagen_edit_payload_invalid_mask_mime_type"
    );
  }
  if (sourceReferenceType !== VERTEX_REFERENCE_TYPE_RAW) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity source reference is missing required referenceType ${VERTEX_REFERENCE_TYPE_RAW}`,
      "imagen_edit_payload_invalid_source_reference_type"
    );
  }
  if (maskReferenceType !== VERTEX_REFERENCE_TYPE_MASK) {
    throw new VertexSecondaryContinuityError(
      `Vertex continuity mask reference is missing required referenceType ${VERTEX_REFERENCE_TYPE_MASK}`,
      "imagen_edit_payload_invalid_mask_reference_type"
    );
  }
  if (typeof firstInstance.referenceImages[0]?.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference is missing required referenceId",
      "imagen_edit_payload_missing_source_reference_id"
    );
  }
  if (typeof firstInstance.referenceImages[1]?.referenceId !== "number") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity mask reference is missing required referenceId",
      "imagen_edit_payload_missing_mask_reference_id"
    );
  }
  if (maskConfig?.maskMode !== "MASK_MODE_USER_PROVIDED") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing MASK_MODE_USER_PROVIDED on the mask reference",
      "imagen_edit_payload_missing_mask_mode"
    );
  }
  if (firstInstance.referenceImages[0]?.config) {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity source reference is in the wrong array position or incorrectly carries mask config",
      "imagen_edit_payload_invalid_source_reference_order"
    );
  }
  if (params.payload.parameters.editMode !== "EDIT_MODE_INPAINT_INSERTION") {
    throw new VertexSecondaryContinuityError(
      "Vertex continuity edit payload is missing EDIT_MODE_INPAINT_INSERTION",
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