import sharp from "sharp";
import { siblingOutPath, writeImageDataUrl } from "../utils/images";
import { getGeminiClient } from "../ai/gemini";
import { runWithImageModelFallback } from "../ai/runWithImageModelFallback";

function isDataUrl(s: any): s is string {
  return typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(s);
}

export async function applyEdit(params: {
  baseImagePath: string;
  mask: unknown; // expected: data URL string (white=edit/restore region, black=preserve)
  mode: "edit" | "restore_original" | "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  restoreFromPath?: string;
  smartReinstate?: boolean;
  sensitivityPx?: number; // grow/feather radius in pixels
}): Promise<string> {
  let { baseImagePath, mask, mode, instruction, restoreFromPath, smartReinstate = true, sensitivityPx = 4 } = params;

  // Map new modes to legacy for backward compatibility
  if (mode === "edit") {
    // For 'edit', default to Gemini logic (Add/Remove/Replace)
    mode = "Add"; // Use Add as a placeholder; actual op is in instruction
  } else if (mode === "restore_original") {
    mode = "Restore";
  }

  // Debug: log input params
  console.log('[applyEdit] Params:', { baseImagePath, mode, instruction, restoreFromPath, smartReinstate, sensitivityPx });
  if (!mask) {
    console.warn('[applyEdit] No mask provided, returning original image.');
    return baseImagePath;
  }

  const meta = await sharp(baseImagePath).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return baseImagePath;

  const maskBuf = isDataUrl(mask)
    ? Buffer.from(String(mask).split(',')[1] || '', 'base64')
    : (Buffer.isBuffer(mask) ? mask : Buffer.alloc(0));

  if (!maskBuf || maskBuf.length === 0) {
    console.warn('[applyEdit] Mask buffer is empty, returning original image.');
    return baseImagePath;
  }

  // Normalize mask to match base size and generate solid alpha map (0 or 255)
  let workingMask: Buffer;
  try {
    workingMask = await sharp(maskBuf)
      .resize(W, H, { fit: 'fill' })
      .greyscale()
      .threshold(128)
      .toBuffer();
    // Debug: check mask stats
    const maskStats = await sharp(workingMask).stats();
    console.log(`[editApply] Mask stats: min=${maskStats.channels[0].min}, max=${maskStats.channels[0].max}, mean=${maskStats.channels[0].mean}`);
    // Check for uniform mask
    if (maskStats.channels[0].min === maskStats.channels[0].max) {
      console.warn('[applyEdit] Mask is uniform (all black or all white).');
      return baseImagePath;
    }
  } catch (err) {
    console.error('[applyEdit] Error normalizing mask:', err);
    return baseImagePath;
  }

    // Debug: log mask type and size
    console.log(`[editApply] Received mask, length=${maskBuf.length}, type=${typeof mask}`);
    if (maskBuf.length < 100) {
      console.warn(`[editApply] Mask buffer is suspiciously small (${maskBuf.length} bytes)`);
      // Return error image or original
      return baseImagePath;
    }
  const dilate = Math.max(0, Math.floor(sensitivityPx));
  if (dilate > 0) {
    try {
      workingMask = await sharp(workingMask)
        .blur(dilate)
        .toBuffer();
    } catch (err) {
      console.error('[applyEdit] Error during mask dilation/blur:', err);
      return baseImagePath;
    }
  }

  if (mode === "Restore") {
    // Smart Restore: take pixels from restoreFromPath (baseline) wherever mask=white
    const srcPath = restoreFromPath || baseImagePath;
    const overlay = await sharp(srcPath)
      .resize(W, H)
      .removeAlpha()
      .joinChannel(workingMask) // add mask as alpha channel
      .toBuffer();

    const outPath = siblingOutPath(baseImagePath, "-edit-restore", ".png");
    await sharp(baseImagePath)
      .composite([{ input: overlay }])
      .toFile(outPath);
    console.log('[applyEdit] Restore mode output:', outPath);
    return outPath;
  }

  // For Add/Remove/Replace: build guided input and call Gemini with explicit mask instruction
  // 1) Guided input – darken outside mask region
  let invertedMask: Buffer;
  try {
    invertedMask = await sharp(workingMask)
      .negate()
      .toColourspace('b-w')
      .toBuffer();
  } catch (err) {
    console.error('[applyEdit] Error inverting mask:', err);
    return baseImagePath;
  }

  // Create a black overlay with alpha = invertedMask to darken outside region
  const blackout = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.45 } } })
    .toBuffer();

  const blackoutWithAlpha = await sharp(blackout)
    .joinChannel(invertedMask) // use inverted mask as alpha to apply darkening where mask is black
    .toBuffer();

  const guidedBuf = await sharp(baseImagePath)
    .composite([{ input: blackoutWithAlpha }])
    .toFormat('png')
    .toBuffer();

  const guidedPath = siblingOutPath(baseImagePath, "-edit-guide", ".png");
  await sharp(guidedBuf).toFile(guidedPath);
  console.log('[applyEdit] Guided input saved:', guidedPath);

  // 2) Gemini inpaint-style call
  const ai = getGeminiClient();
  const guidedB64 = guidedBuf.toString('base64');
  const maskB64 = (await sharp(workingMask).png().toBuffer()).toString('base64');

  const opHint = mode === 'Add' ? 'ADD new content' : mode === 'Remove' ? 'REMOVE content' : 'REPLACE content';
  const prompt = [
    `[REGION EDIT – ${opHint}]`,
    `- Only modify the WHITE area of the provided mask.`,
    `- DO NOT change any pixels outside the mask.`,
    `- Preserve walls/windows/doors and architectural elements.`,
    `- Maintain camera viewpoint and perspective exactly.`,
    `- Instruction: ${instruction}`,
  ].join('\n');

  let resp;
  try {
    resp = (await runWithImageModelFallback(ai as any, {
      contents: [
        { inlineData: { mimeType: 'image/png', data: guidedB64 } },
        { inlineData: { mimeType: 'image/png', data: maskB64 } },
        { text: prompt }
      ]
    } as any, "region-edit")).resp;
    console.log('[applyEdit] Gemini model response received.');
  } catch (err) {
    console.error('[applyEdit] Gemini model call failed:', err);
    return baseImagePath;
  }

  const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data && /image\//.test(p.inlineData?.mimeType || ''));
    console.warn(`[editApply] Gemini region edit failed, returning original image`);
  if (img?.inlineData?.data) {
    const outPath = siblingOutPath(baseImagePath, "-edit", ".webp");
    writeImageDataUrl(outPath, `data:image/webp;base64,${img.inlineData.data}`);
    console.log('[applyEdit] Edit output saved:', outPath);
    return outPath;
  }

  // Fallback: if model failed, return original
  console.warn('[applyEdit] No valid output from Gemini, returning original image.');
  return baseImagePath;
}
