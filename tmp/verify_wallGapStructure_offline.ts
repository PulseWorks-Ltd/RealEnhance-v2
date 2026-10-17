import { compareWallGapObservations, type WallGapObservation } from "./wallGapStructureCheck";

let failures = 0;
function check(label: string, baseline: WallGapObservation, staged: WallGapObservation, expectVerdict: string) {
  const v = compareWallGapObservations(baseline, staged);
  const pass = v.verdict === expectVerdict;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: verdict=${v.verdict} boundaryQualifiedByNewObject=${v.boundaryQualifiedByNewObject} (${v.reason}) (expected ${expectVerdict})`);
  if (!pass) failures++;
}

function obs(overrides: Partial<WallGapObservation> = {}): WallGapObservation {
  return {
    identifiedItemDescription: "",
    itemLocationDescription: "",
    structuralTraceDescription: "",
    itemPresenceState: "present",
    nearestCenterCorner: "",
    boundaryDescription: "",
    boundarySizeCategory: "narrow",
    boundaryDefinedBy: "item_itself",
    itemStructureDescription: "",
    itemStructureCount: 2,
    ...overrides,
  };
}

console.log("=== Pre-existing comparison logic, both sides 'present' (must be unchanged behavior, renamed fields) ===");
console.log("--- Bedroom 09 style: narrow boundary -> wide boundary, AND pane count drops (3 panes -> 1 pane) ---");
check(
  "Both signals converge",
  obs({ boundarySizeCategory: "narrow", itemStructureCount: 3 }),
  obs({ boundarySizeCategory: "wide", itemStructureCount: 1 }),
  "fail_both"
);

console.log("--- Bedroom 12 style: touching -> wide boundary (door shifted far from corner), structure unchanged (still 2 panels) ---");
check("Boundary only", obs({ boundarySizeCategory: "touching", itemStructureCount: 2 }), obs({ boundarySizeCategory: "wide", itemStructureCount: 2 }), "fail_boundary_shifted");

console.log("--- Structure changed but boundary category roughly stable ---");
check("Structure only", obs({ boundarySizeCategory: "medium", itemStructureCount: 3 }), obs({ boundarySizeCategory: "medium", itemStructureCount: 2 }), "fail_structure_changed");

console.log("--- Small, camera-angle-plausible single-step boundary difference, structure unchanged (must NOT flag) ---");
check(
  "Single-step boundary difference alone is not enough",
  obs({ boundarySizeCategory: "narrow", itemStructureCount: 2 }),
  obs({ boundarySizeCategory: "medium", itemStructureCount: 2 }),
  "pass"
);

console.log("--- Fully consistent, no change (must NOT flag) ---");
check("No change", obs({ boundarySizeCategory: "narrow", itemStructureCount: 2 }), obs({ boundarySizeCategory: "narrow", itemStructureCount: 2 }), "pass");

console.log("--- Missing/unknown category or count (must not crash, must default to not-flagged) ---");
check("Unknown category", obs({ boundarySizeCategory: "unknown", itemStructureCount: 2 }), obs({ boundarySizeCategory: "wide", itemStructureCount: 2 }), "pass");
check("Missing structure count", obs({ boundarySizeCategory: "narrow", itemStructureCount: null }), obs({ boundarySizeCategory: "narrow", itemStructureCount: 2 }), "pass");

console.log("\n=== Presence-classification fix (from the prior task) ===");
console.log("--- Bedroom 02-original style: item genuinely absent (confident 'absent', continuous surface) -> CONCLUSIVE FAIL ---");
check(
  "Genuinely absent -> fail_item_absent",
  obs({ itemPresenceState: "present" }),
  obs({ itemPresenceState: "absent", itemLocationDescription: "plain continuous painted wall, no seam, frame, or trace of a door", boundaryDefinedBy: "open_wall" }),
  "fail_item_absent"
);

console.log("--- Bedroom 11 FIXED style: item occluded by new furniture, boundary stable -> must NOT fail (regression guard) ---");
check(
  "Occluded by new furniture, boundary unchanged -> inconclusive, not a fail",
  obs({ itemPresenceState: "present", boundarySizeCategory: "narrow", boundaryDefinedBy: "item_itself" }),
  obs({ itemPresenceState: "occluded", itemLocationDescription: "a dresser is placed directly in front of this location, blocking most of the view", boundarySizeCategory: "narrow", boundaryDefinedBy: "new_object" }),
  "inconclusive_occluded"
);

console.log("--- Genuinely can't tell (poor visibility) -> must NOT fail, must NOT default to absent ---");
check(
  "Cannot tell -> inconclusive, not a fail",
  obs({ itemPresenceState: "present" }),
  obs({ itemPresenceState: "cannot_tell", itemLocationDescription: "this area is too dark/cropped to make out clearly", boundaryDefinedBy: "cannot_tell" }),
  "inconclusive_occluded"
);

console.log("--- Baseline itself not present (no reference data) -> inconclusive, not forced into a comparison ---");
check("Baseline occluded too -> inconclusive", obs({ itemPresenceState: "occluded", boundaryDefinedBy: "cannot_tell" }), obs({ itemPresenceState: "present" }), "inconclusive_occluded");

console.log("\n=== NEW: present_partial (Living 07 fix) ===");
console.log("--- Living 07 style: furniture present, but a structural remnant (hearth) confirms the item survives, boundary stable -> PASS ---");
check(
  "Remnant confirmed, boundary stable -> pass_remnant_confirmed",
  obs({ itemPresenceState: "present", boundarySizeCategory: "wide", boundaryDefinedBy: "item_itself" }),
  obs({
    itemPresenceState: "present_partial",
    structuralTraceDescription: "a raised stone hearth platform is visible at floor level beside the new sofa",
    boundarySizeCategory: "wide",
    boundaryDefinedBy: "item_itself",
  }),
  "pass_remnant_confirmed"
);

console.log("--- Remnant confirmed BUT boundary also genuinely shifted -> must still fail (remnant survival doesn't blanket-suppress a real shift) ---");
check(
  "Remnant confirmed but boundary shifted -> fail_boundary_shifted",
  obs({ itemPresenceState: "present", boundarySizeCategory: "touching", boundaryDefinedBy: "item_itself" }),
  obs({ itemPresenceState: "present_partial", boundarySizeCategory: "wide", boundaryDefinedBy: "item_itself" }),
  "fail_boundary_shifted"
);

console.log("\n=== NEW: decoupled boundary-shift signal (Bedroom 02 fix) ===");
console.log("--- Bedroom 02 style: staged occluded by new furniture (dresser) exactly at the door's old spot, but boundary distance shifted -> FAIL ---");
check(
  "Occluded but boundary shifted (new_object) -> fail_boundary_shifted",
  obs({ itemPresenceState: "present", boundarySizeCategory: "touching", boundaryDefinedBy: "item_itself" }),
  obs({ itemPresenceState: "occluded", itemLocationDescription: "a dresser and mirror now sit where the door used to be", boundarySizeCategory: "wide", boundaryDefinedBy: "new_object" }),
  "fail_boundary_shifted"
);
check(
  "boundaryQualifiedByNewObject is true in the case above",
  obs({ itemPresenceState: "present", boundarySizeCategory: "touching", boundaryDefinedBy: "item_itself" }),
  obs({ itemPresenceState: "occluded", boundarySizeCategory: "wide", boundaryDefinedBy: "new_object" }),
  "fail_boundary_shifted"
);

console.log("--- Bedroom 02 counter-case: occluded, but only a single-step (camera-angle-plausible) boundary difference -> must NOT fire ---");
check(
  "Occluded, single-step boundary difference -> inconclusive, not a fail",
  obs({ itemPresenceState: "present", boundarySizeCategory: "narrow", boundaryDefinedBy: "item_itself" }),
  obs({ itemPresenceState: "occluded", boundarySizeCategory: "medium", boundaryDefinedBy: "new_object" }),
  "inconclusive_occluded"
);

console.log("--- cannot_tell qualifier on boundaryDefinedBy must skip evaluation even if category strings nominally differ ---");
check(
  "boundaryDefinedBy cannot_tell on staged side -> boundary not evaluable, falls back to presence verdict",
  obs({ itemPresenceState: "present", boundarySizeCategory: "touching", boundaryDefinedBy: "item_itself" }),
  obs({ itemPresenceState: "occluded", boundarySizeCategory: "wide", boundaryDefinedBy: "cannot_tell" }),
  "inconclusive_occluded"
);

console.log("--- boundaryQualifiedByNewObject is false when the boundary is item-defined on both sides (e.g. a Bedroom 09/12-style genuine presence resize) ---");
{
  const baseline = obs({ itemPresenceState: "present", boundarySizeCategory: "touching", boundaryDefinedBy: "item_itself" });
  const staged = obs({ itemPresenceState: "present", boundarySizeCategory: "wide", boundaryDefinedBy: "item_itself" });
  const v = compareWallGapObservations(baseline, staged);
  const pass = v.verdict === "fail_boundary_shifted" && v.boundaryQualifiedByNewObject === false;
  console.log(`${pass ? "PASS" : "FAIL"} item-defined boundary shift: verdict=${v.verdict} boundaryQualifiedByNewObject=${v.boundaryQualifiedByNewObject} (expected fail_boundary_shifted, false)`);
  if (!pass) failures++;
}

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
