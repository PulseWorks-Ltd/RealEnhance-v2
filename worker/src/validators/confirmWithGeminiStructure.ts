import { runGeminiSemanticValidator } from "./geminiSemanticValidator";

type StageKey = "stage1b" | "stage2";

export async function confirmWithGeminiStructure(params: {
  baselinePathOrUrl: string;
  candidatePathOrUrl: string;
  stage: StageKey;
  roomType?: string;
  sceneType?: "interior" | "exterior";
  jobId?: string;
  localReasons: string[];
  localMetrics?: any;
}): Promise<{ confirmedFail: boolean; reasons: string[]; confidence?: number; raw?: any; status: "pass" | "fail" | "error" }> {
  const failOpen = (process.env.GEMINI_CONFIRM_FAIL_OPEN || "1") === "1";
  const reasons: string[] = [];

  try {
    const verdict = await runGeminiSemanticValidator({
      basePath: params.baselinePathOrUrl,
      candidatePath: params.candidatePathOrUrl,
      stage: params.stage === "stage1b" ? "1B" : "2",
      sceneType: params.sceneType || "interior",
    });

    const pass = !verdict.hardFail;
    if (!pass) {
      reasons.push(...(verdict.reasons || []));
    }

    return {
      confirmedFail: !pass,
      reasons,
      confidence: verdict.confidence,
      raw: verdict,
      status: pass ? "pass" : "fail",
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    reasons.push(`gemini_confirm_error: ${msg}`);
    if (failOpen) {
      return { confirmedFail: false, reasons, status: "error" };
    }
    return { confirmedFail: true, reasons, status: "error" };
  }
}
