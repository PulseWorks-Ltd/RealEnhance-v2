import {
  clearWallVisibilityCacheForJob,
  __getWallVisibilityCacheStateForTest,
  __setWallVisibilityCacheEntryForTest,
  WALL_VISIBILITY_CACHE_MAX_ENTRIES,
  type WallVisibilityWall,
} from "../src/pipeline/anchorLockedStaging";

function makeWalls(label: string): WallVisibilityWall[] {
  return [
    {
      id: "wall_0",
      wallLabel: label,
      extent: { polygon: [] as any },
      openingIds: [],
      usableWidthFraction: 1,
      usableSegments: [],
      confidence: 0.9,
    },
  ];
}

describe("wallVisibilityCache lifecycle (C2 fix)", () => {
  it("keys different jobs independently — one job's entry does not leak into another's lookup", () => {
    __setWallVisibilityCacheEntryForTest("job_A", makeWalls("A"));
    __setWallVisibilityCacheEntryForTest("job_B", makeWalls("B"));

    const state = __getWallVisibilityCacheStateForTest();
    expect(state.hasJob("job_A")).toBe(true);
    expect(state.hasJob("job_B")).toBe(true);

    clearWallVisibilityCacheForJob("job_A");
    clearWallVisibilityCacheForJob("job_B");
  });

  it("a job cannot retain cache state after it finishes — clearWallVisibilityCacheForJob evicts exactly that job's entry", () => {
    __setWallVisibilityCacheEntryForTest("job_finished", makeWalls("finished"));
    expect(__getWallVisibilityCacheStateForTest().hasJob("job_finished")).toBe(true);

    // Simulates the worker.ts per-job `finally` block cleanup call.
    clearWallVisibilityCacheForJob("job_finished");

    expect(__getWallVisibilityCacheStateForTest().hasJob("job_finished")).toBe(false);
  });

  it("clearing a job that was never cached, or clearing twice, is a safe no-op", () => {
    expect(() => clearWallVisibilityCacheForJob("job_never_cached")).not.toThrow();
    __setWallVisibilityCacheEntryForTest("job_double_clear", makeWalls("x"));
    clearWallVisibilityCacheForJob("job_double_clear");
    expect(() => clearWallVisibilityCacheForJob("job_double_clear")).not.toThrow();
    expect(__getWallVisibilityCacheStateForTest().hasJob("job_double_clear")).toBe(false);
  });

  it("defense-in-depth: the cache cannot grow past its cap even if per-job cleanup is never called", () => {
    const totalJobs = WALL_VISIBILITY_CACHE_MAX_ENTRIES + 10;
    const jobIds: string[] = [];
    for (let i = 0; i < totalJobs; i++) {
      const jobId = `job_stress_${i}`;
      jobIds.push(jobId);
      __setWallVisibilityCacheEntryForTest(jobId, makeWalls(jobId));
    }

    const state = __getWallVisibilityCacheStateForTest();
    expect(state.size).toBeLessThanOrEqual(WALL_VISIBILITY_CACHE_MAX_ENTRIES);

    // Oldest entries (inserted first) should have been evicted first.
    expect(state.hasJob(jobIds[0])).toBe(false);
    // Most recently inserted entry must still be present.
    expect(state.hasJob(jobIds[jobIds.length - 1])).toBe(true);

    // Cleanup for the entries that do remain, so this test doesn't leak
    // state into other test files sharing the module cache.
    for (const jobId of jobIds) {
      clearWallVisibilityCacheForJob(jobId);
    }
  });

  it("re-setting an existing job's entry refreshes its position instead of counting as a second entry", () => {
    __setWallVisibilityCacheEntryForTest("job_refresh", makeWalls("v1"));
    const sizeAfterFirstSet = __getWallVisibilityCacheStateForTest().size;
    __setWallVisibilityCacheEntryForTest("job_refresh", makeWalls("v2"));
    const sizeAfterSecondSet = __getWallVisibilityCacheStateForTest().size;
    expect(sizeAfterSecondSet).toBe(sizeAfterFirstSet);
    clearWallVisibilityCacheForJob("job_refresh");
  });
});
