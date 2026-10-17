// Regression tests for the opening-occlusion guard fix (2026-08-30),
// covering the confirmed root cause behind two real production false
// positives investigated from logs.1788043959694.log:
//   - job_9afb6878: attempt 1's balcony slider hard-failed as
//     opening_infilled/"replaced" even though the model's own current-state
//     description said the opening was clearly open (curtains tied back,
//     balcony visible) — confirmed by direct visual inspection.
//   - job_c4a18bc3: attempt 1's bedroom window hard-failed as
//     opening_infilled/"replaced" with reason text describing the window as
//     "fully visible" with "gray curtains" and "potted plants on the sill";
//     attempt 2 (visually identical window, confirmed by direct image
//     comparison) raised no opening signal at all.
//
// Both were tagged issueType opening_infilled — see
// openingEnvelopeValidator.ts, which reports every altered-opening verdict
// under that one issueType regardless of the underlying verdict string —
// and neither ever reached the pre-existing curtain/plant/furniture
// occlusion-keyword guard, because isOpeningEscalationCandidate only
// recognized opening_removed/opening_resized_major/opening_resized_minor.
import {
  isOpeningEscalationCandidate,
  shouldApplyOpeningOcclusionGuard,
  isEligibleForOpeningOcclusionDowngrade,
  matchedOpeningOcclusionKeywords,
  type OpeningEscalationSignal,
} from "../src/validators/openingOcclusionGuard";

describe("isOpeningEscalationCandidate", () => {
  it("recognizes opening_infilled and opening_sealed (the confirmed production gap)", () => {
    expect(isOpeningEscalationCandidate({ issueType: "opening_infilled" })).toBe(true);
    expect(isOpeningEscalationCandidate({ issueType: "opening_sealed" })).toBe(true);
  });

  it("still recognizes the pre-existing candidate types", () => {
    expect(isOpeningEscalationCandidate({ issueType: "opening_removed" })).toBe(true);
    expect(isOpeningEscalationCandidate({ issueType: "opening_resized_major" })).toBe(true);
    expect(isOpeningEscalationCandidate({ issueType: "opening_resized_minor" })).toBe(true);
  });

  it("does not treat unrelated issue types as candidates", () => {
    expect(isOpeningEscalationCandidate({ issueType: "fixture_changed" })).toBe(false);
    expect(isOpeningEscalationCandidate({ issueType: "floor_changed" })).toBe(false);
    expect(isOpeningEscalationCandidate({ issueType: undefined })).toBe(false);
  });
});

describe("matchedOpeningOcclusionKeywords", () => {
  it("returns every distinct keyword in one string, not just whether any matched", () => {
    const matched = matchedOpeningOcclusionKeywords(
      "gray curtains hang at left and right ends of the window; several small potted plants sit on the sill"
    );
    expect(matched).toEqual(expect.arrayContaining(["curtain", "plant"]));
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });
});

describe("shouldApplyOpeningOcclusionGuard + isEligibleForOpeningOcclusionDowngrade — real production fixtures", () => {
  it("job_c4a18bc3: a single reason string naming curtains AND potted plants clears the >=2 threshold on its own", () => {
    const signal: OpeningEscalationSignal = {
      validator: "openings",
      issueType: "opening_infilled",
      reason:
        "opening_envelope_validator: W1 (A high, wide landscape window with a white frame and a single vertical mullion on the left wall.): verdict=replaced — A high, wide horizontal window with white frame is fully visible. Glass shows exterior roof and sky; several small potted plants sit on the sill; gray curtains hang at left and right ends of the window.",
    };
    const guard = shouldApplyOpeningOcclusionGuard(signal, [signal], []);
    expect(guard.apply).toBe(true);
    expect(guard.occlusionHints.length).toBeGreaterThanOrEqual(2);
    expect(isEligibleForOpeningOcclusionDowngrade("UNKNOWN", guard.occlusionHints.length)).toBe(true);
  });

  it("job_9afb6878: an opening described as clearly open (curtains tied back, balcony visible) qualifies for downgrade", () => {
    const signal: OpeningEscalationSignal = {
      validator: "openings",
      issueType: "opening_infilled",
      reason:
        "opening_envelope_validator: A1 (A sliding glass door walkthrough onto a balcony.): verdict=replaced — curtains are tied back on both sides of the frameless walkthrough; the balcony railing and furniture beyond remain visible through the open doorway.",
    };
    const guard = shouldApplyOpeningOcclusionGuard(signal, [signal], []);
    expect(guard.apply).toBe(true);
    expect(guard.occlusionHints.length).toBeGreaterThanOrEqual(2);
    expect(isEligibleForOpeningOcclusionDowngrade("UNKNOWN", guard.occlusionHints.length)).toBe(true);
  });

  it("a genuine, corroborated removal (REMOVAL class) is deliberately NOT eligible for downgrade even with occlusion hints", () => {
    // classifyStructuralSignal in worker.ts only ever classifies
    // opening_infilled/opening_removed/opening_sealed as "REMOVAL" when an
    // envelope signal corroborates it — that case must stay a hard block
    // regardless of what keywords happen to appear in the reason text.
    expect(isEligibleForOpeningOcclusionDowngrade("REMOVAL", 5)).toBe(false);
  });

  it("does not fire when there is only one occlusion hint (threshold unchanged at >=2)", () => {
    const signal: OpeningEscalationSignal = {
      validator: "openings",
      issueType: "opening_infilled",
      reason: "the window opening now shows a plain painted wall with no visible frame",
    };
    const guard = shouldApplyOpeningOcclusionGuard(signal, [signal], []);
    expect(guard.apply).toBe(false);
    expect(isEligibleForOpeningOcclusionDowngrade("UNKNOWN", guard.occlusionHints.length)).toBe(false);
  });

  it("does not apply to an unrelated issue type even when its text is full of guard keywords", () => {
    const signal: OpeningEscalationSignal = {
      validator: "fixtures",
      issueType: "fixture_changed",
      reason: "the sofa, lamp, and shelving were replaced with different furniture and decor",
    };
    const guard = shouldApplyOpeningOcclusionGuard(signal, [signal], []);
    expect(guard.apply).toBe(false);
  });

  it("curtainRailLikely contributes one extra hint when true", () => {
    const signal: OpeningEscalationSignal = {
      validator: "openings",
      issueType: "opening_sealed",
      reason: "a single curtain panel partially covers the frame",
    };
    const withoutRail = shouldApplyOpeningOcclusionGuard(signal, [signal], [], false);
    const withRail = shouldApplyOpeningOcclusionGuard(signal, [signal], [], true);
    expect(withRail.occlusionHints.length).toBe(withoutRail.occlusionHints.length + 1);
  });
});
