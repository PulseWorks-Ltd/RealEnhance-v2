// Real testing of the new unified structural validator against known-bad
// and known-good real results from tonight's work, plus direct comparison
// against the existing specialist validators on the same images.
import fs from "fs/promises";
import path from "path";
import { runSingleCallStructuralValidator } from "../worker/src/validators/singleCallStructuralValidator";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function runCase(label: string, baselineImagePath: string, stagedImagePath: string, baseline: any, opts: { runOpening?: boolean; runFloor?: boolean; runFixture?: boolean }) {
  console.log(`\n\n########## CASE: ${label} ##########`);
  console.log(`baseline image: ${baselineImagePath}`);
  console.log(`staged image:   ${stagedImagePath}`);

  console.log("\n=== NEW: single-call structural validator (materiality redesign) ===");
  const unified = await runSingleCallStructuralValidator(baselineImagePath, stagedImagePath, baseline, { jobId: `test-${label}`, imageId: `test-${label}` });
  console.log("status:", unified.status);
  console.log("itemResults:", JSON.stringify(unified.itemResults, null, 2));
  console.log(
    "LOW-MATERIALITY items (excluded from alteration-based failure):",
    unified.lowMaterialityItems.length === 0
      ? "(none)"
      : JSON.stringify(unified.lowMaterialityItems.map((i) => ({ id: i.id, type: i.type, description: i.description, materialityReason: i.materialityReason })), null, 2)
  );
  console.log(
    "MATERIAL + ALTERED items (drive fail):",
    unified.materialAlteredItems.length === 0
      ? "(none)"
      : JSON.stringify(unified.materialAlteredItems.map((i) => ({ id: i.id, type: i.type, description: i.description, alterationReason: i.alterationReason })), null, 2)
  );

  if (opts.runOpening) {
    console.log("\n=== EXISTING: runOpeningValidator ===");
    const opening = await runOpeningValidator(baselineImagePath, stagedImagePath, { jobId: `test-${label}`, imageId: `test-${label}`, baseline });
    console.log("status:", opening.status, "| hardFail:", opening.hardFail, "| reason:", opening.reason);
  }
  if (opts.runFloor) {
    console.log("\n=== EXISTING: runFloorIntegrityValidator ===");
    const floor = await runFloorIntegrityValidator(baselineImagePath, stagedImagePath, { jobId: `test-${label}`, imageId: `test-${label}` });
    console.log("status:", floor.status, "| hardFail:", floor.hardFail, "| reason:", floor.reason);
  }
  if (opts.runFixture) {
    console.log("\n=== EXISTING: runFixtureValidator ===");
    const fixture = await runFixtureValidator(baselineImagePath, stagedImagePath, { jobId: `test-${label}`, imageId: `test-${label}` });
    console.log("status:", fixture.status, "| hardFail:", fixture.hardFail, "| reason:", fixture.reason);
  }

  return unified;
}

async function main() {
  // ── Case A/B: Bedroom 11 unfixed (known-bad) vs fixed (known-good) ──
  const snapshot = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8"));
  const bedroom11Baseline = snapshot.baseline;
  const bedroom11Original = path.join(BEDROOM_DIR, "Bedroom 11.jpg");

  await runCase(
    "bedroom11-UNFIXED-known-bad",
    bedroom11Original,
    path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp"),
    bedroom11Baseline,
    { runOpening: true }
  );

  await runCase(
    "bedroom11-FIXED-known-good",
    bedroom11Original,
    path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp"),
    bedroom11Baseline,
    { runOpening: true }
  );

  // ── Case C: Living 07 flooring failure (known-bad, out of scope for new validator) ──
  const living07Original = path.join(LIVING_DIR, "Living 07.jpg");
  console.log("\n\n=== Fresh baseline extraction: Living 07 ===");
  const living07Baseline: any = await extractStructuralBaseline(living07Original, { jobId: "test-living07-baseline", imageId: "test-living07-baseline" });
  console.log("openings:", living07Baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));

  await runCase(
    "living07-flooring-failure-known-bad",
    living07Original,
    path.join(LIVING_DIR, "Living 07-staged-v2.webp"),
    living07Baseline,
    { runFloor: true }
  );

  // ── Case D: Living 10 clean pass (known-good) ──
  const living10Original = path.join(LIVING_DIR, "Living 10.jpg");
  console.log("\n\n=== Fresh baseline extraction: Living 10 ===");
  const living10Baseline: any = await extractStructuralBaseline(living10Original, { jobId: "test-living10-baseline", imageId: "test-living10-baseline" });
  console.log("openings:", living10Baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));
  console.log("anchorFixtures:", (living10Baseline.anchorFixtures || []).map((f: any) => `${f.id}(${f.type})`).join(", "));

  await runCase(
    "living10-clean-known-good",
    living10Original,
    path.join(LIVING_DIR, "Living 10-staged-sharedpath.webp"),
    living10Baseline,
    { runOpening: true, runFixture: true }
  );

  // ── Case E: Bedroom 02 — door converted to wall with mirror over it (new real case) ──
  const bedroom02Original = path.join(BEDROOM_DIR, "Bedroom 02.jpg");
  console.log("\n\n=== Fresh baseline extraction: Bedroom 02 ===");
  const bedroom02Baseline: any = await extractStructuralBaseline(bedroom02Original, { jobId: "test-bedroom02-baseline", imageId: "test-bedroom02-baseline" });
  console.log("openings:", bedroom02Baseline.openings.map((o: any) => `${o.id}(${o.type})`).join(", "));
  console.log("anchorFixtures:", (bedroom02Baseline.anchorFixtures || []).map((f: any) => `${f.id}(${f.type})`).join(", "));

  await runCase(
    "bedroom02-door-to-mirror-known-bad",
    bedroom02Original,
    path.join(BEDROOM_DIR, "Bedroom 02 - Staged 2.jpg"),
    bedroom02Baseline,
    { runOpening: true }
  );

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_unified_validator failed:", e);
  process.exit(1);
});
