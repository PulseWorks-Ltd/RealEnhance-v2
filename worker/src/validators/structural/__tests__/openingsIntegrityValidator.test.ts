import { runOpeningsIntegrityCheck } from "../openingsIntegrityValidator";

jest.mock("../../maskedEdgeValidator", () => ({
  runMaskedEdgeValidator: jest.fn(),
}));

const { runMaskedEdgeValidator } = jest.requireMock("../../maskedEdgeValidator");

describe("openingsIntegrityValidator", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("flags created openings and applies fatal when enabled", async () => {
    runMaskedEdgeValidator.mockResolvedValue({
      createdOpenings: 2,
      closedOpenings: 0,
      maskedEdgeDrift: 0.1,
    });

    const result = await runOpeningsIntegrityCheck({
      baselinePath: "/tmp/base.png",
      candidatePath: "/tmp/cand.png",
      stage: "stage2",
      scene: "interior",
      thresholds: { createMax: 0, closeMax: 0, maskedDriftMax: 0.2 },
      fatalOnOpeningsDelta: true,
    });

    expect(result.metrics.openingsCreated).toBe(2);
    expect(result.triggers.some(t => t.id === "openings_created_maskededge" && t.fatal)).toBe(true);
  });

  it("flags masked edge drift when above threshold", async () => {
    runMaskedEdgeValidator.mockResolvedValue({
      createdOpenings: 0,
      closedOpenings: 0,
      maskedEdgeDrift: 0.35,
    });

    const result = await runOpeningsIntegrityCheck({
      baselinePath: "/tmp/base.png",
      candidatePath: "/tmp/cand.png",
      stage: "stage1B",
      scene: "interior",
      thresholds: { createMax: 1, closeMax: 1, maskedDriftMax: 0.3 },
      fatalOnOpeningsDelta: false,
    });

    const driftTrigger = result.triggers.find(t => t.id === "masked_edge_drift");
    expect(driftTrigger).toBeDefined();
    expect(driftTrigger?.fatal).toBeUndefined();
  });

  it("returns no triggers when within thresholds", async () => {
    runMaskedEdgeValidator.mockResolvedValue({
      createdOpenings: 0,
      closedOpenings: 0,
      maskedEdgeDrift: 0.1,
    });

    const result = await runOpeningsIntegrityCheck({
      baselinePath: "/tmp/base.png",
      candidatePath: "/tmp/cand.png",
      stage: "stage2",
      scene: "exterior",
      thresholds: { createMax: 1, closeMax: 1, maskedDriftMax: 0.3 },
      fatalOnOpeningsDelta: false,
    });

    expect(result.triggers).toHaveLength(0);
  });
});
