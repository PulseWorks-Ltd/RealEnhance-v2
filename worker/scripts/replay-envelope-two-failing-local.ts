import * as fs from "fs/promises";
import * as path from "path";
import { config } from "dotenv";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator.js";
import { buildEnvelopeDeterministicComparison, runEnvelopeValidator } from "../src/validators/envelopeValidator.js";

type StructuralBaselineLike = {
  cameraOrientation?: string;
  wallDescriptors?: Array<{
    wallIndex: number;
    visibility?: string;
    visibleExtent?: string;
    architecturalCertainty?: string;
    leftCornerVisible?: boolean;
    rightCornerVisible?: boolean;
    terminatesAtCorner?: boolean;
    continuesBeyondFrame?: boolean;
  }>;
};

config({ path: path.join(process.cwd(), ".env") });

type ReplayCase = {
  label: string;
  jobId: string;
  imageId: string;
  expected: "pass" | "fail";
  baselineFile: string;
  stagedFile: string;
  canonicalBaselineWebpUrl: string;
};

type ReplaySummary = {
  job: string;
  expected: "pass" | "fail";
  actual: string;
  selectedReplaySource: "localjpg" | "canonicalwebp";
  replayPathComparisons: {
    localjpg: {
      baselinePath: string;
      stagedPath: string;
      baselineExtractionSummary: string;
      stageExtractionSummary: string;
      deterministicSuspicions: Array<{ observationId: string; code: string; wallIndex: number; note: string }>;
      clarificationQuestions: string[];
      finalDecision: string;
      confidence: number;
    };
    canonicalwebp?: {
      baselinePath: string;
      stagedPath: string;
      baselineExtractionSummary: string;
      stageExtractionSummary: string;
      deterministicSuspicions: Array<{ observationId: string; code: string; wallIndex: number; note: string }>;
      clarificationQuestions: string[];
      finalDecision: string;
      confidence: number;
    };
  };
  architecturalQuestionPresented: string;
  architecturalClaimPresented: string;
  geminiAnswer: string;
  geminiReason: string;
  structuralPatterns: Array<{
    patternId: string;
    patternName: string;
    supportingObservations: string[];
    confidence: number;
  }>;
  architecturalEventCandidates: Array<{
    eventId: string;
    eventName: string;
    supportingStructuralPatterns: string[];
    conflictingStructuralPatterns: string[];
    supportingObservations: string[];
    conflictingObservations: string[];
    confidence: number;
    reasoning: string;
  }>;
  winningArchitecturalEvent: string;
  architecturalEventInferred: string;
  architecturalEventType: string;
  architecturalEventSecondary: string;
  architecturalEventEvidence: string[];
  alternativeExplanationsConsidered: string[];
  baselineExtractionSummary: string;
  stageExtractionSummary: string;
  architecturalChangeSummaryPassedToGemini: string;
  deterministicConfidence: string;
  verticalEdgeDeltaExecuted: boolean;
  usedCanonicalStage1AWebp: boolean;
  unsupportedArchitecturalCompletionDetected: boolean;
  addedWallDetected: boolean;
  removedWallDetected: boolean;
  generatedHypothesis: string;
  generatedHypothesisConfidence: string;
  selectedExplanation: string;
  generatedHypotheses: Array<{
    hypothesisId: string;
    category: string;
    title: string;
    confidence: string;
    statement: string;
    supportingObservations: string[];
    conflictingObservations: string[];
    alternativesConsidered: string[];
  }>;
  supportingDeterministicObservations: string[];
  geminiVerdict: string;
  geminiDismissalReason: string;
  geminiAnalysis: string;
  deterministicSuspicions: Array<{ observationId: string; code: string; wallIndex: number; note: string }>;
  clarificationQuestions: string[];
  observationAdjudications: Array<{
    observationId: string;
    code: string;
    wallIndex: number;
    decision: string;
    dismissReason?: string;
    explanation: string;
  }>;
  suspicionAddressMatrix: Array<{
    observationId: string;
    code: string;
    wallIndex: number;
    note: string;
    individuallyAddressed: boolean;
    decision?: string;
    dismissReason?: string;
    explanation?: string;
  }>;
  allSuspicionsAddressed: boolean;
  geminiReasoning: string;
  rawGeminiJson: string;
  finalDecision: string;
  confidence: number;
};

