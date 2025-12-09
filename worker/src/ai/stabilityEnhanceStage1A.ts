import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import FormData from "form-data";

const STABILITY_API_URL = "https://api.stability.ai/v2beta/stable-image/edit";
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

if (!STABILITY_API_KEY) {
  throw new Error("STABILITY_API_KEY is not set in environment variables");
}

export async function enhanceWithStabilityStage1A(
  inputPath: string,
  prompt: string
): Promise<string> {
  const form = new FormData();

  form.append("image", fs.createReadStream(inputPath));
  form.append("prompt", prompt);
  form.append("output_format", "webp");

  // ✅ SAFE, REALISTIC STAGE 1A PARAMETERS
  form.append("strength", "0.28");       // Low denoise to preserve structure
  form.append("cfg_scale", "5.5");        // Natural look, avoids over-stylization
  form.append("steps", "20");             // Good quality / speed balance
  form.append("seed", "0");               // Deterministic (0 = auto but stable in SD)
  form.append("guidance_preset", "NONE"); // Avoids cinematic / fantasy looks

  const res = await fetch(STABILITY_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STABILITY_API_KEY}`,
      "Accept": "image/webp"
    },
    body: form as any
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ Stability Stage 1A failed:", err);
    throw new Error("Stability Stage 1A enhancement failed");
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const outPath = inputPath.replace(".webp", "-stability-1A.webp");

  fs.writeFileSync(outPath, buffer);

  return outPath;
}
