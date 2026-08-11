import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { validateMask } from "../src/providers/vertexInpaint/maskValidator";

async function writeGrayscalePng(filePath: string, width: number, height: number, fillValue: number | Buffer) {
  const raw = Buffer.isBuffer(fillValue) ? fillValue : Buffer.alloc(width * height, fillValue);
  await sharp(raw, { raw: { width, height, channels: 1 } }).png().toFile(filePath);
}

async function writeSourceImage(filePath: string, width: number, height: number) {
  await sharp({ create: { width, height, channels: 3, background: { r: 100, g: 100, b: 100 } } }).png().toFile(filePath);
}

describe("validateMask", () => {
  let tmpDir: string;
  const width = 64;
  const height = 64;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-inpaint-mask-validator-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts a mask with a reasonable editable region", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const maskPath = path.join(tmpDir, "mask.png");
    await writeSourceImage(sourcePath, width, height);

    const raw = Buffer.alloc(width * height, 0);
    // White square covering ~25% of the frame (well within default 1%-95% bounds)
    for (let y = 16; y < 48; y += 1) {
      for (let x = 16; x < 48; x += 1) {
        raw[y * width + x] = 255;
      }
    }
    await writeGrayscalePng(maskPath, width, height, raw);

    const result = await validateMask({ sourceImagePath: sourcePath, maskPath });
    expect(result.valid).toBe(true);
    expect(result.metrics.boundingBox).toEqual({ x: 16, y: 16, width: 32, height: 32 });
  });

  it("rejects a completely black mask (no editable region)", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const maskPath = path.join(tmpDir, "mask.png");
    await writeSourceImage(sourcePath, width, height);
    await writeGrayscalePng(maskPath, width, height, 0);

    const result = await validateMask({ sourceImagePath: sourcePath, maskPath });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("completely_black");
  });

  it("rejects a completely white mask (nothing protected)", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const maskPath = path.join(tmpDir, "mask.png");
    await writeSourceImage(sourcePath, width, height);
    await writeGrayscalePng(maskPath, width, height, 255);

    const result = await validateMask({ sourceImagePath: sourcePath, maskPath });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("completely_white");
  });

  it("rejects a mask whose dimensions do not match the source image", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const maskPath = path.join(tmpDir, "mask.png");
    await writeSourceImage(sourcePath, width, height);
    await writeGrayscalePng(maskPath, width / 2, height / 2, 128);

    const result = await validateMask({ sourceImagePath: sourcePath, maskPath });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mask_dimension_mismatch");
  });

  it("rejects an editable region below the minimum ratio", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const maskPath = path.join(tmpDir, "mask.png");
    await writeSourceImage(sourcePath, width, height);

    const raw = Buffer.alloc(width * height, 0);
    raw[0] = 255; // a single pixel — far below the 1% default minimum
    await writeGrayscalePng(maskPath, width, height, raw);

    const result = await validateMask({ sourceImagePath: sourcePath, maskPath });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too_small");
  });
});
