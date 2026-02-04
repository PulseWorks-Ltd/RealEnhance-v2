/**
 * Dual AI Validation System
 * Validates images with both Gemini API and optionally Stability AI
 */

import { getGeminiClient } from '../ai/gemini';

interface ValidationResult {
  provider: 'gemini' | 'stability';
  passed: boolean;
  score?: number;
  reason?: string;
  error?: string;
}

interface DualValidationResult {
  passed: boolean;
  gemini: ValidationResult;
  stability?: ValidationResult;
  decision: 'both_pass' | 'both_fail' | 'one_fail' | 'error';
  shouldRetry: boolean;
}

const STABILITY_API_KEY = process.env.STABILITY_API_KEY || '';
const USE_STABILITY = !!STABILITY_API_KEY;

/**
 * Validate image with Gemini API
 */
async function validateWithGemini(
  imageBuffer: Buffer,
  prompt: string
): Promise<ValidationResult> {
  try {
    const client = getGeminiClient();
    
    const parts = [
      { text: prompt },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBuffer.toString('base64')
        }
      }
    ];

    const response = await client.models.generateContent({
      model: 'gemini-2.0-flash-exp',
      contents: [{ role: 'user', parts }]
    });

    const candidates = response.candidates || [];
    const firstCandidate = candidates[0];
    const text = firstCandidate?.content?.parts?.[0]?.text?.toLowerCase() || '';
    
    // Check for quality indicators
    const passed = 
      !text.includes('blur') &&
      !text.includes('artifact') &&
      !text.includes('distortion') &&
      !text.includes('poor quality') &&
      (text.includes('good') || text.includes('acceptable') || text.includes('pass'));

    return {
      provider: 'gemini',
      passed,
      reason: passed ? 'Quality acceptable' : 'Quality issues detected',
      score: passed ? 0.8 : 0.4
    };
  } catch (error: any) {
    console.error('[Validation] Gemini error:', error.message);
    return {
      provider: 'gemini',
      passed: false,
      error: error.message
    };
  }
}

/**
 * Validate image with Stability AI (if enabled)
 */
async function validateWithStability(
  imageBuffer: Buffer
): Promise<ValidationResult> {
  if (!USE_STABILITY) {
    return {
      provider: 'stability',
      passed: true,
      reason: 'Stability AI not configured'
    };
  }

  try {
    // Placeholder for Stability AI integration
    // TODO: Implement actual Stability AI validation API
    console.log('[Validation] Stability AI validation placeholder');
    
    return {
      provider: 'stability',
      passed: true,
      score: 0.85,
      reason: 'Placeholder validation passed'
    };
  } catch (error: any) {
    console.error('[Validation] Stability error:', error.message);
    return {
      provider: 'stability',
      passed: false,
      error: error.message
    };
  }
}

/**
 * Perform dual validation with decision logic
 */
export async function performDualValidation(
  imageBuffer: Buffer,
  validationPrompt: string = 'Analyze this image for quality, clarity, and artifacts. Is it acceptable for professional use?'
): Promise<DualValidationResult> {
  console.log('[Validation] Starting dual validation...');
  
  // Run validations in parallel
  const [geminiResult, stabilityResult] = await Promise.all([
    validateWithGemini(imageBuffer, validationPrompt),
    USE_STABILITY ? validateWithStability(imageBuffer) : Promise.resolve(null)
  ]);

  // Decision logic
  let decision: DualValidationResult['decision'];
  let shouldRetry: boolean;

  const geminiPassed = geminiResult.passed;
  const stabilityPassed = stabilityResult?.passed ?? true; // Default to pass if not used

  if (geminiResult.error && stabilityResult?.error) {
    decision = 'error';
    shouldRetry = true;
  } else if (geminiPassed && stabilityPassed) {
    decision = 'both_pass';
    shouldRetry = false;
  } else if (!geminiPassed && !stabilityPassed) {
    decision = 'both_fail';
    shouldRetry = true;
  } else {
    decision = 'one_fail';
    shouldRetry = true;
  }

  const result: DualValidationResult = {
    passed: decision === 'both_pass',
    gemini: geminiResult,
    stability: stabilityResult || undefined,
    decision,
    shouldRetry
  };

  console.log('[Validation] Result:', {
    decision: result.decision,
    shouldRetry: result.shouldRetry,
    geminiPassed,
    stabilityPassed: stabilityResult?.passed
  });

  return result;
}

/**
 * Retry validation with exponential backoff
 */
export async function retryValidation(
  imageBuffer: Buffer,
  maxAttempts: number = 3,
  validationPrompt?: string
): Promise<DualValidationResult> {
  let lastResult: DualValidationResult | null = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Validation] Attempt ${attempt}/${maxAttempts}`);
    
    const result = await performDualValidation(imageBuffer, validationPrompt);
    lastResult = result;
    
    if (result.passed) {
      console.log('[Validation] ✅ Validation passed');
      return result;
    }
    
    if (attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.log(`[Validation] ⚠️  Validation failed, retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  console.error(`[Validation] ❌ Validation failed after ${maxAttempts} attempts`);
  return lastResult!;
}
