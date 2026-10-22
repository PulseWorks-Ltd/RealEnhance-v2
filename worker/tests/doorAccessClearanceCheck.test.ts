// Regression tests for evaluateDoorAccessClearance / isDoorAccessClearanceCheckApplicable
// (RealEnhance audit fix H1 — no validator previously checked that a door
// or walkthrough remains FUNCTIONALLY usable, only that it remains
// visually present). Pure, synchronous functions — no network calls, no
// mocking needed.
import { evaluateDoorAccessClearance, isDoorAccessClearanceCheckApplicable } from "../src/validators/doorAccessClearanceCheck";

describe("isDoorAccessClearanceCheckApplicable", () => {
  it("applies to door and walkthrough", () => {
    expect(isDoorAccessClearanceCheckApplicable("door")).toBe(true);
    expect(isDoorAccessClearanceCheckApplicable("walkthrough")).toBe(true);
  });

  it("does NOT apply to closet_door — a closet with furniture in front of it is normal staging, not a functional failure", () => {
    expect(isDoorAccessClearanceCheckApplicable("closet_door")).toBe(false);
  });

  it("does not apply to window", () => {
    expect(isDoorAccessClearanceCheckApplicable("window")).toBe(false);
  });
});

describe("evaluateDoorAccessClearance (H1 fix)", () => {
  it("is not_applicable for a closet_door regardless of observation content", () => {
    const result = evaluateDoorAccessClearance("closet_door", {
      approachAreaDescription: "A dresser sits directly across the closet door's opening.",
      accessBlocked: "yes",
    });
    expect(result.verdict).toBe("not_applicable");
  });

  it("fails when a large piece of furniture's footprint crosses the doorway's own threshold — the real Bedroom 12 failure class", () => {
    const result = evaluateDoorAccessClearance("door", {
      approachAreaDescription: "The bed's footboard extends directly across the doorway's threshold; a person could not walk through or open the door without moving the bed first.",
      accessBlocked: "yes",
    });
    expect(result.verdict).toBe("fail_access_blocked");
    expect(result.reason).toContain("footboard");
  });

  it("fails the same way for a walkthrough opening (no door leaf, still a circulation path)", () => {
    const result = evaluateDoorAccessClearance("walkthrough", {
      approachAreaDescription: "A large sofa is positioned directly in the walkthrough's own gap, blocking passage entirely.",
      accessBlocked: "yes",
    });
    expect(result.verdict).toBe("fail_access_blocked");
  });

  it("passes when the approach area is genuinely clear", () => {
    const result = evaluateDoorAccessClearance("door", {
      approachAreaDescription: "The floor area directly in front of the door is completely clear.",
      accessBlocked: "no",
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes when only a minor, out-of-the-way item is nearby — a small side table beside the opening is normal staging, not a blocked path", () => {
    const result = evaluateDoorAccessClearance("door", {
      approachAreaDescription: "A small side table sits against the wall beside the doorway, out of the direct path; the approach itself is clear.",
      accessBlocked: "no",
    });
    expect(result.verdict).toBe("pass");
  });

  it("passes (does not hard-fail) on an ambiguous 'cannot_tell' read — a new, uncalibrated check should never hard-fail on ambiguity alone", () => {
    const result = evaluateDoorAccessClearance("door", {
      approachAreaDescription: "The area is poorly lit and mostly out of frame.",
      accessBlocked: "cannot_tell",
    });
    expect(result.verdict).toBe("pass");
  });
});
