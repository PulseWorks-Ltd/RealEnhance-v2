// Standalone live test of a dedicated, narrowly-scoped "find curtain-like
// fabric that might be concealing a window" observation call — separate
// from the (failed) attempt to bury this instruction inside the big
// structural-baseline extraction system prompt. Tests directly against the
// real repro image before this gets wired into the actual pipeline.
process.env.OPENING_BASELINE_SINGLE_PASS = "1";
import path from "node:path";
import { toBase64 } from "../worker/src/utils/images";
import { getGeminiClient } from "../worker/src/ai/gemini";

const SYSTEM_INSTRUCTION = `You are inspecting a single interior room photo for curtain-like fabric window coverings that might be hiding a window.

Look at every wall in the image. For each distinct piece of curtain-like fabric you see — this includes full-length drapery, short valances, roman blinds, or any rod/track-mounted fabric panel hanging flat against a wall — report it, REGARDLESS of whether you can see any window frame, glass, or light behind/around it. Size does not matter: a small curtain panel counts exactly the same as a large floor-length one.

Do NOT include: framed pictures/art, mirrors, tapestries or quilts hung flat with no rod/track and no fabric drape, flags, or curtains that are clearly hanging across a doorway/walkthrough between rooms rather than against a wall.

For each curtain-like item found, report:
- location: which wall (e.g. "wall behind the bed headboard", "right wall") and roughly where on it
- bbox: [x1,y1,x2,y2] normalized 0-1 (0,0 = top-left)
- visualDescription: exactly what it looks like (pattern, color, how it hangs)
- windowEvidenceVisible: true if you can see any window frame, glass pane, or daylight on any side of this curtain; false if the curtain fully covers the area with no such evidence visible
- isFunctionalCurtain: true if this genuinely looks like a functional window curtain/blind (has a rod/track, drapes or hangs the way fabric does under gravity); false if it's more likely pure decor (e.g. a flat fabric wall-hanging with no rod)

Respond with ONLY a single valid JSON object: {"curtains": [{"location": string, "bbox": [number,number,number,number], "visualDescription": string, "windowEvidenceVisible": boolean, "isFunctionalCurtain": boolean}]}`;

async function main() {
  const imagePath = path.resolve(
    __dirname,
    "../Test Images/Validator Testing Images/2 Valentine Street - Image 01.jpg"
  );
  const image = toBase64(imagePath);
  const ai = getGeminiClient();
  const startedAt = Date.now();
  const response: any = await (ai as any).models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      {
        role: "user",
        parts: [
          { text: SYSTEM_INSTRUCTION },
          { text: "Analyze this room image." },
          { inlineData: { mimeType: image.mime, data: image.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: 2048, responseMimeType: "application/json" },
  });
  console.log(`Latency: ${Date.now() - startedAt}ms`);
  const parts: any[] = response?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p: any) => typeof p?.text === "string");
  console.log("\n=== RAW RESPONSE ===");
  console.log(textPart?.text || "(no text)");

  const cleaned = String(textPart?.text || "{}").replace(/```json|```/gi, "").trim();
  const parsed = JSON.parse(cleaned);
  console.log("\n=== PARSED ===");
  console.log(JSON.stringify(parsed, null, 2));

  const curtains = parsed?.curtains || [];
  // Inclusion in the list already means the model judged it curtain-like
  // (rod/track-mounted fabric panel) per the system instruction's own
  // filter — isFunctionalCurtain is a redundant second-guess that real
  // testing showed flip-flops on borderline cases (e.g. a short valance
  // described as "hanging like art"). Given the asymmetric cost (a false
  // positive just means a real curtain stays unchanged in the output; a
  // false negative risks a real window being misrepresented as removable
  // wall space), don't let isFunctionalCurtain gate this — only whether
  // window evidence is visible matters.
  const concealing = curtains.filter((c: any) => c.windowEvidenceVisible === false);
  console.log(`\nTotal curtains reported: ${curtains.length}`);
  console.log(`Curtains classified as concealing (no window evidence, functional curtain): ${concealing.length}`);
  if (concealing.length > 0) {
    console.log("\n✅ Curtain-over-bed style concealment WAS detected by this dedicated call.");
  } else {
    console.log("\n❌ Still not detected — even the dedicated call missed it.");
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
