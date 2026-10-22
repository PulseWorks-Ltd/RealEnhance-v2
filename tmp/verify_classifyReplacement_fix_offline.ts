import { classifyReplacement } from "../worker/src/validators/occlusionVsRemovalCheck";

let failures = 0;
function check(label: string, text: string, expectReplaced: boolean) {
  const r = classifyReplacement(text);
  const pass = r.value === expectReplaced;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: value=${r.value} confidence=${r.confidence} matchedPattern=${r.matchedPattern} (expected ${expectReplaced})`);
  if (!pass) failures++;
}

console.log("=== Real captured false positive (must now be fixed): job_3e255f88 W2 ===");
check(
  "job_3e255f88 W2 currentSurfaceDescription (variant 1: 'continues below it')",
  "Window glass and grey blind near the ceiling; plain white wall continues below it down to a white dresser.",
  false
);
check(
  "job_3e255f88 W2 currentSurfaceDescription (variant 2: 'surrounds it', from live re-test)",
  "Window glass, white frame trim, and a light roller blind; plain white wall surrounds it, with a mirror and dresser below outside the region.",
  false
);
check(
  "job_3e255f88 W2 currentSurfaceDescription (variant 3: 'against plain white wall', from a later live re-test)",
  "Window glass and white frame with roller shade against plain white wall; nothing large sitting directly over the pane.",
  false
);
check(
  "job_8505488a attempt1 F1 (AC unit) currentSurfaceDescription (variant 4: 'mounted...on the plain painted wall')",
  "White plastic AC unit housing mounted high on the plain painted wall.",
  false
);

console.log("\n=== Real captured cases NOT touched by this fix (different mechanism, must remain unchanged) ===");
check(
  "job_d8329bfc C1 currentSurfaceDescription (ambiguous/perception, not a pattern bug)",
  "Flat painted drywall with no seam, break, or hardware; the adjacent dresser sits to the left but does not occupy this exact edge strip.",
  true
);
check(
  "Bedroom 02 D1 currentSurfaceDescription (perception/geometry, not a pattern bug)",
  "Light wood furniture top with ceramic/decorative objects and books in the lower portion; plain painted white wall and the edge of a black picture frame in the upper portion.",
  true
);

console.log("\n=== Detection power preserved: genuine 'replaced' positive case ===");
check(
  "Synthetic genuine violation (no adjacency phrasing)",
  "The window has been fully removed. A plain, continuous painted wall now fills the entire opening where the window used to be.",
  true
);
check(
  "Synthetic genuine violation using 'by' (not on/onto/against/into, must still fire)",
  "No trace of the AC unit remains. The wall in this region has been replaced by a plain, continuous painted surface.",
  true
);

console.log("\n=== Existing negation-guard case (from the code's own AUDIT FIX comment, must remain correct) ===");
check(
  "Existing negated case",
  "The closet door is still fully present here - it has definitely not been replaced by a continuous wall.",
  false
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
