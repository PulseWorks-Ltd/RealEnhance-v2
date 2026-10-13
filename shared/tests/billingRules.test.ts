import { computeCharge, estimateCredits, estimateBatchCredits } from "../src/billing/rules";

describe("billing rules (BILLING_DECLUTTER_STAGE_EXTRA_CREDIT=on)", () => {
  beforeAll(() => { process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "on"; });
  afterAll(() => { delete process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT; });

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

  it("returns 2 for declutter + stage when both were delivered", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: true,
    });
    expect(result.amount).toBe(2);
    expect(result.reason).toBe("declutter_and_stage");
  });

  it("returns 1 when staging an empty room (no declutter chosen)", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: false,
    });
    expect(result.amount).toBe(1);
  });

  it("returns 1 when 1B ran but the user did not choose declutter", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: false,
    });
    expect(result.amount).toBe(1);
  });

  it("returns 1 for declutter + stage when staging fell back to the decluttered image", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: false,
      sceneType: "interior",
      stage1BUserSelected: true,
      completionType: "fallback_1b" as any,
      finalDeliveredStage: "1B",
      requestedBeyond1A: true,
    });
    expect(result.amount).toBe(1);
  });

  it("returns 1 for declutter + stage when the room was empty (declutter skipped)", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: true,
    });
    expect(result.amount).toBe(1);
  });

  it("returns 2 when the pre-check quoted declutter + stage (user only ticked Stage)", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: false,
      declutterAndStageBillable: true,
    });
    expect(result.amount).toBe(2);
  });

  it("returns 1 when the pre-check quoted 1 even though declutter ran", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: true,
      declutterAndStageBillable: false,
    });
    expect(result.amount).toBe(1);
  });

  it("returns 1 for declutter only", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: false,
      sceneType: "interior",
      stage1BUserSelected: true,
    });
    expect(result.amount).toBe(1);
  });

  it("returns 1 for partial interior pipeline", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: false,
      sceneType: "interior",
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("flat_one_image_model");
  });

  it("returns 0 for interior fallback_1a when user requested beyond 1A", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: false,
      sceneType: "interior",
      completionType: "fallback_1a",
      finalDeliveredStage: "1A",
      requestedBeyond1A: true,
    });
    expect(result.amount).toBe(0);
    expect(result.reason).toBe("interior_fallback_1a_refund");
  });

  it("returns 1 for intentional interior 1A-only delivery", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: false,
      sceneType: "interior",
      finalDeliveredStage: "1A",
      requestedBeyond1A: false,
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("flat_one_image_model");
  });

  it("returns 1 for exterior full pipeline", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "exterior",
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("flat_one_image_model");
  });

  it("returns 1 for exterior 1A-only success", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: false,
      stage2: false,
      sceneType: "exterior",
      completionType: "fallback_1a",
      finalDeliveredStage: "1A",
      requestedBeyond1A: true,
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("flat_one_image_model");
  });

  describe("estimates", () => {
    it("declutter + stage interior = 2", () => {
      expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true })).toBe(2);
    });
    it("stage only, declutter only, enhance only = 1", () => {
      expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: false, userSelectedStage2: true })).toBe(1);
      expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: false })).toBe(1);
      expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: false, userSelectedStage2: false })).toBe(1);
    });
    it("exterior = 1", () => {
      expect(estimateCredits({ sceneType: "exterior", userSelectedStage1B: true, userSelectedStage2: true })).toBe(1);
    });
    it("batch sums per image", () => {
      expect(
        estimateBatchCredits([
          { sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true },
          { sceneType: "interior", userSelectedStage1B: false, userSelectedStage2: true },
          { sceneType: "exterior", userSelectedStage1B: false, userSelectedStage2: false },
        ])
      ).toBe(4);
    });
  });
});

describe("billing rules (default: 1 credit per image)", () => {
  beforeEach(() => { delete process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT; });

  it("charges 1 for declutter + stage when the switch is off", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: true,
      declutterAndStageBillable: true,
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("flat_one_image_model");
  });

  it("estimates 1 per image for declutter + stage when the switch is off", () => {
    expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true })).toBe(1);
    expect(estimateBatchCredits([
      { sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true },
      { sceneType: "exterior", userSelectedStage1B: false, userSelectedStage2: false },
    ])).toBe(2);
  });

  it("still refunds a failed staging and charges 0 when Stage 1A failed", () => {
    expect(computeCharge({ stage1A: false, stage1B: true, stage2: true, sceneType: "interior" }).amount).toBe(0);
    expect(computeCharge({
      stage1A: true, stage1B: false, stage2: false, sceneType: "interior",
      completionType: "fallback_1a", finalDeliveredStage: "1A", requestedBeyond1A: true,
    }).amount).toBe(0);
  });

  it("treats only on/1/true/yes as on", () => {
    process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "off";
    expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true })).toBe(1);
    process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "ON";
    expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true })).toBe(2);
  });
});
