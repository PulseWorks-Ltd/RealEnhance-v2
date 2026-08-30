// Regression tests for shouldRescueBaselineExtractionMiss
// (occlusionVsRemovalCheck.ts) — extracted during the RealEnhance audit
// fixes C2/C3 implementation so openingEnvelopeValidator.ts's
// fabricatedOpeningCheck integration and fixtureFlooringValidator.ts's new
// fabricatedFixtureCheck integration share one tested implementation.
// Covers the real production case (job_b29d5e7d-adjacent doorway/window
// swap) that originally motivated the overlap-scoping logic, plus the
// fixture-side equivalent scenario.
import { shouldRescueBaselineExtractionMiss } from "../src/validators/occlusionVsRemovalCheck";

describe("shouldRescueBaselineExtractionMiss", () => {
  it("rescues when there is no flagged bbox at all — nothing to conflict with", () => {
    expect(shouldRescueBaselineExtractionMiss(null, [[0.1, 0.1, 0.3, 0.3]])).toBe(true);
    expect(shouldRescueBaselineExtractionMiss(undefined, [[0.1, 0.1, 0.3, 0.3]])).toBe(true);
  });

  it("rescues when there are no failing items to check overlap against", () => {
    expect(shouldRescueBaselineExtractionMiss([0.1, 0.1, 0.3, 0.3], [])).toBe(true);
  });

  it("rescues when the flagged location does not overlap any failing item's bbox — the true baseline-extraction-miss case", () => {
    const flaggedBbox: [number, number, number, number] = [0.05, 0.05, 0.15, 0.15]; // far corner
    const failingItemBboxes: Array<[number, number, number, number]> = [[0.6, 0.6, 0.9, 0.9]]; // unrelated, far away
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, failingItemBboxes)).toBe(true);
  });

  it("does NOT rescue when the flagged location significantly overlaps the exact item that is failing — the real job_b29d5e7d doorway/window swap regression", () => {
    // D1's own baseline bbox — the doorway that was actually replaced by a
    // fabricated window wider than D1's own footprint.
    const d1Bbox: [number, number, number, number] = [0.3, 0.1, 0.5, 0.9];
    // fabricatedOpeningCheck's call 1 flagged a slightly wider region
    // largely coinciding with D1's own location (the wider fabricated
    // window's own extent).
    const flaggedBbox: [number, number, number, number] = [0.28, 0.1, 0.55, 0.9];
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, [d1Bbox])).toBe(false);
  });

  it("does not rescue when overlap meets the threshold exactly (>= 0.3, not > 0.3)", () => {
    // Two equal-area (1x1) boxes offset so their intersection is exactly
    // 30% of either box's own area: intersection width (1 - 0.7) * height 1
    // = 0.3; bboxOverlapFraction = intersection / min(areaA, areaB) = 0.3/1.
    const failingItemBbox: [number, number, number, number] = [0, 0, 1, 1];
    const flaggedBbox: [number, number, number, number] = [0.7, 0, 1.7, 1];
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, [failingItemBbox], 0.3)).toBe(false);
  });

  it("rescues when overlap is just under the threshold", () => {
    // Same construction, offset by 0.71 instead of 0.7 → overlap fraction
    // 0.29, just under the 0.3 threshold.
    const failingItemBbox: [number, number, number, number] = [0, 0, 1, 1];
    const flaggedBbox: [number, number, number, number] = [0.71, 0, 1.71, 1];
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, [failingItemBbox], 0.3)).toBe(true);
  });

  it("checks overlap against EVERY failing item, not just the first — does not rescue if ANY one overlaps", () => {
    const flaggedBbox: [number, number, number, number] = [0.6, 0.6, 0.9, 0.9];
    const unrelatedItem: [number, number, number, number] = [0.05, 0.05, 0.15, 0.15];
    const overlappingItem: [number, number, number, number] = [0.55, 0.55, 0.95, 0.95];
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, [unrelatedItem, overlappingItem])).toBe(false);
  });

  it("safely skips undefined bboxes in the failing-items list (an item with no resolvable baseline bbox) rather than throwing", () => {
    const flaggedBbox: [number, number, number, number] = [0.1, 0.1, 0.3, 0.3];
    expect(() => shouldRescueBaselineExtractionMiss(flaggedBbox, [undefined, [0.6, 0.6, 0.9, 0.9]])).not.toThrow();
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, [undefined, [0.6, 0.6, 0.9, 0.9]])).toBe(true);
  });

  it("fixture-side equivalent: does not rescue when the flagged fixture location overlaps the fixture that is actually failing", () => {
    // A fireplace's own baseline bbox, genuinely altered (e.g. mantel
    // removed) — the standard fixture check correctly failed it.
    const fireplaceBbox: [number, number, number, number] = [0.35, 0.4, 0.65, 0.9];
    // fabricatedFixtureCheck's call 1 flagged a similar, largely
    // coinciding region (a redrawn/altered fireplace reading as "unlisted"
    // because its new appearance doesn't closely match the old bbox).
    const flaggedBbox: [number, number, number, number] = [0.33, 0.4, 0.68, 0.9];
    expect(shouldRescueBaselineExtractionMiss(flaggedBbox, [fireplaceBbox])).toBe(false);
  });
});
