// Regression test: universal feature-protection mechanism on the three
// previously-validated images (Bedroom 12, Living 07, Living 10).
// Diningroom 01 was the only real end-to-end confirmation so far.
//
// Call budget note (deviates from the task's stated 5, reported honestly):
// Bedroom 12's fresh baseline (with real `description` fields) was
// recovered LOSSLESSLY from the previous task's log output (the process
// had genuinely finished — see the Redis-handle hang finding — so no
// re-extraction was needed for baseline). Its wall-visibility data was
// never persisted to disk in that run, so it requires one fresh real call
// here — this is unavoidable, unrelated-to-the-fix supporting data, not a
// retest of anything already validated. Total: 1 (Bedroom 12 walls) + 2
// (Living 07/10 fresh baselines) + 3 (generation) = 6 real calls.
//
// Anchor PLACEMENT logic (bed wall selection; sofa/dining/TV geometry for
// the living/dining pair) is held exactly constant, reusing already-
// validated saved plan data — only the protected-features mechanism is
// the variable under test here, same as every isolated test tonight.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import {
  CATEGORY_A_LOCKS,
  buildUniversalFeatureProtectionSection,
  planBedroomAnchor,
  type WallVisibilityWall,
} from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const WALL_VISIBILITY_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

type Point = [number, number];
function polygonBBox(polygon: Point[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const WALL_VISIBILITY_SYSTEM_INSTRUCTION = `You are a structural feature extraction engine, extending an existing analysis with wall-level visibility data.

You are given a room photograph AND an existing structural baseline (openings and fixtures already
detected, with stable IDs).

CRITICAL FIRST STEP — before describing any walls, first explicitly determine: how many distinct flat
wall planes are actually visible in this photograph? A new wall plane is indicated by a genuine visible
boundary — a corner where two surfaces meet at an angle, a change in the ceiling cornice line's slope, a
change in the skirting/baseboard line's direction, or a shadow/seam line — NOT merely by whether two
wall segments look similar in color or texture (most interior walls in a room are painted the same
color, so similarity in appearance is not evidence they are the same wall).

For each distinct wall you identify:
- Assign a wall id using the SAME 0-indexed wallIndex convention already used in the baseline
  (wall_0, wall_1, wall_2, wall_3).
- Give the wall's total visible extent as a polygon (perspective-skewed quadrilateral, following the
  actual visible floor-to-ceiling boundary of that wall).
- List which of the GIVEN opening/fixture IDs (from the baseline below) fall on this wall, if any.
- Estimate usableWidthFraction: the fraction (0-1) of this wall's total width that is clear, usable
  wall space once the openings/fixtures on it are subtracted.
- Describe usableSegments as horizontal fraction ranges [start, end] along that wall, each with a
  short plain description.
- Give a confidence value (0-1) for this wall's existence as a distinct wall.

You must output strict JSON only. No explanations. No markdown. No comments. No extra text.`;

function buildWallVisibilityUserPrompt(baseline: any): string {
  return `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

First, internally determine how many distinct walls are visible. Then analyze this room photograph
and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "wallCount": number,
  "wallCountReasoning": string,
  "walls": [
    { "id": "wall_0" | "wall_1" | "wall_2" | "wall_3", "wallLabel": string, "extent": { "polygon": [[x,y], [x,y], ...] }, "openingIds": string[], "usableWidthFraction": number, "usableSegments": [{ "range": [start, end], "widthFraction": number, "description": string }], "confidence": number }
  ]
}`;
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function extractWallVisibility(imagePath: string, baseline: any): Promise<WallVisibilityWall[]> {
  const image = toBase64(imagePath);
  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: WALL_VISIBILITY_MODEL,
    contents: [{ role: "user", parts: [{ text: WALL_VISIBILITY_SYSTEM_INSTRUCTION }, { text: buildWallVisibilityUserPrompt(baseline) }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("NO TEXT RETURNED (wall visibility)");
  return extractJsonFromModelText(textPart.text).walls;
}

async function generateOne(imagePath: string, prompt: string, outPath: string) {
  const { data, mime } = toBase64(imagePath);
  const ai = getGeminiClient();
  console.log(`\n=== Sending real generation call (model=${MODEL}) === imagePath=${imagePath}`);
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
    return null;
  }
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== DONE (${durationMs}ms) === outPath=${outPath}`);
  return outPath;
}

// ── Living/dining anchor-section logic, exact copy of the last validated
// version (tmp/test_flooring_zone_material_fix.ts) — anchor PLACEMENT is
// not under test here, only the protected-features mechanism is. ──
const FLOOR_MATERIAL_KEYWORDS = /\b(floor|flooring|carpet|linoleum|hardwood|tile|material|surface)\b/i;
function materialPreservationNote(zone: any, otherZoneLabel: string): string {
  if (!zone?.reasoning || !FLOOR_MATERIAL_KEYWORDS.test(zone.reasoning)) return "";
  return ` This zone's own boundary was identified by a real flooring-material distinction from the ${otherZoneLabel} zone — preserve this zone's exact flooring material and the visible boundary between the two zones precisely as shown in the original photo; do not extend the ${otherZoneLabel} zone's floor material into this zone, and do not blend or unify the two into one continuous surface.`;
}
function buildLivingDiningAnchorSection(plan: any, sofaInstructionOverride?: string): string {
  const livingLines: string[] = [];
  if (plan.tvPlan && sofaInstructionOverride) {
    livingLines.push(`* Place a TV and low TV console/unit against ${plan.tvPlan.wallId} (${plan.tvPlan.wallLabel}), within the segment described as "${plan.tvPlan.segmentDescription}".`);
    livingLines.push(`* ${sofaInstructionOverride}`);
  } else if (plan.sofaPlan) {
    const where = plan.sofaPlan.wallId ? `against ${plan.sofaPlan.wallId} (${plan.sofaPlan.wallLabel})` : `floor-centered within the living zone (no wall in this zone is suitable for large furniture)`;
    const livingNote = materialPreservationNote(plan.livingZone, "dining");
    livingLines.push(`* Place a sofa ${where}. ${plan.sofaPlan.orientationInstruction || ""}${livingNote}`.trim());
  }
  const diningLines: string[] = [];
  if (plan.diningPlan) {
    const diningNote = materialPreservationNote(plan.diningZone, "living");
    diningLines.push(`* Place a dining table with seating for 4-6 chairs, freestanding within the dining zone, centered roughly at normalized position [${plan.diningPlan.center[0].toFixed(3)}, ${plan.diningPlan.center[1].toFixed(3)}] of the full photo.${diningNote} The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out.`);
  }
  return `ANCHOR ITEMS — LIVING ZONE (must be followed exactly)\n\n${livingLines.join("\n")}\n\nANCHOR ITEM — DINING ZONE (must be followed exactly)\n\n${diningLines.join("\n")}\n\nZONING CONTEXT: this is a single open-plan room combining two functional zones — a living/seating zone and a dining zone. Stage each zone according to its function as instructed above, so the two areas read as distinct, intentional zones within the same open room, not one undifferentiated furniture arrangement.`;
}
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
  if (entryOpenings.length > 0) {
    const entryXs = entryOpenings.map((o: any) => (o.bbox[0] + o.bbox[2]) / 2);
    const avgEntryX = entryXs.reduce((a: number, b: number) => a + b, 0) / entryXs.length;
    sofaX = avgEntryX < zoneCenterX ? zoneBBox.minX + zoneWidth * 0.68 : zoneBBox.minX + zoneWidth * 0.32;
  }
  const sofaY = zoneBBox.minY + zoneDepth * 0.6;
  return { x: sofaX, y: sofaY };
}
function checkClearance(sofaPos: { x: number; y: number }, entryOpenings: any[]) {
  for (const o of entryOpenings) {
    const entryX = (o.bbox[0] + o.bbox[2]) / 2;
    if (Math.abs(sofaPos.x - entryX) < CLEARANCE_RADIUS) return false;
  }
  return true;
}

async function main() {
  // ══════════════════════ BEDROOM 12 ══════════════════════
  console.log("\n\n########## BEDROOM 12 ##########");
  const bedroom12Baseline = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/bedroom12_baseline_withdesc.json"), "utf8"));
  console.log("Recovered fresh Bedroom 12 baseline (no re-call) — description fields:");
  for (const o of bedroom12Baseline.openings) console.log(`  ${o.id} (${o.type}): ${JSON.stringify(o.description)}`);
  for (const f of bedroom12Baseline.anchorFixtures || []) console.log(`  ${f.id} (${f.type}): ${JSON.stringify(f.description)}`);

  const bedroom12Path = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const bedroom12Walls = await extractWallVisibility(bedroom12Path, bedroom12Baseline);
  console.log("\nBedroom 12 walls:", JSON.stringify(bedroom12Walls.map((w) => ({ id: w.id, label: w.wallLabel })), null, 2));

  const bedroom12Plan = planBedroomAnchor(bedroom12Baseline, bedroom12Walls);
  if (!bedroom12Plan) throw new Error("Bedroom 12: no anchor plan produced");
  console.log("\nBedroom 12 anchor plan:", JSON.stringify(bedroom12Plan, null, 2));

  const { section: b12Section, itemCount: b12Count } = buildUniversalFeatureProtectionSection(bedroom12Baseline, bedroom12Walls);
  console.log(`\nBedroom 12: ${b12Count} protected-feature sentences`);

  const b12FramingLine = bedroom12Plan.anchorFramingNote ? ` ${bedroom12Plan.anchorFramingNote}` : "";
  const b12NoDecorLine = bedroom12Plan.noDecorAboveBedNote ? `\n* ${bedroom12Plan.noDecorAboveBedNote}` : "";
  const bedroom12Prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${b12Section}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against ${bedroom12Plan.anchorWallId} in the room analysis, referred to as "${bedroom12Plan.anchorWallLabel}", within the clear segment described as "${bedroom12Plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${bedroom12Plan.anchorOrientationInstruction}${b12FramingLine}${b12NoDecorLine}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the protected features named above and the no-decor-above-bed rule if it applies. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## BEDROOM 12 — FULL PROMPT ##########\n", bedroom12Prompt);
  await generateOne(bedroom12Path, bedroom12Prompt, path.join(BEDROOM_DIR, "Bedroom 12-staged-universalprotection.webp"));

  // ══════════════════════ LIVING 07 ══════════════════════
  console.log("\n\n########## LIVING 07: fresh baseline extraction (real call) ##########");
  const living07Path = path.join(LIVING_DIR, "Living 07.jpg");
  const living07FreshBaseline: any = await extractStructuralBaseline(living07Path, { jobId: "tmp-regression3-living07", imageId: "tmp-regression3-living07" });
  console.log("Living 07 fresh baseline — description fields:");
  for (const o of living07FreshBaseline.openings) console.log(`  ${o.id} (${o.type}): ${JSON.stringify(o.description)}`);
  for (const f of living07FreshBaseline.anchorFixtures || []) console.log(`  ${f.id} (${f.type}): ${JSON.stringify(f.description)}`);

  const fixData = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/fix_zoning_and_depth_check_1786621860530.json"), "utf8"));
  const living07Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 07_1786620838800.json"), "utf8"));
  const living07Plan = fixData.find((r: any) => r.name === "Living 07.jpg").newPlan;
  const living07Walls = living07Raw.wallVis.walls;

  const { section: l07Section, itemCount: l07Count } = buildUniversalFeatureProtectionSection(living07FreshBaseline, living07Walls);
  console.log(`\nLiving 07: ${l07Count} protected-feature sentences`);

  const living07AnchorSection = buildLivingDiningAnchorSection(living07Plan); // no TV -> existing sofa logic
  const living07Prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${l07Section}

${living07AnchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a combined living/dining space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## LIVING 07 — FULL PROMPT ##########\n", living07Prompt);
  await generateOne(living07Path, living07Prompt, path.join(LIVING_DIR, "Living 07-staged-universalprotection.webp"));

  // ══════════════════════ LIVING 10 ══════════════════════
  console.log("\n\n########## LIVING 10: fresh baseline extraction (real call) ##########");
  const living10Path = path.join(LIVING_DIR, "Living 10.jpg");
  const living10FreshBaseline: any = await extractStructuralBaseline(living10Path, { jobId: "tmp-regression3-living10", imageId: "tmp-regression3-living10" });
  console.log("Living 10 fresh baseline — description fields:");
  for (const o of living10FreshBaseline.openings) console.log(`  ${o.id} (${o.type}): ${JSON.stringify(o.description)}`);
  for (const f of living10FreshBaseline.anchorFixtures || []) console.log(`  ${f.id} (${f.type}): ${JSON.stringify(f.description)}`);

  const living10Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 10_1786620966268.json"), "utf8"));
  const living10Plan = fixData.find((r: any) => r.name === "Living 10.jpg").newPlan;
  const living10Walls = living10Raw.wallVis.walls;

  const livingWallIndices: number[] = living10Plan.livingZone.borderingWallIndices;
  const entryOpenings = findLivingZoneEntryOpenings(living10FreshBaseline, livingWallIndices);
  const sofaPos = computeFloatingSofaPosition(living10Plan.livingZone, entryOpenings);
  const clearanceOk = checkClearance(sofaPos, entryOpenings);
  console.log("\nLiving 10 sofa position (recomputed against fresh baseline):", sofaPos, "clearanceOk:", clearanceOk);
  if (!clearanceOk) {
    console.error("!!! CLEARANCE CHECK FAILED against fresh baseline — stopping short of generation for Living 10. !!!");
    return;
  }
  const sofaInstruction = `Place the sofa floating in the room (not against any wall), facing directly toward ${living10Plan.tvPlan.wallId} (the TV wall), positioned at approximately normalized coordinates [${sofaPos.x.toFixed(3)}, ${sofaPos.y.toFixed(3)}] of the full photo. This position is deliberately clear of the direct path from ${entryOpenings.map((o: any) => o.id).join("/")} into the room — do not place the sofa against a side or adjacent wall, and do not place it so it blocks the walking path from that opening into the rest of the room.`;

  const { section: l10Section, itemCount: l10Count } = buildUniversalFeatureProtectionSection(living10FreshBaseline, living10Walls);
  console.log(`\nLiving 10: ${l10Count} protected-feature sentences`);

  const living10AnchorSection = buildLivingDiningAnchorSection(living10Plan, sofaInstruction);
  const living10Prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${l10Section}

${living10AnchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a combined living/dining space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## LIVING 10 — FULL PROMPT ##########\n", living10Prompt);
  await generateOne(living10Path, living10Prompt, path.join(LIVING_DIR, "Living 10-staged-universalprotection.webp"));

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("regression_universal_protection_3images failed:", e);
  process.exit(1);
});
