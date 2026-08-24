import { classifyReplacement } from "../worker/src/validators/occlusionVsRemovalCheck";

let failures = 0;
function check(label: string, text: string, expectReplaced: boolean) {
  const r = classifyReplacement(text);
  const pass = r.value === expectReplaced;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: value=${r.value} confidence=${r.confidence} matchedPattern=${r.matchedPattern} (expected ${expectReplaced})`);
  if (!pass) failures++;
}

console.log("=== 5th real captured false positive (Bedroom 12-2, A1 doorway) ===");
check(
  "A1 doorway currentSurfaceDescription",
  "Open air of a doorway with the carpeted floor and white walls of the next room visible through the gap; the surrounding wall surface is plain painted drywall.",
  false
);

console.log("\n=== All four prior variants (must remain correctly fixed) ===");
check("Variant 1: continues below it", "Window glass and grey blind near the ceiling; plain white wall continues below it down to a white dresser.", false);
check("Variant 2: surrounds it", "Window glass, white frame trim, and a light roller blind; plain white wall surrounds it, with a mirror and dresser below outside the region.", false);
check("Variant 3: against plain white wall", "Window glass and white frame with roller shade against plain white wall; nothing large sitting directly over the pane.", false);
check("Variant 4: mounted...on the plain painted wall", "White plastic AC unit housing mounted high on the plain painted wall.", false);

console.log("\n=== Untouched cases (different mechanism, must remain unchanged) ===");
check("job_d8329bfc C1 (ambiguous/perception, not a pattern bug)", "Flat painted drywall with no seam, break, or hardware; the adjacent dresser sits to the left but does not occupy this exact edge strip.", true);
check("Bedroom 02 D1 (perception/geometry, not a pattern bug — must keep failing)", "Light wood furniture top with ceramic/decorative objects and books in the lower portion; plain painted white wall and the edge of a black picture frame in the upper portion.", true);

console.log("\n=== Detection power preserved: genuine violations ===");
check("Synthetic genuine violation (no adjacency phrasing)", "The window has been fully removed. A plain, continuous painted wall now fills the entire opening where the window used to be.", true);
check("Synthetic genuine violation using 'by'", "No trace of the AC unit remains. The wall in this region has been replaced by a plain, continuous painted surface.", true);
check(
  "Genuine violation using 'surrounding' in a different sense (wall extension, not context)",
  "The window is gone. The surrounding wall has been extended to fully cover the opening, now a plain continuous surface.",
  true
);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
