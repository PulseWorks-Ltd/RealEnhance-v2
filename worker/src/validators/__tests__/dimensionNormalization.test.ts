import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { normalizeImagePairForValidator } from "../dimensionUtils";
import { runMaskedEdgeValidator } from "../maskedEdgeValidator";

async function makeSolidImage(w: number, h: number, name: string) {
  const p = path.join("/tmp", `validator-${name}-${w}x${h}.png`);
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .png()
    .toFile(p);
  return p;
}

test("small dimension mismatch is normalized and validator runs", async (t) => {
  const base = await makeSolidImage(512, 341, "base-small");
  const cand = await makeSolidImage(512, 343, "cand-small");

  t.after(async () => {
    await Promise.all([fs.rm(base, { force: true }), fs.rm(cand, { force: true })]);
  });

  const norm = await normalizeImagePairForValidator({ basePath: base, candidatePath: cand, jobId: "test-small" });
  assert.ok(norm.normalized, "expected normalization to run");
  assert.strictEqual(norm.width, 512);
  assert.strictEqual(norm.height, 341);
  assert.strictEqual(norm.severity, "info");

  const res = await runMaskedEdgeValidator({
    originalImagePath: base,
    enhancedImagePath: cand,
    scene: "interior",
    mode: "log",
    jobId: "test-small",
  });

  assert.ok(typeof res.maskedEdgeDrift === "number");
});

test("large mismatch warns but does not fail", async (t) => {
  const base = await makeSolidImage(512, 341, "base-large");
  const cand = await makeSolidImage(768, 512, "cand-large");

  t.after(async () => {
    await Promise.all([fs.rm(base, { force: true }), fs.rm(cand, { force: true })]);
  });

  const norm = await normalizeImagePairForValidator({ basePath: base, candidatePath: cand, jobId: "test-large" });
  assert.ok(norm.normalized, "expected normalization attempt");
  assert.strictEqual(norm.severity, "warn");

  const res = await runMaskedEdgeValidator({
    originalImagePath: base,
    enhancedImagePath: cand,
    scene: "interior",
    mode: "log",
    jobId: "test-large",
  });

  assert.ok(typeof res.maskedEdgeDrift === "number");
});
