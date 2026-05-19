import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { nLog } from "../../logger";
import type { ContinuityRenderMode, PlacementPlan } from "../../continuity/types";
import { VertexSecondaryContinuityError } from "../../continuity/types";
import { toVertexImagePayload } from "../imageTransport";
import type { ImageRendererProvider, ImageRenderRequest, ImageRenderResponse } from "../types";
import { getVertexGenAiClient, getVertexProjectConfig } from "./adc";

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
  const bytesBase64Encoded = typeof payload.bytesBase64Encoded === "string"
    ? payload.bytesBase64Encoded
    : "";
  const gcsUri = typeof payload.gcsUri === "string"
    ? payload.gcsUri
    : null;

  return {
    hasInlineBytes: bytesBase64Encoded.length > 0,
    inlineBytesLength: bytesBase64Encoded.length,
    hasGcsUri: Boolean(gcsUri),
    gcsUri,
    mimeType: typeof payload.mimeType === "string" ? payload.mimeType : null,
    keys: Object.keys(payload),
    payloadImageMode: gcsUri ? "gcsUri" : bytesBase64Encoded.length > 0 ? "inline_bytes" : "missing",
  };
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

    const payload = {
      instances: [
        {
          prompt,
          image: sourcePayload,
          mask: {
            image: maskPayload,
          },
        },
      ],
      parameters: {
        sampleCount: 1,
        guidanceScale,
        addWatermark: false,
        editMode: "EDIT_MODE_INPAINT_INSERTION",
        maskMode: "MASK_MODE_USER_PROVIDED",
        outputOptions: {
          mimeType: "image/png",
        },
      },
    };

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
        body: JSON.stringify(payload),
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
      nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
        phase: "failure",
        continuityGroupId: request.continuityGroupId || null,
        imageId: request.imageId,
        jobId: request.jobId,
        renderMode: request.renderMode,
        model,
        outputPath: request.outputPath,
        error: error?.message || String(error),
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
      });
      throw error;
    }
  }
}