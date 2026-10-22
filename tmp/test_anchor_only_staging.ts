// Architecture-shift test (not a wording tweak): minimal-prescription
// prompt. Every previous test tonight named specific secondary items (side
// tables, dressing table, chair) in specific spots — that hit a real
// ceiling (planner has no interior-design placement logic for WHERE a
// dressing table or chair belongs) and the last test showed that pushing
// harder on ONE instruction (framing) can cost compliance on another
// (orientation). This test narrows the prompt to exactly two hard
// requirements — structural preservation, and the anchor item's wall +
// orientation (reusing the planner's already-proven output, not
// regenerated) — and explicitly grants Gemini creative freedom for
// everything else, rather than leaving "everything else" ambiguous by
// omission.
//
// Reuses: baseline openings/fixtures (same KNOWN_BASELINE data as every
// prior test tonight), and plan.anchorWall / plan.anchorOrientationInstruction
// from the SAME run2 plan (tmp/deterministic_plan_v3_*.json) used in the
// last two tests — not regenerated. Framing/edge-cropping instructions are
// deliberately NOT carried over (out of scope per this test's design; the
// previous test found that mechanism unreliable and possibly harmful to
// other instructions in the same sentence block).
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

function describeOpeningLockdown(o: { id: string; type: string; wallIndex: number }): string {
  return `* ${o.type} (${o.id}), on wall_${o.wallIndex}: must remain exactly as it is — same position, same size, fully visible and unobstructed, not infilled, not sealed, not converted into a wall or a different type of opening.`;
}
function describeFixtureLockdown(f: { id: string; type: string; wallIndex: number }): string {
  return `* ${f.type} (${f.id}), on wall_${f.wallIndex}: must remain exactly as it is — visible, unobstructed, not removed, not relocated.`;
}

async function buildMinimalPrescriptionPrompt(plan: any): Promise<string> {
  const lockdownLines = [
    ...KNOWN_BASELINE.openings.map(describeOpeningLockdown),
    ...KNOWN_BASELINE.anchorFixtures.map(describeFixtureLockdown),
  ].join("\n");

  return `Virtual Staging Instructions for nano banana (or Pro)

As an advanced virtual staging AI, your role is to add realistic, correctly-scaled furniture and decor to the provided room photo. Structural preservation is the highest-priority, non-negotiable requirement. Beyond that and the one anchor-item placement below, use your own professional staging judgment.

A. STRUCTURAL PRESERVATION — NON-NEGOTIABLE, HIGHEST PRIORITY

${lockdownLines}
* No new item may be mounted on, attached to, or placed directly in front of/blocking any wall-mounted fixture or opening listed above.
* Walls, ceiling, floor, and all architectural lines and proportions must remain unchanged.

CAMERA & PERSPECTIVE CONSTRAINT:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.

CORE PRINCIPLE:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo.

B. ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against the far-right wall of the room (${plan.reasoning.selectedWallId} in the room analysis, referred to as "${plan.anchorWall}") — this is the wall selected as the anchor wall by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}

C. EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement in section B and the structural constraints in section A, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates section A. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;
}

async function main() {
  const planFiles = (await fs.readdir(path.join(REPO_ROOT, "tmp"))).filter((f) => f.startsWith("deterministic_plan_v3_"));
  const latest = planFiles.sort().at(-1)!;
  const plans = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp", latest), "utf8"));
  const plan = plans.run2; // same plan reused in the previous two tests tonight

  const prompt = await buildMinimalPrescriptionPrompt(plan);
  console.log("=== MINIMAL-PRESCRIPTION PROMPT ===\n");
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

  const outPath = path.join(OUT_DIR, "Bedroom 12-anchor-only-staged.webp");
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);

  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify({ outPath, imageBytes: imgBuffer.length }, null, 2));
}

main().catch((e) => {
  console.error("test_anchor_only_staging failed:", e);
  process.exit(1);
});
