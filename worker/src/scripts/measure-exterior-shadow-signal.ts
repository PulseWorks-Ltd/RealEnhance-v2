/**
 * Zero-cost verification of Fix B (worker/src/pipeline/stage1A.ts,
 * computeStage1AFactors) — the new exterior-only lumStdev-based local-shadow
 * signal that feeds into the `darkness` factor alongside the existing
 * mean-luminance signal.
 *
 * Calls the real, exported computeStage1AFactors directly (pure function,
 * no image I/O, no API calls) across a grid of synthetic (lumMean, lumStdev)
 * analyses for both interior and exterior, to confirm:
 *  - the new term is exactly 0 for interior inputs at every lumStdev
 *  - it's 0 for exterior when lumStdev is below the onset (evenly-lit exteriors
 *    unaffected)
 *  - it ramps smoothly and caps at STAGE1A_EXT_SHADOW_MAX_DARKNESS (0.28) once
 *    lumStdev clears onset+span
 *  - a genuinely dark exterior (mean-based darkness already near 1) is not
 *    pushed past darkness=1 by the additional term (clamped)
 *  - a bright, evenly-lit exterior (low lumStdev) that would otherwise get
 *    darkness=0 from the mean signal alone is unaffected (still 0)
 *  - a bright exterior with a hard local shadow (high lumStdev) now gets a
 *    non-zero darkness where it previously got exactly 0
 *
 * Usage: tsx src/scripts/measure-exterior-shadow-signal.ts
 */
import { computeStage1AFactors, type Stage1AAnalysis } from "../pipeline/stage1A";

function makeAnalysis(overrides: Partial<Stage1AAnalysis>): Stage1AAnalysis {
  return {
    lumMean: 180,
    lumStdev: 40,
    edgeDensity: 0.1,
    isExterior: true,
    isBlurry: false,
    sceneType: "exterior",
    ...overrides,
  };
}

type Case = {
  name: string;
  analysis: Stage1AAnalysis;
  check: (darkness: number) => boolean;
  describe: string;
};

const cases: Case[] = [
  {
    name: "interior_high_stdev_unaffected",
    analysis: makeAnalysis({ isExterior: false, sceneType: "interior", lumMean: 180, lumStdev: 90 }),
    // Interior must be driven purely by the pre-existing mean-based signal —
    // at lumMean=180 (>> onset 135) that's darknessFromMean=0 regardless of
    // how high lumStdev is, since the new term is gated on isExterior only.
    check: (d) => d === 0,
    describe: "interior ignores lumStdev entirely (new term gated on isExterior)",
  },
  {
    name: "exterior_bright_even_lighting_unaffected",
    analysis: makeAnalysis({ lumMean: 190, lumStdev: 25 }), // below onset (60)
    check: (d) => d === 0,
    describe: "bright, evenly-lit exterior (low stdev) stays at darkness=0, same as before Fix B",
  },
  {
    name: "exterior_bright_hard_shadow_now_nonzero",
    analysis: makeAnalysis({ lumMean: 190, lumStdev: 75 }), // above onset, below onset+span(90)
    check: (d) => d > 0 && d < 0.28,
    describe: "bright exterior with hard local shadow (high stdev) now gets partial uplift — previously exactly 0",
  },
  {
    name: "exterior_extreme_shadow_caps_at_max",
    analysis: makeAnalysis({ lumMean: 190, lumStdev: 200 }), // far past onset+span
    check: (d) => Math.abs(d - 0.28) < 1e-9,
    describe: "extreme stdev caps the added term at STAGE1A_EXT_SHADOW_MAX_DARKNESS (0.28), doesn't blow past it",
  },
  {
    name: "exterior_already_dark_not_pushed_past_1",
    analysis: makeAnalysis({ lumMean: 20, lumStdev: 200 }), // darknessFromMean already ~1, plus extreme stdev
    check: (d) => d === 1,
    describe: "already-dark exterior (mean-based darkness ~1) stays clamped at 1, not pushed over",
  },
  {
    name: "exterior_at_stdev_onset_boundary_is_zero",
    analysis: makeAnalysis({ lumMean: 190, lumStdev: 60 }), // exactly at onset
    check: (d) => d === 0,
    describe: "exactly at STAGE1A_EXT_SHADOW_STDEV_ONSET (60), added term is 0 (ramp hasn't started)",
  },
];

let anyFailure = false;
for (const c of cases) {
  const factors = computeStage1AFactors(c.analysis);
  const pass = c.check(factors.darkness);
  if (!pass) anyFailure = true;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${c.name.padEnd(42)} lumMean=${c.analysis.lumMean} lumStdev=${c.analysis.lumStdev} isExterior=${c.analysis.isExterior} -> darkness=${factors.darkness.toFixed(4)} gammaBoost=${factors.gammaBoost.toFixed(4)} contrastBoost=${factors.contrastBoost.toFixed(4)}\n         ${c.describe}`
  );
}

// Grid sweep, printed for visual sanity-checking of the ramp shape (not
// pass/fail — just makes the curve inspectable).
console.log("\nGrid sweep (exterior, lumMean=190 fixed, lumStdev swept):");
for (let stdev = 20; stdev <= 120; stdev += 10) {
  const factors = computeStage1AFactors(makeAnalysis({ lumMean: 190, lumStdev: stdev }));
  console.log(`  lumStdev=${String(stdev).padStart(3)}  darkness=${factors.darkness.toFixed(4)}`);
}

console.log(`\n${anyFailure ? "RESULT: one or more cases failed." : "RESULT: all cases passed."}`);
process.exit(anyFailure ? 1 : 0);
