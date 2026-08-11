import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

jest.mock("../src/ai/gemini", () => ({ getGeminiClient: jest.fn(() => ({})) }));
jest.mock("../src/ai/runWithImageModelFallback", () => ({ runWithSelectedImageModel: jest.fn() }));

describe("generateFurniturePlacementMask", () => {
  let tmpDir: string;
  const width = 16;
  const height = 16;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vertex-inpaint-mask-gen-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sends the source image + room-type prompt to Gemini and writes a compiled mask on success", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const outputMaskPath = path.join(tmpDir, "mask.png");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(sourcePath);

    const rawMaskRaw = Buffer.alloc(width * height, 0);
    for (let i = 0; i < 50; i += 1) rawMaskRaw[i] = 255;
    const rawMaskPng = await sharp(rawMaskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const rawMaskBase64 = rawMaskPng.toString("base64");

    const { runWithSelectedImageModel } = require("../src/ai/runWithImageModelFallback");
    (runWithSelectedImageModel as jest.Mock).mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: rawMaskBase64 } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const { generateFurniturePlacementMask } = require("../src/providers/vertexInpaint/maskGenerator");
    const result = await generateFurniturePlacementMask({
      sourceImagePath: sourcePath,
      roomType: "living_room",
      outputMaskPath,
      jobId: "job_1",
      imageId: "img_1",
    });

    expect(result.maskPath).toBe(outputMaskPath);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);

    const written = await fs.readFile(outputMaskPath);
    expect(written.length).toBeGreaterThan(0);

    const callArgs = (runWithSelectedImageModel as jest.Mock).mock.calls[0][0];
    const promptText = callArgs.baseRequest.contents[0].parts[0].text;
    expect(promptText).toContain("living_room");
    expect(promptText).toContain("WHITE");
    expect(promptText).toContain("BLACK");
  });

  it("throws GeminiMaskGenerationError when no inline image part is returned", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const outputMaskPath = path.join(tmpDir, "mask.png");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(sourcePath);

    const { runWithSelectedImageModel } = require("../src/ai/runWithImageModelFallback");
    (runWithSelectedImageModel as jest.Mock).mockResolvedValue({
      resp: { candidates: [{ content: { parts: [{ text: "sorry, I cannot do that" }] } }] },
      modelUsed: "gemini-2.5-flash-image",
    });

    const { generateFurniturePlacementMask } = require("../src/providers/vertexInpaint/maskGenerator");
    const { GeminiMaskGenerationError } = require("../src/providers/vertexInpaint/types");

    await expect(
      generateFurniturePlacementMask({
        sourceImagePath: sourcePath,
        roomType: "living_room",
        outputMaskPath,
        jobId: "job_2",
        imageId: "img_2",
      })
    ).rejects.toThrow(GeminiMaskGenerationError);
  });

  it("wraps a Gemini call failure in GeminiMaskGenerationError", async () => {
    const sourcePath = path.join(tmpDir, "source.png");
    const outputMaskPath = path.join(tmpDir, "mask.png");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(sourcePath);

    const { runWithSelectedImageModel } = require("../src/ai/runWithImageModelFallback");
    (runWithSelectedImageModel as jest.Mock).mockRejectedValue(new Error("network error"));

    const { generateFurniturePlacementMask } = require("../src/providers/vertexInpaint/maskGenerator");
    const { GeminiMaskGenerationError } = require("../src/providers/vertexInpaint/types");

    await expect(
      generateFurniturePlacementMask({
        sourceImagePath: sourcePath,
        roomType: "living_room",
        outputMaskPath,
        jobId: "job_3",
        imageId: "img_3",
      })
    ).rejects.toThrow(GeminiMaskGenerationError);
  });
});
