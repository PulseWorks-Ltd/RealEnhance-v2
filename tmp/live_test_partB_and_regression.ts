// Part B regression guardrail (Bedroom 09 genuine resize must still FAIL)
// plus the standing regression set (Bedroom 11 UNFIXED/FIXED, Living 10,
// Living 07 fireplace, Bedroom 02, Bedroom 12 clean) — confirms the
// contrastive-clause + resize-negation fix introduces no new false
// positives/negatives on cases already validated earlier tonight.
import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { runFixtureFlooringValidator } from "../worker/src/validators/fixtureFlooringValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BEDROOM_STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

type Case = { label: string; baseline: string; staged: string; requiredOverall: "pass" | "fail" };

const CASES: Case[] = [
  {
    label: "Bedroom 09 genuine resize (Part B critical guardrail)",
    baseline: path.join(BEDROOM_DIR, "Bedroom 09.jpg"),
    staged: path.join(BEDROOM_STAGED_DIR, "Bedroom 09 (Enhanced).webp"),
    requiredOverall: "fail",
  },
  {
    label: "Bedroom 11 UNFIXED (standing regression, known bad)",
    baseline: path.join(BEDROOM_DIR, "Bedroom 11.jpg"),
    staged: path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp"),
    requiredOverall: "fail",
  },
  {
    label: "Bedroom 11 FIXED (standing regression, known good)",
    baseline: path.join(BEDROOM_DIR, "Bedroom 11.jpg"),
    staged: path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp"),
    requiredOverall: "pass",
  },
  {
    label: "Living 10 (standing regression, known good)",
    baseline: path.join(LIVING_DIR, "Living 10.jpg"),
    staged: path.join(LIVING_DIR, "Living 10-staged.webp"),
    requiredOverall: "pass",
  },
  {
    label: "Living 07 fireplace (standing regression, known good)",
    baseline: path.join(LIVING_DIR, "Living 07.jpg"),
    staged: path.join(LIVING_DIR, "Living 07-staged.webp"),
    requiredOverall: "pass",
  },
  {
    label: "Bedroom 02 (standing regression, known good)",
    baseline: path.join(BEDROOM_DIR, "Bedroom 02.jpg"),
    staged: path.join(BEDROOM_DIR, "Bedroom 02 - Staged 2.jpg"),
    requiredOverall: "pass",
  },
  {
    label: "Bedroom 12 clean (standing regression, known good)",
    baseline: path.join(BEDROOM_DIR, "Bedroom 12.jpg"),
    staged: path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 12 (Enhanced).webp"),
    requiredOverall: "pass",
  },
];

async function runCase(c: Case, idx: number) {
  const ctx = { jobId: `regress-${idx}`, imageId: `regress-${idx}` };
  console.log(`\n\n########## ${c.label} ##########`);
  const baseline: any = await extractStructuralBaseline(c.baseline, ctx);
  const [envelopeResult, fixtureResult] = await Promise.all([
    runOpeningEnvelopeValidator(c.baseline, c.staged, baseline, ctx),
    runFixtureFlooringValidator(c.baseline, c.staged, baseline, ctx),
  ]);
  const overallFail =
    envelopeResult.opening.status === "fail" ||
    envelopeResult.envelope.status === "fail" ||
    fixtureResult.fixture.status === "fail" ||
    fixtureResult.floor.status === "fail";
  const overall = overallFail ? "fail" : "pass";
  console.log(`opening.status=${envelopeResult.opening.status} envelope.status=${envelopeResult.envelope.status} fixture.status=${fixtureResult.fixture.status} floor.status=${fixtureResult.floor.status}`);
  if (envelopeResult.opening.status === "fail") console.log(`opening.reason=${envelopeResult.opening.reason}`);
  if (envelopeResult.envelope.status === "fail") console.log(`envelope.reason=${envelopeResult.envelope.reason}`);
  if (fixtureResult.fixture.status === "fail") console.log(`fixture.reason=${fixtureResult.fixture.reason}`);
  if (fixtureResult.floor.status === "fail") console.log(`floor.reason=${fixtureResult.floor.reason}`);
  console.log(`RESULT: ${c.label} => overall=${overall} required=${c.requiredOverall} match=${overall === c.requiredOverall}`);
  return { label: c.label, overall, required: c.requiredOverall, match: overall === c.requiredOverall };
}

async function main() {
  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    try {
      results.push(await runCase(CASES[i], i));
    } catch (e: any) {
      console.error(`ERROR ${CASES[i].label}:`, e?.message || e);
      results.push({ label: CASES[i].label, error: String(e?.message || e) });
    }
  }
  console.log("\n\n================ SUMMARY ================");
  for (const r of results) console.log(JSON.stringify(r));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
