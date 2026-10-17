import path from "path";
import { runOpeningEnvelopeValidator } from "../worker/src/validators/openingEnvelopeValidator";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const VDIR = path.join(REPO_ROOT, "Test Images/Validator Testing Images");

async function main() {
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  const baselinePath = path.join(VDIR, "Bedroom 14.jpg");
  const baseline: any = await extractStructuralBaseline(baselinePath, { jobId: "sdfix-baseline", imageId: "sdfix-baseline" });
  console.log("openings:", JSON.stringify(baseline.openings.map((o: any) => ({ id: o.id, type: o.type, paneStructure: o.paneStructure, doorLeafState: o.doorLeafState, description: o.description })), null, 2));

  const staged2 = path.join(VDIR, "Bedroom 14 Testing - Staged Run 2.webp");
  const r2 = await runOpeningEnvelopeValidator(baselinePath, staged2, baseline, { jobId: "sdfix-r2", imageId: "sdfix-r2" });
  console.log("\n=== Run 2 ===");
  console.log("opening.status:", r2.opening.status, "envelope.status:", r2.envelope.status);
  console.log("FULL itemResults:", JSON.stringify(r2.itemResults, null, 2));
  console.log("envelope reason:", r2.envelope.reason);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
