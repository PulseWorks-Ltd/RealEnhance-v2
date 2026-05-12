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
  });
});