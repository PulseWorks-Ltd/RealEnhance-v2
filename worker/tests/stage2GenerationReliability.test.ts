import fs from "fs";
import os from "os";
import path from "path";
import { nLog } from "../src/logger";
import {
  resolveStage2Model,
  runStage2GenerationAttempt,
  Stage2GenerationFailure,
  Stage2GenerationNoImageError,
  isStage2RetryableGenerationError,
  wrapRetryableSecondaryContinuityError,
} from "../src/pipeline/stage2";

jest.mock("../src/ai/gemini", () => ({
  getGeminiClient: jest.fn(() => ({ models: { generateContent: jest.fn() } })),
}));

const mockRunWithPrimaryThenFallback = jest.fn();

jest.mock("../src/ai/runWithImageModelFallback", () => ({
  MODEL_CONFIG: {
    stage2: {
      primary: "gemini-2.5-flash-image",
      fallback: "gemini-3.1-flash-image",
    },
  },
  runWithSelectedImageModel: (...args) => mockRunWithPrimaryThenFallback(...args),
}));

jest.mock("../src/utils/images", () => ({
  siblingOutPath: (basePath, suffix, ext) => {
    const mockPath = require("path");
    const parsed = mockPath.parse(basePath);
    return mockPath.join(parsed.dir, `${parsed.name}${suffix}${ext}`);
  },
  toBase64: () => ({ mime: "image/webp", data: "ZmFrZQ==" }),
  writeImageDataUrl: (outputPath) => {
    const mockFs = require("fs");
    mockFs.writeFileSync(outputPath, "ok");
  },
}));

jest.mock("../src/utils/debugImageUrls", () => ({
  logImageAttemptUrl: jest.fn(async () => undefined),
}));

