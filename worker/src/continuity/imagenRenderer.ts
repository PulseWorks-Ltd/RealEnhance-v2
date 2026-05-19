import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import sharp from "sharp";
import { nLog } from "../logger";
import { toBase64 } from "../utils/images";
import type { ImagenRenderInput, ImagenRenderResult, PlacementPlan } from "./types";
import { VertexSecondaryContinuityError } from "./types";

let vertexImagenClient: GoogleGenAI | null = null;

function getVertexImagenClient(): GoogleGenAI {
  if (vertexImagenClient) {
    return vertexImagenClient;
  }
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
  if (!project) {
    throw new VertexSecondaryContinuityError(
      "GOOGLE_CLOUD_PROJECT is required for Vertex secondary continuity rendering",
      "missing_vertex_project"
    );
  }
  vertexImagenClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
  return vertexImagenClient;
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
  const promptParts = [
    furniture.join(", "),
    materials.length > 0 ? `${materials.join(", ")} textures` : "realistic material textures",
    params.stagingStyle ? `${params.stagingStyle} staging finish` : "listing-ready styling",
    "consistent scale",
    "realistic shadow grounding",
    params.lightingHint,
    "high-quality staging photography",
  ].filter(Boolean);
  return promptParts.join(", ");
}

function resolveModelResource(model: string): string {
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

function extractGeneratedImage(response: any): { imageBytes: string; mimeType: string } {
  const prediction = response?.predictions?.[0] || response?.generatedImages?.[0] || null;
  const imageBytes = prediction?.bytesBase64Encoded
    || prediction?.image?.bytesBase64Encoded
    || prediction?.image?.imageBytes;
  const mimeType = prediction?.mimeType
    || prediction?.image?.mimeType
    || "image/png";
  if (!imageBytes || typeof imageBytes !== "string") {
    throw new VertexSecondaryContinuityError(
      "Imagen response did not include image bytes",
      "imagen_missing_image"
    );
  }
  return { imageBytes, mimeType };
}

export async function renderSecondaryContinuityWithImagen(params: ImagenRenderInput): Promise<ImagenRenderResult> {
  const rendererFlag = String(process.env.SECONDARY_CONTINUITY_RENDERER || "imagen3").trim().toLowerCase();
  const model = rendererFlag === "imagen3" ? "imagen-3.0-capability-001" : rendererFlag;
  const guidanceScale = Number(process.env.VERTEX_CONTINUITY_GUIDANCE_SCALE || 12);
  const ai = getVertexImagenClient();
  const secondary = toBase64(params.secondaryImagePath);
  const mask = toBase64(params.maskPath);
  const startedAt = Date.now();
  const payload = {
    instances: [
      {
        prompt: params.prompt,
        image: {
          bytesBase64Encoded: secondary.data,
          mimeType: secondary.mime,
        },
        mask: {
          image: {
            bytesBase64Encoded: mask.data,
            mimeType: mask.mime,
          },
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

  nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
    phase: "start",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    model,
    prompt: params.prompt,
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
  await sharp(imageBuffer).webp({ quality: 95 }).toFile(params.outputPath);
  await fs.access(params.outputPath);
  const latencyMs = Date.now() - startedAt;

  nLog("[VERTEX_CONTINUITY_IMAGEN_RENDER]", {
    phase: "complete",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    model,
    latencyMs,
    outputPath: params.outputPath,
    mimeType: generated.mimeType,
  });

  return {
    outputPath: params.outputPath,
    model,
    latencyMs,
    mimeType: generated.mimeType,
    guidanceScale,
    payload,
  };
}