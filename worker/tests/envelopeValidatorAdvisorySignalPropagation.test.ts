const {
  buildEnvelopeAdvisoryStructuredIssues,
  describeCenterFractionLocation,
} = require("../src/validators/envelopeValidator");
const { buildStructuredIssueContext } = require("../src/validators/runValidation");

// Regression coverage for the bug found reviewing job_f6940e0e (mantel/wall alteration
// that passed Stage 2 despite the deterministic envelope check detecting it): the
// Vertical-Edge-Delta corner-persistence signal was pushed into `advisorySignals` but
// never into `structuredIssues`, and Stage 2's advisory injection only reads
// `structuredIssues` — so the signal never reached the final adjudicating Gemini call.
describe("envelope VED advisory -> structuredIssue propagation", () => {
  it("produces a structuredIssue for a corner-flattened VED finding, even though Gemini's own quick check passed", () => {
    const issues = buildEnvelopeAdvisoryStructuredIssues({
      claim: "corner_flattened",
      confidence: 0.85,
      worstRetention: 0.621,
      junctionCount: 32,
      locationHint: "right side of the image",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: "envelope_change",
      object: "wall_plane (right side of the image)",
      action: "flattened",
      severity: "critical",
      source: "envelope_validator_ved",
      confidence: 0.85,
    });
    expect(issues[0].evidence).toEqual(
      expect.arrayContaining([
        "corner_flattened",
        "deterministic_vertical_edge_delta",
        "worst_retention_0.621",
        "junction_count_32",
      ]),
    );
  });

  it("produces a structuredIssue for a vertical-edge-loss VED finding", () => {
    const issues = buildEnvelopeAdvisoryStructuredIssues({
      claim: "wall_plane_modified",
      confidence: 0.6,
      worstRetention: 0.7,
      junctionCount: 5,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: "envelope_change",
      object: "wall_plane",
      action: "changed",
    });
  });

  it("reaches the final adjudicator's advisory text exactly like an opening finding would", () => {
    // This is the end of the pipeline that was silently empty for job_f6940e0e:
    // STAGE2_ADVISORY_INJECTION builds its "Specialist Semantic Context" from
    // buildStructuredIssueContext(specialistStructuredIssues). Feeding the envelope
    // structuredIssue through the same function it's fed in production confirms the
    // advisory now actually surfaces to the adjudicator.
    const issues = buildEnvelopeAdvisoryStructuredIssues({
      claim: "corner_flattened",
      confidence: 0.85,
      worstRetention: 0.621,
      junctionCount: 32,
      locationHint: "right side of the image",
    });

    const context = buildStructuredIssueContext(issues);

    expect(context).toHaveLength(1);
    expect(context[0]).toContain("envelope specialist");
    expect(context[0]).toContain("This context is non-binding and must be visually verified.");
  });

  it("phrases coarse left/center/right locations from a normalized region center", () => {
    expect(describeCenterFractionLocation(0.1)).toBe("left side of the image");
    expect(describeCenterFractionLocation(0.5)).toBe("center of the image");
    expect(describeCenterFractionLocation(0.9)).toBe("right side of the image");
  });
});
