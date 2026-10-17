// Part 3 (this task): Bedroom 12 confirmation test with Part 1's new
// category-A clauses added, additively, to the category-A lock set proven
// in test_anchor_only_staging_v2.ts. Nothing removed/rewritten from v2 —
// three new lines added:
//   1. Explicit wall-mounted AC/split-system/HVAC clause (previously only
//      implicitly hedged via "HVAC vents, thermostats, switches, or
//      outlets", which a plain reading suggests doesn't naturally cover a
//      standalone wall-mounted split-system head unit — see report).
//   2. Explicit ceiling-mounted light fixture + smoke/heat detector clause
//      (previously only implicitly hedged via nothing at all — nano-banana
//      has no "recessed lighting"-style clause in the trimmed A-lock set
//      used here; and even the full nano-banana "recessed lighting" phrase
//      doesn't naturally cover a flush-mount fixture — see report).
//   3. A general, unconditional catch-all backstop clause, deliberately not
//      tied to any specific detected item, so any future/uncategorized
//      fixture type still has default protection.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");

const CATEGORY_A_LOCKS_V3 = `As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement.

You must preserve all architectural elements exactly:

* walls, ceilings, floors, doors, windows, openings, built-ins, and camera geometry.

If staging conflicts with structure:

* structure always takes priority,
* but you must still produce a high-quality, fully staged, listing-ready result.

Do not default to sparse or minimal staging.
Instead, adapt placement, scale, and composition to resolve conflicts.

All added items must be rendered with realistic lighting and shadows that match the room, and must be in the correct perspective for the photo. All items must be to-scale.

Strict Prohibitions (Negative Constraints):
You are explicitly and completely prohibited from making ANY changes, of any kind, to the core structure, appearance, or built-in elements of the room itself. You must not add, remove, resize, extend, re-color, or alter in ANY way, the following:

Walls: No changes to their location, dimension, surface texture, or existing finish. (Do not repaint or apply wallpaper, as that is not virtual staging). No adding or removing walls.

Openings: Do not alter the existence, size, or shape of any windows, doors, doorways, archways, or skylights. Do not paint or change frames, glass, or hardware. Do not cover them. This includes keeping the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor.

Floors & Ceilings: Do not alter the floor material (e.g., hardwood, carpet, tile) or the ceiling (e.g., paint, texture, tray ceilings). Only place rugs and furniture on top of the existing floor.

Fixtures & Features: Do not change, remove, or alter existing:
HVAC vents, thermostats, switches, or outlets.
Baseboards, crown molding, and railings.
Wall-mounted air conditioning units, split-system units, and any other visible HVAC equipment: do not remove, relocate, resize, or alter their appearance, and do not cover or obstruct them with furniture, artwork, or decor.
Ceiling-mounted light fixtures (including flush-mount, semi-flush, pendant, and any other ceiling-mounted lighting) and ceiling-mounted safety devices (smoke detectors, heat detectors): do not remove, relocate, resize, or alter their appearance.

View: Do not change the existing view through windows or doors.

Do not alter, remove, or add any other fixed fixture, fitting, appliance, or built-in feature visible in the original photo, even if not individually named above.

Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;

async function buildPrompt(plan: any): Promise<string> {
  return `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS_V3}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against the far-right wall of the room (${plan.reasoning.selectedWallId} in the room analysis, referred to as "${plan.anchorWall}") — this is the wall selected as the anchor wall by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;
}

async function main() {
  const planFiles = (await fs.readdir(path.join(REPO_ROOT, "tmp"))).filter((f) => f.startsWith("deterministic_plan_v3_"));
  const latest = planFiles.sort().at(-1)!;
  const plans = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp", latest), "utf8"));
  const plan = plans.run2;

  const prompt = await buildPrompt(plan);
  console.log("=== BEDROOM 12 PROMPT WITH NEW CATEGORY-A CLAUSES (Part 3) ===\n");
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

  const outPath = path.join(OUT_DIR, "Bedroom 12-anchor-only-staged-v3.webp");
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);

  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify({ outPath, imageBytes: imgBuffer.length }, null, 2));
}

main().catch((e) => {
  console.error("test_anchor_only_staging_v3 failed:", e);
  process.exit(1);
});
