// server/src/services/geminiAnalysis.ts
// Gemini API service for auto failure analysis

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import type { AnalysisOutput, AnalysisInputSummary } from "@realenhance/shared/analysis/types.js";

const PROMPT_VERSION = "analysis-v1";

// Environment configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_ANALYSIS = process.env.GEMINI_MODEL_ANALYSIS || "gemini-2.5-flash";
const ANALYSIS_ENABLED = process.env.ANALYSIS_ENABLED !== "false"; // default true
const ANALYSIS_TIMEOUT_MS = parseInt(process.env.ANALYSIS_TIMEOUT_MS || "30000");
const ANALYSIS_MAX_IMAGES = parseInt(process.env.ANALYSIS_MAX_IMAGES || "3");
const ANALYSIS_REDACT = process.env.ANALYSIS_REDACT !== "false"; // default true

/**
 * System prompt for Gemini analysis
 */
const SYSTEM_PROMPT = `You are an internal validator review assistant for RealEnhance, a multi-stage real estate photo enhancement pipeline.

**Your Task:**
Analyze failed/degraded jobs by reviewing validator logs and before/after images to diagnose issues and provide actionable recommendations.

**Pipeline Stages:**
- **Stage 1A (Enhance)**: AI-powered enhancement (lighting, color, clarity)
- **Stage 1B (Declutter)**: Remove furniture and objects, prepare for staging
- **Stage 2 (Virtual Staging)**: Add furniture and decor

**Output Requirements:**
1. Return STRICT JSON matching this schema (no markdown, no extra text):
{
  "job_summary": { "stages_run": ["1A","1B","2"], "final_outcome": "PASS|FAIL|DEGRADED" },
  "primary_issue": "string (one sentence)",
  "supporting_evidence": ["bullet points from logs/images"],
  "assessment": {
    "classification": "REAL_IMAGE_ISSUE|SYSTEM_ISSUE|MIXED|INSUFFICIENT_EVIDENCE",
    "confidence": "LOW|MEDIUM|HIGH",
    "notes": "string"
  },
  "recommended_actions": {
    "prompt_changes": ["actionable suggestions"],
    "validator_adjustments": ["threshold/logic changes"],
    "pipeline_logic_changes": ["workflow improvements"],
    "model_changes": ["model selection/tuning"]
  },
  "do_not_recommend": ["actions to avoid"]
}

2. Be concise and actionable
3. Use evidence from logs and images
4. If evidence is insufficient, say so in assessment.notes
5. This is INTERNAL ONLY - not customer-facing
6. Avoid vendor names and marketing language
7. Prioritize fixing real issues over tuning for edge cases

**Guidelines:**
- REAL_IMAGE_ISSUE: Low quality source, extreme lighting, corrupted file, unsupported content
- SYSTEM_ISSUE: Model hallucination, validator bug, pipeline error, resource timeout
- MIXED: Both real image problems AND system issues
- INSUFFICIENT_EVIDENCE: Not enough data to determine root cause`;

/**
 * Job data package for Gemini
 */
export interface AnalysisJobData {
  inputSummary: AnalysisInputSummary;
  validatorLogs: string[];
  validatorResults: Array<{
    name: string;
    passed: boolean;
    score?: number;
    message?: string;
  }>;
  imageUrls: {
    original?: string;
    stage1A?: string;
    stage1B?: string;
    stage2?: string;
    failed?: string; // The output that failed
  };
}

/**
 * Redact sensitive information from text
 */
function redactSensitive(text: string): string {
  if (!ANALYSIS_REDACT) return text;

  // Redact API keys, tokens, passwords
  let redacted = text.replace(/[a-zA-Z0-9_-]{20,}/g, (match) => {
    // Check if it looks like a key/token
    if (match.match(/^(sk|pk|key|token|secret|password)/i)) {
      return "[REDACTED]";
    }
    return match;
  });

  // Redact AWS credentials
  redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]");

  // Redact email addresses (optional)
  // redacted = redacted.replace(/[\w.-]+@[\w.-]+\.\w+/g, "[REDACTED_EMAIL]");

  return redacted;
}

/**
 * Initialize Gemini client
 */
function getGeminiClient(): GenerativeModel | null {
  if (!ANALYSIS_ENABLED) {
    console.log("[ANALYSIS] Feature disabled (ANALYSIS_ENABLED=false)");
    return null;
  }

  if (!GEMINI_API_KEY) {
    console.warn("[ANALYSIS] GEMINI_API_KEY not configured");
    return null;
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: GEMINI_MODEL_ANALYSIS });
}

