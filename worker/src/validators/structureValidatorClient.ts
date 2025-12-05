/**
 * TypeScript Client for OpenCV Structural Validator Microservice
 *
 * This client connects the RealEnhance worker to the Python OpenCV validator service.
 * It provides a unified interface for structural validation with configurable modes.
 *
 * Environment Variables:
 *   STRUCTURE_VALIDATOR_URL - URL of the OpenCV validator service
 *   STRUCTURE_VALIDATOR_MODE - Operation mode: "off" | "log" | "block"
 *   STRUCTURE_VALIDATOR_SENSITIVITY - Deviation threshold in degrees (default: 5.0)
 */

import axios, { AxiosError } from "axios";

/**
 * Line summary statistics from OpenCV analysis
 */
export interface LineSummary {
  count: number;
  verticalCount: number;
  horizontalCount: number;
  verticalAngles: number[];
  horizontalAngles: number[];
  avgVerticalAngle: number;
  avgHorizontalAngle: number;
}

/**
 * Structural validation result
 */
export interface StructureValidationResult {
  mode: "off" | "log" | "block";
  isSuspicious: boolean;
  deviationScore: number;
  verticalShift: number;
  horizontalShift: number;
  original: LineSummary;
  enhanced: LineSummary;
  message: string;
  error?: string;
}

/**
 * Validator configuration from environment variables
 */
function getValidatorConfig() {
  const url = process.env.STRUCTURE_VALIDATOR_URL;
  const mode = (process.env.STRUCTURE_VALIDATOR_MODE ?? "log") as "off" | "log" | "block";
  const sensitivity = parseFloat(process.env.STRUCTURE_VALIDATOR_SENSITIVITY ?? "5.0");

  return { url, mode, sensitivity };
}

/**
 * Create a disabled/dummy validation result
 */
function createDisabledResult(reason: string): StructureValidationResult {
  return {
    mode: "off",
    isSuspicious: false,
    deviationScore: 0,
    verticalShift: 0,
    horizontalShift: 0,
    original: {
      count: 0,
      verticalCount: 0,
      horizontalCount: 0,
      verticalAngles: [],
      horizontalAngles: [],
      avgVerticalAngle: 0,
      avgHorizontalAngle: 0,
    },
    enhanced: {
      count: 0,
      verticalCount: 0,
      horizontalCount: 0,
      verticalAngles: [],
      horizontalAngles: [],
      avgVerticalAngle: 0,
      avgHorizontalAngle: 0,
    },
    message: reason,
  };
}

/**
 * Validate structural integrity between original and enhanced images
 *
 * This function:
 * 1. Checks if validator is enabled via environment variables
 * 2. Calls the OpenCV microservice with image URLs
 * 3. Returns validation results with mode, scores, and suspicious flag
 * 4. Handles errors gracefully - always returns a result, never throws
 *
 * @param originalUrl - Public URL to the original image
 * @param enhancedUrl - Public URL to the enhanced/staged image
 * @returns Validation result with structural analysis
 */
