import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';

export async function applyEdit(baseImagePath: string, maskPath: string): Promise<string | null> {
  // 1. Load base image exactly as before
  const baseExists = await fs
    .access(baseImagePath)
    .then(() => true)
    .catch(() => false);

  if (!baseExists) {
    console.error('[applyEdit] Base image missing:', baseImagePath);
    throw new Error('Base image not found for edit');
  }

  // 2. Load mask safely
  let mask;
  try {
    mask = sharp(maskPath);
  } catch (err) {
    console.error('[applyEdit] Failed to load mask file:', err);
    throw new Error('Mask could not be read — aborting edit');
  }

  const maskBuf = await mask.toBuffer().catch((err) => {
    console.error('[applyEdit] Error converting mask to buffer:', err);
    return null;
  });

  if (!maskBuf || maskBuf.length === 0) {
    console.warn('[applyEdit] Mask buffer empty — nothing to edit');
    return null; // IMPORTANT: no fallback to baseImagePath
  }

  const stats = await mask.stats();
  const uniform =
    stats.channels[0].min === stats.channels[0].max &&
    stats.channels[1].min === stats.channels[1].max &&
    stats.channels[2].min === stats.channels[2].max;

  if (uniform) {
    console.warn('[applyEdit] Mask is uniform; cancelling edit');
    return null;
  }

  // 3. Do whatever your existing edit logic is here
  // (blend, inpaint, etc – KEEP your current logic, just feed it baseImagePath + mask)

  const outputPath = path.join(
    path.dirname(baseImagePath),
    path.basename(baseImagePath, path.extname(baseImagePath)) + '-edited.webp'
  );

  // Example: very simple compositing placeholder.
  // Replace this body with your existing editing implementation.
  await sharp(baseImagePath)
    .composite([{ input: maskPath, blend: 'dest-in' }])
    .toFile(outputPath);

  return outputPath;
}
