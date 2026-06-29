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
const JOB = {
  label: "job_bb029607",
  jobId: "job_bb029607-dcd8-4614-997c-406d2ed33142",
  imageId: "img_e75a5903-34d3-42a2-b93f-b29314a5138d",
  baselineFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c.jpg",
  stagedFile: "1782337783430-realenhance-job_bb029607-dcd8-4614-997c-406d2ed33142-1782337782828-5pbiinwfb7c-stage2.jpg",
};

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
  return [
    `- ${label}: present`,
    `- wall count: ${walls.length}`,
    `- opening count: ${openings.length}`,
    `- anchor fixture count: ${fixtures.length}`,
    ...(walls.length > 0
      ? walls.map((wall) => `- wall ${wall.wallIndex}: visibility=${wall.visibility}, extent=${wall.visibleExtent || wall.visibility}, certainty=${wall.architecturalCertainty || "unknown"}, leftCorner=${wall.leftCornerVisible === true ? "yes" : "no"}, rightCorner=${wall.rightCornerVisible === true ? "yes" : "no"}, continuesBeyondFrame=${wall.continuesBeyondFrame === true ? "yes" : "no"} -- ${wall.description}`)
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
  return verifications.flatMap((item) => [
    `- ${item.displayName} [${item.semanticWallId}]`,
    `  primary semantic anchor: ${item.primaryAnchorLabel || "none"}`,
    `  same permanent wall visible: ${item.samePermanentWallVisible}`,
    `  wall visibility: ${item.wallVisibility || "unknown"}`,
    `  wall extent: ${item.wallExtent || "unknown"}`,
    `  left corner visible: ${typeof item.leftCornerVisible === "boolean" ? String(item.leftCornerVisible) : "unknown"}`,
    `  right corner visible: ${typeof item.rightCornerVisible === "boolean" ? String(item.rightCornerVisible) : "unknown"}`,
    `  continues beyond frame: ${typeof item.continuesBeyondFrame === "boolean" ? String(item.continuesBeyondFrame) : "unknown"}`,
    `  terminates at corner: ${typeof item.terminatesAtCorner === "boolean" ? String(item.terminatesAtCorner) : "unknown"}`,
    `  return wall visible: ${typeof item.returnWallVisible === "boolean" ? String(item.returnWallVisible) : "unknown"}`,
    `  adjoining wall visible: ${typeof item.adjoiningWallVisible === "boolean" ? String(item.adjoiningWallVisible) : "unknown"}`,
    `  recess visible: ${typeof item.recessVisible === "boolean" ? String(item.recessVisible) : "unknown"}`,
    `  confidence: ${typeof item.confidence === "number" ? String(item.confidence) : "unknown"}`,
    `  reason: ${item.reason || "none"}`,
    `  observations: ${item.observations.length > 0 ? item.observations.join(" | ") : "none"}`,
  ]);
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
    `- additional permanent wall planes: ${evidence.additionalPermanentWallPlanes}`,
    `- additional permanent wall plane descriptions: ${evidence.additionalPermanentWallPlaneDescriptions.length > 0 ? evidence.additionalPermanentWallPlaneDescriptions.join(" | ") : "none"}`,
    `- additional permanent return walls: ${evidence.additionalPermanentReturnWalls}`,
    `- additional permanent return wall descriptions: ${evidence.additionalPermanentReturnWallDescriptions.length > 0 ? evidence.additionalPermanentReturnWallDescriptions.join(" | ") : "none"}`,
    `- additional permanent recesses: ${evidence.additionalPermanentRecesses}`,
    `- additional permanent recess descriptions: ${evidence.additionalPermanentRecessDescriptions.length > 0 ? evidence.additionalPermanentRecessDescriptions.join(" | ") : "none"}`,
    `- additional permanent corners: ${evidence.additionalPermanentCorners}`,
    `- additional permanent corner descriptions: ${evidence.additionalPermanentCornerDescriptions.length > 0 ? evidence.additionalPermanentCornerDescriptions.join(" | ") : "none"}`,
    `- unmatched permanent architectural features: ${evidence.unmatchedPermanentArchitecturalFeatures}`,
    `- unmatched permanent feature descriptions: ${evidence.unmatchedPermanentFeatureDescriptions.length > 0 ? evidence.unmatchedPermanentFeatureDescriptions.join(" | ") : "none"}`,
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
    "## Guided Staged Wall Observations",
    ...(result.initialAdvisoryStageExtraction ? [result.initialAdvisoryStageExtraction] : ["(not available)"]),
    "",
    "---",
    "",
    "## Initial Guided Staged Wall Observations",
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
    "## Final Guided Staged Observation",
    ...(result.advisoryStageExtraction ? [result.advisoryStageExtraction] : ["(not available)"]),
    "",
    "---",
    "",
    "## Final Guided Staged Wall Observations",
    ...linesForWallVerifications(result.stagedWallVerifications || []),
    "",
    "---",
    "",
    "## Deterministic Observations",
    ...linesForDeterministicComparison(result),
    "",
    "---",
    "",
    "## Deterministic Structural Interpretations",
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