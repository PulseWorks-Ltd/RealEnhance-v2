jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { checkWallNames, normaliseLandmarkBoxes, buildRoomBriefInstruction } from "../src/pipeline/roomBrief";
import { floorMovedHint } from "../src/pipeline/stage2Masked/core";

const brief = (walls: string[], placement: string): any => ({
  walls: walls.map((name) => ({ name, description: "", usableForLargeFurniture: true, partlyVisible: false })),
  layout: [{ item: "Queen bed", placement }],
  relationships: [],
  avoid: [],
});

describe("room brief wall names", () => {
  it("flags walls named by direction alone (job_56b49ee9, Oct 2026)", () => {
    const issues = checkWallNames(brief(["left wall", "far wall"], "against the left wall beneath the high clerestory window"));
    expect(issues.join(" ")).toContain('"left wall"');
  });

  it("accepts walls named by position in the photo and what is on them", () => {
    const name = "the wall straight ahead with the high strip window";
    expect(checkWallNames(brief([name, "the wall on the right of the photo with the large picture window"], `headboard against ${name}, foot toward the picture window`))).toEqual([]);
  });

  it("flags a bare direction in a placement even when the walls are named well", () => {
    const issues = checkWallNames(brief(["the wall straight ahead with the high strip window"], "against the back wall of the room"));
    expect(issues.join(" ")).toContain('"back wall"');
  });

  it("tells the planner the rule", () => {
    expect(buildRoomBriefInstruction("bedroom")).toContain("Name every wall by where it is in the photo AND what is on it");
  });
});

describe("room brief landmark boxes", () => {
  it("turns Gemini's box_2d [ymin, xmin, ymax, xmax] on 0-1000 into [x1, y1, x2, y2] on 0-1", () => {
    const b: any = { landmarks: [{ id: "L1", type: "window", description: "high strip window", box_2d: [20, 160, 280, 450] }] };
    normaliseLandmarkBoxes(b);
    expect(b.landmarks[0].box).toEqual([0.16, 0.02, 0.45, 0.28]);
    expect(b.landmarks[0].box_2d).toBeUndefined();
  });
  it("leaves an old-style box alone", () => {
    const b: any = { landmarks: [{ id: "L1", type: "door", description: "", box: [0.1, 0.2, 0.3, 0.9] }] };
    normaliseLandmarkBoxes(b);
    expect(b.landmarks[0].box).toEqual([0.1, 0.2, 0.3, 0.9]);
  });
});

describe("floor-moved hint on tight shots", () => {
  it("adds the run-off-the-edge, no-rug line only for tight shots", () => {
    expect(floorMovedHint({ atXPct: [16, 25] }, { tightShot: true })).toContain("leave out the rug");
    expect(floorMovedHint({ atXPct: [16, 25] })).not.toContain("leave out the rug");
  });
});