export async function validateStructure(
  originalUrl: string,
  enhancedUrl: string
): Promise<StructureValidationResult> {
  const { url, mode, sensitivity } = getValidatorConfig();

  // Check if validator is disabled
  if (!url || mode === "off") {
    console.log("[structureValidator] Validator disabled (mode=off or no URL configured)");
    return createDisabledResult("Validator disabled");
  }

  // Validate URLs
  if (!originalUrl || !enhancedUrl) {
    console.warn("[structureValidator] Missing image URLs, skipping validation");
    return createDisabledResult("Missing image URLs");
  }

  console.log(`[structureValidator] Validating structure (mode=${mode}, sensitivity=${sensitivity}°)`);
  console.log(`[structureValidator] Original: ${originalUrl.substring(0, 80)}...`);
  console.log(`[structureValidator] Enhanced: ${enhancedUrl.substring(0, 80)}...`);

  try {
    const startTime = Date.now();

    // Call OpenCV validator microservice
    const response = await axios.post(
      `${url}/validate-structure`,
      {
        originalUrl,
        enhancedUrl,
        sensitivity,
      },
      {
        timeout: 30000, // 30 second timeout
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const elapsed = Date.now() - startTime;
    const data = response.data;

    console.log(`[structureValidator] Validation complete in ${elapsed}ms`);
    console.log(`[structureValidator] Deviation: ${data.deviationScore}° (vertical: ${data.verticalShift}°, horizontal: ${data.horizontalShift}°)`);
    console.log(`[structureValidator] Suspicious: ${data.isSuspicious}`);

    return {
      mode,
      isSuspicious: data.isSuspicious,
      deviationScore: data.deviationScore,
      verticalShift: data.verticalShift,
      horizontalShift: data.horizontalShift,
      original: data.original,
      enhanced: data.enhanced,
      message: data.message,
    };
  } catch (error) {
    // Handle errors gracefully - never throw, always return a result
    const axiosError = error as AxiosError;

    if (axiosError.response) {
      // Server responded with error status
      console.error(
        `[structureValidator] Validation failed: ${axiosError.response.status} ${axiosError.response.statusText}`
      );
      return {
        ...createDisabledResult(`Validation service error: ${axiosError.response.status}`),
        mode,
        error: String(axiosError.response.data),
      };
    } else if (axiosError.request) {
      // Request made but no response received
      console.error(
        `[structureValidator] Validation service unreachable: ${axiosError.message}`
      );
      return {
        ...createDisabledResult("Validation service unreachable"),
        mode,
        error: axiosError.message,
      };
    } else {
      // Something else happened
      console.error(`[structureValidator] Unexpected error: ${error}`);
      return {
        ...createDisabledResult("Validation error"),
        mode,
        error: String(error),
      };
    }
  }
}

/**
 * Execute structural validation check and handle blocking logic
 *
 * This function wraps validateStructure() and implements the blocking behavior:
 * - mode="off": Skip validation entirely
 * - mode="log": Run validation, log results, never block
 * - mode="block": Run validation, block if suspicious
 *
 * @param originalUrl - Public URL to the original image
 * @param enhancedUrl - Public URL to the enhanced image
 * @throws Error if mode="block" and validation fails
 */
export async function runStructuralCheck(
  originalUrl: string,
  enhancedUrl: string
): Promise<StructureValidationResult> {
  const result = await validateStructure(originalUrl, enhancedUrl);

  // Log results (always, for all modes)
  console.log("[structureValidator] === STRUCTURAL VALIDATION RESULT ===");
  console.log(`[structureValidator] Mode: ${result.mode}`);
  console.log(`[structureValidator] Deviation Score: ${result.deviationScore}°`);
  console.log(`[structureValidator] Vertical Shift: ${result.verticalShift}°`);
  console.log(`[structureValidator] Horizontal Shift: ${result.horizontalShift}°`);
  console.log(`[structureValidator] Suspicious: ${result.isSuspicious}`);
  console.log(`[structureValidator] Message: ${result.message}`);

  if (result.original.count > 0) {
    console.log(
      `[structureValidator] Original lines: ${result.original.count} total (${result.original.verticalCount} vertical, ${result.original.horizontalCount} horizontal)`
    );
  }

  if (result.enhanced.count > 0) {
    console.log(
      `[structureValidator] Enhanced lines: ${result.enhanced.count} total (${result.enhanced.verticalCount} vertical, ${result.enhanced.horizontalCount} horizontal)`
    );
  }

  // Blocking logic
  if (result.mode === "block" && result.isSuspicious) {
    console.error("[structureValidator] ⚠️ BLOCKING IMAGE due to structural deviation");
    console.error(`[structureValidator] Deviation score ${result.deviationScore}° exceeds threshold`);
    throw new Error(
      `Structural validation failed: ${result.message} (deviation: ${result.deviationScore}°)`
    );
  } else if (result.isSuspicious) {
    console.warn(
      `[structureValidator] ⚠️ Structural deviation detected but not blocking (mode=${result.mode})`
    );
  } else {
    console.log("[structureValidator] ✓ Structural validation passed");
  }

  return result;
}
