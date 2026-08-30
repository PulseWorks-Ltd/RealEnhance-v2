import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

async function main() {
  const imagePath = path.resolve(__dirname, "..", "Test Images/Living (Baseline)/Rental 03.jpg");
  console.log("=== Running real extractStructuralBaseline() on Rental 03.jpg ===");
  const baseline = await extractStructuralBaseline(imagePath, {
    jobId: "tmp-rental03-diagnosis",
    imageId: "rental03-diagnosis",
  });
  console.log(JSON.stringify(baseline, null, 2));
  console.log("=== DONE ===");
}

main().catch((e) => {
  console.error("check_rental03_baseline failed:", e);
  process.exit(1);
});
