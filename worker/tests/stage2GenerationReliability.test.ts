import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveStage2Model,
  runStage2GenerationAttempt,
  Stage2GenerationFailure,
  Stage2GenerationNoImageError,
} from "../src/pipeline/stage2";
import type { Stage2LayoutPlan } from "../src/pipeline/layoutPlanner";

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

  async function captureStage2Prompt(roomType: string, layoutPlan?: Stage2LayoutPlan | null): Promise<string> {
    runWithPrimaryThenFallbackMock.mockResolvedValue({
      resp: {
        candidates: [{ content: { parts: [{ inlineData: { data: "ZmFrZQ==" } }] } }],
      },
      modelUsed: "gemini-2.5-flash-image",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-prompt-"));
    const basePath = path.join(tempDir, "base.webp");
    const outputPath = path.join(tempDir, "out.webp");
    fs.writeFileSync(basePath, "base");

    await runStage2GenerationAttempt(basePath, {
      roomType,
      jobId: `job-test-prompt-${roomType}`,
      imageId: `img-test-prompt-${roomType}`,
      outputPath,
      attempt: 1,
      layoutPlan: layoutPlan ?? undefined,
    });

    const call = runWithPrimaryThenFallbackMock.mock.calls.at(-1);
    expect(call).toBeDefined();
    return call?.[0]?.baseRequest?.contents?.[0]?.text;
  }

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
        imageId: "img-test-no-image",
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
        imageId: "img-test-collapse",
        outputPath: basePath,
        attempt: 1,
      })
    ).rejects.toBeInstanceOf(Stage2GenerationFailure);
  });

    it.each([
      "DINING",
      "LIVING_DINING",
      "KITCHEN_DINING",
      "MULTIPLE_LIVING",
    ])("applies dining ceiling suppression for %s", async (roomType) => {
      const prompt = await captureStage2Prompt(roomType);

      expect(prompt).toContain("Do not add pendant lights, hanging lights, chandeliers, or any other ceiling light fixtures above dining tables. Use existing room lighting only.");
    });

    it.each([
      "BEDROOM",
      "BATHROOM",
      "OFFICE",
      "EXTERIOR",
      "LIVING_ROOM",
    ])("does not apply dining ceiling suppression for %s", async (roomType) => {
      const prompt = await captureStage2Prompt(roomType);

      expect(prompt).not.toContain("Do not add pendant lights, hanging lights, chandeliers, or any other ceiling light fixtures above dining tables. Use existing room lighting only.");
    });

    it("uses minimal planner directive when STAGE2_MINIMAL_PLANNER_MODE is enabled", async () => {
      process.env.STAGE2_MINIMAL_PLANNER_MODE = "true";
      const prompt = await captureStage2Prompt("living_room");

      expect(prompt).toContain("ROLE: Real Estate Interior Photographer and Staging Consultant");
      expect(prompt).toContain("CAMERA COMPOSITION AUTHORITY");
      expect(prompt).toContain("ROOM FUNCTION AUTHORITY");
      expect(prompt).toContain("Do not create showroom-style furniture layouts.");
      expect(prompt).toContain("MINIMAL STAGING DIRECTIVE");
      expect(prompt).toContain("Stage this room in a modern real-estate style.");
      expect(prompt).toContain("Preserve all architecture exactly.");
      expect(prompt).not.toContain("FULL-SYNTHESIS LOGIC — MANDATORY");
      expect(prompt).not.toContain("REFRESH LOGIC — FLEXIBLE STAGING MODE");
    });

    it("applies composition-authority opening to BEDROOM in minimal planner mode", async () => {
      process.env.STAGE2_MINIMAL_PLANNER_MODE = "true";
      const prompt = await captureStage2Prompt("bedroom");

      expect(prompt).toContain("ROLE: Real Estate Interior Photographer and Staging Consultant");
      expect(prompt).toContain("CAMERA COMPOSITION AUTHORITY");
      expect(prompt).toContain("ROOM FUNCTION AUTHORITY");
      expect(prompt).toContain("Do not create showroom-style furniture layouts.");
      expect(prompt).toContain("Stage as: bedroom");
      expect(prompt).toContain("MINIMAL STAGING DIRECTIVE");
      expect(prompt).not.toContain("FULL-SYNTHESIS LOGIC — MANDATORY");
      expect(prompt).not.toContain("REFRESH LOGIC — FLEXIBLE STAGING MODE");
    });

    it("bypasses layout planner instructions in minimal planner mode", async () => {
      process.env.STAGE2_MINIMAL_PLANNER_MODE = "1";
      const layoutPlan: Stage2LayoutPlan = {
        room_type: "living_room",
        layout: [{ item: "sofa", placement: "centered on focal wall" }],
        avoid_zones: ["window_wall"],
        anchorItem: "sofa_group",
      };

      const prompt = await captureStage2Prompt("living_room", layoutPlan);

      expect(prompt).not.toContain("Use the following furniture placement plan exactly.");
      expect(prompt).not.toContain("ANCHOR REGION GUIDANCE (SOFT, NOT A HARD MASK)");
      expect(prompt).not.toContain("PLAN_JSON:");
    });
});
