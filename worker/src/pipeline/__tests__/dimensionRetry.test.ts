import fs from "fs";
import os from "os";
import path from "path";
import { STRICT_DIMENSION_PROMPT_SUFFIX } from "../../utils/dimensionGuard";

const mockStageAwareConfig = {
  enabled: true,
  stage2EdgeMode: "structure_only" as const,
  stage2ExcludeLowerPct: 0.4,
  gateMinSignals: 2,
  iouMinPixelsRatio: 0.005,
  logArtifactsOnFail: true,
  maxRetryAttempts: 1,
  paintOverEnable: true,
  paintOverEdgeRatioMin: 0.35,
  paintOverTexRatioMin: 0.45,
  paintOverMinRoiArea: 0.005,
  stage1AThresholds: { edgeIouMin: 0.6, structIouMin: 0.3 },
  stage1BThresholds: {
    edgeIouMin: 0.5,
    structIouMin: 0.4,
    lineEdgeMin: 0.6,
    unifiedMin: 0.55,
    edgeMode: "structure_only" as const,
    excludeLowerPct: 0.2,
  },
  stage1BHardFailSwitches: {
    blockOnWindowCountChange: true,
    blockOnWindowPositionChange: false,
    blockOnOpeningsDelta: false,
  },
  stage2Thresholds: {
    edgeIouMin: 0.6,
    structIouMin: 0.55,
    lineEdgeMin: 0.7,
    unifiedMin: 0.65,
  },
  hardFailSwitches: {
    blockOnWindowCountChange: false,
    blockOnWindowPositionChange: false,
    blockOnOpeningsDelta: false,
  },
  blockOnDimensionMismatch: true,
};

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  jest.restoreAllMocks();
});

jest.mock("../../utils/dimensionGuard", () => {
  const actual = jest.requireActual("../../utils/dimensionGuard");
  return {
    ...actual,
    compareImageDimensions: jest.fn(),
  };
});

const enhanceWithGeminiMock = jest.fn();
jest.mock("../../ai/gemini", () => ({
  enhanceWithGemini: (...args: any[]) => enhanceWithGeminiMock(...args),
  getGeminiClient: jest.fn(() => ({})),
}));

const runWithPrimaryThenFallbackMock = jest.fn();
jest.mock("../../ai/runWithImageModelFallback", () => ({
  runWithPrimaryThenFallback: (...args: any[]) => runWithPrimaryThenFallbackMock(...args),
}));

jest.mock("../../validators/structural/stageAwareValidator", () => ({
  validateStructureStageAware: jest.fn().mockResolvedValue({
    stage: "stage2",
    mode: "block",
    passed: true,
    risk: false,
    score: 1,
    triggers: [],
    metrics: {},
    debug: {},
  }),
}));

jest.mock("../../validators/stageRetryManager", () => ({
  shouldRetryStage: jest.fn(() => ({ shouldRetry: false, reason: "no retry", tightenLevel: 0, isFinalAttempt: false })),
  markStageFailed: jest.fn(),
  logRetryState: jest.fn(),
}));

jest.mock("../../validators/validatorMode", () => ({
  shouldValidatorBlock: jest.fn(() => true),
  getValidatorMode: jest.fn(() => "block"),
}));

jest.mock("../../validators/stageAwareConfig", () => ({
  loadStageAwareConfig: jest.fn(() => mockStageAwareConfig),
  chooseStage2Baseline: jest.fn(({ stage1APath, stage1BPath }: { stage1APath: string; stage1BPath?: string | null }) => ({
    baselinePath: stage1BPath && stage1BPath !== stage1APath ? stage1BPath : stage1APath,
    baselineStage: stage1BPath && stage1BPath !== stage1APath ? "1B" : "1A",
  })),
}));

import { compareImageDimensions } from "../../utils/dimensionGuard";
import { runStage1B } from "../stage1B";
import { runStage2 } from "../stage2";
import { validateStructureStageAware } from "../../validators/structural/stageAwareValidator";

