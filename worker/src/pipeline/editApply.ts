

import sharp from "sharp";
import { getGeminiClient } from "../ai/gemini";
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
    instruction: instruction.substring(0, 50),
    hasMask: !!mask,
    maskSize: mask?.length
  });

  try {
    // Step 1: Load base image and get dimensions
    const baseImage = sharp(baseImagePath);
    const baseMetadata = await baseImage.metadata();
    const { width, height } = baseMetadata;

    if (!width || !height) {
      throw new Error("Could not read base image dimensions");
    }

    console.log("[editApply] Base image dimensions:", { width, height });

    // Step 2: Resize mask to match base image dimensions
    const resizedMask = await sharp(mask)
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer();

    console.log("[editApply] Mask resized to match image");

    // Step 3: Build the prompt
    const prompt = buildRegionEditPrompt({
      userInstruction: instruction,
      sceneType: "interior",
      preserveStructure: true,
    });

    console.log("[editApply] Prompt built, length:", prompt.length);

    // Step 4: Convert to base64
    const baseBase64 = toBase64(baseImagePath).data;
    const maskBase64 = resizedMask.toString("base64");

    console.log("[editApply] Images converted to base64");

    // Step 5: Call Gemini
    const gemini = getGeminiClient();
    console.log("[editApply] Calling Gemini API for region edit...");
    const response = await gemini.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/webp",
              data: baseBase64,
            },
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: maskBase64,
            },
          },
        ],
      }],
      // generationConfig removed: not supported by GenerateContentParameters type
    });

    console.log("[editApply] Gemini responded");

    // Step 6: Extract image from response
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) {
      console.error("[editApply] No candidates in Gemini response");
      throw new Error("No candidates in Gemini response");
    }

    const parts = candidates[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      console.error("[editApply] No parts in first candidate");
      throw new Error("No parts in Gemini response");
    }

    console.log("[editApply] Response has", parts.length, "parts");
    console.log("[editApply] Part types:", parts.map((p: any) => {
      if (p.text) return 'text';
      if (p.inlineData) return 'inlineData';
      return 'unknown';
    }));

    // Find the image part
    const imagePart = parts.find((p: any) => p.inlineData);

    if (!imagePart?.inlineData?.data) {
      // Log what we got instead
      const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
      if (textParts.length > 0) {
        console.error("[editApply] Gemini returned text instead of image:");
        console.error(textParts.join('\n').substring(0, 500));
      }
      throw new Error("No image data in Gemini response - it may have returned text instead");
    }

    console.log("[editApply] Found image in response");

    // Step 7: Save the edited image
    const editedImageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
    const outputPath = baseImagePath.replace(/\.(jpg|jpeg|png|webp)$/i, "-edited.webp");

    await sharp(editedImageBuffer)
      .webp({ quality: 90 })
      .toFile(outputPath);

    console.log("[editApply] ✅ Edit saved:", outputPath);
    return outputPath;
  } catch (error: any) {
    console.error("[editApply] ❌ Error:", error.message);
    console.error("[editApply] Stack:", error.stack);
    throw error;
  }
}
