jest.mock("../src/ai/gemini", () => ({
  getGeminiClient: jest.fn(),
}));

jest.mock("../src/utils/images", () => ({
  toBase64: jest.fn(() => ({ data: "ZmFrZQ==" })),
}));

jest.mock("../src/validators/signalMetrics", () => ({
  computeMaterialSignal: jest.fn(async () => ({
    colorShift: 0,
    textureShift: 0,
    suspiciousMaterialChange: false,
  })),
  computeOpeningGeometrySignal: jest.fn(async () => ({
    openingAreaDelta: 0,
    aspectRatioDelta: 0,
    suspiciousOpeningGeometry: false,
  })),
}));

import { parseFixtureResult } from "../src/validators/fixtureValidator";
import { ISSUE_TYPES } from "../src/validators/issueTypes";

describe("fixture validator mutation parsing", () => {
  const fixtureMutationCases = [
    {
      name: "tokenized pendant mutation",
      reason: "pendant_light_added",
      issueType: ISSUE_TYPES.FIXTURE_CHANGED,
    },
    {
      name: "tokenized chandelier mutation",
      reason: "chandelier_removed",
      issueType: ISSUE_TYPES.FIXTURE_CHANGED,
    },
    {
      name: "tokenized hvac mutation",
      reason: "hvac_unit_added",
      issueType: ISSUE_TYPES.HVAC_CHANGED,
    },
    {
      name: "natural language pendant mutation",
      reason: "a pendant light was added",
      issueType: ISSUE_TYPES.FIXTURE_CHANGED,
    },
    {
      name: "natural language chandelier mutation",
      reason: "chandelier removed from ceiling",
      issueType: ISSUE_TYPES.FIXTURE_CHANGED,
    },
    {
      name: "natural language hvac mutation",
      reason: "new HVAC unit installed",
      issueType: ISSUE_TYPES.HVAC_CHANGED,
    },
  ] as const;

  it.each(fixtureMutationCases)("hard-fails $name", ({ reason, issueType }) => {
    const result = parseFixtureResult(JSON.stringify({
      ok: false,
      reason,
      confidence: 1.0,
    }));

    expect(result.status).toBe("fail");
    expect(result.reason).toBe(reason);
    expect(result.hardFail).toBe(true);
    expect(result.issueType).toBe(issueType);
  });

  it("keeps non-mutation fixture findings advisory", () => {
    const result = parseFixtureResult(JSON.stringify({
      ok: false,
      reason: "fixture_visibility_uncertain",
      confidence: 1.0,
    }));

    expect(result.status).toBe("fail");
    expect(result.hardFail).toBe(false);
    expect(result.issueType).toBe(ISSUE_TYPES.FIXTURE_ANOMALY);
  });
});