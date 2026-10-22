// Full regression suite for the four-tier anchor-wall-selection rebuild
// (planSingleAnchorWall). This is the highest-risk change of the night —
// it replaces the core wall-selection logic bedroom, study, and (via
// planMultiAnchor's sofa-wall fallback... no, actually NOT living_dining/
// living_room, which use planMultiAnchor's own separate wall-ranking
// logic, untouched by this task) bedroom/study specifically depend on.
// Same harness pattern as every prior test tonight: real production
// function, real repeat calls, real generation + Grok validator pass.
//
// Covers:
//   1) Bedroom 12 — 3 repeat calls, tier + full reasoning logged each time.
//   2) Bedroom 14 — 3 repeat calls, confirms tier 2 still correctly wins
//      over the doorway wall (the original floor-clearance-fix case),
//      now via explicit tier priority rather than raw score dominance.
//   3) Study (forced on Bedroom 12, matching the room-type-extension
//      task's precedent) — 3 repeat calls.
//   4) Real generation + Grok validator pass on Bedroom 12 and Bedroom 14.
//   5) Zero-impact confirmation: kitchen, living_dining, bathroom,
//      hallway, garage — none call planSingleAnchorWall, confirmed live
//      (diagnostics-only, no new generation) rather than assumed from
//      the code-search above alone.
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

async function planOnce(label: string, imagePath: string, roomType: string, runIdx: number) {
  const result = await buildAnchorLockedStage2Prompt({
    imagePath,
    roomType,
    jobId: `tmp-tier-rebuild-${label.replace(/\s+/g, "").toLowerCase()}-r${runIdx}`,
    imageId: `tmp-tier-rebuild-${label.replace(/\s+/g, "").toLowerCase()}-r${runIdx}`,
  });
  if (result.diagnostics.baselineExtracted) apiCallCount++;
  if (result.diagnostics.wallVisibilityExtracted) apiCallCount++;
  console.log(
    `[${label}][run ${runIdx}] fallbackReason=${result.fallbackReason} anchorWallId=${result.diagnostics.anchorWallId} confidence=${result.diagnostics.anchorConfidence}`
  );
  console.log(`[${label}][run ${runIdx}] anchorSelectionReason: ${result.diagnostics.anchorSelectionReason}`);
  return result;
}

async function repeatRuns(label: string, imagePath: string, roomType: string, runs: number) {
  console.log(`\n\n########## ${label} — ${runs} repeat calls ##########`);
  const results = [];
  for (let r = 1; r <= runs; r++) {
    results.push(await planOnce(label, imagePath, roomType, r));
  }
  return results;
}

async function validateGeneration(label: string, imagePath: string, prompt: string, outPath: string) {
  await generateOne(imagePath, prompt, outPath);
  console.log(`\n=== Fresh baseline extraction for validator (${label}) ===`);
  const validatorBaseline: any = await extractStructuralBaseline(imagePath, { jobId: `tier-rebuild-validator-${label}`, imageId: `tier-rebuild-validator-${label}` });
  apiCallCount++;
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  console.log(`=== Running runOpeningEnvelopeValidator (Grok) on generated result (${label}) ===`);
  const oe = await runOpeningEnvelopeValidator(imagePath, outPath, validatorBaseline, { jobId: `tier-rebuild-validate-${label}`, imageId: `tier-rebuild-validate-${label}` });
  apiCallCount += 2;
  console.log(`[${label}] opening.status:`, oe.opening.status);
  console.log(`[${label}] opening.reason:`, oe.opening.reason);
  console.log(`[${label}] envelope.status:`, oe.envelope.status);
  console.log(`[${label}] itemResults:`, JSON.stringify(oe.itemResults.map((r) => ({ id: r.id, type: r.type, verdict: r.verdict, altered: r.altered, materiality: r.materiality })), null, 2));
  return oe;
}

async function main() {
  console.log("\n\n========== PART 1: BEDROOM 12 — 3 REPEAT CALLS ==========");
  const bedroom12Image = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const b12Results = await repeatRuns("Bedroom 12", bedroom12Image, "bedroom", 3);

  console.log("\n\n========== PART 2: BEDROOM 14 — 3 REPEAT CALLS (tier-2-vs-tier-4 regression case) ==========");
  const bedroom14Image = path.join(BEDROOM_DIR, "Bedroom 14.jpg");
  const b14Results = await repeatRuns("Bedroom 14", bedroom14Image, "bedroom", 3);

  console.log("\n\n========== PART 3: STUDY (forced on Bedroom 12) — 3 REPEAT CALLS ==========");
  const studyResults = await repeatRuns("Study", bedroom12Image, "study", 3);

  console.log("\n\n========== PART 4: REAL GENERATION + GROK VALIDATOR — BEDROOM 12 & BEDROOM 14 ==========");
  const lastB12 = b12Results[b12Results.length - 1];
  if (lastB12.prompt) {
    await validateGeneration("bedroom12", bedroom12Image, lastB12.prompt, path.join(BEDROOM_DIR, "Bedroom 12-tierrebuild-staged.webp"));
  } else {
    console.log("Bedroom 12: no prompt produced on final run, skipping generation.");
  }
  const lastB14 = b14Results[b14Results.length - 1];
  if (lastB14.prompt) {
    await validateGeneration("bedroom14", bedroom14Image, lastB14.prompt, path.join(BEDROOM_DIR, "Bedroom 14-tierrebuild-staged.webp"));
  } else {
    console.log("Bedroom 14: no prompt produced on final run, skipping generation.");
  }

  console.log("\n\n========== PART 5: ZERO-IMPACT CONFIRMATION — kitchen, living_dining, bathroom, hallway, garage ==========");
  await planOnce("Kitchen (zero-impact)", path.join(KITCHEN_DIR, "Karaka - Image 02 Baseline.jpg"), "kitchen", 1);
  await planOnce("Living_dining (zero-impact)", path.join(LIVING_DIR, "Living 07.jpg"), "living_dining", 1);
  await planOnce("Bathroom (zero-impact)", path.join(KITCHEN_DIR, "Karaka - Image 02 Baseline.jpg"), "bathroom", 1);
  await planOnce("Hallway (zero-impact)", path.join(LIVING_DIR, "Living 10.jpg"), "hallway", 1);
  await planOnce("Garage (zero-impact)", path.join(LIVING_DIR, "Rental 07.jpg"), "garage", 1);

  console.log(`\n\n=== ALL DONE === total real API calls this run: ${apiCallCount}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("test_tier_rebuild failed:", e);
  process.exit(1);
});
