import { parseFloorIntegrityResult } from "../src/validators/floorIntegrityValidator";

describe("floor validator structured issue emission", () => {
  it("emits structured issue for identity-breaking floor replacement", () => {
    const result = parseFloorIntegrityResult(JSON.stringify({
      ok: false,
      reason: "floor_integrity_changed",
      confidence: 0.95,
      baseline_material: "wood",
      staged_material: "tile",
      baseline_material_visible: true,
      staged_material_visible: true,
      staged_floor_fully_covered_by_movable_items: false,
      material_changed: true,
    }));

    expect(result.primaryStructuredIssue).toMatchObject({
      type: "floor_change",
      object: "floor_material",
      action: "replaced",
      severity: "review",
      source: "floor_validator",
      confidence: 0.95,
    });
    expect(result.structuredIssues).toHaveLength(1);
    expect(result.primaryStructuredIssue?.evidence).toEqual(
      expect.arrayContaining([
        "baseline_material:wood",
        "staged_material:tile",
        "floor_identity_breaking_material_shift",
        "floor_confidence_band:block",
      ])
    );
    expect(result.hardFail).toBe(true);
  });
});