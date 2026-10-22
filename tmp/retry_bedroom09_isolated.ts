import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const REPO_ROOT = path.resolve(__dirname, "..");

async function main() {
  const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 09.jpg");
  const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 09 (Enhanced).webp");
  const ctx = { jobId: "b09-isolated-retry", imageId: "b09-isolated-retry" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, bbox: o.bbox, description: o.description })), null, 2));
  const oe = await runOpeningEnvelopeValidator(baselinePath, stagedPath, baseline, ctx);
  console.log(`opening.status=${oe.opening.status} envelope.status=${oe.envelope.status} (required opening=fail)`);
  console.log(`opening.reason=${oe.opening.reason}`);
  console.log(`envelope.reason=${oe.envelope.reason}`);
  console.log("FULL itemResults:", JSON.stringify((oe as any).itemResults, null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
