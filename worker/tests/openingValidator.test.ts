import {
  analyzeOpeningSignalCoherence,
  buildOpeningValidatorDecision,
  extractStrongDeterministicAddedOpeningSignals,
  hasStableAddedOpeningConsensus,
  parseOpeningResult,
  runStructuralContinuityPrecheck,
} from "../src/validators/openingValidator";

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

  it.each([
    ["added opening", { pass: false, reason: "opening_added", confidence: 1.0, details: [{ id: "opening_1", classification: "added", reason: "opening added" }] }],
    ["relocated opening", { pass: false, reason: "opening_relocated_review", confidence: 1.0, details: [{ id: "opening_1", classification: "relocated", reason: "opening relocated" }] }],
    ["major resize", { pass: false, reason: "opening_resized_major", confidence: 1.0, details: [{ id: "opening_1", classification: "altered", reason: "opening resized major" }] }],
  ] as const)("hard-fails %s", (_label, payload) => {
    const result = parseOpeningResult(JSON.stringify(payload));

    expect(result.status).toBe("fail");
    expect(result.hardFail).toBe(true);
  });

  it("keeps ambiguous occlusion advisory", () => {
    const result = parseOpeningResult(JSON.stringify({
      pass: false,
      reason: "window_occlusion_review",
      confidence: 0.5,
      details: [{ id: "opening_1", classification: "occluded", reason: "occluded by staging" }],
    }));

    expect(result.status).toBe("pass");
    expect(result.hardFail).toBe(false);
    expect(result.issueType).toBeDefined();
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

  it("requires strong deterministic added-opening criteria before signaling addition", () => {
    const baseline: any = {
      openings: [
        {
          id: "W1",
          type: "window",
          bbox: [0.1, 0.2, 0.3, 0.5],
          area_pct: 6,
          wallIndex: 3,
          horizontalBand: "left_third",
          confidence: 0.98,
          verticalBand: "mid_zone",
          heightClass: "standard",
          wallCoverageBand: "20-40",
          orientation: "portrait",
          paneStructure: "fixed_plus_opening",
        },
      ],
    };

    const detected: any[] = [
      {
        id: "W2",
        type: "window",
        bbox: [0.45, 0.2, 0.65, 0.55],
        area_pct: 5,
        wallIndex: 3,
        horizontalBand: "center_third",
        confidence: 0.9,
        verticalBand: "mid_zone",
        heightClass: "standard",
        wallCoverageBand: "10-20",
        orientation: "portrait",
        paneStructure: "single_fixed",
      },
    ];

    const signals = extractStrongDeterministicAddedOpeningSignals({
      baseline,
      detectedOpenings: detected,
      hasAddedOpenings: true,
      summary: { openingBandMismatch: true },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "window",
      wallIndex: 3,
      horizontalBand: "center_third",
    });
  });

  it("uses intersection stability across two deterministic passes", () => {
    const pass1: Parameters<typeof hasStableAddedOpeningConsensus>[0] = [
      {
        type: "window" as const,
        wallIndex: 3 as const,
        canonicalWallIndex: 3 as const,
        horizontalBand: "center_third" as const,
        bbox: [0.44, 0.2, 0.66, 0.56] as [number, number, number, number],
        confidence: 0.91,
      },
    ];

    const pass2Stable: Parameters<typeof hasStableAddedOpeningConsensus>[1] = [
      {
        type: "window" as const,
        wallIndex: 3 as const,
        canonicalWallIndex: 3 as const,
        horizontalBand: "center_third" as const,
        bbox: [0.46, 0.21, 0.67, 0.57] as [number, number, number, number],
        confidence: 0.92,
      },
    ];

    const pass2Different: Parameters<typeof hasStableAddedOpeningConsensus>[1] = [
      {
        type: "window" as const,
        wallIndex: 2 as const,
        canonicalWallIndex: 2 as const,
        horizontalBand: "left_third" as const,
        bbox: [0.10, 0.20, 0.30, 0.50] as [number, number, number, number],
        confidence: 0.95,
      },
    ];

    expect(hasStableAddedOpeningConsensus(pass1, pass2Stable)).toBe(true);
    expect(hasStableAddedOpeningConsensus(pass1, pass2Different)).toBe(false);
  });

  it("builds a structural continuity wall remap from stable baseline references", () => {
    const baseline: any = {
      openings: [
        {
          id: "A1",
          type: "walkthrough",
          bbox: [0.08, 0.1, 0.32, 0.92],
          area_pct: 14,
          wallIndex: 3,
          horizontalBand: "left_third",
          confidence: 0.95,
        },
        {
          id: "W1",
          type: "window",
          bbox: [0.40, 0.2, 0.60, 0.56],
          area_pct: 6,
          wallIndex: 3,
          horizontalBand: "center_third",
          confidence: 0.98,
        },
      ],
    };

    const detected: any[] = [
      {
        id: "A1",
        type: "walkthrough",
        bbox: [0.08, 0.1, 0.32, 0.92],
        area_pct: 14,
        wallIndex: 2,
        horizontalBand: "left_third",
        confidence: 0.94,
      },
      {
        id: "W1",
        type: "window",
        bbox: [0.40, 0.2, 0.60, 0.56],
        area_pct: 6,
        wallIndex: 2,
        horizontalBand: "center_third",
        confidence: 0.97,
      },
    ];

    const precheck = runStructuralContinuityPrecheck({ baseline, detectedOpenings: detected });

    expect(precheck.passed).toBe(true);
    expect(precheck.matchedReferenceOpenings).toBeGreaterThanOrEqual(2);
    expect(precheck.wallRemap.get(2)).toBe(3);
  });

  it("keeps consensus strict but stable under canonical wall remap", () => {
    const baseline: any = {
      openings: [
        {
          id: "A1",
          type: "walkthrough",
          bbox: [0.08, 0.1, 0.32, 0.92],
          area_pct: 14,
          wallIndex: 3,
          horizontalBand: "left_third",
          confidence: 0.95,
        },
      ],
    };

    const pass1Detected: any[] = [
      {
        id: "A1",
        type: "walkthrough",
        bbox: [0.08, 0.1, 0.32, 0.92],
        area_pct: 14,
        wallIndex: 3,
        horizontalBand: "left_third",
        confidence: 0.95,
      },
      {
        id: "W_new",
        type: "window",
        bbox: [0.45, 0.2, 0.66, 0.56],
        area_pct: 5,
        wallIndex: 3,
        horizontalBand: "center_third",
        confidence: 0.92,
      },
    ];

    const pass2Detected: any[] = [
      {
        id: "A1",
        type: "walkthrough",
        bbox: [0.08, 0.1, 0.32, 0.92],
        area_pct: 14,
        wallIndex: 2,
        horizontalBand: "left_third",
        confidence: 0.95,
      },
      {
        id: "W_new",
        type: "window",
        bbox: [0.46, 0.21, 0.67, 0.57],
        area_pct: 5,
        wallIndex: 2,
        horizontalBand: "center_third",
        confidence: 0.93,
      },
    ];

    const precheck1 = runStructuralContinuityPrecheck({ baseline, detectedOpenings: pass1Detected });
    const precheck2 = runStructuralContinuityPrecheck({ baseline, detectedOpenings: pass2Detected });
    const signals1 = extractStrongDeterministicAddedOpeningSignals({
      baseline,
      detectedOpenings: pass1Detected,
      hasAddedOpenings: true,
      wallRemap: precheck1.wallRemap,
      summary: { openingBandMismatch: true },
    });
    const signals2 = extractStrongDeterministicAddedOpeningSignals({
      baseline,
      detectedOpenings: pass2Detected,
      hasAddedOpenings: true,
      wallRemap: precheck2.wallRemap,
      summary: { openingBandMismatch: true },
    });

    expect(precheck1.passed && precheck2.passed).toBe(true);
    expect(signals1).toHaveLength(1);
    expect(signals2).toHaveLength(1);
    expect(hasStableAddedOpeningConsensus(signals1, signals2)).toBe(true);
  });

  it("emits a structured decision for corroborated added openings", () => {
    const decision = buildOpeningValidatorDecision({
      hardFail: true,
      deterministicHardFailIssue: true,
      hasHighConfidenceMicroHardFailSignal: false,
      addedHardFailCorroborated: true,
      openingAddedConsensusUnstable: false,
      openingAddedStructuralContinuityUnresolved: false,
      reasonParts: ["opening_added", "light_anchor_opening_added_confirmed"],
      advisorySignals: ["light_anchor_added_corroboration_confidence:0.940"],
    });

    expect(decision).toMatchObject({
      decision: "hard_fail",
      authorityClass: "CLASS_A",
      authority: "deterministic_added_opening",
      vetoable: false,
      semanticCorroborated: true,
      vetoed: false,
    });
    expect(decision.signals).toEqual(
      expect.arrayContaining(["opening_added", "light_anchor_opening_added_confirmed"])
    );
    expect(decision.decisionTrace).toEqual(
      expect.arrayContaining([
        "decision_trace_started",
        "authority_class_a_assigned",
        "semantic_corroboration_confirmed",
        "veto_skipped_nonvetoable",
      ])
    );
    expect(decision.trace).toEqual(decision.decisionTrace);
  });
});