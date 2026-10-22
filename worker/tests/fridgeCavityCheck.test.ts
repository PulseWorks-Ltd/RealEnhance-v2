// Regression tests for the fridge-cavity insertion eligibility check (see
// fridgeCavityCheck.ts's own header for the full design rationale): Stage
// 2 staging is normally strictly forbidden from adding any large/floor-
// standing item to a kitchen zone. This narrow exception permits inserting
// exactly one refrigerator into a confirmed-empty, purpose-built cavity,
// only when no fridge already exists anywhere else in the room. Every
// other appliance and floor item remains locked regardless of this
// check's result.
//
// Pure, offline-testable "code decides" function — no Gemini mocking,
// matching this repo's established testing convention (see
// openingOcclusionGuard.ts's file header).
import { evaluateFridgeCavityEligibility, type FridgeCavityObservation } from "../src/validators/fridgeCavityCheck";

function makeObservation(overrides: Partial<FridgeCavityObservation> = {}): FridgeCavityObservation {
  return {
    fridgeAlreadyPresent: "no",
    fridgeAlreadyPresentDescription: "no fridge visible in this photo",
    cavityPresent: "yes",
    cavityDescription: "an empty gap in the cabinetry run, flanked by cabinets on both sides",
    cavityBbox: [0.6, 0.3, 0.78, 0.9],
    ...overrides,
  };
}

describe("evaluateFridgeCavityEligibility", () => {
  it("is eligible when a cavity is confirmed and no fridge is present anywhere", () => {
    const result = evaluateFridgeCavityEligibility(makeObservation());
    expect(result.eligible).toBe(true);
    expect(result.cavityBbox).toEqual([0.6, 0.3, 0.78, 0.9]);
  });

  it("is not eligible when a fridge is already present, even with a confirmed cavity", () => {
    const result = evaluateFridgeCavityEligibility(
      makeObservation({ fridgeAlreadyPresent: "yes", fridgeAlreadyPresentDescription: "a stainless steel french-door fridge on the left wall" })
    );
    expect(result.eligible).toBe(false);
    expect(result.cavityBbox).toBeNull();
  });

  it("is not eligible when fridge presence is uncertain ('cannot_tell') — fails closed, does not assume absence", () => {
    const result = evaluateFridgeCavityEligibility(makeObservation({ fridgeAlreadyPresent: "cannot_tell" }));
    expect(result.eligible).toBe(false);
  });

  it("is not eligible when no cavity is confirmed", () => {
    const result = evaluateFridgeCavityEligibility(makeObservation({ cavityPresent: "no", cavityBbox: null }));
    expect(result.eligible).toBe(false);
    expect(result.cavityBbox).toBeNull();
  });

  it("is not eligible when cavity presence is uncertain ('cannot_tell') — fails closed, does not assume presence", () => {
    const result = evaluateFridgeCavityEligibility(makeObservation({ cavityPresent: "cannot_tell", cavityBbox: null }));
    expect(result.eligible).toBe(false);
  });

  it("is not eligible when cavityPresent is 'yes' but no bbox was returned (malformed/incomplete observation)", () => {
    const result = evaluateFridgeCavityEligibility(makeObservation({ cavityBbox: null }));
    expect(result.eligible).toBe(false);
  });
});
