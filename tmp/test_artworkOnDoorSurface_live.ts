// Live test of the artwork-mounted-on-door-surface rule. STANDALONE, not
// wired to production.
//
// HONEST LIMITATION, stated up front: no image among tonight's fixtures
// shows artwork actually mounted on a glazed/mirrored/sliding door leaf —
// this was checked directly (visually inspected the real candidate images
// during planning) and no genuine positive-control case was found, so none
// is fabricated here. This test verifies the NEGATIVE path only: two real,
// confirmed-clean cases (neither has anything mounted on the door leaf
// itself) must correctly stay silent. The positive path (does the rule
// actually fire when artwork IS on a mirrored/glazed door) is verified
// offline only (tmp/verify_implausibleStaging_offline.ts) — treat that as
// logic-verified but NOT live-confirmed until a real positive-control image
// is sourced.
import path from "path";
process.env.STAGE2_VALIDATOR_MODEL = process.env.STAGE2_VALIDATOR_MODEL || "grok";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { observeArtworkOnDoorSurface, evaluateArtworkOnDoorSurface } from "./implausibleStagingCheck";
import { buildSemanticReference, pickLargestOpening, type PickedItem } from "./semanticItemRef";

const ROOT = path.join(__dirname, "..");
const BEDROOM_BASE = path.join(ROOT, "Test Images", "Bedroom (Baseline)");
const BEDROOM_STAGED = path.join(ROOT, "Test Images", "Bedroom (Staged)");

type Case = {
  label: string;
  baselinePath: string;
  stagedPath: string;
  jobId: string;
  pick: (baseline: any) => PickedItem | null;
};

// Baseline extraction is non-deterministic about which door gets returned
// when multiple exist in frame (confirmed repeatedly tonight, e.g. Bedroom
// 12's sliding door vs. an unrelated walkthrough). Bedroom 11 has BOTH a
// plain hinged door AND the mirrored sliding closet doors that are the
// actual subject of this test — pickLargestOpening's largest-by-area
// heuristic picked the WRONG one (the plain door) on a prior run. Match by
// description content instead, same fix pattern used for Bedroom 12
// earlier tonight.
function pickMirroredClosetDoor(b: any): PickedItem | null {
  const allOpenings = [...(b?.openings || [])];
  const mirrored = allOpenings.find((o: any) => /mirror/i.test(o.description || ""));
  return mirrored
    ? { id: mirrored.id, type: mirrored.type, description: mirrored.description, wallIndex: mirrored.wallIndex, horizontalBand: mirrored.horizontalBand, verticalBand: mirrored.verticalBand, bbox: mirrored.bbox }
    : pickLargestOpening(b, ["closet_door", "door"]);
}

const CASES: Case[] = [
  {
    label: "Bedroom 11 FIXED (mirrored closet door behind dresser — negative control, no art on the door leaf)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 11.jpg"),
    stagedPath: path.join(BEDROOM_BASE, "Bedroom 11-staged-FIXED-controlled.webp"),
    jobId: "artworkondoor-b11-fixed",
    pick: pickMirroredClosetDoor,
  },
  {
    label: "Bedroom 02 (door walled over, wall-mounted mirror beside dresser — negative control, mirror is on the WALL not the door)",
    baselinePath: path.join(BEDROOM_BASE, "Bedroom 02.jpg"),
    stagedPath: path.join(BEDROOM_STAGED, "Bedroom 02 (Enhanced).webp"),
    jobId: "artworkondoor-b02",
    pick: (b) => pickLargestOpening(b, ["closet_door", "door"]),
  },
];

const RUNS_PER_CASE = 3;

async function main() {
  console.log(`Validator model: ${process.env.STAGE2_VALIDATOR_MODEL}`);
  console.log(`NOTE: negative-control-only run — see file header for the honest limitation on positive-case coverage.`);
  const summary: string[] = [];

  const casesToRun = process.env.ONLY_JOB_IDS ? CASES.filter((c) => process.env.ONLY_JOB_IDS!.split(",").includes(c.jobId)) : CASES;
  for (const c of casesToRun) {
    console.log(`\n${"=".repeat(80)}\n${c.label}\n${"=".repeat(80)}`);

    let item: PickedItem | null = null;
    try {
      const baseline: any = await extractStructuralBaseline(c.baselinePath, { jobId: c.jobId, imageId: c.jobId });
      item = c.pick(baseline);
    } catch (e: any) {
      console.log(`  BASELINE EXTRACTION FAILED: ${e?.message || e}`);
    }

    if (!item) {
      console.log(`  Could not pick a door — skipping.`);
      summary.push(`${c.label}: SKIPPED (no door found)`);
      continue;
    }

    const semanticRef = buildSemanticReference(item);
    console.log(`  item.type="${item.type}" | baseline description="${item.description}" | semantic reference: "${semanticRef}"`);

    let failCount = 0;
    let notApplicableCount = 0;
    for (let run = 1; run <= RUNS_PER_CASE; run++) {
      console.log(`\n  --- Run ${run}/${RUNS_PER_CASE} ---`);
      const obs = await observeArtworkOnDoorSurface({ imagePath: c.stagedPath, semanticRef, ctx: { jobId: c.jobId, imageId: c.jobId, callLabel: `run${run}` } });
      console.log(`  doorSurfaceType="${obs.doorSurfaceType}" | doorSurfaceDescription="${obs.doorSurfaceDescription}"`);
      console.log(`  artworkMountedOnDoor="${obs.artworkMountedOnDoor}" | mountedArtworkDescription="${obs.mountedArtworkDescription}"`);
      const verdict = evaluateArtworkOnDoorSurface(item.type, item.description, obs);
      console.log(`  VERDICT: ${verdict.verdict} (${verdict.reason})`);
      if (verdict.verdict === "fail_artwork_on_door_surface") failCount++;
      if (verdict.verdict === "not_applicable") notApplicableCount++;
    }

    const line = `${c.label}: failed ${failCount}/${RUNS_PER_CASE}, not_applicable ${notApplicableCount}/${RUNS_PER_CASE} (expected fail=false — negative control)`;
    console.log(`\n  SUMMARY: ${line}`);
    summary.push(line);
  }

  console.log(`\n${"=".repeat(80)}\nFINAL SUMMARY (Artwork on Door Surface — negative controls only)\n${"=".repeat(80)}`);
  for (const s of summary) console.log(s);
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e, e?.stack);
  process.exit(1);
});
