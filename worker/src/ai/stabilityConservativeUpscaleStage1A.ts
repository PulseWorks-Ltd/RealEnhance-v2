import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";
import sharp from "sharp";

const STABILITY_UPSCALE_URL =
  "https://api.stability.ai/v2beta/stable-image/upscale/conservative";

const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

if (!STABILITY_API_KEY) {
  throw new Error("STABILITY_API_KEY is not set");
}

/**
 * Conservative Upscaler for Stage 1A — NO CONTENT REINTERPRETATION.
 *
 * This endpoint provides pure quality enhancement without any hallucinations,
 * object changes, or content reinterpretation. Perfect for real estate compliance.
 */
export async function enhanceWithStabilityConservativeStage1A(
  inputWebpPath: string
): Promise<string> {
  // 1. Convert input webp → JPEG for Stability
  const jpegInputPath = inputWebpPath.replace(".webp", "-stability-input.jpg");

  await sharp(inputWebpPath)
    .jpeg({ quality: 95 })
    .toFile(jpegInputPath);

  // 2. Prepare multipart form
  const form = new FormData();
  form.append("image", fs.createReadStream(jpegInputPath));
  form.append("output_format", "jpeg");

  // 3. Send request
  const res = await fetch(STABILITY_UPSCALE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STABILITY_API_KEY}`,
      Accept: "image/*",
    },
    body: form as any,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[Stability Stage1A Conservative] HTTP Error:", err);
    throw new Error("Stability Conservative Upscaler failed");
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
