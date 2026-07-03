/**
 * Envelope Validator Diagnostic Replay
 * 
 * Replays all production jobs with local Stage 1A/Stage 2 image pairs
 * Full decision path tracing: baseline → descriptors → observation extraction → deterministic interpretation → result
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
    expectedDecision: "fail",
    baselineFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9.jpg",
    stagedFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9-stage2.jpg",
    notes: "Expected FAIL: Envelope anomaly detection",
  },
  {
    label: "job_bb029607",
    jobId: "job_bb029607-dcd8-4614-997c-406d2ed33142",
    imageId: "img_e75a5903-34d3-42a2-b93f-b29314a5138d",
    expectedStatus: "fail",
    expectedDecision: "advisory",
    baselineFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg",
    stagedFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-stage2.jpg",
    notes: "Expected FAIL: Envelope anomaly detection",
  },
  {
    label: "job_4a87f43b",
    jobId: "job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10",
    imageId: "img_a4f41fe0-ecc8-4bef-9a9b-0715d4e3963c",
    expectedStatus: "pass",
    expectedDecision: "pass",
    baselineFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or.jpg",
    stagedFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or-stage2.jpg",
    notes: "Expected PASS: No envelope change",
  },
  {
    label: "job_dfbe98aa",
    jobId: "job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1",
    imageId: "img_0c2e8e0d-2e87-4ae2-8b31-9c8c5e8c6f4a",
    expectedStatus: "pass",
    expectedDecision: "advisory",
    baselineFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap.jpg",
    stagedFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap-stage2.jpg",
    notes: "Expected PASS: No envelope modification",
  },
  {
    label: "job_81e485e7",
    jobId: "job_81e485e7-e3ce-4283-9f5e-e4f931d784bc",
    imageId: "img_228b053c-a06a-4f01-a3bf-123b2deaf8eb",
    expectedStatus: "pass",
    expectedDecision: "pass",
    baselineFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2.jpg",
    stagedFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2-stage2.jpg",
    notes: "Expected PASS: Same room envelope",
  },
  {
    label: "job_4ceef035",
    jobId: "job_4ceef035-b334-489c-bf91-3591fa703257",
    imageId: "img_13682e51-d7fd-4900-9edc-1cffc8c4cd99",
    expectedStatus: "pass",
    expectedDecision: "pass",
    baselineFile: "job_4ceef035-stage1A.jpg",
    stagedFile: "job_4ceef035-stage2.webp",
    baselineUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1782706114147-realenhance-job_4ceef035-b334-489c-bf91-3591fa703257-1782706084255-xp9qm6xmlj-canonical-1A-1a-delivery.jpg",
    stagedUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/debug-attempts/job_4ceef035-b334-489c-bf91-3591fa703257/realenhance-job_4ceef035-b334-489c-bf91-3591fa703257-1782706084255-xp9qm6xmlj-canonical-1A-2.webp",
    notes: "Expected PASS: Sixth benchmark recovered from attached worker logs",
  },
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadIfMissing(url: string | undefined, destinationPath: string): Promise<void> {
  if (!url) return;
  if (await fileExists(destinationPath)) return;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download benchmark artifact: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, bytes);
}

async function resolveImagePairPaths(testImageDir: string, testJob: typeof TEST_JOBS[number]): Promise<{ baselinePath: string; stagedPath: string }> {
  const baselinePath = path.join(testImageDir, testJob.baselineFile);
  const stagedPath = path.join(testImageDir, testJob.stagedFile);

  if (await fileExists(baselinePath) && await fileExists(stagedPath)) {
    return { baselinePath, stagedPath };
  }

  await downloadIfMissing((testJob as any).baselineUrl, baselinePath);
  await downloadIfMissing((testJob as any).stagedUrl, stagedPath);

  await fs.access(baselinePath);
  await fs.access(stagedPath);
  return { baselinePath, stagedPath };
}

interface DecisionPathTrace {
  stage: string;
  phase: string;
  findings: Record<string, any>;
}

interface WallEvidenceLineageTrace {
  semanticWallId: string;
  wallDisplayName: string;
  advisoryWallIndex: number;
  rawStructuralObservations: any[];
  additionalArchitecturalEvidence: any[];
  wallUtilisationObservations: any[];
  deterministicInterpretations: any[];
  policyEvidence: string[];
}

interface DiagnosticResult {
  label: string;
  jobId: string;
  expectedStatus: string;
  expectedDecision?: "pass" | "advisory" | "fail";
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
    baselineExtractionStrategy?: string;
    fallbackExtractionInvoked?: boolean;
    baselineReliability?: string;
    baselineConfidence?: number;
    baselineConfidenceDegraded?: boolean;
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

  // Observation extraction
  observationExtraction: {
    modelStatus: string;
    reason: string;
    confidence: number;
    issueType: string;
    advisorySignals: string[];
    stagedWallVerifications: any[];
    wallUtilisationObservations: any[];
    additionalArchitecturalEvidence: Record<string, any> | null;
    rawStructuralObservations: any[];
    wallEvidenceLineage: WallEvidenceLineageTrace[];
    stagedConsistency: {
      status: "CONSISTENT" | "RECONCILABLE" | "INCONSISTENT" | "UNKNOWN";
      retryPerformed: boolean;
      retrySuccess: boolean;
      consistencyFailures: string[];
    };
    interpretationCoverageAudit: Record<string, any> | null;
    rawObservationJson: string;
  };

  // Deterministic decisioning
  deterministicDecision: {
    geometricSignal: string;
    structuralSignal: string;
    hardFail: boolean;
    finalStatus: string;
    finalReason: string;
    mergeLogic: string;
    deterministicStructuralInterpretations: any[];
    architecturalObservations: any[];
    rawInterpretationCount: number;
    weightedEvidenceSummary: {
      previousModelEvidence: string[];
      newModelEvidence: string[];
    };
    materiallyUsableWallSurfaceInterpretations: Array<{
      generated: boolean;
      wallSemanticId?: string;
      wallDisplayName?: string;
      supportingGeometricInterpretations: string[];
      corroboratingEvidence: string[];
      confidence: string;
      decision: string;
      summary: string;
    }>;
  };

  // Final result
  actualStatus: string;
  actualDecision?: "pass" | "advisory" | "fail";
  previousDecision?: "pass" | "advisory" | "fail";
  verificationRequests?: string[];
  correct: boolean;
  confidence: number;
  issueType: string;
  hardFail: boolean;
  advisorySignals: string[];

  // Diagnostic trace
  decisionPath: DecisionPathTrace[];
}

function computeRawInterpretationPolicy(validationResult: any): {
  decision: "pass" | "advisory" | "fail";
  policyEvidence: string[];
} {
  const interpretations = Array.isArray(validationResult?.deterministicStructuralInterpretations)
    ? validationResult.deterministicStructuralInterpretations
    : [];
  const significant = interpretations.filter((item: any) => item?.severity === "significant");
  const advisory = interpretations.filter((item: any) => item?.severity === "advisory");
  const structuralFailCategories = new Set([
    "unsupported_boundary_expansion",
    "wall_plane_introduced",
    "wall_plane_removed",
    "return_wall_introduced",
    "return_wall_removed",
    "recess_introduced",
    "recess_removed",
    "adjoining_wall_introduced",
    "adjoining_wall_removed",
  ]);

  const failInterpretations = significant.filter((item: any) => {
    const explicitlyStructural = item?.classification === "structural_addition" || item?.decision === "fail";
    const structurallyMaterialCategory = structuralFailCategories.has(String(item?.category || ""));
    const supportingFacts = Array.isArray(item?.supportingFacts) ? item.supportingFacts.length : 0;
    const corroboratingEvidence = Array.isArray(item?.corroboratingEvidence) ? item.corroboratingEvidence.length : 0;
    const highSupport = supportingFacts >= 3 || corroboratingEvidence >= 1;
    return explicitlyStructural && structurallyMaterialCategory && highSupport;
  });

  const hasUnsupportedBoundaryAndMaterialUsePair = (() => {
    const byWall = new Map<string, any[]>();
    for (const item of interpretations) {
      const wall = String(item?.wallSemanticId || "__global__");
      const bucket = byWall.get(wall) || [];
      bucket.push(item);
      byWall.set(wall, bucket);
    }
    for (const items of byWall.values()) {
      const hasUnsupported = items.some((item) => String(item?.category || "") === "unsupported_boundary_expansion");
      const hasMaterial = items.some((item) => String(item?.category || "") === "materially_usable_wall_surface_introduced");
      if (hasUnsupported && hasMaterial) return true;
    }
    return false;
  })();

  if (failInterpretations.length > 0 || hasUnsupportedBoundaryAndMaterialUsePair) {
    const pairedEvidence = hasUnsupportedBoundaryAndMaterialUsePair
      ? ["unsupported_boundary_expansion+materially_usable_wall_surface_introduced:combined_boundary_material_signal"]
      : [];
    return {
      decision: "fail",
      policyEvidence: [
        ...failInterpretations.map((item: any) => `${item.category}:${item.summary}`),
        ...pairedEvidence,
      ],
    };
  }

  const advisorySignals = Array.isArray(validationResult?.advisorySignals) ? validationResult.advisorySignals : [];
  const policyEvidence = [
    ...advisory.map((item: any) => `${item.category}:${item.summary}`),
    ...significant.map((item: any) => `${item.category}:${item.summary}`),
    ...advisorySignals.map((signal: string) => `signal:${signal}`),
  ];

  if (validationResult?.verticalEdgeDelta?.cornerPersistenceFailure) {
    policyEvidence.push(`signal:corner_persistence_failure:${Number(validationResult.verticalEdgeDelta.worstRetention || 0).toFixed(3)}`);
  }
  if (validationResult?.verticalEdgeDelta?.verticalEdgeLossDetected) {
    policyEvidence.push("signal:vertical_edge_loss_detected");
  }

  const hasPolicyEvidence = policyEvidence.length > 0
    || significant.length > 0
    || advisorySignals.length > 0
    || !!validationResult?.verticalEdgeDelta?.cornerPersistenceFailure
    || !!validationResult?.verticalEdgeDelta?.verticalEdgeLossDetected;

  if (hasPolicyEvidence) {
    return {
      decision: "advisory",
      policyEvidence,
    };
  }
  return {
    decision: "pass",
    policyEvidence: ["no_meaningful_structural_concern"],
  };
}

function computeCollapsedObservationPolicy(validationResult: any): {
  decision: "pass" | "advisory" | "fail";
  policyEvidence: string[];
} {
  const interpretations = Array.isArray(validationResult?.deterministicStructuralInterpretations)
    ? validationResult.deterministicStructuralInterpretations
    : [];
  const grouped = new Map<string, any[]>();

  const observationKeyFor = (item: any): string => {
    const wall = String(item?.wallSemanticId || "global");
    const category = String(item?.category || "unknown");
    if (["corner_introduced", "wall_plane_introduced", "return_wall_introduced", "adjoining_wall_introduced", "unsupported_boundary_expansion"].includes(category)) {
      return `adjacent_wall_geometry_introduced:${wall}`;
    }
    if (["corner_removed", "return_wall_removed", "adjoining_wall_removed"].includes(category)) {
      return `adjacent_wall_geometry_removed:${wall}`;
    }
    if (["wall_shortened", "wall_extended"].includes(category)) {
      return `wall_termination_changed:${wall}`;
    }
    return `${category}:${wall}`;
  };

  for (const interpretation of interpretations) {
    const key = observationKeyFor(interpretation);
    const bucket = grouped.get(key) || [];
    bucket.push(interpretation);
    grouped.set(key, bucket);
  }

  const observations = [...grouped.entries()].map(([key, items]) => {
    const fail = items.some((item: any) => item?.severity === "significant" && item?.decision === "fail");
    const support = items.reduce((count: number, item: any) => count + (Array.isArray(item?.supportingFacts) ? item.supportingFacts.length : 0) + (Array.isArray(item?.corroboratingEvidence) ? item.corroboratingEvidence.length : 0), 0);
    const summary = String(items[0]?.summary || key);
    return {
      key,
      fail,
      support,
      summary,
      advisory: items.some((item: any) => item?.severity === "advisory") || !fail,
    };
  });

  const failObservations = observations.filter((item) => item.fail && item.support > 0);
  if (failObservations.length > 0) {
    return {
      decision: "fail",
      policyEvidence: failObservations.map((item) => `${item.key}:${item.summary}`),
    };
  }

  const advisorySignals = Array.isArray(validationResult?.advisorySignals) ? validationResult.advisorySignals : [];
  const policyEvidence = [
    ...observations.map((item) => `${item.key}:${item.summary}`),
    ...advisorySignals.map((signal: string) => `signal:${signal}`),
  ];

  if (validationResult?.verticalEdgeDelta?.cornerPersistenceFailure) {
    policyEvidence.push(`signal:corner_persistence_failure:${Number(validationResult.verticalEdgeDelta.worstRetention || 0).toFixed(3)}`);
  }
  if (validationResult?.verticalEdgeDelta?.verticalEdgeLossDetected) {
    policyEvidence.push("signal:vertical_edge_loss_detected");
  }

  if (policyEvidence.length > 0) {
    return {
      decision: "advisory",
      policyEvidence,
    };
  }

  return {
    decision: "pass",
    policyEvidence: ["no_meaningful_structural_concern"],
  };
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
  const requestedJobLabel = process.argv.find((value) => value.startsWith("--job="))?.split("=")[1]
    || (() => {
      const idx = process.argv.indexOf("--job");
      return idx >= 0 ? process.argv[idx + 1] : undefined;
    })();
  const selectedJobs = requestedJobLabel
    ? TEST_JOBS.filter((job) => job.label === requestedJobLabel || job.jobId === requestedJobLabel)
    : TEST_JOBS;

  if (requestedJobLabel && selectedJobs.length === 0) {
    throw new Error(`No benchmark job matched --job ${requestedJobLabel}`);
  }

  if (requestedJobLabel) {
    console.log(`Running single-job replay for ${requestedJobLabel}`);
  }

  for (const testJob of selectedJobs) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`📋 JOB: ${testJob.label}`);
    console.log(`   Expected: ${testJob.expectedStatus.toUpperCase()}`);
    console.log(`   ${testJob.notes}`);
    console.log(`${"═".repeat(70)}\n`);

    try {
      const ctx = createMockContext(testJob.jobId);
      const { baselinePath, stagedPath } = await resolveImagePairPaths(TEST_IMAGE_DIR, testJob);

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
      const actualDecision = (validationResult as any).decision || (actualStatus === "fail" ? "fail" : "pass");
      const previousPolicy = computeCollapsedObservationPolicy(validationResult as any);
      const currentPolicy = computeRawInterpretationPolicy(validationResult as any);
      const previousDecision = previousPolicy.decision;
      const rawInterpretationCount = Array.isArray((validationResult as any).deterministicStructuralInterpretations)
        ? (validationResult as any).deterministicStructuralInterpretations.length
        : 0;
      const materiallyUsableInterpretations = ((validationResult as any).deterministicStructuralInterpretations || [])
        .filter((item: any) => item?.category === "materially_usable_wall_surface_introduced")
        .map((item: any) => {
          const supportingFacts = Array.isArray(item?.supportingFacts) ? item.supportingFacts : [];
          const supportingGeo = supportingFacts
            .find((fact: string) => fact.startsWith("supporting_geometric_interpretations="))
            ?.replace("supporting_geometric_interpretations=", "")
            .split(",")
            .map((value: string) => value.trim())
            .filter((value: string) => value.length > 0) || [];
          return {
            generated: true,
            wallSemanticId: item?.wallSemanticId,
            wallDisplayName: item?.wallDisplayName,
            supportingGeometricInterpretations: supportingGeo,
            corroboratingEvidence: Array.isArray(item?.corroboratingEvidence) ? item.corroboratingEvidence : [],
            confidence: String(item?.confidence || "unknown"),
            decision: String(item?.decision || "unknown"),
            summary: String(item?.summary || ""),
          };
        });
      const architecturalObservationsGenerated = Array.isArray((validationResult as any).architecturalObservations)
        && (validationResult as any).architecturalObservations.length > 0;
      const advisoryOnlyVerificationRequests = (actualDecision as string) === "advisory"
        ? ((validationResult as any).verificationRequests || [])
        : [];
      const stagedConsistencyStatus = ((validationResult as any).stagedObservationConsistency?.status || "UNKNOWN") as "CONSISTENT" | "RECONCILABLE" | "INCONSISTENT" | "UNKNOWN";
      const stagedRetryPerformed = !!((validationResult as any).stagedExtractionRetryStatus?.triggered);
      const stagedRetrySuccess = !!((validationResult as any).stagedExtractionRetryStatus?.retrySucceeded);
      const stagedConsistencyFailures = Array.isArray((validationResult as any).stagedObservationConsistency?.consistencyFailures)
        ? (validationResult as any).stagedObservationConsistency.consistencyFailures
        : [];
      const rawStructuralObservations = Array.isArray((validationResult as any).rawStructuralObservations)
        ? (validationResult as any).rawStructuralObservations
        : [];
      const wallUtilisationObservations = Array.isArray((validationResult as any).wallUtilisationObservations)
        ? (validationResult as any).wallUtilisationObservations
        : [];
      const wallEvidenceLineage = Array.isArray((validationResult as any).wallEvidenceLineage)
        ? (validationResult as any).wallEvidenceLineage
        : [];
      const interpretationCoverageAudit = (validationResult as any).interpretationCoverageAudit || null;
      console.log(`   ✓ Validator decision: ${actualStatus.toUpperCase()}`);
      console.log(`   ✓ Envelope policy decision: ${String(actualDecision).toUpperCase()}`);
      console.log(`   ✓ Previous (collapsed observation) decision: ${String(previousDecision).toUpperCase()}`);
      console.log(`   ✓ Raw interpretation count: ${rawInterpretationCount}`);
      console.log(`   ✓ Architectural observations generated: ${architecturalObservationsGenerated ? "YES" : "NO"}`);
      console.log(`   ✓ Staged consistency status: ${stagedConsistencyStatus}`);
      console.log(`   ✓ Staged retry performed: ${stagedRetryPerformed ? "YES" : "NO"}`);
      console.log(`   ✓ Staged retry success: ${stagedRetrySuccess ? "YES" : "NO"}`);
      console.log(`   ✓ Raw structural observations: ${rawStructuralObservations.length}`);
      console.log(`   ✓ Wall utilisation observations: ${wallUtilisationObservations.length}`);
      console.log(`   ✓ Wall evidence lineage rows: ${wallEvidenceLineage.length}`);
      if (interpretationCoverageAudit) {
        console.log(`   ✓ Interpretation coverage: ${interpretationCoverageAudit.coveragePercent}% (${interpretationCoverageAudit.coveredObservationCount}/${interpretationCoverageAudit.rawStructuralObservationCount})`);
        if (Array.isArray(interpretationCoverageAudit.missingObservations) && interpretationCoverageAudit.missingObservations.length > 0) {
          console.log(`   ✓ Missing observations (coverage loss):`);
          interpretationCoverageAudit.missingObservations.forEach((item: any) => {
            console.log(`     - ${item.code}:${item.reason}`);
          });
        }
      }
      if (stagedConsistencyFailures.length > 0) {
        console.log(`   ✓ Staged consistency failures:`);
        stagedConsistencyFailures.forEach((failure: string) => {
          console.log(`     - ${failure}`);
        });
      }
      console.log(`   ✓ Confidence: ${validationResult.confidence}`);
      console.log(`   ✓ Hard fail: ${validationResult.hardFail}`);
      console.log(`   ✓ Issue type: ${validationResult.issueType || "none"}`);
      if (Array.isArray(advisoryOnlyVerificationRequests) && advisoryOnlyVerificationRequests.length > 0) {
        console.log(`   ✓ Verification requests:`);
        advisoryOnlyVerificationRequests.forEach((request: string) => {
          console.log(`     - ${request}`);
        });
      }
      
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
        expectedDecision: (testJob as any).expectedDecision,
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
          baselineMethod: (baseline as any)?.graphMeta?.baselineMethod || "graph_consensus",
          baselineExtractionStrategy: (baseline as any)?.observationMeta?.baselineExtractionStrategy || (baseline as any)?.graphMeta?.baselineExtractionStrategy,
          fallbackExtractionInvoked: !!((baseline as any)?.observationMeta?.fallbackInvoked || (baseline as any)?.graphMeta?.fallbackInvoked),
          baselineReliability: (baseline as any)?.observationMeta?.baselineReliability || (baseline as any)?.graphMeta?.baselineReliability,
          baselineConfidence: (baseline as any)?.observationMeta?.baselineConfidence || (baseline as any)?.graphMeta?.baselineConfidence,
          baselineConfidenceDegraded: !!((baseline as any)?.observationMeta?.baselineConfidenceDegraded || (baseline as any)?.graphMeta?.baselineConfidenceDegraded),
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

        observationExtraction: {
          modelStatus: validationResult.status || "unknown",
          reason: (validationResult as any).reason || "",
          confidence: validationResult.confidence || 0,
          issueType: validationResult.issueType || "none",
          advisorySignals: validationResult.advisorySignals || [],
          stagedWallVerifications: (validationResult as any).stagedWallVerifications || [],
          wallUtilisationObservations,
          additionalArchitecturalEvidence: (validationResult as any).additionalArchitecturalEvidence || null,
          rawStructuralObservations,
          wallEvidenceLineage,
          stagedConsistency: {
            status: stagedConsistencyStatus,
            retryPerformed: stagedRetryPerformed,
            retrySuccess: stagedRetrySuccess,
            consistencyFailures: stagedConsistencyFailures,
          },
          interpretationCoverageAudit,
          rawObservationJson: (validationResult as any).guidedObservationRawGeminiJson || "",
        },

        deterministicDecision: {
          geometricSignal: (validationResult as any).verticalEdgeLoss ? "GEOMETRIC_FAILURE" : "GEOMETRIC_OK",
          structuralSignal: validationResult.status === "pass" ? "DETERMINISTIC_PASS" : "DETERMINISTIC_FAIL",
          hardFail: validationResult.hardFail || false,
          finalStatus: validationResult.status || "unknown",
          finalReason: (validationResult as any).reason || "",
          mergeLogic: "hard-fail integrity checks override; otherwise software-determined structural interpretations decide the outcome",
          deterministicStructuralInterpretations: (validationResult as any).deterministicStructuralInterpretations || [],
          architecturalObservations: (validationResult as any).architecturalObservations || [],
          rawInterpretationCount,
          weightedEvidenceSummary: {
            previousModelEvidence: previousPolicy.policyEvidence,
            newModelEvidence: currentPolicy.policyEvidence,
          },
          materiallyUsableWallSurfaceInterpretations: materiallyUsableInterpretations,
        },

        actualStatus,
        actualDecision: actualDecision as "pass" | "advisory" | "fail",
        previousDecision,
        verificationRequests: advisoryOnlyVerificationRequests,
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
            stage: "3_observation_extraction",
            phase: "gemini_guided_wall_observations",
            findings: {
              stagedWallVerifications: ((validationResult as any).stagedWallVerifications || []).length,
              additionalArchitecturalEvidence: (validationResult as any).additionalArchitecturalEvidence || null,
              wallEvidenceLineageRows: wallEvidenceLineage.length,
              stagedConsistencyStatus,
              stagedRetryPerformed,
              stagedRetrySuccess,
              stagedConsistencyFailures,
            },
          },
          {
            stage: "4_deterministic_interpretation",
            phase: "software_structural_reasoning",
            findings: {
              interpretations: (validationResult as any).deterministicStructuralInterpretations || [],
              architecturalObservations: (validationResult as any).architecturalObservations || [],
              rawStructuralObservations,
              interpretationCoverageAudit,
            },
          },
          {
            stage: "5_final_software_decision",
            phase: "final_decision",
            findings: {
              hardFail: validationResult.hardFail,
              finalStatus: validationResult.status,
              finalReason: (validationResult as any).reason,
            },
          },
        ],
      };

      results.push(diagnosticResult);

      const coverage = diagnosticResult.observationExtraction.interpretationCoverageAudit;
      if (coverage) {
        console.log(`   Evidence Loss Audit (Raw Structural Observations -> Deterministic Interpretations):`);
        for (const row of coverage.rows || []) {
          const status = row.lost ? "LOST" : "PRESERVED";
          const interpretations = Array.isArray(row.deterministicInterpretations) && row.deterministicInterpretations.length > 0
            ? row.deterministicInterpretations.join(", ")
            : "none";
          console.log(`     - ${status} | ${row.rawStructuralObservation} -> ${interpretations}${row.reason ? ` | ${row.reason}` : ""}`);
        }
      }

      if (Array.isArray(diagnosticResult.observationExtraction.wallEvidenceLineage) && diagnosticResult.observationExtraction.wallEvidenceLineage.length > 0) {
        console.log(`   Semantic Wall Lineage Matrix:`);
        console.log(`     Semantic Wall ↓ Raw Structural Observations ↓ Additional Architectural Evidence ↓ Wall Utilisation ↓ Deterministic Interpretations ↓ Policy Evidence`);
        for (const row of diagnosticResult.observationExtraction.wallEvidenceLineage) {
          const rawCount = Array.isArray(row.rawStructuralObservations) ? row.rawStructuralObservations.length : 0;
          const addlCount = Array.isArray(row.additionalArchitecturalEvidence) ? row.additionalArchitecturalEvidence.length : 0;
          const utilCount = Array.isArray(row.wallUtilisationObservations) ? row.wallUtilisationObservations.length : 0;
          const interpCount = Array.isArray(row.deterministicInterpretations) ? row.deterministicInterpretations.length : 0;
          const policyCount = Array.isArray(row.policyEvidence) ? row.policyEvidence.length : 0;
          console.log(`     - ${row.wallDisplayName} (${row.semanticWallId}): raw=${rawCount}, additional=${addlCount}, utilisation=${utilCount}, interpretations=${interpCount}, policy=${policyCount}`);
        }
      }
    } catch (error: any) {
      console.error(`   ❌ ERROR: ${error.message}\n`);
      results.push({
        label: testJob.label,
        jobId: testJob.jobId,
        expectedStatus: testJob.expectedStatus,
        expectedDecision: (testJob as any).expectedDecision,
        baselineFile: testJob.baselineFile,
        stagedFile: testJob.stagedFile,
        baseline: { openingsCount: 0, fixturesCount: 0, wallDescriptorsCount: 0, wallDescriptors: [], graphConfidence: 0, baselineMethod: "error" },
        fullyInterpolatedPrompt: "",
        geometricMetrics: { verticalEdgeLoss: false, cornerPersistenceFailure: false, worstRetention: "N/A", junctionCount: 0, beforeEdges: 0, afterEdges: 0, deterministic: { verticalEdgeDeltaTriggered: false, reason: error.message } },
        observationExtraction: {
          modelStatus: "error",
          reason: error.message,
          confidence: 0,
          issueType: "error",
          advisorySignals: [],
          stagedWallVerifications: [],
          wallUtilisationObservations: [],
          additionalArchitecturalEvidence: null,
          rawStructuralObservations: [],
          wallEvidenceLineage: [],
          stagedConsistency: {
            status: "UNKNOWN",
            retryPerformed: false,
            retrySuccess: false,
            consistencyFailures: [],
          },
          interpretationCoverageAudit: null,
          rawObservationJson: "",
        },
        deterministicDecision: {
          geometricSignal: "ERROR",
          structuralSignal: "ERROR",
          hardFail: false,
          finalStatus: "error",
          finalReason: error.message,
          mergeLogic: "ERROR",
          deterministicStructuralInterpretations: [],
          architecturalObservations: [],
          rawInterpretationCount: 0,
          weightedEvidenceSummary: {
            previousModelEvidence: [],
            newModelEvidence: [],
          },
          materiallyUsableWallSurfaceInterpretations: [],
        },
        actualStatus: "error",
        actualDecision: "advisory",
        previousDecision: "advisory",
        verificationRequests: [],
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

  console.log(`Envelope Decision Policy Comparison`);
  console.log(`${"─".repeat(120)}`);
  console.log(`| Job ID          | Expected Decision | Previous Decision | New Decision | Verification Requests |`);
  console.log(`${"─".repeat(120)}`);
  for (const result of results) {
    const expectedDecision = (result.expectedDecision || result.expectedStatus || "unknown").padEnd(17);
    const previousDecision = (result.previousDecision || "unknown").padEnd(17);
    const newDecision = (result.actualDecision || result.actualStatus || "unknown").padEnd(12);
    const requests = (result.verificationRequests || []).length;
    const requestLabel = (requests > 0 ? `${requests} request(s)` : "none").padEnd(21);
    console.log(`| ${result.label.padEnd(15)} | ${expectedDecision} | ${previousDecision} | ${newDecision} | ${requestLabel} |`);
  }
  console.log(`${"─".repeat(120)}\n`);

  console.log(`Architectural Observations & Baseline Strategy`);
  console.log(`${"─".repeat(140)}`);
  console.log(`| Job ID          | Observations | Fallback | Strategy                  | Reliability |`);
  console.log(`${"─".repeat(140)}`);
  for (const result of results) {
    const observationCount = (result.deterministicDecision.architecturalObservations || []).length;
    const fallback = result.baseline.fallbackExtractionInvoked ? "YES" : "NO";
    const strategy = (result.baseline.baselineExtractionStrategy || result.baseline.baselineMethod || "unknown").slice(0, 24).padEnd(24);
    const reliability = (result.baseline.baselineReliability || "unknown").padEnd(11);
    console.log(`| ${result.label.padEnd(15)} | ${String(observationCount).padEnd(12)} | ${fallback.padEnd(8)} | ${strategy} | ${reliability} |`);
  }
  console.log(`${"─".repeat(140)}\n`);

  console.log(`Interpretation Coverage`);
  console.log(`${"─".repeat(140)}`);
  console.log(`| Job ID          | Raw Structural Observations | Deterministic Interpretations | Coverage | Missing |`);
  console.log(`${"─".repeat(140)}`);
  for (const result of results) {
    const coverage = result.observationExtraction.interpretationCoverageAudit || {};
    const rawCount = Number.isFinite(Number(coverage.rawStructuralObservationCount)) ? Number(coverage.rawStructuralObservationCount) : 0;
    const interpCount = Number.isFinite(Number(coverage.deterministicInterpretationCount)) ? Number(coverage.deterministicInterpretationCount) : 0;
    const coverageLabel = Number.isFinite(Number(coverage.coveragePercent)) ? `${Number(coverage.coveragePercent).toFixed(2)}%` : "n/a";
    const missingCount = Array.isArray(coverage.missingObservations) ? coverage.missingObservations.length : 0;
    console.log(`| ${result.label.padEnd(15)} | ${String(rawCount).padEnd(27)} | ${String(interpCount).padEnd(29)} | ${coverageLabel.padEnd(8)} | ${String(missingCount).padEnd(7)} |`);
  }
  console.log(`${"─".repeat(140)}\n`);

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
          expectedDecision: r.expectedDecision,
          actualStatus: r.actualStatus,
          actualDecision: r.actualDecision,
          decisionPath: r.decisionPath,
          geometricFindings: r.geometricMetrics.deterministic,
          semanticFindings: {
            status: r.actualStatus,
            decision: r.actualDecision,
            reason: r.observationExtraction.reason,
            confidence: r.observationExtraction.confidence,
            issueType: r.observationExtraction.issueType,
            advisorySignals: r.observationExtraction.advisorySignals,
            verificationRequests: r.verificationRequests || [],
          },
          mergeLogic: r.deterministicDecision,
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
      console.log(`   • Decision: ${String(result.actualDecision || result.actualStatus).toUpperCase()}`);
      console.log(`   • Reason: ${result.observationExtraction.reason}`);
      console.log(`   • Confidence: ${result.observationExtraction.confidence}`);
      console.log(`   • Issue type: ${result.observationExtraction.issueType}`);
      if ((result.observationExtraction.advisorySignals || []).length > 0) {
        console.log(`   • Advisory signals: ${result.observationExtraction.advisorySignals.join(", ")}`);
      }

      console.log(`\n   DECISION MERGE:`);
      console.log(`   • Geometric signal: ${result.deterministicDecision.geometricSignal}`);
      console.log(`   • Semantic signal: ${result.deterministicDecision.structuralSignal}`);
      console.log(`   • Hard fail flag: ${result.deterministicDecision.hardFail}`);
      console.log(`   • Merge logic: ${result.deterministicDecision.mergeLogic}`);
      console.log(`   • Final merged status: ${result.deterministicDecision.finalStatus}\n`);

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
