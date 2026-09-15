/**
 * Verifies the dusk/dawn exterior prompt refactor (worker/src/ai/prompts.nzRealEstate.ts):
 *  - the daylight exterior prompt (duskMode=false, the default) is byte-identical
 *    to its pre-refactor snapshot, proving the shared-section extraction changed
 *    nothing for existing jobs
 *  - the dusk exterior prompt contains the shared structural guardrails verbatim
 *    and the required opening-illumination carve-out, and does NOT contain the
 *    daylight-only language that would contradict a twilight look
 *  - duskMode has no effect on the interior dispatch branch
 *
 * Usage:
 *   tsx src/scripts/assert-dusk-prompt-contract.ts --snapshot   (write/refresh the baseline)
 *   tsx src/scripts/assert-dusk-prompt-contract.ts              (verify against it)
 */
import fs from "node:fs";
import path from "node:path";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";

const SNAPSHOT_PATH = path.resolve(__dirname, "./__fixtures__/stage1a-exterior-daylight-prompt.snapshot.txt");

function ensureFixturesDir() {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
}

const writeSnapshot = process.argv.includes("--snapshot");

const daylightPrompt = buildStage1APromptNZStyle("room", "exterior");

if (writeSnapshot) {
  ensureFixturesDir();
  fs.writeFileSync(SNAPSHOT_PATH, daylightPrompt, "utf8");
  console.log(`Snapshot written: ${SNAPSHOT_PATH} (${daylightPrompt.length} chars)`);
  process.exit(0);
}

let anyFailure = false;

function check(name: string, pass: boolean, detail?: string) {
  if (!pass) anyFailure = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// 1. Daylight output must be byte-identical to the pre-refactor snapshot.
if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.log(`No snapshot found at ${SNAPSHOT_PATH} — run with --snapshot first.`);
  process.exit(1);
}
const snapshot = fs.readFileSync(SNAPSHOT_PATH, "utf8");
check("daylight_prompt_byte_identical_to_snapshot", daylightPrompt === snapshot,
  daylightPrompt === snapshot ? "" : `lengths: current=${daylightPrompt.length} snapshot=${snapshot.length}`);

// 2. duskMode=true vs false must differ for exterior.
const duskPrompt = buildStage1APromptNZStyle("room", "exterior", true);
check("dusk_prompt_differs_from_daylight", duskPrompt !== daylightPrompt);

// 3. Shared guardrail sections must survive verbatim into the dusk prompt.
const sharedMustContain = [
  "STRICT GEOMETRIC & SITE LOCK (NON-NEGOTIABLE)",
  "SHADOW DEPTH & MATERIAL RECOVERY:",
  "PREMIUM GLAZING READABILITY:",
  "HARDSCAPE PRESERVATION:",
  "Fix the light — NOT the property.",
  "It is an improvement of the PHOTO ONLY.",
  "Return ONLY the enhanced image.",
];
for (const needle of sharedMustContain) {
  check(`dusk_prompt_contains_shared[${needle.slice(0, 30)}...]`, duskPrompt.includes(needle));
}

// 4. The opening-illumination carve-out must be present (this is what stops the
//    geometric lock's "no opening-like structure" bullet from fighting the
//    window-glow instruction).
check(
  "dusk_prompt_contains_opening_illumination_carveout",
  /illuminat/i.test(duskPrompt) && /already exists? in the input/i.test(duskPrompt)
);

// 5. Daylight-only language must NOT leak into the dusk prompt.
const daylightOnlyMustBeAbsent = [
  "Clear Day",
  "New Zealand Summer Blue",
  "Neutral daylight balanced",
  "PARAMETER ADJUSTMENT, not scene generation",
];
for (const needle of daylightOnlyMustBeAbsent) {
  check(`dusk_prompt_excludes_daylight_only[${needle}]`, !duskPrompt.includes(needle));
}

// 6. Twilight-specific directives must be present.
const duskMustContain = [/blue|indigo|navy|violet/i, /window/i, /path|landscape/i, /light/i];
for (const re of duskMustContain) {
  check(`dusk_prompt_contains_directive[${re}]`, re.test(duskPrompt));
}

// 7. duskMode must not affect the interior branch at all.
const interiorDefault = buildStage1APromptNZStyle("room", "interior");
const interiorWithDusk = buildStage1APromptNZStyle("room", "interior", true);
check("dusk_mode_has_no_effect_on_interior", interiorDefault === interiorWithDusk);

console.log(`\n${anyFailure ? "RESULT: one or more checks failed." : "RESULT: all checks passed."}`);
process.exit(anyFailure ? 1 : 0);
