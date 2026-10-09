import fs from "fs";
import path from "path";
import sharp from "sharp";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";
import { generateContentViaRest } from "../ai/geminiRestClient";

const D = path.resolve(__dirname, "../../../Test Images/Exterior_Repro");
const input = path.join(D, "input.png");

async function run(label: string, model: string, prompt: string, imageFirst = true) {
  const data = fs.readFileSync(input).toString("base64");
  const parts: any[] = imageFirst
    ? [{ inlineData: { mimeType: "image/png", data } }, { text: prompt }]
    : [{ text: prompt }, { inlineData: { mimeType: "image/png", data } }];
  const t0 = Date.now();
  const resp = await generateContentViaRest({
    apiKey: String(process.env.GEMINI_API_KEY),
    model,
    body: { contents: parts, generationConfig: { temperature: 0, topP: Number(process.env.TOPP || 0.25), topK: 40, ...(model.includes("2.5") ? {} : { imageConfig: { imageSize: "2K", aspectRatio: "4:3" } }) } },
    timeoutMs: 240000,
  });
  const img = resp.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!img) { console.log("RESULT", label, "NO IMAGE", JSON.stringify(resp).slice(0, 300)); return; }
  const out = path.join(D, `${label}.jpg`);
  await sharp(Buffer.from(img.inlineData.data, "base64")).jpeg({ quality: 90 }).toFile(out);
  const m = await sharp(out).metadata();
  console.log("RESULT", label, model, m.width, m.height, (Date.now() - t0) / 1000, JSON.stringify(resp.usageMetadata));
}

(async () => {
  const base = buildStage1APromptNZStyle("room", "exterior", false);
  fs.writeFileSync(path.join(D, "prompt_current.txt"), base);
  const which = (process.env.VARIANTS || "A").split(",");
  for (const v of which) {
    if (v === "A") await run("A_3pro_current", "gemini-3-pro-image-preview", base);
    if (v === "O") {
    }
    if (v.startsWith("P")) await run(`${v}_3pro_topP025`, "gemini-3-pro-image-preview", base);
    if (v === "F") await run("F_2.5flash_current", "gemini-2.5-flash-image", base);
    if (v === "C") await run("C_3.1flash_current", "gemini-3.1-flash-image", base);
    if (v === "B") {
      const p = fs.readFileSync(path.join(D, "prompt_B.txt"), "utf8");
      await run("B_3pro_tightened", "gemini-3-pro-image-preview", p);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
