// Regression tests for the layout-planning routing fix: exactly one of
// layoutPlanner.ts / anchorLockedStaging.ts should contribute placement
// guidance to a given Stage 2 prompt, decided once via
// shouldUseAnchorLockedLayoutPlanning before either system runs (worker.ts
// uses it to decide whether to call planStage2Layout at all; stage2.ts
// uses the identical function again as a defensive second check before
// appending any layoutPlan content). Covers the real contradiction this
// closes: a living_dining room where anchorLockedStaging correctly floats
// the sofa, but layoutPlanner.ts's own independent plan would otherwise
// append a "MANDATORY... Anchor wall" directive for the same sofa_group
// anchor afterward.
import {
  isRoomTypeSupportedByAnchorLockedStaging,
  shouldUseAnchorLockedLayoutPlanning,
} from "../src/pipeline/anchorLockedStaging";

describe("isRoomTypeSupportedByAnchorLockedStaging", () => {
  it("recognizes all currently-supported room types, including multiple_living (multi-zone room-type expansion)", () => {
    for (const roomType of [
      "bedroom",
      "living_dining",
      "kitchen",
      "kitchen_dining",
      "kitchen_living",
      "multiple_living",
      "living_room",
      "living",
      "study",
      "bathroom",
      "bathroom_1",
      "bathroom_2",
      "hallway",
      "garage",
    ]) {
      expect(isRoomTypeSupportedByAnchorLockedStaging(roomType)).toBe(true);
    }
  });

  it("returns false for an unknown/unsupported room type", () => {
    expect(isRoomTypeSupportedByAnchorLockedStaging("office")).toBe(false);
    expect(isRoomTypeSupportedByAnchorLockedStaging("")).toBe(false);
  });
});

describe("shouldUseAnchorLockedLayoutPlanning (layout-planning routing fix)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("is true for a supported room type, full prompt mode, and an anchor-locked-eligible prompt variant", () => {
    for (const variant of ["anchor_locked", "grok", "grok_skill", "combined"]) {
      process.env.STAGE2_PROMPT_VARIANT = variant;
      expect(shouldUseAnchorLockedLayoutPlanning("living_dining", "full")).toBe(true);
    }
  });

  it("is false in refresh prompt mode regardless of variant — anchorLockedStaging only produces plans in full mode", () => {
    process.env.STAGE2_PROMPT_VARIANT = "anchor_locked";
    expect(shouldUseAnchorLockedLayoutPlanning("living_dining", "refresh")).toBe(false);
  });

  it("is true for multiple_living now that it is supported (multi-zone room-type expansion)", () => {
    process.env.STAGE2_PROMPT_VARIANT = "anchor_locked";
    expect(shouldUseAnchorLockedLayoutPlanning("multiple_living", "full")).toBe(true);
  });

  it("is false for a genuinely unsupported room type even with an eligible variant and full mode", () => {
    process.env.STAGE2_PROMPT_VARIANT = "anchor_locked";
    expect(shouldUseAnchorLockedLayoutPlanning("office", "full")).toBe(false);
  });

  it("is false when STAGE2_PROMPT_VARIANT is a non-anchor-locked variant (nano, legacy, unset)", () => {
    process.env.STAGE2_PROMPT_VARIANT = "nano";
    expect(shouldUseAnchorLockedLayoutPlanning("living_dining", "full")).toBe(false);
    delete process.env.STAGE2_PROMPT_VARIANT;
    expect(shouldUseAnchorLockedLayoutPlanning("living_dining", "full")).toBe(false);
  });

  it("is case-insensitive on STAGE2_PROMPT_VARIANT", () => {
    process.env.STAGE2_PROMPT_VARIANT = "GROK";
    expect(shouldUseAnchorLockedLayoutPlanning("living_room", "full")).toBe(true);
  });

  it("the real contradiction scenario: a living_dining room under the confirmed-live variant is routed exclusively to anchorLockedStaging", () => {
    // Matches this deployment's actual confirmed STAGE2_PROMPT_VARIANT.
    process.env.STAGE2_PROMPT_VARIANT = "grok";
    expect(shouldUseAnchorLockedLayoutPlanning("living_dining", "full")).toBe(true);
    // worker.ts's resolveStage2LayoutPlan short-circuits to null in this
    // case (never calls planStage2Layout), so there is nothing for
    // layoutPlanner.ts to contradict anchorLockedStaging's own sofa
    // floating/wall-anchoring decision with.
  });
});
