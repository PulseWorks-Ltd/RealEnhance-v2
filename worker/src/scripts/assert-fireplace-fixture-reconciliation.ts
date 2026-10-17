/**
 * Zero-cost verification of the anchor-fixture reconciliation added for the
 * fireplace-loss investigation (worker/src/validators/openingPreservationValidator.ts).
 *
 * Replaces the previous behavior — on disagreement between the 2 default
 * baseline-extraction consensus passes, anchorFixtures came along for the
 * ride with whichever full graph won an alphabetical SHA-256 hash tie-break,
 * unrelated to correctness. Fixtures are now reconciled independently by
 * unioning what either pass saw, keyed by a drift-resistant identity token
 * (type|wallIndex|horizontalBand), with no truncation.
 *
 * Exercises the real exported functions directly on fabricated pass data —
 * no Gemini calls, no image files.
 *
 * Usage: tsx src/scripts/assert-fireplace-fixture-reconciliation.ts
 */
import {
  anchorFixtureIdentityToken,
  reconcileAnchorFixturesAcrossPasses,
  type AnchorFixture,
  type StructuralBaseline,
} from "../validators/openingPreservationValidator";

let anyFailure = false;
function check(name: string, pass: boolean, detail?: string) {
  if (!pass) anyFailure = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function fixture(overrides: Partial<AnchorFixture>): AnchorFixture {
  return {
    id: "F1",
    type: "fireplace",
    wallIndex: 2,
    horizontalBand: "center_third",
    bbox: [0.4, 0.5, 0.6, 0.8],
    confidence: 0.9,
    description: "white tiled fireplace with black firebox",
    ...overrides,
  };
}

function baseline(anchorFixtures: AnchorFixture[]): StructuralBaseline {
  return { openings: [], anchorFixtures };
}

// 1. Identity token excludes drifting fields (bbox/description/id), includes
//    the fields that actually identify "the same fixture" across passes.
const fpA = fixture({ id: "F1", bbox: [0.4, 0.5, 0.6, 0.8], description: "tiled fireplace" });
const fpB = fixture({ id: "F9", bbox: [0.41, 0.49, 0.59, 0.79], description: "white brick hearth" });
check(
  "identity_token_ignores_bbox_description_id",
  anchorFixtureIdentityToken(fpA) === anchorFixtureIdentityToken(fpB)
);
check(
  "identity_token_differs_on_wallIndex",
  anchorFixtureIdentityToken(fpA) !== anchorFixtureIdentityToken(fixture({ wallIndex: 0 }))
);
check(
  "identity_token_differs_on_type",
  anchorFixtureIdentityToken(fpA) !== anchorFixtureIdentityToken(fixture({ type: "other" }))
);

// 2. The exact incident scenario: pass 1 sees the fireplace, pass 2 misses it
//    entirely (both see a tv_mount identically). Union must keep BOTH — a
//    fixture seen in only one pass must survive, not be discarded as a tie-break loss.
const tvMount = fixture({ id: "T1", type: "tv_mount", wallIndex: 2, horizontalBand: "center_third", description: "TV wall-mount bracket above the fireplace" });
const pass1 = baseline([fixture({ id: "F1" }), tvMount]);
const pass2 = baseline([tvMount]); // fireplace missed entirely in this pass
const reconciledMiss = reconcileAnchorFixturesAcrossPasses([pass1, pass2]);
check(
  "fixture_seen_in_only_one_pass_survives",
  reconciledMiss.fixtures.some((f) => f.type === "fireplace"),
  `fixtures=${JSON.stringify(reconciledMiss.fixtures.map((f) => f.type))}`
);
check(
  "no_truncation_both_distinct_fixtures_present",
  reconciledMiss.fixtures.length === 2
);

// 3. Two passes agree exactly (same token) -> single reconciled record, not duplicated.
const pass3 = baseline([fixture({ id: "F1", confidence: 0.7 })]);
const pass4 = baseline([fixture({ id: "F2", confidence: 0.95 })]);
const reconciledAgree = reconcileAnchorFixturesAcrossPasses([pass3, pass4]);
check("agreeing_passes_produce_single_fixture_not_duplicated", reconciledAgree.fixtures.length === 1);
check(
  "agreeing_passes_keep_higher_confidence_record",
  reconciledAgree.fixtures[0].confidence === 0.95,
  `got confidence=${reconciledAgree.fixtures[0]?.confidence}`
);
check("agreement_ratio_is_1_when_all_fixtures_seen_in_all_passes", reconciledAgree.fixtureAgreement === 1);

// 4. Old buggy behavior this replaces: concatenate-then-slice(0, max(len)) could
//    drop a genuinely distinct fixture. Simulate 3 distinct single-pass fixtures
//    across 2 passes (2 in pass A, 1 in pass B) — old slice(0, max(2,1)=2) would
//    drop the 3rd. New reconciliation must keep all 3.
const distinctA = baseline([
  fixture({ id: "A1", type: "fireplace", wallIndex: 2 }),
  fixture({ id: "A2", type: "kitchen_island", wallIndex: 0, horizontalBand: "left_third" }),
]);
const distinctB = baseline([
  fixture({ id: "B1", type: "tv_mount", wallIndex: 1, horizontalBand: "right_third" }),
]);
const reconciledDistinct = reconcileAnchorFixturesAcrossPasses([distinctA, distinctB]);
check(
  "three_distinct_single_pass_fixtures_all_survive_no_slice_truncation",
  reconciledDistinct.fixtures.length === 3,
  `got ${reconciledDistinct.fixtures.length}: ${JSON.stringify(reconciledDistinct.fixtures.map((f) => f.type))}`
);

// 5. Empty input is handled cleanly.
const reconciledEmpty = reconcileAnchorFixturesAcrossPasses([baseline([]), baseline([])]);
check("empty_passes_produce_empty_result", reconciledEmpty.fixtures.length === 0);
check("empty_passes_agreement_defaults_to_1_not_nan", reconciledEmpty.fixtureAgreement === 1);

// 6. Single-pass input (OPENING_BASELINE_SINGLE_PASS mode) is an identity operation.
const single = fixture({ id: "S1" });
const reconciledSingle = reconcileAnchorFixturesAcrossPasses([baseline([single])]);
check("single_pass_is_identity_operation", reconciledSingle.fixtures.length === 1 && reconciledSingle.fixtures[0].id === "S1");

console.log(`\n${anyFailure ? "RESULT: one or more checks failed." : "RESULT: all checks passed."}`);
process.exit(anyFailure ? 1 : 0);
