import fs from "fs/promises";
import path from "path";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";
import { extractStructuralBaseline } from "../worker/src/validators/openingPreservationValidator";
import { execSync } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "..");
const BEDROOM_DIR = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)");
const WALL_VISIBILITY_MODEL = String(process.env.OPENING_PRESERVATION_MODEL || "gemini-2.5-pro");

function extractInstructionFromSource(source: string): string {
  const m = source.match(/const WALL_VISIBILITY_SYSTEM_INSTRUCTION = `([\s\S]*?)`;/);
  if (!m) throw new Error("Could not extract WALL_VISIBILITY_SYSTEM_INSTRUCTION");
  return m[1];
}

function buildUser(baseline: any): string {
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

async function extractWallVisibilityWith(imagePath: string, baseline: any, system: string): Promise<any[]> {
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

function scoreWalls(walls: any[]) {
  return walls.map((w: any) => ({
    id: w.id,
    label: w.wallLabel,
    usableWidthFraction: w.usableWidthFraction,
    largestSegment: (w.usableSegments || []).reduce((m: number, s: any) => Math.max(m, s.widthFraction), 0),
    openingIds: w.openingIds,
  }));
}

async function main() {
  const currentSource = await fs.readFile(path.join(REPO_ROOT, "worker/src/pipeline/anchorLockedStaging.ts"), "utf8");
  const fixedInstruction = extractInstructionFromSource(currentSource);
  const oldSource = execSync("git show HEAD:worker/src/pipeline/anchorLockedStaging.ts", { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 }).toString();
  const oldInstruction = extractInstructionFromSource(oldSource);
  console.log("Old instruction contains FLOOR-CLEARANCE RULE:", oldInstruction.includes("FLOOR-CLEARANCE RULE"));
  console.log("Fixed instruction contains FLOOR-CLEARANCE RULE:", fixedInstruction.includes("FLOOR-CLEARANCE RULE"));

  const imagePath = path.join(BEDROOM_DIR, "Bedroom 12.jpg");
  console.log("\n=== Real baseline extraction (single, shared for both prompt versions) ===");
  const baseline: any = await extractStructuralBaseline(imagePath, { jobId: "controlled-regression-b12", imageId: "controlled-regression-b12" });
  console.log("openings:", baseline.openings.map((o: any) => `${o.id}(${o.type},touchesFloor=${o.touchesFloor},wallIndex=${o.wallIndex})`).join(", "));
  console.log("anchorFixtures:", (baseline.anchorFixtures || []).map((f: any) => `${f.id}(${f.type},wallIndex=${f.wallIndex})`).join(", "));

  console.log("\n=== OLD (pre-fix, HEAD) wall-visibility on this exact baseline ===");
  const oldWalls = await extractWallVisibilityWith(imagePath, baseline, oldInstruction);
  console.log(JSON.stringify(scoreWalls(oldWalls), null, 2));

  console.log("\n=== NEW (fixed) wall-visibility on this exact baseline ===");
  const newWalls = await extractWallVisibilityWith(imagePath, baseline, fixedInstruction);
  console.log(JSON.stringify(scoreWalls(newWalls), null, 2));

  process.exit(0);
}
main().catch((e) => {
  console.error("controlled_regression_bedroom12 failed:", e);
  process.exit(1);
});
