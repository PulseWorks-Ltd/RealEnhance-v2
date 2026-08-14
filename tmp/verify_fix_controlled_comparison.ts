// Controlled before/after comparison from the IDENTICAL saved extraction
// snapshot (tmp/colocated_risk_snapshot_bedroom11.json, attempt 3 of
// probe_colocated_risk_wall.ts — wall_1 qualifies as anchor wall AND has
// real co-located items: A1 walkthrough + W2 small window). Using the same
// snapshot for both prompts eliminates wall-selection variance as a
// confound — this isolates the ONE variable under test: does the restored
// co-located-features section change the result on an otherwise-identical
// plan?
//
// "Unfixed" prompt = exact regressed CATEGORY_A_LOCKS (no Core Principle)
// + universal section only, matching what's currently committed at HEAD.
// "Fixed" prompt = current working-tree CATEGORY_A_LOCKS (with Core
// Principle restored) + universal section + restored co-located section,
// matching the uncommitted fix.
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import {
  CATEGORY_A_LOCKS as FIXED_CATEGORY_A_LOCKS,
  buildUniversalFeatureProtectionSection,
  planBedroomAnchor,
} from "../worker/src/pipeline/anchorLockedStaging";
import { execSync } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const MODEL = process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || "gemini-2.5-flash-image";

// Exact regressed CATEGORY_A_LOCKS, pulled live from HEAD (the currently
// committed, unfixed state) rather than retyped, to guarantee fidelity.
function getUnfixedCategoryALocks(): string {
  const text = execSync("git show HEAD:worker/src/pipeline/anchorLockedStaging.ts", { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 }).toString();
  const m = text.match(/export const CATEGORY_A_LOCKS = `([\s\S]*?)`;/);
  if (!m) throw new Error("Could not extract CATEGORY_A_LOCKS from HEAD");
  return m[1];
}

// Exact restored function, copied verbatim from the current working-tree
// module (not exported from production — duplicated here for this
// controlled test only, same pattern used throughout tonight).
function describeHorizontalBand(band: string): string {
  if (band === "left_third") return "left portion";
  if (band === "right_third") return "right portion";
  return "center";
}
function describeVerticalBand(band: string): string {
  if (band === "floor_zone") return "lower";
  if (band === "ceiling_zone") return "upper, near the ceiling";
  if (band === "full_height") return "full-height";
  return "middle";
}
function describeCoLocatedFeatures(baseline: any, anchorWallIndex: number): string[] {
  const openingLines = baseline.openings
    .filter((o: any) => o.wallIndex === anchorWallIndex)
    .map(
      (o: any) =>
        `* ${o.id} (${o.description || o.type}), in the ${describeVerticalBand(o.verticalBand)} area, ${describeHorizontalBand(o.horizontalBand)} of this wall: must remain fully visible. Do not place artwork, mirrors, shelving, or any wall-mounted decor over it, and do not obstruct it with furniture.`
    );
  const fixtureLines = (baseline.anchorFixtures || [])
    .filter((f: any) => f.wallIndex === anchorWallIndex)
    .map(
      (f: any) =>
        `* ${f.id} (${f.description || f.type}), in the ${describeHorizontalBand(f.horizontalBand)} of this wall: must remain fully visible and unobstructed. Do not place artwork, mirrors, shelving, or any wall-mounted decor over it.`
    );
  return [...openingLines, ...fixtureLines];
}

