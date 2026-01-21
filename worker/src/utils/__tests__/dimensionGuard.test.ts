import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

import {
  calculateDimensionDelta,
  isWithinDimensionTolerance,
  normalizeCandidateToBaseline,
  getDimensionTolerancePct,
  DEFAULT_DIM_MISMATCH_TOLERANCE_PCT,
} from "../dimensionGuard";

const makeImage = async (p: string, w: number, h: number) => {
  await sharp({ create: { width: w, height: h, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
    .png()
    .toFile(p);
};

describe("dimensionGuard helpers", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test("calculateDimensionDelta and tolerance check", () => {
    const deltas = calculateDimensionDelta({ width: 100, height: 80 }, { width: 103, height: 82 });
    expect(Number((deltas.widthPct * 100).toFixed(2))).toBe(3);
    expect(Number((deltas.heightPct * 100).toFixed(2))).toBe(2.5);
    expect(isWithinDimensionTolerance({ width: 100, height: 80 }, { width: 103, height: 82 }, DEFAULT_DIM_MISMATCH_TOLERANCE_PCT)).toBe(true);
    expect(isWithinDimensionTolerance({ width: 100, height: 80 }, { width: 107, height: 80 }, DEFAULT_DIM_MISMATCH_TOLERANCE_PCT)).toBe(false);
  });

  test("getDimensionTolerancePct respects env override", () => {
    process.env.DIM_MISMATCH_TOLERANCE_PCT = "0.02";
    expect(getDimensionTolerancePct()).toBe(0.02);

    process.env.DIM_MISMATCH_TOLERANCE_PCT = "not-a-number";
    expect(getDimensionTolerancePct()).toBe(DEFAULT_DIM_MISMATCH_TOLERANCE_PCT);
  });

  test("normalizeCandidateToBaseline crops down within tolerance", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimnorm-crop-"));
    const base = path.join(dir, "base.png");
    const cand = path.join(dir, "cand.png");
    await makeImage(base, 100, 80);
    await makeImage(cand, 103, 82);

    const result = await normalizeCandidateToBaseline(base, cand, { suffix: "-norm" });

    expect(result.ok).toBe(true);
    const meta = await sharp(result.normalizedPath).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
    expect(result.method).toBe("crop");
  });

  test("normalizeCandidateToBaseline pads up when smaller", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimnorm-pad-"));
    const base = path.join(dir, "base.png");
    const cand = path.join(dir, "cand.png");
    await makeImage(base, 100, 80);
    await makeImage(cand, 98, 78);

    const result = await normalizeCandidateToBaseline(base, cand, { suffix: "-norm" });

    expect(result.ok).toBe(true);
    const meta = await sharp(result.normalizedPath).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
    expect(["pad", "crop+pad"].includes(result.method)).toBe(true);
  });
});
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { compareImageDimensions } from "../dimensionGuard";

describe("compareImageDimensions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dim-guard-"));
  const baselinePath = path.join(tmpDir, "baseline.png");
  const matchPath = path.join(tmpDir, "match.png");
  const mismatchPath = path.join(tmpDir, "mismatch.png");

  beforeAll(async () => {
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 200, b: 200 } } })
      .png()
      .toFile(baselinePath);

    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 150, g: 150, b: 150 } } })
      .png()
      .toFile(matchPath);

    await sharp({ create: { width: 70, height: 50, channels: 3, background: { r: 100, g: 100, b: 100 } } })
      .png()
      .toFile(mismatchPath);
  });

  test("returns ok when dimensions match", async () => {
    const result = await compareImageDimensions(baselinePath, matchPath);
    expect(result.ok).toBe(true);
    expect(result.baseline).toEqual({ width: 64, height: 48 });
    expect(result.candidate).toEqual({ width: 64, height: 48 });
    expect(result.message).toContain("match");
  });

  test("flags mismatch with dimensions", async () => {
    const result = await compareImageDimensions(baselinePath, mismatchPath);
    expect(result.ok).toBe(false);
    expect(result.baseline).toEqual({ width: 64, height: 48 });
    expect(result.candidate).toEqual({ width: 70, height: 50 });
    expect(result.message).toContain("Dimension mismatch");
  });
});
