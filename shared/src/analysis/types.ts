// shared/src/analysis/types.ts
// Types for Auto Failure Analysis feature

export type AnalysisStatus = "PENDING" | "COMPLETE" | "FAILED";
export type AnalysisTrigger = "AUTO_ON_FAIL" | "MANUAL";
export type FinalOutcome = "PASS" | "FAIL" | "DEGRADED";
export type Classification = "REAL_IMAGE_ISSUE" | "SYSTEM_ISSUE" | "MIXED" | "INSUFFICIENT_EVIDENCE";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";

/**
 * Structured output from Gemini analysis
 */
export interface AnalysisOutput {
  job_summary: {
    stages_run: string[];
    final_outcome: FinalOutcome;
  };
  primary_issue: string;
  supporting_evidence: string[];
  assessment: {
    classification: Classification;
    confidence: Confidence;
    notes: string;
  };
  recommended_actions: {
    prompt_changes: string[];
    validator_adjustments: string[];
    pipeline_logic_changes: string[];
    model_changes: string[];
  };
  do_not_recommend: string[];
}

/**
 * Input summary sent to Gemini (minimal metadata)
 */
export interface AnalysisInputSummary {
  jobId: string;
  stages: string[];
  sceneType?: string;
  validators: string[];
  failFlags: Record<string, boolean>;
  scoreHighlights: Record<string, number>;
  createdAt: string;
}

/**
 * Job analysis record stored in database
 */
export interface JobAnalysis {
  id: string;
  jobId: string;
  status: AnalysisStatus;
  trigger: AnalysisTrigger;
  model: string;
  createdAt: string;
  completedAt?: string;
  promptVersion: string;
  inputSummary: AnalysisInputSummary;
  output?: AnalysisOutput;
  rawText?: string;
  error?: string;
}

/**
 * Request to create analysis
 */
export interface CreateAnalysisRequest {
  jobId: string;
  trigger: AnalysisTrigger;
}

/**
 * API response for analysis
 */
export interface AnalysisResponse {
  analysis: JobAnalysis;
}
