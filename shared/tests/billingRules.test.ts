import { computeCharge, estimateCredits, estimateBatchCredits, deliveredImageCharge, requiredCreditsForJobOptions } from "../src/billing/rules";

describe("billing rules (BILLING_DECLUTTER_STAGE_EXTRA_CREDIT=on: staged image = 2 credits)", () => {
  beforeAll(() => { process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "on"; });
  afterAll(() => { delete process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT; });
  const interior = { stage1A: true, sceneType: "interior" };

  it("returns 0 when stage1A failed", () => {
    const r = computeCharge({ stage1A: false, stage1B: true, stage2: true, sceneType: "interior" });
    expect(r).toEqual({ amount: 0, reason: "stage1A_failed" });
  });
  it("charges 2 for declutter + stage when the staged image was delivered", () => {
    expect(computeCharge({ ...interior, stage1B: true, stage2: true, finalDeliveredStage: "2" })).toEqual({ amount: 2, reason: "staged_image" });
  });
  it("charges 2 for staging an empty room (no declutter)", () => {
    expect(computeCharge({ ...interior, stage1B: false, stage2: true, finalDeliveredStage: "2" }).amount).toBe(2);
  });
  it("charges 1 for enhance only and for enhance + declutter", () => {
    expect(computeCharge({ ...interior, stage1B: false, stage2: false, completionType: "intentional_1a_success" as any, finalDeliveredStage: "1A" }).amount).toBe(1);
    expect(computeCharge({ ...interior, stage1B: true, stage2: false, finalDeliveredStage: "1B" }).amount).toBe(1);
  });
  it("charges 1 when staging fell back to the decluttered image", () => {
    expect(computeCharge({ ...interior, stage1B: true, stage2: false, completionType: "fallback_1b" as any, finalDeliveredStage: "1B", requestedBeyond1A: true }).amount).toBe(1);
  });
  it("refunds (0) when staging fell back to the enhanced image", () => {
    expect(computeCharge({ ...interior, stage1B: false, stage2: false, completionType: "fallback_1a" as any, finalDeliveredStage: "1A", requestedBeyond1A: true })).toEqual({ amount: 0, reason: "interior_fallback_1a_refund" });
  });
  it("charges 1 for exteriors whatever was asked", () => {
    expect(computeCharge({ stage1A: true, stage1B: true, stage2: true, sceneType: "exterior" }).amount).toBe(1);
  });
  it("quotes 2 for any staged interior, 1 otherwise", () => {
    expect(estimateCredits({ sceneType: "interior", userSelectedStage2: true })).toBe(2);
    expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: true })).toBe(2);
    expect(estimateCredits({ sceneType: "interior", userSelectedStage1B: true, userSelectedStage2: false })).toBe(1);
    expect(estimateCredits({ sceneType: "exterior", userSelectedStage2: true })).toBe(1);
    expect(estimateBatchCredits([
      { sceneType: "interior", userSelectedStage2: true },
      { sceneType: "interior", userSelectedStage2: false },
      { sceneType: "exterior", userSelectedStage2: false },
    ])).toBe(4);
  });
});

describe("billing rules (default: 1 credit per image)", () => {
  beforeEach(() => { delete process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT; });

  it("charges 1 for a staged image when the switch is off", () => {
    const result = computeCharge({
      stage1A: true,
      stage1B: true,
      stage2: true,
      sceneType: "interior",
      stage1BUserSelected: true,
    });
    expect(result.amount).toBe(1);
    expect(result.reason).toBe("flat_one_image_model");
  });

  it("estimates 1 per image when the switch is off", () => {
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

describe("charged credits for a finished image (worker)", () => {
  afterEach(() => { delete process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT; });
  it("switch on: staged 2, not staged 1, exterior 1, nothing delivered 0", () => {
    process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "on";
    expect(deliveredImageCharge({ billable: true, sceneType: "interior", stagedDelivered: true })).toBe(2);
    expect(deliveredImageCharge({ billable: true, sceneType: "interior", stagedDelivered: false })).toBe(1);
    expect(deliveredImageCharge({ billable: true, sceneType: "exterior", stagedDelivered: true })).toBe(1);
    expect(deliveredImageCharge({ billable: false, sceneType: "interior", stagedDelivered: true })).toBe(0);
  });
  it("never charges more than was quoted", () => {
    process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "on";
    expect(deliveredImageCharge({ billable: true, sceneType: "interior", stagedDelivered: true, quotedCredits: 1 })).toBe(1);
    expect(deliveredImageCharge({ billable: true, sceneType: "interior", stagedDelivered: true, quotedCredits: 2 })).toBe(2);
  });
  it("switch off: always 1 when delivered", () => {
    expect(deliveredImageCharge({ billable: true, sceneType: "interior", stagedDelivered: true })).toBe(1);
  });
  it("reserve amount for stored jobs follows the quote, else the same rule", () => {
    expect(requiredCreditsForJobOptions({ virtualStage: true, sceneType: "interior" })).toBe(1);
    process.env.BILLING_DECLUTTER_STAGE_EXTRA_CREDIT = "on";
    expect(requiredCreditsForJobOptions({ virtualStage: true, sceneType: "interior" })).toBe(2);
    expect(requiredCreditsForJobOptions({ virtualStage: true, sceneType: "exterior" })).toBe(1);
    expect(requiredCreditsForJobOptions({ virtualStage: false, declutter: true, sceneType: "interior" })).toBe(1);
    expect(requiredCreditsForJobOptions({ virtualStage: true, quotedCredits: 1 })).toBe(1);
    expect(requiredCreditsForJobOptions({ quotedCredits: 5 })).toBe(2);
  });
});
