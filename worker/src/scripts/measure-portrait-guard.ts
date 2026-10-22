/**
 * Zero-cost verification of normalizePortraitImageForGemini (worker/src/utils/images.ts) —
 * reinstated from commit 0245366b ("Portrait Image Tiling Fix 1", never
 * merged into main/this branch) and generalized to cover Stage 1A, 1B, and 2.
 *
 * No real photo in Test Images/ happens to be a portrait taller than the
 * default 2048px threshold, so this synthesizes controlled canvases
 * straddling the boundary with sharp directly, plus checks a real landscape
 * fixture and the real (but only mildly portrait, 1728x2304) Chessboard
 * incident file as a sanity check.
 *
 * Usage: tsx src/scripts/measure-portrait-guard.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { normalizePortraitImageForGemini } from "../utils/images";

async function makeFlatCanvas(filePath: string, width: number, height: number): Promise<void> {
  await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 130, b: 140 } },
  })
    .jpeg({ quality: 90 })
    .toFile(filePath);
}

async function run() {
  const scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "portrait-guard-"));
  console.log(`Working files in: ${scratchDir}\n`);

  const cases: Array<{ name: string; width: number; height: number; expectApplied: boolean }> = [
    { name: "well_under_threshold_portrait", width: 1000, height: 1400, expectApplied: false },
    { name: "just_under_threshold_portrait", width: 1024, height: 2046, expectApplied: false },
    { name: "exactly_at_threshold_portrait", width: 1024, height: 2048, expectApplied: false },
    { name: "just_over_threshold_portrait", width: 1024, height: 2050, expectApplied: true },
    { name: "well_over_threshold_portrait", width: 1200, height: 3600, expectApplied: true },
    { name: "landscape_large", width: 3600, height: 1200, expectApplied: false },
  ];

  let anyFailure = false;

  for (const c of cases) {
    const filePath = path.join(scratchDir, `${c.name}.jpg`);
    await makeFlatCanvas(filePath, c.width, c.height);
    const outPath = await normalizePortraitImageForGemini(filePath, { jobId: "measure-portrait-guard", stage: "1A" });
    const applied = outPath !== filePath;
    const outMeta = applied ? await sharp(outPath).metadata() : { width: c.width, height: c.height };
    const aspectIn = c.width / c.height;
    const aspectOut = (outMeta.width || 1) / (outMeta.height || 1);
    const aspectOk = Math.abs(aspectIn - aspectOut) < 0.01;
    const pass = applied === c.expectApplied && aspectOk && (!applied || (outMeta.height || 0) <= 2048);
    if (!pass) anyFailure = true;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${c.name.padEnd(30)} in=${c.width}x${c.height} out=${outMeta.width}x${outMeta.height} applied=${applied} (expected ${c.expectApplied}) aspectPreserved=${aspectOk}`
    );
  }

  // Real incident file, as a sanity check (not part of pass/fail — the
  // guard was never expected to repair collage content, only to stop an
  // oversized-portrait input reaching Gemini unmodified).
  const chessboardPath = path.resolve(__dirname, "../../../Test Images/Failed Production Runs/Chessboard Image - Output Original.jpg");
  if (fs.existsSync(chessboardPath)) {
    const meta = await sharp(chessboardPath).metadata();
    const outPath = await normalizePortraitImageForGemini(chessboardPath, { jobId: "measure-portrait-guard", stage: "1A" });
    const applied = outPath !== chessboardPath;
    console.log(`\nReal incident file: ${meta.width}x${meta.height} -> applied=${applied}${applied ? ` (${outPath})` : ""}`);
  }

  console.log(`\n${anyFailure ? "RESULT: one or more cases failed." : "RESULT: all cases passed."}`);
  process.exit(anyFailure ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
