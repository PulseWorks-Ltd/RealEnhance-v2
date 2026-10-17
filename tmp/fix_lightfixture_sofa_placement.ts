// Three fixes from direct visual review of the first living/dining
// generation test:
//   1. Light-fixture fabrication (Living 07 + Living 10): new category-A
//      clause, same "specific beats generic catch-all" pattern as the
//      earlier door-fabrication fix.
//   2+3. Sofa wall-backed placement + circulation-path obstruction
//      (Living 10): new floating-sofa-facing-TV logic, only engaged when a
//      TV is present (the zone-exclusive-wall case). Living 07 has no TV,
//      so its existing sofa fallback logic is untouched.
// Reuses saved zoning/wall-visibility data — no new extraction calls.
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

// ── PART 1: category-A locks, with the new light-fixture-fabrication
// clause added to the existing Fixtures & Features section (same status —
// general, unconditional, room-type-independent — as the AC-unit/ceiling-
// fixture clauses added earlier tonight). ──
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

Do not add any new ceiling-mounted, wall-mounted, or hanging light fixtures as staging decor — this includes pendant lights, chandeliers, hanging fixtures over tables, and wall sconces. Only movable/portable lighting (table lamps, floor lamps) may be added. Existing ceiling-mounted fixtures already present in the original photo must be preserved exactly as-is per the fixtures rule above, but no new fixed lighting of any kind may be introduced.

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
  return included.length > 0 ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, also do not alter, remove, or obstruct:\n${included.map((r) => `* ${r.clause}`).join("\n")}` : "";
}

// ── PART 2: floating-sofa-facing-TV logic. Only used when a TV is placed.
// "Circulation path" = the direct line from any door/walkthrough opening
// bordering the living zone into the room. Grounded entirely in existing
// baseline (opening bboxes/wallIndex) and zoning (floorRegion polygon)
// data — no new extraction. ──
function findLivingZoneEntryOpenings(baseline: any, livingWallIndices: number[]) {
  return baseline.openings.filter((o: any) => livingWallIndices.includes(o.wallIndex) && (o.type === "door" || o.type === "walkthrough"));
}

const CLEARANCE_RADIUS = 0.12; // normalized frame-x distance a floating sofa must keep from an entry opening's x-center

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
  // Set back from the TV wall (zone's minY, the "far" edge nearest the TV
  // wall) by ~60% of zone depth — leaves TV-viewing distance in front, and
  // walking space behind the sofa toward the entry/dining side.
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

async function renderClearanceOverlay(imagePath: string, outPath: string, livingZone: any, diningZone: any, entryOpenings: any[], sofaPos: any, tvWall: any) {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width!, height = meta.height!;
  const svgParts: string[] = [];
  for (const [z, color] of [[livingZone, "rgba(0,120,255,0.2)"], [diningZone, "rgba(255,140,0,0.2)"]] as any[]) {
    if (!z?.floorRegion?.polygon) continue;
    svgParts.push(`<polygon points="${denormPolygon(z.floorRegion.polygon, width, height)}" fill="${color}" stroke="black" stroke-width="3" stroke-dasharray="8,5"/>`);
  }
  for (const o of entryOpenings) {
    const [x1, y1, x2, y2] = o.bbox;
    svgParts.push(`<rect x="${x1 * width}" y="${y1 * height}" width="${(x2 - x1) * width}" height="${(y2 - y1) * height}" fill="none" stroke="red" stroke-width="5"/>`);
    const entryX = (x1 + x2) / 2;
    svgParts.push(`<line x1="${entryX * width}" y1="${y2 * height}" x2="${entryX * width}" y2="${height}" stroke="red" stroke-width="4" stroke-dasharray="10,6"/>`);
    svgParts.push(`<text x="${entryX * width}" y="${y1 * height - 10}" font-size="24" font-weight="bold" fill="red" text-anchor="middle">${o.id} entry path</text>`);
  }
  if (tvWall) {
    const bbox = polygonBBox(tvWall.extent.polygon);
    svgParts.push(`<rect x="${bbox.minX * width}" y="${bbox.minY * height}" width="${(bbox.maxX - bbox.minX) * width}" height="${(bbox.maxY - bbox.minY) * height}" fill="none" stroke="lime" stroke-width="4"/>`);
    svgParts.push(`<text x="${((bbox.minX + bbox.maxX) / 2) * width}" y="${bbox.minY * height - 10}" font-size="22" font-weight="bold" fill="lime" text-anchor="middle">TV WALL</text>`);
  }
  const sofaHalfW = 0.09, sofaHalfH = 0.06;
  svgParts.push(`<rect x="${(sofaPos.x - sofaHalfW) * width}" y="${(sofaPos.y - sofaHalfH) * height}" width="${sofaHalfW * 2 * width}" height="${sofaHalfH * 2 * height}" fill="rgba(80,40,150,0.7)" stroke="yellow" stroke-width="4"/>`);
  svgParts.push(`<text x="${sofaPos.x * width}" y="${sofaPos.y * height}" font-size="22" font-weight="bold" fill="white" text-anchor="middle">SOFA (floating)</text>`);
  const overlayLayer = await sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`)).png().toBuffer();
  const overlayBuffer = await sharp(imagePath).composite([{ input: overlayLayer, blend: "over" }]).png().toBuffer();
  await sharp(overlayBuffer).toFile(outPath);
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
  const outPath = path.join(LIVING_DIR, imgName.replace(/\.jpg$/i, "-staged-v2.webp"));
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
  const living10Zoning = fixData.find((r: any) => r.name === "Living 10.jpg").newZoning;

  // ── Living 10: compute floating sofa position (Part 2) ──
  const livingWallIndices: number[] = living10Plan.livingZone.borderingWallIndices;
  const entryOpenings = findLivingZoneEntryOpenings(living10Raw.baseline, livingWallIndices);
  console.log("\n=== Living 10 entry openings into living zone ===", JSON.stringify(entryOpenings.map((o: any) => ({ id: o.id, type: o.type, wallIndex: o.wallIndex, bbox: o.bbox })), null, 2));

  const sofaPos = computeFloatingSofaPosition(living10Plan.livingZone, entryOpenings);
  console.log("\n=== Computed floating sofa position ===", JSON.stringify(sofaPos, null, 2));

  const clearance = checkClearance(sofaPos, entryOpenings);
  console.log("\n=== Clearance check ===", JSON.stringify(clearance, null, 2));
  if (!clearance.clear) {
    console.error("!!! CLEARANCE CHECK FAILED — would need to adjust before generating. Stopping short of generation for Living 10 review. !!!");
  }

  const living10Walls = living10Raw.wallVis.walls;
  const tvWallObj = living10Walls.find((w: any) => w.id === living10Plan.tvPlan.wallId);

  const overlayPath = path.join(LIVING_DIR, "Living 10-sofa-clearance-overlay.png");
  await renderClearanceOverlay(path.join(LIVING_DIR, "Living 10.jpg"), overlayPath, living10Plan.livingZone, living10Plan.diningZone, entryOpenings, sofaPos, tvWallObj);
  console.log("clearance overlay saved:", overlayPath);

  const sofaInstruction = `Place the sofa floating in the room (not against any wall), facing directly toward ${living10Plan.tvPlan.wallId} (the TV wall), positioned at approximately normalized coordinates [${sofaPos.x.toFixed(3)}, ${sofaPos.y.toFixed(3)}] of the full photo. This position is deliberately clear of the direct path from ${entryOpenings.map((o: any) => o.id).join("/")} into the room — do not place the sofa against a side or adjacent wall, and do not place it so it blocks the walking path from that opening into the rest of the room.`;
  console.log("\n=== New sofa instruction ===\n", sofaInstruction);

  if (!clearance.clear) {
    console.error("Stopping before generation — clearance check did not pass.");
    return;
  }

  // ── Part 3: build prompts and generate ──
  const living07Prompt = await buildPrompt(living07Raw.baseline, living07Plan); // no TV -> existing sofa logic, unchanged
  const living10Prompt = await buildPrompt(living10Raw.baseline, living10Plan, sofaInstruction);

  await generateOne("Living 07.jpg", living07Raw.baseline, living07Prompt);
  await generateOne("Living 10.jpg", living10Raw.baseline, living10Prompt);

  console.log("\n\n=== ALL DONE ===");
}

main().catch((e) => {
  console.error("fix_lightfixture_sofa_placement failed:", e);
  process.exit(1);
});
