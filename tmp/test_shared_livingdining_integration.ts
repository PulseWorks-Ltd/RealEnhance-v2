// Real end-to-end test of the newly-ported living/dining path through the
// ACTUAL shared production function (buildAnchorLockedStage2Prompt), not a
// local reimplementation — this is the whole point of the integration.
// Covers: Bedroom 12 (regression + toggle-isolation confirmation), Living 07,
// Living 10 (circulation-clearance emphasis), and one forced-failure case.
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

async function generateOne(imagePath: string, prompt: string, outPath: string) {
  const { data, mime } = toBase64(imagePath);
  const ai = getGeminiClient();
  console.log(`\n=== Sending real generation call (model=${MODEL}) === imagePath=${imagePath}`);
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
    console.error("=== NO IMAGE RETURNED ===", parts.map((p: any) => Object.keys(p)));
    return null;
  }
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== DONE (${durationMs}ms) === outPath=${outPath}`);
  return outPath;
}

async function runRoom(label: string, imagePath: string, roomType: string, outPath: string) {
  console.log(`\n\n########## ${label} — via buildAnchorLockedStage2Prompt(roomType="${roomType}") ##########`);
  const result = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType,
    jobId: `tmp-shared-integration-${label.replace(/\s+/g, "").toLowerCase()}`,
    imageId: `tmp-shared-integration-${label.replace(/\s+/g, "").toLowerCase()}`,
  });
  console.log(`${label} fallbackReason:`, result.fallbackReason);
  console.log(`${label} diagnostics:`, JSON.stringify(result.diagnostics, null, 2));
  if (!result.prompt) {
    console.error(`${label}: NO PROMPT PRODUCED — stopping short of generation.`);
    return;
  }
  console.log(`\n########## ${label} — FULL PROMPT ##########\n${result.prompt}`);
  await generateOne(imagePath, result.prompt, outPath);
}

async function main() {
  await runRoom("Bedroom 12", path.join(BEDROOM_DIR, "Bedroom 12.jpg"), "bedroom", path.join(BEDROOM_DIR, "Bedroom 12-staged-sharedpath.webp"));
  await runRoom("Living 07", path.join(LIVING_DIR, "Living 07.jpg"), "living_dining", path.join(LIVING_DIR, "Living 07-staged-sharedpath.webp"));
  await runRoom("Living 10", path.join(LIVING_DIR, "Living 10.jpg"), "living_dining", path.join(LIVING_DIR, "Living 10-staged-sharedpath.webp"));

  console.log("\n\n########## FORCED FAILURE — nonexistent image path, roomType=living_dining ##########");
  const forcedResult = await buildAnchorLockedStage2Prompt({
    imagePath: path.join(LIVING_DIR, "DOES-NOT-EXIST-forced-failure-test.jpg"),
    roomType: "living_dining",
    jobId: "tmp-shared-integration-forcedfailure",
    imageId: "tmp-shared-integration-forcedfailure",
  });
  console.log("Forced-failure result:", JSON.stringify(forcedResult, null, 2));
  console.log("Forced-failure prompt is null (expected true):", forcedResult.prompt === null);
  console.log("Forced-failure fallbackReason (expected to mention baseline_extraction_failed):", forcedResult.fallbackReason);

  console.log("\n\n########## ROOM-TYPE-NOT-SUPPORTED sanity check (no API calls expected) ##########");
  const unsupportedResult = await buildAnchorLockedStage2Prompt({
    imagePath: path.join(LIVING_DIR, "Living 07.jpg"),
    roomType: "kitchen",
    jobId: "tmp-shared-integration-unsupported",
    imageId: "tmp-shared-integration-unsupported",
  });
  console.log("Unsupported room type result:", JSON.stringify(unsupportedResult, null, 2));

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("test_shared_livingdining_integration failed:", e);
  process.exit(1);
});
