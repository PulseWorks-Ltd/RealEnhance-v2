// Live re-run (Grok-primary) of the full test suite for the
// contrastive-phrasing / resize false-positive fix, against real production
// image pairs downloaded from S3 (baseline_*.jpg = original upload,
// attempt{1,2}_*.webp = the exact Stage 2 image the validator evaluated for
// that attempt).
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";
import { runFlooringBoundaryCheck } from "../worker/src/validators/flooringBoundaryCheck";

process.env.STAGE2_VALIDATOR_MODEL = "grok";

const DIR = path.join(__dirname, "prodimg");

type Job = {
  key: string;
  baseline: string;
  attempts: string[];
};

const JOBS: Job[] = [
  { key: "job_4f09191f", baseline: "baseline_4f09191f.jpg", attempts: ["attempt1_4f09191f.webp", "attempt2_4f09191f.webp"] },
  { key: "job_f53669f1", baseline: "baseline_f53669f1.jpg", attempts: ["attempt1_f53669f1.webp", "attempt2_f53669f1.webp"] },
  { key: "job_3e255f88", baseline: "baseline_3e255f88.jpg", attempts: ["attempt1_3e255f88.webp", "attempt2_3e255f88.webp"] },
  { key: "job_7121d9d1", baseline: "baseline_7121d9d1.jpg", attempts: ["attempt1_7121d9d1.webp", "attempt2_7121d9d1.webp"] },
  { key: "job_9f64fe2a", baseline: "baseline_9f64fe2a.jpg", attempts: ["attempt1_9f64fe2a.webp", "attempt2_9f64fe2a.webp"] },
  { key: "job_5f9e501c", baseline: "baseline_5f9e501c.jpg", attempts: ["attempt1_5f9e501c.webp", "attempt2_5f9e501c.webp"] },
  { key: "job_d8329bfc", baseline: "baseline_d8329bfc.jpg", attempts: ["attempt1_d8329bfc.webp", "attempt2_d8329bfc.webp"] },
];

async function testJobAttempt(jobKey: string, attemptIdx: number, baselinePath: string, stagedPath: string) {
  const ctx = { jobId: `${jobKey}-live-a${attemptIdx}`, imageId: `${jobKey}-live-a${attemptIdx}` };
  console.log(`\n\n########## ${jobKey} attempt ${attemptIdx} ##########`);
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  console.log(`openings=${baseline.openings.length} anchorFixtures=${(baseline.anchorFixtures || []).length}`);

  const [envelopeResult, fixtureResult] = await Promise.all([
    runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx),
    runFixtureFlooringValidator(baselinePath, stagedPath, baseline, ctx),
  ]);

  console.log(`opening.status=${envelopeResult.opening.status} envelope.status=${envelopeResult.envelope.status}`);
  console.log(`opening.reason=${envelopeResult.opening.reason}`);
  console.log(`envelope.reason=${envelopeResult.envelope.reason}`);
  console.log(`fixture.status=${fixtureResult.fixture.status}`);
  console.log(`fixture.reason=${fixtureResult.fixture.reason}`);
  console.log(`floor(fromFixtureValidator).status=${fixtureResult.floor.status}`);
  console.log(`floor(fromFixtureValidator).reason=${fixtureResult.floor.reason}`);

  const overallFail =
    envelopeResult.opening.status === "fail" ||
    envelopeResult.envelope.status === "fail" ||
    fixtureResult.fixture.status === "fail" ||
    fixtureResult.floor.status === "fail";

  return {
    jobKey,
    attemptIdx,
    opening: envelopeResult.opening.status,
    envelope: envelopeResult.envelope.status,
    fixture: fixtureResult.fixture.status,
    floor: fixtureResult.floor.status,
    overall: overallFail ? "fail" : "pass",
  };
}

async function main() {
  const results: any[] = [];
  for (const job of JOBS) {
    const baselinePath = path.join(DIR, job.baseline);
    for (let i = 0; i < job.attempts.length; i++) {
      const stagedPath = path.join(DIR, job.attempts[i]);
      try {
        const r = await testJobAttempt(job.key, i + 1, baselinePath, stagedPath);
        results.push(r);
      } catch (e: any) {
        console.error(`ERROR ${job.key} attempt ${i + 1}:`, e?.message || e);
        results.push({ jobKey: job.key, attemptIdx: i + 1, error: String(e?.message || e) });
      }
    }
  }

  console.log("\n\n================ SUMMARY ================");
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
