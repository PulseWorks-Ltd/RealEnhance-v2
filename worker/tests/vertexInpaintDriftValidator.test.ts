import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

const width = 32;
const height = 32;

async function writeSolidImage(filePath: string, r: number, g: number, b: number) {
  await sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toFile(filePath);
}

async function writeMaskWithEditableSquare(filePath: string, x0: number, y0: number, size: number) {
  const raw = Buffer.alloc(width * height, 0);
  for (let y = y0; y < y0 + size; y += 1) {
    for (let x = x0; x < x0 + size; x += 1) {
      raw[y * width + x] = 255;
    }
  }
  await sharp(raw, { raw: { width, height, channels: 1 } }).png().toFile(filePath);
}

describe("validateOutsideMaskDrift", () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-inpaint-drift-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when the candidate is identical to the source outside the mask", async () => {
    const { validateOutsideMaskDrift } = require("../src/providers/vertexInpaint/driftValidator");
    const sourcePath = path.join(tmpDir, "source.png");
    const candidatePath = path.join(tmpDir, "candidate.png");
    const maskPath = path.join(tmpDir, "mask.png");

    await writeSolidImage(sourcePath, 50, 100, 150);
    await writeSolidImage(candidatePath, 50, 100, 150); // identical
    await writeMaskWithEditableSquare(maskPath, 8, 8, 8);

    const result = await validateOutsideMaskDrift({
      sourcePath,
      candidatePath,
      maskPath,
      jobId: "job_1",
      imageId: "img_1",
    });
    expect(result.passed).toBe(true);
    expect(result.metrics.changedPixelCount).toBe(0);
  });

  it("fails when pixels change outside the editable mask beyond threshold", async () => {
    const { validateOutsideMaskDrift } = require("../src/providers/vertexInpaint/driftValidator");
    const sourcePath = path.join(tmpDir, "source.png");
    const candidatePath = path.join(tmpDir, "candidate.png");
    const maskPath = path.join(tmpDir, "mask.png");

    await writeSolidImage(sourcePath, 50, 100, 150);
    await writeSolidImage(candidatePath, 250, 5, 5); // drastically different everywhere
    await writeMaskWithEditableSquare(maskPath, 8, 8, 8);

    const result = await validateOutsideMaskDrift({
      sourcePath,
      candidatePath,
      maskPath,
      jobId: "job_2",
      imageId: "img_2",
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("outside_mask_drift_exceeded");
  });

  it("ignores changes that occur only inside the editable mask", async () => {
    const { validateOutsideMaskDrift } = require("../src/providers/vertexInpaint/driftValidator");
    const sourcePath = path.join(tmpDir, "source.png");
    const candidatePath = path.join(tmpDir, "candidate.png");
    const maskPath = path.join(tmpDir, "mask.png");

    await writeSolidImage(sourcePath, 50, 100, 150);
    // Build a candidate that matches source everywhere except inside the mask square.
    const candidateRaw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 3;
        const insideMask = x >= 8 && x < 16 && y >= 8 && y < 16;
        candidateRaw[idx] = insideMask ? 250 : 50;
        candidateRaw[idx + 1] = insideMask ? 5 : 100;
        candidateRaw[idx + 2] = insideMask ? 5 : 150;
      }
    }
    await sharp(candidateRaw, { raw: { width, height, channels: 3 } }).png().toFile(candidatePath);
    await writeMaskWithEditableSquare(maskPath, 8, 8, 8);

    const result = await validateOutsideMaskDrift({
      sourcePath,
      candidatePath,
      maskPath,
      jobId: "job_3",
      imageId: "img_3",
    });
    expect(result.passed).toBe(true);
  });

  it("resolveDriftThresholds honors env overrides", () => {
    process.env.VERTEX_INPAINT_OUTSIDE_MASK_MAX_MAE = "12";
    process.env.VERTEX_INPAINT_OUTSIDE_MASK_MAX_CHANGED_RATIO = "0.1";
    process.env.VERTEX_INPAINT_OUTSIDE_MASK_CHANGE_THRESHOLD = "30";
    jest.resetModules();
    const { resolveDriftThresholds } = require("../src/providers/vertexInpaint/driftValidator");
    expect(resolveDriftThresholds()).toEqual({ maxMae: 12, maxChangedRatio: 0.1, changeThreshold: 30 });
    delete process.env.VERTEX_INPAINT_OUTSIDE_MASK_MAX_MAE;
    delete process.env.VERTEX_INPAINT_OUTSIDE_MASK_MAX_CHANGED_RATIO;
    delete process.env.VERTEX_INPAINT_OUTSIDE_MASK_CHANGE_THRESHOLD;
  });
});
