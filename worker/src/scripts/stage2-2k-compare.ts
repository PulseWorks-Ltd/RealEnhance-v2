import path from "path";
import fs from "fs";
import sharp from "sharp";

const ROOT = path.resolve(__dirname, "../../..");
const T = path.join(ROOT, "Test Images");
const OUT = path.join(T, "Stage2_2K_Comparison");
const IMAGES: Array<{ name: string; file: string; roomType: string }> = [
  { name: "Living07", file: "Living (Baseline)/Living 07.jpg", roomType: "living_room" },
  { name: "Living10", file: "Living (Baseline)/Living 10.jpg", roomType: "living_room" },
  { name: "Diningroom01", file: "Living (Baseline)/Diningroom 01.webp", roomType: "dining_room" },
  { name: "Validator_2327860184", file: "Validator Testing Images/2327860184.jpg", roomType: "living_room" },
  { name: "Bedroom14", file: "Validator Testing Images/Bedroom 14.jpg", roomType: "bedroom" },
  { name: "Bedroom12", file: "Validator Testing Images/job_59ac76ce_Bedroom_12_UPLOAD.jpg", roomType: "bedroom" },
];
const MODELS = (process.env.MODELS || "gemini-3.1-flash-image,gemini-nano-banana-2.1").split(",");

async function main() {
  process.env.USE_GEMINI_STAGE2 = "1";
  const { runStage2GenerationAttempt } = await import("../pipeline/stage2");
  fs.mkdirSync(OUT, { recursive: true });
  const rows: any[] = [];
  const only = process.env.ONLY;
  for (const model of MODELS) {
    process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = model;
    process.env.REALENHANCE_STAGE2_IMAGE_SIZE = "2K";
    for (const img of IMAGES) {
      if (only && !img.name.includes(only)) continue;
      const src = path.join(T, img.file);
      const input = path.join(OUT, `${img.name}__input${path.extname(src)}`);
      fs.copyFileSync(src, input);
      const out = path.join(OUT, `${img.name}__${model}.webp`);
      const t0 = Date.now();
      let row: any = { image: img.name, model };
      try {
        await runStage2GenerationAttempt(input, {
          roomType: img.roomType, sceneType: "interior", promptMode: "full", sourceStage: "1A",
          stagingStyle: "nz_standard", jobId: `cmp_${model}`, imageId: img.name, outputPath: out, attempt: 1,
        });
        const m = await sharp(out).metadata();
        const im = await sharp(input).metadata();
        row = { ...row, ok: true, inW: im.width, inH: im.height, outW: m.width, outH: m.height, sec: (Date.now() - t0) / 1000 };
      } catch (e: any) {
        row = { ...row, ok: false, error: String(e?.message || e).slice(0, 300), sec: (Date.now() - t0) / 1000 };
      }
      console.log("RESULT", JSON.stringify(row));
      rows.push(row);
    }
  }
  fs.writeFileSync(path.join(OUT, `results_${Date.now()}.json`), JSON.stringify(rows, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
