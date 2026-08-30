import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

async function generateOne(imagePath: string, prompt: string, outPath: string) {
  const { data, mime } = toBase64(imagePath);
  const ai = getGeminiClient();
  const startedAt = Date.now();
  const response: any = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data } }] }],
    generationConfig: { temperature: 0.4, topP: 0.9, topK: 40 },
  });
  const durationMs = Date.now() - startedAt;
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p: any) => p?.inlineData?.data);
  if (!imgPart) {
    console.error("NO IMAGE RETURNED", parts.map((p: any) => Object.keys(p)));
    return null;
  }
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`DONE (${durationMs}ms) -> ${outPath}`);
  return outPath;
}

async function runRoom(label: string, imgFile: string, outFile: string) {
  console.log(`\n\n########## ${label} — via CURRENT shared buildAnchorLockedStage2Prompt ##########`);
  const imagePath = path.join(BEDROOM_DIR, imgFile);
  const result = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType: "bedroom",
    jobId: `tmp-incident-${label.replace(/\s+/g, "").toLowerCase()}`,
    imageId: `tmp-incident-${label.replace(/\s+/g, "").toLowerCase()}`,
  });
  console.log(`${label} fallbackReason:`, result.fallbackReason);
  console.log(`${label} diagnostics:`, JSON.stringify(result.diagnostics, null, 2));
  if (!result.prompt) {
    console.error(`${label}: NO PROMPT — stopping.`);
    return;
  }
  console.log(`\n${label} FULL PROMPT:\n${result.prompt}`);
  await generateOne(imagePath, result.prompt, path.join(BEDROOM_DIR, outFile));
}

async function main() {
  await runRoom("Bedroom 11", "Bedroom 11.jpg", "Bedroom 11-staged-incidenttest.webp");
  await runRoom("Bedroom 14", "Bedroom 14.jpg", "Bedroom 14-staged-incidenttest.webp");
  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("incident_bedroom11_14_test failed:", e);
  process.exit(1);
});
