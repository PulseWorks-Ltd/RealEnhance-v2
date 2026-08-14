// Real generation test using the exact saved baseline+walls from attempt 3
// of verify_walluse_fix.ts (wall_0 selected correctly), built through the
// REAL exported production functions (planBedroomAnchor,
// buildUniversalFeatureProtectionSection, CATEGORY_A_LOCKS) — not a
// reimplementation.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { CATEGORY_A_LOCKS, buildUniversalFeatureProtectionSection, planBedroomAnchor } from "../worker/src/pipeline/anchorLockedStaging";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

async function main() {
  const results = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/bedroom14_fixed_walluse_results.json"), "utf8"));
  const attempt3 = results[2]; // 0-indexed; attempt3 = index 2, wall_0 selected
  const { baseline, walls } = attempt3;

  const plan = planBedroomAnchor(baseline, walls);
  if (!plan) throw new Error("planBedroomAnchor returned null against the fixed real data — unexpected");
  console.log("=== Anchor plan (real, via planBedroomAnchor) ===", JSON.stringify(plan, null, 2));

  const { section: protectedFeatureSection } = buildUniversalFeatureProtectionSection(baseline, walls);

  const framingLine = plan.anchorFramingNote ? ` ${plan.anchorFramingNote}` : "";
  const noDecorLine = plan.noDecorAboveBedNote ? `\n* ${plan.noDecorAboveBedNote}` : "";
  const prompt = `Virtual Staging Instructions for nano banana (or Pro)

${CATEGORY_A_LOCKS}${protectedFeatureSection}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against ${plan.anchorWallId} in the room analysis, referred to as "${plan.anchorWallLabel}", within the clear segment described as "${plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${plan.anchorOrientationInstruction}${framingLine}${noDecorLine}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the protected features named above and the no-decor-above-bed rule if it applies. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;

  console.log("\n\n########## FULL PROMPT ##########\n", prompt);

  const imagePath = path.join(BEDROOM_DIR, "Bedroom 14.jpg");
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
    console.error("NO IMAGE RETURNED", parts.map((p: any) => Object.keys(p)));
    process.exit(1);
  }
  const outPath = path.join(BEDROOM_DIR, "Bedroom 14-staged-wallfixed.webp");
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`DONE (${durationMs}ms) -> ${outPath}`);
  process.exit(0);
}
main().catch((e) => {
  console.error("generate_bedroom14_fixed_test failed:", e);
  process.exit(1);
});
