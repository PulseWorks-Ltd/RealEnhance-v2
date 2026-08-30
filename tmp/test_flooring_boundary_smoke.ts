import path from "path";
import { runFlooringBoundaryCheck } from "../worker/src/validators/flooringBoundaryCheck";

const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "gemini";
  const baseline = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07.jpg");
  const staged = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07-staged-precisefloorcheck.webp");
  const result = await runFlooringBoundaryCheck(baseline, staged, { jobId: "smoke", imageId: "smoke" });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
