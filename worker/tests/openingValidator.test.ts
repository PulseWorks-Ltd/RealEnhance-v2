import { analyzeOpeningSignalCoherence, parseOpeningResult } from "../src/validators/openingValidator";

describe("opening validator structured issue emission", () => {
  it("emits structured issue for removed opening result", () => {
    const result = parseOpeningResult(JSON.stringify({
      pass: false,
      issueType: "opening_removed",
      confidence: 0.95,
      details: [
        {
          id: "opening_1",
          classification: "removed",
          reason: "opening removed",
        },
      ],
    }));

    expect(result.primaryStructuredIssue).toMatchObject({
      type: "opening_change",
      object: "opening",
      action: "removed",
      severity: "critical",
      source: "opening_validator",
      confidence: 0.95,
    });
    expect(result.structuredIssues).toHaveLength(1);
    expect(result.primaryStructuredIssue?.evidence).toContain("opening_removed");
  });

  it("treats destructive opening bundles as coherent when resize is supportive", () => {
    const analysis = analyzeOpeningSignalCoherence({
      issueType: "opening_infilled",
      allIssueTypes: ["opening_infilled", "opening_sealed", "opening_resized"],
      hasResize: true,
      hasOcclusion: false,
      hasBandMismatch: false,
    });

    expect(analysis.coherent).toBe(true);
    expect(analysis.primaryDestructiveStates).toEqual(
      expect.arrayContaining(["opening_infilled", "opening_sealed"])
    );
    expect(analysis.supportiveModifiers).toContain("opening_resized");
    expect(analysis.contradictions).toEqual([]);
  });

  it("downgrades only true contradiction bundles", () => {
    const analysis = analyzeOpeningSignalCoherence({
      issueType: "opening_removed",
      allIssueTypes: ["opening_removed", "opening_added", "openings_preserved"],
      hasResize: false,
      hasOcclusion: false,
      hasBandMismatch: false,
    });

    expect(analysis.coherent).toBe(false);
    expect(analysis.contradictions).toEqual(
      expect.arrayContaining([
        "preserved_state_conflicts_with_destructive_state",
        "opening_added_without_relocation_explanation",
      ])
    );
  });

  it("keeps removed plus geometry modifiers coherent", () => {
    const analysis = analyzeOpeningSignalCoherence({
      issueType: "opening_removed",
      allIssueTypes: [
        "opening_removed",
        "opening_infilled",
        "opening_sealed",
        "opening_resized",
        "opening_band_mismatch",
      ],
      hasResize: true,
      hasOcclusion: false,
      hasBandMismatch: true,
    });

    expect(analysis.coherent).toBe(true);
    expect(analysis.primaryDestructiveStates).toEqual(
      expect.arrayContaining(["opening_removed", "opening_infilled", "opening_sealed"])
    );
    expect(analysis.supportiveModifiers).toEqual(
      expect.arrayContaining(["opening_resized", "opening_band_mismatch"])
    );
    expect(analysis.contradictions).toEqual([]);
  });
});