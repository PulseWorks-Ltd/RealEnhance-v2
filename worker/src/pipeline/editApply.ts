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
  mode: "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  restoreFromPath?: string;
  smartReinstate?: boolean;
  sensitivityPx?: number; // grow/feather radius in pixels
}): Promise<string> {
  const { baseImagePath, mask, mode, instruction, restoreFromPath, smartReinstate = true, sensitivityPx = 4 } = params;

  const meta = await sharp(baseImagePath).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return baseImagePath;

  const maskBuf = isDataUrl(mask)
    ? Buffer.from(String(mask).split(',')[1] || '', 'base64')
    : (Buffer.isBuffer(mask) ? mask : Buffer.alloc(0));

  // Normalize mask to match base size and generate solid alpha map (0 or 255)
  const baseMask = await sharp(maskBuf)
    .resize(W, H, { fit: 'fill' })
    .greyscale()
    .threshold(128)
    .toBuffer();

  // Optional sensitivity: dilate + slight blur to avoid hard seams
  let workingMask = baseMask;
  try {
    const dilate = Math.max(0, Math.floor(sensitivityPx));
    if (dilate > 0) {
      // crude dilation via blur + threshold
      const blurred = await sharp(baseMask).blur(dilate / 2).toBuffer();
      workingMask = await sharp(blurred).threshold(32).toBuffer();
    }
  } catch {}

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
    return outPath;
  }

  // For Add/Remove/Replace: build guided input and call Gemini with explicit mask instruction
  // 1) Guided input – darken outside mask region
  const invertedMask = await sharp(workingMask)
    .negate()
    .toColourspace('b-w')
    .toBuffer();

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

  const { resp } = await runWithImageModelFallback(ai as any, {
    contents: [
      { inlineData: { mimeType: 'image/png', data: guidedB64 } },
      { inlineData: { mimeType: 'image/png', data: maskB64 } },
      { text: prompt }
    ]
  } as any, "region-edit");

  const parts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data && /image\//.test(p.inlineData?.mimeType || ''));
  if (img?.inlineData?.data) {
    const outPath = siblingOutPath(baseImagePath, "-edit", ".webp");
    writeImageDataUrl(outPath, `data:image/webp;base64,${img.inlineData.data}`);
    return outPath;
  }

  // Fallback: if model failed, return original
  return baseImagePath;
}
