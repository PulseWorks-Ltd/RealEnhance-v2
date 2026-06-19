import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import https from "https";
import { runOpeningValidator } from "../worker/src/validators/openingValidator";
import { runFixtureValidator } from "../worker/src/validators/fixtureValidator";
import { runFloorIntegrityValidator } from "../worker/src/validators/floorIntegrityValidator";
import { runEnvelopeValidator } from "../worker/src/validators/envelopeValidator";
import { runUnifiedValidation } from "../worker/src/validators/runValidation";
import { runStage2GenerationAttempt } from "../worker/src/pipeline/stage2";
import { accumulateValidatorTriggers, buildAutoRetryGuidance } from "../worker/src/pipeline/validatorRetryGuidance";

type Name = "opening" | "fixture" | "floor" | "envelope";

type SpecialistBundle = {
  opening: any;
  fixture: any;
  floor: any;
  envelope: any;
  advisorySignals: string[];
};

const JOB_ID = "job_0a649ccd-e39d-48e8-aa5b-b081391fee82";
const IMAGE_ID = "img_e9cefb64-085e-43d6-aa89-011537106dea";

const BASE_DIR = "/workspaces/RealEnhance-v2/analysis/validator_retry_replay_job_0a649ccd";
const INPUT_DIR = path.join(BASE_DIR, "inputs");
const OUTPUT_DIR = path.join(BASE_DIR, "outputs");
const EVIDENCE_DIR = path.join(BASE_DIR, "evidence");

const URLS = {
  stage1A: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1781818259681-realenhance-job_0a649ccd-e39d-48e8-aa5b-b081391fee82-1781818236310-9cq0svnrr87-canonical-1A-1a-delivery.jpg",
  historicalAttempt1: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/debug-attempts/job_0a649ccd-e39d-48e8-aa5b-b081391fee82/realenhance-job_0a649ccd-e39d-48e8-aa5b-b081391fee82-1781818236310-9cq0svnrr87-canonical-1A-2.webp",
  historicalAttempt2: "https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/debug-attempts/job_0a649ccd-e39d-48e8-aa5b-b081391fee82/realenhance-job_0a649ccd-e39d-48e8-aa5b-b081391fee82-1781818236310-9cq0svnrr87-canonical-1A-2-retry1.webp",
};

