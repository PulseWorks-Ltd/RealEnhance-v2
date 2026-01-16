/**
 * Staging Guard - Single source of truth for staging eligibility
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PART C - Exterior staging hard-disable
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rules:
 * - scene === "exterior" → NEVER allow staging (hard false)
 * - scene === "unknown" or null → require user to confirm scene before staging
 * - scene === "interior" → staging allowed (subject to roomType requirements)
 *
 * This guard is used in:
 * - Client: disable staging UI + show message for exterior/unknown
 * - Server/Worker: reject/skip Stage 2 for exterior/unknown
 */

export type SceneType = "interior" | "exterior" | "unknown" | null;

export interface StagingGuardInput {
  scene: SceneType;
  roomType?: string | null;
  /** Optional override for testing - ALWAYS false in production */
  outdoorStagingEnabled?: boolean;
}

export interface StagingGuardResult {
  allowed: boolean;
  reason: "exterior_blocked" | "unknown_scene_requires_confirmation" | "missing_room_type" | "allowed";
  message?: string;
}

/**
 * Determines if staging is allowed for a given scene/room configuration.
 *
 * @param input - Scene and room configuration
 * @returns Result with allowed status and reason
 */
export function canStage(input: StagingGuardInput): StagingGuardResult {
  const { scene, roomType, outdoorStagingEnabled = false } = input;

  // RULE 1: Exterior staging is ALWAYS blocked (hard false)
  // This overrides any env var or configuration
  if (scene === "exterior") {
    // Even with outdoorStagingEnabled, we block staging for V1 safety
    // The env var only controls staging detection, not actual staging
    return {
      allowed: false,
      reason: "exterior_blocked",
      message: "Staging is not available for exterior images. Only interior images can be staged."
    };
  }

  // RULE 2: Unknown/null scene requires user confirmation before staging
  if (scene === "unknown" || scene === null) {
    return {
      allowed: false,
      reason: "unknown_scene_requires_confirmation",
      message: "Please confirm the scene type (Interior/Exterior) before enabling staging."
    };
  }

  // RULE 3: Interior requires a valid room type for staging
  if (scene === "interior") {
    if (!roomType || typeof roomType !== "string" || !roomType.trim()) {
      return {
        allowed: false,
        reason: "missing_room_type",
        message: "Please select a room type to enable staging."
      };
    }

    // All checks passed - staging is allowed
    return {
      allowed: true,
      reason: "allowed"
    };
  }

  // Fallback - shouldn't reach here but be safe
  return {
    allowed: false,
    reason: "unknown_scene_requires_confirmation",
    message: "Unable to determine scene type. Please select Interior or Exterior."
  };
}

/**
 * Logs a staging block event (for debugging/auditing)
 */
export function logStagingBlocked(
  context: {
    orgId?: string | null;
    imageId: string;
    scene: SceneType;
    reason: StagingGuardResult["reason"];
  }
): void {
  console.log(`[STAGING_BLOCKED] orgId=${context.orgId ?? 'null'} imageId=${context.imageId} scene=${context.scene} reason=${context.reason}`);
}
