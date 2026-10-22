import fs from "fs";
import path from "path";
import sharp from "sharp";
import { generateContentViaRest } from "../ai/geminiRestClient";
const D = path.resolve(__dirname, "../../../Test Images/Stage2_Downlight");
const PROMPTS: Record<string, string> = {
  FULL: fs.readFileSync(path.join(D, "prod_prompt.txt"), "utf8"),
  M1: "Virtually stage this empty bedroom with a bed, bedside tables and a rug. Return the edited photo.",
  M2: "Virtually stage this empty bedroom with a bed, bedside tables and a rug. Do not change anything else. The ceiling has exactly one small downlight; do not add any other light to the ceiling. Return the edited photo.",
  M3: "Return this exact photo unchanged, except place a bed in the room.",
};
(async () => {
  const data = fs.readFileSync(path.join(D, "bedroom_input.png")).toString("base64");
  const tags = (process.env.TAGS || "M1,M2,M3").split(",");
  const N = Number(process.env.N || 6);
  await Promise.all(tags.flatMap((t) => Array.from({ length: N }, async (_, i) => {
    try {
      const resp = await generateContentViaRest({
        apiKey: String(process.env.GEMINI_API_KEY), model: process.env.MODEL || "gemini-2.5-flash-image",
        body: { contents: [{ text: PROMPTS[t] }, { inlineData: { mimeType: "image/png", data } }], generationConfig: { temperature: 0.4, topP: 0.9, topK: 40, ...(process.env.MODEL?.includes("2.5") || !process.env.MODEL ? {} : { imageConfig: { imageSize: "2K", aspectRatio: "3:4" } }) } },
        timeoutMs: 200000,
      });
      const img = resp.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
      if (!img) { console.log("RESULT", t, i, "NOIMAGE"); return; }
      await sharp(Buffer.from(img.inlineData.data, "base64")).jpeg({ quality: 88 }).toFile(path.join(D, `${t}${process.env.SUFFIX || ""}_${i}.jpg`));
      console.log("RESULT", t, i, "ok");
    } catch (e: any) { console.log("RESULT", t, i, "ERR", String(e.message).slice(0, 100)); }
  })));
})();
