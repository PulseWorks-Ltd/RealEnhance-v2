// Standalone, one-off test of the PROPOSED fourth question dimension
// (not implemented in occlusionVsRemovalCheck.ts or anywhere in
// production) — does directly asking about size/position, rather than
// only presence/coverage, actually elicit awareness of Bedroom 09's real
// W1 resize? Real API calls, both models, no changes to any validator
// file. This exists purely to answer the empirical question "would Grok
// catch it if asked" rather than speculate.
import path from "path";
import { toBase64 } from "../worker/src/utils/images";
import { getGeminiClient } from "../worker/src/ai/gemini";
import { grokAnalyzeImages } from "../worker/src/ai/grok";

const REPO_ROOT = path.resolve(__dirname, "..");
const baselinePath = path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)/Bedroom 09.jpg");
const stagedPath = path.join(REPO_ROOT, "Test Images/Bedroom (Staged)/Bedroom 09 (Enhanced).webp");

// W1's real baseline bbox, from tonight's actual extraction.
const W1_BBOX = { x1: 0.048, y1: 0.231, x2: 0.485, y2: 0.551 };

const PROMPT = `You are comparing an ORIGINAL (baseline) room photo against a STAGED (furnished) version of the same room.

There is a window in the ORIGINAL photo at approximately this region: x: ${W1_BBOX.x1.toFixed(3)}-${W1_BBOX.x2.toFixed(3)}, y: ${W1_BBOX.y1.toFixed(3)}-${W1_BBOX.y2.toFixed(3)} (normalized fractions of image width/height, 0,0 = top-left). It is a large white-framed sliding window on the left wall.

Looking at the STAGED image, describe the CURRENT visible extent of this same window — where do its own edges (frame top/bottom/left/right) actually fall now, compared to that original region? Does it occupy roughly the same footprint and shape, or is it visibly larger, smaller, taller, wider, more square, or shifted in position along the wall relative to the original region? Describe concretely what you observe about its size, shape, and position — do not just answer "changed" or "unchanged," and do not discuss whether it is obstructed by furniture; only its own size/shape/position.

Respond with ONLY a single valid JSON object: {"extentComparisonDescription": string, "appearsResized": boolean, "appearsRepositioned": boolean}`;

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
    jobId: "resize-direct-test",
    imageId: "resize-direct-test",
    reason: "resize_direct_question_test",
    expectJson: true,
  });
}

async function main() {
  console.log("=== GEMINI, direct size/position question ===");
  const g1 = await askGemini();
  console.log(g1);
  console.log("\n=== GEMINI, run 2 ===");
  const g2 = await askGemini();
  console.log(g2);

  console.log("\n\n=== GROK, direct size/position question ===");
  const x1 = await askGrok();
  console.log(x1);
  console.log("\n=== GROK, run 2 ===");
  const x2 = await askGrok();
  console.log(x2);

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
