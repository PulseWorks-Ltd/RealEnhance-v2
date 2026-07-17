import * as path from "path";
import { config } from "dotenv";
import { runEnvelopeValidator } from "../src/validators/envelopeValidator";
import { buildStructuredIssueContext, runUnifiedValidation } from "../src/validators/runValidation";

config({ path: path.join(process.cwd(), ".env") });

// Real images pulled from the debug-attempts S3 bucket for job_f6940e0e-7aec-45ba-88a9-aaff8dc4bef0
// (the mantel/corbel job from logs.1784248028443.log). Confirms end-to-end, with real Gemini
// calls, that the envelope VED corner-persistence signal now reaches structuredIssues AND that
// Unified's own semantic reasoning actually references it — not just that the plumbing exists.
const BASELINE_PATH = "/tmp/claude-1000/-workspaces-RealEnhance-v2/51f1677b-7a08-46c5-acb8-5a59d2e8a4ad/scratchpad/replay/job_f6940e0e_1A.jpg";
const STAGED_PATH = "/tmp/claude-1000/-workspaces-RealEnhance-v2/51f1677b-7a08-46c5-acb8-5a59d2e8a4ad/scratchpad/replay/job_f6940e0e_stage2.webp";

async function main() {
  console.log("=".repeat(80));
  console.log("STEP 1: runEnvelopeValidator (real Gemini quick-check + real deterministic VED)");
  console.log("=".repeat(80));

  const envelopeResult = await runEnvelopeValidator(BASELINE_PATH, STAGED_PATH, {
    jobId: "replay_mantel_verification",
    imageId: "job_f6940e0e_mantel",
    attempt: 1,
  });

  console.log("\nenvelopeResult.status:", envelopeResult.status);
  console.log("envelopeResult.hardFail:", envelopeResult.hardFail);
  console.log("envelopeResult.reason:", envelopeResult.reason);
  console.log("envelopeResult.advisorySignals:", envelopeResult.advisorySignals);
  console.log("envelopeResult.verticalEdgeDelta:", envelopeResult.verticalEdgeDelta ? {
    cornerPersistenceFailure: envelopeResult.verticalEdgeDelta.cornerPersistenceFailure,
    verticalEdgeLossDetected: envelopeResult.verticalEdgeDelta.verticalEdgeLossDetected,
    worstRetention: envelopeResult.verticalEdgeDelta.worstRetention,
    junctionCount: envelopeResult.verticalEdgeDelta.junctions.length,
  } : undefined);
  console.log("envelopeResult.structuredIssues:", JSON.stringify(envelopeResult.structuredIssues, null, 2));

  if (!envelopeResult.structuredIssues || envelopeResult.structuredIssues.length === 0) {
    console.log("\n❌ FAIL: structuredIssues is empty — VED signal did not propagate. Nothing to inject into Unified.");
    if (!envelopeResult.verticalEdgeDelta?.cornerPersistenceFailure && !envelopeResult.verticalEdgeDelta?.verticalEdgeLossDetected) {
      console.log("   (Note: VED itself did not fire on this image pair — this run cannot exercise the fix. See raw VED result above.)");
    }
    process.exit(1);
  }

  console.log("\n" + "=".repeat(80));
  console.log("STEP 2: buildStructuredIssueContext (what Stage 2 actually injects into the adjudicator prompt)");
  console.log("=".repeat(80));

  const advisoryContext = buildStructuredIssueContext(envelopeResult.structuredIssues);
  console.log(JSON.stringify(advisoryContext, null, 2));

  if (advisoryContext.length === 0) {
    console.log("\n❌ FAIL: buildStructuredIssueContext produced no advisory text from the structuredIssues.");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(80));
  console.log("STEP 3: runUnifiedValidation (real Stage 2 pipeline, real Gemini adjudication call)");
  console.log("=".repeat(80));

  const unifiedResult = await runUnifiedValidation({
    originalPath: BASELINE_PATH,
    enhancedPath: STAGED_PATH,
    stage: "2",
    sceneType: "interior",
    jobId: "replay_mantel_verification",
    imageId: "job_f6940e0e_mantel",
    specialistStructuredIssues: envelopeResult.structuredIssues,
  });

  console.log("\nunifiedResult.passed:", unifiedResult.passed);
  console.log("unifiedResult.hardFail:", unifiedResult.hardFail);
  console.log("unifiedResult.score:", unifiedResult.score);
  console.log("unifiedResult.reasons:", unifiedResult.reasons);
  console.log("unifiedResult.raw.geminiSemantic:", JSON.stringify(unifiedResult.raw?.geminiSemantic, null, 2));

  console.log("\n" + "=".repeat(80));
  console.log("VERDICT: check the [STAGE2_ADVISORY_INJECTION] and [UNIFIED_ADJUDICATION] log blocks above");
  console.log("for whether Gemini's questionResults/reasoning actually reference the wall/envelope/mantel area.");
  console.log("=".repeat(80));
}

main().catch((err) => {
  console.error("REPLAY_FAILED:", err);
  process.exit(1);
});