function download(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(outPath, { force: true });
        return resolve(download(res.headers.location, outPath));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`download_failed status=${res.statusCode} url=${url}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });
    req.on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

function collectSignals(r: any): string[] {
  const out: string[] = [];
  if (Array.isArray(r?.advisorySignals)) {
    out.push(...r.advisorySignals.filter((x: any) => typeof x === "string"));
  }
  if (typeof r?.issueType === "string" && r.issueType !== "none") {
    out.push(r.issueType);
  }
  return [...new Set(out.map((s) => String(s).trim()).filter(Boolean))];
}

function toStage2Triggers(bundle: SpecialistBundle): string[] {
  const bySource: Record<Name, string[]> = {
    opening: collectSignals(bundle.opening),
    fixture: collectSignals(bundle.fixture),
    floor: collectSignals(bundle.floor),
    envelope: collectSignals(bundle.envelope),
  };

  let triggers: string[] = [];
  triggers = accumulateValidatorTriggers(triggers, bySource.opening);
  triggers = accumulateValidatorTriggers(triggers, bySource.fixture);
  triggers = accumulateValidatorTriggers(triggers, bySource.floor);
  triggers = accumulateValidatorTriggers(triggers, bySource.envelope);
  return triggers;
}

async function runSpecialists(basePath: string, candidatePath: string, context: { jobId: string; imageId: string; attempt: number }): Promise<SpecialistBundle> {
  const opening = await runOpeningValidator(basePath, candidatePath, context as any);
  const fixture = await runFixtureValidator(basePath, candidatePath, context as any);
  const floor = await runFloorIntegrityValidator(basePath, candidatePath, context as any);
  const envelope = await runEnvelopeValidator(basePath, candidatePath, context as any);
  const advisorySignals = [...new Set([
    ...collectSignals(opening),
    ...collectSignals(fixture),
    ...collectSignals(floor),
    ...collectSignals(envelope),
  ])];
  return { opening, fixture, floor, envelope, advisorySignals };
}

function openingSummary(opening: any) {
  const reason = String(opening?.reason || "");
  const visibility = reason.match(/opening_visibility_reduction:([0-9.]+)/)?.[1] || null;
  const resized = reason.match(/opening_resized_minor:([0-9.]+)/)?.[1] || null;
  const findings = Array.isArray(opening?.findings) ? opening.findings : [];
  return {
    status: opening?.status ?? null,
    issueType: opening?.issueType ?? null,
    issueTier: opening?.issueTier ?? null,
    confidence: opening?.confidence ?? null,
    reason,
    visibilityReduction: visibility ? Number(visibility) : null,
    resizedMinor: resized ? Number(resized) : null,
    findingCount: findings.length,
    locations: findings.map((f: any) => f?.location ?? null),
    overlapToBaseline: findings.map((f: any) => f?.overlapToBaseline ?? null),
  };
}

function unifiedSummary(unified: any) {
  return {
    passed: unified?.passed ?? null,
    hardFail: unified?.hardFail ?? null,
    blockSource: unified?.blockSource ?? null,
    score: unified?.score ?? null,
    issueType: unified?.issueType ?? null,
    issueTier: unified?.issueTier ?? null,
    warnings: unified?.warnings ?? [],
    reasons: unified?.reasons ?? [],
    modelUsed: unified?.modelUsed ?? null,
    profile: unified?.profile ?? null,
  };
}

async function runUnified(basePath: string, candidatePath: string, jobId: string, signals: string[]) {
  return runUnifiedValidation({
    originalPath: basePath,
    enhancedPath: candidatePath,
    stage: "2",
    sceneType: "interior",
    roomType: "bedroom",
    mode: "enforce",
    jobId,
    imageId: IMAGE_ID,
    stagingStyle: "standard_listing",
    stage1APath: basePath,
    sourceStage: "1A",
    validationMode: "FULL_STAGE_ONLY",
    geminiPolicy: "always",
    specialistAdvisorySignals: signals,
  } as any);
}

async function main() {
  await fsp.mkdir(INPUT_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await fsp.mkdir(EVIDENCE_DIR, { recursive: true });

  const stage1APath = path.join(INPUT_DIR, "stage1A_delivery.jpg");
  const historicalAttempt1Path = path.join(INPUT_DIR, "historical_attempt1.webp");
  const historicalAttempt2Path = path.join(INPUT_DIR, "historical_attempt2.webp");

  await download(URLS.stage1A, stage1APath);
  await download(URLS.historicalAttempt1, historicalAttempt1Path);
  await download(URLS.historicalAttempt2, historicalAttempt2Path);

  const attempt1Ctx = { jobId: `${JOB_ID}-replay-precheck`, imageId: IMAGE_ID, attempt: 1 };
  const specialistOnAttempt1 = await runSpecialists(stage1APath, historicalAttempt1Path, attempt1Ctx);

  const validatorTriggers = toStage2Triggers(specialistOnAttempt1);
  const guidance = buildAutoRetryGuidance({
    triggers: validatorTriggers,
    roomType: "bedroom",
    anchorWall: "right",
  });

  const promptDumpPath = path.join(EVIDENCE_DIR, "replay_stage2_final_prompt_attempt2.txt");
  process.env.STAGE2_PROMPT_VARIANT = process.env.STAGE2_PROMPT_VARIANT || "nano";
  process.env.STAGE2_DEBUG_PROMPT_DUMP_PATH = promptDumpPath;

  const replayAttempt2Path = path.join(OUTPUT_DIR, "replay_attempt2.webp");
  await runStage2GenerationAttempt(stage1APath, {
    roomType: "bedroom",
    sceneType: "interior",
    stagingStyle: "standard_listing",
    sourceStage: "1A",
    promptMode: "full",
    jobId: `${JOB_ID}-replay`,
    imageId: IMAGE_ID,
    outputPath: replayAttempt2Path,
    attempt: 2,
    retryType: "validator_forced_retry",
    retryInstructions: guidance.text || undefined,
    structuralRetryContext: {
      compositeFail: false,
      failureType: null,
      attemptNumber: 1,
    },
    modelReason: "stage2 unified retry 1",
  });

  const historicalAttempt2Ctx = { jobId: `${JOB_ID}-historical-attempt2`, imageId: IMAGE_ID, attempt: 2 };
  const replayAttempt2Ctx = { jobId: `${JOB_ID}-replay-attempt2`, imageId: IMAGE_ID, attempt: 2 };

  const historicalSpecialists = await runSpecialists(stage1APath, historicalAttempt2Path, historicalAttempt2Ctx);
  const replaySpecialists = await runSpecialists(stage1APath, replayAttempt2Path, replayAttempt2Ctx);

  const historicalUnified = await runUnified(stage1APath, historicalAttempt2Path, `${JOB_ID}-historical-unified`, historicalSpecialists.advisorySignals);
  const replayUnified = await runUnified(stage1APath, replayAttempt2Path, `${JOB_ID}-replay-unified`, replaySpecialists.advisorySignals);

  const report = {
    targetJobId: JOB_ID,
    imageId: IMAGE_ID,
    runAt: new Date().toISOString(),
    inputs: {
      stage1APath,
      historicalAttempt1Path,
      historicalAttempt2Path,
      historicalAttempt2Url: URLS.historicalAttempt2,
      historicalAttempt1Url: URLS.historicalAttempt1,
    },
    replay: {
      replayAttempt2Path,
      promptDumpPath,
      stage2PromptVariant: process.env.STAGE2_PROMPT_VARIANT,
      validatorTriggers,
      validatorInstructions: guidance.validatorInstructions,
      layoutInstruction: guidance.layoutInstruction,
      instructionCount: guidance.instructionCount,
      guidanceText: guidance.text,
    },
    historicalAttempt2: {
      opening: openingSummary(historicalSpecialists.opening),
      advisorySignals: historicalSpecialists.advisorySignals,
      unified: unifiedSummary(historicalUnified),
    },
    replayAttempt2: {
      opening: openingSummary(replaySpecialists.opening),
      advisorySignals: replaySpecialists.advisorySignals,
      unified: unifiedSummary(replayUnified),
    },
    raw: {
      specialistOnAttempt1,
      historicalSpecialists,
      replaySpecialists,
      historicalUnified,
      replayUnified,
    },
  };

  const reportPath = path.join(EVIDENCE_DIR, `replay_report_${Date.now()}.json`);
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`REPORT=${reportPath}`);
  console.log(`PROMPT=${promptDumpPath}`);
  console.log(`REPLAY_IMAGE=${replayAttempt2Path}`);
  console.log(JSON.stringify({
    instructionCount: guidance.instructionCount,
    guidanceLength: guidance.text?.length || 0,
    validatorInstructions: guidance.validatorInstructions,
    layoutInstruction: guidance.layoutInstruction,
    historical: {
      openingIssueType: report.historicalAttempt2.opening.issueType,
      openingReason: report.historicalAttempt2.opening.reason,
      unifiedPassed: report.historicalAttempt2.unified.passed,
      unifiedWarnings: report.historicalAttempt2.unified.warnings,
    },
    replay: {
      openingIssueType: report.replayAttempt2.opening.issueType,
      openingReason: report.replayAttempt2.opening.reason,
      unifiedPassed: report.replayAttempt2.unified.passed,
      unifiedWarnings: report.replayAttempt2.unified.warnings,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error("REPLAY_FAILED", err?.message || String(err));
  process.exit(1);
});
