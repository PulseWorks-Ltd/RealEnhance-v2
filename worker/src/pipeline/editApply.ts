

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
  console.log("[editApply] Starting edit", { baseImagePath, mode, instruction });

  // Step 1: Load base image and get its dimensions
  const baseImage = sharp(baseImagePath);
  const baseMetadata = await baseImage.metadata();
  const { width, height } = baseMetadata;
  if (!width || !height) {
    throw new Error("Could not read base image dimensions");
  }

  // Step 2: Resize mask to match base image dimensions
  const resizedMask = await sharp(mask)
    .resize(width, height, { fit: 'fill' })
    .toBuffer();

  // Step 3: Build the prompt for Gemini
  const prompt = buildRegionEditPrompt({
    userInstruction: instruction,
    sceneType: "interior", // Optionally pass from job payload
    preserveStructure: true,
  });

  // Step 4: Convert images to base64 for Gemini
  const baseBase64 = toBase64(baseImagePath).data;
  const maskBase64 = resizedMask.toString("base64");

  // Step 5: Call Gemini API with the prompt
  const gemini = getGeminiClient();
  const response = await gemini.models.generateContent({
    model: "gemini-2.0-flash-exp",
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
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
      },
    ],
  });

  // Step 6: Extract the edited image from Gemini response
  const resultPart = response.candidates?.[0]?.content?.parts?.find(
    (p: any) => p.inlineData
  );

  if (!resultPart?.inlineData?.data) {
    throw new Error("No image data in Gemini response");
  }

  // Step 7: Save the edited image
  const editedImageBuffer = Buffer.from(resultPart.inlineData.data, "base64");
  const outputPath = baseImagePath.replace(/\.(jpg|jpeg|png|webp)$/i, "-edited.webp");
  await sharp(editedImageBuffer)
    .webp({ quality: 90 })
    .toFile(outputPath);

  console.log("[editApply] Edit output saved:", outputPath);
  return outputPath;
}
