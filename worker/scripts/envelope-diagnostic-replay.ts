/**
 * Envelope Validator Diagnostic Replay
 * 
 * Replays all production jobs with local Stage 1A/Stage 2 image pairs
 * Full decision path tracing: baseline → descriptors → geometric → semantic → merge → result
 * 
 * This is a DIAGNOSTIC PASS ONLY - no code modifications
 */

import * as fs from "fs/promises";
import * as path from "path";
import { config } from "dotenv";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator.js";
import { runEnvelopeValidator, buildEnvelopeAuthoritativeBaselineDescription } from "../src/validators/envelopeValidator.js";
import type { PipelineContext } from "../src/types/pipelineContext.js";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "../.env") });

// Define all test jobs with expected outcomes
const TEST_JOBS = [
  {
    label: "job_c11a8e7c",
    jobId: "job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023",
    imageId: "img_aced9a07-fccd-4e24-b0ee-139d5bbcde1d",
    expectedStatus: "fail",
    baselineFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9.jpg",
    stagedFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9-stage2.jpg",
    notes: "Expected FAIL: Envelope anomaly detection",
  },
  {
    label: "job_bb029607",
    jobId: "job_bb029607-dcd8-4614-997c-406d2ed33142",
    imageId: "img_e75a5903-34d3-42a2-b93f-b29314a5138d",
    expectedStatus: "fail",
    baselineFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg",
    stagedFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-stage2.jpg",
    notes: "Expected FAIL: Envelope anomaly detection",
  },
  {
    label: "job_4a87f43b",
    jobId: "job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10",
    imageId: "img_a4f41fe0-ecc8-4bef-9a9b-0715d4e3963c",
    expectedStatus: "pass",
    baselineFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or.jpg",
    stagedFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or-stage2.jpg",
    notes: "Expected PASS: No envelope change",
  },
  {
    label: "job_dfbe98aa",
    jobId: "job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1",
    imageId: "img_0c2e8e0d-2e87-4ae2-8b31-9c8c5e8c6f4a",
    expectedStatus: "pass",
    baselineFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap.jpg",
    stagedFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap-stage2.jpg",
    notes: "Expected PASS: No envelope modification",
  },
  {
    label: "job_81e485e7",
    jobId: "job_81e485e7-e3ce-4283-9f5e-e4f931d784bc",
    imageId: "img_228b053c-a06a-4f01-a3bf-123b2deaf8eb",
    expectedStatus: "pass",
    baselineFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2.jpg",
    stagedFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2-stage2.jpg",
    notes: "Expected PASS: Same room envelope",
  },
];

interface DecisionPathTrace {
  stage: string;
  phase: string;
  findings: Record<string, any>;
}

interface DiagnosticResult {
  label: string;
  jobId: string;
  expectedStatus: string;
  baselineFile: string;
  stagedFile: string;
  
  // Baseline extraction
  baseline: {
    openingsCount: number;
    fixturesCount: number;
    wallDescriptorsCount: number;
    wallDescriptors: Array<{ wallIndex: number; visibility: string; description: string }>;
    graphConfidence: number;
    baselineMethod: string;
  };

  // Interpolated prompt
  fullyInterpolatedPrompt: string;

  // Geometric analysis
  geometricMetrics: {
    verticalEdgeLoss: boolean;
    cornerPersistenceFailure: boolean;
    worstRetention: string;
    junctionCount: number;
    beforeEdges: number;
    afterEdges: number;
    deterministic: {
      verticalEdgeDeltaTriggered: boolean;
      reason: string;
    };
  };

  // Gemini semantic response
  geminiResponse: {
    status: string;
    reason: string;
    confidence: number;
    issueType: string;
    advisorySignals: string[];
  };

  // Decision merge
  decisionMerge: {
    geometricSignal: string;
    semanticSignal: string;
    hardFail: boolean;
    mergedStatus: string;
    mergeLogic: string;
  };

  // Final result
  actualStatus: string;
  correct: boolean;
  confidence: number;
  issueType: string;
  hardFail: boolean;
  advisorySignals: string[];

