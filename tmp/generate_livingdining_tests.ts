// Part 2: first real generation tests for living/dining, all three images.
// Reuses CATEGORY_A_LOCKS verbatim from worker/src/pipeline/anchorLockedStaging.ts
// (copied, not imported, per "standalone tmp/ scripts" / "no production
// code changes" — this task only touches the prototype planning logic).
// One real Gemini generation call per image, no retries.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

// ── Verbatim from worker/src/pipeline/anchorLockedStaging.ts ──
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
Wall-mounted air conditioning units, split-system units, and any other visible HVAC equipment: do not remove, relocate, resize, or alter their appearance, and do not cover or obstruct them with furniture, artwork, or decor.
Ceiling-mounted light fixtures (including flush-mount, semi-flush, pendant, and any other ceiling-mounted lighting) and ceiling-mounted safety devices (smoke detectors, heat detectors): do not remove, relocate, resize, or alter their appearance.

View: Do not change the existing view through windows or doors.

Do not alter, remove, or add any other fixed fixture, fitting, appliance, or built-in feature visible in the original photo, even if not individually named above.

GEOMETRIC ENVELOPE LOCK — ZERO TOLERANCE:
The architectural envelope must remain visually and geometrically identical to the original photo. You must NOT:
* change wall positions, lengths, or angles
* alter corner locations
* modify ceiling height or plane geometry
* change window-to-wall ratio or door-to-wall ratio
* alter visible wall spacing
* adjust depth perspective or compression
* modify vanishing point alignment
Perspective lines, wall intersections, and opening proportions must align with the original image. Do NOT "improve" room proportions, straighten perspective, extend wall planes for compositional symmetry, or reinterpret spatial depth in any way — even subtly, even if it would make the room look larger or more spacious. This is a separate, additional requirement to the Camera & Perspective Constraint below, not covered by it: the camera may stay perfectly still while the room's geometry is redrawn, and that is equally prohibited.

Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.`;

const CATEGORY_B_RULES = [
  { id: "kitchen_built_ins", clause: "Kitchen islands, cabinetry, and countertops.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => ["kitchen_island", "built_in_cabinet"].includes(f.type)) },
  { id: "fireplace", clause: "Fireplaces, mantels, and hearths.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "fireplace") },
  { id: "closets", clause: "Closets and their doors.", matches: (b: any) => b.openings.some((o: any) => o.type === "closet_door") },
  { id: "plumbing", clause: "Faucets, sinks, tubs, and showers.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "plumbing_fixture") },
  { id: "pendant_ceiling_lighting", clause: "Pendant lights, chandeliers, recessed lighting, or ceiling fans.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "light_fixture") },
];

function buildCategoryBSection(baseline: any): string {
  const included = CATEGORY_B_RULES.filter((r) => r.matches(baseline));
  return included.length > 0
    ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, also do not alter, remove, or obstruct:\n${included.map((r) => `* ${r.clause}`).join("\n")}`
    : "";
}

function buildAnchorSection(imgName: string, plan: any): string {
  const livingLines: string[] = [];
  if (plan.tvPlan && plan.sofaPlan?.wallId) {
    livingLines.push(`* Place a TV and low TV console/unit against ${plan.tvPlan.wallId} (${plan.tvPlan.wallLabel}), within the segment described as "${plan.tvPlan.segmentDescription}".`);
    livingLines.push(`* Place a sofa against ${plan.sofaPlan.wallId} (${plan.sofaPlan.wallLabel}), oriented so it faces directly toward the TV on ${plan.tvPlan.wallId} — the sofa and TV must read as a coherent, intentionally facing pair, not two independently placed items.`);
  } else if (plan.sofaPlan) {
    const where = plan.sofaPlan.wallId ? `against ${plan.sofaPlan.wallId} (${plan.sofaPlan.wallLabel})` : `floor-centered within the living zone (no wall in this zone is suitable for large furniture)`;
    livingLines.push(`* Place a sofa ${where}. ${plan.sofaPlan.orientationInstruction || ""}`.trim());
  }
  const diningLines: string[] = [];
  if (plan.diningPlan) {
    diningLines.push(`* Place a dining table with seating for 4-6 chairs, freestanding within the dining zone, centered roughly at normalized position [${plan.diningPlan.center[0].toFixed(3)}, ${plan.diningPlan.center[1].toFixed(3)}] of the full photo. The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out.`);
  }

  return `ANCHOR ITEMS — LIVING ZONE (must be followed exactly)

${livingLines.join("\n")}

ANCHOR ITEM — DINING ZONE (must be followed exactly)

${diningLines.join("\n")}

ZONING CONTEXT: this is a single open-plan room combining two functional zones — a living/seating zone and a dining zone. Stage each zone according to its function as instructed above, so the two areas read as distinct, intentional zones within the same open room, not one undifferentiated furniture arrangement.`;
}

