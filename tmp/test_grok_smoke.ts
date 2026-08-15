// Minimal connectivity smoke test for the ported grok.ts before committing
// to the full test matrix — confirms XAI_API_KEY actually works and both
// grokAnalyzeImages (JSON) and grokImageEdit (image generation) return
// real, usable responses.
import path from "path";
import { toBase64 } from "../worker/src/utils/images";
import { grokAnalyzeImages, grokImageEdit } from "../worker/src/ai/grok";

const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const imgPath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const { data, mime } = toBase64(imgPath);
  const buffer = Buffer.from(data, "base64");

  console.log("=== Smoke test 1: grokAnalyzeImages (JSON) ===");
  const analyzeStart = Date.now();
  const text = await grokAnalyzeImages({
    images: [{ buffer, mimeType: mime, label: "Room photo:" }],
    prompt: `Return JSON describing this room: {"roomType": string, "hasWindow": boolean}`,
    jobId: "smoke-test",
    imageId: "smoke-test",
    reason: "connectivity_smoke_test",
    expectJson: true,
  });
  console.log("raw text:", text);
  console.log("latencyMs:", Date.now() - analyzeStart);
  try {
    const parsed = JSON.parse(text.trim().replace(/```json|```/gi, "").trim());
    console.log("parsed OK:", parsed);
  } catch (e) {
    console.log("PARSE FAILED:", e);
  }

  console.log("\n=== Smoke test 2: grokImageEdit (image generation) ===");
  const editStart = Date.now();
  const result = await grokImageEdit({
    imageBuffer: buffer,
    mimeType: mime,
    prompt: "Add a single small potted plant in the corner of this empty room. Keep everything else exactly the same.",
    jobId: "smoke-test",
    imageId: "smoke-test",
    reason: "connectivity_smoke_test",
  });
  console.log("output bytes:", result.buffer.length, "mimeType:", result.mimeType, "latencyMs:", Date.now() - editStart);
  const fs = require("fs");
  fs.writeFileSync("/tmp/grok_smoke_output.png", result.buffer);
  console.log("saved to /tmp/grok_smoke_output.png");

  console.log("\n=== ALL SMOKE TESTS PASSED ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
