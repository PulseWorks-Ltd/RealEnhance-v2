import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

async function main() {
  const result = await buildAnchorLockedStage2Prompt({
    imagePath: path.join(LIVING_DIR, "Living 10.jpg"),
    roomType: "living_dining",
    jobId: "tmp-living10-retry2",
    imageId: "tmp-living10-retry2",
  });
  console.log("fallbackReason:", result.fallbackReason);
  console.log("diagnostics:", JSON.stringify(result.diagnostics, null, 2));
  if (!result.prompt) {
    console.error("NO PROMPT");
    process.exit(1);
  }
  console.log("\nFULL PROMPT:\n", result.prompt);
  const { data, mime } = toBase64(path.join(LIVING_DIR, "Living 10.jpg"));
  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: result.prompt }, { inlineData: { mimeType: mime, data } }] }],
    generationConfig: { temperature: 0.4, topP: 0.9, topK: 40 },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p: any) => p?.inlineData?.data);
  if (!imgPart) {
    console.error("NO IMAGE");
    process.exit(1);
  }
  const outPath = path.join(LIVING_DIR, "Living 10-staged-sharedpath-retry2.webp");
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log("DONE", outPath);
  process.exit(0);
}
main().catch((e) => {
  console.error("failed:", e);
  process.exit(1);
});
