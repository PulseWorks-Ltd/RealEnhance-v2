// Corrected anchor-only prompt test. Rebuilds the minimal-prescription
// approach from tmp/test_anchor_only_staging.ts, but this time sourcing all
// general structural-lock language VERBATIM from STAGE2_PROMPT_NANO_BANANA
// (worker/src/pipeline/stage2.ts:755-812) — the real production prompt —
// instead of hand-writing a lockdown section from only the baseline's
// specific item IDs. The category-level "Openings: Do not alter the
// existence, size, or shape of any windows, doors, doorways, archways, or
// skylights" clause (absent from the previous attempt) is the specific fix
// for the fabricated-door failure — see tmp/stage2_nanobanana_prompt_audit.md
// for the full audit this rebuild is based on.
//
// Per that audit: zero category-B clauses apply to Bedroom 12 (no
// fireplace/kitchen island/built-in shelving/closets/bathroom fixtures in
// the baseline), so none are included. The one ambiguous (C-flagged) clause
// — "HVAC vents, thermostats, switches, or outlets" — is kept in, per its
// own A-list inclusion in the audit, as a conservative low-cost hedge for
// Bedroom 12's AC unit, whose coverage under that phrase is uncertain and
// explicitly flagged as something to watch for in this test's result, not
// assumed to be solved by including it.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const BASELINE_PATH = path.join(OUT_DIR, "Bedroom 12.jpg");

// ── Category-A clauses, verbatim from stage2.ts:755-812. B-only sub-bullets
// (kitchen islands, built-in shelves/entertainment centers, fireplaces,
// closets, faucets/sinks/tubs/showers, pendant/chandelier/recessed/fan)
// removed since none apply to Bedroom 12's baseline. Nothing else edited —
// no paraphrasing. ──
const CATEGORY_A_LOCKS = `As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room.

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

View: Do not change the existing view through windows or doors.

Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;

async function buildCorrectedPrompt(plan: any): Promise<string> {
  return `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}

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
  const plan = plans.run2; // same plan reused across every test tonight

  const prompt = await buildCorrectedPrompt(plan);
  console.log("=== CORRECTED ANCHOR-ONLY PROMPT (category-A locks restored, verbatim) ===\n");
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

  const outPath = path.join(OUT_DIR, "Bedroom 12-anchor-only-staged-v2.webp");
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);

  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify({ outPath, imageBytes: imgBuffer.length }, null, 2));
}

main().catch((e) => {
  console.error("test_anchor_only_staging_v2 failed:", e);
  process.exit(1);
});
