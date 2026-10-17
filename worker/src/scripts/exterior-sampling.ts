import fs from "fs";
import path from "path";
import sharp from "sharp";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";
import { generateContentViaRest } from "../ai/geminiRestClient";

const D = path.resolve(__dirname, "../../../Test Images/Exterior_Repro/samples");
const INPUT = process.env.INPUT as string; // pregen-processed webp
const N = Number(process.env.N || 8);
const variant = process.env.VARIANT || "base";
fs.mkdirSync(D, { recursive: true });

function promptFor(v: string): string {
  const base = buildStage1APromptNZStyle("room", "exterior", false);
  if (v === "base" || v === "flash") return base;
  if (v === "v2") {
    const file = path.join(D, "../prompt_v2.txt");
    return fs.readFileSync(file, "utf8");
  }
  return base;
}
async function edge(buf: Buffer, w: number, h: number): Promise<Float32Array> {
  const { data } = await sharp(buf).resize(w, h, { fit: "fill" }).greyscale().blur(1.5).raw().toBuffer({ resolveWithObject: true });
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const gx = data[y * w + x + 1] - data[y * w + x - 1], gy = data[(y + 1) * w + x] - data[(y - 1) * w + x];
    g[y * w + x] = Math.hypot(gx, gy);
  }
  return g;
}
function ncc(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length;
  let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; n += x * y; da += x * x; db += y * y; }
  return n / Math.sqrt(da * db);
}
(async () => {
  const prompt = promptFor(variant);
  const inBuf = fs.readFileSync(INPUT);
  const W = 160, H = 120;
  const ein = await edge(inBuf, W, H);
  const data = inBuf.toString("base64");
  const mime = INPUT.endsWith(".webp") ? "image/webp" : "image/jpeg";
  await Promise.all(Array.from({ length: N }, async (_, i) => {
    try {
      const resp = await generateContentViaRest({
        apiKey: String(process.env.GEMINI_API_KEY), model: process.env.MODEL || "gemini-3-pro-image-preview",
        body: { contents: [{ inlineData: { mimeType: mime, data } }, { text: prompt }], generationConfig: { temperature: 0, topP: 0.25, topK: 40, imageConfig: { imageSize: "2K", aspectRatio: "4:3" } } },
        timeoutMs: 240000,
      });
      const img = resp.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
      if (!img) { console.log("RESULT", variant, i, "NOIMAGE"); return; }
      const buf = Buffer.from(img.inlineData.data, "base64");
      const out = path.join(D, `${variant}_${i}.jpg`);
      await sharp(buf).resize({ height: 450 }).jpeg({ quality: 85 }).toFile(out);
      console.log("RESULT", variant, i, "ncc=" + ncc(ein, await edge(buf, W, H)).toFixed(3));
    } catch (e: any) { console.log("RESULT", variant, i, "ERR", String(e.message).slice(0, 120)); }
  }));
})();
