import fs from "fs";
import fetch from "node-fetch";
import FormData from "form-data";

const STABILITY_API_URL = "https://api.stability.ai/v2beta/stable-image/generate/sd3";
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

if (!STABILITY_API_KEY) {
  throw new Error("STABILITY_API_KEY is not set");
}

export async function enhanceWithStabilityStage1A(
  inputJpegPath: string,
  prompt: string
): Promise<string> {
  const form = new FormData();

  // 🔑 Required fields (per Stable Image docs)
  form.append("prompt", prompt);
  form.append("output_format", "jpeg");

  // 🔑 Switch to image-to-image mode by providing an image
  form.append("image", fs.createReadStream(inputJpegPath));

  // Recommended SD3 params
  form.append("model", "sd3-medium");           // base SD3
  form.append("mode", "image-to-image");        // crucial for img2img
  form.append("seed", "0");                     // 0 = random
  // Note: aspect_ratio is NOT allowed in image-to-image mode (derived from input image)

  // Gentle, realism-preserving enhancement
  form.append("strength", "0.3");               // small changes

  const res = await fetch(STABILITY_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STABILITY_API_KEY}`,
      "Accept": "image/*"
    },
    body: form as any
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[Stability Stage1A] HTTP error:", err);
    throw new Error("Stability Stage 1A enhancement failed");
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const outPath = inputJpegPath.replace("-stability-input.jpg", "-stability-1A.jpg");

  fs.writeFileSync(outPath, buffer);
  return outPath;
}