  // Diagnostic trace
  decisionPath: DecisionPathTrace[];
}

function createMockContext(jobId: string): PipelineContext {
  return {
    jobId,
    userId: "diagnostic_user",
    imageId: uuidv4(),
    stage: "envelope_diagnostic",
    attempt: 1,
    telemetry: {
      startTime: Date.now(),
    },
  } as any;
}

async function runDiagnosticReplay() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║      ENVELOPE VALIDATOR DIAGNOSTIC REPLAY - FULL TRACE     ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  const TEST_IMAGE_DIR = "/workspaces/RealEnhance-v2/Test Images/Envelope Test Images";
  const results: DiagnosticResult[] = [];

  for (const testJob of TEST_JOBS) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`📋 JOB: ${testJob.label}`);
    console.log(`   Expected: ${testJob.expectedStatus.toUpperCase()}`);
    console.log(`   ${testJob.notes}`);
    console.log(`${"═".repeat(70)}\n`);

    try {
      const ctx = createMockContext(testJob.jobId);
      const baselinePath = path.join(TEST_IMAGE_DIR, testJob.baselineFile);
      const stagedPath = path.join(TEST_IMAGE_DIR, testJob.stagedFile);

      // Verify files exist
      await fs.access(baselinePath);
      await fs.access(stagedPath);
      console.log(`   ✓ Baseline image: ${testJob.baselineFile}`);
      console.log(`   ✓ Staged image:   ${testJob.stagedFile}\n`);

      // STAGE 1: Extract baseline from baseline image
      console.log(`   [STAGE 1/4] Extracting baseline structural features...`);
      const baseline = await extractStructuralBaseline(baselinePath, ctx);

      if (!baseline) {
        throw new Error("Failed to extract baseline");
      }

      const wallDescriptors = baseline.wallDescriptors || [];
      console.log(`   ✓ Openings: ${baseline.openings.length}`);
      console.log(`   ✓ Fixtures: ${baseline.anchorFixtures?.length || 0}`);
      console.log(`   ✓ Wall descriptors: ${wallDescriptors.length}`);
      
      if (wallDescriptors.length > 0) {
        console.log(`   Wall descriptions:`);
        wallDescriptors.forEach((wd, i) => {
          console.log(`     - Wall ${wd.wallIndex} (${wd.visibility}): ${wd.description}`);
        });
      }
      console.log();

      // STAGE 2: Build interpolated prompt
      console.log(`   [STAGE 2/4] Building envelope validator prompt...`);
      const interpolatedPrompt = buildEnvelopeAuthoritativeBaselineDescription(baseline);
      console.log(`   ✓ Prompt length: ${interpolatedPrompt.length} characters\n`);

      // STAGE 3: Run envelope validator (full production flow)
      console.log(`   [STAGE 3/4] Running envelope validator (production flow)...`);
      const validationResult = await runEnvelopeValidator(
        baselinePath,
        stagedPath,
        {
          jobId: testJob.jobId,
          imageId: testJob.imageId,
          attempt: 1,
          baseline,
        }
      );

      const actualStatus = validationResult.status || "unknown";
      console.log(`   ✓ Validator decision: ${actualStatus.toUpperCase()}`);
      console.log(`   ✓ Confidence: ${validationResult.confidence}`);
      console.log(`   ✓ Hard fail: ${validationResult.hardFail}`);
      console.log(`   ✓ Issue type: ${validationResult.issueType || "none"}`);
      
      if (validationResult.advisorySignals && validationResult.advisorySignals.length > 0) {
        console.log(`   ✓ Advisory signals:`);
        validationResult.advisorySignals.forEach((sig) => {
          console.log(`     - ${sig}`);
        });
      }
      console.log();

      // STAGE 4: Compile diagnostic result
      console.log(`   [STAGE 4/4] Compiling diagnostic trace...\n`);

      const correct = actualStatus === testJob.expectedStatus;
      const resultIcon = correct ? "✅" : "❌";

      console.log(`   ${resultIcon} RESULT: Expected ${testJob.expectedStatus.toUpperCase()}, got ${actualStatus.toUpperCase()}`);
      console.log(`   ${correct ? "✓ CORRECT" : "✗ INCORRECT"}\n`);

      const diagnosticResult: DiagnosticResult = {
        label: testJob.label,
        jobId: testJob.jobId,
        expectedStatus: testJob.expectedStatus,
        baselineFile: testJob.baselineFile,
        stagedFile: testJob.stagedFile,

        baseline: {
          openingsCount: baseline.openings.length,
          fixturesCount: baseline.anchorFixtures?.length || 0,
          wallDescriptorsCount: wallDescriptors.length,
          wallDescriptors: wallDescriptors.map((wd) => ({
            wallIndex: wd.wallIndex,
            visibility: wd.visibility,
            description: wd.description,
          })),
          graphConfidence: (validationResult as any).graphConfidence || 0,
          baselineMethod: "graph_consensus",
        },

        fullyInterpolatedPrompt: interpolatedPrompt,

        geometricMetrics: {
          verticalEdgeLoss: (validationResult as any).verticalEdgeLoss || false,
          cornerPersistenceFailure: (validationResult as any).cornerPersistenceFailure || false,
          worstRetention: (validationResult as any).worstRetention || "N/A",
          junctionCount: (validationResult as any).junctionCount || 0,
          beforeEdges: (validationResult as any).beforeEdges || 0,
          afterEdges: (validationResult as any).afterEdges || 0,
          deterministic: {
            verticalEdgeDeltaTriggered: (validationResult as any).verticalEdgeDeltaTriggered || false,
            reason: (validationResult as any).envelopeDetectionReason || "N/A",
          },
        },

        geminiResponse: {
          status: validationResult.status || "unknown",
          reason: (validationResult as any).reason || "",
          confidence: validationResult.confidence || 0,
          issueType: validationResult.issueType || "none",
          advisorySignals: validationResult.advisorySignals || [],
        },

        decisionMerge: {
          geometricSignal: (validationResult as any).verticalEdgeLoss ? "GEOMETRIC_FAILURE" : "GEOMETRIC_OK",
          semanticSignal: validationResult.status === "pass" ? "SEMANTIC_PASS" : "SEMANTIC_FAIL",
          hardFail: validationResult.hardFail || false,
          mergedStatus: validationResult.status || "unknown",
          mergeLogic: "hardFail overrides all; else use semantic decision",
        },

        actualStatus,
        correct,
        confidence: validationResult.confidence || 0,
        issueType: validationResult.issueType || "none",
        hardFail: validationResult.hardFail || false,
        advisorySignals: validationResult.advisorySignals || [],

        decisionPath: [
          {
            stage: "1_baseline_extraction",
            phase: "graph_consensus",
            findings: {
              openings: baseline.openings.length,
              wallDescriptors: wallDescriptors.length,
              graphConfidence: (validationResult as any).graphConfidence,
            },
          },
          {
            stage: "2_geometric_analysis",
            phase: "vertical_edge_delta",
            findings: {
              verticalEdgeLoss: (validationResult as any).verticalEdgeLoss,
              cornerPersistenceFailure: (validationResult as any).cornerPersistenceFailure,
              worstRetention: (validationResult as any).worstRetention,
            },
          },
          {
            stage: "3_semantic_review",
            phase: "gemini_flash",
            findings: {
              status: validationResult.status,
              reason: (validationResult as any).reason,
            },
          },
          {
            stage: "4_decision_merge",
            phase: "final_decision",
            findings: {
              hardFail: validationResult.hardFail,
              finalStatus: validationResult.status,
            },
          },
        ],
      };

      results.push(diagnosticResult);
    } catch (error: any) {
      console.error(`   ❌ ERROR: ${error.message}\n`);
      results.push({
        label: testJob.label,
        jobId: testJob.jobId,
        expectedStatus: testJob.expectedStatus,
        baselineFile: testJob.baselineFile,
        stagedFile: testJob.stagedFile,
        baseline: { openingsCount: 0, fixturesCount: 0, wallDescriptorsCount: 0, wallDescriptors: [], graphConfidence: 0, baselineMethod: "error" },
        fullyInterpolatedPrompt: "",
        geometricMetrics: { verticalEdgeLoss: false, cornerPersistenceFailure: false, worstRetention: "N/A", junctionCount: 0, beforeEdges: 0, afterEdges: 0, deterministic: { verticalEdgeDeltaTriggered: false, reason: error.message } },
        geminiResponse: { status: "error", reason: error.message, confidence: 0, issueType: "error", advisorySignals: [] },
        decisionMerge: { geometricSignal: "ERROR", semanticSignal: "ERROR", hardFail: false, mergedStatus: "error", mergeLogic: "ERROR" },
        actualStatus: "error",
        correct: false,
        confidence: 0,
        issueType: "error",
        hardFail: false,
        advisorySignals: [],
        decisionPath: [],
      });
    }
  }

  // Generate summary
  console.log(`\n${"═".repeat(70)}`);
  console.log(`DIAGNOSTIC REPLAY SUMMARY`);
  console.log(`${"═".repeat(70)}\n`);

  const correctCount = results.filter((r) => r.correct).length;
  const incorrectCount = results.filter((r) => !r.correct && r.actualStatus !== "error").length;
  const errorCount = results.filter((r) => r.actualStatus === "error").length;

  console.log(`Total jobs:    ${results.length}`);
  console.log(`✓ Correct:     ${correctCount}`);
  console.log(`✗ Incorrect:   ${incorrectCount}`);
  console.log(`⚠ Errors:      ${errorCount}\n`);

  // Summary table
  console.log(`${"─".repeat(90)}`);
  console.log(`| Job ID          | Expected | Actual   | Correct | HardFail | Issue Type              |`);
  console.log(`${"─".repeat(90)}`);

  for (const result of results) {
    const correctIcon = result.correct ? "✓" : "✗";
    const jobLabel = result.label.padEnd(15);
    const expected = result.expectedStatus.padEnd(8);
    const actual = result.actualStatus.padEnd(8);
    const hardFail = (result.hardFail ? "YES" : "NO").padEnd(8);
    const issueType = (result.issueType || "none").padEnd(23);

    console.log(
      `| ${jobLabel} | ${expected} | ${actual} | ${correctIcon}       | ${hardFail} | ${issueType} |`
    );
  }

  console.log(`${"─".repeat(90)}\n`);

  // Save detailed report
  const reportDir = path.resolve(path.join(__dirname, "../reports"));
  const reportPath = path.join(reportDir, "envelope-diagnostic-full-trace.json");

  await fs.mkdir(reportDir, { recursive: true });

  const report = {
    title: "Envelope Validator Diagnostic Replay - Full Decision Path Trace",
    executedAt: new Date().toISOString(),
    summary: {
      totalJobs: results.length,
      correctResults: correctCount,
      incorrectResults: incorrectCount,
      errorResults: errorCount,
      accuracyRate: `${Math.round((correctCount / results.length) * 100)}%`,
      expectedFails: results.filter((r) => r.expectedStatus === "fail").length,
      actualFails: results.filter((r) => r.actualStatus === "fail").length,
      expectedPasses: results.filter((r) => r.expectedStatus === "pass").length,
      actualPasses: results.filter((r) => r.actualStatus === "pass").length,
    },
    results,
    decisionPathAnalysis: {
      description: "For each result, trace the decision path from baseline extraction through final merge",
      incorrectResults: results
        .filter((r) => !r.correct && r.actualStatus !== "error")
        .map((r) => ({
          jobId: r.label,
          expectedStatus: r.expectedStatus,
          actualStatus: r.actualStatus,
          decisionPath: r.decisionPath,
          geometricFindings: r.geometricMetrics.deterministic,
          semanticFindings: r.geminiResponse,
          mergeLogic: r.decisionMerge,
          analysisNote:
            r.expectedStatus === "fail" && r.actualStatus === "pass"
              ? "Geometric failure detected but semantic decision overrode to PASS"
              : r.expectedStatus === "pass" && r.actualStatus === "fail"
              ? "No geometric failure but semantic decision went to FAIL"
              : "Status mismatch",
        })),
    },
  };

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`📊 Full diagnostic report saved to:`);
  console.log(`   ${reportPath}\n`);

  // Print any incorrect results with full analysis
  const incorrectResults = results.filter((r) => !r.correct && r.actualStatus !== "error");
  if (incorrectResults.length > 0) {
    console.log(`\n${"═".repeat(90)}`);
    console.log(`DETAILED ANALYSIS OF INCORRECT RESULTS`);
    console.log(`${"═".repeat(90)}\n`);

    for (const result of incorrectResults) {
      console.log(`📌 ${result.label} - Expected: ${result.expectedStatus.toUpperCase()}, Got: ${result.actualStatus.toUpperCase()}\n`);

      console.log(`   BASELINE EXTRACTION:`);
      console.log(`   • Openings: ${result.baseline.openingsCount}`);
      console.log(`   • Wall descriptors: ${result.baseline.wallDescriptorsCount}`);
      if (result.baseline.wallDescriptors.length > 0) {
        result.baseline.wallDescriptors.forEach((wd) => {
          console.log(`     - Wall ${wd.wallIndex} (${wd.visibility}): ${wd.description}`);
        });
      }

      console.log(`\n   GEOMETRIC ANALYSIS:`);
      console.log(`   • Vertical edge loss: ${result.geometricMetrics.verticalEdgeLoss}`);
      console.log(`   • Corner persistence failure: ${result.geometricMetrics.cornerPersistenceFailure}`);
      console.log(`   • Worst retention: ${result.geometricMetrics.worstRetention}`);
      console.log(`   • Junctions affected: ${result.geometricMetrics.junctionCount}`);
      console.log(`   • Edge count delta: ${result.geometricMetrics.beforeEdges} → ${result.geometricMetrics.afterEdges}`);

      console.log(`\n   SEMANTIC REVIEW (GEMINI):`);
      console.log(`   • Decision: ${result.geminiResponse.status.toUpperCase()}`);
      console.log(`   • Reason: ${result.geminiResponse.reason}`);
      console.log(`   • Confidence: ${result.geminiResponse.confidence}`);
      console.log(`   • Issue type: ${result.geminiResponse.issueType}`);
      if (result.geminiResponse.advisorySignals.length > 0) {
        console.log(`   • Advisory signals: ${result.geminiResponse.advisorySignals.join(", ")}`);
      }

      console.log(`\n   DECISION MERGE:`);
      console.log(`   • Geometric signal: ${result.decisionMerge.geometricSignal}`);
      console.log(`   • Semantic signal: ${result.decisionMerge.semanticSignal}`);
      console.log(`   • Hard fail flag: ${result.decisionMerge.hardFail}`);
      console.log(`   • Merge logic: ${result.decisionMerge.mergeLogic}`);
      console.log(`   • Final merged status: ${result.decisionMerge.mergedStatus}\n`);

      console.log(`   ROOT CAUSE ANALYSIS:`);
      if (result.expectedStatus === "fail" && result.actualStatus === "pass") {
        console.log(`   → Geometric failure was detected (${result.geometricMetrics.cornerPersistenceFailure ? "corner persistence failure" : "vertical edge loss"})`);
        console.log(`   → But Gemini semantic review returned PASS`);
        console.log(`   → Hard fail flag was: ${result.hardFail}`);
        console.log(`   → DIAGNOSIS: Semantic reasoning may not be weighted heavily enough vs. geometric evidence`);
      } else if (result.expectedStatus === "pass" && result.actualStatus === "fail") {
        console.log(`   → No significant geometric failure (${result.geometricMetrics.cornerPersistenceFailure ? "though corner persistence noted" : "clean geometry"})`);
        console.log(`   → But Gemini semantic review returned FAIL`);
        console.log(`   → DIAGNOSIS: Semantic reasoning detected an architectural change that geometry didn't catch`);
      }
      console.log();
    }
  }

  console.log(`\n✅ Diagnostic replay complete`);
}

// Run the replay
runDiagnosticReplay().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
