// server/src/services/analysisOrchestrator.ts
// Orchestrates the analysis process

import {
  createAnalysis,
  completeAnalysis,
  failAnalysis,
  getLatestAnalysisForJob,
  hasPendingAnalysis,
} from "@realenhance/shared/analysis/storage.js";
import type { JobAnalysis, AnalysisTrigger } from "@realenhance/shared/analysis/types.js";
import { runGeminiAnalysis, isAnalysisEnabled, PROMPT_VERSION, getAnalysisConfig } from "./geminiAnalysis.js";
import { packageJobDataForAnalysis } from "./analysisDataPackager.js";

const GEMINI_MODEL_ANALYSIS = process.env.GEMINI_MODEL_ANALYSIS || "gemini-2.5-flash";
const ANALYSIS_RUN_ON_FAILURE = process.env.ANALYSIS_RUN_ON_FAILURE !== "false"; // default true

/**
 * Run analysis for a job
 * This is the main entry point for creating and running an analysis
 */
export async function runAnalysisForJob(
  jobId: string,
  trigger: AnalysisTrigger
): Promise<JobAnalysis> {
  console.log(`[ANALYSIS] Starting analysis for job ${jobId} (trigger: ${trigger})`);

  // Check if analysis is enabled
  if (!isAnalysisEnabled()) {
    throw new Error("Analysis feature is not enabled or configured");
  }

  // Check for existing pending analysis (idempotency)
  if (hasPendingAnalysis(jobId)) {
    console.log(`[ANALYSIS] Job ${jobId} already has pending analysis`);
    const existing = getLatestAnalysisForJob(jobId);
    if (existing) {
      return existing;
    }
  }

  try {
    // Package job data
    console.log(`[ANALYSIS] Packaging data for job ${jobId}...`);
    const jobData = await packageJobDataForAnalysis(jobId);

    // Create analysis record
    const analysis = createAnalysis({
      jobId,
      trigger,
      model: GEMINI_MODEL_ANALYSIS,
      promptVersion: PROMPT_VERSION,
      inputSummary: jobData.inputSummary,
    });

    // Run Gemini analysis
    console.log(`[ANALYSIS] Calling Gemini API for analysis ${analysis.id}...`);
    try {
      const { output, rawText } = await runGeminiAnalysis(jobData);

      // Complete analysis
      const completed = completeAnalysis(analysis.id, output, rawText);
      console.log(`[ANALYSIS] Completed analysis ${analysis.id} for job ${jobId}`);
      return completed;
    } catch (aiError) {
      // Fail analysis
      const errorMsg = aiError instanceof Error ? aiError.message : String(aiError);
      const failed = failAnalysis(analysis.id, errorMsg);
      console.error(`[ANALYSIS] Failed analysis ${analysis.id}:`, errorMsg);
      return failed;
    }
  } catch (error) {
    console.error(`[ANALYSIS] Error starting analysis for job ${jobId}:`, error);
    throw error;
  }
}

/**
 * Auto-trigger analysis on job failure
 * Call this from job completion handler
 */
export async function autoTriggerAnalysisOnFailure(
  jobId: string,
  jobStatus: string
): Promise<void> {
  // Check if auto-trigger is enabled
  if (!ANALYSIS_RUN_ON_FAILURE) {
    console.log(`[ANALYSIS] Auto-trigger disabled for job ${jobId}`);
    return;
  }

  // Check if analysis is enabled
  if (!isAnalysisEnabled()) {
    console.log(`[ANALYSIS] Analysis feature not available for job ${jobId}`);
    return;
  }

  // Only trigger on FAILED or DEGRADED status
  if (jobStatus !== "FAILED" && jobStatus !== "DEGRADED") {
    return;
  }

  // Check if already has pending or recent analysis
  if (hasPendingAnalysis(jobId)) {
    console.log(`[ANALYSIS] Job ${jobId} already has pending analysis, skipping auto-trigger`);
    return;
  }

  const existing = getLatestAnalysisForJob(jobId);
  if (existing && existing.status === "COMPLETE") {
    // Check if analysis is recent (within 1 hour)
    const ageMs = Date.now() - new Date(existing.createdAt).getTime();
    if (ageMs < 3600000) {
      console.log(`[ANALYSIS] Job ${jobId} has recent analysis, skipping auto-trigger`);
      return;
    }
  }

  // Run analysis in background (don't await to avoid blocking)
  console.log(`[ANALYSIS] Auto-triggering analysis for failed job ${jobId}`);
  runAnalysisForJob(jobId, "AUTO_ON_FAIL").catch((error) => {
    console.error(`[ANALYSIS] Auto-trigger failed for job ${jobId}:`, error);
  });
}

/**
 * Get analysis configuration
 */
export function getConfig() {
  return {
    ...getAnalysisConfig(),
    autoTrigger: ANALYSIS_RUN_ON_FAILURE,
  };
}
