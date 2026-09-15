/**
 * Zero-cost verification of the "Enhance Exterior Outlook" hallucination
 * check (worker/src/validators/stage1AExteriorHallucinationCheck.ts) — the
 * missing enforcement backstop for the enhanceExteriorSky checkbox: nothing
 * previously checked whether Gemini actually complied with the "don't
 * invent new exterior content" instruction when brightening the outlook
 * through a window.
 *
 * Exercises the real exported prompt builder, decision function, and flag
 * reader directly — no network call, no image files.
 *
 * Usage: tsx src/scripts/assert-exterior-hallucination-check.ts
 */
import {
  buildStage1AExteriorHallucinationPrompt,
  decideStage1AExteriorHallucination,
  stage1AExteriorHallucinationCheckBlocking,
} from "../validators/stage1AExteriorHallucinationCheck";

let anyFailure = false;
function check(name: string, pass: boolean, detail?: string) {
  if (!pass) anyFailure = true;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const prompt = buildStage1AExteriorHallucinationPrompt();

// 1. Must explicitly permit the two behaviours the user confirmed should
//    keep working: full sky replacement and vegetation colour boosting.
check("permits_sky_replacement", /overcast/i.test(prompt) && /blue/i.test(prompt) && /authorised/i.test(prompt));
check("permits_vegetation_colour", /vibrant/i.test(prompt) && /colour.*alone is authorised/i.test(prompt));
check("permits_visibility_recovery", /obscured by weather/i.test(prompt) || /recovering real detail/i.test(prompt));

// 2. Must still flag the actual risk categories named in the request.
const mustFlag = [/building/i, /fence/i, /retaining wall/i, /hill|ridge|mountain/i, /vehicle/i, /boat/i, /person/i];
for (const re of mustFlag) {
  check(`flags_category[${re}]`, re.test(prompt));
}
check("flags_vegetation_shape_change", /changed size, shape, position, or species/i.test(prompt));

// 3. JSON contract must be minimal and self-contained — no dependency on
//    geminiSemanticValidator.ts's legacy 7-key contract (which is what
//    silently downgrades hardFail for stage "1A" — see this module's header
//    comment for why that contract was deliberately avoided).
check("contract_has_hallucinationDetected", prompt.includes('"hallucinationDetected"'));
check("contract_has_reasons", prompt.includes('"reasons"'));
check("contract_has_confidence", prompt.includes('"confidence"'));
check("contract_excludes_legacy_hardFail_key", !prompt.includes('"hardFail"'));
check("contract_excludes_legacy_violationType_key", !prompt.includes('"violationType"'));

// 4. Decision function: threshold behavior.
check("decide_true_above_threshold", decideStage1AExteriorHallucination({ hallucinationDetected: true, confidence: 0.9 }) === true);
check("decide_false_below_threshold", decideStage1AExteriorHallucination({ hallucinationDetected: true, confidence: 0.5 }) === false);
check("decide_false_when_not_detected", decideStage1AExteriorHallucination({ hallucinationDetected: false, confidence: 0.99 }) === false);
check("decide_false_at_exact_default_threshold_minus_epsilon", decideStage1AExteriorHallucination({ hallucinationDetected: true, confidence: 0.749 }) === false);
check("decide_true_at_exact_default_threshold", decideStage1AExteriorHallucination({ hallucinationDetected: true, confidence: 0.75 }) === true);
check("decide_false_on_nan_confidence", decideStage1AExteriorHallucination({ hallucinationDetected: true, confidence: NaN }) === false);

// 5. Blocking flag: default off, only "true" (case/whitespace-insensitive) turns it on.
const savedEnv = process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING;
try {
  delete process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING;
  check("blocking_default_off", stage1AExteriorHallucinationCheckBlocking() === false);
  process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING = "0";
  check("blocking_off_on_zero", stage1AExteriorHallucinationCheckBlocking() === false);
  process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING = " TRUE ";
  check("blocking_on_case_and_whitespace_insensitive", stage1AExteriorHallucinationCheckBlocking() === true);
  process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING = "yes";
  check("blocking_off_on_non_exact_true", stage1AExteriorHallucinationCheckBlocking() === false);
} finally {
  if (savedEnv === undefined) delete process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING;
  else process.env.STAGE1A_EXTERIOR_HALLUCINATION_CHECK_BLOCKING = savedEnv;
}

console.log(`\n${anyFailure ? "RESULT: one or more checks failed." : "RESULT: all checks passed."}`);
process.exit(anyFailure ? 1 : 0);