function summarizeBaselineExtraction(baseline: StructuralBaselineLike | null | undefined): string {
  if (!baseline) return "baseline extraction unavailable";
  const descriptors = Array.isArray(baseline.wallDescriptors) ? baseline.wallDescriptors : [];
  const detail = descriptors
    .slice()
    .sort((a, b) => a.wallIndex - b.wallIndex)
    .map((wall) => {
      const certainty = wall.architecturalCertainty || "partial";
      const visibility = wall.visibleExtent || wall.visibility || "unknown";
      return `wall_${wall.wallIndex}: visibility=${visibility}, certainty=${certainty}, corners=${wall.leftCornerVisible ? "L" : "-"}${wall.rightCornerVisible ? "R" : "-"}, terminatesAtCorner=${wall.terminatesAtCorner === true ? "yes" : "no"}, continuesBeyondFrame=${wall.continuesBeyondFrame === true ? "yes" : "no"}`;
    })
    .join(" | ");
  return `cameraOrientation=${baseline.cameraOrientation || "unknown"}; wallCount=${descriptors.length}; ${detail || "no wall descriptors"}`;
}

const TEST_IMAGE_DIR = "/workspaces/RealEnhance-v2/Test Images/Envelope Test Images";

const CASES: ReplayCase[] = [
  {
    label: "job_c11a8e7c",
    jobId: "job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023",
    imageId: "img_aced9a07-fccd-4e24-b0ee-139d5bbcde1d",
    expected: "fail",
    baselineFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9.jpg",
    stagedFile: "1782337783609-realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9-stage2.jpg",
    canonicalBaselineWebpUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/debug-attempts/job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023/realenhance-job_c11a8e7c-ef3b-48c9-9782-3bb41cc12023-1782337782818-ijp1zscim9-canonical-1A-env-relit-2.webp",
  },
  {
    label: "job_bb029607",
    jobId: "job_bb029607-dcd8-4614-997c-406d2ed33142",
    imageId: "img_e75a5903-34d3-42a2-b93f-b29314a5138d",
    expected: "fail",
    baselineFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg",
    stagedFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-stage2.jpg",
    canonicalBaselineWebpUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/debug-attempts/job_bb029607-dcd8-4614-997c-406d2ed33142/realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-canonical-1A-2.webp",
  },
  {
    label: "job_4a87f43b",
    jobId: "job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10",
    imageId: "img_a4f41fe0-ecc8-4bef-9a9b-0715d4e3963c",
    expected: "pass",
    baselineFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or.jpg",
    stagedFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or-stage2.jpg",
    canonicalBaselineWebpUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1782337804785-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or-canonical-1A-env-relit-1a-delivery.jpg",
  },
  {
    label: "job_dfbe98aa",
    jobId: "job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1",
    imageId: "img_35baa798-d2dd-4882-82d7-2b84b90a4b2e",
    expected: "pass",
    baselineFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap.jpg",
    stagedFile: "1782337783586-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap-stage2.jpg",
    canonicalBaselineWebpUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1782337800629-realenhance-job_dfbe98aa-c811-47b5-8c4c-f6ac70f65bb1-1782337782867-5lps3vswgap-canonical-1A-env-relit-1a-delivery.jpg",
  },
  {
    label: "job_81e485e7",
    jobId: "job_81e485e7-e3ce-4283-9f5e-e4f931d784bc",
    imageId: "img_228b053c-a06a-4f01-a3bf-123b2deaf8eb",
    expected: "pass",
    baselineFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2.jpg",
    stagedFile: "1782337783803-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2-stage2.jpg",
    canonicalBaselineWebpUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1782337803926-realenhance-job_81e485e7-e3ce-4283-9f5e-e4f931d784bc-1782337782967-xhrrckilo2-canonical-1A-1a-delivery.jpg",
  },
];

