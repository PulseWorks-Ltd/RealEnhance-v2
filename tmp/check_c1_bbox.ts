import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

async function main() {
  const baselinePath = path.join(__dirname, "prodimg", "baseline_d8329bfc.jpg");
  const ctx = { jobId: "check-c1-bbox", imageId: "check-c1-bbox" };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  for (const o of baseline.openings) {
    console.log(o.id, "bbox=", JSON.stringify(o.bbox), "horizontalBand=", o.horizontalBand);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
