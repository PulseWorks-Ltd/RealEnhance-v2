import path from "path";

import {
  detectFurnitureWithRetry,
  type FurnitureDetectionResult,
} from "./furnitureDetector";
import { getGeminiClient } from "./gemini";
import { toBase64 } from "../utils/images";

export type FurnitureDetectionSceneType = "interior" | "exterior";

export type FurnitureDetectionSafeParams = {
  imagePath: string;
  sceneType?: FurnitureDetectionSceneType;
  timeoutMs?: number;
  logContext?: {
    jobId?: string;
    imageId?: string;
    mode?: string;
    sourceEvent?: string;
    startedFields?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  };
};

export type FurnitureDetectionSafeResponse = {
  result: FurnitureDetectionResult | null;
  source: "cache_hit" | "inflight_join" | "fresh";
};

const resultCache = new Map<string, FurnitureDetectionResult | null>();
const inFlightDetectorRequests = new Map<string, Promise<FurnitureDetectionSafeResponse>>();

export function buildFurnitureDetectionCacheKey(params: {
  imagePath: string;
  sceneType?: FurnitureDetectionSceneType;
}): string {
  return `${path.resolve(params.imagePath)}::${params.sceneType === "exterior" ? "exterior" : "interior"}`;
}

function buildLogPayload(params: FurnitureDetectionSafeParams, event: string): Record<string, unknown> {
  return {
    event,
    jobId: params.logContext?.jobId,
    imageId: params.logContext?.imageId,
    mode: params.logContext?.mode,
    sceneType: params.sceneType === "exterior" ? "exterior" : "interior",
    imagePath: path.basename(params.imagePath),
    ...(params.logContext?.extra || {}),
  };
}

export async function runFurnitureDetectionSafe(
  params: FurnitureDetectionSafeParams
): Promise<FurnitureDetectionSafeResponse> {
  const cacheKey = buildFurnitureDetectionCacheKey({
    imagePath: params.imagePath,
    sceneType: params.sceneType,
  });

  if (resultCache.has(cacheKey)) {
    console.info("DETECTOR_CACHE_HIT", buildLogPayload(params, "DETECTOR_CACHE_HIT"));
    return {
      result: resultCache.get(cacheKey) ?? null,
      source: "cache_hit",
    };
  }

  const inFlight = inFlightDetectorRequests.get(cacheKey);
  if (inFlight) {
    console.info("DETECTOR_INFLIGHT_JOIN", buildLogPayload(params, "DETECTOR_INFLIGHT_JOIN"));
    return inFlight;
  }

  const promise = (async (): Promise<FurnitureDetectionSafeResponse> => {
    const detectorStartedAtMs = Date.now();
    try {
      const startedEvent = "FURNITURE_DETECTOR_START";
      console.info(startedEvent, {
        ...buildLogPayload(params, startedEvent),
        ...(params.logContext?.startedFields || {}),
      });

      const result = await detectFurnitureWithRetry(
        getGeminiClient(),
        toBase64(params.imagePath).data,
        {
          sceneType: params.sceneType,
          timeoutMs: params.timeoutMs,
        }
      );

      const detectorLatencyMs = Math.max(0, Date.now() - detectorStartedAtMs);
      if (result?.status === "success") {
        console.info("FURNITURE_DETECTOR_SUCCESS", {
          ...buildLogPayload(params, "FURNITURE_DETECTOR_SUCCESS"),
          detectorLatencyMs,
          detectorConfidence: typeof result.confidence === "number" ? result.confidence : null,
        });
      } else {
        const eventByFailureCode: Record<string, string> = {
          timeout: "FURNITURE_DETECTOR_TIMEOUT",
          rate_limit: "FURNITURE_DETECTOR_RATE_LIMIT",
          parse_failure: "FURNITURE_DETECTOR_PARSE_FAILURE",
          empty_response: "FURNITURE_DETECTOR_EMPTY_RESPONSE",
        };
        const failureEvent = eventByFailureCode[result?.failureCode || ""] || "FURNITURE_DETECTOR_PARSE_FAILURE";
        console.warn(failureEvent, {
          ...buildLogPayload(params, failureEvent),
          detectorLatencyMs,
          detectorConfidence: null,
          fallbackReason: result?.failureCode || "unknown",
          fallbackSource: "detector_runtime",
          detectorStatusCode: result?.statusCode ?? null,
          detectorRetryable: result?.retryable ?? false,
          detectorMessage: result?.message || null,
          stage1BForcedByFallback: null,
        });
      }

      resultCache.set(cacheKey, result);
      return {
        result,
        source: "fresh",
      };
    } catch (error) {
      const detectorLatencyMs = Math.max(0, Date.now() - detectorStartedAtMs);
      console.warn("DETECTOR_FAILED", {
        ...buildLogPayload(params, "DETECTOR_FAILED"),
        detectorLatencyMs,
        message: error instanceof Error ? error.message : String(error),
      });
      resultCache.set(cacheKey, null);
      return {
        result: null,
        source: "fresh",
      };
    } finally {
      inFlightDetectorRequests.delete(cacheKey);
    }
  })();

  inFlightDetectorRequests.set(cacheKey, promise);
  return promise;
}