/**
 * Run Gemini analysis on job data
 */
export async function runGeminiAnalysis(jobData: AnalysisJobData): Promise<{
  output: AnalysisOutput;
  rawText: string;
}> {
  const model = getGeminiClient();

  if (!model) {
    throw new Error("Gemini API not configured or disabled");
  }

  // Build prompt content
  const contentParts: any[] = [];

  // Add job header
  contentParts.push({
    text: `**Job Analysis Request**

Job ID: ${jobData.inputSummary.jobId}
Stages Run: ${jobData.inputSummary.stages.join(", ")}
Scene Type: ${jobData.inputSummary.sceneType || "auto"}
Created: ${jobData.inputSummary.createdAt}

**Validator Results:**
${jobData.validatorResults.map((v) => `- ${v.name}: ${v.passed ? "PASS" : "FAIL"}${v.score !== undefined ? ` (score: ${v.score})` : ""}${v.message ? ` - ${v.message}` : ""}`).join("\n")}

**Validator Logs:**
${jobData.validatorLogs.map((log) => redactSensitive(log)).join("\n\n")}
`,
  });

  // Add images (up to ANALYSIS_MAX_IMAGES)
  const imageUrls: string[] = [];
  if (jobData.imageUrls.original) imageUrls.push(jobData.imageUrls.original);
  if (jobData.imageUrls.failed) imageUrls.push(jobData.imageUrls.failed);
  if (jobData.imageUrls.stage2 && !jobData.imageUrls.failed) imageUrls.push(jobData.imageUrls.stage2);
  if (jobData.imageUrls.stage1B && imageUrls.length < ANALYSIS_MAX_IMAGES) imageUrls.push(jobData.imageUrls.stage1B);
  if (jobData.imageUrls.stage1A && imageUrls.length < ANALYSIS_MAX_IMAGES) imageUrls.push(jobData.imageUrls.stage1A);

  for (const url of imageUrls.slice(0, ANALYSIS_MAX_IMAGES)) {
    try {
      // Fetch image and convert to base64
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[ANALYSIS] Failed to fetch image: ${url}`);
        continue;
      }

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const mimeType = response.headers.get("content-type") || "image/jpeg";

      contentParts.push({
        inlineData: {
          mimeType,
          data: base64,
        },
      });
    } catch (error) {
      console.error(`[ANALYSIS] Error fetching image ${url}:`, error);
    }
  }

  contentParts.push({
    text: "\nProvide your analysis as STRICT JSON (no markdown, no extra text):",
  });

  // Call Gemini API with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: contentParts,
        },
      ],
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.2, // Lower temperature for more consistent JSON
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 2048,
      },
    });

    clearTimeout(timeout);

    const response = result.response;
    const rawText = response.text();

    // Parse JSON response
    let output: AnalysisOutput;
    try {
      // Try to extract JSON if wrapped in markdown
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || rawText.match(/(\{[\s\S]*\})/);
      const jsonText = jsonMatch ? jsonMatch[1] : rawText;
      output = JSON.parse(jsonText);

      // Validate schema
      if (!output.job_summary || !output.primary_issue || !output.assessment) {
        throw new Error("Invalid output schema");
      }
    } catch (parseError) {
      console.error("[ANALYSIS] Failed to parse Gemini output:", rawText);
      throw new Error(`Failed to parse AI response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }

    return { output, rawText };
  } catch (error) {
    clearTimeout(timeout);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Analysis timeout after ${ANALYSIS_TIMEOUT_MS}ms`);
    }

    throw error;
  }
}

/**
 * Check if analysis feature is available
 */
export function isAnalysisEnabled(): boolean {
  return ANALYSIS_ENABLED && !!GEMINI_API_KEY;
}

/**
 * Get current configuration
 */
export function getAnalysisConfig() {
  return {
    enabled: ANALYSIS_ENABLED,
    configured: !!GEMINI_API_KEY,
    model: GEMINI_MODEL_ANALYSIS,
    promptVersion: PROMPT_VERSION,
    maxImages: ANALYSIS_MAX_IMAGES,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    redact: ANALYSIS_REDACT,
  };
}

export { PROMPT_VERSION };
