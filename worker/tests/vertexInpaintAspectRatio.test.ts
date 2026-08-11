import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { cropToOriginalDimensions, padImageInPlace, resolveNearestImagenAspectRatio } from "../src/providers/vertexInpaint/aspectRatio";

describe("resolveNearestImagenAspectRatio", () => {
  it("returns no normalization for an exact supported ratio", () => {
    const result = resolveNearestImagenAspectRatio(1024, 1024); // 1:1
    expect(result.normalizationApplied).toBe(false);
    expect(result.targetAspectRatio).toBe("1:1");
    expect(result.padLeft).toBe(0);
    expect(result.padTop).toBe(0);
  });

  it("pads an arbitrary real-estate photo ratio to the nearest supported ratio", () => {
    // A common 3:2 DSLR photo ratio (1.5) — not one of Imagen's supported ratios.
    const result = resolveNearestImagenAspectRatio(4000, 2667);
    expect(result.normalizationApplied).toBe(true);
    expect(["1:1", "4:3", "3:4", "16:9", "9:16"]).toContain(result.targetAspectRatio);
    expect(result.paddedWidth).toBeGreaterThanOrEqual(4000);
    expect(result.paddedHeight).toBeGreaterThanOrEqual(2667);
    expect(result.padLeft + result.padRight).toBe(result.paddedWidth - 4000);
    expect(result.padTop + result.padBottom).toBe(result.paddedHeight - 2667);
  });

  it("throws on invalid dimensions", () => {
    expect(() => resolveNearestImagenAspectRatio(0, 100)).toThrow();
    expect(() => resolveNearestImagenAspectRatio(100, -1)).toThrow();
  });
});

describe("pad/crop round-trip", () => {
  it("padImageInPlace + cropToOriginalDimensions restores original dimensions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-inpaint-aspect-"));
    const imagePath = path.join(tmpDir, "source.png");
    const width = 4000;
    const height = 2667;
    await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toFile(imagePath);

    const normalization = resolveNearestImagenAspectRatio(width, height);
    expect(normalization.normalizationApplied).toBe(true);

    await padImageInPlace(imagePath, normalization);
    const paddedMetadata = await sharp(imagePath).metadata();
    expect(paddedMetadata.width).toBe(normalization.paddedWidth);
    expect(paddedMetadata.height).toBe(normalization.paddedHeight);

    // Simulate a "generated" image at the padded size, then crop back.
    const generatedBuffer = await sharp(imagePath).png().toBuffer();
    const cropped = await cropToOriginalDimensions(generatedBuffer, normalization);
    const croppedMetadata = await sharp(cropped).metadata();
    expect(croppedMetadata.width).toBe(width);
    expect(croppedMetadata.height).toBe(height);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
