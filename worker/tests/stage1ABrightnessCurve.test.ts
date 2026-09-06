import {
  computeStage1AFactors,
  applyStage1ABrightnessGuard,
  Stage1AAnalysis,
} from "../src/pipeline/stage1A";

function analysisAt(lumMean: number, overrides: Partial<Stage1AAnalysis> = {}): Stage1AAnalysis {
  return {
    lumMean,
    lumStdev: 40,
    edgeDensity: 20,
    isExterior: false,
    isBlurry: false,
    sceneType: "interior",
    ...overrides,
  };
}

describe("Stage 1A darkness curve", () => {
  it("no longer zeroes out darkness in the 95-135 'visibly dim' band (regression guard)", () => {
    // Before the fix, lumMean 118 sat above the old onset of 95, so
    // darkness (and everything derived from it) was exactly 0 — the entire
    // pre-Gemini tone stack was a no-op for this very common band.
    const factors = computeStage1AFactors(analysisAt(118));
    expect(factors.darkness).toBeGreaterThan(0);
  });

  it("still fully saturates darkness at the existing full-darkness anchor (lumMean <= 45)", () => {
    expect(computeStage1AFactors(analysisAt(45)).darkness).toBe(1);
    expect(computeStage1AFactors(analysisAt(20)).darkness).toBe(1);
  });

  it("reaches zero darkness at and above the new onset (lumMean >= 135)", () => {
    expect(computeStage1AFactors(analysisAt(135)).darkness).toBe(0);
    expect(computeStage1AFactors(analysisAt(150)).darkness).toBe(0);
  });

  it("is monotonically non-increasing as lumMean rises", () => {
    const samples = [40, 50, 60, 70, 80, 90, 100, 110, 118, 125, 135, 150];
    const darknessValues = samples.map((lumMean) => computeStage1AFactors(analysisAt(lumMean)).darkness);
    for (let i = 1; i < darknessValues.length; i += 1) {
      expect(darknessValues[i]).toBeLessThanOrEqual(darknessValues[i - 1]);
    }
  });

  it("keeps gammaBoost and shadowLift as fixed multiples of darkness (coefficient invariant)", () => {
    const factors = computeStage1AFactors(analysisAt(100));
    expect(factors.gammaBoost).toBeCloseTo(factors.darkness * 0.9, 6);
    expect(factors.shadowLift).toBeCloseTo(factors.darkness * 0.75, 6);
  });
});

describe("Stage 1A brightness guard", () => {
  it("passes baseBrightness through unchanged at or below the taper threshold", () => {
    expect(applyStage1ABrightnessGuard(1.0308, 100)).toBe(1.0308);
    expect(applyStage1ABrightnessGuard(1.0308, 125)).toBe(1.0308);
  });

  it("fully tapers to neutral (1.0) once meanBrightness reaches the top of the taper span", () => {
    expect(applyStage1ABrightnessGuard(1.0308, 195)).toBe(1.0);
  });

  it("returns baseBrightness unchanged when meanBrightness is missing or non-finite", () => {
    expect(applyStage1ABrightnessGuard(1.05, undefined)).toBe(1.05);
    expect(applyStage1ABrightnessGuard(1.05, Number.NaN)).toBe(1.05);
  });
});
