const { parseEnvelopeResult } = require("../src/validators/envelopeValidator");

describe("envelope validator structured issue emission", () => {
  it("rejects semantic-only Gemini verdict payloads", () => {
    expect(() => parseEnvelopeResult(JSON.stringify({
      ok: false,
      reason: "wall plane replaced",
      confidence: 0.78,
      boundaryLinesMissing: true,
      continuousSurfaceReplacement: true,
      noPlausibleVisualExplanation: true,
      visualAmbiguity: false,
    }))).toThrow("validator_error_invalid_schema");
  });

  it("ignores semantic verdict fields when observation payload exists", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      ok: false,
      reason: "envelope_confirmed_structural_change",
      confidence: 0.55,
      wallVerifications: [
        {
          semanticWallId: "wall_test",
          displayName: "wall containing W1",
          primaryAnchorLabel: "W1",
          samePermanentWallVisible: "TRUE",
          wallVisibility: "partial",
          wallExtent: "partial",
          architecturalCertainty: "partial",
          observations: [
            "wall containing W1 is partially visible",
            "wall containing W1 contains W1",
            "no visible left corner on wall containing W1",
            "wall containing W1 continues beyond the left image edge",
            "no visible adjoining wall plane adjacent to the left edge of wall containing W1",
            "visible right corner on wall containing W1",
            "wall containing W1 terminates at an observed right corner",
            "no visible adjoining wall plane adjacent to the right edge of wall containing W1"
          ]
        }
      ]
    }));

    expect(result.status).toBe("pass");
    expect(result.hardFail).toBe(false);
    expect(result.issueType).toBe("none");
    expect(result.reason).toBe("staged_observation_recorded");
  });

  it("preserves structural verification statements without deriving a verdict", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      confidence: 0.84,
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
      ]
    }));

    expect(result.status).toBe("pass");
    expect(result.architecturalAnswer).toBeUndefined();
    expect(result.baselineVerificationResults).toHaveLength(2);
    expect(result.baselineVerificationResults?.[0]).toMatchObject({
      statementId: "stmt_01",
      answer: "FALSE",
      observedVisibilityMagnitude: "partial",
    });
  });

  it("derives staged wall geometry from observation-only wall descriptions", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      confidence: 0.92,
      wallVerifications: [
        {
          semanticWallId: "wall_door_center_third_full_height",
          displayName: "wall containing sliding glass door",
          primaryAnchorLabel: "sliding glass door",
          samePermanentWallVisible: "TRUE",
          wallVisibility: "substantial",
          wallExtent: "substantial",
          architecturalCertainty: "known",
          confidence: 1,
          observations: [
            "wall containing sliding glass door is partially visible",
            "visible left corner on wall containing sliding glass door",
            "visible right corner on wall containing sliding glass door",
            "wall containing sliding glass door terminates at an observed left corner",
            "return wall visible adjacent to the left edge of wall containing sliding glass door",
            "adjoining wall plane visible adjacent to the left edge of wall containing sliding glass door",
            "no visible recess adjacent to the left edge of wall containing sliding glass door"
          ]
        }
      ],
      additionalPermanentArchitecturalFeatures: [
        "permanent return wall connected to the left edge of wall containing sliding glass door",
        "permanent interior corner connecting this return wall to wall containing sliding glass door"
      ]
    }));

    expect(result.status).toBe("pass");
    expect(result.stagedWallVerifications?.[0]).toMatchObject({
      leftCornerVisible: true,
      rightCornerVisible: true,
      continuesBeyondFrame: false,
      terminatesAtCorner: true,
      returnWallVisible: true,
      adjoiningWallVisible: true,
      recessVisible: false,
    });
    expect(result.additionalArchitecturalEvidence?.observedFeatures).toEqual([
      "permanent interior corner connecting this return wall to wall containing sliding glass door",
      "permanent return wall connected to the left edge of wall containing sliding glass door",
    ]);
  });

  it("parses architectural significance magnitudes for edge features", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      confidence: 0.9,
      wallVerifications: [
        {
          semanticWallId: "wall_window_right_third",
          displayName: "wall containing landscape window",
          primaryAnchorLabel: "landscape window",
          samePermanentWallVisible: "TRUE",
          wallVisibility: "partial",
          wallExtent: "partial",
          architecturalCertainty: "known",
          returnWallVisibilityMagnitude: "minimal",
          adjoiningWallVisibilityMagnitude: "small",
          recessVisibilityMagnitude: "none",
          confidence: 0.9,
          observations: [
            "wall containing landscape window is partially visible",
            "wall containing landscape window contains landscape window",
            "visible left corner on wall containing landscape window",
            "wall containing landscape window terminates at an observed left corner",
            "small adjoining wall plane visible adjacent to the left edge of wall containing landscape window",
            "no visible right corner on wall containing landscape window",
            "wall containing landscape window continues beyond the right image edge",
            "minimal return wall visible adjacent to the left edge of wall containing landscape window"
          ]
        }
      ],
      additionalPermanentArchitecturalFeatures: [
        "small: permanent wall plane visible at the far left edge of wall containing landscape window"
      ]
    }));

    expect(result.stagedWallVerifications?.[0]).toMatchObject({
      returnWallVisibilityMagnitude: "minimal",
      adjoiningWallVisibilityMagnitude: "small",
      recessVisibilityMagnitude: "none",
      returnWallVisible: true,
      adjoiningWallVisible: true,
      recessVisible: false,
    });
    expect(result.additionalArchitecturalEvidence).toMatchObject({
      additionalPermanentWallPlaneVisibilityMagnitude: "small",
    });
  });

  it("parses explicit corner position and adjacent wall visibility observations", () => {
    const result = parseEnvelopeResult(JSON.stringify({
      confidence: 0.88,
      wallVerifications: [
        {
          semanticWallId: "wall_door_center_third_full_height",
          displayName: "wall containing sliding glass door",
          primaryAnchorLabel: "sliding glass door",
          samePermanentWallVisible: "TRUE",
          wallVisibility: "partial",
          wallExtent: "partial",
          architecturalCertainty: "known",
          leftCornerVisibility: "minimal",
          leftCornerPosition: "image_edge",
          leftAdjacentWallVisibility: "trace",
          rightCornerVisibility: "partial",
          rightCornerPosition: "outer_third",
          rightAdjacentWallVisibility: "partial",
          observations: [
            "left corner visibility: minimal",
            "left corner position: image edge",
            "left adjacent wall visibility: trace",
            "right corner visibility: partial",
            "right corner position: outer third",
            "right adjacent wall visibility: partial"
          ]
        }
      ]
    }));

    expect(result.stagedWallVerifications?.[0]).toMatchObject({
      leftCornerVisibility: "minimal",
      leftCornerPosition: "image_edge",
      leftAdjacentWallVisibility: "trace",
      rightCornerVisibility: "partial",
      rightCornerPosition: "outer_third",
      rightAdjacentWallVisibility: "partial",
    });
  });
});