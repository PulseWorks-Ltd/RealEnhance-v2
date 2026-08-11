import fs from "fs/promises";
import sharp from "sharp";
import { getGeminiClient } from "../../ai/gemini";
import { runWithSelectedImageModel } from "../../ai/runWithImageModelFallback";
import { toBase64 } from "../../utils/images";
import { compileMask } from "./maskCompile";
import { GeminiMaskGenerationError } from "./types";

// Single-image furniture-placement mask generation
// (VERTEX_INPAINTING_INVESTIGATION.md §5/§6). This is deliberately NOT a call
// into feature/vertex-secondary-inpainting-continuity's
// generateGeminiOccupancyMask — that function requires two images (an
// already-staged master + a secondary target angle) and projects furniture
// from one onto the other. This has one image and no projection: it asks
// Gemini to directly propose where furniture may go in a single empty-room
// photo, with semantic protection of doors/windows/cabinetry/etc. baked into
// the same prompt (rather than a downstream edge-detection heuristic).

const MASK_GENERATION_MODEL = String(
  process.env.VERTEX_INPAINT_MASK_MODEL || "gemini-2.5-flash-image"
).trim();

function buildFurniturePlacementMaskPrompt(roomType: string): string {
  return [
    "You are given a single real-estate room photograph.",
    "Task: identify the regions of open floor / usable room space where new furniture could reasonably be placed for staging.",
    `Room type: ${roomType || "unspecified"}.`,
    "",
    "Output a binary grayscale mask IMAGE, same dimensions as the input photograph.",
    "WHITE = editable — open floor/usable space where furniture may be generated.",
    "BLACK = protected — must remain completely unchanged, including:",
    "- walls, ceilings, and any floor area that should remain visible",
    "- doors and door frames",
    "- windows and window frames",
    "- built-in cabinetry, wardrobes, closets",
    "- fireplaces, kitchen cabinetry, bathroom fixtures",
    "- fixed shelving, tiled walls",
    "- architectural features and structural columns",
    "- any other permanent built-in feature",
    "",
    "This is NOT a general 'anything that looks empty' mask — it specifically marks",
    "where new furniture may be inserted, nothing else.",
    "This is NOT a furniture-removal mask — do not mark existing furniture for removal;",
    "existing clutter has already been handled in an earlier step.",
    "",
    "Rules:",
    "- Output IMAGE ONLY. No text, no JSON, no explanation.",
    "- The mask must be strictly binary: only pure white (255) and pure black (0).",
    "- Do not paint grey or use anti-aliased/soft edges.",
    "- If uncertain whether an area is safe to mark editable, mark it BLACK (protect it).",
  ].join("\n");
}

function findFirstInlineImagePart(parts: any[]): { mimeType: string; data: string } | null {
  for (const part of parts || []) {
    const inlineData = part?.inlineData;
    if (!inlineData?.data) continue;
    const mimeType = String(inlineData.mimeType || "image/png").toLowerCase();
    if (!mimeType.startsWith("image/")) continue;
    return { mimeType, data: String(inlineData.data) };
  }
  return null;
}

export async function generateFurniturePlacementMask(params: {
  sourceImagePath: string;
  roomType: string;
  outputMaskPath: string;
  jobId: string;
  imageId: string;
}): Promise<{ maskPath: string; width: number; height: number }> {
  const sourceMetadata = await sharp(params.sourceImagePath).metadata();
  const width = sourceMetadata.width || 0;
  const height = sourceMetadata.height || 0;
  if (!width || !height) {
    throw new GeminiMaskGenerationError(
      `Unable to read source image dimensions: ${params.sourceImagePath}`,
      "mask_gen_source_dimensions_unreadable"
    );
  }

  const source = toBase64(params.sourceImagePath);
  const prompt = buildFurniturePlacementMaskPrompt(params.roomType);

  console.log("[STAGE2_VERTEX_INPAINT] mask_generation start", {
    jobId: params.jobId,
    imageId: params.imageId,
    roomType: params.roomType,
    model: MASK_GENERATION_MODEL,
    sourceDimensions: { width, height },
  });

  const ai = getGeminiClient();
  let run: { resp: any; modelUsed: string };
  try {
    run = await runWithSelectedImageModel({
      stageLabel: "2",
      ai,
      model: MASK_GENERATION_MODEL,
      baseRequest: {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: source.mime, data: source.data } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          candidateCount: 1,
        },
      } as any,
      context: "vertex_inpaint_furniture_placement_mask",
      meta: {
        jobId: params.jobId,
        imageId: params.imageId,
        stage: "2",
        reason: "vertex_inpaint_mask_generation",
        callType: "image_generation",
      },
    });
  } catch (err: any) {
    throw new GeminiMaskGenerationError(
      `Gemini mask generation call failed: ${err?.message || err}`,
      "mask_gen_gemini_call_failed"
    );
  }

  const parts: any[] = run.resp?.candidates?.[0]?.content?.parts || [];
  const imagePart = findFirstInlineImagePart(parts);
  if (!imagePart) {
    throw new GeminiMaskGenerationError(
      "Gemini mask generation returned no inline image part",
      "mask_gen_no_image_returned"
    );
  }

  const rawMaskBuffer = Buffer.from(imagePart.data, "base64");
  const compiled = await compileMask({ rawMaskPngBuffer: rawMaskBuffer, width, height });
  await fs.writeFile(params.outputMaskPath, compiled);

  console.log("[STAGE2_VERTEX_INPAINT] mask_generation complete", {
    jobId: params.jobId,
    imageId: params.imageId,
    modelUsed: run.modelUsed,
    maskPath: params.outputMaskPath,
    width,
    height,
  });

  return { maskPath: params.outputMaskPath, width, height };
}
