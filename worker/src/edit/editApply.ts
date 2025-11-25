// server/worker/src/editApply.ts (or similar)

import sharp from "sharp";
import fs from "fs/promises";
import path from "path";

export async function applyEdit(
  baseImagePath: string,
  maskPath: string
): Promise<string> {
  // -------- 1) Validate base image --------
  const baseExists = await fs
    .access(baseImagePath)
    .then(() => true)
    .catch(() => false);

  if (!baseExists) {
    console.error("[applyEdit] Base image missing:", baseImagePath);
    throw new Error("Base image not found for edit");
  }

  // Load base buffer
  let baseBuf: Buffer;
  try {
    baseBuf = await fs.readFile(baseImagePath);
  } catch (err) {
    console.error("[applyEdit] Failed reading base image:", err);
    throw new Error("Failed to read base image");
  }

  // -------- 2) Validate mask --------
  let maskBuf: Buffer | null = null;
  let maskValid = true;

  try {
    maskBuf = await fs.readFile(maskPath);
  } catch {
    maskValid = false;
  }

  if (!maskValid || !maskBuf || maskBuf.length < 32) {
    console.warn("[applyEdit] Mask missing or too small, returning base image.");
    return baseImagePath;
  }

  // Check if mask is actually an image
  let maskMeta;
  try {
    maskMeta = await sharp(maskBuf).metadata();
  } catch (err) {
    console.warn("[applyEdit] Mask is not a readable image:", err);
    return baseImagePath;
  }

  // -------- 3) Detect uniform mask (all black or all white) --------
  try {
    const stats = await sharp(maskBuf).stats();
    const ch = stats.channels[0];

    if (ch.min === ch.max) {
      console.warn("[applyEdit] Mask is uniform (black or white), skipping edit.");
      return baseImagePath;
    }
  } catch (err) {
    console.warn("[applyEdit] Mask stats failed, treating as invalid:", err);
    return baseImagePath;
  }

  // -------- 4) Compute output path --------
  const dir = path.dirname(baseImagePath);
  const baseName = path.basename(baseImagePath, path.extname(baseImagePath));
  const outputPath = path.join(dir, `${baseName}-edited.webp`);

  // -------- 5) Composite safely --------
  try {
    await sharp(baseBuf)
      .composite([
        {
          input: maskBuf,
          blend: "dest-in",
        },
      ])
      .toFormat("webp")
      .toFile(outputPath);
  } catch (err) {
    console.error("[applyEdit] Sharp compositing failed:", err);
    return baseImagePath; // fallback to base image instead of breaking
  }

  // -------- 6) Validate output image --------
  try {
    const test = await sharp(outputPath).metadata();
    if (!test.width || !test.height) {
      throw new Error("invalid output metadata");
    }
  } catch (err) {
    console.error("[applyEdit] Output validation failed:", err);
    return baseImagePath;
  }

  return outputPath;
}
