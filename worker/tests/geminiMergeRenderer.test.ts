import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

jest.mock("../src/pipeline/stage2", () => ({ runStage2: jest.fn() }));
jest.mock("../src/providers/geminiMerge/extraction", () => ({
  extractStagingLayerMask: jest.fn(),
  getExtractionModel: jest.fn(() => "gemini-2.5-flash-image"),
}));

describe("renderStagingWithGeminiMerge", () => {
  let tmpDir: string;
  const width = 16;
  const height = 16;
  let originalPath: string;
  let stagedPath: string;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-merge-renderer-"));
    originalPath = path.join(tmpDir, "room-2.webp");
    stagedPath = path.join(tmpDir, "room-2-staged.webp");
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).webp().toFile(originalPath);
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } } }).webp().toFile(stagedPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs generation -> extraction -> validation -> composite end to end and writes debug artifacts", async () => {
    const { runStage2 } = require("../src/pipeline/stage2");
    const { extractStagingLayerMask } = require("../src/providers/geminiMerge/extraction");

    (runStage2 as jest.Mock).mockResolvedValue({
      outputPath: stagedPath,
      attempts: 1,
      maxAttempts: 2,
      validationRisk: false,
      fallbackUsed: false,
      localReasons: [],
    });

    const maskRaw = Buffer.alloc(width * height, 0);
    for (let y = 4; y < 10; y += 1) for (let x = 4; x < 10; x += 1) maskRaw[y * width + x] = 255;
    const maskPngBuffer = await sharp(maskRaw, { raw: { width, height, channels: 1 } }).png().toBuffer();
    (extractStagingLayerMask as jest.Mock).mockResolvedValue({
      maskPngBuffer,
      width,
      height,
      modelUsed: "gemini-2.5-flash-image",
    });

    const { renderStagingWithGeminiMerge } = require("../src/providers/geminiMerge/renderer");
    const result = await renderStagingWithGeminiMerge({
      basePath: originalPath,
      roomType: "living_room",
      sceneType: "interior",
      stagingStyle: "standard_listing",
      sourceStage: "1A",
      jobId: "job_1",
      imageId: "img_1",
    });

    expect(result.stagedCandidatePath).toBe(stagedPath);
    expect(result.maskMetrics.nonZeroPixelCount).toBe(36);
    expect(result.extractionModel).toBe("gemini-2.5-flash-image");

    const finalStat = await fs.stat(result.finalLocalPath);
    expect(finalStat.size).toBeGreaterThan(0);
    const maskStat = await fs.stat(result.extractionMaskPath);
    expect(maskStat.size).toBeGreaterThan(0);
    const overlayStat = await fs.stat(result.overlayDebugPath);
    expect(overlayStat.size).toBeGreaterThan(0);
  });

  it("throws StagingGenerationError when runStage2 does not produce a new candidate", async () => {
    const { runStage2 } = require("../src/pipeline/stage2");
    (runStage2 as jest.Mock).mockResolvedValue({
      outputPath: originalPath, // collapsed to input — Gemini disabled/unavailable
      attempts: 0,
      maxAttempts: 0,
      validationRisk: false,
      fallbackUsed: false,
      localReasons: [],
    });

    const { renderStagingWithGeminiMerge } = require("../src/providers/geminiMerge/renderer");
    const { StagingGenerationError } = require("../src/providers/geminiMerge/types");

    await expect(
      renderStagingWithGeminiMerge({
        basePath: originalPath,
        roomType: "living_room",
        sourceStage: "1A",
        jobId: "job_2",
        imageId: "img_2",
      })
    ).rejects.toThrow(StagingGenerationError);
  });

  it("throws MaskValidationError when the extracted mask is empty", async () => {
    const { runStage2 } = require("../src/pipeline/stage2");
    const { extractStagingLayerMask } = require("../src/providers/geminiMerge/extraction");

    (runStage2 as jest.Mock).mockResolvedValue({
      outputPath: stagedPath,
      attempts: 1,
      maxAttempts: 2,
      validationRisk: false,
      fallbackUsed: false,
      localReasons: [],
    });

    const emptyMaskPng = await sharp(Buffer.alloc(width * height, 0), { raw: { width, height, channels: 1 } }).png().toBuffer();
    (extractStagingLayerMask as jest.Mock).mockResolvedValue({
      maskPngBuffer: emptyMaskPng,
      width,
      height,
      modelUsed: "gemini-2.5-flash-image",
    });

    const { renderStagingWithGeminiMerge } = require("../src/providers/geminiMerge/renderer");
    const { MaskValidationError } = require("../src/providers/geminiMerge/types");

    await expect(
      renderStagingWithGeminiMerge({
        basePath: originalPath,
        roomType: "living_room",
        sourceStage: "1A",
        jobId: "job_3",
        imageId: "img_3",
      })
    ).rejects.toThrow(MaskValidationError);
  });
});
