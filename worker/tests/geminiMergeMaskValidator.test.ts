import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { validateExtractionMask } from "../src/providers/geminiMerge/maskValidator";

async function writeSourceImage(filePath: string, width: number, height: number) {
  await sharp({ create: { width, height, channels: 3, background: { r: 80, g: 80, b: 80 } } }).png().toFile(filePath);
}

async function makeGrayscalePng(width: number, height: number, fillValue: number | Buffer): Promise<Buffer> {
  const raw = Buffer.isBuffer(fillValue) ? fillValue : Buffer.alloc(width * height, fillValue);
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

describe("validateExtractionMask", () => {
  let tmpDir: string;
  const width = 64;
  const height = 64;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-merge-mask-validator-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts a valid mask with a reasonable non-zero region", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    await writeSourceImage(sourcePath, width, height);

    const raw = Buffer.alloc(width * height, 0);
    for (let y = 16; y < 40; y += 1) {
      for (let x = 16; x < 40; x += 1) {
        raw[y * width + x] = 255;
      }
    }
    const maskPngBuffer = await makeGrayscalePng(width, height, raw);

    const result = await validateExtractionMask({ sourceImagePath: sourcePath, maskPngBuffer });
    expect(result.valid).toBe(true);
    expect(result.metrics.boundingBox).toEqual({ x: 16, y: 16, width: 24, height: 24 });
    expect(result.metrics.nonZeroPixelCount).toBe(24 * 24);
  });

  it("rejects an empty (all-black) mask", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    await writeSourceImage(sourcePath, width, height);
    const maskPngBuffer = await makeGrayscalePng(width, height, 0);

    const result = await validateExtractionMask({ sourceImagePath: sourcePath, maskPngBuffer });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mask_empty");
  });

  it("rejects a full-frame (all-white) mask", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    await writeSourceImage(sourcePath, width, height);
    const maskPngBuffer = await makeGrayscalePng(width, height, 255);

    const result = await validateExtractionMask({ sourceImagePath: sourcePath, maskPngBuffer });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("entire_image");
  });

  it("rejects a mask whose dimensions do not match the source image", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    await writeSourceImage(sourcePath, width, height);
    const maskPngBuffer = await makeGrayscalePng(width / 2, height / 2, 128);

    const result = await validateExtractionMask({ sourceImagePath: sourcePath, maskPngBuffer });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mask_dimension_mismatch");
  });

  it("rejects invalid (non-image) mask data", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    await writeSourceImage(sourcePath, width, height);
    const garbage = Buffer.from("this is not a png", "utf8");

    const result = await validateExtractionMask({ sourceImagePath: sourcePath, maskPngBuffer: garbage });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mask_not_a_valid_image");
  });

  it("computes mean alpha and connected component diagnostics", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    await writeSourceImage(sourcePath, width, height);

    const raw = Buffer.alloc(width * height, 0);
    // two disjoint blocks
    for (let y = 4; y < 8; y += 1) for (let x = 4; x < 8; x += 1) raw[y * width + x] = 255;
    for (let y = 40; y < 44; y += 1) for (let x = 40; x < 44; x += 1) raw[y * width + x] = 255;
    const maskPngBuffer = await makeGrayscalePng(width, height, raw);

    const result = await validateExtractionMask({ sourceImagePath: sourcePath, maskPngBuffer });
    expect(result.valid).toBe(true);
    expect(result.metrics.connectedComponentCount).toBe(2);
    expect(result.metrics.meanAlpha).toBeGreaterThan(0);
  });
});
