import { parseEnvelopeResult } from "../src/validators/envelopeValidator";

describe("envelope validator structured issue emission", () => {
  it("emits structured issue for confirmed wall-plane flattening", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      ok: false,
      reason: "wall plane replaced",
      confidence: 0.78,
      boundaryLinesMissing: true,
      continuousSurfaceReplacement: true,
      noPlausibleVisualExplanation: true,
      visualAmbiguity: false,
    }));

    expect(result.primaryStructuredIssue).toMatchObject({
      type: "envelope_change",
      object: "wall_plane",
      action: "flattened",
      severity: "review",
      source: "envelope_validator",
      confidence: 0.78,
    });
    expect(result.structuredIssues).toHaveLength(1);
    expect(result.primaryStructuredIssue?.evidence).toEqual(
      expect.arrayContaining([
        "envelope_confirmed_structural_change",
        "boundary_lines_missing",
        "continuous_surface_replacement",
      ])
    );
    expect(result.hardFail).toBe(true);
  });

  it("keeps ambiguous envelope changes advisory", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      ok: false,
      reason: "envelope_changed",
      confidence: 0.55,
      boundaryLinesMissing: false,
      continuousSurfaceReplacement: false,
      noPlausibleVisualExplanation: false,
      visualAmbiguity: true,
    }));

    expect(result.hardFail).toBe(false);
    expect(result.advisory).toBe(true);
  });

  it("derives overall failure from structural verification statements", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      confidence: 0.84,
      analysis: "A new return wall is now visible.",
      verifications: [
        {
          statementId: "stmt_01",
          statement: "No additional permanent wall planes are visible beyond the baseline wall set.",
          scope: "structural",
          answer: "FALSE",
          reason: "A new return wall is visible on the right side.",
          observedVisibilityMagnitude: "partial",
        },
        {
          statementId: "stmt_02",
          statement: "The front wall is partially visible.",
          scope: "structural",
          answer: "TRUE",
        },
      ],
      visualAmbiguity: false,
      boundaryLinesMissing: true,
      continuousSurfaceReplacement: true,
      noPlausibleVisualExplanation: true,
    }));

    expect(result.status).toBe("fail");
    expect(result.architecturalAnswer).toBe("TRUE");
    expect(result.baselineVerificationResults).toHaveLength(2);
    expect(result.baselineVerificationResults?.[0]).toMatchObject({
      statementId: "stmt_01",
      answer: "FALSE",
      observedVisibilityMagnitude: "partial",
    });
  });
});