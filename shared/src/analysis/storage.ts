// shared/src/analysis/storage.ts
// Storage for job analysis results

import { readJsonFile, writeJsonFile } from "../jsonStore.js";
import type { JobAnalysis, AnalysisStatus, AnalysisTrigger, AnalysisInputSummary, AnalysisOutput } from "./types.js";
import crypto from "crypto";

const ANALYSIS_FILE = "job_analysis.json";

type AnalysisState = Record<string, JobAnalysis>;

function loadAnalyses(): AnalysisState {
  return readJsonFile<AnalysisState>(ANALYSIS_FILE, {});
}

function saveAnalyses(state: AnalysisState): void {
  writeJsonFile(ANALYSIS_FILE, state);
}

/**
 * Create a new analysis record
 */
export function createAnalysis(params: {
  jobId: string;
  trigger: AnalysisTrigger;
  model: string;
  promptVersion: string;
  inputSummary: AnalysisInputSummary;
}): JobAnalysis {
  const state = loadAnalyses();

  const analysis: JobAnalysis = {
    id: `analysis_${crypto.randomUUID()}`,
    jobId: params.jobId,
    status: "PENDING",
    trigger: params.trigger,
    model: params.model,
    createdAt: new Date().toISOString(),
    promptVersion: params.promptVersion,
    inputSummary: params.inputSummary,
  };

  state[analysis.id] = analysis;
  saveAnalyses(state);

  console.log(`[ANALYSIS] Created analysis ${analysis.id} for job ${params.jobId}`);
  return analysis;
}

/**
 * Update analysis with completion result
 */
export function completeAnalysis(
  analysisId: string,
  output: AnalysisOutput,
  rawText?: string
): JobAnalysis {
  const state = loadAnalyses();
  const analysis = state[analysisId];

  if (!analysis) {
    throw new Error(`Analysis ${analysisId} not found`);
  }

  analysis.status = "COMPLETE";
  analysis.completedAt = new Date().toISOString();
  analysis.output = output;
  analysis.rawText = rawText;

  saveAnalyses(state);
  console.log(`[ANALYSIS] Completed analysis ${analysisId}`);
  return analysis;
}

/**
 * Mark analysis as failed
 */
export function failAnalysis(analysisId: string, error: string): JobAnalysis {
  const state = loadAnalyses();
  const analysis = state[analysisId];

  if (!analysis) {
    throw new Error(`Analysis ${analysisId} not found`);
  }

  analysis.status = "FAILED";
  analysis.completedAt = new Date().toISOString();
  analysis.error = error;

  saveAnalyses(state);
  console.log(`[ANALYSIS] Failed analysis ${analysisId}: ${error}`);
  return analysis;
}

/**
 * Get analysis by ID
 */
export function getAnalysisById(analysisId: string): JobAnalysis | null {
  const state = loadAnalyses();
  return state[analysisId] || null;
}

/**
 * Get latest analysis for a job
 */
export function getLatestAnalysisForJob(jobId: string): JobAnalysis | null {
  const state = loadAnalyses();
  const analyses = Object.values(state)
    .filter((a) => a.jobId === jobId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return analyses[0] || null;
}

/**
 * Get all analyses for a job
 */
export function getAnalysesForJob(jobId: string): JobAnalysis[] {
  const state = loadAnalyses();
  return Object.values(state)
    .filter((a) => a.jobId === jobId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Check if job has pending analysis
 */
export function hasPendingAnalysis(jobId: string): boolean {
  const state = loadAnalyses();
  return Object.values(state).some(
    (a) => a.jobId === jobId && a.status === "PENDING"
  );
}

/**
 * Get recent analyses (for admin dashboard)
 */
export function getRecentAnalyses(limit: number = 50): JobAnalysis[] {
  const state = loadAnalyses();
  return Object.values(state)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}
