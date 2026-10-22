// Regression tests for flooringBoundaryCheck.ts's staging-occlusion rescue
// (2026-08-30), covering the confirmed root cause behind job_71d4afb2's
// two real production false positives (Living_07.jpg — the same image
// this file's own header already cites as the case that motivated
// building the check in the first place):
//   - Attempt 1: a dining rug was placed over the linoleum/carpet
//     boundary as normal staging; the check's own boundaryDescription
//     answer said "...one continuous dark speckled carpet surface (plus
//     the dining rug on top)..." and hard-failed as boundary_lost.
//   - Attempt 2: the dining table and chairs were positioned over the
//     same boundary; the answer said "...the speckled carpet now appears
//     to run continuously under the dining table and chairs..." and
//     hard-failed as boundary_lost again. Confirmed by direct visual
//     inspection that the linoleum remains visible just beyond the table
//     in the same zone — only the occluded sub-area reads as changed.
//
// combineFlooringObservation is a pure, synchronous function over raw
// observation text — no Gemini calls, no mocking needed.
import { combineFlooringObservation } from "../src/validators/flooringBoundaryCheck";

describe("combineFlooringObservation — staging-occlusion rescue", () => {
  it("job_71d4afb2 attempt 1: a rug named in the boundary text rescues an otherwise boundary_lost verdict", () => {
    const result = combineFlooringObservation(
      {
        id: "zone_2",
        materialDescription: "dark charcoal gray, low-pile carpet with a dense speckled pattern",
        boundaryDescription:
          "Along the shared edge where this carpet originally met the smooth, medium-gray floor, no seam or threshold remains visible. The floor appears as continuous carpet through that transition area, with only the edges of the placed area rugs interrupting the surface.",
      },
      "dark charcoal gray, low-pile carpet with a dense speckled pattern",
      true
    );
    expect(result.verdict).toBe("preserved");
    expect(result.altered).toBe(false);
    expect(result.occlusionRescueKeywords).toEqual(expect.arrayContaining(["rug"]));
  });

  it("job_71d4afb2 attempt 2: a dining table and chairs named in the boundary text rescue an otherwise boundary_lost verdict", () => {
    const result = combineFlooringObservation(
      {
        id: "zone_2",
        materialDescription: "smooth, solid medium-gray vinyl or linoleum flooring",
        boundaryDescription:
          "Where this carpet originally met the smoother gray floor on the right, no seam, threshold, or material change is visible anymore. The speckled carpet now appears to run continuously under the dining table and chairs with no transition line.",
      },
      "smooth, solid medium-gray vinyl or linoleum flooring",
      true
    );
    expect(result.verdict).toBe("preserved");
    expect(result.altered).toBe(false);
    expect(result.occlusionRescueKeywords.length).toBeGreaterThan(0);
  });

  it("a genuine boundary loss with no staged-item mention still hard-fails", () => {
    const result = combineFlooringObservation(
      {
        id: "zone_2",
        materialDescription: "dark charcoal gray, low-pile carpet with a dense speckled pattern",
        boundaryDescription:
          "No seam, threshold, or material transition is visible anywhere along this edge. The entire floor has been unified into one continuous carpet surface.",
      },
      "dark charcoal gray, low-pile carpet with a dense speckled pattern",
      true
    );
    expect(result.verdict).toBe("boundary_lost");
    expect(result.altered).toBe(true);
    expect(result.occlusionRescueKeywords).toEqual([]);
  });

  it("does not rescue a genuine material_changed verdict just because a rug/table is mentioned nearby", () => {
    const result = combineFlooringObservation(
      {
        id: "zone_1",
        materialDescription:
          "This area now shows dark speckled carpet, a completely different material from the original smooth vinyl — a small rug sits nearby but the underlying floor itself has clearly been changed.",
        boundaryDescription: "No boundary visible; the rug and the floor around it are all one continuous carpet.",
      },
      "smooth, solid medium-gray vinyl or linoleum flooring",
      true
    );
    expect(result.verdict).toBe("material_changed");
    expect(result.altered).toBe(true);
  });

  it("a clean, genuinely preserved zone reports no rescue keywords (nothing to rescue)", () => {
    const result = combineFlooringObservation(
      {
        id: "zone_1",
        materialDescription: "same solid medium-gray vinyl flooring as the original",
        boundaryDescription: "The boundary remains a clearly visible seam between the two materials.",
      },
      "smooth, solid medium-gray vinyl or linoleum flooring",
      true
    );
    expect(result.verdict).toBe("preserved");
    expect(result.altered).toBe(false);
    expect(result.occlusionRescueKeywords).toEqual([]);
  });

  it("single-zone rooms are unaffected (no boundary question asked at all)", () => {
    const result = combineFlooringObservation(
      { id: "zone_1", materialDescription: "same solid medium-gray vinyl flooring as the original" },
      "smooth, solid medium-gray vinyl or linoleum flooring",
      false
    );
    expect(result.verdict).toBe("preserved");
    expect(result.occlusionRescueKeywords).toEqual([]);
  });
});
