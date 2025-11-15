import path from "path";
import fs from "fs";
import sharp from "sharp";
import { validateStage } from "../ai/unified-validator";

async function ensureTestImage(): Promise<string> {
  const testImage = path.join(__dirname, "..", "..", "test-data", "test-room.jpg");
  if (!fs.existsSync(testImage)) {
    console.log("Downloading sample test image...");
    fs.mkdirSync(path.dirname(testImage), { recursive: true });
    const resp = await fetch("https://source.unsplash.com/random/1600x1066/?empty+room");
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(testImage, buffer);
    console.log(`Saved to ${testImage}`);
  }
  return testImage;
}

async function makeSharpBaseline(input: string): Promise<string> {
  const out = input.replace(/\.(jpg|jpeg|png|webp)$/i, "-baseline.jpg");
  await sharp(input)
    .rotate()
    .median(3)
    .normalize()
    .modulate({ brightness: 1.08, saturation: 1.12 })
    .jpeg({ quality: 92 })
    .toFile(out);
  return out;
}

async function makeCandidateFromBaseline(baseline: string): Promise<string> {
  // Intentionally change dimensions slightly and tweak brightness/contrast
  const meta = await sharp(baseline).metadata();
  const w = Math.max(64, (meta.width || 0) - 20);
  const h = Math.max(64, (meta.height || 0) - 10);
  const out = baseline.replace(/-baseline\.jpg$/, "-candidate.jpg");
  await sharp(baseline)
    .resize({ width: w, height: h, fit: "cover" })
    .modulate({ brightness: 1.05, saturation: 1.08 })
    .sharpen({ sigma: 0.8 })
    .jpeg({ quality: 90 })
    .toFile(out);
  return out;
}

async function main() {
  process.env.STAGE1A_DEBUG = process.env.STAGE1A_DEBUG || "1";
  // Relaxed defaults we expect to pass under the new two-signal rule
  process.env.LOCAL_EDGE_SIM_HARD_MIN_1A_INTERIOR = process.env.LOCAL_EDGE_SIM_HARD_MIN_1A_INTERIOR || "0.30";
  process.env.LOCAL_EDGE_SIM_EXTREME_MIN_1 = process.env.LOCAL_EDGE_SIM_EXTREME_MIN_1 || "0.20";
  process.env.LOCAL_BRIGHT_DIFF_HARD_MAX_1A_INTERIOR = process.env.LOCAL_BRIGHT_DIFF_HARD_MAX_1A_INTERIOR || "0.08";
  process.env.LOCAL_EDGE_DILATE_RADIUS = process.env.LOCAL_EDGE_DILATE_RADIUS || "2";

  const img = await ensureTestImage();
  let baseline: string;
  let candidate: string;
  try {
    baseline = await makeSharpBaseline(img);
    candidate = await makeCandidateFromBaseline(baseline);
  } catch (e) {
    console.warn("Image encode not available in this environment; falling back to copy test.");
    baseline = img;
    candidate = img.replace(/\.(jpg|jpeg|png|webp)$/i, "-copy.jpg");
    fs.copyFileSync(img, candidate);
  }

  console.log("Baseline:", baseline);
  console.log("Candidate:", candidate);

  const verdict = await validateStage(
    { stage: "1A", path: baseline },
    { stage: "1A", path: candidate },
    { sceneType: "interior" }
  );

  console.log("Validation verdict:", verdict);
  if (!verdict.ok) {
    console.error("Validator flagged candidate:", verdict.reasons?.join("; "));
    process.exitCode = 2;
  } else {
    console.log("Validator passed as expected with new thresholds.");
  }
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
