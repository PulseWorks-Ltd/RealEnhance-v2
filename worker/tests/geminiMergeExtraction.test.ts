import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

jest.mock("../src/ai/gemini", () => ({ getGeminiClient: jest.fn(() => ({})) }));
jest.mock("../src/ai/runWithImageModelFallback", () => ({ runWithSelectedImageModel: jest.fn() }));

describe("extractStagingLayerMask", () => {
  let tmpDir: string;
  const width = 16;
  const height = 16;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-merge-extraction-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sends both images and the extraction prompt, and converts the response into a mask buffer", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(originalPath);
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toFile(stagedPath);

    const maskRaw = Buffer.alloc(width * height, 0);
    for (let i = 0; i < 40; i += 1) maskRaw[i] = 255;
    const maskPng = await sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const maskBase64 = maskPng.toString("base64");

    const { runWithSelectedImageModel } = require("../src/ai/runWithImageModelFallback");
    (runWithSelectedImageModel as jest.Mock).mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: maskBase64 } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const { extractStagingLayerMask } = require("../src/providers/geminiMerge/extraction");
    const result = await extractStagingLayerMask({
      originalImagePath: originalPath,
      stagedImagePath: stagedPath,
      jobId: "job_1",
      imageId: "img_1",
    });

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.modelUsed).toBe("gemini-2.5-flash-image");
    expect(result.maskPngBuffer.length).toBeGreaterThan(0);

    const callArgs = (runWithSelectedImageModel as jest.Mock).mock.calls[0][0];
    const parts = callArgs.baseRequest.contents[0].parts;
    const promptText = parts[0].text as string;
    expect(promptText).toContain("WHITE");
    expect(promptText).toContain("GREY");
    expect(promptText).toContain("BLACK");
    expect(promptText).toContain("conservative");
    expect(promptText.toLowerCase()).toContain("doorway");
    // Both images must actually be sent
    const inlineImageParts = parts.filter((p: any) => p.inlineData);
    expect(inlineImageParts).toHaveLength(2);
  });

  it("throws ExtractionError when no inline image part is returned", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(originalPath);
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toFile(stagedPath);

    const { runWithSelectedImageModel } = require("../src/ai/runWithImageModelFallback");
    (runWithSelectedImageModel as jest.Mock).mockResolvedValue({
      resp: { candidates: [{ content: { parts: [{ text: "cannot help with that" }] } }] },
      modelUsed: "gemini-2.5-flash-image",
    });

    const { extractStagingLayerMask } = require("../src/providers/geminiMerge/extraction");
    const { ExtractionError } = require("../src/providers/geminiMerge/types");

    await expect(
      extractStagingLayerMask({
        originalImagePath: originalPath,
        stagedImagePath: stagedPath,
        jobId: "job_2",
        imageId: "img_2",
      })
    ).rejects.toThrow(ExtractionError);
  });

  it("wraps a Gemini call failure in ExtractionError", async () => {
    const originalPath = path.join(tmpDir, "original.png");
    const stagedPath = path.join(tmpDir, "staged.png");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(originalPath);
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toFile(stagedPath);

    const { runWithSelectedImageModel } = require("../src/ai/runWithImageModelFallback");
    (runWithSelectedImageModel as jest.Mock).mockRejectedValue(new Error("network error"));

    const { extractStagingLayerMask } = require("../src/providers/geminiMerge/extraction");
    const { ExtractionError } = require("../src/providers/geminiMerge/types");

    await expect(
      extractStagingLayerMask({
        originalImagePath: originalPath,
        stagedImagePath: stagedPath,
        jobId: "job_3",
        imageId: "img_3",
      })
    ).rejects.toThrow(ExtractionError);
  });
});
