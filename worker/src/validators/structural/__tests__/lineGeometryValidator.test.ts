import { runLineGeometryCheck } from "../lineGeometryValidator";

jest.mock("../../lineEdgeValidator", () => ({
  validateLineStructure: jest.fn(),
}));

const { validateLineStructure } = jest.requireMock("../../lineEdgeValidator");

describe("lineGeometryValidator", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("emits trigger when score falls below threshold", async () => {
    validateLineStructure.mockResolvedValue({
      passed: false,
      score: 0.6,
      edgeLoss: 0.2,
    });

    const result = await runLineGeometryCheck({
      baselinePath: "/tmp/base.png",
      candidatePath: "/tmp/cand.png",
      stage: "stage2",
      threshold: 0.7,
    });

    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].id).toBe("line_geometry_score");
    expect(result.triggers[0].fatal).toBeUndefined();
    expect(result.metrics.lineScore).toBe(0.6);
    expect(result.metrics.edgeLoss).toBe(0.2);
  });

  it("returns empty triggers when score meets threshold", async () => {
    validateLineStructure.mockResolvedValue({
      passed: true,
      score: 0.8,
      edgeLoss: 0.1,
    });

    const result = await runLineGeometryCheck({
      baselinePath: "/tmp/base.png",
      candidatePath: "/tmp/cand.png",
      stage: "stage1B",
      threshold: 0.7,
    });

    expect(result.triggers).toHaveLength(0);
    expect(result.metrics.lineScore).toBe(0.8);
    expect(result.metrics.edgeLoss).toBe(0.1);
  });
});
