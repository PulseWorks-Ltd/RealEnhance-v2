// Read-only test: same LAYOUT_PLANNER_PROMPT text as
// worker/src/pipeline/layoutPlanner.ts (copied verbatim, not modified —
// that file's own Gemini call is currently broken: `ai.getGenerativeModel`
// is not a function on the @google/genai client), called via the working
// ai.models.generateContent() pattern used successfully elsewhere in this
// codebase, so we can actually see what Gemini responds with.
import path from "path";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { toBase64 } from "../worker/src/utils/images";

// Copied verbatim from worker/src/pipeline/layoutPlanner.ts:52-79
const LAYOUT_PLANNER_PROMPT = `Analyze this empty room and produce a structured furniture layout plan suitable for real estate staging.

Return strict JSON with this shape:
{
  "room_type": string,
  "layout": [{ "item": string, "placement": string }],
  "avoid_zones": string[],
  "anchorItem": "bed" | "tv_unit" | "dining_table" | "sofa_group",
  "anchorWall": string,
  "anchorOrientation": "facing_camera" | "facing_anchor_wall",
  "anchorConstraints": {
    "allowWallMount": boolean,
    "avoidAboveWindow": boolean,
    "avoidCoveringWindows": boolean,
    "mountMode": "wall_mount" | "console_only" | "freestanding",
    "rules": string[]
  },
  "anchorRegion": { "x": number, "y": number, "width": number, "height": number },
  "anchorConfidence": number
}

Rules:
- For bedroom use bed anchor.
- For living room prefer sofa_group anchor.
- Add a tv_unit anchor only when a clearly suitable uninterrupted wall area exists with no conflicting openings.
- For dining room use dining_table anchor.
- AnchorRegion values must be normalized 0..1.
- If uncertain, still return layout with conservative anchorConfidence.`;

// Copied verbatim from layoutPlanner.ts:81-104 (buildPlannerPriorityBlock, no retryInstructions branch)
const PLANNER_PRIORITY_BLOCK = `
PLANNING PRIORITY HIERARCHY (STRICT):
P0 Structural Constraints + Continuity Constraints (NON-NEGOTIABLE)
P2 Room Type Rules
P3 Staging Style Rules
P4 Default Layout Heuristics
`;

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const baselinePath = path.join(repoRoot, "Test Images/Bedroom (Baseline)/Bedroom 12.jpg");
  const roomType = "bedroom";
  const stagingStyle = "standard_listing";

  const { data, mime } = toBase64(baselinePath);
  const ai = getGeminiClient();

  const fullPromptText = `${LAYOUT_PLANNER_PROMPT}

CONTEXT:
- Room type target: ${roomType}
- Staging style target: ${stagingStyle}
${PLANNER_PRIORITY_BLOCK}`;

  console.log("=== calling Gemini with the real layout-planner prompt (verbatim) on Bedroom 12 ===");
  const startedAt = Date.now();
  const response = await (ai as any).models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: mime, data } },
          { text: fullPromptText },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.9,
      topK: 20,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
    },
  });
  const durationMs = Date.now() - startedAt;

  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");

  console.log(`\n=== RAW RESPONSE TEXT (${durationMs}ms) ===`);
  console.log(textPart?.text || "(no text part returned)");

  if (textPart?.text) {
    try {
      const parsed = JSON.parse(textPart.text);
      console.log("\n=== PARSED JSON ===");
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e: any) {
      console.log("\n=== JSON PARSE FAILED ===", e.message);
    }
  }
}

main().catch((e) => {
  console.error("test_layout_planner_working_call failed:", e);
  process.exit(1);
});
