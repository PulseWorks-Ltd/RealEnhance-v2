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

import { isDisputedVote } from "../src/pipeline/stage2Masked/pipeline";
// Nov 2026, Harcourts job_0a1ff9bf: a 2-to-1 "door blocked" vote on an early
// check is not final; the check runs again on the finished image.
describe("disputed door verdicts", () => {
  it("a split vote is disputed; unanimous or error-only votes are not", () => {
    expect(isDisputedVote({ consensus: { votes: [true, false, true], calls: 3 } })).toBe(true);
    expect(isDisputedVote({ consensus: { votes: [false, true, true], calls: 3 } })).toBe(true);
    expect(isDisputedVote({ consensus: { votes: [true, true], calls: 2 } })).toBe(false);
    expect(isDisputedVote({ consensus: { votes: [true, null, true], calls: 3 } })).toBe(false);
    expect(isDisputedVote({})).toBe(false);
  });
});
