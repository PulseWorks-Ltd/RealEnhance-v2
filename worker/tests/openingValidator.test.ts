import { parseOpeningResult } from "../src/validators/openingValidator";

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
});