// PART 3 (standalone, real Gemini call): builds the trimmed Stage 2 prompt
// ENTIRELY from the extended planner's own output (tmp/build_deterministic_layout_plan_v3.ts,
// run2 wall data — see selection rationale below) — no hand-authored
// placement text this time. Only the generic "keep" scaffolding (structural
// priority rule, camera constraint) is reused verbatim from the prompt
// structure proven in tonight's hand-authored v2 test; every room-specific
// sentence (structural feature call-outs, the staging plan itself,
// orientation, framing) is generated from the plan JSON / baseline data,
// not written by hand.
//
// Wall-data choice: the planner was run against BOTH repeat runs of tonight's
// corrected wall-visibility extraction. run1's wall data causes the
// (previously flagged, deliberately unfixed) wall-selection sizing bug to
// produce a physically absurd anchorRegion (a 0.2%-of-frame-width sliver —
// see report). run2's wall data does not trigger that bug (the selected
// wall is a real ~25%-of-frame-width segment) and is also the run that
// independently matched the user's own visual read of the room. run2 is
// used for this real generation call; run1's plan is reported for
// completeness but not sent.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");

const KNOWN_BASELINE = {
  openings: [
    { id: "A1", type: "walkthrough", wallIndex: 0 },
    { id: "D1", type: "door", wallIndex: 3 },
  ],
  anchorFixtures: [{ id: "AC1", type: "ac_unit", wallIndex: 3 }],
};

function describeOpeningForPrompt(o: { id: string; type: string; wallIndex: number }): string {
  const functionalNote =
    o.type === "walkthrough"
      ? "must remain fully visible, unobstructed, and functional as a walkway. Do not place any furniture in or across this opening."
      : "must remain fully visible, unobstructed, and functional. Do not cover it with furniture, curtains, or decor. Do not change its size, position, or the view through it.";
  return `* ${o.type} (${o.id}), on wall_${o.wallIndex}: ${functionalNote}`;
}

function describeFixtureForPrompt(f: { id: string; type: string; wallIndex: number }): string {
  return `* ${f.type} (${f.id}), on wall_${f.wallIndex}: must remain visible and unobstructed. Furniture may be placed beneath it but must not cover or obscure it.`;
}

async function buildPromptFromPlan(plan: any): Promise<string> {
  const structuralFeatureLines = [
    ...KNOWN_BASELINE.openings.map(describeOpeningForPrompt),
    ...KNOWN_BASELINE.anchorFixtures.map(describeFixtureForPrompt),
  ].join("\n");

  const planLines = plan.layout.map((item: { item: string; placement: string }) => `* ${item.item}: ${item.placement}`).join("\n");

  return `Virtual Staging Instructions for nano banana (or Pro)

As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as a decorator, placing items within the unchanging physical structure of the room.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement.

You must preserve all architectural elements exactly: walls, ceilings, floors, doors, windows, openings, and camera geometry.

If staging conflicts with structure:
* structure always takes priority,
* but you must still produce a high-quality, fully staged, listing-ready result.

Do not default to sparse or minimal staging. Instead, adapt placement, scale, and composition to resolve conflicts.

THIS ROOM'S SPECIFIC STRUCTURAL FEATURES — DO NOT ALTER OR OBSTRUCT:

${structuralFeatureLines}

EXPLICIT STAGING PLAN FOR THIS ROOM — place furniture exactly as follows:

${planLines}

All added items must be rendered with realistic lighting and shadows that match the room, in correct perspective for the photo, and to-scale.

CORE PRINCIPLE:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework, following the explicit plan above. Do not extend, expand, contract, or warp any space or element of the original photo.

CAMERA & PERSPECTIVE CONSTRAINT:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;
}

async function main() {
  const repoRoot = REPO_ROOT;
  const planFiles = (await fs.readdir(path.join(repoRoot, "tmp"))).filter((f) => f.startsWith("deterministic_plan_v3_"));
  const latest = planFiles.sort().at(-1)!;
  const plans = JSON.parse(await fs.readFile(path.join(repoRoot, "tmp", latest), "utf8"));
  const plan = plans.run2; // see file header for why run2, not run1, is used

  const prompt = await buildPromptFromPlan(plan);
  console.log("=== PLANNER-DRIVEN PROMPT (Part 3, built entirely from plan JSON) ===\n");
  console.log(prompt);
  console.log("\n=== END PROMPT ===\n");

  const { data, mime } = toBase64(BASELINE_PATH);
  const ai = getGeminiClient();

  console.log(`=== Sending single real generation call (model=${MODEL}) ===`);
  const startedAt = Date.now();
  const response: any = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data } }] }],
    generationConfig: { temperature: 0.4, topP: 0.9, topK: 40 },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p: any) => p?.inlineData?.data);
  if (!imgPart) {
    console.error("=== NO IMAGE RETURNED ===", parts.map((p: any) => Object.keys(p)));
    process.exit(1);
  }

  const outPath = path.join(OUT_DIR, "Bedroom 12-planner-guided-staged.webp");
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);

  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify({ outPath, imageBytes: imgBuffer.length }, null, 2));
}

main().catch((e) => {
  console.error("test_planner_guided_staging failed:", e);
  process.exit(1);
});
