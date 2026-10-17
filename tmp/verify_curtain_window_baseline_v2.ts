process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import path from "node:path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

async function main() {
  const imagePath = path.resolve(
    __dirname,
    "../Test Images/Validator Testing Images/2 Valentine Street - Image 01.jpg"
  );
  const baseline = await extractStructuralBaseline(imagePath, {
    jobId: "verify_curtain_window_v2",
    imageId: "img_verify_curtain_window_v2",
    attempt: 1,
  });

  console.log("\n=== FULL MERGED OPENINGS ===");
  console.log(JSON.stringify(baseline.openings, null, 2));
  console.log(`\nTotal openings: ${baseline.openings.length}`);
  const windows = baseline.openings.filter((o) => o.type === "window");
  console.log(`Windows: ${windows.length}`);
  windows.forEach((w) => console.log(`  - ${w.id}: wallIndex=${w.wallIndex} confidence=${w.confidence} desc="${w.description}"`));
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
