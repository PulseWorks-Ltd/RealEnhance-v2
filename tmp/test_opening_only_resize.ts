import path from "path";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import {
  HUMAN_EYE_FRAMING,
  buildObservationOnlyItemList,
  buildObservationQuestionsInstruction,
  buildObservationSchemaText,
  classifyObservation,
  combineOcclusionAnswer,
  runOcclusionObservationCall,
} from "../worker/src/validators/occlusionVsRemovalCheck";

process.env.STAGE2_VALIDATOR_MODEL = "grok";
const REPO_ROOT = path.resolve(__dirname, "..");
const OPENING_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

const OPENING_SYSTEM_INSTRUCTION = `You are checking whether architectural openings (windows, doors, walkthroughs, closet doors) from a room's baseline photo are still genuinely present in a staged (furnished) version — as opposed to merely being partly hidden behind normal staging furniture, which is expected and acceptable.

You are given two photos: the ORIGINAL (baseline) and the STAGED (furnished) version.

${HUMAN_EYE_FRAMING}

You must output strict JSON only: {"observations": [...], "materiality": [...]}. No explanations outside the JSON. No markdown. No comments.`;

async function runOnce(label: string, baselinePath: string, stagedPath: string, jobId: string, runIdx: number) {
  const ctx = { jobId: `${jobId}-r${runIdx}`, imageId: `${jobId}-r${runIdx}` };
  const baseline: any = await extractStructuralBaseline(baselinePath, ctx);
  const openings = baseline.openings;

  const phaseA = `PHASE A — OBSERVATION ONLY. Below are opening regions from the original photo, identified only by id and their approximate location.

${buildObservationOnlyItemList(openings.map((o: any) => ({ id: o.id, type: "", description: "", bbox: o.bbox })))}

${buildObservationQuestionsInstruction("opening")}

"observations" schema — one entry per id above, in the same order:
[${buildObservationSchemaText()}]`;

  const identified = openings.map((o: any) => ({ id: o.id, type: o.type, description: o.description || o.type, confidence: o.confidence }));
  const phaseB = `PHASE B — IDENTIFICATION AND MATERIALITY. Here is what each region actually is:
${JSON.stringify(identified, null, 2)}

"materiality" schema — one entry per id, same order:
[{"id": string, "materiality": "material" | "low_materiality", "materialityReason": string}]`;

  const raw = await runOcclusionObservationCall({
    systemInstruction: OPENING_SYSTEM_INSTRUCTION,
    userPrompt: `${phaseA}\n\n${phaseB}`,
    baselineImagePath: baselinePath,
    stagedImagePath: stagedPath,
    model: OPENING_MODEL,
    ctx: { ...ctx, callLabel: "opening" },
  });

  const observations = Array.isArray(raw?.observations) ? raw.observations : [];
  console.log(`\n########## ${label} run ${runIdx} ##########`);
  for (const obs of observations) {
    const classified = classifyObservation(obs);
    const combined = combineOcclusionAnswer({ ...classified, rawObservation: obs });
    const meta = openings.find((o: any) => o.id === obs.id);
    console.log(`  id=${obs.id} type=${meta?.type} verdict=${combined.verdict} resized=${combined.classification.resized.value} repositioned=${combined.classification.repositioned.value}`);
    console.log(`    extentComparisonDescription: ${obs.extentComparisonDescription}`);
  }
  return { label, runIdx, observations: observations.map((o: any) => o.id) };
}

async function main() {
  const which = process.argv[2];
  const runIdx = Number(process.argv[3] || 1);
  if (which === "bedroom12") {
    await runOnce(
      "Bedroom 12 (sliding door D1)",
      path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg"),
      path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 12-2.webp"),
      "opening-only-bedroom12",
      runIdx
    );
  } else if (which === "bedroom09") {
    await runOnce(
      "Bedroom 09 (genuine window resize)",
      path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 09.jpg"),
      path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 09 (Enhanced).webp"),
      "opening-only-bedroom09",
      runIdx
    );
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
