import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFabricatedOpeningCheck } from "../worker/src/validators/fabricatedOpeningCheck";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const REPO_ROOT = path.resolve(__dirname, "..");

async function testCase(label: string, baselinePath: string, stagedPath: string) {
  const ctx = { jobId: `regress-fab-${label.replace(/\W+/g, "-")}`, imageId: `regress-fab-${label.replace(/\W+/g, "-")}` };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const result = await runFabricatedOpeningCheck(baselinePath, stagedPath, baseline, ctx);
  console.log(`\n${label}: verdict=${result.verdict} flagged=${result.flagged} (required=clean)`);
  if (result.flagged) {
    console.log(`  location=${result.location}`);
    console.log(`  call1Description=${result.call1Description}`);
  }
  return { label, verdict: result.verdict, match: result.verdict === "clean" };
}

async function main() {
  const results = [];
  results.push(await testCase(
    "Bedroom 12 clean",
    path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg"),
    path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 12 (Enhanced).webp")
  ));
  results.push(await testCase(
    "Bedroom 11 FIXED",
    path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 11.jpg"),
    path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 11-staged-FIXED-controlled.webp")
  ));
  console.log("\n\n================ SUMMARY ================");
  for (const r of results) console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
