const {
  computeStage1BOpeningClosureSignal,
  buildStage1BRetryCorrectionPrompt,
  STAGE1B_OPENING_CLOSURE_FAILFAST_CONFIDENCE,
} = require("../src/validators/stage1BOpeningClosureSignal");

function finding(overrides: Partial<{
  id: string;
  openingType: string;
  status: "missing" | "infilled" | "altered";
  location: string;
  wallIndex: number;
  bbox: [number, number, number, number];
  machineReasons: string[];
  explanation: string;
  question: string;
  confidence: number;
}> = {}) {
  return {
    id: "A1",
    openingType: "walkthrough",
    status: "infilled",
    location: "left side of the left wall",
    wallIndex: 3,
    bbox: [0, 0, 1, 1],
    machineReasons: ["opening_replaced_by_wall_continuity"],
    explanation: "The walk-through opening was replaced by continuous wall surface.",
    question: "Does the opening remain open?",
    confidence: 0.95,
    ...overrides,
  };
}

// Regression coverage for the bug found reviewing job_45a10097 (opening walled over,
// twice, in Stage 1B): the deterministic reconciliation correctly flagged the opening as
// INFILLED, but the veto gate feeding STAGE1B_OPENING_SIGNAL only checked
// openingStateChanged / openingApertureExpanded — an opening being closed off was
// invisible to it entirely.
describe("computeStage1BOpeningClosureSignal", () => {
  it("reports no closure when the summary shows none of removed/infilled/sealed", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingRemoved: false, openingInfilled: false, openingSealed: false },
      findings: [],
    });

    expect(result).toEqual({ openingClosed: false });
  });

  it("detects an infilled opening even with no accompanying state-change or aperture-expansion signal", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingRemoved: false, openingInfilled: true, openingSealed: true },
      findings: [finding()],
    });

    expect(result.openingClosed).toBe(true);
    expect(result.openingClosureDetail).toEqual({
      location: "left side of the left wall",
      openingType: "walkthrough",
      explanation: "The walk-through opening was replaced by continuous wall surface.",
    });
  });

  it("marks a high-confidence wall-continuity infill as fail-fast eligible", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingInfilled: true, openingSealed: true },
      findings: [finding({ confidence: STAGE1B_OPENING_CLOSURE_FAILFAST_CONFIDENCE })],
    });

    expect(result.failFastFinding).toBeDefined();
    expect(result.failFastFinding.id).toBe("A1");
  });

  it("also treats a missing_opening finding on a 'missing' status as fail-fast eligible", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingRemoved: true, openingSealed: true },
      findings: [finding({ status: "missing", machineReasons: ["missing_opening"] })],
    });

    expect(result.failFastFinding).toBeDefined();
  });

  it("does NOT fail-fast on a low-confidence closure — falls back to full_gemini", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingInfilled: true, openingSealed: true },
      findings: [finding({ confidence: STAGE1B_OPENING_CLOSURE_FAILFAST_CONFIDENCE - 0.2 })],
    });

    expect(result.openingClosed).toBe(true);
    expect(result.failFastFinding).toBeUndefined();
    // Still surfaced for a retry-prompt correction even though it can't hard-fail alone.
    expect(result.openingClosureDetail).toBeDefined();
  });

  it("does NOT fail-fast when confidence is high but the machine reason isn't in the narrow allowlist", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingInfilled: true, openingSealed: true },
      findings: [finding({ machineReasons: ["opening_band_mismatch"] })],
    });

    expect(result.openingClosed).toBe(true);
    expect(result.failFastFinding).toBeUndefined();
  });

  it("picks the highest-confidence closure finding when multiple are present", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingInfilled: true, openingSealed: true },
      findings: [
        finding({ id: "W1", confidence: 0.4, location: "right wall window" }),
        finding({ id: "A1", confidence: 0.97, location: "left wall walkthrough" }),
      ],
    });

    expect(result.openingClosureDetail?.location).toBe("left wall walkthrough");
  });

  it("ignores 'altered' findings for closure purposes (only infilled/missing count)", () => {
    const result = computeStage1BOpeningClosureSignal({
      summary: { openingInfilled: true, openingSealed: true },
      findings: [finding({ status: "altered" })],
    });

    // Closure is still true (summary says so) but there's no infilled/missing finding to
    // attach a location/correction to.
    expect(result.openingClosed).toBe(true);
    expect(result.openingClosureDetail).toBeUndefined();
    expect(result.failFastFinding).toBeUndefined();
  });
});

// Regression coverage for a prose-quality bug found during replay against real job_45a10097
// images: `location` (from openingPreservationValidator.ts) already reads as a full noun
// phrase like "walk-through opening in the center of the near wall" — it already starts
// with the opening type. Wrapping it in "the {openingType} opening located at {location}"
// produced a redundant "...the walkthrough opening located at the walk-through opening..."
// sentence. The prompt must read as one natural sentence, not a field/value dump.
describe("buildStage1BRetryCorrectionPrompt", () => {
  it("does not repeat the opening type — location already includes it", () => {
    const prompt = buildStage1BRetryCorrectionPrompt({
      location: "walk-through opening in the center of the near wall",
      openingType: "walkthrough",
      explanation: "The walk-through opening in the center of the near wall is not detectable in the AFTER image and appears to have been replaced by continuous wall surface.",
    });

    expect(prompt).toContain(
      "A previous attempt on this image incorrectly filled in the walk-through opening in the center of the near wall — turning it into a continuous wall surface where an opening should be."
    );
    // The redundant phrasing this replaces would contain "opening located at the walk-through opening".
    expect(prompt).not.toMatch(/opening located at the/);
    expect(prompt).toContain("This opening MUST remain open and unobstructed");
  });
});
