import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFabricatedOpeningCheck } from "../worker/src/validators/fabricatedOpeningCheck";

// Deliberately not setting STAGE2_VALIDATOR_MODEL=grok, routes to Gemini.
const DIR = path.join(__dirname, "prodimg");

async function main() {
  const baselinePath = path.join(DIR, "baseline_8505488a.jpg");
  const stagedPath = path.join(DIR, "attempt2_8505488a.webp");
  const ctx = { jobId: "test-gemini-8505488a-a2", imageId: "test-gemini-8505488a-a2" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const result = await runFabricatedOpeningCheck(baselinePath, stagedPath, baseline, ctx);
  console.log(`verdict=${result.verdict} (required=fabricated) match=${result.verdict === "fabricated"}`);
  console.log(`ranCall1=${result.ranCall1} ranCall2=${result.ranCall2} flagged=${result.flagged}`);
  if (result.flagged) {
    console.log(`location=${result.location}`);
    console.log(`locationBbox=${JSON.stringify(result.locationBbox)}`);
    console.log(`call1Description=${result.call1Description}`);
    console.log(`presentInBaseline=${result.presentInBaseline}`);
    console.log(`call2Description=${result.call2Description}`);
  }
  console.log("baseline.openings (with bbox):", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, bbox: o.bbox })), null, 2));
  console.log(`outcome.status=${result.outcome.status} outcome.reason=${result.outcome.reason}`);
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
