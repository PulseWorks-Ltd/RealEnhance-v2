import path from "path";
import fs from "fs";
const D = path.resolve(__dirname, "../../../Test Images/Stage2_Downlight");
async function main() {
  process.env.USE_GEMINI_STAGE2 = "1";
  const { runStage2GenerationAttempt } = await import("../pipeline/stage2");
  const tag = process.env.TAG || "base";
  const n = Number(process.env.N || 4);
  const src = path.join(D, process.env.SRC || "bedroom_input.png");
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    const input = path.join(D, `${tag}_${i}__in.png`);
    fs.copyFileSync(src, input);
    const out = path.join(D, `${tag}_${i}.webp`);
    try {
      await runStage2GenerationAttempt(input, {
        roomType: "bedroom", sceneType: "interior", promptMode: "full", sourceStage: "1A",
        stagingStyle: "nz_standard", jobId: `rep_${tag}_${i}`, imageId: `rep_${tag}_${i}`, outputPath: out, attempt: 1,
      });
      console.log("RESULT", tag, i, "ok");
    } catch (e: any) { console.log("RESULT", tag, i, "ERR", String(e?.message).slice(0, 150)); }
  }));
}
main();
