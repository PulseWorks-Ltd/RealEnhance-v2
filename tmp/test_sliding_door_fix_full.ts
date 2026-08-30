// Full test battery for the sliding-pocket-door fix. Grok-primary.
// - Bedroom 14 Run 2: primary confirmation, 3 runs for stability (must
//   consistently pass, with structural evidence found, not a lucky default).
// - Bedroom 14 Run 1: regression check — the door panel here was SHIFTED
//   along the wall (per user's direct visual confirmation), not merely
//   closed in place, so no track/frame/jamb evidence should exist at the
//   ORIGINAL baseline location; must still correctly fail (not softened
//   into a false rescue).
// - Bedroom 02 door-to-mirror: regression check — a genuine hinged-door
//   removal case (not a sliding/pocket door at all); must still fail.
import fs from "fs/promises";
import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const VDIR = path.join(REPO_ROOT, "Test Images/Validator Testing Images");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

process.env.STAGE2_VALIDATOR_MODEL = "grok";

async function runOnce(label: string, baselinePath: string, stagedPath: string, baseline: any, required: string) {
  const ctx = { jobId: `sdfull-${label}-grok`, imageId: `sdfull-${label}-grok` };
  const r = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`[${label}][grok] opening.status=${r.opening.status} envelope.status=${r.envelope.status} (required=${required})`);
  const doorItems = r.itemResults.filter((i) => i.type === "closet_door" || i.type === "door");
  for (const d of doorItems) {
    console.log(`  ${d.id}(${d.type}): verdict=${d.verdict} altered=${d.altered} structuralEvidenceFound=${d.structuralEvidenceFound} structEvidenceText="${d.rawObservation.structuralEvidenceDescription}"`);
  }
  if (r.materialAlteredItems.length > 0) {
    console.log(`  altered items: ${r.materialAlteredItems.map((i) => `${i.id}=${i.verdict}`).join(", ")}`);
  }
  return { opening: r.opening.status, envelope: r.envelope.status };
}

async function main() {
  console.log("\n\n########## PRIMARY: Bedroom 14 Run 2 (3 runs for stability) ##########");
  const b14Baseline = path.join(VDIR, "Bedroom 14.jpg");
  const b14Struct: any = await extractStructuralBaseline(b14Baseline, { jobId: "sdfull-b14-baseline", imageId: "sdfull-b14-baseline" });
  const run2 = path.join(VDIR, "Bedroom 14 Testing - Staged Run 2.webp");
  const run2Results = [];
  for (let r = 1; r <= 3; r++) {
    run2Results.push(await runOnce(`b14run2-r${r}`, b14Baseline, run2, b14Struct, "pass"));
  }
  console.log(`>>> Run 2 SUMMARY: ${run2Results.map((r) => `opening=${r.opening}/envelope=${r.envelope}`).join(" | ")}`);

  console.log("\n\n########## REGRESSION: Bedroom 14 Run 1 (door panel shifted, must still fail) ##########");
  const run1 = path.join(VDIR, "Bedroom 14 Testing - Staged Run 1.webp");
  const run1Result = await runOnce("b14run1", b14Baseline, run1, b14Struct, "fail (door shifted, not just closed)");

  console.log("\n\n########## REGRESSION: Bedroom 02 door-to-mirror (genuine hinged-door removal) ##########");
  const b02Baseline = path.join(BEDROOM_DIR, "Bedroom 02.jpg");
  const b02Struct: any = await extractStructuralBaseline(b02Baseline, { jobId: "sdfull-b02-baseline", imageId: "sdfull-b02-baseline" });
  const b02Staged = path.join(BEDROOM_DIR, "Bedroom 02 - Staged 2.jpg");
  const b02Result = await runOnce("b02", b02Baseline, b02Staged, b02Struct, "fail");

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("test_sliding_door_fix_full failed:", e);
  process.exit(1);
});
