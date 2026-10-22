import fs from "fs";
import path from "path";
import sharp from "sharp";
import { buildLightDeclutterPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { generateContentViaRest } from "../ai/geminiRestClient";
const D = path.resolve(__dirname, "../../../Test Images/Exterior_Repro");
async function run(label: string, temperature: number) {
  const data = fs.readFileSync(path.join(D, "C_3.1flash_current.jpg")).toString("base64");
  const prompt = buildLightDeclutterPromptNZStyle("unknown", "exterior");
  try {
    const resp = await generateContentViaRest({
      apiKey: String(process.env.GEMINI_API_KEY), model: "gemini-3-pro-image-preview",
      body: { contents: [{ inlineData: { mimeType: "image/jpeg", data } }, { text: prompt }], ...(temperature < 0 ? {} : { generationConfig: { temperature, topP: 0.7, topK: 30 } }) },
      timeoutMs: 240000,
    });
    const img = resp.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!img) { console.log("RESULT", label, "NO IMAGE"); return; }
    const out = path.join(D, `${label}.jpg`);
    await sharp(Buffer.from(img.inlineData.data, "base64")).jpeg({ quality: 90 }).toFile(out);
    const m = await sharp(out).metadata();
    console.log("RESULT", label, m.width, m.height);
  } catch (e: any) { console.log("RESULT", label, "ERR", String(e.message).slice(0, 200)); }
}
(async () => { await Promise.all(( [["1Bnew_a", 0.09], ["1Bnew_b", 0.09], ["1Bnew_c", 0.09], ["1Bnew_d", 0.09]] as const).map(([l, t]) => run(l, t))); })();
