import { applyStructuralConsensusBackstop } from "../src/pipeline/stage2StructuralConsensusBackstop";

describe("stage2 structural consensus backstop", () => {
  it("forces hardFail when 5 structural detectors fail", () => {
    const verdict = {
      hardFail: false,
      category: "unknown",
      violationType: "other",
    };

    const result = applyStructuralConsensusBackstop(verdict, {
      stage: "2",
      validationMode: "FULL_STAGE_ONLY",
      jobId: "job_test_5",
      semantic: {
        windowsStatus: "FAIL",
        wallDriftStatus: "FAIL",
      },
      masked: {
        maskedDriftStatus: "FAIL",
        openingsStatus: "FAIL",
      },
      composite: {
        decision: "FAIL",
      },
    });

    expect(result.applied).toBe(true);
    expect(result.derivedWarnings).toBe(5);
    expect(verdict.hardFail).toBe(true);
    expect(verdict.category).toBe("structure");
    expect(verdict.violationType).toBe("structural_consensus");
  });

  it("does not change hardFail when only 4 detectors fail", () => {
    const verdict = {
      hardFail: false,
      category: "unknown",
      violationType: "other",
    };

    const result = applyStructuralConsensusBackstop(verdict, {
      stage: "2",
      validationMode: "FULL_STAGE_ONLY",
      jobId: "job_test_4",
      semantic: {
        windowsStatus: "FAIL",
        wallDriftStatus: "FAIL",
      },
      masked: {
        maskedDriftStatus: "FAIL",
        openingsStatus: "PASS",
      },
      composite: {
        decision: "FAIL",
      },
    });

    expect(result.applied).toBe(false);
    expect(result.derivedWarnings).toBe(4);
    expect(verdict.hardFail).toBe(false);
    expect(verdict.category).toBe("unknown");
    expect(verdict.violationType).toBe("other");
  });
});
