// Part 3 testing: universal auto-generated position-bound protection.
//
// 1. Bedroom 12: fresh real baseline extraction (needs Part 1's new
//    `description` field) — stability check + old-vs-new prompt-size
//    comparison for one image, as requested.
// 2. Living 07 / Living 10: REUSE saved baseline data (no `description`
//    field present — pre-dates this fix) to confirm graceful fallback
//    behavior and get a second/third prompt-size comparison, with zero
//    new extraction calls.
// 3. Diningroom 01: fresh real baseline extraction (needs `description`)
//    + one real generation call — the primary test.
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
import { planDiningRoomAnchor } from "./plan_dining_room_anchor";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const WALL_VISIBILITY_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

// ── OLD fixed-clause mechanism, reconstructed here ONLY for a fair
// before/after size comparison (this is the exact logic that was deleted
// from anchorLockedStaging.ts in this task — kept here as a frozen
// reference copy for measurement purposes only, not reintroduced live). ──
const OLD_CATEGORY_B_RULES = [
  { id: "kitchen_built_ins", clause: "Kitchen islands, cabinetry, and countertops.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => ["kitchen_island", "built_in_cabinet"].includes(f.type)) },
  { id: "fireplace", clause: "Fireplaces, mantels, and hearths.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "fireplace") },
  { id: "closets", clause: "Closets and their doors.", matches: (b: any) => b.openings.some((o: any) => o.type === "closet_door") },
  { id: "plumbing", clause: "Faucets, sinks, tubs, and showers.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "plumbing_fixture") },
  { id: "pendant_ceiling_lighting", clause: "Pendant lights, chandeliers, recessed lighting, or ceiling fans.", matches: (b: any) => (b.anchorFixtures || []).some((f: any) => f.type === "light_fixture") },
];
function buildOldCategoryBSection(baseline: any): string {
  const included = OLD_CATEGORY_B_RULES.filter((r) => r.matches(baseline));
  return included.length > 0
    ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, also do not alter, remove, or obstruct:\n${included.map((r) => `* ${r.clause}`).join("\n")}`
    : "";
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
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

function report(label: string, oldSection: string, newSection: string) {
  console.log(`\n=== ${label}: OLD vs NEW protected-feature section size ===`);
  console.log(`OLD: ${oldSection.length} chars, ${oldSection.split(/\s+/).filter(Boolean).length} words`);
  console.log(`NEW: ${newSection.length} chars, ${newSection.split(/\s+/).filter(Boolean).length} words`);
  console.log(`--- NEW section text ---\n${newSection}`);
}

async function main() {
  // ── 1. Bedroom 12: fresh real baseline extraction (real call #1) ──
  console.log("\n\n########## BEDROOM 12: fresh baseline extraction (testing Part 1 schema) ##########");
  const bedroom12Path = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  const bedroom12Baseline: any = await extractStructuralBaseline(bedroom12Path, { jobId: "tmp-universal-protection-bedroom12", imageId: "tmp-universal-protection-bedroom12" });
  console.log(JSON.stringify(bedroom12Baseline, null, 2));
  console.log("\n=== Bedroom 12 stability metrics ===", JSON.stringify(bedroom12Baseline.graphMeta, null, 2));
  console.log("\n=== Bedroom 12: openings/fixtures with description field present? ===");
  for (const o of bedroom12Baseline.openings) console.log(`  ${o.id} (${o.type}): description=${JSON.stringify(o.description)}`);
  for (const f of bedroom12Baseline.anchorFixtures || []) console.log(`  ${f.id} (${f.type}): description=${JSON.stringify(f.description)}`);

  const bedroom12Walls = await extractWallVisibility(bedroom12Path, bedroom12Baseline);
  const bedroom12Plan = planBedroomAnchor(bedroom12Baseline, bedroom12Walls);
  console.log("\n=== Bedroom 12 anchor plan (should be structurally consistent with a validated bedroom run) ===", JSON.stringify(bedroom12Plan, null, 2));

  const oldB12 = buildOldCategoryBSection(bedroom12Baseline);
  const { section: newB12 } = buildUniversalFeatureProtectionSection(bedroom12Baseline, bedroom12Walls);
  report("Bedroom 12", oldB12, newB12);

  // ── 2. Living 07 / Living 10: reuse saved baseline (NO new calls) ──
  const living07Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 07_1786620838800.json"), "utf8"));
  const living10Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 10_1786620966268.json"), "utf8"));

  const oldL07 = buildOldCategoryBSection(living07Raw.baseline);
  const { section: newL07 } = buildUniversalFeatureProtectionSection(living07Raw.baseline, living07Raw.wallVis?.walls || null);
  report("Living 07 (reused pre-fix baseline, no description field — tests fallback)", oldL07, newL07);

  const oldL10 = buildOldCategoryBSection(living10Raw.baseline);
  const { section: newL10 } = buildUniversalFeatureProtectionSection(living10Raw.baseline, living10Raw.wallVis?.walls || null);
  report("Living 10 (reused pre-fix baseline, no description field — tests fallback)", oldL10, newL10);

  // ── 3. Diningroom 01: fresh real baseline extraction (real call #2) ──
  console.log("\n\n########## DININGROOM 01: fresh baseline extraction (testing Part 1 schema + Part 2 fix) ##########");
  const diningPath = path.join(LIVING_DIR, "Diningroom 01.webp");
  const diningBaseline: any = await extractStructuralBaseline(diningPath, { jobId: "tmp-universal-protection-dining01", imageId: "tmp-universal-protection-dining01" });
  console.log(JSON.stringify(diningBaseline, null, 2));
  console.log("\n=== Diningroom 01: openings/fixtures with description field ===");
  for (const o of diningBaseline.openings) console.log(`  ${o.id} (${o.type}): ${JSON.stringify(o.description)}`);
  for (const f of diningBaseline.anchorFixtures || []) console.log(`  ${f.id} (${f.type}): ${JSON.stringify(f.description)}`);

  // Reuse previously-extracted wall-visibility data (positions unaffected by the description-field change).
  const { walls: diningWalls } = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/dining01_extraction.json"), "utf8"));

  const plan = planDiningRoomAnchor(diningBaseline, diningWalls);
  console.log("\n=== Dining room anchor plan (re-derived from fresh baseline) ===", JSON.stringify(plan, null, 2));

  const { section: protectedFeatureSection, itemCount, sentences } = buildUniversalFeatureProtectionSection(diningBaseline, diningWalls);
  console.log(`\n=== Diningroom 01: ${itemCount} universal protected-feature sentences ===`);
  sentences.forEach((s) => console.log(`  * ${s}`));

  const anchorSection = `ANCHOR ITEM — DINING TABLE (must be followed exactly)

* Place a dining table with seating for 4-6 chairs, freestanding in the room (not against a wall), centered roughly at normalized position [${plan.center[0].toFixed(3)}, ${plan.center[1].toFixed(3)}] of the full photo. The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out, and clear of the swing path of both doors in the room.`;

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

${anchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor item above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a dining room, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## Diningroom 01 — FULL PROMPT (v2, universal protection) ##########\n", prompt);

  const { data, mime } = toBase64(diningPath);
  const ai = getGeminiClient();
  console.log(`\n=== Sending real generation call (model=${MODEL}, temperature=0.4, topP=0.9, topK=40) ===`);
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
    return;
  }
  const outPath = path.join(LIVING_DIR, "Diningroom 01-staged-v2.webp");
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== DONE (${durationMs}ms) === outPath=${outPath}`);

  await fs.writeFile(path.join(REPO_ROOT, "tmp/dining01_extraction_v2_withdesc.json"), JSON.stringify({ baseline: diningBaseline, walls: diningWalls }, null, 2));

  console.log("\n\n=== ALL DONE ===");
}

main().catch((e) => {
  console.error("universal_protection_test failed:", e);
  process.exit(1);
});
