// Part 2: standalone single-room dining test — Diningroom 01.
// Imports CATEGORY_A_LOCKS / CATEGORY_B_RULES directly from production
// anchorLockedStaging.ts (the real, current, consolidated + flooring-fix
// text) rather than a local copy, since this is testing a genuinely new
// room-type path against the real current locks. Reuses the real baseline
// + wall-visibility data already extracted and saved
// (tmp/dining01_extraction.json) — no re-extraction.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { CATEGORY_A_LOCKS, CATEGORY_B_RULES } from "../worker/src/pipeline/anchorLockedStaging";
import { planDiningRoomAnchor } from "./plan_dining_room_anchor";

const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";
const REPO_ROOT = path.resolve(__dirname, "..");
const LIVING_DIR = path.join(REPO_ROOT, "Test Images/Living (Baseline)");

function buildCategoryBSection(baseline: any): { section: string; included: string[] } {
  const included = CATEGORY_B_RULES.filter((r) => r.matches(baseline));
  const section =
    included.length > 0
      ? `\n\nROOM-SPECIFIC PROTECTED FEATURES — detected in this photo, also do not alter, remove, or obstruct:\n${included.map((r) => `* ${r.clause}`).join("\n")}`
      : "";
  return { section, included: included.map((r) => r.id) };
}

async function main() {
  const { baseline, walls } = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/dining01_extraction.json"), "utf8"));

  const plan = planDiningRoomAnchor(baseline, walls);
  console.log("\n=== Dining room anchor plan ===\n", JSON.stringify(plan, null, 2));

  const { section: categoryBSection, included: categoryBIncluded } = buildCategoryBSection(baseline);
  console.log("\n=== Category-B clauses included ===", categoryBIncluded);

  const anchorSection = `ANCHOR ITEM — DINING TABLE (must be followed exactly)

* Place a dining table with seating for 4-6 chairs, freestanding in the room (not against a wall), centered roughly at normalized position [${plan.center[0].toFixed(3)}, ${plan.center[1].toFixed(3)}] of the full photo. The table must be freestanding — not against a wall — with clearance on all sides for chairs to be pulled out, and clear of the swing path of both doors in the room.`;

  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${categoryBSection}

${anchorSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the anchor item above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a dining room, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## Diningroom 01 — FULL PROMPT ##########\n", prompt);

  const imagePath = path.join(LIVING_DIR, "Diningroom 01.webp");
  const { data, mime } = toBase64(imagePath);
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
  const outPath = path.join(LIVING_DIR, "Diningroom 01-staged-v1.webp");
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`=== DONE (${durationMs}ms) === outPath=${outPath}`);
}

main().catch((e) => {
  console.error("generate_dining_room_test failed:", e);
  process.exit(1);
});
