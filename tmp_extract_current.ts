import fs from "fs";
import { extractStructuralBaseline } from "./worker/src/validators/openingPreservationValidator";

async function main() {
  const image = "/workspaces/RealEnhance-v2/tmp/historical-window-shift-rerun/baseline.jpg";
  const out = await extractStructuralBaseline(image, { jobId: "rca-new-extract", imageId: "baseline" });
  fs.writeFileSync("/workspaces/RealEnhance-v2/analysis/window_shift_regression/baseline_extract_current_head.json", JSON.stringify(out, null, 2));
  console.log("WROTE baseline_extract_current_head.json");
}
main();