describe("dimension guard retry flows", () => {
  const envBackup = { ...process.env };
  const compareImageDimensionsMock = compareImageDimensions as jest.MockedFunction<typeof compareImageDimensions>;

  beforeEach(() => {
    compareImageDimensionsMock.mockReset();
    enhanceWithGeminiMock.mockReset();
    runWithPrimaryThenFallbackMock.mockReset();
    (validateStructureStageAware as jest.Mock).mockClear();
    process.env = { ...envBackup, USE_GEMINI_STAGE2: "1", REALENHANCE_API_KEY: "test" };
    mockStageAwareConfig.maxRetryAttempts = 1;
    mockStageAwareConfig.blockOnDimensionMismatch = true;
  });

  afterAll(() => {
    process.env = envBackup;
  });

  const writeTmpFile = (dir: string, name: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "data");
    return p;
  };

  test("stage1B retries once for dimension mismatch and succeeds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage1b-dim-"));
    const stage1A = writeTmpFile(dir, "img-1A.webp");
    const firstOut = writeTmpFile(dir, "gemini-first.webp");
    const retryOut = writeTmpFile(dir, "gemini-retry.webp");

    compareImageDimensionsMock
      .mockResolvedValueOnce({ ok: false, baseline: { width: 100, height: 80 }, candidate: { width: 110, height: 82 }, message: "mismatch" })
      .mockResolvedValueOnce({ ok: true, baseline: { width: 100, height: 80 }, candidate: { width: 100, height: 80 }, message: "match" });

    enhanceWithGeminiMock.mockResolvedValueOnce(firstOut).mockResolvedValueOnce(retryOut);

    const result = await runStage1B(stage1A, { declutterMode: "stage-ready" });

    const expectedRetryPath = path.join(dir, "img-1A-1B-dimretry.webp");
    expect(result).toBe(expectedRetryPath);
    expect(enhanceWithGeminiMock).toHaveBeenCalledTimes(2);
    expect(enhanceWithGeminiMock.mock.calls[1][1].promptOverride).toContain(STRICT_DIMENSION_PROMPT_SUFFIX);
    expect(validateStructureStageAware).toHaveBeenCalled();
  });

  test("stage1B blocks when retry still mismatches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage1b-dim-block-"));
    const stage1A = writeTmpFile(dir, "img-1A.webp");
    const firstOut = writeTmpFile(dir, "gemini-first.webp");
    const retryOut = writeTmpFile(dir, "gemini-retry.webp");

    compareImageDimensionsMock
      .mockResolvedValueOnce({ ok: false, baseline: { width: 100, height: 80 }, candidate: { width: 110, height: 82 }, message: "mismatch" })
      .mockResolvedValueOnce({ ok: false, baseline: { width: 100, height: 80 }, candidate: { width: 120, height: 90 }, message: "mismatch" });

    enhanceWithGeminiMock.mockResolvedValueOnce(firstOut).mockResolvedValueOnce(retryOut);

    const result = await runStage1B(stage1A, { declutterMode: "stage-ready" });

    expect(result).toBeNull();
    expect(enhanceWithGeminiMock).toHaveBeenCalledTimes(2);
    expect(validateStructureStageAware).not.toHaveBeenCalled();
  });

  test("stage2 retries once for dimension mismatch and succeeds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-dim-"));
    const basePath = writeTmpFile(dir, "img-1B.webp");
    const stage1APath = writeTmpFile(dir, "img-1A.webp");

    compareImageDimensionsMock
      .mockResolvedValueOnce({ ok: false, baseline: { width: 1184, height: 864 }, candidate: { width: 1216, height: 880 }, message: "mismatch" })
      .mockResolvedValueOnce({ ok: true, baseline: { width: 1184, height: 864 }, candidate: { width: 1184, height: 864 }, message: "match" });

    const firstB64 = Buffer.from("first").toString("base64");
    const retryB64 = Buffer.from("retry").toString("base64");

    runWithPrimaryThenFallbackMock
      .mockResolvedValueOnce({ resp: { candidates: [{ content: { parts: [{ inlineData: { data: firstB64 } }] } }] }, modelUsed: "test" })
      .mockResolvedValueOnce({ resp: { candidates: [{ content: { parts: [{ inlineData: { data: retryB64 } }] } }] }, modelUsed: "test" });

    const result = await runStage2(basePath, "1B", { roomType: "living room", stage1APath, stage1BPath: basePath });

    const expectedRetryPath = path.join(dir, "img-1B-2-retry1-dimretry.webp");
    expect(result).toBe(expectedRetryPath);
    expect(runWithPrimaryThenFallbackMock).toHaveBeenCalledTimes(2);
    expect(validateStructureStageAware).toHaveBeenCalled();
  });

  test("stage2 blocks when retry still mismatches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-dim-block-"));
    const basePath = writeTmpFile(dir, "img-1B.webp");
    const stage1APath = writeTmpFile(dir, "img-1A.webp");

    compareImageDimensionsMock
      .mockResolvedValueOnce({ ok: false, baseline: { width: 1184, height: 864 }, candidate: { width: 1216, height: 880 }, message: "mismatch" })
      .mockResolvedValueOnce({ ok: false, baseline: { width: 1184, height: 864 }, candidate: { width: 1200, height: 900 }, message: "mismatch" });

    const firstB64 = Buffer.from("first-block").toString("base64");
    const retryB64 = Buffer.from("retry-block").toString("base64");

    runWithPrimaryThenFallbackMock
      .mockResolvedValueOnce({ resp: { candidates: [{ content: { parts: [{ inlineData: { data: firstB64 } }] } }] }, modelUsed: "test" })
      .mockResolvedValueOnce({ resp: { candidates: [{ content: { parts: [{ inlineData: { data: retryB64 } }] } }] }, modelUsed: "test" });

    const result = await runStage2(basePath, "1B", { roomType: "bedroom", stage1APath, stage1BPath: basePath });

    expect(result).toBeNull();
    expect(runWithPrimaryThenFallbackMock).toHaveBeenCalledTimes(2);
    expect(validateStructureStageAware).not.toHaveBeenCalled();
  });
});
