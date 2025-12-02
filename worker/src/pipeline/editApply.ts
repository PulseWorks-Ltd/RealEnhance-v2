

import sharp from "sharp";
import { regionEditWithGemini } from "../ai/gemini";
import { buildRegionEditPrompt } from "./prompts";
import { toBase64, siblingOutPath, writeImageDataUrl } from "../utils/images";

export type EditMode = "Add" | "Remove" | "Replace" | "Restore";

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
      hasRestoreFrom: !!restoreFromPath,
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

    const dir = require("path").dirname(baseImagePath);
    const baseName = require("path").basename(baseImagePath, require("path").extname(baseImagePath));
    const outPath = require("path").join(dir, `${baseName}-region-edit.webp`);

    // 🔹 Handle "Restore" mode with pixel-level copying (NEVER use Gemini)
    if (mode === "Restore") {
      console.log("[editApply] Restore mode check:", { mode, hasRestorePath: !!restoreFromPath, hasMask: !!maskPngBuffer });

      // Validate required inputs for Restore mode
      if (!restoreFromPath) {
        const errMsg = "Restore mode requires restoreFromPath but none was provided";
        console.error("[editApply]", errMsg);
        throw new Error(errMsg);
      }

      if (!maskPngBuffer) {
        const errMsg = "Restore mode requires a mask but none was provided";
        console.error("[editApply]", errMsg);
        throw new Error(errMsg);
      }

      console.log("[editApply] Restore mode: copying pixels from", restoreFromPath);

      try {
        // Load the restore source image
        const restoreImage = sharp(restoreFromPath);
        const restoreMeta = await restoreImage.metadata();

        // Ensure restore image matches base dimensions
        let restoreBuffer: Buffer;
        if (restoreMeta.width !== meta.width || restoreMeta.height !== meta.height) {
          console.log("[editApply] Resizing restore image to match base");
          restoreBuffer = await restoreImage
            .resize(meta.width!, meta.height!, { fit: "fill" })
            .toBuffer();
        } else {
          restoreBuffer = await restoreImage.toBuffer();
        }

        // Create inverted mask (for keeping non-masked areas from base)
        const invertedMask = await sharp(maskPngBuffer)
          .negate()
          .toBuffer();

        // Composite: base with inverted mask + restore with original mask
        const baseImageBuffer = await sharp(baseImagePath).toBuffer();

        // Step 1: Apply inverted mask to base (keep non-masked areas)
        const maskedBase = await sharp(baseImageBuffer)
          .composite([
            {
              input: invertedMask,
              blend: "dest-in",
            },
          ])
          .toBuffer();

        // Step 2: Apply mask to restore source (get masked areas)
        const maskedRestore = await sharp(restoreBuffer)
          .composite([
            {
              input: maskPngBuffer,
              blend: "dest-in",
            },
          ])
          .toBuffer();

        // Step 3: Combine both (overlay masked restore on top of masked base)
        await sharp(maskedBase)
          .composite([
            {
              input: maskedRestore,
              blend: "over",
            },
          ])
          .webp()
          .toFile(outPath);

        console.log("[editApply] Restore complete (pixel-level), saved to", outPath);
        return outPath;
      } catch (err) {
        // NEVER fall back to Gemini for Restore mode - throw error to notify user
        const errMsg = `Restore operation failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error("[editApply]", errMsg);
        throw new Error(errMsg);
      }
    }

    // 🔹 For Add/Remove/Replace modes (or if Restore failed), use Gemini
    console.log("[editApply] Using Gemini for mode:", mode);

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

    await sharp(editedBuffer).toFile(outPath);
    console.log("[editApply] Saved edited image to", outPath);
    return outPath;
  }
