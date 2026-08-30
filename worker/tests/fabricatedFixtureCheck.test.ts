// Regression tests for combineFabricatedFixtureVerdict (RealEnhance audit
// fix C2 — fixtureFlooringValidator.ts had no equivalent to
// fabricatedOpeningCheck.ts's hallucinated-new-element detection). Pure,
// synchronous function — no network calls, no mocking needed.
import { combineFabricatedFixtureVerdict } from "../src/validators/fabricatedFixtureCheck";
import { ISSUE_TYPES } from "../src/validators/issueTypes";

describe("combineFabricatedFixtureVerdict (C2 fix)", () => {
  it("returns a hard-failing 'fabricated' verdict when the flagged location is confirmed absent from the baseline", () => {
    const result = combineFabricatedFixtureVerdict({
      location: "right-hand wall, roughly waist height",
      locationBbox: [0.6, 0.3, 0.9, 0.6],
      call1Description: "A wall-mounted electric fireplace insert with a stone surround.",
      presentInBaseline: false,
      call2Description: "Plain painted drywall, no fixture of any kind at this location.",
    });

    expect(result.verdict).toBe("fabricated");
    expect(result.outcome.status).toBe("fail");
    expect(result.outcome.hardFail).toBe(true);
    expect(result.outcome.issueType).toBe(ISSUE_TYPES.FIXTURE_FABRICATED);
    expect(result.outcome.reason).toContain("fixture_fabricated");
    expect(result.outcome.reason).toContain("right-hand wall, roughly waist height");
    expect(result.outcome.advisorySignals).toEqual(["fixture_fabricated:right-hand wall, roughly waist height"]);
  });

  it("returns a non-blocking 'baseline_extraction_miss' verdict when the flagged location is confirmed present in the baseline too", () => {
    const result = combineFabricatedFixtureVerdict({
      location: "left wall near the corner",
      locationBbox: [0.05, 0.2, 0.25, 0.5],
      call1Description: "A built-in bookshelf unit.",
      presentInBaseline: true,
      call2Description: "Yes — the same built-in bookshelf is visible here in the baseline photo too.",
    });

    expect(result.verdict).toBe("baseline_extraction_miss");
    expect(result.outcome.status).toBe("pass");
    expect(result.outcome.hardFail).toBe(false);
    expect(result.outcome.issueType).toBe(ISSUE_TYPES.NONE);
    expect(result.outcome.advisorySignals).toEqual(["fixture_baseline_extraction_miss:left wall near the corner"]);
  });

  it("preserves the flagged location and both call descriptions on the fabricated path for downstream logging/audit", () => {
    const result = combineFabricatedFixtureVerdict({
      location: "above the kitchen sink",
      locationBbox: [0.4, 0.1, 0.7, 0.3],
      call1Description: "A pendant light fixture hangs here.",
      presentInBaseline: false,
      call2Description: "No light fixture visible at this location in the baseline.",
    });

    expect(result.ranCall1).toBe(true);
    expect(result.ranCall2).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.location).toBe("above the kitchen sink");
    expect(result.locationBbox).toEqual([0.4, 0.1, 0.7, 0.3]);
    expect(result.call1Description).toBe("A pendant light fixture hangs here.");
    expect(result.call2Description).toBe("No light fixture visible at this location in the baseline.");
  });

  it("handles a null locationBbox (model could not offer a bbox guess) without throwing", () => {
    expect(() =>
      combineFabricatedFixtureVerdict({
        location: "somewhere along the back wall",
        locationBbox: null,
        call1Description: "An AC condenser unit.",
        presentInBaseline: false,
        call2Description: "No AC unit visible.",
      })
    ).not.toThrow();
  });
});
