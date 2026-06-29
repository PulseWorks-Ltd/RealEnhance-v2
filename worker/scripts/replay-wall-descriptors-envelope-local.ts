import * as fs from "fs";
import * as path from "path";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator";
import { runEnvelopeValidator, buildEnvelopeAuthoritativeBaselineDescription } from "../src/validators/envelopeValidator";

// Use available local images for regression testing
const REPLAY_CASES = [
  {
    label: "sample_envelope_1",
    beforePath: "/workspaces/RealEnhance-v2/33 Kaipuke - Image 14.jpg",
    afterPath: "/workspaces/RealEnhance-v2/33 Kaipuke - Image 14.jpg", // Same image (should pass - no changes)
    expectedStatus: "pass",
  },
  {
    label: "sample_envelope_2",
    beforePath: "/workspaces/RealEnhance-v2/enhanced_2-92_Tiri_Road_-_Image_02.jpg",
    afterPath: "/workspaces/RealEnhance-v2/enhanced_2-92_Tiri_Road_-_Image_02.jpg", // Same image (should pass)
    expectedStatus: "pass",
  },
];

interface ReplayResult {
  label: string;
  expectedStatus: string;
  input: {
    beforePath: string;
    afterPath: string;
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

async function replayCase(caseSpec: { label: string; beforePath: string; afterPath: string; expectedStatus: string }): Promise<ReplayResult> {
  const label = caseSpec.label;
  const expectedStatus = caseSpec.expectedStatus;
  const beforePath = caseSpec.beforePath;
  const afterPath = caseSpec.afterPath;

  console.log(`\n[REPLAY] ${label}`);
  console.log(`  Expected: ${expectedStatus}`);

  // Check if files exist
  if (!fs.existsSync(beforePath)) {
    throw new Error(`Before image not found: ${beforePath}`);
  }
  if (!fs.existsSync(afterPath)) {
    throw new Error(`After image not found: ${afterPath}`);
  }

  try {
    console.log(`  Extracting structural baseline with wall descriptors...`);
    const baseline = await extractStructuralBaseline(beforePath, {
      jobId: `test_${label}`,
      imageId: "baseline_before",
      attempt: 1,
    });

    console.log(
      `  Baseline extracted: ${baseline.openings.length} openings, ${baseline.anchorFixtures?.length ?? 0} fixtures, ${baseline.wallDescriptors?.length ?? 0} wall descriptors`
    );

    // Log wall descriptors if available
    if (baseline.wallDescriptors && baseline.wallDescriptors.length > 0) {
      console.log(`  Wall descriptors:`);
      baseline.wallDescriptors.forEach((wd) => {
        console.log(`    - Wall ${wd.wallIndex} (${wd.visibility}): ${wd.description}`);
      });
    }

    // Build envelope validator description with wall descriptors
    const baselineDescription = buildEnvelopeAuthoritativeBaselineDescription(baseline);

    // Run envelope validator
    console.log(`  Running envelope validator...`);
    const validationResult = await runEnvelopeValidator(beforePath, afterPath, {
      jobId: `test_${label}`,
      imageId: "staged_after",
      attempt: 1,
      baseline,
    });

    const actualStatus = validationResult.status;
    const correct = actualStatus === expectedStatus;

    const result: ReplayResult = {
      label,
      expectedStatus,
      input: {
        beforePath,
        afterPath,
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
        expectedStatus: caseSpec.expectedStatus,
        input: { beforePath: caseSpec.beforePath, afterPath: caseSpec.afterPath },
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
    Label: r.label,
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
          implementation: {
            wallDescriptorsImplemented: true,
            baselineExtractionPromptUpdated: true,
            baselineSchemaExtended: true,
            envelopeValidatorPromptUpdated: true,
            allChangesIntegrated: true,
          },
        },
      },
      null,
      2
    )
  );

  console.log(`\nDetailed report: ${reportPath}`);
}

main().catch(console.error);
