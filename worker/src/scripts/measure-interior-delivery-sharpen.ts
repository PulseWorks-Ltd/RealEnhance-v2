// Zero-cost verification script (image-quality fix, 2026-09-18): no Gemini
// calls. Compares the OLD (hardcoded) vs NEW (retuned) interior post-finish
// sharpen and delivery-export sharpen/denoise parameters on real interior
// test images, and prints a Laplacian-variance sharpness/noise proxy plus
// saves both variants to disk for visual inspection.
//
// Run: npx tsx src/scripts/measure-interior-delivery-sharpen.ts
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { applyStage1APostGenerationFinish } from "../pipeline/stage1A-post-finish";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OUT_DIR = path.resolve(__dirname, "../../../.tmp-delivery-sharpen-check");

const SAMPLES = [
  path.join(REPO_ROOT, "Test Images/Kitchen/Karaka - Image 02 Baseline.jpg"),
  path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)"),
  path.join(REPO_ROOT, "Test Images/Living (Baseline)"),
];

function findFirstImage(p: string): string | null {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const entries = fs.readdirSync(p).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
    if (entries.length) return path.join(p, entries[0]);
  }
  return null;
}

// Laplacian-variance proxy: higher = more high-frequency energy (could be
// real detail OR noise/haloing — this script's job is to let a human look at
// both, this number is just a quick sanity signal on direction/magnitude).
async function laplacianVariance(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        -4 * data[i] +
        data[i - 1] + data[i + 1] + data[i - w] + data[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

async function simulateDeliveryExport(
  inputPath: string,
  variant: "old" | "new"
): Promise<Buffer> {
  const meta = await sharp(inputPath).metadata();
  const targetLongSide = 2048;
  const currentLongSide = Math.max(meta.width || 0, meta.height || 0);
  const shouldResize = currentLongSide < targetLongSide;
  const resizeOptions = (meta.width || 0) >= (meta.height || 0)
    ? { width: targetLongSide }
    : { height: targetLongSide };

  let pipeline = sharp(inputPath).rotate();

  if (shouldResize) {
    if (variant === "new") {
      pipeline = pipeline.median(3);
    }
    pipeline = pipeline.resize({ ...resizeOptions, fit: "inside", kernel: sharp.kernel.lanczos3, withoutEnlargement: false });
  }

  const m2 = variant === "old" ? 2.0 : (shouldResize ? 0.8 : 2.0);
  pipeline = pipeline
    .gamma(1.03)
    .sharpen({ sigma: 1.04, m1: 1.0, m2, x1: 2.0, y2: 10.0, y3: 20.0 })
    .modulate({ saturation: 1.03 });

  return pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const sample of SAMPLES) {
    const imagePath = findFirstImage(sample);
    if (!imagePath) {
      console.log(`[skip] no image found for ${sample}`);
      continue;
    }
    const label = path.basename(imagePath).replace(/[^a-z0-9.]+/gi, "_");
    console.log(`\n=== ${label} (${imagePath}) ===`);

    // applyStage1APostGenerationFinish derives its output path via a
    // `.webp` suffix swap, so it requires (and in production always gets,
    // since real Stage 1A output is webp) a .webp input — convert the
    // sample once so old/new calls don't collide on input===output.
    const webpInput = path.join(OUT_DIR, `${label}.source.webp`);
    await sharp(imagePath).webp({ quality: 96 }).toFile(webpInput);

    // --- Part A: stage1A-post-finish.ts interior sharpen, old vs new ---
    delete process.env.STAGE1A_POSTFINISH_SHARPEN_M2_INTERIOR;
    delete process.env.STAGE1A_POSTFINISH_DENOISE_ENABLED;
    process.env.STAGE1A_POSTFINISH_SHARPEN_M2_INTERIOR = "0.38"; // old hardcoded value
    process.env.STAGE1A_POSTFINISH_DENOISE_ENABLED = "0"; // old: no denoise
    const oldPostFinishPath = await applyStage1APostGenerationFinish(webpInput, {
      jobId: `verify-${label}-old`,
      sceneType: "interior",
    });
    const oldPostFinishBuf = fs.readFileSync(oldPostFinishPath);
    fs.copyFileSync(oldPostFinishPath, path.join(OUT_DIR, `${label}.postfinish-OLD.webp`));

    delete process.env.STAGE1A_POSTFINISH_SHARPEN_M2_INTERIOR; // new default 0.22
    delete process.env.STAGE1A_POSTFINISH_DENOISE_ENABLED; // new default enabled
    const newPostFinishPath = await applyStage1APostGenerationFinish(webpInput, {
      jobId: `verify-${label}-new`,
      sceneType: "interior",
    });
    const newPostFinishBuf = fs.readFileSync(newPostFinishPath);
    fs.copyFileSync(newPostFinishPath, path.join(OUT_DIR, `${label}.postfinish-NEW.webp`));

    const oldPfLap = await laplacianVariance(oldPostFinishBuf);
    const newPfLap = await laplacianVariance(newPostFinishBuf);
    console.log(`  post-finish laplacian-var: old=${oldPfLap.toFixed(1)} new=${newPfLap.toFixed(1)} (lower after denoise+softer sharpen is expected)`);

    // --- Part B: delivery-export resize+sharpen simulation, old vs new ---
    const oldDelivery = await simulateDeliveryExport(imagePath, "old");
    const newDelivery = await simulateDeliveryExport(imagePath, "new");
    fs.writeFileSync(path.join(OUT_DIR, `${label}.delivery-OLD.jpg`), oldDelivery);
    fs.writeFileSync(path.join(OUT_DIR, `${label}.delivery-NEW.jpg`), newDelivery);

    const oldDelLap = await laplacianVariance(oldDelivery);
    const newDelLap = await laplacianVariance(newDelivery);
    console.log(`  delivery-export laplacian-var: old=${oldDelLap.toFixed(1)} new=${newDelLap.toFixed(1)}`);
  }

  console.log(`\nAll variants written to ${OUT_DIR} — inspect visually (zoom to ~100%) to confirm reduced grain/haloing without an unacceptable softness loss.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
