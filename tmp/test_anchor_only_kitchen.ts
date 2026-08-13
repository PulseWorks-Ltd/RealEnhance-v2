// Part 2 (validation task): anchor-only prompt test on a room with real
// category-B content (kitchen island + built-in cabinet, both confirmed by
// the REAL extractStructuralBaseline() call this task). Same method as the
// corrected Bedroom 12 test: category-A locks verbatim from
// STAGE2_PROMPT_NANO_BANANA, plus ONLY the category-B sub-bullets whose
// item type the baseline actually detected, plus the planner's anchor
// instruction (reused verbatim, not hand-edited — including a real bug it
// surfaced, see below), plus the freedom clause.
//
// Two things flagged BEFORE sending, not discovered after:
// 1. Orientation bug: the planner's determineOrientation() picked W1 (the
//    window) as the sofa's focal feature, but W1 is on wall_1 — the SAME
//    wall selected for the sofa itself. The function's own fallback logic
//    correctly detected there was no off-wall focal opening and used W1
//    anyway (self-flagged as "lower-confidence fallback" in its reasoning),
//    but the resulting anchorOrientationInstruction text doesn't convey
//    that — it reads as a confident "face the window" instruction despite
//    being physically incoherent (can't face a window directly behind you).
//    Per this task's instructions ("reuse the existing planner output — no
//    need to regenerate"), this is used AS-IS, bug included, to see how
//    Gemini actually handles it.
// 2. This image already contains a real, pre-existing leather sofa (kept
//    through Stage 1B decluttering as the preserved anchor piece, per the
//    PARTIAL ANCHOR PRESERVATION rule audited earlier tonight) — it is not
//    an empty baseline. Instructing Gemini to "place a sofa" here is a
//    mismatch with this specific image's actual state. Proceeding anyway
//    since Part 2's primary purpose is testing category-B conditional
//    inclusion, not anchor-item placement from scratch — but flagging this
//    up front rather than treating a strange anchor-related outcome as a
//    surprise finding.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "Test Images/Kitchen");
const IMAGE_PATH = path.join(OUT_DIR, "Karaka - Image 02 Decluttered.jpg");

// Category-A locks, verbatim from stage2.ts:755-812 (identical to the
// corrected Bedroom 12 prompt's A-lock block). Only the Built-Ins section
// differs this time: "Kitchen islands, cabinetry, and countertops." is
// INCLUDED (F1 kitchen_island + F2 built_in_cabinet both baseline-detected)
// while the other 3 Built-Ins sub-bullets remain excluded (not detected).
// "Faucets, sinks..." and "Pendant lights, chandeliers..." are EXCLUDED
// too, despite a sink/tap and 3 pendant lights being visibly present in
// the photo — the real extractStructuralBaseline() schema (StructuralOpeningType /
// AnchorFixtureType) has no category for plumbing fixtures or ceiling/pendant
// lighting, so nothing detects them for conditional inclusion. Flagged as a
// real, generalizable limitation of the conditional-inclusion mechanism —
// see report.
const CATEGORY_A_LOCKS_WITH_KITCHEN_B = `As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room.

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

Built-Ins: Do not change any permanent built-in features, including but not limited to:
Kitchen islands, cabinetry, and countertops.

Fixtures & Features: Do not change, remove, or alter existing:
HVAC vents, thermostats, switches, or outlets.
Baseboards, crown molding, and railings.

View: Do not change the existing view through windows or doors.

Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;

async function buildPrompt(plan: any): Promise<string> {
  return `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS_WITH_KITCHEN_B}

ANCHOR ITEM — SOFA (must be followed exactly)

* Place the sofa against ${plan.anchorWallId} in the room analysis, referred to as "${plan.anchorWall}" — this is the wall selected as the anchor wall by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the sofa placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for this space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;
}

async function main() {
  const planFiles = (await fs.readdir(path.join(REPO_ROOT, "tmp"))).filter((f) => f.startsWith("kitchen_wallvis_and_plan_"));
  const latest = planFiles.sort().at(-1)!;
  const data = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp", latest), "utf8"));
  const plan = data.plan;

  const prompt = await buildPrompt(plan);
  console.log("=== KITCHEN/LIVING ANCHOR-ONLY PROMPT (category-A locks + conditional B) ===\n");
  console.log(prompt);
  console.log("\n=== END PROMPT ===\n");

  const { data: imgData, mime } = toBase64(IMAGE_PATH);
  const ai = getGeminiClient();

  console.log(`=== Sending single real generation call (model=${MODEL}) ===`);
  const startedAt = Date.now();
  const response: any = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: imgData } }] }],
    generationConfig: { temperature: 0.4, topP: 0.9, topK: 40 },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p: any) => p?.inlineData?.data);
  if (!imgPart) {
    console.error("=== NO IMAGE RETURNED ===", parts.map((p: any) => Object.keys(p)));
    process.exit(1);
  }

  const outPath = path.join(OUT_DIR, "Karaka 02-anchor-only-staged.webp");
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);

  console.log(`=== DONE (${durationMs}ms) ===`);
  console.log(JSON.stringify({ outPath, imageBytes: imgBuffer.length }, null, 2));
}

main().catch((e) => {
  console.error("test_anchor_only_kitchen failed:", e);
  process.exit(1);
});
