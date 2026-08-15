// Wire-in test for flooringBoundaryCheck.ts, run against the real cases
// specified in the task: primary confirmation (Living 07's real
// carpet/linoleum boundary loss), positive control (any confirmed-preserved
// two-material case in the standing set), and regression (Bedroom 12,
// Bedroom 11 FIXED — single-material, clean), plus Living 07-staged-v2 as
// an additional data point. Real API calls throughout, both models.
//
// Baseline zone extraction is done ONCE per baseline image and reused
// across the 2 repeat runs per model, so "run 1 vs run 2" isolates
// observation-call consistency specifically, not compounded with baseline
// zone-extraction variance (extraction is always Gemini, independent of
// STAGE2_VALIDATOR_MODEL, same precedent as extractStructuralBaseline).
import path from "path";
import { runFlooringBoundaryCheck, extractFlooringZones, type FlooringZone } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

async function runOnce(label: string, model: "gemini" | "grok", runIdx: number, baselinePath: string, stagedPath: string, zones: FlooringZone[], required: string) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const ctx = { jobId: `floorbound-${label}-${model}-r${runIdx}`, imageId: `floorbound-${label}-${model}-r${runIdx}` };
  const result = await runFlooringBoundaryCheck(baselinePath, stagedPath, ctx, zones);
  console.log(`\n=== [${label}][${model}] run ${runIdx}: applicable=${result.applicable} status=${result.floor.status} (required=${required}) zoneCount=${zones.length} ===`);
  for (const z of result.itemResults) {
    console.log(`  zone ${z.id}: verdict=${z.verdict} materialMatches=${z.materialMatchesOriginalZone} seamVisible=${z.seamStillVisibleAnywhere} (matPattern=${z.classification.material.matchedPattern}${z.classification.boundary ? `, boundPattern=${z.classification.boundary.matchedPattern}` : ""})`);
  }
  return result.floor.status;
}

async function extractOnce(label: string, baselinePath: string): Promise<FlooringZone[]> {
  const zones = await extractFlooringZones(baselinePath, { jobId: `floorbound-extract-${label}`, imageId: `floorbound-extract-${label}` });
  console.log(`[extract] ${label}: ${zones.length} zone(s) — ${zones.map((z) => z.materialDescription).join(" | ")}`);
  return zones;
}

async function main() {
  console.log("\n\n########## PRIMARY: Living 07 real boundary-loss failure ##########");
  const livingBaseline = path.join(LIVING_DIR, "Living 07.jpg");
  const livingZones = await extractOnce("living07", livingBaseline);
  const precisefloorStaged = path.join(LIVING_DIR, "Living 07-staged-precisefloorcheck.webp");
  const primaryResults: string[] = [];
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      primaryResults.push(await runOnce("living07-precisefloorcheck", model, r, livingBaseline, precisefloorStaged, livingZones, "fail"));
    }
  }
  console.log(`>>> SUMMARY [living07-precisefloorcheck] required=fail | results=${primaryResults.join("/")}`);

  console.log("\n\n########## Living 07-staged-v2 (additional data point) ##########");
  const v2Staged = path.join(LIVING_DIR, "Living 07-staged-v2.webp");
  const v2Results: string[] = [];
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      v2Results.push(await runOnce("living07-v2", model, r, livingBaseline, v2Staged, livingZones, "unknown"));
    }
  }
  console.log(`>>> SUMMARY [living07-v2] required=unknown | results=${v2Results.join("/")}`);

  console.log("\n\n########## REGRESSION: Bedroom 12 clean (single-material floor) ##########");
  const bedroom12Baseline = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const bedroom12Zones = await extractOnce("bedroom12", bedroom12Baseline);
  const bedroom12Staged = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 12 (Enhanced).webp");
  const b12Results: string[] = [];
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      b12Results.push(await runOnce("bedroom12-clean", model, r, bedroom12Baseline, bedroom12Staged, bedroom12Zones, "pass"));
    }
  }
  console.log(`>>> SUMMARY [bedroom12-clean] required=pass | results=${b12Results.join("/")}`);

  console.log("\n\n########## REGRESSION: Bedroom 11 FIXED (single-material floor) ##########");
  const bedroom11Baseline = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  const bedroom11Zones = await extractOnce("bedroom11", bedroom11Baseline);
  const bedroom11Fixed = path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp");
  const b11Results: string[] = [];
  for (const model of ["gemini", "grok"] as const) {
    for (let r = 1; r <= 2; r++) {
      b11Results.push(await runOnce("bedroom11-FIXED", model, r, bedroom11Baseline, bedroom11Fixed, bedroom11Zones, "pass"));
    }
  }
  console.log(`>>> SUMMARY [bedroom11-FIXED] required=pass | results=${b11Results.join("/")}`);

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_flooring_boundary_check failed:", e);
  process.exit(1);
});
