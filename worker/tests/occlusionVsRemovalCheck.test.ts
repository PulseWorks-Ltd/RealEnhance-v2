// Truth-table regression tests for combineOcclusionAnswer — the shared
// decision function behind occlusionVsRemovalCheck.ts, used by every
// fixture/opening occlusion-vs-removal check in this codebase
// (openingEnvelopeValidator, fabricatedOpeningCheck, flooringBoundaryCheck,
// windowArtworkCheck, vanishedLandmarkCheck, doorAccessClearanceCheck, and
// fixtureFlooringValidator all import from this module). No unit test
// existed for it before this (fireplace-loss investigation, job_5671358c) —
// added as a safety net for any future work on this function, covering its
// full decision tree over the 5 input booleans. Pure function — no network
// calls, no mocking needed.
import { combineOcclusionAnswer, type OcclusionCheckAnswer } from "../src/validators/occlusionVsRemovalCheck";

function baseAnswer(overrides: Partial<OcclusionCheckAnswer> = {}): OcclusionCheckAnswer {
  return {
    id: "item1",
    traceVisible: true,
    replacedByContinuousSurface: false,
    itemExtendsBeyondCoveringObject: true,
    extentChanged: false,
    structuralEvidenceFound: false,
    confidence: 0.9,
    ...overrides,
  } as OcclusionCheckAnswer;
}

describe("combineOcclusionAnswer", () => {
  it("occlusion (not altered): trace visible, not replaced by continuous surface, extends beyond covering object, extent unchanged", () => {
    const result = combineOcclusionAnswer(baseAnswer());
    expect(result.verdict).toBe("occlusion");
    expect(result.altered).toBe(false);
  });

  it("altered when extentChanged is true, even though everything else says occlusion", () => {
    const result = combineOcclusionAnswer(baseAnswer({ extentChanged: true }));
    expect(result.verdict).not.toBe("occlusion");
    expect(result.altered).toBe(true);
  });

  it("preserved_closed (not altered): no trace visible, but structural evidence found (e.g. a door track/frame) — the closed-door rescue", () => {
    const result = combineOcclusionAnswer(baseAnswer({ traceVisible: false, structuralEvidenceFound: true }));
    expect(result.verdict).toBe("preserved_closed");
    expect(result.altered).toBe(false);
  });

  it("preserved_closed also fires when replaced by a continuous surface but structural evidence is found", () => {
    const result = combineOcclusionAnswer(baseAnswer({ replacedByContinuousSurface: true, structuralEvidenceFound: true }));
    expect(result.verdict).toBe("preserved_closed");
    expect(result.altered).toBe(false);
  });

  it("replaced (altered): replaced by a continuous surface, no structural evidence to rescue it", () => {
    const result = combineOcclusionAnswer(baseAnswer({ replacedByContinuousSurface: true, structuralEvidenceFound: false, traceVisible: false }));
    expect(result.verdict).toBe("replaced");
    expect(result.altered).toBe(true);
  });

  it("removed (altered): no trace visible, not replaced by a continuous surface, no structural evidence", () => {
    const result = combineOcclusionAnswer(baseAnswer({ traceVisible: false, replacedByContinuousSurface: false, structuralEvidenceFound: false }));
    expect(result.verdict).toBe("removed");
    expect(result.altered).toBe(true);
  });

  it("fully_covered (altered): trace visible, not replaced, but does NOT extend beyond the covering object — this is the shared tolerance's own ceiling, e.g. a fireplace 100% covered with nothing peeking out", () => {
    const result = combineOcclusionAnswer(baseAnswer({ itemExtendsBeyondCoveringObject: false }));
    expect(result.verdict).toBe("fully_covered");
    expect(result.altered).toBe(true);
  });

  it("resized (altered): trace visible, not replaced, extends beyond covering object, but extent changed — falls through every other branch", () => {
    const result = combineOcclusionAnswer(baseAnswer({ extentChanged: true, itemExtendsBeyondCoveringObject: true }));
    expect(result.verdict).toBe("resized");
    expect(result.altered).toBe(true);
  });

  it("preserves all original answer fields on the combined result (spread, not replaced)", () => {
    const answer = baseAnswer({ id: "custom-id", confidence: 0.42 });
    const result = combineOcclusionAnswer(answer);
    expect(result.id).toBe("custom-id");
    expect(result.confidence).toBe(0.42);
  });
});
