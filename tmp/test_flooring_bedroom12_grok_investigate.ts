import path from "path";
import { runFlooringBoundaryCheck, extractFlooringZones } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");

async function main() {
  const baseline = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const staged = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 12 (Enhanced).webp");
  const zones = await extractFlooringZones(baseline, { jobId: "investigate-b12-extract", imageId: "investigate-b12-extract" });
  console.log("zones:", JSON.stringify(zones, null, 2));

  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  for (let r = 1; r <= 4; r++) {
    const result = await runFlooringBoundaryCheck(baseline, staged, { jobId: `investigate-b12-grok-r${r}`, imageId: `investigate-b12-grok-r${r}` }, zones);
    console.log(`\n--- run ${r}: status=${result.floor.status} ---`);
    console.log(JSON.stringify(result.itemResults, null, 2));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
