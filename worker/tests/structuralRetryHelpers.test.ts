import { buildStructuralRetryInjection, classifyStructuralFailure } from "../src/pipeline/structuralRetryHelpers";

describe("structural retry helpers", () => {
  it("classifies composite failure reasons", () => {
    expect(classifyStructuralFailure({ failed: true, reason: "catastrophic_override_structDeg_gt_85" })).toBe("CATASTROPHIC_ORIENTATION");
    expect(classifyStructuralFailure({ failed: true, reason: "composite_structural_distortion" })).toBe("STRUCTURAL_DISTORTION");
    expect(classifyStructuralFailure({ failed: true, reason: "functional_opening_suppression" })).toBe("OPENING_SUPPRESSION");
    expect(classifyStructuralFailure({ failed: false, reason: "composite_structural_distortion" })).toBeNull();
  });

  it("applies tier rules and catastrophic no-relaxation guard", () => {
    const tier1Distortion = buildStructuralRetryInjection({ compositeFail: true, failureType: "STRUCTURAL_DISTORTION", attemptNumber: 1 });
    expect(tier1Distortion?.retryTier).toBe(1);
    expect(tier1Distortion?.retryInjection).toContain("Preserve all original wall planes exactly");
    expect(tier1Distortion?.retryInjection).not.toContain("Reduce furniture quantity if necessary");

    const tier2Distortion = buildStructuralRetryInjection({ compositeFail: true, failureType: "STRUCTURAL_DISTORTION", attemptNumber: 2 });
    expect(tier2Distortion?.retryTier).toBe(2);
    expect(tier2Distortion?.retryInjection).toContain("Reduce furniture quantity if necessary");

    const tier2Catastrophic = buildStructuralRetryInjection({ compositeFail: true, failureType: "CATASTROPHIC_ORIENTATION", attemptNumber: 2 });
    expect(tier2Catastrophic?.retryInjection).toContain("Preserve the exact original camera position");
    expect(tier2Catastrophic?.retryInjection).not.toContain("Reduce furniture quantity if necessary");
  });
});
