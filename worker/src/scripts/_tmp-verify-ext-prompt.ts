import path from "path";
import fs from "fs";
import sharp from "sharp";
for (const line of fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[k] === undefined) process.env[k] = v;
}
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";
const SRC = process.argv[2]; const OUT = process.argv[3];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await enhanceWithGemini(SRC, {
    stage: "1A", sceneType: "exterior", replaceSky: true, jobId: "verify-ext-prompt2", imageId: "verify-ext-prompt2",
    promptOverride: buildStage1APromptNZStyle("room", "exterior"), temperature: 0, topP: 0.25, topK: 40,
    outputPath: path.join(OUT, "after.webp"),
  });
  await sharp(r).png().toFile(path.join(OUT, "after.png"));
  const a = await sharp(SRC).metadata(); const b = await sharp(r).metadata();
  console.log("DIMS before", a.width, a.height, "after", b.width, b.height);
})().catch(e => { console.error(e); process.exit(1); });
