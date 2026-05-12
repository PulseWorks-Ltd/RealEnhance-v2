import { analyzeEnvelopeOpeningRelation } from "../src/validators/envelopeArbitration";
import { buildStructuredIssueContext } from "../src/validators/runValidation";

describe("envelope arbitration relation analysis", () => {
  it("does not treat advisory envelope structural findings as contradiction", () => {
    const analysis = analyzeEnvelopeOpeningRelation({
      reason: "envelope_corner_flattened: wall-plane corner collapsed. envelope_confirmed_structural_change: doorway filled and replaced by continuous wall.",
      advisorySignals: [
        "envelope_confirmed_structural_change",
        "envelope_corner_flattened",
      ],
      issueType: "envelope_corner_flattened" as any,
      semanticIssueType: "envelope_corner_flattened" as any,
      pass: true,
      hardFail: false,
      structuredIssues: [
        {
          type: "envelope_change",
          object: "wall_plane",
          action: "flattened",
          severity: "critical",
          source: "envelope_validator",
          confidence: 0.99,
          evidence: ["envelope_confirmed_structural_change"],
        },
      ],
    });

    expect(analysis.envelopeConfirmsStructuralChange).toBe(true);
    expect(analysis.envelopeHasSemanticAuthority).toBe(true);
    expect(analysis.explicitContradiction).toBe(false);
    expect(analysis.nonContradictoryAdvisory).toBe(true);
  });

  it("requires explicit preservation semantics before contradiction is true", () => {
    const analysis = analyzeEnvelopeOpeningRelation({
      reason: "The architectural envelope, including all visible wall planes, openings, and ceiling geometry, remains identical between the baseline and staged images.",
      issueType: "none" as any,
      pass: true,
      hardFail: false,
    });

    expect(analysis.envelopeConfirmsStructuralChange).toBe(false);
    expect(analysis.explicitContradiction).toBe(true);
    expect(analysis.explicitPreservationSignals).toEqual(
      expect.arrayContaining(["architectural_envelope_identical"])
    );
  });
});

describe("buildStructuredIssueContext", () => {
  it("includes envelope change semantic context separately from openings", () => {
    const context = buildStructuredIssueContext([
      {
        type: "envelope_change",
        object: "wall_plane",
        action: "flattened",
        severity: "critical",
        source: "envelope_validator",
        confidence: 0.98,
        evidence: ["envelope_confirmed_structural_change", "continuous_surface_replacement"],
      },
    ]);

    expect(context).toHaveLength(1);
    expect(context[0]).toContain("envelope structural change affecting wall_plane");
    expect(context[0]).toContain("envelope specialist");
    expect(context[0]).toContain("envelope_confirmed_structural_change");
  });
});