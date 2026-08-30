import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFabricatedOpeningCheck } from "../worker/src/validators/fabricatedOpeningCheck";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const DIR = path.join(__dirname, "prodimg");

async function testCase(label: string, baselineFile: string, stagedFile: string, requiredVerdict: string, jobIdPrefix: string, runIdx: number) {
  const baselinePath = path.join(DIR, baselineFile);
  const stagedPath = path.join(DIR, stagedFile);
  const ctx = { jobId: `${jobIdPrefix}-r${runIdx}`, imageId: `${jobIdPrefix}-r${runIdx}` };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const result = await runFabricatedOpeningCheck(baselinePath, stagedPath, baseline, ctx);
  const match = result.verdict === requiredVerdict;
  console.log(`\n########## ${label} run ${runIdx} ##########`);
  console.log(`verdict=${result.verdict} (required=${requiredVerdict}) match=${match}`);
  console.log(`ranCall1=${result.ranCall1} ranCall2=${result.ranCall2} flagged=${result.flagged}`);
  if (result.flagged) {
    console.log(`location=${result.location}`);
    console.log(`call1Description=${result.call1Description}`);
    console.log(`presentInBaseline=${result.presentInBaseline}`);
    console.log(`call2Description=${result.call2Description}`);
  }
  console.log(`outcome.status=${result.outcome.status} outcome.reason=${result.outcome.reason}`);
  return { label, runIdx, verdict: result.verdict, requiredVerdict, match };
}

async function main() {
  const which = process.argv[2];
  const runIdx = process.argv[3] ? Number(process.argv[3]) : null;
  const results = [];
  const runs = runIdx ? [runIdx] : [1, 2, 3];
  for (const r of runs) {
    try {
      if (which === "8505488a") {
        results.push(await testCase("job_8505488a attempt2 (fabricated far-left doorway)", "baseline_8505488a.jpg", "attempt2_8505488a.webp", "fabricated", "test-8505488a-a2", r));
      } else if (which === "4f09191f") {
        results.push(await testCase("job_4f09191f attempt1 (fabricated return wall)", "baseline_4f09191f.jpg", "attempt1_4f09191f.webp", "fabricated", "test-4f09191f-a1", r));
      }
    } catch (e: any) {
      console.error(`ERROR run ${r}:`, e?.message || e);
      results.push({ label: which, runIdx: r, error: String(e?.message || e) });
    }
  }
  console.log("\n\n================ SUMMARY ================");
  for (const r of results) console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
