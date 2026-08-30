import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

async function main() {
  const imagePath = path.resolve(__dirname, "..", "Test Images/Bedroom (Baseline)/Bedroom 11.jpg");
  console.log("=== Running real extractStructuralBaseline() on Bedroom 11.jpg ===");
  const baseline = await extractStructuralBaseline(imagePath, {
    jobId: "tmp-bedroom11-diagnosis",
    imageId: "bedroom11-diagnosis",
  });
  console.log(JSON.stringify(baseline, null, 2));
  console.log("=== DONE ===");
}

main().catch((e) => {
  console.error("check_bedroom11_baseline failed:", e);
  process.exit(1);
});
