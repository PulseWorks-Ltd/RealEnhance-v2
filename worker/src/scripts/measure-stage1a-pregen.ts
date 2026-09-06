/**
 * Zero-cost measurement of the Stage 1A deterministic pre-Gemini tone stack.
 *
 * `runStage1A` writes a `<input>-1A-sharp.webp` pre-gen artifact before it
 * ever calls Gemini. When the Gemini call fails (e.g. no API key configured),
 * the fallback path renames that exact file to the final `-1A.webp` output.
 * This script deliberately strips any Gemini key so every run takes that
 * fallback, letting us measure the effect of the deterministic tone stack
 * (the STAGE1A_DARKNESS_ONSET / STAGE1A_DARKNESS_SPAN change) in isolation,
 * at zero API cost, before ever involving the model.
 *
 * Usage:
 *   tsx src/scripts/measure-stage1a-pregen.ts [dir1] [dir2] ...
 *   (defaults to a few real fixture folders under Test Images/ if none given)
 *
 * Env overrides are honoured (loaded from worker/.env if present), so this
 * can be used to A/B the new STAGE1A_DARKNESS_ONSET / STAGE1A_DARKNESS_SPAN
 * constants, e.g.:
 *   STAGE1A_DARKNESS_ONSET=95 STAGE1A_DARKNESS_SPAN=50 tsx src/scripts/measure-stage1a-pregen.ts
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runStage1A } from "../pipeline/stage1A";

// The worker package does not depend on `dotenv` (env vars are injected
// directly by the platform in production). Load worker/.env here with a
// minimal parser so this script picks up the same STAGE1A_* configuration
// the real worker process uses.
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

// Force the zero-cost Gemini-failure fallback path regardless of what's
// configured in .env — this script measures the pre-Gemini math only.
delete process.env.GEMINI_API_KEY;
delete process.env.REALENHANCE_API_KEY;

// Resolved relative to the repo root (worker/src/scripts -> ../../../) rather
// than process.cwd(), so this works the same whether invoked from the repo
// root or from worker/ (e.g. via `pnpm --filter @realenhance/worker run ...`).
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_DIRS = [
  path.join(REPO_ROOT, "Test Images/Bedroom (Baseline)"),
  path.join(REPO_ROOT, "Test Images/Living (Baseline)"),
  path.join(REPO_ROOT, "Test Images/Kitchen"),
];

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
// Regression-alert threshold: highlight-clipping growth beyond this many
// percentage points on any single image should trip a review of the gamma
// coefficient / darkness constants before shipping.
const MAX_CLIPPING_GROWTH_PCT = 1.0;

async function findImages(dirs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const dir of dirs) {
    const abs = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(abs)) {
      console.warn(`[skip] directory not found: ${abs}`);
      continue;
    }
    const entries = await fsp.readdir(abs);
    for (const entry of entries) {
      if (IMAGE_EXT.test(entry)) {
        found.push(path.join(abs, entry));
      }
    }
  }
  return found;
}

type ToneStats = {
  lumMean: number;
  clippedFraction: number; // pixels >= 250
  blackAnchorFraction: number; // pixels <= 5
};

async function measure(imagePath: string): Promise<ToneStats> {
  const img = sharp(imagePath).rotate().removeAlpha().greyscale();
  const stats = await img.clone().stats();
  const lumMean = stats.channels[0]?.mean ?? 0;

  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  let clipped = 0;
  let blackAnchor = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] >= 250) clipped += 1;
    if (data[i] <= 5) blackAnchor += 1;
  }

  return {
    lumMean,
    clippedFraction: data.length ? (clipped / data.length) * 100 : 0,
    blackAnchorFraction: data.length ? (blackAnchor / data.length) * 100 : 0,
  };
}

async function main() {
  const argDirs = process.argv.slice(2);
  const dirs = argDirs.length ? argDirs : DEFAULT_DIRS;
  const images = await findImages(dirs);

  if (!images.length) {
    console.error("No images found. Pass one or more directories as arguments.");
    process.exit(1);
  }

  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "stage1a-pregen-"));
  console.log(`Working copies + outputs written to: ${scratchDir}\n`);

  const rows: Array<{
    name: string;
    inputLum: number;
    outputLum: number;
    liftPct: number;
    inputClip: number;
    outputClip: number;
    clipGrowth: number;
    outputBlackAnchor: number;
  }> = [];

  for (const imagePath of images) {
    const base = path.basename(imagePath);
    const workingCopy = path.join(scratchDir, base);
    await fsp.copyFile(imagePath, workingCopy);

    const before = await measure(workingCopy);

    // runStage1A writes the deterministic pre-Gemini artifact to this exact
    // sidecar path unconditionally, before it ever calls Gemini — so it's
    // available regardless of how the (deliberately broken) Gemini call
    // below resolves. A missing API key throws a fatal error rather than
    // going through the soft-failure rename-to-final path, so we read the
    // sidecar directly instead of relying on runStage1A's return value.
    const sharpSidecarPath = workingCopy.replace(/\.(jpg|jpeg|png|webp)$/i, "-1A-sharp.webp");

    let outputPath: string | undefined;
    try {
      outputPath = await runStage1A(workingCopy, {
        jobId: "measure-stage1a-pregen",
        imageId: base,
        sceneType: "interior",
        declutter: false,
      });
    } catch (err) {
      if (fs.existsSync(sharpSidecarPath)) {
        outputPath = sharpSidecarPath;
      } else {
        console.error(`[error] ${base}: ${(err as Error).message}`);
        continue;
      }
    }

    const after = await measure(outputPath);
    const liftPct = before.lumMean > 0 ? ((after.lumMean - before.lumMean) / before.lumMean) * 100 : 0;
    const clipGrowth = after.clippedFraction - before.clippedFraction;

    rows.push({
      name: base,
      inputLum: before.lumMean,
      outputLum: after.lumMean,
      liftPct,
      inputClip: before.clippedFraction,
      outputClip: after.clippedFraction,
      clipGrowth,
      outputBlackAnchor: after.blackAnchorFraction,
    });
  }

  console.log(
    "name".padEnd(36),
    "in lumMean".padStart(11),
    "out lumMean".padStart(12),
    "lift %".padStart(8),
    "clip growth pp".padStart(16),
    "black anchor %".padStart(15)
  );
  let anyRegression = false;
  for (const row of rows) {
    const flag = row.clipGrowth > MAX_CLIPPING_GROWTH_PCT ? "  <-- REVIEW" : "";
    if (flag) anyRegression = true;
    console.log(
      row.name.padEnd(36),
      row.inputLum.toFixed(1).padStart(11),
      row.outputLum.toFixed(1).padStart(12),
      row.liftPct.toFixed(1).padStart(8),
      row.clipGrowth.toFixed(2).padStart(16),
      row.outputBlackAnchor.toFixed(2).padStart(15) + flag
    );
  }

  console.log(
    `\nAcceptance: highlight-clipping growth must stay <= ${MAX_CLIPPING_GROWTH_PCT} percentage point(s) on every image.`
  );
  console.log(anyRegression ? "RESULT: one or more images exceeded the clipping budget — review before shipping." : "RESULT: within budget on all images.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
