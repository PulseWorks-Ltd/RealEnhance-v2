// Live-API verification (image-quality fix, 2026-09-18): calls the REAL,
// just-modified enhanceWithGemini() directly for the new exterior Stage 1A
// path (Gemini 3 Pro Image + imageConfig 2K), to confirm (a) the model
// actually respects imageSize, (b) aspect-ratio bucketing doesn't visibly
// crop the shot, and (c) the fallback-on-bad-model-name path engages
// correctly. Small number of real API calls, by design.
import path from "path";
import fs from "fs";
import sharp from "sharp";

function loadDotEnvIfPresent(envPath: string) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadDotEnvIfPresent(path.resolve(__dirname, "../../.env"));

import { enhanceWithGemini } from "../ai/gemini";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO_ROOT, "Test Images/Web App Images/Example Exterior Image 01.jpg");
const OUT_DIR = path.join(REPO_ROOT, ".tmp-exterior-gemini3-check");

async function runOne(label: string, opts: { sceneType: "interior" | "exterior"; envOverrides?: Record<string, string> }) {
  const prevEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts.envOverrides || {})) {
    prevEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const outputPath = path.join(OUT_DIR, `out-${label}.webp`);
  console.log(`\n=== ${label} (sceneType=${opts.sceneType}) ===`);
  try {
    const result = await enhanceWithGemini(SRC, {
      stage: "1A",
      sceneType: opts.sceneType,
      jobId: `verify-ext-${label}`,
      imageId: `verify-ext-${label}`,
      roomType: undefined,
      modelReason: `verification-script:${label}`,
      outputPath,
    });
    if (result && result !== SRC && fs.existsSync(result)) {
      const finalOut = path.join(OUT_DIR, `${label}.webp`);
      fs.copyFileSync(result, finalOut);
      const meta = await sharp(finalOut).metadata();
      console.log(`  -> dimensions: ${meta.width}x${meta.height} (source was 935x832) saved=${finalOut}`);
    } else {
      console.log(`  -> WARNING: no new file produced (result === input or missing)`);
    }
  } catch (err: any) {
    console.error(`  -> ERROR: ${err?.message || err}`);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const srcMeta = await sharp(SRC).metadata();
  console.log("Source dimensions:", srcMeta.width, "x", srcMeta.height);

  // 1. Exterior -> should now route to gemini-3-pro-image-preview + imageConfig 2K.
  await runOne("1-exterior-gemini3-2k", { sceneType: "exterior" });

  // 2. Interior (same photo, forced sceneType) -> should be byte-for-byte the
  //    old code path: Gemini 2.5, no imageConfig. Confirms the branch really
  //    is scene-conditional and interior is untouched.
  await runOne("2-interior-unchanged-gemini25", { sceneType: "interior" });

  // 3. Exterior + 4K tier, for a quality/cost ceiling comparison.
  await runOne("3-exterior-gemini3-4k", {
    sceneType: "exterior",
    envOverrides: { REALENHANCE_STAGE1A_EXTERIOR_IMAGE_SIZE: "4K" },
  });

  // 4. Exterior + kill switch -> should behave identically to run #2's engine
  //    (Gemini 2.5, no imageConfig), confirming the kill switch works.
  await runOne("4-exterior-killswitch", {
    sceneType: "exterior",
    envOverrides: { STAGE1A_DISABLE_EXTERIOR_GEMINI3: "1" },
  });

  // 5. Fallback drill: point the exterior primary model at an invalid name to
  //    confirm runWithPrimaryThenFallback actually falls back to Gemini 2.5.
  await runOne("5-exterior-fallback-drill", {
    sceneType: "exterior",
    envOverrides: { REALENHANCE_MODEL_STAGE1A_EXTERIOR_PRIMARY: "gemini-nonexistent-model-xyz" },
  });
}

main().then(() => {
  console.log("\nDone.");
  process.exit(0);
}).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
