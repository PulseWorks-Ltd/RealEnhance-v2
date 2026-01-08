// server/src/services/analysisDataPackager.ts
// Package job data for Gemini analysis

import type { AnalysisInputSummary } from "@realenhance/shared/analysis/types.js";
import type { AnalysisJobData } from "./geminiAnalysis.js";
import { getJob } from "./jobs.js";
import { getImageRecord } from "./images.js";
import { getS3SignedUrl } from "../utils/s3.js";

/**
 * Extract validator results from job
 */
function extractValidatorResults(job: any): Array<{
  name: string;
  passed: boolean;
  score?: number;
  message?: string;
}> {
  const results: Array<{ name: string; passed: boolean; score?: number; message?: string }> = [];

  // Check if job has validation results
  if (job.validationResults) {
    for (const [key, value] of Object.entries(job.validationResults)) {
      if (typeof value === "object" && value !== null) {
        results.push({
          name: key,
          passed: (value as any).passed === true,
          score: (value as any).score,
          message: (value as any).message || (value as any).reason,
        });
      }
    }
  }

  // Also check metadata for validator flags
  if (job.meta) {
    const validators = [
      "contentDiff",
      "lineEdge",
      "hallucination",
      "quality",
      "roomType",
      "declutter",
    ];

    for (const validator of validators) {
      const key = `${validator}Passed`;
      if (job.meta[key] !== undefined) {
        results.push({
          name: validator,
          passed: job.meta[key] === true,
          message: job.meta[`${validator}Message`] || undefined,
        });
      }
    }
  }

  return results;
}

/**
 * Extract validator logs from job
 */
function extractValidatorLogs(job: any): string[] {
  const logs: string[] = [];

  // Extract from job logs
  if (job.logs && Array.isArray(job.logs)) {
    for (const log of job.logs) {
      if (typeof log === "string") {
        if (log.includes("validator") || log.includes("FAIL") || log.includes("PASS")) {
          logs.push(log);
        }
      } else if (typeof log === "object") {
        logs.push(JSON.stringify(log, null, 2));
      }
    }
  }

  // Extract from validation results
  if (job.validationResults) {
    logs.push("=== Validation Results ===");
    logs.push(JSON.stringify(job.validationResults, null, 2));
  }

  // Extract from metadata
  if (job.meta) {
    const relevantMeta = {
      stage: job.meta.stage,
      declutter: job.meta.declutter,
      virtualStage: job.meta.virtualStage,
      roomType: job.meta.roomType,
      sceneType: job.meta.sceneType,
      errors: job.meta.errors,
      warnings: job.meta.warnings,
    };
    logs.push("=== Job Metadata ===");
    logs.push(JSON.stringify(relevantMeta, null, 2));
  }

  // If no logs found, add placeholder
  if (logs.length === 0) {
    logs.push("No validator logs available for this job");
  }

  return logs;
}

/**
 * Get image URLs with pre-signed S3 URLs
 */
async function getImageUrls(job: any, imageRecord: any): Promise<{
  original?: string;
  stage1A?: string;
  stage1B?: string;
  stage2?: string;
  failed?: string;
}> {
  const urls: any = {};

  try {
    // Original image
    if (imageRecord?.originalPath) {
      const s3Key = imageRecord.originalPath.replace(/^.*uploads\//, "");
      urls.original = await getS3SignedUrl(s3Key, 3600); // 1 hour expiry
    }

    // Stage outputs (check version history)
    if (imageRecord?.history && Array.isArray(imageRecord.history)) {
      for (const version of imageRecord.history) {
        const stage = version.stageLabel;
        if (version.filePath || version.s3Key) {
          const key = version.s3Key || version.filePath.replace(/^.*uploads\//, "");
          const signedUrl = await getS3SignedUrl(key, 3600);

          if (stage === "1A" || stage === "stage1A") {
            urls.stage1A = signedUrl;
          } else if (stage === "1B" || stage === "stage1B") {
            urls.stage1B = signedUrl;
          } else if (stage === "2" || stage === "stage2") {
            urls.stage2 = signedUrl;
          }
        }
      }
    }

    // Current/final output
    if (imageRecord?.outputUrl) {
      urls.failed = imageRecord.outputUrl;
    } else if (imageRecord?.filePath) {
      const key = imageRecord.filePath.replace(/^.*uploads\//, "");
      urls.failed = await getS3SignedUrl(key, 3600);
    }
  } catch (error) {
    console.error("[ANALYSIS] Error getting image URLs:", error);
  }

  return urls;
}

/**
 * Package job data for analysis
 */
export async function packageJobDataForAnalysis(jobId: string): Promise<AnalysisJobData> {
  const job = await getJob(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Get image record
  const imageRecord = job.imageId ? await getImageRecord(job.imageId) : null;

  // Build input summary
  const stages: string[] = [];
  // Infer stages from job payload options (for enhance jobs)
  if (job.payload && job.payload.type === "enhance") {
    const options = (job.payload as any).options;
    if (options?.declutter === false && options?.virtualStage === false) {
      stages.push("1A");
    } else if (options?.declutter === true && options?.virtualStage === false) {
      stages.push("1A", "1B");
    } else if (options?.virtualStage === true) {
      stages.push("1A", "1B", "2");
    }
  }
  // Fallback: if no stages determined, assume 1A at minimum
  if (stages.length === 0) {
    stages.push("1A");
  }

  const validatorResults = extractValidatorResults(job);
  const failFlags: Record<string, boolean> = {};
  const scoreHighlights: Record<string, number> = {};

  for (const result of validatorResults) {
    if (!result.passed) {
      failFlags[result.name] = true;
    }
    if (result.score !== undefined) {
      scoreHighlights[result.name] = result.score;
    }
  }

  // Get sceneType from payload options or meta
  let sceneType: string | undefined;
  if (job.payload && job.payload.type === "enhance") {
    sceneType = (job.payload as any).options?.sceneType;
  }
  if (!sceneType) {
    sceneType = job.meta?.scene?.label || (imageRecord?.meta as any)?.sceneType;
  }

  const inputSummary: AnalysisInputSummary = {
    jobId: job.jobId || job.id,
    stages,
    sceneType,
    validators: validatorResults.map((v) => v.name),
    failFlags,
    scoreHighlights,
    createdAt: job.createdAt || new Date().toISOString(),
  };

  // Get validator logs
  const validatorLogs = extractValidatorLogs(job);

  // Get image URLs
  const imageUrls = await getImageUrls(job, imageRecord);

  return {
    inputSummary,
    validatorLogs,
    validatorResults,
    imageUrls,
  };
}
