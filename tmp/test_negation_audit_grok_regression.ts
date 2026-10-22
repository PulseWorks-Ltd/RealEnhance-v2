// Final live regression confirmation for the negation-blindness audit fixes
// (classifyPresence, classifyReplacement, shared NEGATION_CUE_PATTERN "n't"
// fix, FLOORING_NEGATION_CUE_PATTERN "n't" fix). Grok only, 1 run per case,
// across the standing six-case set plus the flooring cases, per the
// standing priority rule. Gemini not run here (reference-only, optional,
// not required — skipped to keep this focused and cheap).
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runFlooringBoundaryCheck, extractFlooringZones } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const STAGED_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)");

process.env.STAGE2_VALIDATOR_MODEL = "grok";

async function runOpening(label: string, baselinePath: string, stagedPath: string, baseline: any, required: string) {
  const ctx = { jobId: `negaudit-${label}-grok`, imageId: `negaudit-${label}-grok` };
  const r = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`[opening][${label}][grok] status=${r.opening.status} (required=${required})`);
  if (r.materialAlteredItems.length > 0) {
    console.log(`  altered: ${r.materialAlteredItems.map((i) => `${i.id}=${i.verdict}`).join(", ")}`);
  }
  return r.opening.status;
}

async function runFlooring(label: string, baselinePath: string, stagedPath: string, zones: any, required: string) {
  const ctx = { jobId: `negaudit-floor-${label}-grok`, imageId: `negaudit-floor-${label}-grok` };
  const r = await runFlooringBoundaryCheck(baselinePath, stagedPath, ctx, zones);
  console.log(`[flooring][${label}][grok] status=${r.floor.status} (required=${required})`);
  if (r.alteredZones.length > 0) {
    console.log(`  altered: ${r.alteredZones.map((z) => `${z.id}=${z.verdict}`).join(", ")}`);
  }
  return r.floor.status;
}

async function main() {
  const results: Record<string, string> = {};

  // --- Six-case opening/envelope regression set ---
  const bedroom11Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8")).baseline;
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  results["bedroom11-UNFIXED"] = await runOpening("bedroom11-UNFIXED", bedroom11Original, path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp"), bedroom11Baseline, "fail");
  results["bedroom11-FIXED"] = await runOpening("bedroom11-FIXED", bedroom11Original, path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp"), bedroom11Baseline, "pass (known pre-existing A1/C1 flakiness, not chased)");

  const living10Original = path.join(LIVING_DIR, "Living 10.jpg");
  const living10Baseline: any = await extractStructuralBaseline(living10Original, { jobId: "negaudit-living10-baseline", imageId: "negaudit-living10-baseline" });
  results["living10"] = await runOpening("living10", living10Original, path.join(LIVING_DIR, "Living 10-staged-sharedpath.webp"), living10Baseline, "fail");

  const living07Original = path.join(LIVING_DIR, "Living 07.jpg");
  const living07Baseline: any = await extractStructuralBaseline(living07Original, { jobId: "negaudit-living07-baseline", imageId: "negaudit-living07-baseline" });
  results["living07-fireplace"] = await runOpening("living07-fireplace", living07Original, path.join(LIVING_DIR, "Living 07-staged-v2.webp"), living07Baseline, "pass");

  const bedroom02Original = path.join(BEDROOM_DIR, "Bedroom 02.jpg");
  const bedroom02Baseline: any = await extractStructuralBaseline(bedroom02Original, { jobId: "negaudit-bedroom02-baseline", imageId: "negaudit-bedroom02-baseline" });
  results["bedroom02-door-to-mirror"] = await runOpening("bedroom02-door-to-mirror", bedroom02Original, path.join(BEDROOM_DIR, "Bedroom 02 - Staged 2.jpg"), bedroom02Baseline, "fail");

  const bedroom12Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/bedroom12_baseline_withdesc.json"), "utf8"));
  const bedroom12Original = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const bedroom12Staged = path.join(STAGED_DIR, "Bedroom 12 (Enhanced).webp");
  results["bedroom12-clean"] = await runOpening("bedroom12-clean", bedroom12Original, bedroom12Staged, bedroom12Baseline, "pass");

  // --- Flooring cases ---
  const living07Zones = await extractFlooringZones(living07Original, { jobId: "negaudit-living07-floor-extract", imageId: "negaudit-living07-floor-extract" });
  results["flooring:living07-precisefloorcheck"] = await runFlooring("living07-precisefloorcheck", living07Original, path.join(LIVING_DIR, "Living 07-staged-precisefloorcheck.webp"), living07Zones, "fail");
  results["flooring:living07-v2"] = await runFlooring("living07-v2", living07Original, path.join(LIVING_DIR, "Living 07-staged-v2.webp"), living07Zones, "fail (established, no positive control)");

  const bedroom12Zones = await extractFlooringZones(bedroom12Original, { jobId: "negaudit-bedroom12-floor-extract", imageId: "negaudit-bedroom12-floor-extract" });
  results["flooring:bedroom12-clean"] = await runFlooring("bedroom12-clean", bedroom12Original, bedroom12Staged, bedroom12Zones, "pass");

  const bedroom11Zones = await extractFlooringZones(bedroom11Original, { jobId: "negaudit-bedroom11-floor-extract", imageId: "negaudit-bedroom11-floor-extract" });
  results["flooring:bedroom11-FIXED"] = await runFlooring("bedroom11-FIXED", bedroom11Original, path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp"), bedroom11Zones, "pass");

  console.log("\n\n=== FINAL SUMMARY ===");
  for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
  console.log("\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_negation_audit_grok_regression failed:", e);
  process.exit(1);
});
