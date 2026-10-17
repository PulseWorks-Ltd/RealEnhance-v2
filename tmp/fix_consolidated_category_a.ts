// Fix: flooring-material alteration (Living 07 seam between carpet and
// linoleum/hard flooring was unified into one material in the previous
// -staged-v2 result). Adds one new, specific category-A clause — same
// pattern as every prior fix tonight (specific beats generic catch-all).
// Reuses saved zoning/wall-visibility/plan data from the previous run —
// no new extraction calls. Everything else (light-fixture clause,
// floating-sofa-facing-TV logic for Living 10) is carried over unchanged
// from tmp/fix_lightfixture_sofa_placement.ts.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

type Point = [number, number];
function polygonBBox(polygon: Point[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function denormPolygon(points: Point[], width: number, height: number): string {
  return points.map(([x, y]) => `${Math.round(x * width)},${Math.round(y * height)}`).join(" ");
}

// ── PART 1 (consolidated): same rule coverage as the previous run's
// category-A locks, rewritten for density per the prompt-bloat hypothesis
// test — see tmp/consolidated_category_a_before_after.md for the audit.
// Applied identically to worker/src/pipeline/anchorLockedStaging.ts. ──
const CATEGORY_A_LOCKS = `As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo, placing items within the unchanging physical structure of the room. You must still produce a high-quality, fully staged, listing-ready result — do not default to sparse or minimal staging; adapt placement, scale, and composition to fit the room instead. All added items must have realistic lighting, shadows, and perspective matching the room, and must be to-scale.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement and always overrides staging choices. You are explicitly and completely prohibited from making ANY changes — adding, removing, resizing, extending, re-coloring, relocating, or otherwise altering — the core structure, appearance, or built-in elements of the room, including:

Walls: location, dimensions, surface texture, or finish. Do not repaint, wallpaper, add, or remove walls.

Openings & views: the existence, size, or shape of any window, door, doorway, archway, or skylight, their frames/glass/hardware, or the view through them. Do not cover any opening. Keep the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor.

Floors & ceilings: floor material (e.g. hardwood, carpet, tile) and ceiling finish (paint, texture, tray ceilings). If two or more distinct flooring materials are visible in the original photo, each must stay exactly in its original location, boundary, and type — do not blend, unify, or extend one material over another, or smooth over a visible seam. Only place rugs and furniture on top of the existing floor.

Fixtures: HVAC vents, thermostats, switches, outlets, wall-mounted AC/split-system units, and other visible HVAC equipment; baseboards, crown molding, and railings; and any other fixed fixture, fitting, appliance, or built-in feature — do not remove, relocate, resize, alter, cover, or obstruct any of them, even if not individually named here.

Lighting: existing ceiling-mounted fixtures (flush-mount, semi-flush, pendant, or other) and ceiling-mounted safety devices (smoke/heat detectors) must be preserved exactly as-is. Do not add any new ceiling-mounted, wall-mounted, or hanging light fixture as staging decor (including pendant lights, chandeliers, hanging fixtures over tables, or wall sconces) — only movable/portable lighting (table lamps, floor lamps) may be added.

GEOMETRIC ENVELOPE LOCK — ZERO TOLERANCE:
The architectural envelope must remain visually and geometrically identical to the original photo, independent of camera movement. You must NOT:
* change wall positions, lengths, or angles
* alter corner locations
* modify ceiling height or plane geometry
* change window-to-wall ratio or door-to-wall ratio
* alter visible wall spacing
* adjust depth perspective or compression
* modify vanishing point alignment
Perspective lines, wall intersections, and opening proportions must align with the original image. Do NOT "improve" room proportions, straighten perspective, extend wall planes for symmetry, or reinterpret spatial depth in any way, even subtly or to make the room look larger — the camera may stay perfectly still while the room's geometry is redrawn, and that is equally prohibited.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing must remain exactly as in the original photo — do not zoom, crop, rotate, widen, narrow, or otherwise shift camera position or perspective. The final image must look like the same photo with furniture simply placed into the scene.`;

const CATEGORY_B_RULES = [
  { id: "kitchen_built_ins", clause: "Kitchen islands, cabinetry, and countertops.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => ["kitchen_island", "built_in_cabinet"].includes(f.type)) },
  { id: "fireplace", clause: "Fireplaces, mantels, and hearths.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "fireplace") },
  { id: "closets", clause: "Closets and their doors.", matches: (b: any) => b.openings.some((o: any) => o.type === "closet_door") },
  { id: "plumbing", clause: "Faucets, sinks, tubs, and showers.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "plumbing_fixture") },
  { id: "pendant_ceiling_lighting", clause: "Pendant lights, chandeliers, recessed lighting, or ceiling fans.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "light_fixture") },
];
function buildCategoryBSection(baseline: any): string {
  const included = CATEGORY_B_RULES.filter((r) => r.matches(baseline));
  return included.length > 0 ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, also do not alter, remove, or obstruct:\n${included.map((r) => `* ${r.clause}`).join("\n")}` : "";
}

// ── PART 2: floating-sofa-facing-TV logic (unchanged from previous fix). ──
function findLivingZoneEntryOpenings(baseline: any, livingWallIndices: number[]) {
  return baseline.openings.filter((o: any) => livingWallIndices.includes(o.wallIndex) && (o.type === "door" || o.type === "walkthrough"));
}

const CLEARANCE_RADIUS = 0.12;

function computeFloatingSofaPosition(livingZone: any, entryOpenings: any[]) {
  const zoneBBox = polygonBBox(livingZone.floorRegion.polygon);
  const zoneWidth = zoneBBox.maxX - zoneBBox.minX;
  const zoneDepth = zoneBBox.maxY - zoneBBox.minY;
  const zoneCenterX = zoneBBox.minX + zoneWidth / 2;

  let sofaX = zoneCenterX;
  let shiftReasoning = "No entry opening on the living zone's bordering walls — sofa centered horizontally within the zone.";
  if (entryOpenings.length > 0) {
    const entryXs = entryOpenings.map((o: any) => (o.bbox[0] + o.bbox[2]) / 2);
    const avgEntryX = entryXs.reduce((a: number, b: number) => a + b, 0) / entryXs.length;
    if (avgEntryX < zoneCenterX) {
      sofaX = zoneBBox.minX + zoneWidth * 0.68;
      shiftReasoning = `Entry opening(s) [${entryOpenings.map((o: any) => o.id).join(", ")}] average x=${avgEntryX.toFixed(3)}, left of zone center (${zoneCenterX.toFixed(3)}) — sofa shifted right, to x=${sofaX.toFixed(3)}, to stay clear of the direct path from the entry.`;
    } else {
      sofaX = zoneBBox.minX + zoneWidth * 0.32;
      shiftReasoning = `Entry opening(s) [${entryOpenings.map((o: any) => o.id).join(", ")}] average x=${avgEntryX.toFixed(3)}, right of zone center (${zoneCenterX.toFixed(3)}) — sofa shifted left, to x=${sofaX.toFixed(3)}, to stay clear of the direct path from the entry.`;
    }
  }
  const sofaY = zoneBBox.minY + zoneDepth * 0.6;

  return { x: sofaX, y: sofaY, shiftReasoning };
}

function checkClearance(sofaPos: { x: number; y: number }, entryOpenings: any[]) {
  for (const o of entryOpenings) {
    const entryX = (o.bbox[0] + o.bbox[2]) / 2;
    const dx = Math.abs(sofaPos.x - entryX);
    if (dx < CLEARANCE_RADIUS) {
      return { clear: false, reason: `Sofa x (${sofaPos.x.toFixed(3)}) is within the ${CLEARANCE_RADIUS} clearance radius of entry opening ${o.id}'s x-center (${entryX.toFixed(3)}), dx=${dx.toFixed(3)}.` };
    }
  }
  return { clear: true, reason: `Sofa clears all entry openings by >= ${CLEARANCE_RADIUS} (closest: ${Math.min(...entryOpenings.map((o: any) => Math.abs(sofaPos.x - (o.bbox[0] + o.bbox[2]) / 2))).toFixed(3)}).` };
}

function buildAnchorSection(plan: any, sofaInstructionOverride?: string): string {
  const livingLines: string[] = [];
  if (plan.tvPlan && sofaInstructionOverride) {
    livingLines.push(`* Place a TV and low TV console/unit against ${plan.tvPlan.wallId} (${plan.tvPlan.wallLabel}), within the segment described as "${plan.tvPlan.segmentDescription}".`);
    livingLines.push(`* ${sofaInstructionOverride}`);
  } else if (plan.sofaPlan) {
    const where = plan.sofaPlan.wallId ? `against ${plan.sofaPlan.wallId} (${plan.sofaPlan.wallLabel})` : `floor-centered within the living zone (no wall in this zone is suitable for large furniture)`;
    livingLines.push(`* Place a sofa ${where}. ${plan.sofaPlan.orientationInstruction || ""}`.trim());
  }
  const diningLines: string[] = [];
  if (plan.diningPlan) {
    diningLines.push(`* Place a dining table with seating for 4-6 chairs, freestanding within the dining zone, centered roughly at normalized position [${plan.diningPlan.center[0].toFixed(3)}, ${plan.diningPlan.center[1].toFixed(3)}] of the full photo. The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out.`);
  }
  return `ANCHOR ITEMS — LIVING ZONE (must be followed exactly)\n\n${livingLines.join("\n")}\n\nANCHOR ITEM — DINING ZONE (must be followed exactly)\n\n${diningLines.join("\n")}\n\nZONING CONTEXT: this is a single open-plan room combining two functional zones — a living/seating zone and a dining zone. Stage each zone according to its function as instructed above, so the two areas read as distinct, intentional zones within the same open room, not one undifferentiated furniture arrangement.`;
}

async function buildPrompt(baseline: any, plan: any, sofaInstructionOverride?: string): Promise<string> {
  return `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${buildCategoryBSection(baseline)}

${buildAnchorSection(plan, sofaInstructionOverride)}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a combined living/dining space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;
}

async function generateOne(imgName: string, baseline: any, prompt: string) {
  const imagePath = path.join(LIVING_DIR, imgName);
  console.log(`\n\n########## ${imgName} — PROMPT ##########\n${prompt}`);
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
  const outPath = path.join(LIVING_DIR, imgName.replace(/\.jpg$/i, "-staged-v4.webp"));
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== ${imgName} DONE (${durationMs}ms) === outPath=${outPath}`);
  return outPath;
}

async function main() {
  const fixData = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/fix_zoning_and_depth_check_1786621860530.json"), "utf8"));
  const living07Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 07_1786620838800.json"), "utf8"));
  const living10Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 10_1786620966268.json"), "utf8"));
  const living07Plan = fixData.find((r: any) => r.name === "Living 07.jpg").newPlan;
  const living10Plan = fixData.find((r: any) => r.name === "Living 10.jpg").newPlan;

  // ── Living 10: recompute floating sofa position (identical logic/inputs to the previous run) ──
  const livingWallIndices: number[] = living10Plan.livingZone.borderingWallIndices;
  const entryOpenings = findLivingZoneEntryOpenings(living10Raw.baseline, livingWallIndices);
  const sofaPos = computeFloatingSofaPosition(living10Plan.livingZone, entryOpenings);
  const clearance = checkClearance(sofaPos, entryOpenings);
  console.log("\n=== Living 10 clearance check (should match previous run) ===", JSON.stringify(clearance, null, 2));
  if (!clearance.clear) {
    console.error("!!! CLEARANCE CHECK FAILED — stopping short of generation for Living 10. !!!");
    return;
  }

  const sofaInstruction = `Place the sofa floating in the room (not against any wall), facing directly toward ${living10Plan.tvPlan.wallId} (the TV wall), positioned at approximately normalized coordinates [${sofaPos.x.toFixed(3)}, ${sofaPos.y.toFixed(3)}] of the full photo. This position is deliberately clear of the direct path from ${entryOpenings.map((o: any) => o.id).join("/")} into the room — do not place the sofa against a side or adjacent wall, and do not place it so it blocks the walking path from that opening into the rest of the room.`;

  const living07Prompt = await buildPrompt(living07Raw.baseline, living07Plan);
  const living10Prompt = await buildPrompt(living10Raw.baseline, living10Plan, sofaInstruction);

  await generateOne("Living 07.jpg", living07Raw.baseline, living07Prompt);
  await generateOne("Living 10.jpg", living10Raw.baseline, living10Prompt);

  console.log("\n\n=== ALL DONE ===");
}

main().catch((e) => {
  console.error("fix_consolidated_category_a failed:", e);
  process.exit(1);
});
