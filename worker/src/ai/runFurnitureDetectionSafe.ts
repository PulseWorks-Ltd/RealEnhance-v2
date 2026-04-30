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
    try {
      const startedEvent = params.logContext?.sourceEvent || "DETECTOR_STARTED";
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
      resultCache.set(cacheKey, result);
      return {
        result,
        source: "fresh",
      };
    } catch (error) {
      console.warn("DETECTOR_FAILED", {
        ...buildLogPayload(params, "DETECTOR_FAILED"),
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