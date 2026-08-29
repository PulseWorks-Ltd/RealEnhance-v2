// Regression test for the three new ISSUE_TYPES entries added alongside
// the RealEnhance audit fixes (C2: FIXTURE_FABRICATED, C3:
// ARTWORK_ON_DOOR_SURFACE, H1: DOOR_ACCESS_BLOCKED) — confirms each lands
// in the tier its own severity was designed for, and that adding them did
// not disturb any pre-existing classification.
import { ISSUE_TYPES, classifyIssueTier } from "../src/validators/issueTypes";

describe("new issue type classification", () => {
  it("FIXTURE_FABRICATED classifies as critical, matching its structural sibling OPENING_FABRICATED", () => {
    expect(classifyIssueTier(ISSUE_TYPES.FIXTURE_FABRICATED)).toBe("critical");
    expect(classifyIssueTier(ISSUE_TYPES.OPENING_FABRICATED)).toBe("critical");
  });

  it("ARTWORK_ON_DOOR_SURFACE classifies as critical, matching its structural sibling WINDOW_ARTWORK_REPLACEMENT", () => {
    expect(classifyIssueTier(ISSUE_TYPES.ARTWORK_ON_DOOR_SURFACE)).toBe("critical");
    expect(classifyIssueTier(ISSUE_TYPES.WINDOW_ARTWORK_REPLACEMENT)).toBe("critical");
  });

  it("DOOR_ACCESS_BLOCKED classifies as review, not critical — deliberately more cautious pending a real production track record", () => {
    expect(classifyIssueTier(ISSUE_TYPES.DOOR_ACCESS_BLOCKED)).toBe("review");
  });

  it("pre-existing classifications are unchanged", () => {
    expect(classifyIssueTier(ISSUE_TYPES.NONE)).toBe("advisory");
    expect(classifyIssueTier(ISSUE_TYPES.OPENING_REMOVED)).toBe("critical");
    expect(classifyIssueTier(ISSUE_TYPES.FIXTURE_CHANGED)).toBe("critical");
    expect(classifyIssueTier(ISSUE_TYPES.FLOOR_CHANGED)).toBe("review");
    expect(classifyIssueTier(ISSUE_TYPES.UNIFIED_FAILURE)).toBe("review");
  });
});
