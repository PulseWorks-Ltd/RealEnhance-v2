// Verification of the real fix in worker/src/pipeline/anchorLockedStaging.ts
// (WALL_VISIBILITY_SYSTEM_INSTRUCTION's floor-clearance rule). Pulls the
// CURRENT (post-fix) instruction text directly from the working-tree file
// on disk — not retyped — to guarantee the exact real fix is what's being
// tested, not a paraphrase. No code changes here; this script only calls
// the real extraction call pattern with that exact text.
import fs from "fs/promises";
import path from "path";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const WALL_VISIBILITY_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

async function getFixedInstructionAndPromptBuilder(): Promise<{ system: string; buildUser: (baseline: any) => string }> {
  const text = await fs.readFile(path.join(REPO_ROOT, "worker/src/pipeline/anchorLockedStaging.ts"), "utf8");
  const sysMatch = text.match(/const WALL_VISIBILITY_SYSTEM_INSTRUCTION = `([\s\S]*?)`;/);
  if (!sysMatch) throw new Error("Could not extract WALL_VISIBILITY_SYSTEM_INSTRUCTION from working tree");
  const system = sysMatch[1];
  return {
    system,
    buildUser: (baseline: any) => `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

First, internally determine how many distinct walls are visible. Then analyze this room photograph
and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "wallCount": number,
  "wallCountReasoning": string,
  "walls": [
    {
      "id": "wall_0" | "wall_1" | "wall_2" | "wall_3",
      "wallLabel": string,
      "extent": { "polygon": [[x,y], [x,y], ...] },
      "openingIds": string[],
      "usableWidthFraction": number,
      "usableSegments": [
        { "range": [start, end], "widthFraction": number, "description": string }
      ],
      "confidence": number
    }
  ]
}`,
  };
}

function extractJsonFromModelText(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function extractWallVisibilityFixed(imagePath: string, baseline: any, system: string, buildUser: (b: any) => string): Promise<any[]> {
  const image = toBase64(imagePath);
  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: WALL_VISIBILITY_MODEL,
    contents: [{ role: "user", parts: [{ text: system }, { text: buildUser(baseline) }, { inlineData: { mimeType: image.mime, data: image.data } }] }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 3072, responseMimeType: "application/json" },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  if (!textPart) throw new Error("NO TEXT RETURNED (wall visibility)");
  return extractJsonFromModelText(textPart.text).walls;
}

const MIN_USABLE_FRACTION_FOR_ANCHOR = 0.35;

async function runOnce(label: string, imagePath: string, system: string, buildUser: (b: any) => string) {
  console.log(`\n=== ${label}: real baseline extraction ===`);
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId: `verify-fix-${label}`, imageId: `verify-fix-${label}` });
  console.log("openings:", baseline.openings.map((o: any) => `${o.id}(${o.type},touchesFloor=${o.touchesFloor},wallIndex=${o.wallIndex})`).join(", "));

  console.log(`=== ${label}: real wall-visibility extraction (FIXED prompt) ===`);
  const walls = await extractWallVisibilityFixed(imagePath, baseline, system, buildUser);
  const scored = walls.map((w: any) => ({
    id: w.id,
    label: w.wallLabel,
    usableWidthFraction: w.usableWidthFraction,
    largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0),
    openingIds: w.openingIds,
  }));
  console.log(JSON.stringify(scored, null, 2));
  const qualifying = scored.filter((w) => w.largestSegment >= MIN_USABLE_FRACTION_FOR_ANCHOR).sort((a, b) => b.largestSegment - a.largestSegment);
  console.log("Qualifying (>=0.35), ranked:", qualifying.map((q) => `${q.id}=${q.largestSegment.toFixed(3)}`));
  console.log("Would select:", qualifying[0]?.id || "NONE (fallback)");
  return { baseline, walls, scored };
}

async function main() {
  const { system, buildUser } = await getFixedInstructionAndPromptBuilder();
  console.log("=== Confirming fix text is present in the extracted instruction ===");
  console.log("Contains 'FLOOR-CLEARANCE RULE':", system.includes("FLOOR-CLEARANCE RULE"));

  const imagePath = path.join(BEDROOM_DIR, "Bedroom 14.jpg");
  const results = [];
  for (let i = 1; i <= 3; i++) {
    results.push(await runOnce(`bedroom14-fixed-attempt${i}`, imagePath, system, buildUser));
  }

  await fs.writeFile(path.join(REPO_ROOT, "tmp/bedroom14_fixed_walluse_results.json"), JSON.stringify(results, null, 2));
  console.log("\n\n=== ALL DONE ===");
  process.exit(0);
}
main().catch((e) => {
  console.error("verify_walluse_fix failed:", e);
  process.exit(1);
});
