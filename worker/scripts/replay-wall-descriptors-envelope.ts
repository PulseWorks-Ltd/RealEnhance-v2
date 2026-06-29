import * as fs from "fs";
import * as path from "path";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator";
import { runEnvelopeValidator, buildEnvelopeAuthoritativeBaselineDescription } from "../src/validators/envelopeValidator";

const REPLAY_CASES = [
  // Expected FAIL
  { jobId: "job_c11a8e7c", label: "anomaly_envelope_c11a8e7c", expectedStatus: "fail" },
  { jobId: "job_bb029607", label: "anomaly_envelope_bb029607", expectedStatus: "fail" },
  // Expected PASS
  { jobId: "job_4a87f43b", label: "normal_envelope_4a87f43b", expectedStatus: "pass" },
  { jobId: "job_dfbe98aa", label: "normal_envelope_dfbe98aa", expectedStatus: "pass" },
  { jobId: "job_81e485e7", label: "normal_envelope_81e485e7", expectedStatus: "pass" },
];

interface ReplayResult {
  label: string;
  jobId: string;
  expectedStatus: string;
  input: {
    baselineUrl: string;
    stagedUrl: string;
  };
  baselineSummary: {
    cameraOrientation?: string;
    openingsCount: number;
    anchorFixturesCount: number;
    wallDescriptorsCount: number;
  };
  wallDescriptors: Array<{ wallIndex: number; visibility: string; description: string }>;
  fullyInterpolatedPrompt: string;
  semanticReasoning: string;
  decision: {
    status: string;
    confidence: number;
    issueType: string;
    hardFail: boolean;
    advisory: boolean;
    advisorySignals?: string[];
  };
  actualResult: string;
  correct: boolean;
  notes: string;
}

async function replayCase(caseSpec: { jobId: string; label: string; expectedStatus: string }): Promise<ReplayResult> {
  const jobId = caseSpec.jobId;
  const label = caseSpec.label;
  const expectedStatus = caseSpec.expectedStatus;

  // Construct S3 URLs based on job ID pattern
  const baselinePath1 = `https://realenhance-prod-public.s3.us-east-1.amazonaws.com/audit/baseline/${jobId}/path1.jpg`;
  const stagedPath2 = `https://realenhance-prod-public.s3.us-east-1.amazonaws.com/audit/staged/${jobId}/path2.jpg`;

  console.log(`\n[REPLAY] ${label} (${jobId})`);
  console.log(`  Expected: ${expectedStatus}`);

  try {
    console.log(`  Extracting structural baseline with wall descriptors...`);
    const baseline = await extractStructuralBaseline(baselinePath1, {
      jobId,
      imageId: "baseline_path1",
      attempt: 1,
    });

    console.log(
      `  Baseline extracted: ${baseline.openings.length} openings, ${baseline.anchorFixtures?.length ?? 0} fixtures, ${baseline.wallDescriptors?.length ?? 0} wall descriptors`
    );

    // Build envelope validator description with wall descriptors
    const baselineDescription = buildEnvelopeAuthoritativeBaselineDescription(baseline);

    // Run envelope validator
    console.log(`  Running envelope validator...`);
    const validationResult = await runEnvelopeValidator(baselinePath1, stagedPath2, {
      jobId,
      imageId: "staged_path2",
      attempt: 1,
      baseline,
    });

    const actualStatus = validationResult.status;
    const correct = actualStatus === expectedStatus;

    const result: ReplayResult = {
      label,
      jobId,
      expectedStatus,
      input: {
        baselineUrl: baselinePath1,
        stagedUrl: stagedPath2,
      },
      baselineSummary: {
        cameraOrientation: baseline.cameraOrientation,
        openingsCount: baseline.openings.length,
        anchorFixturesCount: baseline.anchorFixtures?.length ?? 0,
        wallDescriptorsCount: baseline.wallDescriptors?.length ?? 0,
      },
      wallDescriptors:
        baseline.wallDescriptors?.map((wd) => ({
          wallIndex: wd.wallIndex,
          visibility: wd.visibility,
          description: wd.description,
        })) ?? [],
      fullyInterpolatedPrompt: baselineDescription,
      semanticReasoning: validationResult.reason || "",
      decision: {
        status: actualStatus,
        confidence: validationResult.confidence || 0,
        issueType: validationResult.issueType || "unknown",
        hardFail: validationResult.hardFail || false,
        advisory: validationResult.advisory || false,
        advisorySignals: validationResult.advisorySignals,
      },
      actualResult: actualStatus,
      correct,
      notes: correct ? "✓ Result matches expectation" : `✗ Expected ${expectedStatus}, got ${actualStatus}`,
    };

    console.log(`  Result: ${result.actualResult} (${result.correct ? "✓ CORRECT" : "✗ MISMATCH"})`);
    console.log(`  Confidence: ${validationResult.confidence}`);
    console.log(`  Wall descriptors extracted: ${result.wallDescriptors.length}`);

    return result;
  } catch (err) {
    console.error(`  ERROR: ${err}`);
    throw err;
  }
}

async function main() {
  console.log("=".repeat(80));
  console.log("ENVELOPE VALIDATOR - WALL DESCRIPTORS REPLAY");
  console.log("=".repeat(80));

  const results: ReplayResult[] = [];

  for (const caseSpec of REPLAY_CASES) {
    try {
      const result = await replayCase(caseSpec);
      results.push(result);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
      results.push({
        label: caseSpec.label,
        jobId: caseSpec.jobId,
        expectedStatus: caseSpec.expectedStatus,
        input: { baselineUrl: "", stagedUrl: "" },
        baselineSummary: { openingsCount: 0, anchorFixturesCount: 0, wallDescriptorsCount: 0 },
        wallDescriptors: [],
        fullyInterpolatedPrompt: "",
        semanticReasoning: `ERROR: ${err}`,
        decision: {
          status: "error",
          confidence: 0,
          issueType: "error",
          hardFail: false,
          advisory: false,
        },
        actualResult: "error",
        correct: false,
        notes: String(err),
      });
    }
  }

  // Generate summary report
  const passCount = results.filter((r) => r.correct).length;
  const failCount = results.filter((r) => !r.correct).length;
  const errorCount = results.filter((r) => r.actualResult === "error").length;

  console.log("\n" + "=".repeat(80));
  console.log("REGRESSION SUMMARY");
  console.log("=".repeat(80));

  const table = results.map((r) => ({
    Job: r.jobId.substring(4),
    Expected: r.expectedStatus,
    Actual: r.actualResult,
    Correct: r.correct ? "✓" : "✗",
    WallDescriptors: r.wallDescriptors.length,
    Confidence: `${((r.decision.confidence || 0) * 100).toFixed(0)}%`,
    Notes: r.notes,
  }));

  console.table(table);

  console.log(
    `\nResults: ${passCount} correct, ${failCount} mismatch, ${errorCount} errors out of ${results.length} total`
  );

  // Write detailed report
  const reportPath = path.join(__dirname, "../reports/envelope-wall-descriptors-replay.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        results,
        summary: {
          passCount,
          failCount,
          errorCount,
          totalCount: results.length,
          timestamp: new Date().toISOString(),
        },
      },
      null,
      2
    )
  );

  console.log(`\nDetailed report: ${reportPath}`);
}

main().catch(console.error);

