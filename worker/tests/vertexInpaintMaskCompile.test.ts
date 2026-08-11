import sharp from "sharp";
import { compileMask } from "../src/providers/vertexInpaint/maskCompile";
import { countWhitePixels } from "../src/providers/vertexInpaint/maskUtils";

describe("compileMask", () => {
  const width = 32;
  const height = 32;

  it("binarizes a soft/anti-aliased mask response into strict 0/255", async () => {
    const raw = Buffer.alloc(width * height, 0);
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 24; x += 1) {
        raw[y * width + x] = 180; // above threshold, not pure white
      }
    }
    const rawPng = await sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();

    const compiledPng = await compileMask({ rawMaskPngBuffer: rawPng, width, height });
    const compiledRaw = await sharp(compiledPng).removeAlpha().grayscale().raw().toBuffer();
    for (const value of compiledRaw) {
      expect(value === 0 || value === 255).toBe(true);
    }
    expect(countWhitePixels(compiledRaw)).toBeGreaterThan(0);
  });

  it("removes isolated single-pixel noise", async () => {
    const raw = Buffer.alloc(width * height, 0);
    raw[5 * width + 5] = 255; // isolated speck, no neighbors
    const rawPng = await sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();

    const compiledPng = await compileMask({ rawMaskPngBuffer: rawPng, width, height });
    const compiledRaw = await sharp(compiledPng).removeAlpha().grayscale().raw().toBuffer();
    expect(countWhitePixels(compiledRaw)).toBe(0);
  });

  it("preserves a large solid region", async () => {
    const raw = Buffer.alloc(width * height, 0);
    for (let y = 4; y < 28; y += 1) {
      for (let x = 4; x < 28; x += 1) {
        raw[y * width + x] = 255;
      }
    }
    const rawPng = await sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();

    const compiledPng = await compileMask({ rawMaskPngBuffer: rawPng, width, height });
    const compiledRaw = await sharp(compiledPng).removeAlpha().grayscale().raw().toBuffer();
    expect(countWhitePixels(compiledRaw)).toBeGreaterThan(400); // most of the 24x24=576 block should survive
  });
});
