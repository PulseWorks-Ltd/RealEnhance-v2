import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { extractStructuralBaseline } from "../src/validators/openingPreservationValidator.js";
import type { StructuralBaseline } from "../src/validators/openingPreservationValidator.js";
import { runEnvelopeValidator } from "../src/validators/envelopeValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "../.env") });
delete process.env.ENVELOPE_CONSTRAINT_VERIFICATION;
delete process.env.ENVELOPE_BASELINE_VERIFICATION;

const TEST_IMAGE_DIR = "/workspaces/RealEnhance-v2/Test Images/Envelope Test Images";
const JOBS = {
  job_bb029607: {
    label: "job_bb029607",
    jobId: "job_bb029607-dcd8-4614-997c-406d2ed33142",
    imageId: "img_e75a5903-34d3-42a2-b93f-b29314a5138d",
    baselineFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg",
    stagedFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-stage2.jpg",
  },
  job_4a87f43b: {
    label: "job_4a87f43b",
    jobId: "job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10",
    imageId: "img_a4f41fe0-ecc8-4bef-9a9b-0715d4e3963c",
    baselineFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or.jpg",
    stagedFile: "1782337784628-realenhance-job_4a87f43b-0e1d-4992-ab4b-d39e7cf21f10-1782337782877-o6v436g60or-stage2.jpg",
  },
  job_4ceef035: {
    label: "job_4ceef035",
    jobId: "job_4ceef035-b334-489c-bf91-3591fa703257",
    imageId: "img_13682e51-d7fd-4900-9edc-1cffc8c4cd99",
    baselineFile: "job_4ceef035-stage1A.jpg",
    stagedFile: "job_4ceef035-stage2.webp",
    baselineUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1782706114147-realenhance-job_4ceef035-b334-489c-bf91-3591fa703257-1782706084255-xp9qm6xmlj-canonical-1A-1a-delivery.jpg",
    stagedUrl: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/debug-attempts/job_4ceef035-b334-489c-bf91-3591fa703257/realenhance-job_4ceef035-b334-489c-bf91-3591fa703257-1782706084255-xp9qm6xmlj-canonical-1A-2.webp?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIA3Y3F4KBX2GFVGYDR%2F20260629%2Fap-southeast-2%2Fs3%2Faws4_request&X-Amz-Date=20260629T040901Z&X-Amz-Expires=86400&X-Amz-Signature=9ba4d12109119c0d5211dc5649079afc760ebdb74e84741fe656d7ffd8a42648&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject",
  },
} as const;

const requestedJobLabel = process.env.ENVELOPE_REPORT_JOB || process.argv[2] || "job_bb029607";
const JOB = JOBS[requestedJobLabel as keyof typeof JOBS];

