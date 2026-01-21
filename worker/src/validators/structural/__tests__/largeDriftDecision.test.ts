import { computeLargeDriftFlag, evaluateRiskWithLargeDrift } from "../stageAwareValidator";
import { ValidateParams } from "../../stageAwareConfig";
import { ValidationTrigger } from "../../stageAwareConfig";

describe("large drift decision logic", () => {
  const iouTrigger = (id: string): ValidationTrigger => ({ id, message: id, value: 0, threshold: 0, stage: "stage2" });
  const nonIouTrigger = (id: string): ValidationTrigger => ({ id, message: id, value: 0, threshold: 0, stage: "stage2" });
  const fatalTrigger = (id: string): ValidationTrigger => ({ id, message: id, value: 0, threshold: 0, stage: "stage2", fatal: true });

  const baseOpts = {
    gateMinSignals: 2,
    largeDrift: true,
    largeDriftIouSignalOnly: true,
    largeDriftRequireNonIouSignals: true,
  } as const;

  it("passes when largeDrift=true and only IoU fails", () => {
    const res = evaluateRiskWithLargeDrift({
      ...baseOpts,
      triggers: [iouTrigger("edge_iou"), iouTrigger("structural_mask_iou")],
    });
    expect(res.risk).toBe(false);
    expect(res.reason).toBe("largeDrift-iou-only");
  });

  it("blocks when largeDrift=true and IoU + nonIoU fail", () => {
    const res = evaluateRiskWithLargeDrift({
      ...baseOpts,
      triggers: [iouTrigger("edge_iou"), nonIouTrigger("line_geometry_score")],
    });
    expect(res.risk).toBe(true);
    expect(res.reason).toBe("iou+nonIou");
  });

  it("blocks when largeDrift=true and fatal trigger present", () => {
    const res = evaluateRiskWithLargeDrift({
      ...baseOpts,
      triggers: [fatalTrigger("window_count_change"), iouTrigger("edge_iou")],
    });
    expect(res.risk).toBe(true);
    expect(res.hasFatal).toBe(true);
    expect(res.reason).toContain("fatal");
  });

  it("uses normal regime when largeDrift=false", () => {
    const res = evaluateRiskWithLargeDrift({
      ...baseOpts,
      largeDrift: false,
      triggers: [nonIouTrigger("line_geometry_score"), nonIouTrigger("openings_created_maskededge")],
    });
    expect(res.risk).toBe(true); // gateMinSignals=2
    expect(res.reason).toContain("gate");
  });

  it("computes largeDrift from dimContext maxDelta > tol", () => {
    const dimContext: ValidateParams["dimContext"] = {
      baseline: { width: 1000, height: 1000 },
      candidateOriginal: { width: 940, height: 940 },
      dw: 0.06,
      dh: 0.06,
      maxDelta: 0.06,
      wasNormalized: true,
    };

    const { largeDrift, effectiveMaxDelta } = computeLargeDriftFlag({
      stage: "stage2",
      dimContext,
      computedMaxDelta: 0.0,
      tolerance: 0.04,
      largeDriftIouSignalOnly: true,
    });

    expect(largeDrift).toBe(true);
    expect(effectiveMaxDelta).toBeCloseTo(0.06);

    const res = evaluateRiskWithLargeDrift({
      ...baseOpts,
      largeDrift,
      triggers: [iouTrigger("edge_iou")],
    });
    expect(res.risk).toBe(false);
  });

  it("uses computed maxDelta when context is absent or within tolerance", () => {
    const { largeDrift } = computeLargeDriftFlag({
      stage: "stage2",
      dimContext: undefined,
      computedMaxDelta: 0.02,
      tolerance: 0.04,
      largeDriftIouSignalOnly: true,
    });
    expect(largeDrift).toBe(false);
  });
});
