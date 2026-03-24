

import sharp from "sharp";
import { regionEditWithGemini } from "../ai/gemini";
import { buildRegionEditPrompt } from "./prompts";
import { toBase64, siblingOutPath, writeImageDataUrl } from "../utils/images";

const MIN_PROJECTION_DILATE_PX = 2;
const MAX_PROJECTION_DILATE_PX = 4;

function normalizeSharpResizePosition(position: unknown): any {
  const original = position;
  if (position && typeof position === "object" && !Array.isArray(position)) {
    return position;
  }

  if (typeof position === "string") {
    const canonical = position.trim().toLowerCase().replace(/[_-]+/g, " ");
    if (canonical === "top left") {
      const normalized = "left top";
      console.log("[EDIT_POSITION_NORMALIZED]", { original, normalized });
      return normalized;
    }
    return position;
  }

  const fallback = "left top";
  console.log("[EDIT_POSITION_NORMALIZED]", { original, normalized: fallback });
  return fallback;
}

function allowedMaskArtifactPathForOutput(outPath: string): string {
  return `${outPath}.allowed-mask.png`;
}

function projectionDilatePx(width: number, height: number): number {
  const scaled = Math.round(Math.max(width, height) * 0.0025);
  return Math.max(MIN_PROJECTION_DILATE_PX, Math.min(MAX_PROJECTION_DILATE_PX, scaled || 5));
}

async function normalizeMaskToImageSpace(mask: Buffer, width: number, height: number): Promise<Buffer> {
  const maskImage = sharp(mask, { failOn: "error" });
  const maskMeta = await maskImage.metadata();
  const needsResize = maskMeta.width !== width || maskMeta.height !== height;

  let pipeline = sharp(mask, { failOn: "error" })
    .removeAlpha()
    .grayscale();

  if (needsResize) {
    pipeline = pipeline.resize(width, height, {
      fit: "contain",
      position: normalizeSharpResizePosition("top-left"),
      background: { r: 0, g: 0, b: 0, alpha: 1 },
      kernel: sharp.kernel.nearest,
    });
    console.log("[editApply] Mask normalized with contain/left top (no geometric distortion)");
  } else {
    console.log("[editApply] Mask dimensions already match base image");
  }

  return await pipeline
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();
}

