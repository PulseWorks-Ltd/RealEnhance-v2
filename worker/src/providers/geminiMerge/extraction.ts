import sharp from "sharp";
import { getGeminiClient } from "../../ai/gemini";
import { runWithSelectedImageModel } from "../../ai/runWithImageModelFallback";
import { toBase64 } from "../../utils/images";
import { ExtractionError } from "./types";

// Second Gemini call: given the original Stage 1A/1B image and the staged
// candidate Gemini produced, identify ONLY the newly-introduced staging layer
// (furniture/decor + its directly-associated shadows) as a grayscale alpha
// mask. This is deliberately a separate, narrower call from staging
// generation itself — see the implementation directive §5-§9.

const EXTRACTION_MODEL = String(
  process.env.STAGE2_GEMINI_MERGE_EXTRACTION_MODEL || "gemini-2.5-flash-image"
).trim();

function buildExtractionPrompt(): string {
  return [
    "You are given two photographs of the exact same room, taken from the exact same camera position.",
    "IMAGE_A is the ORIGINAL photograph.",
    "IMAGE_B is a STAGED version of the same room, with furniture and decor added.",
    "",
    "Task: output a grayscale ALPHA MASK, same dimensions as the input images, that identifies ONLY the",
    "newly introduced staging content in IMAGE_B compared to IMAGE_A.",
    "",
    "Output IMAGE ONLY. No text, no JSON, no explanation.",
    "",
    "Mask semantics:",
    "WHITE (255) = newly introduced furniture or decorative staging object (not present in IMAGE_A).",
    "GREY (intermediate values) = natural shadow, soft edge, or appropriate semi-transparency directly",
    "  associated with a newly introduced staging object (contact shadow, cast shadow, soft blend edge).",
    "BLACK (0) = everything else. This must be the default for any pixel you are not confident about.",
    "",
    "INCLUDE only newly introduced: sofas, couches, beds, chairs, dining tables, dining chairs, coffee",
    "tables, side tables, desks, stools, lamps, plants, rugs, cushions, throws, artwork, mirrors (only if",
    "newly introduced), decorative objects, staging accessories, and other clearly new furniture/decor.",
    "Also include contact shadows, cast shadows, and natural soft shadowing directly caused by those new",
    "objects, and reflections clearly caused by newly introduced staging objects.",
    "",
    "EXCLUDE completely (must be BLACK): walls, ceilings, floors, flooring texture, floorboards, tiles,",
    "carpet, existing rugs, windows, window frames, doors, door frames, doorways, cabinetry, kitchen",
    "cabinetry, countertops, islands, wardrobes, closets, built-ins, fireplaces, bathroom fixtures,",
    "plumbing fixtures, existing appliances, structural elements, columns, beams, stairs, railings,",
    "existing furniture that was already present in IMAGE_A, and existing decorative objects.",
    "",
    "Also EXCLUDE any global image change between IMAGE_A and IMAGE_B that is not a specific new staging",
    "object: exposure changes, white-balance changes, colour changes, saturation changes, contrast",
    "changes, sharpening, global lighting changes, global brightness changes, global shadow/highlight",
    "adjustments, or any other change to the room's appearance not directly caused by a newly introduced",
    "staging object. Those pixels must remain BLACK regardless of how different they look between the",
    "two images.",
    "",
    "Be conservative. If you cannot confidently determine that a region is a newly introduced staging",
    "object or its directly associated shadow, mark it BLACK. A missing small decorative object is",
    "acceptable. Including a changed window, doorway, wall, ceiling, floor, cabinet, or other architectural",
    "or existing element is not acceptable.",
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

export function getExtractionModel(): string {
  return EXTRACTION_MODEL;
}

export async function extractStagingLayerMask(params: {
  originalImagePath: string;
  stagedImagePath: string;
  jobId: string;
  imageId: string;
}): Promise<{ maskPngBuffer: Buffer; width: number; height: number; modelUsed: string }> {
  const originalMetadata = await sharp(params.originalImagePath).metadata();
  const width = originalMetadata.width || 0;
  const height = originalMetadata.height || 0;
  if (!width || !height) {
    throw new ExtractionError(
      `Unable to read original image dimensions: ${params.originalImagePath}`,
      "extraction_source_dimensions_unreadable"
    );
  }

  const imageA = toBase64(params.originalImagePath);
  const imageB = toBase64(params.stagedImagePath);
  const prompt = buildExtractionPrompt();

  console.log("[STAGE2_GEMINI_MERGE] extraction_start", {
    jobId: params.jobId,
    imageId: params.imageId,
    model: EXTRACTION_MODEL,
    dimensions: { width, height },
  });

  const ai = getGeminiClient();
  let run: { resp: any; modelUsed: string };
  try {
    run = await runWithSelectedImageModel({
      stageLabel: "2",
      ai,
      model: EXTRACTION_MODEL,
      baseRequest: {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { text: "IMAGE_A (original):" },
              { inlineData: { mimeType: imageA.mime, data: imageA.data } },
              { text: "IMAGE_B (staged):" },
              { inlineData: { mimeType: imageB.mime, data: imageB.data } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          candidateCount: 1,
        },
      } as any,
      context: "gemini_merge_staging_layer_extraction",
      meta: {
        jobId: params.jobId,
        imageId: params.imageId,
        stage: "2",
        reason: "gemini_merge_extraction",
        callType: "image_generation",
      },
    });
  } catch (err: any) {
    throw new ExtractionError(
      `Gemini extraction call failed: ${err?.message || err}`,
      "extraction_gemini_call_failed"
    );
  }

  const parts: any[] = run.resp?.candidates?.[0]?.content?.parts || [];
  const imagePart = findFirstInlineImagePart(parts);
  if (!imagePart) {
    throw new ExtractionError(
      "Gemini extraction call returned no inline image part",
      "extraction_no_image_returned"
    );
  }

  const rawBuffer = Buffer.from(imagePart.data, "base64");
  const maskPngBuffer = await sharp(rawBuffer)
    .removeAlpha()
    .grayscale()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  console.log("[STAGE2_GEMINI_MERGE] extraction_complete", {
    jobId: params.jobId,
    imageId: params.imageId,
    modelUsed: run.modelUsed,
    width,
    height,
  });

  return { maskPngBuffer, width, height, modelUsed: run.modelUsed };
}
