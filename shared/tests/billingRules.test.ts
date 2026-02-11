import { computeCharge } from "../src/billing/rules";

describe("billing rules", () => {
  it("returns 0 when stage1A failed", () => {
    const result = computeCharge({
      stage1A: false,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
    });
    expect(result.amount).toBe(0);
    expect(result.reason).toBe("stage1A_failed");
  });

  it("returns 2 for full interior pipeline", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
    });
    expect(result.amount).toBe(2);
    expect(result.reason).toBe("interior_full_pipeline");
  });

  it("returns 1 for partial interior pipeline", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: false,
      sceneType: "interior",
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("interior_partial_pipeline");
  });

  it("caps exterior charge after stage-based computation", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "exterior",
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("exterior_cap");
  });
});
