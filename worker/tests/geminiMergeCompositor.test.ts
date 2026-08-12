import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { compositeStagingLayer } from "../src/providers/geminiMerge/compositor";

const width = 16;
const height = 16;

async function writeSolidImage(filePath: string, r: number, g: number, b: number) {
  await sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toFile(filePath);
}

async function makeGrayscalePng(fillValue: number | Buffer): Promise<Buffer> {
  const raw = Buffer.isBuffer(fillValue) ? fillValue : Buffer.alloc(width * height, fillValue);
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function readPixel(buf: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const raw = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const idx = (y * raw.info.width + x) * raw.info.channels;
  return { r: raw.data[idx], g: raw.data[idx + 1], b: raw.data[idx + 2] };
}

describe("compositeStagingLayer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-merge-compositor-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("alpha=0 retains the original pixel everywhere", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await writeSolidImage(originalPath, 10, 20, 30);
    await writeSolidImage(stagedPath, 250, 5, 5);
    const maskPngBuffer = await makeGrayscalePng(0);

    const result = await compositeStagingLayer({ originalImagePath: originalPath, stagedImagePath: stagedPath, maskPngBuffer });
    const pixel = await readPixel(result, 8, 8);
    expect(pixel).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("alpha=255 uses the staged pixel everywhere", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await writeSolidImage(originalPath, 10, 20, 30);
    await writeSolidImage(stagedPath, 250, 5, 5);
    const maskPngBuffer = await makeGrayscalePng(255);

    const result = await compositeStagingLayer({ originalImagePath: originalPath, stagedImagePath: stagedPath, maskPngBuffer });
    const pixel = await readPixel(result, 8, 8);
    expect(pixel.r).toBeGreaterThan(240);
    expect(pixel.g).toBeLessThan(15);
    expect(pixel.b).toBeLessThan(15);
  });

  it("alpha=128 produces a roughly even blend of original and staged", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await writeSolidImage(originalPath, 0, 0, 0);
    await writeSolidImage(stagedPath, 200, 200, 200);
    const maskPngBuffer = await makeGrayscalePng(128);

    const result = await compositeStagingLayer({ originalImagePath: originalPath, stagedImagePath: stagedPath, maskPngBuffer });
    const pixel = await readPixel(result, 8, 8);
    // Sharp's "over" compositing with alpha=128/255 (~0.502) should land close to
    // the halfway point between 0 and 200 — allow tolerance for rounding.
    expect(pixel.r).toBeGreaterThan(85);
    expect(pixel.r).toBeLessThan(115);
  });

  it("only alters pixels within the masked region, leaving the rest untouched", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await writeSolidImage(originalPath, 10, 20, 30);
    await writeSolidImage(stagedPath, 250, 5, 5);

    const raw = Buffer.alloc(width * height, 0);
    for (let y = 4; y < 8; y += 1) for (let x = 4; x < 8; x += 1) raw[y * width + x] = 255;
    const maskPngBuffer = await makeGrayscalePng(raw);

    const result = await compositeStagingLayer({ originalImagePath: originalPath, stagedImagePath: stagedPath, maskPngBuffer });

    const insideMask = await readPixel(result, 5, 5);
    expect(insideMask.r).toBeGreaterThan(240);

    const outsideMask = await readPixel(result, 0, 0);
    expect(outsideMask).toEqual({ r: 10, g: 20, b: 30 });
  });
});
