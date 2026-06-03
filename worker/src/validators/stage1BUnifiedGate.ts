import type { Stage1BValidationMode } from "./geminiSemanticValidator";
import {
  runUnifiedValidation,
  type UnifiedValidationResult,
} from "./runValidation";

export interface Stage1BUnifiedGateParams {
  baselinePath: string;
  candidatePath: string;
  sceneType: "interior" | "exterior";
  roomType?: string;
  jobId?: string;
  imageId?: string;
  stagingStyle?: string;
  stage1BValidationMode: Stage1BValidationMode;
}

export interface Stage1BUnifiedGateDecision {
  passed: boolean;
  hardFail: boolean;
  reasons: string[];
  issueType?: string;
  durationMs: number;
  result: UnifiedValidationResult;
}

export async function runStage1BUnifiedGate(
  params: Stage1BUnifiedGateParams
): Promise<Stage1BUnifiedGateDecision> {
  const startedAt = Date.now();
  const result = await runUnifiedValidation({
    originalPath: params.baselinePath,
    enhancedPath: params.candidatePath,
    stage: "1B",
    sceneType: params.sceneType,
    roomType: params.roomType,
    mode: "enforce",
    jobId: params.jobId,
    imageId: params.imageId,
    stagingStyle: params.stagingStyle,
    stage1APath: params.baselinePath,
    sourceStage: "1A",
    stage1BValidationMode: params.stage1BValidationMode,
    geminiPolicy: "always",
  });

  const passed = result.passed === true && result.hardFail !== true;

  return {
    passed,
    hardFail: result.hardFail === true,
    reasons: Array.isArray(result.reasons) ? result.reasons : [],
    issueType: result.issueType,
    durationMs: Math.max(0, Date.now() - startedAt),
    result,
  };
}
