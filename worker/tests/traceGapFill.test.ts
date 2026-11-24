jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { isFillableCutAnyAttempt } from "../src/pipeline/stage2Masked/pipeline";

// Nov 2026, Harcourts job_a900475d: good bedrooms re-staged three times over
// ~1% gaps in the traced outline near a bedside table.
describe("small tracing gaps are filled from Gemini's picture on any attempt", () => {
  it("fills the a900475d gaps", () => {
    for (const m of [
      { areaPct: 1.2, underFurniturePct: 40, shadowPct: 0, floorStd: 40.7 },
      { areaPct: 0.81, underFurniturePct: 41, shadowPct: 0, floorStd: 41.7 },
      { areaPct: 1.57, underFurniturePct: 48, shadowPct: 0, floorStd: 43.8 },
    ]) expect(isFillableCutAnyAttempt(m)).toBe(true);
  });
  it("still re-stages large gaps, mostly-shadow areas and areas not under furniture", () => {
    expect(isFillableCutAnyAttempt({ areaPct: 2.64, underFurniturePct: 92, shadowPct: 11 })).toBe(false);
    expect(isFillableCutAnyAttempt({ areaPct: 1.2, underFurniturePct: 40, shadowPct: 85 })).toBe(false);
    expect(isFillableCutAnyAttempt({ areaPct: 1.2, underFurniturePct: 20, shadowPct: 0 })).toBe(false);
  });
});
