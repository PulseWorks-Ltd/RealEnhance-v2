

import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { buildRegionEditPrompt } from "./prompts";
import { toBase64, siblingOutPath, writeImageDataUrl } from "../utils/images";

export type EditMode = "Add" | "Remove" | "Restore";

export interface ApplyEditArgs {
  baseImagePath: string;      // path to the enhanced image we’re editing
  mask: Buffer;               // binary mask (white = edit, black = keep)
  mode: EditMode;             // "Add" | "Remove" | "Restore"
  instruction: string;        // user’s natural-language instruction
  restoreFromPath?: string;   // optional path to original/enhanced image for restore mode
}

/**
 * Run a region edit with Gemini, using a mask and user instruction.
 * Returns the path to the edited image on disk.
 */
export async function applyEdit({
  baseImagePath,
  mask,
  mode,
  instruction,
  restoreFromPath,
}: ApplyEditArgs): Promise<string> {
  console.log("[editApply] Starting edit", {
    baseImagePath,
    mode,
    instruction,
    hasMask: !!mask,
    maskSize: mask?.length ?? 0,
  });

  // Step 1: Load base image and get dimensions
  const baseImage = sharp(baseImagePath);
  const meta = await baseImage.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Could not read base image dimensions");
  }
  console.log("[editApply] Base image dimensions:", { width: meta.width, height: meta.height });

  // Step 2: Resize mask to match image and encode as PNG for Gemini
  let maskPngBuffer: Buffer | undefined;
  if (mask) {
    maskPngBuffer = await sharp(mask)
      .resize(meta.width, meta.height, { fit: "fill" })
      .png()
      .toBuffer();
    console.log("[editApply] Mask resized to match image");
  }


  // Step 3: Read base image buffer (send as webp)
  const baseImageBuffer = await sharp(baseImagePath).webp().toBuffer();
  const base64Base = baseImageBuffer.toString("base64");
  const base64Mask = maskPngBuffer?.toString("base64");
  console.log("[editApply] Images converted to base64");

  // Step 4: Build the prompt
  const prompt = buildRegionEditPrompt({
    userInstruction: instruction,
    sceneType: "interior",
    preserveStructure: true,
  });
  console.log("[editApply] Prompt built, length:", prompt.length);

  // Step 5: Build Gemini request (use correct field names for SDK)
  const parts: any[] = [
    { text: prompt },
    {
      inlineData: {
        mimeType: "image/webp",
        data: base64Base,
      },
    },
  ];
  if (base64Mask) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: base64Mask,
      },
    });
  }
  const request = {
    contents: [
      {
        role: "user",
        parts,
      },
    ],
  };

  // Step 6: Call Gemini and extract image
  const editedBuffer = await runRegionEditWithGemini(request, {
    hasBaseImageUrl: true,
    hasMask: !!mask,
  });

  // Step 7: Save to temp output path
  const dir = require("path").dirname(baseImagePath);
  const baseName = require("path").basename(baseImagePath, require("path").extname(baseImagePath));
  const outPath = require("path").join(dir, `${baseName}-region-edit.webp`);
  await sharp(editedBuffer).toFile(outPath);
  console.log("[editApply] Saved edited image to", outPath);
  return outPath;
}

// --- Gemini region edit helper ---
const REGION_MODEL_ID = process.env.GEMINI_REGION_MODEL || "gemini-1.5-flash";
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function runRegionEditWithGemini(request: any, ctx: { hasBaseImageUrl: boolean; hasMask: boolean }) {
  console.log("[editApply] Calling Gemini API for region edit...");
  const result = await genAI.models.generateContent({
    ...request,
    model: REGION_MODEL_ID,
  });
  // Safely unwrap .response if it exists (per SDK pattern)
  const rawResponse: any = (result as any).response ?? result;
  // Log as much as possible when things go wrong
  const debugBase = {
    modelVersion: rawResponse.modelVersion,
    hasBaseImageUrl: ctx.hasBaseImageUrl,
    hasMask: ctx.hasMask,
    usageMetadata: rawResponse.usageMetadata,
    promptFeedback: rawResponse.promptFeedback,
  };
  const candidates = rawResponse.candidates ?? [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    console.error(
      "[editApply] Gemini response has no candidates",
      JSON.stringify(debugBase, null, 2)
    );
    throw new Error("No candidates in Gemini response");
  }
  console.log(
    "[editApply] Candidate finishReasons:",
    candidates.map((c: any) => c.finishReason)
  );
  const usable =
    candidates.find(
      (c: any) =>
        !c.finishReason || c.finishReason === "STOP" || c.finishReason === "FINISH_REASON_UNSPECIFIED"
    ) ?? candidates[0];
  if (!usable?.content?.parts?.length) {
    console.error(
      "[editApply] No content parts in chosen candidate",
      JSON.stringify(usable, null, 2)
    );
    throw new Error("No image content in Gemini response");
  }
  // Use correct field for inlineData
  const imagePart = usable.content.parts.find(
    (p: any) => p.inlineData && p.inlineData.data
  );
  if (!imagePart) {
    console.error(
      "[editApply] No inlineData image part in candidate",
      JSON.stringify(usable.content.parts, null, 2)
    );
    throw new Error("No image data in Gemini response");
  }
  const base64Image = imagePart.inlineData.data as string;
  return Buffer.from(base64Image, "base64");
}
