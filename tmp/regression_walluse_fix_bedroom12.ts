// Regression check: does the fix change scoring for floor-touching
// openings (sliding door) or wall-mounted fixtures without a touchesFloor
// field (AC unit)? Bedroom 12 has both on real candidate walls from
// tonight's earlier real runs. Uses the CURRENT (fixed) prompt, pulled
// directly from the working-tree file, same pattern as verify_walluse_fix.ts.
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
  return {
    system: sysMatch[1],
    buildUser: (baseline: any) => `Existing baseline (already detected, DO NOT re-detect — reference these IDs):
${JSON.stringify(baseline, null, 2)}

First, internally determine how many distinct walls are visible. Then analyze this room photograph
and return JSON in this exact schema (all coordinates normalized 0-1):
{
  "wallCount": number,
  "wallCountReasoning": string,
  "walls": [
    { "id": "wall_0" | "wall_1" | "wall_2" | "wall_3", "wallLabel": string, "extent": { "polygon": [[x,y], [x,y], ...] }, "openingIds": string[], "usableWidthFraction": number, "usableSegments": [{ "range": [start, end], "widthFraction": number, "description": string }], "confidence": number }
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

async function main() {
  const { system, buildUser } = await getFixedInstructionAndPromptBuilder();
  const imagePath = path.join(BEDROOM_DIR, "Bedroom 12.jpg");

  for (let i = 1; i <= 2; i++) {
    console.log(`\n=== Bedroom 12 regression attempt ${i}: real baseline extraction ===`);
    const baseline: any = await extractStructuralBaseline(imagePath, { jobId: `regression-b12-${i}`, imageId: `regression-b12-${i}` });
    console.log("openings:", baseline.openings.map((o: any) => `${o.id}(${o.type},touchesFloor=${o.touchesFloor},wallIndex=${o.wallIndex})`).join(", "));
    console.log("anchorFixtures:", (baseline.anchorFixtures || []).map((f: any) => `${f.id}(${f.type},wallIndex=${f.wallIndex})`).join(", "));

    console.log(`=== Bedroom 12 regression attempt ${i}: real wall-visibility extraction (FIXED prompt) ===`);
    const walls = await extractWallVisibilityFixed(imagePath, baseline, system, buildUser);
    for (const w of walls) {
      const largestSegment = (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0);
      console.log(`  ${w.id} (${w.wallLabel}): usableWidthFraction=${w.usableWidthFraction}, largestSegment=${largestSegment.toFixed(3)}, openingIds=[${(w.openingIds || []).join(", ")}]`);
    }
  }

  process.exit(0);
}
main().catch((e) => {
  console.error("regression_walluse_fix_bedroom12 failed:", e);
  process.exit(1);
});
