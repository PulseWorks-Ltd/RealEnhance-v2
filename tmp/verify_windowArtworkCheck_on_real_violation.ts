// Directly tests whether windowArtworkCheck.ts (the dedicated safety-net
// validator) actually catches the real "2 Valentine Street" violation: the
// curtain-concealed window over the bed replaced with framed artwork in
// Stage 2. Uses the now-fixed baseline extraction (which should include
// the curtain-inferred window) against the REAL new staged output image
// the user saved from the app run that still exhibited the bug.
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import path from "node:path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runWindowArtworkCheckForOpenings } from "../worker/src/validators/windowArtworkCheck";

async function main() {
  const baselinePath = path.resolve(
    __dirname,
    "../Test Images/Validator Testing Images/2 Valentine Street - Image 01.jpg"
  );
  const stagedPath = path.resolve(
    __dirname,
    "../Test Images/Validator Testing Images/2 Valentine Street - Image 01 (Staged 2).jpg"
  );

  console.log("Extracting baseline...");
  const baseline = await extractStructuralBaseline(baselinePath, {
    jobId: "verify_real_violation",
    imageId: "img_verify_real_violation",
    attempt: 1,
  });
  const windows = baseline.openings.filter((o) => o.type === "window");
  console.log(`\nBaseline windows: ${windows.length}`);
  windows.forEach((w) => console.log(`  - ${w.id}: wallIndex=${w.wallIndex} confidence=${w.confidence} desc="${w.description}"`));

  console.log("\nRunning windowArtworkCheck against the real new staged output (Staged 2)...");
  const results = await runWindowArtworkCheckForOpenings(baseline.openings, stagedPath, {
    jobId: "verify_real_violation",
    imageId: "img_verify_real_violation",
    attempt: 1,
  });

  console.log("\n=== RESULTS ===");
  console.log(JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.verdict === "fail_window_replaced_by_artwork");
  if (failed.length > 0) {
    console.log(`\n✅ windowArtworkCheck DID catch the violation (${failed.length} item(s) flagged).`);
  } else {
    console.log("\n❌ windowArtworkCheck did NOT catch the violation.");
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
