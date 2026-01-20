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
