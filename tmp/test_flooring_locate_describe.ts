// Part 2b, exploratory only — NOT wired into any validator. Tests whether
// the locate/describe question pattern that worked for openings/fixtures
// (and, with the fourth dimension, for resize/reposition) also works for
// flooring material-boundary detection, on the same real Living 07
// carpet/linoleum unification failure Part 2a tested via the existing
// (dominant-material-class) validator design. Standalone script, real
// calls, both models — same discipline as tmp/test_resize_direct_question.ts.
import path from "path";
import { toBase64 } from "../worker/src/utils/images";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { grokAnalyzeImages } from "../worker/src/ai/grok";

const REPO_ROOT = path.resolve(__dirname, "..");
const baselinePath = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07.jpg");
const stagedPath = path.join(REPO_ROOT, "Test Images/Living (Baseline)/Living 07-staged-precisefloorcheck.webp");

// Approximate region of the baseline's distinct (linoleum/vinyl-look) floor
// zone, behind/right of the second window, determined by direct visual
// inspection of the baseline photo before writing this script.
const ZONE = { x1: 0.55, y1: 0.45, x2: 0.92, y2: 0.72 };

const PROMPT = `You are comparing an ORIGINAL (baseline) room photo against a STAGED (furnished) version of the same room.

There is a floor region in the ORIGINAL photo at approximately this location: x: ${ZONE.x1}-${ZONE.x2}, y: ${ZONE.y1}-${ZONE.y2} (normalized fractions of image width/height, 0,0 = top-left). In the ORIGINAL photo, this region shows a visibly different flooring material from the rest of the room — smoother and lighter in tone than the darker textured carpet elsewhere, with a visible diagonal seam marking the boundary between the two materials.

Look at the STAGED image at this same location. Describe the flooring material you see there now — is it the same lighter, smoother material as the original at this location, or does it now match the darker textured carpet from elsewhere in the room? Describe concretely what you observe about the material's color and texture, and separately state whether a diagonal seam or boundary between two different floor materials is visible ANYWHERE in the staged photo at all.

Respond with ONLY a single valid JSON object: {"materialDescription": string, "materialMatchesOriginalZone": boolean, "seamStillVisibleAnywhere": boolean}`;

async function askGemini(): Promise<string> {
  const original = toBase64(baselinePath);
  const staged = toBase64(stagedPath);
  const ai = getGeminiClient();
  const response: any = await (ai as any).models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT },
          { text: "Image A (original/baseline):" },
          { inlineData: { mimeType: original.mime, data: original.data } },
          { text: "Image B (staged output):" },
          { inlineData: { mimeType: staged.mime, data: staged.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 1024, responseMimeType: "application/json" },
  });
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  return textPart?.text || "(no text)";
}

async function askGrok(): Promise<string> {
  const original = toBase64(baselinePath);
  const staged = toBase64(stagedPath);
  return grokAnalyzeImages({
    images: [
      { buffer: Buffer.from(original.data, "base64"), mimeType: original.mime, label: "Image A (original/baseline):" },
      { buffer: Buffer.from(staged.data, "base64"), mimeType: staged.mime, label: "Image B (staged output):" },
    ],
    prompt: PROMPT,
    jobId: "flooring-locate-describe-test",
    imageId: "flooring-locate-describe-test",
    reason: "flooring_locate_describe_exploratory",
    expectJson: true,
  });
}

async function main() {
  console.log("=== GEMINI run 1 ===");
  console.log(await askGemini());
  console.log("\n=== GEMINI run 2 ===");
  console.log(await askGemini());

  console.log("\n\n=== GROK run 1 ===");
  console.log(await askGrok());
  console.log("\n=== GROK run 2 ===");
  console.log(await askGrok());

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
