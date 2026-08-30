// Full-integration live verification: calls the ACTUAL production entry
// points (runOpeningEnvelopeValidator, runFixtureFlooringValidator) — now
// wired with windowArtworkCheck.ts and vanishedLandmarkCheck.ts — against
// real, confirmed positive/negative controls from tonight's testing.
// Confirms: (1) the new checks' result arrays are populated on the returned
// object, (2) the override logic correctly reaches the final opening/fixture
// ValidatorOutcome (status/issueType/reason), (3) hardFail stays false by
// default (advisory-only rollout — NEW_VALIDATOR_CHECKS_BLOCKING unset),
// (4) nothing throws/crashes the whole validator call.
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const PRODIMG = path.join(__dirname, "prodimg");
const BEDROOM_BASE = path.join(REPO_ROOT, "Test Images", "Bedroom (Baseline)");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  expectOpeningFail: boolean;
  expectFixtureFail: boolean;
};

const CASES: Case[] = [
  {
    label: "Living 10 (window replaced by painting — window-artwork should FAIL opening)",
    baselinePath: path.join(PRODIMG, "baseline_9f64fe2a.jpg"),
    stagedPath: path.join(PRODIMG, "attempt1_9f64fe2a.webp"),
    jobId: "newchecks-living10",
    expectOpeningFail: true,
    expectFixtureFail: false,
  },
  {
    label: "f53669f1 (genuinely clean — must NOT fail either)",
    baselinePath: path.join(PRODIMG, "baseline_f53669f1.jpg"),
    stagedPath: path.join(PRODIMG, "attempt2_f53669f1.webp"),
    jobId: "newchecks-f53669f1",
    expectOpeningFail: false,
    expectFixtureFail: false,
  },
  {
    label: "Bedroom 12 (KNOWN VIOLATION — AC unit removed + door relocated — vanish-check should FAIL)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 12.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 12-2.webp"),
    jobId: "newchecks-b12",
    expectOpeningFail: true,
    expectFixtureFail: true, // AC unit is a fixture; the vanished landmark is often chosen relative to the door (opening), but could show on either side
  },
  {
    label: "Bedroom 11 FIXED (confirmed clean — must NOT fail either)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-FIXED-controlled.webp"),
    jobId: "newchecks-b11fixed",
    expectOpeningFail: false,
    expectFixtureFail: false,
  },
];

const MODELS = ["grok", "gemini"] as const;

async function main() {
  const summary: string[] = [];

  for (const model of MODELS) {
    process.env.STAGE2_VALIDATOR_MODEL = model;
    console.log(`\n\n${"#".repeat(80)}\nMODEL: ${model}\n${"#".repeat(80)}`);

    for (const c of CASES) {
      const jobId = `${c.jobId}-${model}`;
      console.log(`\n${"=".repeat(80)}\n[${model}] ${c.label}\n${"=".repeat(80)}`);
      try {
        const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId, imageId: jobId });
        const ctx = { jobId, imageId: jobId, attempt: 1 };

        const oe = await runOpeningEnvelopeValidator(c.baselinePath, c.stagedPath, baseline, ctx);
        const ff = await runFixtureFlooringValidator(c.baselinePath, c.stagedPath, baseline, ctx);

        console.log(`  opening.status=${oe.opening.status} hardFail=${oe.opening.hardFail} issueType=${oe.opening.issueType}`);
        console.log(`  opening.reason=${oe.opening.reason}`);
        console.log(`  windowArtworkCheck=${JSON.stringify(oe.windowArtworkCheck)}`);
        console.log(`  vanishedLandmarkCheck(openings)=${JSON.stringify(oe.vanishedLandmarkCheck)}`);
        console.log(`  fixture.status=${ff.fixture.status} hardFail=${ff.fixture.hardFail} issueType=${ff.fixture.issueType}`);
        console.log(`  fixture.reason=${ff.fixture.reason}`);
        console.log(`  vanishedLandmarkCheck(fixtures)=${JSON.stringify(ff.vanishedLandmarkCheck)}`);

        const openingFailed = oe.opening.status === "fail";
        const fixtureFailed = ff.fixture.status === "fail";
        const anyNewCheckThrew =
          oe.windowArtworkCheck.some((w) => w.verdict === "error") || oe.vanishedLandmarkCheck.some((v) => v.verdict === "error") || ff.vanishedLandmarkCheck.some((v) => v.verdict === "error");

        const line = `[${model}] ${c.label}: opening.status=${oe.opening.status}(hardFail=${oe.opening.hardFail}) fixture.status=${ff.fixture.status}(hardFail=${ff.fixture.hardFail}) anyNewCheckError=${anyNewCheckThrew} (expected openingFail=${c.expectOpeningFail}, fixtureFail=${c.expectFixtureFail})`;
        console.log(`\n  SUMMARY: ${line}`);
        summary.push(line);
      } catch (e: any) {
        const line = `[${model}] ${c.label}: FATAL ERROR (validator call itself threw — must be zero of these) ${e?.message || e}`;
        console.log(`  ${line}`);
        console.log(e?.stack);
        summary.push(line);
      }
    }
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (full production integration, cross-model)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
