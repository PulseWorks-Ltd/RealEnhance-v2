process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import path from "node:path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

async function main() {
  const imagePath = path.resolve(
    __dirname,
    "../Test Images/Validator Testing Images/2 Valentine Street - Image 01.jpg"
  );
  const baseline = await extractStructuralBaseline(imagePath, {
    jobId: "verify_curtain_window",
    imageId: "img_verify_curtain_window",
    attempt: 1,
  });

  console.log("\n=== OPENINGS ===");
  for (const o of baseline.openings) {
    console.log(JSON.stringify(o, null, 2));
  }
  console.log(`\nTotal openings: ${baseline.openings.length}`);

  const windows = baseline.openings.filter((o) => o.type === "window");
  console.log(`Windows detected: ${windows.length}`);

  const curtainOverBed = windows.find(
    (w) => w.horizontalBand !== undefined && /curtain|inferred|not (directly )?visible|not confirmed/i.test(w.description || "")
  );
  if (curtainOverBed) {
    console.log("\n✅ PASS: a curtain-inferred window was detected:");
    console.log(JSON.stringify(curtainOverBed, null, 2));
  } else if (windows.length >= 2) {
    console.log("\n⚠️  Two+ windows detected but none explicitly flagged as curtain-inferred by description heuristic — inspect manually above.");
  } else {
    console.log("\n❌ FAIL: only the visible right-hand window was detected; the curtain-concealed window above the bed was NOT classified as a window.");
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
