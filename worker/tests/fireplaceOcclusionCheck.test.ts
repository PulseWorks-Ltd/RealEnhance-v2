// Regression tests for evaluateFireplaceOcclusion (fireplace-loss
// investigation, job_5671358c — a living room with a fireplace and a TV
// bracket mounted directly above it). The existing shared fixture-occlusion
// tolerance (occlusionVsRemovalCheck.ts's combineOcclusionAnswer, used for
// all 9 AnchorFixtureTypes) deliberately treats partial occlusion as a
// pass — its own system instruction uses "a fireplace hearth with a plant
// placed in front of part of it is normal staging, not a violation" as the
// canonical acceptable example. This check asks a narrower question
// instead: is the firebox opening specifically blocked by a FURNITURE-class
// object, as opposed to small decor. Pure, synchronous function — no
// network calls, no mocking needed.
import { evaluateFireplaceOcclusion, fireplaceOcclusionCheckBlocking } from "../src/validators/fireplaceOcclusionCheck";

describe("evaluateFireplaceOcclusion", () => {
  it("fails when a furniture-class object blocks the firebox opening — the job_5671358c failure class", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "yes",
      fireboxOpeningVisible: "no",
      coveringObjectType: "furniture",
      coveringObjectDescription: "A low media console is placed directly in front of the firebox, fully blocking it.",
      confidence: 0.9,
    });
    expect(result.verdict).toBe("fail_furniture_blocking_firebox");
    expect(result.reason).toContain("media console");
  });

  it("fails when the fireplace is completely hidden (hearth and firebox both gone)", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "no",
      fireboxOpeningVisible: "no",
      coveringObjectType: "furniture",
      coveringObjectDescription: "A large bookshelf now stands where the fireplace was, completely covering it.",
      confidence: 0.9,
    });
    expect(result.verdict).toBe("fail_fully_hidden");
  });

  it("passes when only small decor is placed near the fireplace — matches the existing check's own canonical acceptable example", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "yes",
      fireboxOpeningVisible: "yes",
      coveringObjectType: "small_decor",
      coveringObjectDescription: "A small potted plant sits beside the hearth; the firebox opening is fully visible.",
      confidence: 0.9,
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes when nothing new is in front of the fireplace at all", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "yes",
      fireboxOpeningVisible: "yes",
      coveringObjectType: "none",
      coveringObjectDescription: "Nothing is in front of the fireplace.",
      confidence: 0.95,
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes (does not hard-fail) when the firebox is blocked but the covering object could not be classified — an uncalibrated check should never hard-fail on ambiguity about WHAT is blocking it", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "yes",
      fireboxOpeningVisible: "no",
      coveringObjectType: "cannot_tell",
      coveringObjectDescription: "Something is in front of it but the image is too dark to identify what.",
      confidence: 0.85,
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes (does not hard-fail) on low confidence, regardless of what was observed", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "no",
      fireboxOpeningVisible: "no",
      coveringObjectType: "furniture",
      coveringObjectDescription: "Possibly a sofa, but the angle makes this uncertain.",
      confidence: 0.3,
    });
    expect(result.verdict).toBe("cannot_tell");
  });

  it("passes when the hearth is partly hidden but the firebox opening itself remains visible", () => {
    const result = evaluateFireplaceOcclusion({
      fireplaceId: "fp1",
      hearthVisible: "cannot_tell",
      fireboxOpeningVisible: "yes",
      coveringObjectType: "small_decor",
      coveringObjectDescription: "A stack of books partially obscures the mantel edge, but the firebox opening is clearly visible.",
      confidence: 0.9,
    });
    expect(result.verdict).toBe("pass");
  });
});

describe("fireplaceOcclusionCheckBlocking", () => {
  const original = process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING;
  afterEach(() => {
    if (original === undefined) delete process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING;
    else process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING = original;
  });

  it("defaults to false (advisory-only) when unset — this is a brand-new, unproven check that must earn its own blocking status", () => {
    delete process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING;
    expect(fireplaceOcclusionCheckBlocking()).toBe(false);
  });

  it("is true only for an exact 'true' value", () => {
    process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING = "true";
    expect(fireplaceOcclusionCheckBlocking()).toBe(true);
    process.env.FIREPLACE_OCCLUSION_CHECK_BLOCKING = "1";
    expect(fireplaceOcclusionCheckBlocking()).toBe(false);
  });
});
