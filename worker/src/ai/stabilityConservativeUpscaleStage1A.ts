import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";
import sharp from "sharp";

const DEFAULT_STABILITY_STAGE1A_ENDPOINT =
  "https://api.stability.ai/v2beta/stable-image/upscale/conservative";

const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const STABILITY_STAGE1A_MODEL = process.env.STABILITY_STAGE1A_MODEL || "";
const STABILITY_STAGE1A_ENDPOINT = process.env.STABILITY_STAGE1A_ENDPOINT
  || (STABILITY_STAGE1A_MODEL
    ? `https://api.stability.ai/v2beta/stable-image/generate/${STABILITY_STAGE1A_MODEL}`
    : DEFAULT_STABILITY_STAGE1A_ENDPOINT);

const STABILITY_STAGE1A_STRENGTH = process.env.STABILITY_STAGE1A_STRENGTH;

/**
 * Minimal prompt for Conservative Upscaler - focuses on quality enhancement only
 * Conservative mode naturally preserves structure, this just guides the enhancement
 */
const STABILITY_STAGE1A_PROMPT = `Professional real estate photo quality enhancement. Improve clarity, lighting balance, and detail while preserving all structure, objects, and layout exactly as shown. No additions, removals, or modifications to content.`;

/**
 * Conservative Upscaler for Stage 1A
 *
 * Uses conservative mode which naturally minimizes hallucinations and content changes.
 * The prompt guides enhancement direction while the conservative algorithm ensures
 * structural preservation.
 */
export async function enhanceWithStabilityConservativeStage1A(
  inputWebpPath: string,
  sceneType?: "interior" | "exterior" | string
): Promise<string> {
  if (!STABILITY_API_KEY) {
    throw new Error("STABILITY_API_KEY is not set");
  }
  // 1. Convert input webp → JPEG for Stability
  const jpegInputPath = inputWebpPath.replace(".webp", "-stability-input.jpg");

  await sharp(inputWebpPath)
    .jpeg({ quality: 95 })
    .toFile(jpegInputPath);

  // 2. Prepare multipart form
  const form = new FormData();
  form.append("image", fs.createReadStream(jpegInputPath));
  form.append("prompt", STABILITY_STAGE1A_PROMPT);
  form.append("output_format", "jpeg");
  if (STABILITY_STAGE1A_STRENGTH) {
    form.append("strength", STABILITY_STAGE1A_STRENGTH);
  }

  // 3. Send request
  const res = await fetch(STABILITY_STAGE1A_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STABILITY_API_KEY}`,
      Accept: "image/*",
    },
    body: form as any,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[Stability Stage1A Conservative] HTTP Error:", errText);
    const error = new Error(`Stability Conservative Upscaler failed (${res.status} ${res.statusText})`);
    (error as any).status = res.status;
    (error as any).body = errText;
    (error as any).endpoint = STABILITY_STAGE1A_ENDPOINT;
    throw error;
  }

  // 4. Save output JPEG
  const buffer = Buffer.from(await res.arrayBuffer());
  const outJpegPath = jpegInputPath.replace(
    "-stability-input.jpg",
    "-stability-conservative-1A.jpg"
  );

  fs.writeFileSync(outJpegPath, buffer);

  return outJpegPath;
}
