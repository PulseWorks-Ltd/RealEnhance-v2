import path from "path";
import { runFlooringBoundaryCheck, extractFlooringZones } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

async function main() {
  const baseline = path.join(LIVING_DIR, "Living 07.jpg");
  const staged = path.join(LIVING_DIR, "Living 07-staged-precisefloorcheck.webp");
  process.env.STAGE2_VALIDATOR_MODEL = "gemini";

  for (let r = 1; r <= 3; r++) {
    const zones = await extractFlooringZones(baseline, { jobId: `investigate3z-extract-r${r}`, imageId: `investigate3z-extract-r${r}` });
    console.log(`\n\n=== extraction run ${r}: ${zones.length} zones ===`);
    console.log(zones.map((z) => `${z.id}: ${z.materialDescription}`).join("\n"));

    const result = await runFlooringBoundaryCheck(baseline, staged, { jobId: `investigate3z-r${r}`, imageId: `investigate3z-r${r}` }, zones);
    console.log(`status=${result.floor.status}`);
    console.log(JSON.stringify(result.itemResults.map((z) => ({ id: z.id, verdict: z.verdict, materialDescription: z.rawObservation.materialDescription, boundaryDescription: z.rawObservation.boundaryDescription })), null, 2));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
