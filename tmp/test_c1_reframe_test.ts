// Standalone test of a reframed isolated-hardware warning, per the
// hypothesis from the last investigation: Grok's 15/15 hallucinated
// responses on Bedroom 14 Run 1's C1 repeatedly construct explicit
// counter-arguments against the CURRENT warning's "not... NOT evidence"
// framing ("not merely isolated hardware," "not just hardware alone")
// rather than genuinely reconsidering what they see. This tests whether
// reframing the same instruction as a neutral, two-option checklist
// question changes that. Standalone only — does NOT modify
// occlusionVsRemovalCheck.ts. Grok-only, same pre-cropped isolated C1 PNG
// established in the prior investigation (already ruled out crop/
// resolution as a factor), same temperature-0 settings.
import path from "path";
import {
  buildObservationOnlyItemList,
  buildObservationSchemaText,
  runOcclusionObservationCall,
  HUMAN_EYE_FRAMING,
} from "../worker/src/validators/occlusionVsRemovalCheck";

const REPO_ROOT = path.resolve(__dirname, "..");
const CDIR = path.join(REPO_ROOT, "tmp/c1_investigate");

const SYSTEM_INSTRUCTION = `You are checking whether architectural openings (windows, doors, walkthroughs, closet doors) from a room's baseline photo are still genuinely present in a staged (furnished) version — as opposed to merely being partly hidden behind normal staging furniture, which is expected and acceptable.

You are given two photos: the ORIGINAL (baseline) and the STAGED (furnished) version.

${HUMAN_EYE_FRAMING}

You must output strict JSON only: {"observations": [...]}. No explanations outside the JSON. No markdown. No comments.`;

// Byte-identical to buildObservationQuestionsInstruction() in
// occlusionVsRemovalCheck.ts EXCEPT the single "IMPORTANT:..." sentence in
// question 1, which is replaced with the reframed version below. Q2-Q5,
// HUMAN_EYE_FRAMING, and the closing line are unchanged.
const ORIGINAL_WARNING = `IMPORTANT: a single small piece of hardware alone — a doorknob, hinge, handle, or latch — with NO door leaf, panel, or frame around it is NOT evidence the door is present; a real door leaf/panel must actually be visible, not just its hardware. Hardware sitting on an otherwise flat, continuous wall with no panel or frame around it means the item has likely been removed or moved elsewhere — describe this plainly as an anomaly, not as "the door is visible."`;

const REFRAMED_WARNING = `Separately, note which of these two situations you actually observe here: (a) hardware (a doorknob, hinge, handle, or latch) together with a visible door leaf, panel, or frame around it, or (b) hardware alone, sitting on an otherwise flat, continuous wall with no leaf, panel, or frame around it. If it is (b), describe that plainly as what you see — hardware alone on flat wall means the item has likely been removed or moved elsewhere; report it as that, not as "the door is visible."`;

function buildQuestionsInstruction(warningText: string): string {
  return `For EACH opening region listed below, answer five questions by describing what you actually see — do not answer yes/no, and do not state a conclusion without describing the concrete visual evidence for it.

1. currentStateDescription — Look at the CURRENT (staged) image at this region. Describe literally what is visible there right now. If you can identify any part of the original item's own physical structure — a frame edge, glass, a door leaf, a track, a mounting bracket, a mirror surface, a sill, molding, trim, or similar — name specifically which part(s) you see and roughly where within the region. If you cannot find anything resembling such structure anywhere in or immediately around that region, state that plainly and describe what occupies the space instead. ${warningText}

2. currentSurfaceDescription — Independent of the above, describe what physically covers or occupies this exact region in the CURRENT image. Describe the actual material, surface, or object present (for example: "painted drywall, no seam or break visible," "a large framed painting hanging flush against a plain wall," "a wooden dresser with a mirror door track visible above and beside it," "a dining chair positioned in front of a glass pane"). Do not answer with a category label alone.

3. coverageExtentDescription — Compare the region's own boundary to whatever new furniture, decor, or object occupies it now. Does the new object's own visible edge stay entirely within the region, or does it extend past the region's boundary (name the direction — up/down/left/right — and roughly by how much)? If nothing new occupies the region at all, say so.

4. extentComparisonDescription — Independent of coverage by furniture, look at the item's OWN edges (its own frame/boundary, not anything placed in front of it) in the CURRENT image and compare them to the region given for it above. Does it occupy roughly the same footprint and shape as that region, or is the item itself visibly larger, smaller, taller, wider, more/less square, or shifted in position along the wall relative to that region? Describe concretely what you observe about its own size, shape, and position — do not just answer "changed" or "unchanged," and do not discuss furniture or obstruction here, only the item's own extent.

5. structuralEvidenceDescription — Independent of all of the above, look specifically for any physical evidence that a door, doorway, or opening mechanism exists at this exact location — a track (overhead or floor-mounted), a frame, a jamb, a reveal, a pocket edge, hinges, a threshold, or a sill. This matters most for any region above flagged with a "SLIDING PANEL door" note: a CLOSED sliding or pocket door can look like a plain, uninterrupted section of wall at first glance (your answers to questions 1 and 2 above might genuinely and correctly say so), but the track/frame/jamb evidence is usually still there if you look for it specifically — a closed door is not the same as a missing opening, and this question exists to catch that difference. Describe concretely whatever such evidence you find, however subtle, and where; or state plainly that you looked carefully and found none.

${HUMAN_EYE_FRAMING}

Do this for EVERY region above BEFORE reading anything else in this prompt. You do not need to know what each region originally contained to answer these five questions — describe only what you currently observe there.`;
}

function buildPrompt(warningText: string): string {
  return `PHASE A — OBSERVATION ONLY. Below is one opening region from the original photo, identified only by id and its approximate location (no other information — do not guess what type of feature it is; just look and describe).

${buildObservationOnlyItemList([{ id: "C1", type: "", description: "", bbox: [0, 0, 1, 1] }])}

${buildQuestionsInstruction(warningText)}

"observations" schema — one entry per id above:
[${buildObservationSchemaText()}]`;
}

async function runOne(warningLabel: string, warningText: string, runIdx: number) {
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  const baselineCrop = path.join(CDIR, "c1_baseline_crop.png");
  const stagedCrop = path.join(CDIR, "c1_run1_crop.png");
  const raw = await runOcclusionObservationCall({
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt: buildPrompt(warningText),
    baselineImagePath: baselineCrop,
    stagedImagePath: stagedCrop,
    model: "gemini-2.5-pro",
    ctx: { jobId: `c1reframe-${warningLabel}-r${runIdx}`, imageId: `c1reframe-${warningLabel}-r${runIdx}`, callLabel: `c1reframe_${warningLabel}` },
  });
  const obs = Array.isArray(raw?.observations) ? raw.observations[0] : raw?.observations;
  console.log(`\n=== [${warningLabel}] run ${runIdx} ===`);
  console.log(JSON.stringify(obs, null, 2));
  return obs;
}

async function main() {
  const runs = Number(process.argv[2] || "5");
  console.log("\n\n########## REFRAMED WARNING TEST ##########");
  for (let r = 1; r <= runs; r++) {
    await runOne("reframed", REFRAMED_WARNING, r);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