async function buildPrompt(baseline: any, plan: any, imgName: string): Promise<string> {
  return `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${buildCategoryBSection(baseline)}

${buildAnchorSection(imgName, plan)}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a combined living/dining space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;
}

async function generateOne(imgName: string, baseline: any, plan: any) {
  const imagePath = path.join(LIVING_DIR, imgName);
  const prompt = await buildPrompt(baseline, plan, imgName);
  console.log(`\n\n########## ${imgName} — PROMPT ##########\n`);
  console.log(prompt);

  const { data, mime } = toBase64(imagePath);
  const ai = getGeminiClient();
  console.log(`\n=== Sending real generation call (model=${MODEL}) ===`);
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
    console.error(`=== ${imgName}: NO IMAGE RETURNED ===`, parts.map((p: any) => Object.keys(p)));
    return null;
  }
  const outPath = path.join(LIVING_DIR, imgName.replace(/\.jpg$/i, "-staged.webp"));
  const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
  await sharp(imgBuffer).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== ${imgName} DONE (${durationMs}ms) === outPath=${outPath}`);
  return outPath;
}

async function main() {
  // Rental 03
  const rental03Baseline = {
    openings: [
      { id: "A1", type: "walkthrough", wallIndex: 0 }, { id: "W2", type: "window", wallIndex: 0 },
      { id: "W3", type: "window", wallIndex: 1 }, { id: "W1", type: "window", wallIndex: 3 },
    ],
    anchorFixtures: [
      { id: "F2", type: "light_fixture", wallIndex: 0 }, { id: "F3", type: "light_fixture", wallIndex: 0 },
      { id: "F1", type: "ac_unit", wallIndex: 3 },
    ],
  };
  const fixData = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/fix_zoning_and_depth_check_1786621860530.json"), "utf8"));
  const rental03Plan = fixData.find((r: any) => r.name === "Rental 03.jpg").newPlan;
  const living07Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 07_1786620838800.json"), "utf8"));
  const living07Plan = fixData.find((r: any) => r.name === "Living 07.jpg").newPlan;
  const living10Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 10_1786620966268.json"), "utf8"));
  const living10Plan = fixData.find((r: any) => r.name === "Living 10.jpg").newPlan;

  console.log("=== Plans being used ===");
  console.log("Rental 03:", JSON.stringify({ tv: rental03Plan.tvPlan?.wallId, sofa: rental03Plan.sofaPlan?.wallId, dining: !!rental03Plan.diningPlan }, null, 2));
  console.log("Living 07:", JSON.stringify({ tv: living07Plan.tvPlan?.wallId ?? null, sofa: living07Plan.sofaPlan, dining: !!living07Plan.diningPlan }, null, 2));
  console.log("Living 10:", JSON.stringify({ tv: living10Plan.tvPlan?.wallId, sofa: living10Plan.sofaPlan?.wallId, dining: !!living10Plan.diningPlan }, null, 2));

  await generateOne("Rental 03.jpg", rental03Baseline, rental03Plan);
  await generateOne("Living 07.jpg", living07Raw.baseline, living07Plan);
  await generateOne("Living 10.jpg", living10Raw.baseline, living10Plan);

  console.log("\n\n=== ALL THREE GENERATION CALLS DONE ===");
}

main().catch((e) => {
  console.error("generate_livingdining_tests failed:", e);
  process.exit(1);
});
