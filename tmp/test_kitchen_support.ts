// Task F, Part 2/testing: real end-to-end test of the new kitchen support
// added to buildAnchorLockedStage2Prompt (worker/src/pipeline/anchorLockedStaging.ts).
// Pattern reused directly from tmp/test_shared_livingdining_integration.ts
// (the harness that validated living-dining's integration earlier this
// session) — same shared production function, same real generation call,
// same real validator pass, nothing reimplemented locally.
//
// Covers:
//   1) Kitchen alone (Test Images/Kitchen/Karaka - Image 02 Baseline.jpg) —
//      real generation + runOpeningEnvelopeValidator (Grok) pass. This is
//      the one case with a real, visually-checkable window (W1, right_third)
//      to confirm against the "covered window" failure mode from Task E.
//   2) kitchen_dining / kitchen_living — PROMPT-ONLY check (no generation).
//      No real kitchen+dining or kitchen+living test image exists in this
//      repo (confirmed via repo-wide search), and forcing that room type
//      onto a kitchen-only photo wouldn't produce a visually meaningful
//      result (there's no real dining/living area in frame to stage) — so
//      this only confirms the code path builds a well-formed prompt with
//      the correct secondary-zone instruction, not a real image result.
//      Flagged here and in the report as an honest limitation, not a
//      skipped test.
//   3) Regression: bedroom + living_dining diagnostics-only re-check
//      (no new generation — buildBedroomPrompt/buildLivingDiningPrompt
//      source is byte-for-byte unchanged by this task, confirmed via git
//      diff; this just confirms the routing change didn't disturb them).
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { buildAnchorLockedStage2Prompt } from "../worker/src/pipeline/anchorLockedStaging";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const KITCHEN_DIR = path.join(REPO_ROOT, "Test Images/Kitchen");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
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
    jobId: `tmp-kitchen-support-${label.replace(/\s+/g, "").toLowerCase()}`,
    imageId: `tmp-kitchen-support-${label.replace(/\s+/g, "").toLowerCase()}`,
  });
  // baseline + wall-visibility extraction, when both run, are 2 real calls.
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
  console.log("\n\n========== PART 1: KITCHEN ALONE — REAL GENERATION + GROK VALIDATOR ==========");
  const kitchenImage = path.join(KITCHEN_DIR, "Karaka - Image 02 Baseline.jpg");
  const kitchenResult = await planRoom("Kitchen (Karaka 02)", kitchenImage, "kitchen");
  if (kitchenResult.prompt) {
    const outPath = path.join(KITCHEN_DIR, "Karaka 02-anchor-locked-kitchen-staged.webp");
    await generateOne(kitchenImage, kitchenResult.prompt, outPath);

    console.log("\n=== Fresh baseline extraction for validator (independent of planner's cached baseline) ===");
    const validatorBaseline: any = await extractStructuralBaseline(kitchenImage, { jobId: "kitchen-support-validator-baseline", imageId: "kitchen-support-validator-baseline" });
    apiCallCount++;

    process.env.STAGE2_VALIDATOR_MODEL = "grok";
    console.log("\n=== Running runOpeningEnvelopeValidator (Grok) on generated result ===");
    const oe = await runOpeningEnvelopeValidator(kitchenImage, outPath, validatorBaseline, { jobId: "kitchen-support-validate", imageId: "kitchen-support-validate" });
    apiCallCount++; // opening+envelope run as one combined call in this validator
    console.log("opening.status:", oe.opening.status);
    console.log("opening.reason:", oe.opening.reason);
    console.log("envelope.status:", oe.envelope.status);
    console.log("itemResults:", JSON.stringify(oe.itemResults.map((r) => ({ id: r.id, type: r.type, verdict: r.verdict, altered: r.altered, materiality: r.materiality })), null, 2));
  }

  console.log("\n\n========== PART 2: KITCHEN_DINING / KITCHEN_LIVING — PROMPT-ONLY (no real image to generate against) ==========");
  const kdResult = await planRoom("Kitchen_dining (Karaka 02, forced roomType)", kitchenImage, "kitchen_dining");
  const klResult = await planRoom("Kitchen_living (Karaka 02, forced roomType)", kitchenImage, "kitchen_living");
  console.log("\nkitchen_dining prompt includes DINING ZONE section:", !!kdResult.prompt?.includes("DINING ZONE"));
  console.log("kitchen_living prompt includes LIVING ZONE section:", !!klResult.prompt?.includes("LIVING ZONE"));

  console.log("\n\n========== PART 3: ROOM-TYPE-NOT-SUPPORTED SAFETY NET (office — must still fall back, no API calls) ==========");
  const officeResult = await buildAnchorLockedStage2Prompt({
    imagePath: kitchenImage,
    roomType: "office",
    jobId: "tmp-kitchen-support-office-safetynet",
    imageId: "tmp-kitchen-support-office-safetynet",
  });
  console.log("office (unsupported) result:", JSON.stringify(officeResult, null, 2));

  console.log("\n\n========== PART 4: REGRESSION — BEDROOM + LIVING_DINING (diagnostics-only, no new generation) ==========");
  await planRoom("Bedroom 12 (regression)", path.join(BEDROOM_DIR, "Bedroom 12.jpg"), "bedroom");
  await planRoom("Living 07 (regression)", path.join(LIVING_DIR, "Living 07.jpg"), "living_dining");

  console.log(`\n\n=== ALL DONE === total real API calls this run: ${apiCallCount}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("test_kitchen_support failed:", e);
  process.exit(1);
});
