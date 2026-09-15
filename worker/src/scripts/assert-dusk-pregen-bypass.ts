/**
 * Zero-cost verification of the dusk-mode deterministic pre-Gemini bypass
 * (worker/src/pipeline/stage1A.ts, runStage1A) — Stage 1A Exterior
 * Enhancement's "Twilight / Dusk Photo" checkbox.
 *
 * Uses the same Gemini-failure-fallback trick as measure-stage1a-pregen.ts:
 * runStage1A always writes a deterministic pre-Gemini `-1A-sharp.webp`
 * artifact before ever calling Gemini, so stripping the API key and reading
 * that sidecar directly measures the tone stack in isolation, at zero cost.
 *
 * Runs a real exterior fixture through runStage1A twice — duskMode: false
 * and duskMode: true — and asserts:
 *  - duskMode: false still applies the normal brighten/neutralize tone stack
 *    (this fixture is an overcast/dim exterior, so some lift is expected) —
 *    proving the dusk feature didn't change existing non-dusk behavior.
 *  - duskMode: true does NOT raise mean luminance beyond the input (no
 *    brightening applied).
 *  - duskMode: true preserves the input's per-channel R/G/B mean ratios far
 *    more closely than duskMode: false does — proving the neutral
 *    white-balance re-anchor and tone-stack modulate were actually skipped,
 *    not just gated on a threshold that happened not to fire.
 *
 * Usage: tsx src/scripts/assert-dusk-pregen-bypass.ts
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runStage1A } from "../pipeline/stage1A";

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

// Force the zero-cost Gemini-failure fallback path — measures the
// pre-Gemini deterministic math only, same as measure-stage1a-pregen.ts.
delete process.env.GEMINI_API_KEY;
delete process.env.REALENHANCE_API_KEY;

const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURE = path.join(REPO_ROOT, "Test Images/Web App Images/Example Exterior Image 01.jpg");

type ChannelStats = { mean: number[]; grey: number };

async function measure(imagePath: string): Promise<ChannelStats> {
  const img = sharp(imagePath).rotate().removeAlpha();
  const stats = await img.clone().stats();
  const mean = stats.channels.slice(0, 3).map((c) => c.mean);
  const greyStats = await img.clone().greyscale().stats();
  return { mean, grey: greyStats.channels[0]?.mean ?? 0 };
}

// How far the R/G/B channel means have drifted apart, relative to their own
// average — a proxy for "how much has white balance / color grading shifted
// this image away from its original color relationships". Lower = closer to
// the input's own channel balance.
function channelSpreadDelta(a: ChannelStats, b: ChannelStats): number {
  const ratiosA = [a.mean[0] / a.grey, a.mean[1] / a.grey, a.mean[2] / a.grey];
  const ratiosB = [b.mean[0] / b.grey, b.mean[1] / b.grey, b.mean[2] / b.grey];
  return Math.sqrt(ratiosA.reduce((sum, r, i) => sum + (r - ratiosB[i]) ** 2, 0));
}

async function runOnce(scratchDir: string, duskMode: boolean): Promise<ChannelStats> {
  const workingCopy = path.join(scratchDir, `input-dusk-${duskMode}.jpg`);
  await fsp.copyFile(FIXTURE, workingCopy);
  const sharpSidecarPath = workingCopy.replace(/\.(jpg|jpeg|png|webp)$/i, "-1A-sharp.webp");

  let outputPath: string | undefined;
  try {
    outputPath = await runStage1A(workingCopy, {
      jobId: "assert-dusk-pregen-bypass",
      imageId: `dusk-${duskMode}`,
      sceneType: "exterior",
      declutter: false,
      duskMode,
    });
  } catch (err) {
    if (fs.existsSync(sharpSidecarPath)) {
      outputPath = sharpSidecarPath;
    } else {
      throw err;
    }
  }
  return measure(outputPath);
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture not found: ${FIXTURE}`);
    process.exit(1);
  }

  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dusk-pregen-bypass-"));
  console.log(`Working files in: ${scratchDir}\n`);

  const input = await measure(FIXTURE);
  const daylightOut = await runOnce(scratchDir, false);
  const duskOut = await runOnce(scratchDir, true);

  console.log(`input        grey=${input.grey.toFixed(1)} rgb=[${input.mean.map((v) => v.toFixed(1)).join(", ")}]`);
  console.log(`duskMode=false grey=${daylightOut.grey.toFixed(1)} rgb=[${daylightOut.mean.map((v) => v.toFixed(1)).join(", ")}]`);
  console.log(`duskMode=true  grey=${duskOut.grey.toFixed(1)} rgb=[${duskOut.mean.map((v) => v.toFixed(1)).join(", ")}]`);

  let anyFailure = false;
  function check(name: string, pass: boolean, detail?: string) {
    if (!pass) anyFailure = true;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  }

  // This fixture is an overcast/dim exterior — the existing (non-dusk) tone
  // stack should still lift it somewhat, proving non-dusk behavior is intact.
  check(
    "daylight_path_still_brightens_dim_exterior",
    daylightOut.grey >= input.grey,
    `input=${input.grey.toFixed(1)} daylightOut=${daylightOut.grey.toFixed(1)}`
  );

  // Dusk mode must not brighten the frame at all.
  check(
    "dusk_path_does_not_brighten",
    duskOut.grey <= input.grey + 1,
    `input=${input.grey.toFixed(1)} duskOut=${duskOut.grey.toFixed(1)}`
  );

  // Dusk mode must preserve the input's channel-color relationships far more
  // closely than the daylight path does (proves neutral-balance + tone-stack
  // modulate were actually skipped, not just below-threshold).
  const daylightSpread = channelSpreadDelta(input, daylightOut);
  const duskSpread = channelSpreadDelta(input, duskOut);
  check(
    "dusk_path_preserves_channel_balance_better_than_daylight_path",
    duskSpread < daylightSpread,
    `daylightSpread=${daylightSpread.toFixed(4)} duskSpread=${duskSpread.toFixed(4)}`
  );
  check("dusk_path_channel_balance_near_identical_to_input", duskSpread < 0.01, `duskSpread=${duskSpread.toFixed(4)}`);

  console.log(`\n${anyFailure ? "RESULT: one or more checks failed." : "RESULT: all checks passed."}`);
  process.exit(anyFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
