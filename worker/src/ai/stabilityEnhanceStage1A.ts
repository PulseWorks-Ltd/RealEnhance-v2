import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import FormData from "form-data";

const STABILITY_API_URL = "https://api.stability.ai/v2beta/image-to-image";
const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

if (!STABILITY_API_KEY) {
  throw new Error("STABILITY_API_KEY is not set");
}

export async function enhanceWithStabilityStage1A(
  inputPath: string,
  prompt: string
): Promise<string> {

  const form = new FormData();

  // ✅ REQUIRED
  form.append("image", fs.createReadStream(inputPath));
  form.append("prompt", prompt);

  // ✅ CORE MODEL (standard access)
  form.append("model", "sdxl");

  // ✅ SAFE REALISM PARAMETERS
  form.append("strength", "0.28");     // low denoise = preserve structure
  form.append("cfg_scale", "5.5");     // natural photographic output
  form.append("steps", "20");
  form.append("seed", "0");

  const res = await fetch(STABILITY_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STABILITY_API_KEY}`,
      "Accept": "application/json"
    },
    body: form as any
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("❌ Stability Stage 1A HTTP failure:", err);
    throw new Error("Stability Stage 1A enhancement failed");
  }

  const json = await res.json();

  // ✅ STANDARD RESPONSE FORMAT FOR v2beta
  if (!json?.artifacts?.[0]?.base64) {
    console.error("❌ Stability response missing image:", json);
    throw new Error("Stability returned no image data");
  }

  const buffer = Buffer.from(json.artifacts[0].base64, "base64");

  const outPath = inputPath.replace(".webp", "-stability-1A.webp");
  fs.writeFileSync(outPath, buffer);

  return outPath;
}