if (!JOB) {
  throw new Error(`Unknown report job: ${requestedJobLabel}`);
}

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
    throw new Error(`Failed to download report artifact: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, bytes);
}

function linesForStatementResults(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const statements = result.constraintVerificationStatements || result.baselineVerificationStatements || [];
  const byId = new Map((result.constraintVerificationResults || result.baselineVerificationResults || []).map((item) => [item.statementId, item] as const));
  if (statements.length === 0) return ["- none"]; 
  return statements.map((statement) => {
    const verification = byId.get(statement.statementId);
    const magnitude = verification?.observedVisibilityMagnitude ? ` [observed visibility: ${verification.observedVisibilityMagnitude}]` : "";
    const suffix = verification?.explanation ? ` -- ${verification.explanation}${magnitude}` : magnitude;
    return `- ${statement.statementId} [${statement.reasoningLayer}] [${statement.architecturalContext}]: ${verification?.answer || "UNANSWERED"} -- ${statement.statement}${suffix}`;
  });
}

function linesForChangedConstraints(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const failures = result.changedConstraints || result.baselineVerificationFailures || [];
  if (failures.length === 0) return ["- none"]; 
  return failures.map((failure) => `- ${failure.statementId}: ${failure.statement}${failure.explanation ? ` -- ${failure.explanation}` : ""}${failure.observedVisibilityMagnitude ? ` [observed visibility: ${failure.observedVisibilityMagnitude}]` : ""}${failure.significance ? ` [significance: ${failure.significance}]` : ""}`);
}

function linesForEvents(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const candidates = result.architecturalEventCandidates || [];
  if (candidates.length === 0) return ["- none"]; 
  return candidates.map((candidate) => `- ${candidate.eventName} (confidence ${candidate.confidence.toFixed(2)}): ${candidate.supportingObservations.join(" | ")}`);
}

function linesForFinalDecision(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  return [
    `- status: ${result.status.toUpperCase()}`,
    `- confidence: ${result.confidence}`,
    `- reason: ${result.reason || "(not available)"}`,
    `- selected explanation: ${result.selectedExplanation || "(not available)"}`,
  ];
}

function linesForStructuralBaseline(label: string, baseline?: StructuralBaseline | null): string[] {
  if (!baseline) return [`- ${label}: none`];
  const walls = baseline.wallDescriptors || [];
  const openings = baseline.openings || [];
  const fixtures = baseline.anchorFixtures || [];
  const edgePosition = (wall: NonNullable<StructuralBaseline["wallDescriptors"]>[number], side: "left" | "right"): string => {
    const visible = side === "left" ? wall.leftCornerVisible === true : wall.rightCornerVisible === true;
    if (!visible) return "none";
    const sideBoundaryVisible = side === "left" ? wall.leftBoundaryVisible === true : wall.rightBoundaryVisible === true;
    const oppositeBoundaryVisible = side === "left" ? wall.rightBoundaryVisible === true : wall.leftBoundaryVisible === true;
    if (wall.visibility === "minimal") return "image edge";
    if (sideBoundaryVisible && !oppositeBoundaryVisible) return "image edge";
    if (sideBoundaryVisible && oppositeBoundaryVisible) return "near image edge";
    return "inner third";
  };
  const edgeCornerVisibility = (wall: NonNullable<StructuralBaseline["wallDescriptors"]>[number], side: "left" | "right"): string => {
    const visible = side === "left" ? wall.leftCornerVisible === true : wall.rightCornerVisible === true;
    if (!visible) return "none";
    if (wall.visibility === "minimal") return "trace";
    if (wall.visibility === "partial") return "partial";
    if (wall.visibility === "substantial" || wall.visibility === "dominant") return "substantial";
    return "complete";
  };
  const adjacentWallVisibility = (wall: NonNullable<StructuralBaseline["wallDescriptors"]>[number], side: "left" | "right"): string => {
    const visible = side === "left" ? wall.leftCornerVisible === true : wall.rightCornerVisible === true;
    if (!visible) return "none";
    if (wall.visibility === "minimal") return "minimal";
    if (wall.visibility === "partial") return "partial";
    if (wall.visibility === "substantial" || wall.visibility === "dominant") return "substantial";
    return "full";
  };
  return [
    `- ${label}: present`,
    `- wall count: ${walls.length}`,
    `- opening count: ${openings.length}`,
    `- anchor fixture count: ${fixtures.length}`,
    ...(walls.length > 0
      ? walls.map((wall) => `- wall ${wall.wallIndex}: visibility=${wall.visibility}, extent=${wall.visibleExtent || wall.visibility}, certainty=${wall.architecturalCertainty || "unknown"}, leftCorner=${wall.leftCornerVisible === true ? "yes" : "no"}, leftCornerPosition=${edgePosition(wall, "left")}, leftCornerVisibility=${edgeCornerVisibility(wall, "left")}, leftAdjacentWallVisibility=${adjacentWallVisibility(wall, "left")}, rightCorner=${wall.rightCornerVisible === true ? "yes" : "no"}, rightCornerPosition=${edgePosition(wall, "right")}, rightCornerVisibility=${edgeCornerVisibility(wall, "right")}, rightAdjacentWallVisibility=${adjacentWallVisibility(wall, "right")}, continuesBeyondFrame=${wall.continuesBeyondFrame === true ? "yes" : "no"} -- ${wall.description}`)
      : ["- wall descriptors: none"]),
    ...(openings.length > 0
      ? openings.map((opening) => `- opening ${opening.id}: ${opening.type} on wall ${opening.wallIndex} at ${opening.horizontalBand}/${opening.verticalBand} (confidence ${opening.confidence})`)
      : ["- openings: none"]),
    ...(fixtures.length > 0
      ? fixtures.map((fixture) => `- fixture ${fixture.id}: ${fixture.type} on wall ${fixture.wallIndex} at ${fixture.horizontalBand} (confidence ${fixture.confidence})`)
      : ["- anchor fixtures: none"]),
  ];
}

function linesForExtractionIntegrity(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const integrity = result.stagedExtractionIntegrity;
  if (!integrity) return ["- none"];
  return [
    `- passed: ${integrity.passed ? "YES" : "NO"}`,
    `- final evaluated attempt: ${integrity.attempt}`,
    `- mapping confidence threshold: ${integrity.mappingConfidenceThreshold}`,
    ...(integrity.issues.length > 0
      ? integrity.issues.map((issue) => `- ${issue.code}: ${issue.message}`)
      : ["- issues: none"]),
  ];
}

function linesForRetryStatus(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const retry = result.stagedExtractionRetryStatus;
  if (!retry) return ["- none"];
  return [
    `- retry triggered: ${retry.triggered ? "YES" : "NO"}`,
    `- total attempts: ${retry.attempts}`,
    `- final attempt: ${retry.finalAttempt}`,
    `- retry succeeded: ${retry.retrySucceeded ? "YES" : "NO"}`,
    `- reason: ${retry.reason || "none"}`,
  ];
}

function linesForCandidateSurfaces(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const candidates = result.baselineCandidateWallQualifications || [];
  if (candidates.length === 0) return ["- none"];
  return candidates.flatMap((candidate) => [
    `- ${candidate.candidateId}`,
    `  advisory positional label: ${candidate.advisoryPositionalLabel}`,
    `  qualification decision: ${candidate.qualificationDecision}`,
    `  qualification score: ${candidate.qualificationScore}`,
    `  primary semantic anchor: ${candidate.primaryAnchorLabel || "none"}`,
    `  raw architectural features: ${candidate.rawArchitecturalFeatures.length > 0 ? candidate.rawArchitecturalFeatures.join(", ") : "none"}`,
    `  evidence breakdown: ${candidate.evidenceBreakdown.join(" | ")}`,
    `  reason: ${candidate.qualificationReason}`,
  ]);
}

function linesForAdvisoryGeometry(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const geometry = result.baselineAdvisoryGeometry || [];
  if (geometry.length === 0) return ["- none"];
  return geometry.flatMap((item) => [
    `- ${item.candidateId} (${item.advisoryPositionalLabel})`,
    `  qualification decision: ${item.qualificationDecision}`,
    `  primary semantic anchor: ${item.primaryAnchorLabel || "none"}`,
    `  raw architectural features: ${item.rawArchitecturalFeatures.length > 0 ? item.rawArchitecturalFeatures.join(", ") : "none"}`,
    `  descriptor: ${item.descriptor}`,
    `  evidence breakdown: ${item.evidenceBreakdown.join(" | ")}`,
    `  reason: ${item.qualificationReason}`,
  ]);
}

function linesForWallVerifications(
  verifications: NonNullable<Awaited<ReturnType<typeof runEnvelopeValidator>>["stagedWallVerifications"]> | NonNullable<Awaited<ReturnType<typeof runEnvelopeValidator>>["initialStagedWallVerifications"]>,
): string[] {
  if (!verifications || verifications.length === 0) return ["- none"];
  return verifications.flatMap((item) => {
    const lines = [
      `- ${item.displayName} [${item.semanticWallId}]`,
      `  primary semantic anchor: ${item.primaryAnchorLabel || "none"}`,
      `  same permanent wall visible: ${item.samePermanentWallVisible}`,
      `  wall visibility: ${item.wallVisibility || "unknown"}`,
      `  wall extent: ${item.wallExtent || "unknown"}`,
      `  architectural certainty: ${item.architecturalCertainty || "unknown"}`,
      `  confidence: ${typeof item.confidence === "number" ? String(item.confidence) : "unknown"}`,
      `  reason: ${item.reason || "none"}`,
    ];
    if (item.observations.length > 0) {
      lines.push("  observations:");
      lines.push(...item.observations.map((observation) => `    - ${observation}`));
    } else {
      lines.push("  observations: none");
    }
    lines.push(`  derived continues beyond frame: ${typeof item.continuesBeyondFrame === "boolean" ? String(item.continuesBeyondFrame) : "unknown"}`);
    lines.push(`  derived terminates at corner: ${typeof item.terminatesAtCorner === "boolean" ? String(item.terminatesAtCorner) : "unknown"}`);
    lines.push(`  derived left corner visible: ${typeof item.leftCornerVisible === "boolean" ? String(item.leftCornerVisible) : "unknown"}`);
    lines.push(`  derived right corner visible: ${typeof item.rightCornerVisible === "boolean" ? String(item.rightCornerVisible) : "unknown"}`);
    lines.push(`  left corner position: ${item.leftCornerPosition || "unknown"}`);
    lines.push(`  left corner visibility: ${item.leftCornerVisibility || "unknown"}`);
    lines.push(`  left adjacent wall visibility: ${item.leftAdjacentWallVisibility || "unknown"}`);
    lines.push(`  right corner position: ${item.rightCornerPosition || "unknown"}`);
    lines.push(`  right corner visibility: ${item.rightCornerVisibility || "unknown"}`);
    lines.push(`  right adjacent wall visibility: ${item.rightAdjacentWallVisibility || "unknown"}`);
    lines.push(`  derived return wall visible: ${typeof item.returnWallVisible === "boolean" ? String(item.returnWallVisible) : "unknown"}`);
    lines.push(`  derived adjoining wall visible: ${typeof item.adjoiningWallVisible === "boolean" ? String(item.adjoiningWallVisible) : "unknown"}`);
    lines.push(`  derived recess visible: ${typeof item.recessVisible === "boolean" ? String(item.recessVisible) : "unknown"}`);
    lines.push(`  return wall visibility significance: ${item.returnWallVisibilityMagnitude || "unknown"}`);
    lines.push(`  adjoining wall visibility significance: ${item.adjoiningWallVisibilityMagnitude || "unknown"}`);
    lines.push(`  recess visibility significance: ${item.recessVisibilityMagnitude || "unknown"}`);
    return lines;
  });
}

function linesForAdditionalWallPlanes(
  additionalWallPlanes: Awaited<ReturnType<typeof runEnvelopeValidator>>["additionalWallPlanes"] | Awaited<ReturnType<typeof runEnvelopeValidator>>["initialAdditionalWallPlanes"],
): string[] {
  if (!additionalWallPlanes) return ["- none"];
  return [
    `- answer: ${additionalWallPlanes.answer}`,
    `- confidence: ${typeof additionalWallPlanes.confidence === "number" ? String(additionalWallPlanes.confidence) : "unknown"}`,
    `- reason: ${additionalWallPlanes.reason || "none"}`,
    ...(additionalWallPlanes.descriptions.length > 0
      ? additionalWallPlanes.descriptions.map((description) => `- description: ${description}`)
      : ["- description: none"]),
  ];
}

function linesForDeterministicInterpretations(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const interpretations = result.deterministicStructuralInterpretations || [];
  if (interpretations.length === 0) return ["- none"];
  return interpretations.flatMap((item) => [
    `- ${item.category}: ${item.summary}`,
    `  wall: ${item.wallDisplayName || "n/a"}`,
    `  detected: ${item.detectedFeature || item.category}`,
    `  associated wall: ${item.associatedWallMagnitude || "unknown"}`,
    `  classification: ${item.classification || "unknown"}`,
    `  decision: ${(item.decision || (item.severity === "significant" ? "fail" : "pass")).toUpperCase()}`,
    `  explanation: ${item.explanation || "none"}`,
    `  severity: ${item.severity}`,
    `  confidence: ${item.confidence}`,
    `  supporting facts: ${item.supportingFacts.length > 0 ? item.supportingFacts.join(" | ") : "none"}`,
    `  corroborating evidence: ${item.corroboratingEvidence.length > 0 ? item.corroboratingEvidence.join(" | ") : "none"}`,
    `  contradicting evidence: ${item.contradictingEvidence.length > 0 ? item.contradictingEvidence.join(" | ") : "none"}`,
  ]);
}

function linesForAdditionalArchitecturalEvidence(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const evidence = result.additionalArchitecturalEvidence;
  if (!evidence) return ["- none"];
  return [
    ...(evidence.observedFeatures.length > 0
      ? evidence.observedFeatures.map((feature) => `- ${feature}`)
      : ["- none"]),
    `- additional permanent wall plane visibility significance: ${evidence.additionalPermanentWallPlaneVisibilityMagnitude || "unknown"}`,
    `- additional permanent return wall visibility significance: ${evidence.additionalPermanentReturnWallVisibilityMagnitude || "unknown"}`,
    `- additional permanent recess visibility significance: ${evidence.additionalPermanentRecessVisibilityMagnitude || "unknown"}`,
    `- additional permanent corner visibility significance: ${evidence.additionalPermanentCornerVisibilityMagnitude || "unknown"}`,
    `- confidence: ${typeof evidence.confidence === "number" ? String(evidence.confidence) : "unknown"}`,
    `- reason: ${evidence.reason || "none"}`,
  ];
}

function linesForSemanticWallModel(
  walls: NonNullable<Awaited<ReturnType<typeof runEnvelopeValidator>>["semanticBaselineWallModel"]> | NonNullable<Awaited<ReturnType<typeof runEnvelopeValidator>>["semanticStagedWallModel"]>,
): string[] {
  if (!walls || walls.length === 0) return ["- none"];
  return walls.flatMap((wall) => [
    `- ${wall.displayName} [${wall.semanticWallId}]`,
    `  primary semantic anchor: ${wall.primaryAnchorLabel || "none"}`,
    `  secondary architectural features: ${wall.secondaryArchitecturalFeatures.length > 0 ? wall.secondaryArchitecturalFeatures.join(", ") : "none"}`,
    `  raw architectural features: ${wall.rawArchitecturalFeatures.length > 0 ? wall.rawArchitecturalFeatures.join(", ") : "none"}`,
    `  advisory positional label: ${wall.advisoryPositionalLabel}`,
    `  identity ambiguity: ${wall.identityAmbiguity || "none"}`,
    `  geometry: ${wall.geometryLines.join(" | ")}`,
  ]);
}

function linesForWallMatches(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const matches = result.semanticWallMatches || [];
  if (matches.length === 0) return ["- none"];
  return matches.map((match) => {
    if (!match.matched) {
      return `- ${match.baselineDisplayName} -> ${match.stagedDisplayName || "unmatched"} (score ${match.score}): ${match.reasons.join("; ")}`;
    }
    return `- ${match.baselineDisplayName} -> ${match.stagedDisplayName} (score ${match.score}): ${match.reasons.join("; ")}`;
  });
}

function linesForDeterministicComparison(result: Awaited<ReturnType<typeof runEnvelopeValidator>>): string[] {
  const comparison = result.deterministicEnvelopeComparison;
  if (!comparison) return ["- none"];
  const semanticWalls = result.semanticBaselineWallModel || [];
  const semanticNameByIndex = new Map(semanticWalls.map((wall) => [wall.advisoryWallIndex, wall.displayName] as const));
  const positionalAliases = new Map(semanticWalls.map((wall) => [wall.advisoryWallIndex, [wall.advisoryPositionalLabel, `${wall.advisoryPositionalLabel.replace(" wall", "")} / camera-facing wall`, `${wall.advisoryPositionalLabel.replace(/^./, (value) => value.toUpperCase())}`]] as const));

  const rewriteNote = (wallIndex: number, note: string) => {
    const semanticName = semanticNameByIndex.get(wallIndex);
    if (!semanticName) return note;
    const aliases = positionalAliases.get(wallIndex) || [];
    let rewritten = note;
    for (const alias of aliases) {
      rewritten = rewritten.replace(alias, semanticName);
    }
    return rewritten;
  };

  return [
    `- baseline wall count: ${comparison.baselineWallCount}`,
    `- staged wall count: ${comparison.stagedWallCount}`,
    ...(comparison.suspicions.length > 0
      ? comparison.suspicions.map((item) => `- ${item.observationId}: ${rewriteNote(item.wallIndex, item.note)}`)
      : ["- no deterministic suspicions"]),
  ];
}

async function main(): Promise<void> {
  const baselinePath = path.join(TEST_IMAGE_DIR, JOB.baselineFile);
  const stagedPath = path.join(TEST_IMAGE_DIR, JOB.stagedFile);
  await downloadIfMissing((JOB as typeof JOB & { baselineUrl?: string }).baselineUrl, baselinePath);
  await downloadIfMissing((JOB as typeof JOB & { stagedUrl?: string }).stagedUrl, stagedPath);
  await fs.access(baselinePath);
  await fs.access(stagedPath);

  const baseline = await extractStructuralBaseline(baselinePath, {
    jobId: JOB.jobId,
    imageId: JOB.imageId,
    attempt: 1,
  });

  const result = await runEnvelopeValidator(baselinePath, stagedPath, {
    jobId: JOB.jobId,
    imageId: JOB.imageId,
    attempt: 1,
    baseline,
  });

  const reportLines = [
    `# Envelope Constraint Verification Report - ${JOB.label}`,
    "",
    "## Pipeline Status",
    "- Default envelope validator pipeline: baseline extraction -> qualified semantic walls + advisory geometry -> guided staged extraction -> extraction integrity gate -> deterministic comparison -> deterministic structural interpretation -> PASS / FAIL.",
    "- Semantic wall repair, blank-wall promotion, and identity regeneration are not used in this replay.",
    "- Environment variables required to enable constraint verification: none.",
    "",
    "---",
    "",
    "## Baseline Candidate Surfaces",
    ...linesForCandidateSurfaces(result),
    "",
    "---",
    "",
    "## Baseline Extraction",
    ...linesForStructuralBaseline("baseline extraction", baseline),
    "",
    "---",
    "",
    "## Qualified Baseline Semantic Walls",
    ...linesForSemanticWallModel(result.semanticBaselineWallModel || []),
    "",
    "---",
    "",
    "## Baseline Advisory Geometry",
    ...linesForAdvisoryGeometry(result),
    "",
    "---",
    "",
    "## Gemini Observations Summary",
    ...(result.initialAdvisoryStageExtraction ? [result.initialAdvisoryStageExtraction] : ["(not available)"]),
    "",
    "---",
    "",
    "## Gemini Observations - Initial Wall Facts",
    ...linesForWallVerifications(result.initialStagedWallVerifications || []),
    "",
    "---",
    "",
    "## Extraction Integrity Gate",
    ...linesForExtractionIntegrity(result),
    "",
    "---",
    "",
    "## Retry Status",
    ...linesForRetryStatus(result),
    "",
    "---",
    "",
    "## Gemini Observations - Final Summary",
    ...(result.advisoryStageExtraction ? [result.advisoryStageExtraction] : ["(not available)"]),
    "",
    "---",
    "",
    "## Gemini Observations - Final Wall Facts",
    ...linesForWallVerifications(result.stagedWallVerifications || []),
    "",
    "---",
    "",
    "## Deterministic Observations",
    ...linesForDeterministicComparison(result),
    "",
    "---",
    "",
    "## Deterministic Interpretation",
    ...linesForDeterministicInterpretations(result),
    "",
    "---",
    "",
    "## Additional Observed Architectural Features",
    ...linesForAdditionalArchitecturalEvidence(result),
    "",
    "---",
    "",
    "## Final Envelope Decision",
    ...linesForFinalDecision(result),
    "",
    "---",
    "",
    "## Guided Observation Prompt",
    result.guidedObservationPrompt || result.finalGeminiPrompt || "(not available)",
    "",
    "---",
    "",
    "## Guided Observation Gemini JSON",
    result.guidedObservationRawGeminiJson || result.rawGeminiJson || "(not available)",
  ];

  const outputDir = path.join(__dirname, "../reports");
  await fs.mkdir(outputDir, { recursive: true });

  const markdownPath = path.join(outputDir, `envelope-constraint-verification-${JOB.label}.md`);
  const jsonPath = path.join(outputDir, `envelope-constraint-verification-${JOB.label}.json`);

  await fs.writeFile(markdownPath, `${reportLines.join("\n")}\n`, "utf8");
  await fs.writeFile(jsonPath, JSON.stringify({
    job: JOB,
    baselinePath,
    stagedPath,
    pipelineStatus: {
      defaultConstraintVerificationPipeline: true,
      legacyGatedPathUsed: false,
      requiredEnvVars: [],
    },
    result,
  }, null, 2), "utf8");

  console.log(JSON.stringify({
    markdownPath,
    jsonPath,
    status: result.status,
    confidence: result.confidence,
    verificationMode: result.constraintVerificationMode || result.baselineVerificationMode,
  }, null, 2));
}

main().catch((error) => {
  console.error("[envelope-constraint-verification-report] failed", error);
  process.exitCode = 1;
});