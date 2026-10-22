// Standalone test of the category-substitution hypothesis: does revealing
// C1's real baseline type/description/paneStructure (the opposite of the
// hidden-type design) change Grok's hallucination on Bedroom 14 Run 1?
// Uses the REAL extracted values (confirmed via extractStructuralBaseline
// earlier this session against Bedroom 14.jpg), not an idealized "sliding
// pocket door" label:
//   {"id":"C1","type":"closet_door","bbox":[0.9453,0.4509,1,1],
//    "paneStructure":"unknown","doorLeafState":"closed",
//    "description":"White bifold closet door, partially visible on the far
//    right wall."}
// Note paneStructure came back "unknown", not "sliding_panel" — the
// baseline extractor itself doesn't confidently know the mechanism; its
// own free-text guess is "bifold," not "sliding/pocket." This test reveals
// exactly that, not a cleaned-up idealized version, per the task's
// explicit instruction.
//
// Standalone only — does NOT modify occlusionVsRemovalCheck.ts. Grok-only,
// same pre-cropped isolated C1 PNG established in the original
// investigation, same temperature-0 settings. Q1's isolated-hardware
// warning is the ORIGINAL (unreframed) text, to isolate "type revealed" as
// the only variable under test versus the 15/15 hidden-type baseline.
import path from "path";
import {
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

// Real extracted baseline data for C1, revealed directly in the item list —
// the opposite of buildObservationOnlyItemList's hidden-type design.
const REVEALED_ITEM_LINE = `- id: C1, region: x: 0.00–1.00, y: 0.00–1.00 (normalized fractions of image width/height, 0,0 = top-left) — KNOWN BASELINE TYPE: closet_door. Baseline description: "White bifold closet door, partially visible on the far right wall." Baseline door leaf state: closed. Baseline pane/mechanism structure: unknown (not confidently determined by prior analysis — could be hinged, bifold, or sliding).`;

// Same Q1-Q5 as production (ORIGINAL, unreframed warning — isolating
// "type revealed" as the only variable), with the Phase A framing line
// changed to reflect that type IS being revealed here.
function buildQuestionsInstruction(): string {
  return `For EACH opening region listed below, answer five questions by describing what you actually see — do not answer yes/no, and do not state a conclusion without describing the concrete visual evidence for it. Use the known baseline type/description above to inform what you should expect to see and how it might appear, but your answers must be based on what is actually visible in the CURRENT image, not assumed from the baseline description alone.

1. currentStateDescription — Look at the CURRENT (staged) image at this region. Describe literally what is visible there right now. If you can identify any part of the original item's own physical structure — a frame edge, glass, a door leaf, a track, a mounting bracket, a mirror surface, a sill, molding, trim, or similar — name specifically which part(s) you see and roughly where within the region. If you cannot find anything resembling such structure anywhere in or immediately around that region, state that plainly and describe what occupies the space instead. IMPORTANT: a single small piece of hardware alone — a doorknob, hinge, handle, or latch — with NO door leaf, panel, or frame around it is NOT evidence the door is present; a real door leaf/panel must actually be visible, not just its hardware. Hardware sitting on an otherwise flat, continuous wall with no panel or frame around it means the item has likely been removed or moved elsewhere — describe this plainly as an anomaly, not as "the door is visible."

2. currentSurfaceDescription — Independent of the above, describe what physically covers or occupies this exact region in the CURRENT image. Describe the actual material, surface, or object present (for example: "painted drywall, no seam or break visible," "a large framed painting hanging flush against a plain wall," "a wooden dresser with a mirror door track visible above and beside it," "a dining chair positioned in front of a glass pane"). Do not answer with a category label alone.

3. coverageExtentDescription — Compare the region's own boundary to whatever new furniture, decor, or object occupies it now. Does the new object's own visible edge stay entirely within the region, or does it extend past the region's boundary (name the direction — up/down/left/right — and roughly by how much)? If nothing new occupies the region at all, say so.

4. extentComparisonDescription — Independent of coverage by furniture, look at the item's OWN edges (its own frame/boundary, not anything placed in front of it) in the CURRENT image and compare them to the region given for it above. Does it occupy roughly the same footprint and shape as that region, or is the item itself visibly larger, smaller, taller, wider, more/less square, or shifted in position along the wall relative to that region? Describe concretely what you observe about its own size, shape, and position — do not just answer "changed" or "unchanged," and do not discuss furniture or obstruction here, only the item's own extent.

5. structuralEvidenceDescription — Independent of all of the above, look specifically for any physical evidence that a door, doorway, or opening mechanism exists at this exact location — a track (overhead or floor-mounted), a frame, a jamb, a reveal, a pocket edge, hinges, a threshold, or a sill. Given the baseline type is a closet door of uncertain (possibly sliding/bifold) mechanism, a CLOSED sliding or pocket door can look like a plain, uninterrupted section of wall at first glance, but the track/frame/jamb evidence is usually still there if you look for it specifically — a closed door is not the same as a missing opening. Describe concretely whatever such evidence you find, however subtle, and where; or state plainly that you looked carefully and found none.

${HUMAN_EYE_FRAMING}

Do this for EVERY region above BEFORE reading anything else in this prompt. Describe only what you currently observe there — the known baseline type is context for what to look for, not a conclusion to assume.`;
}

function buildPrompt(): string {
  return `PHASE A — OBSERVATION, WITH KNOWN BASELINE TYPE. Below is one opening region from the original photo, identified by id, its approximate location, AND its known baseline type/description (revealed here deliberately, unlike the standard hidden-type design — this is a standalone test of whether revealing type changes the result).

${REVEALED_ITEM_LINE}

${buildQuestionsInstruction()}

"observations" schema — one entry per id above:
[${buildObservationSchemaText()}]`;
}

async function runOne(runIdx: number) {
  process.env.STAGE2_VALIDATOR_MODEL = "grok";
  const baselineCrop = path.join(CDIR, "c1_baseline_crop.png");
  const stagedCrop = path.join(CDIR, "c1_run1_crop.png");
  const raw = await runOcclusionObservationCall({
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt: buildPrompt(),
    baselineImagePath: baselineCrop,
    stagedImagePath: stagedCrop,
    model: "gemini-2.5-pro",
    ctx: { jobId: `c1revealed-r${runIdx}`, imageId: `c1revealed-r${runIdx}`, callLabel: "c1revealed" },
  });
  const obs = Array.isArray(raw?.observations) ? raw.observations[0] : raw?.observations;
  console.log(`\n=== [revealed-type] run ${runIdx} ===`);
  console.log(JSON.stringify(obs, null, 2));
  return obs;
}

async function main() {
  const runs = Number(process.argv[2] || "6");
  console.log("\n\n########## REVEALED-TYPE TEST (C1, Bedroom 14 Run 1) ##########");
  for (let r = 1; r <= runs; r++) {
    await runOne(r);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