jest.mock("../src/logger", () => ({
  nLog: jest.fn(),
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
    mockRunWithPrimaryThenFallback.mockResolvedValue({
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
        imageId: "img-test-no-image",
        outputPath,
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationNoImageError);
  });

  it("retries with fresh candidate path and never collapses to baseline", async () => {
    mockRunWithPrimaryThenFallback
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
        imageId: "img-test-retry-1",
        outputPath: path.join(tempDir, "out-initial.webp"),
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationNoImageError);

    const generatedPath = await runStage2GenerationAttempt(basePath, {
      roomType: "living_room",
      jobId: "job-test-retry-2",
      imageId: "img-test-retry-2",
      outputPath: retryOutputPath,
      attempt: 2,
    });

    expect(generatedPath).toBe(retryOutputPath);
    expect(generatedPath).not.toBe(basePath);
    expect(fs.existsSync(generatedPath)).toBe(true);
  });

  it("fails fast when candidate path collapses to baseline path", async () => {
    mockRunWithPrimaryThenFallback.mockResolvedValue({
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
        imageId: "img-test-collapse",
        outputPath: basePath,
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationFailure);
  });

  it("marks Vertex FAILED_PRECONDITION continuity failures as retryable", () => {
    const wrapped = wrapRetryableSecondaryContinuityError(
      new Error("got status: 400 Bad Request. {\"error\":{\"code\":400,\"message\":\"Service agents are being provisioned.\",\"status\":\"FAILED_PRECONDITION\"}}")
    );

    expect(wrapped).toBeInstanceOf(Stage2GenerationFailure);
    expect(isStage2RetryableGenerationError(wrapped)).toBe(true);
    expect((wrapped as Stage2GenerationFailure).code).toBe("vertex_continuity_failed_precondition");
  });

  it("uses compressed secondary reference payload ordering without target duplication", async () => {
    process.env.EXPERIMENT_ROOM_CONSISTENCY_V1 = "1";
    process.env.STAGE2_PROMPT_VARIANT = "nano";

    mockRunWithPrimaryThenFallback.mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { data: "ZmFrZQ==" } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-secondary-reference-"));
    const basePath = path.join(tempDir, "base.webp");
    const outputPath = path.join(tempDir, "out.webp");
    const referencePath = path.join(tempDir, "reference.webp");
    fs.writeFileSync(basePath, "base");
    fs.writeFileSync(referencePath, "reference");

    await runStage2GenerationAttempt(basePath, {
      roomType: "bedroom",
      jobId: "job-test-secondary-reference",
      imageId: "img-test-secondary-reference",
      outputPath,
      attempt: 1,
      promptMode: "full",
      referenceImagePath: referencePath,
      roomConsistencyV1: {
        enabled: true,
        viewRole: "reference",
        roomId: "room-test-secondary-reference",
        approvedMasterImageUrl: "https://example.com/master.webp",
      },
    });

    const request = mockRunWithPrimaryThenFallback.mock.calls[0][0].baseRequest;
    const contents = request.contents;

    expect(contents).toHaveLength(4);
    expect(contents[0].text).toContain("Stage the TARGET room image");
    expect(contents[0].text).toContain("Keep furnishings anchored to the same real room locations");
    expect(contents[0].text).not.toContain("pixel-aligned");
    expect(contents[0].text).not.toContain("immutable architectural plate");
    expect(contents[0].text).not.toContain("style swatch only");
    expect(contents[1].inlineData).toBeDefined();
    expect(contents[2].inlineData).toBeDefined();
    expect(contents[3].text).toContain("Final requirement:");
    expect(contents[3].text).toContain("Preserve the TARGET room architecture, camera geometry, framing, and perspective exactly.");
    expect(contents.filter((part) => part.text === "TARGET_STRUCTURE_INPUT_REANCHOR")).toHaveLength(0);
  });

  it("applies the tuned secondary continuity generation profile and logs continuity identity", async () => {
    process.env.EXPERIMENT_ROOM_CONSISTENCY_V1 = "1";
    process.env.STAGE2_PROMPT_VARIANT = "nano";

    mockRunWithPrimaryThenFallback.mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { data: "ZmFrZQ==" } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-secondary-profile-"));
    const basePath = path.join(tempDir, "base.webp");
    const outputPath = path.join(tempDir, "out.webp");
    const referencePath = path.join(tempDir, "reference.webp");
    fs.writeFileSync(basePath, "base");
    fs.writeFileSync(referencePath, "reference");

    await runStage2GenerationAttempt(basePath, {
      roomType: "living_room",
      jobId: "job-test-secondary-profile",
      imageId: "img-test-secondary-profile",
      outputPath,
      attempt: 1,
      promptMode: "full",
      referenceImagePath: referencePath,
      roomConsistencyV1: {
        enabled: true,
        viewRole: "reference",
        roomId: "room-test-secondary-profile",
        approvedMasterImageUrl: "https://example.com/master.webp",
      },
    });

    const request = mockRunWithPrimaryThenFallback.mock.calls[0][0].baseRequest;
    expect(request.generationConfig).toMatchObject({
      temperature: 0.26,
      topP: 0.68,
      topK: 20,
      candidateCount: 2,
    });

    const loggerMock = jest.mocked(nLog);
    expect(loggerMock).toHaveBeenCalledWith(
      "[SECONDARY_VIEW_CONTINUITY_PROFILE]",
      expect.objectContaining({
        imageId: "img-test-secondary-profile",
        continuityGroupId: "room-test-secondary-profile",
        temperature: 0.26,
        topP: 0.68,
        topK: 20,
        candidateCount: 2,
        continuityMode: true,
      })
    );
    expect(loggerMock).toHaveBeenCalledWith(
      "[STAGE2_GENERATION_PROFILE]",
      expect.objectContaining({
        imageId: "img-test-secondary-profile",
        continuityGroupId: "room-test-secondary-profile",
        temperature: 0.26,
        topP: 0.68,
        topK: 20,
        candidateCount: 2,
        continuityMode: true,
      })
    );
  });

  it("keeps grouped secondary payload shape stable across repeated runs", async () => {
    process.env.EXPERIMENT_ROOM_CONSISTENCY_V1 = "1";
    process.env.STAGE2_PROMPT_VARIANT = "nano";

    mockRunWithPrimaryThenFallback.mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { data: "ZmFrZQ==" } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-secondary-stress-"));
    const basePath = path.join(tempDir, "base.webp");
    const referencePath = path.join(tempDir, "reference.webp");
    fs.writeFileSync(basePath, "base");
    fs.writeFileSync(referencePath, "reference");

    for (let index = 0; index < 8; index += 1) {
      const outputPath = path.join(tempDir, `out-${index}.webp`);
      await runStage2GenerationAttempt(basePath, {
        roomType: "bedroom",
        jobId: `job-test-secondary-stress-${index}`,
        imageId: `img-test-secondary-stress-${index}`,
        outputPath,
        attempt: 1,
        promptMode: "full",
        referenceImagePath: referencePath,
        roomConsistencyV1: {
          enabled: true,
          viewRole: "reference",
          roomId: `room-test-secondary-stress-${index}`,
          approvedMasterImageUrl: "https://example.com/master.webp",
        },
      });

      const request = mockRunWithPrimaryThenFallback.mock.calls[index][0].baseRequest;
      const contents = request.contents;

      expect(contents).toHaveLength(4);
      expect(contents.filter((part) => part.inlineData)).toHaveLength(2);
      expect(contents[0].text).toContain("Keep furnishings anchored to the same real room locations");
      expect(contents[0].text).toContain("Stage the TARGET room image");
      expect(contents[0].text).not.toContain("TARGET_STRUCTURE_INPUT_REANCHOR");
      expect(contents[0].text).not.toContain("zero feature leakage");
    }
  });
});
