import fs from "fs/promises";
import sharp from "sharp";
import { nLog } from "../../logger";
import type { PlacementPlan } from "../../continuity/types";
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

export class VertexImageRendererProvider implements ImageRendererProvider {
  async render(request: ImageRenderRequest): Promise<ImageRenderResponse> {
    const rendererFlag = String(process.env.SECONDARY_CONTINUITY_RENDERER || "imagen3").trim().toLowerCase();
    const model = rendererFlag === "imagen3" ? "imagen-3.0-capability-001" : rendererFlag;
    const ai = getVertexGenAiClient();
    const startedAt = Date.now();
    const payload = {
      instances: [
        {
          prompt: request.prompt,
          image: toVertexImagePayload(request.sourceImage),
          mask: {
            image: toVertexImagePayload(request.maskImage),
          },
        },
      ],
      parameters: {
        sampleCount: 1,
        guidanceScale: 12,
        addWatermark: false,
        editMode: "EDIT_MODE_INPAINT_INSERTION",
        maskMode: "MASK_MODE_USER_PROVIDED",
        outputOptions: {
          mimeType: "image/png",
        },
      },
    };

    nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
      phase: "start",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      model,
      prompt: request.prompt,
      sourceTransport: request.sourceImage.kind,
      maskTransport: request.maskImage.kind,
    });

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
      model,
      latencyMs,
      outputPath: request.outputPath,
      mimeType: generated.mimeType,
    });

    return {
      outputPath: request.outputPath,
      model,
      latencyMs,
      mimeType: generated.mimeType,
      payload,
    };
  }
}