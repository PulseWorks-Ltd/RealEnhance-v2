/**
 * Zero-cost verification of determineLightingDecision (worker/src/ai/exteriorEnvironmentAnalyzer.ts) —
 * the pure decision function behind Fix A (widening shouldAnalyzeExteriorEnvironment
 * in worker.ts so it fires for every confidently-classified exterior photo,
 * not just ambiguous/low-confidence/override/pergola cases).
 *
 * This does not call the gate or any Gemini API — it exercises the decision
 * table directly across a matrix of realistic (scene, gemini) inputs to
 * confirm: interior scenes always no-op regardless of why the function was
 * called, and confidently-classified exteriors get a real environment-based
 * decision instead of silently staying null.
 *
 * Usage: tsx src/scripts/measure-exterior-lighting-decision.ts
 */
import {
  determineLightingDecision,
  type SceneDetectionResult,
  type UserOverride,
  type GeminiEnvironmentResult,
} from "../ai/exteriorEnvironmentAnalyzer";

type Case = {
  name: string;
  scene: SceneDetectionResult;
  userOverride?: UserOverride;
  gemini?: GeminiEnvironmentResult;
  expectShouldRelight: boolean;
};

const cases: Case[] = [
  {
    name: "confident_interior_no_override",
    scene: { sceneType: "interior", confidence: 0.95, needsConfirm: false },
    expectShouldRelight: false,
  },
  {
    name: "confident_exterior_overcast_gemini",
    scene: { sceneType: "exterior", confidence: 0.95, needsConfirm: false },
    gemini: { environment: "exterior_overcast", confidence: 0.9 },
    expectShouldRelight: true,
  },
  {
    name: "confident_exterior_sunny_gemini",
    scene: { sceneType: "exterior", confidence: 0.95, needsConfirm: false },
    gemini: { environment: "exterior_sunny", confidence: 0.9 },
    expectShouldRelight: true,
  },
  {
    name: "confident_exterior_no_gemini_result_falls_back_to_heuristic",
    scene: { sceneType: "exterior", confidence: 0.95, needsConfirm: false },
    expectShouldRelight: true,
  },
  {
    name: "ambiguous_exterior_low_confidence_no_gemini",
    scene: { sceneType: "exterior", confidence: 0.4, needsConfirm: true },
    // Low confidence + no gemini read -> "uncertain" environment, which
    // still relights but conservatively (low strength, no sky replace) —
    // not a hard no-op.
    expectShouldRelight: true,
  },
  {
    name: "user_override_interior_to_exterior",
    scene: { sceneType: "interior", confidence: 0.9, needsConfirm: false },
    userOverride: { sceneOverride: "exterior" },
    expectShouldRelight: true, // conservative "interior_to_exterior" mode
  },
];

let anyFailure = false;
for (const c of cases) {
  const decision = determineLightingDecision({ scene: c.scene, userOverride: c.userOverride, gemini: c.gemini });
  const pass = decision.shouldRelight === c.expectShouldRelight;
  if (!pass) anyFailure = true;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${c.name.padEnd(45)} shouldRelight=${decision.shouldRelight} (expected ${c.expectShouldRelight}) shouldReplaceSky=${decision.shouldReplaceSky} profile=${decision.profile} strength=${decision.strength.toFixed(2)} reason="${decision.reason}"`
  );
}

console.log(`\n${anyFailure ? "RESULT: one or more cases failed." : "RESULT: all cases passed."}`);
process.exit(anyFailure ? 1 : 0);