function inferSemanticSignals(reason: string): {
  unsupportedArchitecturalCompletionDetected: boolean;
  addedWallDetected: boolean;
  removedWallDetected: boolean;
} {
  const r = String(reason || "").toLowerCase();

  const unsupportedArchitecturalCompletionDetected =
    r.includes("unsupported_architectural_completion") ||
    r.includes("unsupported architectural completion") ||
    r.includes("completed beyond baseline") ||
    r.includes("invented") ||
    r.includes("new return wall") ||
    r.includes("new corner");

  const addedWallDetected =
    r.includes("wall_added") ||
    r.includes("wall_extended") ||
    /(new wall|wall added|added wall|new return wall|new corner|new divider)/.test(r);

  const removedWallDetected =
    r.includes("wall_removed") ||
    r.includes("wall_shortened") ||
    r.includes("wall_interrupted") ||
    /(wall removed|removed wall|return removed|corner removed|continuity broken)/.test(r);

  return {
    unsupportedArchitecturalCompletionDetected,
    addedWallDetected,
    removedWallDetected,
  };
}

async function ensureCanonicalBaselineWebp(testCase: ReplayCase): Promise<string> {
  const debugDir = path.join(process.cwd(), "reports", "debug-baselines");
  await fs.mkdir(debugDir, { recursive: true });
  const outPath = path.join(debugDir, `${testCase.label}-canonical-stage1a.webp`);

  try {
    await fs.access(outPath);
    return outPath;
  } catch {
    // Continue to download.
  }

  const response = await fetch(testCase.canonicalBaselineWebpUrl);
  if (!response.ok) {
    throw new Error(`Failed to download canonical baseline WEBP for ${testCase.label}: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(outPath, Buffer.from(arrayBuffer));
  return outPath;
}

async function runOne(testCase: ReplayCase): Promise<ReplaySummary> {
  const localBaselinePath = path.join(TEST_IMAGE_DIR, testCase.baselineFile);
  const stagedPath = path.join(TEST_IMAGE_DIR, testCase.stagedFile);

  await fs.access(localBaselinePath);
  await fs.access(stagedPath);

  const runWithBaseline = async (baselinePath: string, imageIdSuffix: string) => {
    const baseline = await extractStructuralBaseline(baselinePath, {
      jobId: testCase.jobId,
      imageId: `${testCase.imageId}_baseline_${imageIdSuffix}`,
      attempt: 1,
    });

    const detectedBaseline = await extractStructuralBaseline(stagedPath, {
      jobId: testCase.jobId,
      imageId: `${testCase.imageId}_detected_${imageIdSuffix}`,
      attempt: 1,
    });

    const preInferenceDeterministicComparison = buildEnvelopeDeterministicComparison(
      baseline ?? null,
      detectedBaseline ?? null,
    );

    console.log("[TRACE_REPLAY_INPUT_PATHS]", JSON.stringify({
      label: testCase.label,
      imageIdSuffix,
      baselinePath,
      stagedPath,
    }));
    console.log("[TRACE_STAGE2_EXTRACTION_EXECUTED]", JSON.stringify({
      label: testCase.label,
      imageIdSuffix,
      executed: !!detectedBaseline,
      wallDescriptorCount: Array.isArray((detectedBaseline as any)?.wallDescriptors)
        ? (detectedBaseline as any).wallDescriptors.length
        : 0,
    }));
    console.log("[TRACE_RAW_BASELINE_WALL_EXTRACTION_JSON]", JSON.stringify({
      label: testCase.label,
      imageIdSuffix,
      cameraOrientation: (baseline as any)?.cameraOrientation,
      wallDescriptors: Array.isArray((baseline as any)?.wallDescriptors)
        ? (baseline as any).wallDescriptors
        : [],
    }));
    console.log("[TRACE_RAW_STAGE2_WALL_EXTRACTION_JSON]", JSON.stringify({
      label: testCase.label,
      imageIdSuffix,
      cameraOrientation: (detectedBaseline as any)?.cameraOrientation,
      wallDescriptors: Array.isArray((detectedBaseline as any)?.wallDescriptors)
        ? (detectedBaseline as any).wallDescriptors
        : [],
    }));
    console.log("[TRACE_PRE_EVENT_DETERMINISTIC_COMPARISON_JSON]", JSON.stringify({
      label: testCase.label,
      imageIdSuffix,
      deterministicComparison: preInferenceDeterministicComparison,
    }));

    const result = await runEnvelopeValidator(baselinePath, stagedPath, {
      jobId: testCase.jobId,
      imageId: `${testCase.imageId}_${imageIdSuffix}`,
      attempt: 1,
      baseline,
      detectedBaseline,
    });

    return {
      result,
      baseline,
      detectedBaseline,
      baselinePath,
      stagedPath,
      deterministicComparison: preInferenceDeterministicComparison,
    };
  };

  let usedCanonicalStage1AWebp = false;
  const localRun = await runWithBaseline(localBaselinePath, "localjpg");
  let selectedRun = localRun;
  let canonicalRun: Awaited<ReturnType<typeof runWithBaseline>> | undefined;

  const verticalEdgeDeltaExecutedLocal = !!localRun.result.verticalEdgeDelta;
  if (!verticalEdgeDeltaExecutedLocal) {
    const canonicalBaselinePath = await ensureCanonicalBaselineWebp(testCase);
    canonicalRun = await runWithBaseline(canonicalBaselinePath, "canonicalwebp");
    selectedRun = canonicalRun;
    usedCanonicalStage1AWebp = true;
  }

  const result = selectedRun.result;
  const baseline = selectedRun.baseline;
  const detectedBaseline = selectedRun.detectedBaseline;
  const selectedReplaySource: "localjpg" | "canonicalwebp" = usedCanonicalStage1AWebp ? "canonicalwebp" : "localjpg";

  const inferred = inferSemanticSignals(result.reason || "");
  const verticalEdgeDeltaExecuted = !!result.verticalEdgeDelta;

  return {
    job: testCase.label,
    expected: testCase.expected,
    actual: result.status,
      selectedReplaySource,
      replayPathComparisons: {
        localjpg: {
          baselinePath: localRun.baselinePath,
          stagedPath: localRun.stagedPath,
          baselineExtractionSummary: summarizeBaselineExtraction(localRun.baseline as StructuralBaselineLike),
          stageExtractionSummary: summarizeBaselineExtraction(localRun.detectedBaseline as StructuralBaselineLike),
          deterministicSuspicions: (localRun.deterministicComparison.suspicions || []).map((entry) => ({
            observationId: String((entry as any).observationId || ""),
            code: String(entry.code),
            wallIndex: Number(entry.wallIndex),
            note: String(entry.note),
          })),
          clarificationQuestions: (localRun.deterministicComparison.clarificationQuestions || []).map((item) => String(item)),
          finalDecision: localRun.result.status,
          confidence: Number.isFinite(localRun.result.confidence) ? Number(localRun.result.confidence) : 0,
        },
        ...(canonicalRun
          ? {
              canonicalwebp: {
                baselinePath: canonicalRun.baselinePath,
                stagedPath: canonicalRun.stagedPath,
                baselineExtractionSummary: summarizeBaselineExtraction(canonicalRun.baseline as StructuralBaselineLike),
                stageExtractionSummary: summarizeBaselineExtraction(canonicalRun.detectedBaseline as StructuralBaselineLike),
                deterministicSuspicions: (canonicalRun.deterministicComparison.suspicions || []).map((entry) => ({
                  observationId: String((entry as any).observationId || ""),
                  code: String(entry.code),
                  wallIndex: Number(entry.wallIndex),
                  note: String(entry.note),
                })),
                clarificationQuestions: (canonicalRun.deterministicComparison.clarificationQuestions || []).map((item) => String(item)),
                finalDecision: canonicalRun.result.status,
                confidence: Number.isFinite(canonicalRun.result.confidence) ? Number(canonicalRun.result.confidence) : 0,
              },
            }
          : {}),
      },
      architecturalQuestionPresented: String((result as any).architecturalQuestion || ""),
      architecturalClaimPresented: String((result as any).architecturalClaim || ""),
      geminiAnswer: String((result as any).architecturalAnswer || ""),
      geminiReason: String((result as any).architecturalReason || ""),
      structuralPatterns: Array.isArray((result as any).structuralPatterns)
        ? (result as any).structuralPatterns.map((pattern: any) => ({
            patternId: String(pattern?.patternId || ""),
            patternName: String(pattern?.patternName || ""),
            supportingObservations: Array.isArray(pattern?.supportingObservations)
              ? pattern.supportingObservations.map((item: unknown) => String(item))
              : [],
            confidence: Number.isFinite(Number(pattern?.confidence)) ? Number(pattern.confidence) : 0,
          }))
        : [],
      architecturalEventCandidates: Array.isArray((result as any).architecturalEventCandidates)
        ? (result as any).architecturalEventCandidates.map((candidate: any) => ({
            eventId: String(candidate?.eventId || ""),
            eventName: String(candidate?.eventName || ""),
            supportingStructuralPatterns: Array.isArray(candidate?.supportingStructuralPatterns)
              ? candidate.supportingStructuralPatterns.map((item: unknown) => String(item))
              : [],
            conflictingStructuralPatterns: Array.isArray(candidate?.conflictingStructuralPatterns)
              ? candidate.conflictingStructuralPatterns.map((item: unknown) => String(item))
              : [],
            supportingObservations: Array.isArray(candidate?.supportingObservations)
              ? candidate.supportingObservations.map((item: unknown) => String(item))
              : [],
            conflictingObservations: Array.isArray(candidate?.conflictingObservations)
              ? candidate.conflictingObservations.map((item: unknown) => String(item))
              : [],
            confidence: Number.isFinite(Number(candidate?.confidence)) ? Number(candidate.confidence) : 0,
            reasoning: `Supports ${Array.isArray(candidate?.supportingStructuralPatterns) ? candidate.supportingStructuralPatterns.length : 0} structural patterns and conflicts with ${Array.isArray(candidate?.conflictingStructuralPatterns) ? candidate.conflictingStructuralPatterns.length : 0} others.`,
          }))
        : [],
      winningArchitecturalEvent: String((result as any).winningArchitecturalEvent || ""),
      architecturalEventInferred: String(result.architecturalEventInference?.primarySuspicion || ""),
      architecturalEventType: String(result.architecturalEventInference?.primaryEventType || ""),
      architecturalEventSecondary: String(result.architecturalEventInference?.secondarySuspicion || ""),
      architecturalEventEvidence: Array.isArray(result.architecturalEventInference?.evidence)
        ? result.architecturalEventInference!.evidence.map((item) => String(item))
        : [],
      alternativeExplanationsConsidered: Array.isArray(result.architecturalEventInference?.alternatives)
        ? result.architecturalEventInference!.alternatives.map((item) => String(item))
        : [],
      baselineExtractionSummary: summarizeBaselineExtraction(baseline as StructuralBaselineLike),
      stageExtractionSummary: summarizeBaselineExtraction(detectedBaseline as StructuralBaselineLike),
    architecturalChangeSummaryPassedToGemini: String(result.architecturalChangeSummary || ""),
    deterministicConfidence: String(result.hypothesisConfidence || ""),
    verticalEdgeDeltaExecuted,
    usedCanonicalStage1AWebp,
    unsupportedArchitecturalCompletionDetected: inferred.unsupportedArchitecturalCompletionDetected,
    addedWallDetected: inferred.addedWallDetected,
    removedWallDetected: inferred.removedWallDetected,
    generatedHypothesis: String(result.primaryHypothesis || result.deterministicHypotheses?.primaryHypothesis?.statement || ""),
    selectedExplanation: String((result as any).selectedExplanation || result.primaryHypothesis || ""),
    generatedHypothesisConfidence: String(result.hypothesisConfidence || result.deterministicHypotheses?.primaryHypothesis?.confidence || ""),
    generatedHypotheses: (result.deterministicHypotheses?.hypotheses || []).map((item) => ({
      hypothesisId: String((item as any).hypothesisId || ""),
      category: String((item as any).category || ""),
      title: String((item as any).title || ""),
      confidence: String((item as any).confidence || ""),
      statement: String((item as any).statement || ""),
      supportingObservations: Array.isArray((item as any).supportingObservations)
        ? (item as any).supportingObservations.map((entry: unknown) => String(entry))
        : [],
      conflictingObservations: Array.isArray((item as any).conflictingObservations)
        ? (item as any).conflictingObservations.map((entry: unknown) => String(entry))
        : [],
      alternativesConsidered: Array.isArray((item as any).alternativeExplanationsAlreadyConsidered)
        ? (item as any).alternativeExplanationsAlreadyConsidered.map((entry: unknown) => String(entry))
        : [],
    })),
    supportingDeterministicObservations: (result.deterministicHypotheses?.primaryHypothesis?.supportingObservations || []).map((item) => String(item)),
    geminiVerdict: String(result.hypothesisVerdict || ""),
    geminiDismissalReason: String(result.hypothesisDismissalReason || ""),
    geminiAnalysis: String(result.hypothesisAnalysis || ""),
      deterministicSuspicions: (result.deterministicEnvelopeComparison?.suspicions || []).map((entry) => ({
        observationId: String((entry as any).observationId || ""),
        code: String(entry.code),
        wallIndex: Number(entry.wallIndex),
        note: String(entry.note),
      })),
      clarificationQuestions: (result.deterministicEnvelopeComparison?.clarificationQuestions || []).map((item) => String(item)),
    observationAdjudications: (result.deterministicObservationAdjudications || []).map((item) => ({
      observationId: String((item as any).observationId || ""),
      code: String(item.code),
      wallIndex: Number(item.wallIndex),
      decision: String(item.decision),
      dismissReason: item.dismissReason ? String(item.dismissReason) : undefined,
      explanation: String(item.explanation || ""),
    })),
    suspicionAddressMatrix: (() => {
      const adjudications = (result.deterministicObservationAdjudications || []).map((item) => ({
        observationId: String((item as any).observationId || ""),
        code: String(item.code),
        wallIndex: Number(item.wallIndex),
        decision: String(item.decision),
        dismissReason: item.dismissReason ? String(item.dismissReason) : undefined,
        explanation: String(item.explanation || ""),
      }));
      const byObservationId = new Map(adjudications.map((item) => [item.observationId, item]));
      return (result.deterministicEnvelopeComparison?.suspicions || []).map((suspicion) => {
        const observationId = String((suspicion as any).observationId || "");
        const matched = byObservationId.get(observationId);
        return {
          observationId,
          code: String(suspicion.code),
          wallIndex: Number(suspicion.wallIndex),
          note: String(suspicion.note),
          individuallyAddressed: !!matched,
          decision: matched?.decision,
          dismissReason: matched?.dismissReason,
          explanation: matched?.explanation,
        };
      });
    })(),
    allSuspicionsAddressed: result.deterministicAdjudicationCoverage?.allSuspicionsAddressed === true,
    geminiReasoning: result.reason || "",
    rawGeminiJson: String(result.rawGeminiJson || ""),
    finalDecision: result.status,
    confidence: Number.isFinite(result.confidence) ? Number(result.confidence) : 0,
  };
}

async function main(): Promise<void> {
  const targetLabel = String(process.env.REPLAY_TARGET_LABEL || "").trim();
  const selectedCases = targetLabel.length > 0
    ? CASES.filter((c) => c.label === targetLabel)
    : CASES;

  if (selectedCases.length === 0) {
    throw new Error(`No replay case matched REPLAY_TARGET_LABEL=${targetLabel}`);
  }

  const summaries: ReplaySummary[] = [];

  for (const c of selectedCases) {
    console.log(`Running ${c.label}...`);
    const summary = await runOne(c);
    summaries.push(summary);
  }

  const output = {
    timestamp: new Date().toISOString(),
    mode: selectedCases.length === 1
      ? "single-job-envelope-replay-local-with-canonical-webp-fallback"
      : "five-job-envelope-replay-local-with-canonical-webp-fallback",
    selectedCases: selectedCases.map((c) => c.label),
    summaries,
  };

  const outPath = path.join(process.cwd(), "reports", "envelope-five-job-hypothesis-replay-summary.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log("\n=== Concise Comparison ===");
  console.table(
    summaries.map((s) => ({
      Job: s.job,
      Expected: s.expected,
      Actual: s.actual,
      SelectedReplaySource: s.selectedReplaySource,
      LocalSuspicionCount: s.replayPathComparisons.localjpg.deterministicSuspicions.length,
      CanonicalSuspicionCount: s.replayPathComparisons.canonicalwebp?.deterministicSuspicions.length ?? 0,
      VerticalEdgeDeltaExecuted: s.verticalEdgeDeltaExecuted,
      UsedCanonicalStage1AWebp: s.usedCanonicalStage1AWebp,
      UnsupportedArchitecturalCompletionDetected: s.unsupportedArchitecturalCompletionDetected,
      AddedWallDetected: s.addedWallDetected,
      RemovedWallDetected: s.removedWallDetected,
      Hypothesis: s.generatedHypothesis,
      HypothesisConfidence: s.generatedHypothesisConfidence,
      ArchitecturalQuestion: s.architecturalQuestionPresented,
      GeminiAnswer: s.geminiAnswer,
      GeminiReason: s.geminiReason,
      SelectedExplanation: s.selectedExplanation,
      Verdict: s.geminiVerdict,
      FinalDecision: s.finalDecision,
      Confidence: s.confidence,
    }))
  );

  for (const s of summaries) {
    console.log(`\n${s.job}`);
    console.log(`- Selected replay source: ${s.selectedReplaySource}`);
    console.log(`- Replay path comparison:`);
    console.log(`  - localjpg baseline: ${s.replayPathComparisons.localjpg.baselinePath}`);
    console.log(`  - localjpg staged: ${s.replayPathComparisons.localjpg.stagedPath}`);
    console.log(`  - localjpg deterministic suspicion count: ${s.replayPathComparisons.localjpg.deterministicSuspicions.length}`);
    if (s.replayPathComparisons.canonicalwebp) {
      console.log(`  - canonicalwebp baseline: ${s.replayPathComparisons.canonicalwebp.baselinePath}`);
      console.log(`  - canonicalwebp staged: ${s.replayPathComparisons.canonicalwebp.stagedPath}`);
      console.log(`  - canonicalwebp deterministic suspicion count: ${s.replayPathComparisons.canonicalwebp.deterministicSuspicions.length}`);
    }
    if (s.architecturalEventInferred) {
      console.log(`- Architectural Event Inferred: ${s.architecturalEventInferred}`);
      if (s.architecturalEventType) {
        console.log(`- Architectural Event Type: ${s.architecturalEventType}`);
      }
      if (s.architecturalEventSecondary) {
        console.log(`- Secondary suspicion: ${s.architecturalEventSecondary}`);
      }
    }
    if (s.architecturalEventEvidence.length > 0) {
      console.log(`- Evidence:`);
      for (const evidence of s.architecturalEventEvidence) {
        console.log(`  - ${evidence}`);
      }
    }
    if (s.alternativeExplanationsConsidered.length > 0) {
      console.log(`- Alternative explanations considered:`);
      for (const alternative of s.alternativeExplanationsConsidered) {
        console.log(`  - ${alternative}`);
      }
    }
    console.log(`- Baseline extraction summary: ${s.baselineExtractionSummary}`);
    console.log(`- Stage extraction summary: ${s.stageExtractionSummary}`);
    if (s.architecturalChangeSummaryPassedToGemini) {
      console.log(`- Architectural Change Summary passed to Gemini:`);
      console.log(s.architecturalChangeSummaryPassedToGemini);
    }
    if (s.architecturalQuestionPresented) {
      console.log(`- Architectural Question presented to Gemini: ${s.architecturalQuestionPresented}`);
    }
    if (s.geminiAnswer) {
      console.log(`- Gemini answer: ${s.geminiAnswer}`);
    }
    if (s.geminiReason) {
      console.log(`- Gemini reason: ${s.geminiReason}`);
    }
    if (s.deterministicConfidence) {
      console.log(`- Deterministic confidence: ${s.deterministicConfidence}`);
    }
    if (s.deterministicSuspicions.length > 0) {
      console.log(`- Deterministic suspicions:`);
      for (const suspicion of s.deterministicSuspicions) {
        console.log(`  - ${suspicion.observationId}: ${suspicion.code} (wall ${suspicion.wallIndex}): ${suspicion.note}`);
      }
    }
    if (s.structuralPatterns.length > 0) {
      console.log(`- Structural Patterns:`);
      for (const pattern of s.structuralPatterns) {
        console.log(`  - ${pattern.patternName} [${pattern.patternId}] confidence=${pattern.confidence.toFixed(3)}`);
        if (pattern.supportingObservations.length > 0) {
          console.log(`    supporting observations:`);
          for (const observation of pattern.supportingObservations) {
            console.log(`      - ${observation}`);
          }
        }
      }
    }
    if (s.architecturalEventCandidates.length > 0) {
      console.log(`- Architectural Event Candidates:`);
      for (const candidate of s.architecturalEventCandidates) {
        console.log(`  - ${candidate.eventName} [${candidate.eventId}] confidence=${candidate.confidence.toFixed(3)}`);
        console.log(`    reasoning: ${candidate.reasoning}`);
        if (candidate.supportingStructuralPatterns.length > 0) {
          console.log(`    supporting structural patterns:`);
          for (const patternName of candidate.supportingStructuralPatterns) {
            console.log(`      - ${patternName}`);
          }
        }
        if (candidate.conflictingStructuralPatterns.length > 0) {
          console.log(`    conflicting structural patterns:`);
          for (const patternName of candidate.conflictingStructuralPatterns) {
            console.log(`      - ${patternName}`);
          }
        }
      }
    }
    if (s.winningArchitecturalEvent) {
      console.log(`- Winning Architectural Event: ${s.winningArchitecturalEvent}`);
    }
    if (s.architecturalClaimPresented) {
      console.log(`- Architectural Claim Presented To Gemini: ${s.architecturalClaimPresented}`);
    }
    if (s.clarificationQuestions.length > 0) {
      console.log(`- Clarification questions passed to Gemini:`);
      for (const question of s.clarificationQuestions) {
        console.log(`  - ${question}`);
      }
    }
    console.log(`- Generated hypothesis: ${s.generatedHypothesis}`);
        if (s.selectedExplanation) {
          console.log(`- Selected explanation: ${s.selectedExplanation}`);
        }
    if (s.generatedHypothesisConfidence) {
      console.log(`- Generated hypothesis confidence: ${s.generatedHypothesisConfidence}`);
    }
    if (s.generatedHypotheses.length > 0) {
      console.log(`- Generated hypotheses (ranked):`);
      for (const h of s.generatedHypotheses) {
        console.log(`  - ${h.hypothesisId} [${h.category}] title=${h.title} confidence=${h.confidence}`);
        console.log(`    statement: ${h.statement}`);
        if (h.supportingObservations.length > 0) {
          console.log(`    supporting evidence:`);
          for (const support of h.supportingObservations) {
            console.log(`      - ${support}`);
          }
        }
        if (h.conflictingObservations.length > 0) {
          console.log(`    conflicting observations:`);
          for (const conflict of h.conflictingObservations) {
            console.log(`      - ${conflict}`);
          }
        }
        if (h.alternativesConsidered.length > 0) {
          console.log(`    alternatives already considered: ${h.alternativesConsidered.join(", ")}`);
        }
      }
    }
    if (s.supportingDeterministicObservations.length > 0) {
      console.log(`- Supporting deterministic observations:`);
      for (const item of s.supportingDeterministicObservations) {
        console.log(`  - ${item}`);
      }
    }
    console.log(`- Gemini verdict: ${s.geminiVerdict || "(not provided)"}`);
    if (s.selectedExplanation) {
      console.log(`- Gemini selected explanation: ${s.selectedExplanation}`);
    }
    if (s.geminiDismissalReason) {
      console.log(`- Gemini dismissal reason: ${s.geminiDismissalReason}`);
    }
    if (s.geminiAnalysis) {
      console.log(`- Gemini analysis: ${s.geminiAnalysis}`);
    }
    if (s.suspicionAddressMatrix.length > 0) {
      console.log(`- Suspicion adjudication coverage:`);
      for (const row of s.suspicionAddressMatrix) {
        console.log(`  - ${row.observationId}: ${row.code} (wall ${row.wallIndex}): addressed=${row.individuallyAddressed ? "yes" : "no"}${row.decision ? `, decision=${row.decision}` : ""}${row.dismissReason ? `, dismissReason=${row.dismissReason}` : ""}${row.explanation ? `, explanation=${row.explanation}` : ""}`);
      }
      console.log(`  - allSuspicionsAddressed=${s.allSuspicionsAddressed}`);
    }
    console.log(`- Gemini reasoning: ${s.geminiReasoning}`);
    if (s.rawGeminiJson) {
      console.log(`- Raw Gemini JSON: ${s.rawGeminiJson}`);
    }
    console.log(`- PASS / FAIL: ${s.finalDecision}`);
    console.log(`- Confidence: ${s.confidence}`);
    console.log(`- Expected vs Actual: ${s.expected} vs ${s.actual}`);
  }

  console.log(`\nSummary written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
