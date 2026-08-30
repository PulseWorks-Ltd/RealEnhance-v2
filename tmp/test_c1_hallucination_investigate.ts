// Investigation of Bedroom 14 Run 1's C1 hallucination — pure diagnosis,
// no fixes. Uses the exact production question set (Q1-Q5 via the shared
// builders) restricted to just item C1, across four conditions:
//   A) reproduce: full images (real files), real baseline bbox, Grok
//   B) tight crop: pre-cropped baseline+staged (PNG), bbox=[0,0,1,1], Grok
//   C) format: full images but staged re-encoded as PNG (same content/res), Grok
//   D) gemini: same as A but model=gemini (reference/comparison only)
import path from "path";
import {
  buildObservationOnlyItemList,
  buildObservationQuestionsInstruction,
  buildObservationSchemaText,
  runOcclusionObservationCall,
  HUMAN_EYE_FRAMING,
} from "../worker/src/validators/occlusionVsRemovalCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const VDIR = path.join(REPO_ROOT, "Test Images/Validator Testing Images");
const CDIR = path.join(REPO_ROOT, "tmp/c1_investigate");

const SYSTEM_INSTRUCTION = `You are checking whether architectural openings (windows, doors, walkthroughs, closet doors) from a room's baseline photo are still genuinely present in a staged (furnished) version — as opposed to merely being partly hidden behind normal staging furniture, which is expected and acceptable.

You are given two photos: the ORIGINAL (baseline) and the STAGED (furnished) version.

${HUMAN_EYE_FRAMING}

You must output strict JSON only: {"observations": [...]}. No explanations outside the JSON. No markdown. No comments.`;

function buildPrompt(bbox: [number, number, number, number]): string {
  return `PHASE A — OBSERVATION ONLY. Below is one opening region from the original photo, identified only by id and its approximate location (no other information — do not guess what type of feature it is; just look and describe).

${buildObservationOnlyItemList([{ id: "C1", type: "", description: "", bbox }])}

${buildObservationQuestionsInstruction("opening")}

"observations" schema — one entry per id above:
[${buildObservationSchemaText()}]`;
}

async function runOne(label: string, model: "grok" | "gemini", baselinePath: string, stagedPath: string, bbox: [number, number, number, number], runIdx: number) {
  process.env.STAGE2_VALIDATOR_MODEL = model;
  const raw = await runOcclusionObservationCall({
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt: buildPrompt(bbox),
    baselineImagePath: baselinePath,
    stagedImagePath: stagedPath,
    model: "gemini-2.5-pro",
    ctx: { jobId: `c1inv-${label}-${model}-r${runIdx}`, imageId: `c1inv-${label}-${model}-r${runIdx}`, callLabel: `c1inv_${label}` },
  });
  const obs = Array.isArray(raw?.observations) ? raw.observations[0] : raw?.observations;
  console.log(`\n=== [${label}][${model}] run ${runIdx} ===`);
  console.log(JSON.stringify(obs, null, 2));
  return obs;
}

async function main() {
  // Real bbox from a fresh extractStructuralBaseline call against
  // Bedroom 14.jpg (confirmed 2026-08-15): C1 = {"bbox":[0.9453,0.4509,1,1],
  // "description":"White bifold closet door, partially visible on the far
  // right wall.", "paneStructure":"unknown", "doorLeafState":"closed"}.
  // Fixed here (not re-extracted per condition) so every condition in this
  // investigation compares against the identical region definition.
  const realBaselineBbox: [number, number, number, number] = [0.9453, 0.4509, 1, 1];

  const mode = process.argv[2] || "A";
  const runs = Number(process.argv[3] || "1");

  if (mode === "A") {
    console.log("\n\n########## CONDITION A: REPRODUCE (full images, real bbox, Grok) ##########");
    const baseline = path.join(VDIR, "Bedroom 14.jpg");
    const staged = path.join(VDIR, "Bedroom 14 Testing - Staged Run 1.webp");
    for (let r = 1; r <= runs; r++) {
      await runOne("reproduce", "grok", baseline, staged, realBaselineBbox, r);
    }
  } else if (mode === "B") {
    console.log("\n\n########## CONDITION B: TIGHT CROP (pre-cropped PNG, bbox=[0,0,1,1], Grok) ##########");
    const baselineCrop = path.join(CDIR, "c1_baseline_crop.png");
    const stagedCrop = path.join(CDIR, "c1_run1_crop.png");
    for (let r = 1; r <= runs; r++) {
      await runOne("tightcrop", "grok", baselineCrop, stagedCrop, [0, 0, 1, 1], r);
    }
  } else if (mode === "C") {
    console.log("\n\n########## CONDITION C: FORMAT (full images, staged re-encoded PNG, real bbox, Grok) ##########");
    const baseline = path.join(CDIR, "baseline_full_reencoded.png");
    const staged = path.join(CDIR, "run1_full_reencoded.png");
    for (let r = 1; r <= runs; r++) {
      await runOne("format", "grok", baseline, staged, realBaselineBbox, r);
    }
  } else if (mode === "D") {
    console.log("\n\n########## CONDITION D: GEMINI (full images, real bbox, Gemini) ##########");
    const baseline = path.join(VDIR, "Bedroom 14.jpg");
    const staged = path.join(VDIR, "Bedroom 14 Testing - Staged Run 1.webp");
    for (let r = 1; r <= runs; r++) {
      await runOne("reproduce", "gemini", baseline, staged, realBaselineBbox, r);
    }
  }

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
