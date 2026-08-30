// Precise flooring fix validation — Living 07.
// 1. Fresh zoning extraction using the current (flooringDescription-fixed)
//    zoning prompt — real call, report the value verbatim.
// 2. Rebuild the generation prompt using materialPreservationNoteV2 (the
//    fix that's supposed to consume flooringDescription) — confirm wiring.
// 3. One real generation call.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { CATEGORY_A_LOCKS, buildUniversalFeatureProtectionSection } from "../worker/src/pipeline/anchorLockedStaging";
import { ZONING_SYSTEM_INSTRUCTION_V3, buildZoningUserPromptV3, materialPreservationNoteV2 } from "./zoning_prompt_v3_flooring_fidelity";

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");
const ZONING_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function main() {
  const living07Raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/validate_Living 07_1786620838800.json"), "utf8"));
  const fixData = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/fix_zoning_and_depth_check_1786621860530.json"), "utf8"));
  const living07Plan = fixData.find((r: any) => r.name === "Living 07.jpg").newPlan;

  // ── 1. Fresh zoning extraction (real call) with the flooringDescription-fixed prompt ──
  const imagePath = path.join(LIVING_DIR, "Living 07.jpg");
  const image = toBase64(imagePath);
  const ai = getGeminiClient();
  console.log("=== Sending real zoning extraction call (model=" + ZONING_MODEL + ") ===");
  const response: any = await (ai as any).models.generateContent({
    model: ZONING_MODEL,
    contents: [{ role: "user", parts: [{ text: ZONING_SYSTEM_INSTRUCTION_V3 }, { text: buildZoningUserPromptV3(living07Raw.baseline) }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("NO TEXT RETURNED (zoning)");
  const freshZoning = extractJsonFromModelText(textPart.text);
  console.log("\n=== FRESH ZONING RESULT (full) ===\n", JSON.stringify(freshZoning, null, 2));

  const freshLivingZone = freshZoning.zones.find((z: any) => z.purpose === "living");
  const freshDiningZone = freshZoning.zones.find((z: any) => z.purpose === "dining");
  console.log("\n=== flooringDescription — living zone ===\n", JSON.stringify(freshLivingZone?.flooringDescription));
  console.log("=== flooringDescription — dining zone ===\n", JSON.stringify(freshDiningZone?.flooringDescription));
  console.log("\n=== dining zone floorRegion polygon (fresh) ===\n", JSON.stringify(freshDiningZone?.floorRegion?.polygon));
  console.log("=== dining zone reasoning (fresh) ===\n", freshDiningZone?.reasoning);

  // ── 2. Rebuild prompt using materialPreservationNoteV2, fed by the FRESH zoning data ──
  const diningNote = materialPreservationNoteV2(freshDiningZone, "living");
  console.log("\n=== materialPreservationNoteV2 output (what actually gets appended to the anchor instruction) ===\n", diningNote);

  const livingLines: string[] = [];
  const sofaWhere = living07Plan.sofaPlan.wallId ? `against ${living07Plan.sofaPlan.wallId} (${living07Plan.sofaPlan.wallLabel})` : `floor-centered within the living zone (no wall in this zone is suitable for large furniture)`;
  livingLines.push(`* Place a sofa ${sofaWhere}. ${living07Plan.sofaPlan.orientationInstruction || ""}`.trim());

  const diningLines: string[] = [];
  diningLines.push(`* Place a dining table with seating for 4-6 chairs, freestanding within the dining zone, centered roughly at normalized position [${living07Plan.diningPlan.center[0].toFixed(3)}, ${living07Plan.diningPlan.center[1].toFixed(3)}] of the full photo.${diningNote} The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out.`);

  const anchorSection = `ANCHOR ITEMS — LIVING ZONE (must be followed exactly)\n\n${livingLines.join("\n")}\n\nANCHOR ITEM — DINING ZONE (must be followed exactly)\n\n${diningLines.join("\n")}\n\nZONING CONTEXT: this is a single open-plan room combining two functional zones — a living/seating zone and a dining zone. Stage each zone according to its function as instructed above, so the two areas read as distinct, intentional zones within the same open room, not one undifferentiated furniture arrangement.`;

  const { section: protectedFeatureSection } = buildUniversalFeatureProtectionSection(living07Raw.baseline, living07Raw.wallVis?.walls || null);

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

${anchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor items above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a combined living/dining space, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## LIVING 07 — FULL PROMPT ##########\n", prompt);

  // ── 3. One real generation call ──
  const { data, mime } = toBase64(imagePath);
  console.log(`\n=== Sending real generation call (model=${MODEL}) ===`);
  const startedAt = Date.now();
  const genResponse: any = await (ai as any).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data } }] }],
    generationConfig: { temperature: 0.4, topP: 0.9, topK: 40 },
  });
  const durationMs = Date.now() - startedAt;
  const genParts: any[] = genResponse?.candidates?.[0]?.content?.parts || [];
  const imgPart = genParts.find((p: any) => p?.inlineData?.data);
  if (!imgPart) {
    console.error("=== NO IMAGE RETURNED ===", genParts.map((p: any) => Object.keys(p)));
    process.exit(1);
  }
  const outPath = path.join(LIVING_DIR, "Living 07-staged-precisefloorcheck.webp");
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== DONE (${durationMs}ms) === outPath=${outPath}`);

  await fs.writeFile(path.join(REPO_ROOT, "tmp/living07_fresh_zoning_withfloordesc.json"), JSON.stringify(freshZoning, null, 2));

  console.log("\n=== ALL DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("living07_flooring_precise_check failed:", e);
  process.exit(1);
});
