

import sharp from "sharp";
import { regionEditWithGemini } from "../ai/gemini";
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

    const baseImage = sharp(baseImagePath);
    const meta = await baseImage.metadata();
    console.log("[editApply] Base image dimensions:", {
      width: meta.width,
      height: meta.height,
    });

    // Resize mask to match and encode as PNG
    let maskPngBuffer: Buffer | undefined;
    if (mask) {
      maskPngBuffer = await sharp(mask)
        .resize(meta.width!, meta.height!, { fit: "fill" })
        .png()
        .toBuffer();
      console.log("[editApply] Mask resized to match image");
    }

    // Normalize base image to the same format you use in 1A/1B
    const baseImageBuffer = await sharp(baseImagePath).webp().toBuffer();
    console.log("[editApply] Images converted to base64 (implicit)");

    const prompt = buildRegionEditPrompt({
      userInstruction: instruction,
      // Optionally pass roomType, sceneType, preserveStructure if needed
    });
    console.log("[editApply] Prompt built, length:", prompt.length);

    // 🚀 Call shared Gemini helper
    const editedBuffer = await regionEditWithGemini({
      prompt,
      baseImageBuffer,
      maskPngBuffer,
      // Optionally pass roomType, sceneType, preserveStructure if needed
    });

    // Save temp file
    const dir = require("path").dirname(baseImagePath);
    const baseName = require("path").basename(baseImagePath, require("path").extname(baseImagePath));
    const outPath = require("path").join(dir, `${baseName}-region-edit.webp`);
    await sharp(editedBuffer).toFile(outPath);
    console.log("[editApply] Saved edited image to", outPath);
    return outPath;
  }