async function buildMaskRegions(maskPngBuffer: Buffer, width: number, height: number): Promise<{
  innerMask: Buffer;
  projectionMask: Buffer;
  dilatedMask: Buffer;
  outsideMask: Buffer;
}> {
  const innerMask = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const dilatePx = projectionDilatePx(width, height);
  const dilatedMask = await sharp(innerMask)
    .dilate(dilatePx)
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const innerRaw = await sharp(innerMask)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const dilatedRaw = await sharp(dilatedMask)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const projectionRaw = Buffer.alloc(innerRaw.data.length, 0);
  const outsideRaw = Buffer.alloc(innerRaw.data.length, 0);

  for (let i = 0; i < innerRaw.data.length; i += 1) {
    const inner = (innerRaw.data[i] ?? 0) > 127;
    const dilated = (dilatedRaw.data[i] ?? 0) > 127;
    projectionRaw[i] = dilated && !inner ? 255 : 0;
    outsideRaw[i] = dilated ? 0 : 255;
  }

  const projectionMask = await sharp(projectionRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();

  const outsideMask = await sharp(outsideRaw, {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();

  return {
    innerMask,
    projectionMask,
    dilatedMask,
    outsideMask,
  };
}

async function computeOutsideAllowedChangedPct(
  baseImagePath: string,
  editedImagePath: string,
  allowedMask: Buffer
): Promise<number | null> {
  try {
    const baseRaw = await sharp(baseImagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const editedRaw = await sharp(editedImagePath)
      .resize(baseRaw.info.width, baseRaw.info.height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const allowedRaw = await sharp(allowedMask)
      .removeAlpha()
      .grayscale()
      .resize(baseRaw.info.width, baseRaw.info.height, {
        fit: "contain",
        position: normalizeSharpResizePosition("top-left"),
        background: { r: 0, g: 0, b: 0, alpha: 1 },
        kernel: sharp.kernel.nearest,
      })
      .threshold(127, { grayscale: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = baseRaw.info.width * baseRaw.info.height;
    if (pixels === 0) return null;

    let outsideCount = 0;
    let outsideChanged = 0;
    const changeThreshold = 14;
    for (let i = 0; i < pixels; i += 1) {
      const allowed = allowedRaw.data[i] ?? 0;
      if (allowed > 127) continue;
      outsideCount += 1;

      const idx = i * 3;
      const dr = Math.abs((baseRaw.data[idx] ?? 0) - (editedRaw.data[idx] ?? 0));
      const dg = Math.abs((baseRaw.data[idx + 1] ?? 0) - (editedRaw.data[idx + 1] ?? 0));
      const db = Math.abs((baseRaw.data[idx + 2] ?? 0) - (editedRaw.data[idx + 2] ?? 0));
      if (dr + dg + db >= changeThreshold) {
        outsideChanged += 1;
      }
    }

    if (outsideCount === 0) return 0;
    return Number(((outsideChanged / outsideCount) * 100).toFixed(4));
  } catch {
    return null;
  }
}

async function compositeStrictMask(
  originalImagePath: string,
  generatedBuffer: Buffer,
  maskPngBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const alignedGenerated = await sharp(generatedBuffer)
    .resize(width, height, { fit: "fill" })
    .png()
    .toBuffer();

  const normalizedMask = await sharp(maskPngBuffer)
    .removeAlpha()
    .grayscale()
    .threshold(127, { grayscale: true })
    .png()
    .toBuffer();

  const invertedMask = await sharp(normalizedMask)
    .negate()
    .png()
    .toBuffer();

  const originalMasked = await sharp(originalImagePath)
    .resize(width, height, { fit: "fill" })
    .png()
    .composite([{ input: invertedMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const generatedMasked = await sharp(alignedGenerated)
    .composite([{ input: normalizedMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(originalMasked)
    .composite([{ input: generatedMasked, blend: "over" }])
    .webp()
    .toBuffer();
}

function classifyOutsideLeakPct(pct: number | null): "none" | "soft_anomaly" | "real_leak" | "unknown" {
  if (!Number.isFinite(pct as number)) return "unknown";
  const value = Number(pct);
  if (value <= 0.2) return "none";
  if (value <= 1) return "soft_anomaly";
  return "real_leak";
}

export type EditMode = "Add" | "Remove" | "Replace" | "Restore";

export interface ApplyEditArgs {
  baseImagePath: string;      // path to the enhanced image we’re editing
  mask: Buffer;               // binary mask (white = edit, black = keep)
  mode: EditMode;             // "Add" | "Remove" | "Restore"
  instruction: string;        // user’s natural-language instruction
  restoreFromPath?: string;   // optional path to original/enhanced image for restore mode
  stage1AReferencePath?: string; // optional Stage-1A enhanced reference image (remove mode)
  onAnchorValidation?: (result: { passed: boolean; overlapPct: number }) => void;
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
  stage1AReferencePath,
  onAnchorValidation,
}: ApplyEditArgs): Promise<string> {
    console.log("[editApply] Starting edit", {
      baseImagePath,
      mode,
      instruction,
      hasMask: !!mask,
      maskSize: mask?.length ?? 0,
      hasRestoreFrom: !!restoreFromPath,
      hasStage1AReference: !!stage1AReferencePath,
    });

    const baseImage = sharp(baseImagePath);
    const meta = await baseImage.metadata();
    console.log("[editApply] Base image dimensions:", {
      width: meta.width,
      height: meta.height,
    });

    if (!meta.width || !meta.height) {
      throw new Error("Base image is missing width/height metadata for mask alignment");
    }

    // Normalize mask to image coordinates and encode as PNG
    let maskPngBuffer: Buffer | undefined;
    if (mask) {
      maskPngBuffer = await normalizeMaskToImageSpace(mask, meta.width, meta.height);
      console.log("[editApply] Mask normalized to image coordinate space");
      // Save debug PNG
      const debugMaskPath = require("path").join(require("path").dirname(baseImagePath), "debug-mask.png");
      await sharp(maskPngBuffer).toFile(debugMaskPath);
      // Log mask stats
      const maskStats = await sharp(maskPngBuffer).stats();
      console.log("[editApply] Mask stats:", {
        debugMaskPath,
        // Use meta.width and meta.height for dimensions if needed
        channels: maskStats.channels,
        min: maskStats.channels.map((c:any)=>c.min),
        max: maskStats.channels.map((c:any)=>c.max),
        sum: maskStats.channels.map((c:any)=>c.sum),
      });
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
    const finalPrompt = prompt;
    console.log("[editApply] Prompt built, length:", finalPrompt.length);

    // 🚀 Call shared Gemini helper
    const editedBuffer = await regionEditWithGemini({
      prompt: finalPrompt,
      baseImageBuffer,
      maskPngBuffer,
      // Optionally pass roomType, sceneType, preserveStructure if needed
    });

    // Strict edit compositing only: original * (1 - mask) + generated * mask
    const effectiveAllowedMask = await sharp(maskPngBuffer!)
      .removeAlpha()
      .grayscale()
      .threshold(127, { grayscale: true })
      .png()
      .toBuffer();
    const allowedMaskArtifactPath = allowedMaskArtifactPathForOutput(outPath);
    await sharp(effectiveAllowedMask).png().toFile(allowedMaskArtifactPath);
    const strictComposite = await compositeStrictMask(
      baseImagePath,
      editedBuffer,
      maskPngBuffer!,
      meta.width,
      meta.height,
    );
    await sharp(strictComposite).webp().toFile(outPath);

    const maskStats = await sharp(effectiveAllowedMask).stats();
    console.log("[editApply] Enforced mask zones", {
      enforcementMode: "strict_inner_only",
      innerMaskPixels: maskStats.channels[0]?.sum ?? 0,
      allowedMaskArtifactPath,
    });

    // Strict manual edit mode intentionally bypasses anchor validation.

    console.log("[editApply] Saved enforced region edit image to", outPath);
    return outPath;
  }
