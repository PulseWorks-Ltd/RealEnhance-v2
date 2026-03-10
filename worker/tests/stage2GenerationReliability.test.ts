import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveStage2Model,
  runStage2GenerationAttempt,
  Stage2GenerationFailure,
  Stage2GenerationNoImageError,
} from "../src/pipeline/stage2";

jest.mock("../src/ai/gemini", () => ({
  getGeminiClient: jest.fn(() => ({ models: { generateContent: jest.fn() } })),
}));

const runWithPrimaryThenFallbackMock = jest.fn();

jest.mock("../src/ai/runWithImageModelFallback", () => ({
  MODEL_CONFIG: {
    stage2: {
      primary: "gemini-2.5-flash-image",
      fallback: "gemini-3.1-flash-image",
    },
  },
  runWithSelectedImageModel: (...args: any[]) => runWithPrimaryThenFallbackMock(...args),
}));

jest.mock("../src/utils/images", () => ({
  siblingOutPath: (basePath: string, suffix: string, ext: string) => {
    const parsed = path.parse(basePath);
    return path.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
  },
  toBase64: () => ({ mime: "image/webp", data: "ZmFrZQ==" }),
  writeImageDataUrl: (outputPath: string) => {
    fs.writeFileSync(outputPath, "ok");
  },
}));

jest.mock("../src/utils/debugImageUrls", () => ({
  logImageAttemptUrl: jest.fn(async () => undefined),
}));

describe("Stage-2 generation reliability", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("resolves only image-capable Stage-2 models", () => {
    process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = "gemini-2.5-flash-image";
    process.env.REALENHANCE_MODEL_STAGE2_FALLBACK = "gemini-2.5-pro";

    const firstAttemptModel = resolveStage2Model(1, "initial");
    const secondAttemptModel = resolveStage2Model(2, "structural_violation");

    expect(firstAttemptModel).toContain("image");
    expect(secondAttemptModel).toContain("image");
  });

  it("raises Stage2GenerationNoImageError when inline image is missing", async () => {
    runWithPrimaryThenFallbackMock.mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ text: "no image" }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-no-image-"));
    const basePath = path.join(tempDir, "base.webp");
    const outputPath = path.join(tempDir, "out.webp");
    fs.writeFileSync(basePath, "base");

    await expect(
      runStage2GenerationAttempt(basePath, {
        roomType: "living_room",
        jobId: "job-test-no-image",
        outputPath,
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationNoImageError);
  });

  it("retries with fresh candidate path and never collapses to baseline", async () => {
    runWithPrimaryThenFallbackMock
      .mockResolvedValueOnce({
        resp: {
          candidates: [{ content: { parts: [{ text: "no image" }] } }],
        },
        modelUsed: "gemini-2.5-flash-image",
      })
      .mockResolvedValueOnce({
        resp: {
          candidates: [{ content: { parts: [{ inlineData: { data: "ZmFrZQ==" } }] } }],
        },
        modelUsed: "gemini-2.5-pro-image",
      });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-retry-"));
    const basePath = path.join(tempDir, "base.webp");
    const retryOutputPath = path.join(tempDir, "out-retry.webp");
    fs.writeFileSync(basePath, "base");

    await expect(
      runStage2GenerationAttempt(basePath, {
        roomType: "living_room",
        jobId: "job-test-retry-1",
        outputPath: path.join(tempDir, "out-initial.webp"),
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationNoImageError);

    const generatedPath = await runStage2GenerationAttempt(basePath, {
      roomType: "living_room",
      jobId: "job-test-retry-2",
      outputPath: retryOutputPath,
      attempt: 2,
    });

    expect(generatedPath).toBe(retryOutputPath);
    expect(generatedPath).not.toBe(basePath);
    expect(fs.existsSync(generatedPath)).toBe(true);
  });

  it("fails fast when candidate path collapses to baseline path", async () => {
    runWithPrimaryThenFallbackMock.mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { data: "ZmFrZQ==" } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-collapse-"));
    const basePath = path.join(tempDir, "base.webp");
    fs.writeFileSync(basePath, "base");

    await expect(
      runStage2GenerationAttempt(basePath, {
        roomType: "living_room",
        jobId: "job-test-collapse",
        outputPath: basePath,
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationFailure);
  });
});
