// Re-test of the classifyExtent fix against the real case that found the
// bug: Living 07-staged-v2.webp's D1 (sliding glass door), previously
// misclassified "fully_covered" because "the couch extends past the
// region's right boundary" (a directional, partial overhang) was read as
// evidence the door was swallowed, despite Q1 explicitly saying the door
// was fully visible. Grok is the model this fix is being validated for;
// Gemini runs too, logged for reference only.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const baselinePath = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07.jpg");
const stagedPath = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07-staged-v2.webp");

async function runOnce(model: "gemini" | "grok", runIdx: number, baseline: any) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `extentfix-${model}-r${runIdx}`, imageId: `extentfix-${model}-r${runIdx}` };
  const r = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  const d1 = r.itemResults.find((i) => i.id === "D1") || r.itemResults.find((i) => i.type === "door");
  console.log(`\n[${model}] run ${runIdx}: opening.status=${r.opening.status}`);
  if (d1) {
    console.log(`  D1: verdict=${d1.verdict} altered=${d1.altered} extent.value=${d1.classification.extent.value} extent.matchedPattern=${d1.classification.extent.matchedPattern}`);
    console.log(`  coverageExtentDescription: "${d1.rawObservation.coverageExtentDescription}"`);
    console.log(`  currentStateDescription: "${d1.rawObservation.currentStateDescription}"`);
  } else {
    console.log("  D1 not found in itemResults — items:", r.itemResults.map((i) => `${i.id}(${i.type})`).join(","));
  }
  return { status: r.opening.status, d1Verdict: d1?.verdict };
}

async function main() {
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "extentfix-baseline", imageId: "extentfix-baseline" });
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, description: o.description })), null, 2));

  console.log("\n\n========== GROK (primary) ==========");
  const grokResults = [];
  for (let r = 1; r <= 2; r++) grokResults.push(await runOnce("grok", r, baseline));
  console.log(`\n>>> GROK SUMMARY: ${grokResults.map((r) => `${r.status}(D1=${r.d1Verdict})`).join(" / ")}`);

  console.log("\n\n========== GEMINI (reference only) ==========");
  const geminiResults = [];
  for (let r = 1; r <= 2; r++) geminiResults.push(await runOnce("gemini", r, baseline));
  console.log(`\n>>> GEMINI SUMMARY (reference only): ${geminiResults.map((r) => `${r.status}(D1=${r.d1Verdict})`).join(" / ")}`);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
