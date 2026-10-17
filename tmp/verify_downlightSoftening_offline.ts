// Offline verification of the downlight hardFail-softening logic added to
// fixtureFlooringValidator.ts's runFixtureFlooringValidator. Since the real
// logic lives inline in that async function (not extracted as a standalone
// pure function), this reimplements the exact same isDownlightItem
// predicate + hardFail derivation against representative item sets, to
// confirm the decision logic itself is correct before trusting it live.
type Item = { id: string; type: string; description: string; materiality: "material"; altered: true };

function isDownlightItem(item: { type: string; description: string }): boolean {
  return item.type === "light_fixture" && /\b(downlight|recessed)\b/i.test(item.description || "");
}

function deriveHardFail(materialAlteredItems: Item[]): boolean {
  const nonDownlightAlteredItems = materialAlteredItems.filter((r) => !isDownlightItem(r));
  return nonDownlightAlteredItems.length > 0;
}

let failures = 0;
function check(label: string, items: Item[], expectHardFail: boolean) {
  const hardFail = deriveHardFail(items);
  const pass = hardFail === expectHardFail;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: hardFail=${hardFail} (expected ${expectHardFail})`);
  if (!pass) failures++;
}

const downlightL1: Item = { id: "L1", type: "light_fixture", description: "A circular recessed ceiling downlight with a white trim, located on the left side of the ceiling.", materiality: "material", altered: true };
const downlightL2: Item = { id: "L2", type: "light_fixture", description: "A circular recessed ceiling downlight with a white trim, located towards the center-right of the ceiling.", materiality: "material", altered: true };
const fireplace: Item = { id: "F1", type: "fireplace", description: "A brick fireplace with a wooden mantel.", materiality: "material", altered: true };
const pendantLight: Item = { id: "L3", type: "light_fixture", description: "A modern pendant light hanging over the kitchen island.", materiality: "material", altered: true };

check("Real job_5add1f4f attempt1 case: both downlights altered, nothing else -> advisory only", [downlightL1, downlightL2], false);
check("Real job_5add1f4f attempt2 case: single downlight altered -> advisory only", [downlightL1], false);
check("Real job_f61d8dc1 attempt1 case: single downlight (AF3-style) altered -> advisory only", [downlightL1], false);
check("Downlight + genuine fireplace alteration -> still hard-fails, driven by the real issue", [downlightL1, fireplace], true);
check("Fireplace alone -> hard-fails as before (unaffected by this change)", [fireplace], true);
check("Non-downlight light fixture (pendant) alone -> still hard-fails (softening is downlight-specific, not all light fixtures)", [pendantLight], true);
check("No altered items -> hardFail derivation trivially false (upstream 'no material alteration' path handles this separately)", [], false);

console.log(`\n${failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
