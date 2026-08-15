// Extends tonight's six-case Gemini-vs-Grok validator comparison to every
// bedroom with a real baseline + real staged pair, discovered and
// ground-truthed by direct visual crop comparison (see conversation
// report for the full discovery/exclusion reasoning). Scoped to
// runOpeningEnvelopeValidator only (not fixtureFlooringValidator) since
// the original six-case run found zero fixture/floor violations across
// the board — all diagnostic signal was in openings — and every new
// violation found in this wider sample is also window-related.
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");
const STAGED2_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged 2)");

type Case = {
  label: string;
  baselineImagePath: string;
  stagedImagePath: string;
  requiredStatus: "pass" | "fail";
  baselineSource: "fresh" | "reused";
};

async function runOnce(c: Case, model: "gemini" | "grok", runIdx: number, baseline: any) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `full-${c.label}-${model}-r${runIdx}`, imageId: `full-${c.label}-${model}-r${runIdx}` };
  const oe = await runOpeningEnvelopeValidator(c.baselineImagePath, c.stagedImagePath, baseline, ctx);
  console.log(`[${c.label}][${model}][run${runIdx}] opening.status=${oe.opening.status} envelope.status=${oe.envelope.status} required=${c.requiredStatus}`);
  if (oe.materialAlteredItems.length > 0) {
    console.log(`  material+altered:`, JSON.stringify(oe.materialAlteredItems.map((i) => ({ id: i.id, verdict: i.verdict, trace: i.rawObservation.currentStateDescription.slice(0, 140) }))));
  }
  return oe.opening.status;
}

async function runCase(c: Case) {
  console.log(`\n\n########## CASE: ${c.label} (required=${c.requiredStatus}, baseline=${c.baselineSource}) ##########`);
  console.log("baseline:", c.baselineImagePath);
  console.log("staged:  ", c.stagedImagePath);

  let baseline: any;
  if (c.baselineSource === "reused") {
    baseline = (c as any)._baseline;
  } else {
    baseline = await extractStructuralBaseline(c.baselineImagePath, { jobId: `full-${c.label}-baseline`, imageId: `full-${c.label}-baseline` });
    console.log("openings:", baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));
  }

  const results: Record<string, string[]> = { gemini: [], grok: [] };
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      const status = await runOnce(c, model, r, baseline);
      results[model].push(status);
    }
  }
  const geminiStable = results.gemini[0] === results.gemini[1];
  const grokStable = results.grok[0] === results.grok[1];
  const geminiCorrect = results.gemini.every((s) => s === c.requiredStatus);
  const grokCorrect = results.grok.every((s) => s === c.requiredStatus);
  console.log(
    `>>> SUMMARY [${c.label}] required=${c.requiredStatus} | gemini=${results.gemini.join("/")} (stable=${geminiStable}, correct=${geminiCorrect}) | grok=${results.grok.join("/")} (stable=${grokStable}, correct=${grokCorrect})`
  );
  return { label: c.label, required: c.requiredStatus, gemini: results.gemini, grok: results.grok };
}

async function main() {
  const bedroom11Snapshot = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8")).baseline;
  const bedroom12Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/bedroom12_baseline_withdesc.json"), "utf8"));

  const cases: Case[] = [
    { label: "bedroom02-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 02.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 02 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom03-stagedenhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 03.jpg"), stagedImagePath: path.join(STAGED_DIR, "Bedroom 03 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom04-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 04.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 04 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom05-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 05.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 05 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom06-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 06.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 06 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom07-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 07.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 07 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom09-stagedenhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 09.jpg"), stagedImagePath: path.join(STAGED_DIR, "Bedroom 09 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom11-incidenttest", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 11.jpg"), stagedImagePath: path.join(BEDROOM_DIR, "Bedroom 11-staged-incidenttest.webp"), requiredStatus: "pass", baselineSource: "reused" },
    { label: "bedroom11-staged1-NEWVIOLATION", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 11.jpg"), stagedImagePath: path.join(BEDROOM_DIR, "Bedroom 11 - Staged 1.webp"), requiredStatus: "fail", baselineSource: "reused" },
    { label: "bedroom12-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 12.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 12 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "reused" },
    { label: "bedroom14-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 14.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 14 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
    { label: "bedroom16-staged2enhanced", baselineImagePath: path.join(BEDROOM_DIR, "Bedroom 16.jpg"), stagedImagePath: path.join(STAGED2_DIR, "Bedroom 16 (Enhanced).webp"), requiredStatus: "pass", baselineSource: "fresh" },
  ];

  (cases[7] as any)._baseline = bedroom11Snapshot;
  (cases[8] as any)._baseline = bedroom11Snapshot;
  (cases[9] as any)._baseline = bedroom12Baseline;

  const summary: any[] = [];
  for (const c of cases) {
    try {
      const result = await runCase(c);
      summary.push(result);
    } catch (e) {
      console.error(`CASE ${c.label} FAILED:`, e);
      summary.push({ label: c.label, required: c.requiredStatus, error: String(e) });
    }
  }

  console.log("\n\n=== FULL SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_full_bedroom_set failed:", e);
  process.exit(1);
});
