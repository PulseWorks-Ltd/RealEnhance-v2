jest.mock("../src/ai/gemini", () => ({
  getGeminiClient: jest.fn(),
}));

jest.mock("../src/utils/images", () => ({
  toBase64: jest.fn(() => ({ data: "ZmFrZQ==" })),
}));

import { getGeminiClient } from "../src/ai/gemini";
import { runGeminiSemanticValidator } from "../src/validators/geminiSemanticValidator";

describe("runGeminiSemanticValidator - stage2 opening identity lock", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("keeps hardFail=true and downgradeApplied=false for opening_removed even with topology PASS + moderate drift", async () => {
    const geminiResponse = {
      hardFail: true,
      category: "structure",
      reasons: ["Opening removed and replaced by a continuous wall plane."],
      confidence: 0.96,
      violationType: "opening_removed",
      builtInDetected: false,
      structuralAnchorCount: 0,
    };

    (getGeminiClient as jest.Mock).mockReturnValue({
      models: {
        generateContent: jest.fn().mockResolvedValue({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(geminiResponse) }],
              },
            },
          ],
        }),
      },
    });

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const verdict = await runGeminiSemanticValidator({
      basePath: "/tmp/base.webp",
      candidatePath: "/tmp/candidate.webp",
      stage: "2",
      validationMode: "FULL_STAGE_ONLY",
      sceneType: "interior",
      evidence: {
        jobId: "job_test_opening_removed",
        stage: "2",
        roomType: "bedroom",
        ssim: 0.5,
        ssimThreshold: 0.97,
        ssimPassed: false,
        openings: {
          windowsBefore: 2,
          windowsAfter: 2,
          doorsBefore: 1,
          doorsAfter: 1,
        },
        anchorChecks: {
          island: false,
          hvac: false,
          cabinetry: false,
          lighting: false,
        },
        drift: {
          wallPercent: 24,
          maskedEdgePercent: 20,
          angleDegrees: 0,
        },
        localFlags: [],
        geometryProfile: "SOFT",
        topologyResult: "PASS",
      } as any,
      riskLevel: "MEDIUM",
    });

    expect(verdict.hardFail).toBe(true);

    const decisionLog = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("[STRUCTURAL_GEMINI_DECISION]"));

    expect(decisionLog).toContain("openingViolationDetected=true");
    expect(decisionLog).toContain("hardFail=true");
    expect(decisionLog).toContain("downgradeApplied=false");
  });
});
