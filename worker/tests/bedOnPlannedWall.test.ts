jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { plannedBedWallFromBrief, buildBedWallPrompt, evaluateBedWall } from "../src/pipeline/stage2Masked/core";
import { isLayoutOrTransientFailure } from "../src/pipeline/stage2Masked/pipeline";

// Nov 2026, job_37bb979a: the plan chose the plain right-hand wall; attempt 2
// put the bed against the back wall (with a doorway), past the corner, and passed.
const brief = {
  walls: [
    { name: "the plain wall on the right of the photo" },
    { name: "the back wall with the open doorway" },
  ],
  layout: [
    { item: "Queen bed (1.5 m wide)", placement: "headboard against the plain wall on the right of the photo, toward the far corner" },
    { item: "Bedside table (0.5 m wide)", placement: "beside the bed" },
  ],
};

describe("bed on the wall the room plan chose (job_37bb979a)", () => {
  it("reads the planned wall from the plan, by the plan's own wall name", () => {
    expect(plannedBedWallFromBrief(brief)).toBe("the plain wall on the right of the photo");
    expect(plannedBedWallFromBrief({ layout: [{ item: "Double bed", placement: "against the left wall under the window — toward the corner" }] })).toBe("against the left wall under the window");
    expect(plannedBedWallFromBrief({ layout: [{ item: "Sofa", placement: "x" }] })).toBeNull();
  });
  it("asks the check whether the headboard is on that wall", () => {
    const p = buildBedWallPrompt([], "the plain wall on the right of the photo");
    expect(p).toMatch(/onPlannedWall/);
    expect(p).toMatch(/the plain wall on the right of the photo/);
    expect(p).toMatch(/past a corner of the room/);
    expect(buildBedWallPrompt([])).not.toMatch(/onPlannedWall/);
  });
  it("fails a bed on a different wall, with a hint naming the planned wall, and allows another staging", () => {
    const planned = "the plain wall on the right of the photo";
    const r = evaluateBedWall({ bedPresent: "yes", onPlannedWall: "no", doorOnHeadboardWall: "yes", otherPlainWallAvailable: "no" }, planned);
    expect(r.failed).toBe(true);
    expect(r.wrongWall).toBe(true);
    expect(r.restageHints.join(" ")).toMatch(/the plain wall on the right of the photo/);
    expect(evaluateBedWall({ bedPresent: "yes", onPlannedWall: "yes" }, planned).failed).toBe(false);
    expect(evaluateBedWall({ bedPresent: "yes" }, null).failed).toBe(false);
    expect(isLayoutOrTransientFailure("bed not where the plan put it")).toBe(true);
  });
});
