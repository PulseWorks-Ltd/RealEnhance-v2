import { evaluateStructuralInvariantDecision } from "../src/validators/structuralInvariantDecision";

describe("structural invariant decision parser", () => {
  it("does not trigger opening violation for explicit negation phrase", () => {
    const result = evaluateStructuralInvariantDecision({
      openings_before: 2,
      openings_after: 2,
      removed_openings_count: 0,
      removed_opening_locations: [],
      relocation_detected: false,
      location_mismatch_detected: false,
      wall_plane_replacement_detected: false,
      opening_occlusion_only: true,
      confidence: 5,
      reason:
        "The total number of structural wall openings remains constant at 2 (one window, one door) in both the BEFORE and AFTER images. Both the window on the left wall and the door on the right wall are present in the same approximate locations. The window in the AFTER image is partially occluded by curtains and a bed, but its structural frame edges are visibly present, the depth void and light cavity remain visible, and the wall plane does not become continuous across its boundary. Therefore, it is considered merely occluded, not removed. No openings were removed, relocated, or infilled by continuous wall planes.",
    });

    expect(result.openingViolationDetected).toBe(false);
    expect(result.fail).toBe(false);
  });
});