function buildPrompt(opts: { categoryALocks: string; protectedFeatureSection: string; plan: any; includeColocated: boolean; baseline: any }): string {
  const framingLine = opts.plan.anchorFramingNote ? ` ${opts.plan.anchorFramingNote}` : "";
  const noDecorLine = opts.plan.noDecorAboveBedNote ? `\n* ${opts.plan.noDecorAboveBedNote}` : "";
  let anchorWallFeaturesSection = "";
  if (opts.includeColocated) {
    const coLocatedFeatures = describeCoLocatedFeatures(opts.baseline, opts.plan.anchorWallIndex);
    anchorWallFeaturesSection =
      coLocatedFeatures.length > 0
        ? `\n\nANCHOR WALL — CO-LOCATED FEATURES (must stay fully visible; nothing may cover or obstruct them, including the bed)\n\nThe wall selected for the bed also has the following existing feature(s) on it. Position the bed within the clear segment described above so that it does NOT overlap or obstruct any of these — the bed must be positioned to avoid them, even if that means it does not span the entire wall. No new item (artwork, mirrors, shelving, or any other wall-mounted decor) may be placed over them either, even though it may look conventional to decorate that spot:\n${coLocatedFeatures.join("\n")}`
        : "";
  }
  return `Virtual Staging Instructions for nano banana (or Pro)

${opts.categoryALocks}${opts.protectedFeatureSection}

ANCHOR ITEM — BED (must be followed exactly)

* Place the bed against ${opts.plan.anchorWallId} in the room analysis, referred to as "${opts.plan.anchorWallLabel}", within the clear segment described as "${opts.plan.anchorSegmentDescription}" — this is the wall and clear zone selected as the anchor by the room's own layout analysis.
* ${opts.plan.anchorOrientationInstruction}${framingLine}${noDecorLine}${anchorWallFeaturesSection}

EVERYTHING ELSE — YOUR PROFESSIONAL JUDGMENT

Beyond the bed placement above and the structural constraints above, use your own professional staging judgment to furnish and decorate the rest of the room appropriately for a bedroom, producing a realistic, market-ready real estate listing photo. Choose what additional furniture and decor to include, how much, and where — as long as nothing you add violates the structural constraints above, including the protected features named above and the no-decor-above-bed rule if it applies. Do not leave the room sparse or under-furnished; stage it as a professional would for a real listing.`;
}

async function generateOne(imagePath: string, prompt: string, outPath: string) {
  const { data, mime } = toBase64(imagePath);
  const ai = getGeminiClient();
  console.log(`\n=== Sending real generation call (model=${MODEL}) -> ${outPath} ===`);
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
    return null;
  }
  await sharp(Buffer.from(imgPart.inlineData.data, "base64")).webp({ quality: 95 }).toFile(outPath);
  console.log(`DONE (${durationMs}ms)`);
  return outPath;
}

async function main() {
  const snapshot = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "tmp/colocated_risk_snapshot_bedroom11.json"), "utf8"));
  const { baseline, walls } = snapshot;

  const plan = planBedroomAnchor(baseline, walls);
  if (!plan) throw new Error("planBedroomAnchor returned null against the saved snapshot — unexpected");
  console.log("=== Anchor plan (identical for both prompts) ===", JSON.stringify(plan, null, 2));
  console.log("=== Co-located items on selected anchor wall ===", describeCoLocatedFeatures(baseline, plan.anchorWallIndex));

  const { section: protectedFeatureSection } = buildUniversalFeatureProtectionSection(baseline, walls);

  const unfixedLocks = getUnfixedCategoryALocks();
  console.log("\nUnfixed CATEGORY_A_LOCKS chars:", unfixedLocks.length, "| Fixed CATEGORY_A_LOCKS chars:", FIXED_CATEGORY_A_LOCKS.length);

  const unfixedPrompt = buildPrompt({ categoryALocks: unfixedLocks, protectedFeatureSection, plan, includeColocated: false, baseline });
  const fixedPrompt = buildPrompt({ categoryALocks: FIXED_CATEGORY_A_LOCKS, protectedFeatureSection, plan, includeColocated: true, baseline });

  console.log("\n\n########## UNFIXED (regressed, matches committed HEAD) PROMPT ##########\n", unfixedPrompt);
  console.log("\n\n########## FIXED (uncommitted working tree) PROMPT ##########\n", fixedPrompt);

  const imagePath = path.join(BEDROOM_DIR, "Bedroom 11.jpg");
  await generateOne(imagePath, unfixedPrompt, path.join(BEDROOM_DIR, "Bedroom 11-staged-UNFIXED-controlled.webp"));
  await generateOne(imagePath, fixedPrompt, path.join(BEDROOM_DIR, "Bedroom 11-staged-FIXED-controlled.webp"));

  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("verify_fix_controlled_comparison failed:", e);
  process.exit(1);
});
