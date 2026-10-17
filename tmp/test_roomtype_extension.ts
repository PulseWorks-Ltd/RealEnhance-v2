// Task G: real end-to-end test of the extended room-type coverage
// (standalone living, study, bathroom, hallway, garage) added to
// buildAnchorLockedStage2Prompt. Same harness pattern as
// tmp/test_kitchen_support.ts — real production function, real
// generation call where a genuine test image exists, real Grok
// validator pass, honest prompt-only checks where no real image of that
// type exists in the repo.
//
// Covers:
//   1) Standalone living (Rental 07.jpg, roomType="living_room") — REAL
//      generation + Grok validator pass. This is the one new room type
//      with a genuine, un-forced test image available.
//   2) Study, bathroom, hallway, garage — PROMPT-ONLY checks (no real
//      test image of these types exists in the repo, confirmed via
//      repo-wide search). Forced roomType onto existing real photos to
//      exercise the real wall-selection/light-staging mechanisms against
//      real extracted data, same approach used for kitchen_dining/
//      kitchen_living last task when no real image existed for those.
//   3) Office (unsupported) safety-net re-check — zero API calls expected.
//   4) Regression: bedroom (Bedroom 12 — HIGHEST PRIORITY, since
//      planBedroomAnchor's internals were refactored this task into a
//      shared helper; diagnostics are diffed against the exact known-good
//      values captured earlier this session), living_dining (Living 07),
//      kitchen (Karaka 02) — all diagnostics-only, no new generation,
//      since none of their own prompt-building code changed.
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const KITCHEN_DIR = path.join(REPO_ROOT, "Test Images/Kitchen");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

let apiCallCount = 0;

async function generateOne(imagePath: string, prompt: string, outPath: string) {
  const { data, mime } = toBase64(imagePath);
  const ai = getGeminiClient();
  console.log(`\n=== Sending real generation call (model=${MODEL}) === imagePath=${imagePath}`);
  const startedAt = Date.now();
  apiCallCount++;
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

async function planRoom(label: string, imagePath: string, roomType: string) {
  console.log(`\n\n########## ${label} — buildAnchorLockedStage2Prompt(roomType="${roomType}") ##########`);
  const result = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType,
    jobId: `tmp-roomtype-ext-${label.replace(/\s+/g, "").toLowerCase()}`,
    imageId: `tmp-roomtype-ext-${label.replace(/\s+/g, "").toLowerCase()}`,
  });
  if (result.diagnostics.baselineExtracted) apiCallCount++;
  if (result.diagnostics.wallVisibilityExtracted) apiCallCount++;
  console.log(`${label} fallbackReason:`, result.fallbackReason);
  console.log(`${label} diagnostics:`, JSON.stringify(result.diagnostics, null, 2));
  if (result.prompt) {
    console.log(`\n########## ${label} — FULL PROMPT ##########\n${result.prompt}`);
  }
  return result;
}

async function main() {
  console.log("\n\n========== PART 1: STANDALONE LIVING — REAL GENERATION + GROK VALIDATOR ==========");
  const livingImage = path.join(LIVING_DIR, "Rental 07.jpg");
  const livingResult = await planRoom("Standalone Living (Rental 07)", livingImage, "living_room");
  if (livingResult.prompt) {
    const outPath = path.join(LIVING_DIR, "Rental 07-anchor-locked-livingonly-staged.webp");
    await generateOne(livingImage, livingResult.prompt, outPath);

    console.log("\n=== Fresh baseline extraction for validator ===");
    const validatorBaseline: any = await extractStructuralBaseline(livingImage, { jobId: "roomtype-ext-living-validator-baseline", imageId: "roomtype-ext-living-validator-baseline" });
    apiCallCount++;

    process.env.STAGE2_VALIDATOR_MODEL = "grok";
    console.log("\n=== Running runOpeningEnvelopeValidator (Grok) on generated result ===");
    const oe = await runOpeningEnvelopeValidator(livingImage, outPath, validatorBaseline, { jobId: "roomtype-ext-living-validate", imageId: "roomtype-ext-living-validate" });
    apiCallCount += 2; // envelope_check + occlusion_check_opening are two separate Grok calls
    console.log("opening.status:", oe.opening.status);
    console.log("opening.reason:", oe.opening.reason);
    console.log("envelope.status:", oe.envelope.status);
    console.log("itemResults:", JSON.stringify(oe.itemResults.map((r) => ({ id: r.id, type: r.type, verdict: r.verdict, altered: r.altered, materiality: r.materiality })), null, 2));
  }

  console.log("\n\n========== PART 2: STUDY / BATHROOM / HALLWAY / GARAGE — PROMPT-ONLY (no real test image of these types exists) ==========");
  await planRoom("Study (forced on Bedroom 12)", path.join(BEDROOM_DIR, "Bedroom 12.jpg"), "study");
  await planRoom("Bathroom (forced on Karaka kitchen)", path.join(KITCHEN_DIR, "Karaka - Image 02 Baseline.jpg"), "bathroom");
  await planRoom("Hallway (forced on Living 10)", path.join(LIVING_DIR, "Living 10.jpg"), "hallway");
  await planRoom("Garage (forced on Rental 07)", livingImage, "garage");

  console.log("\n\n========== PART 3: OFFICE SAFETY-NET RE-CHECK (still unsupported, must still fall back, zero API calls) ==========");
  const officeResult = await buildAnchorLockedStage2Prompt({
    imagePath: livingImage,
    roomType: "office",
    jobId: "tmp-roomtype-ext-office-safetynet",
    imageId: "tmp-roomtype-ext-office-safetynet",
  });
  console.log("office (unsupported) result:", JSON.stringify(officeResult, null, 2));

  console.log("\n\n========== PART 4: REGRESSION — BEDROOM (highest priority: planBedroomAnchor was refactored), LIVING_DINING, KITCHEN ==========");
  const bedroomResult = await planRoom("Bedroom 12 (regression)", path.join(BEDROOM_DIR, "Bedroom 12.jpg"), "bedroom");
  console.log("\n>>> BEDROOM REGRESSION CHECK vs known-good values from earlier this session:");
  console.log(">>> expected anchorWallId=wall_1, anchorConfidence=0.9, protectedFeatureCount=5");
  console.log(">>> actual:", bedroomResult.diagnostics.anchorWallId, bedroomResult.diagnostics.anchorConfidence, bedroomResult.diagnostics.protectedFeatureCount);

  await planRoom("Living 07 (regression)", path.join(LIVING_DIR, "Living 07.jpg"), "living_dining");
  await planRoom("Kitchen (Karaka 02, regression)", path.join(KITCHEN_DIR, "Karaka - Image 02 Baseline.jpg"), "kitchen");

  console.log(`\n\n=== ALL DONE === total real API calls this run: ${apiCallCount}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("test_roomtype_extension failed:", e);
  process.exit(1);
});
