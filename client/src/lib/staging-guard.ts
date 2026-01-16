/**
 * Staging Guard - Client-side version
 * Single source of truth for staging eligibility (mirrors shared/staging-guard.ts)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PART C - Exterior staging hard-disable
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Rules:
 * - scene === "exterior" → NEVER allow staging (hard false)
 * - scene === "unknown" or null → require user to confirm scene before staging
 * - scene === "interior" → staging allowed (subject to roomType requirements)
 */

export type SceneType = "interior" | "exterior" | "unknown" | null;

export interface StagingGuardInput {
  scene: SceneType;
  roomType?: string | null;
}

export interface StagingGuardResult {
  allowed: boolean;
  reason: "exterior_blocked" | "unknown_scene_requires_confirmation" | "missing_room_type" | "allowed";
  message?: string;
}

/**
 * Determines if staging is allowed for a given scene/room configuration.
 * Client-side version - mirrors server-side logic for UI gating.
 */
export function canStage(input: StagingGuardInput): StagingGuardResult {
  const { scene, roomType } = input;

  // RULE 1: Exterior staging is ALWAYS blocked
  if (scene === "exterior") {
    return {
      allowed: false,
      reason: "exterior_blocked",
      message: "Staging is not available for exterior images."
    };
  }

  // RULE 2: Unknown/null scene requires user confirmation
  if (scene === "unknown" || scene === null) {
    return {
      allowed: false,
      reason: "unknown_scene_requires_confirmation",
      message: "Please confirm the scene type before enabling staging."
    };
  }

  // RULE 3: Interior requires a valid room type
  if (scene === "interior") {
    if (!roomType || typeof roomType !== "string" || !roomType.trim()) {
      return {
        allowed: false,
        reason: "missing_room_type",
        message: "Please select a room type to enable staging."
      };
    }

    return {
      allowed: true,
      reason: "allowed"
    };
  }

  // Fallback
  return {
    allowed: false,
    reason: "unknown_scene_requires_confirmation",
    message: "Unable to determine scene type."
  };
}

/**
 * Check if staging UI should be shown/enabled for a given scene
 */
export function isStagingUIEnabled(scene: SceneType): boolean {
  // Only show staging UI for interior scenes
  return scene === "interior";
}

/**
 * Get user-friendly message for why staging is disabled
 */
export function getStagingDisabledMessage(scene: SceneType): string | null {
  if (scene === "exterior") {
    return "Virtual staging is only available for interior images.";
  }
  if (scene === "unknown" || scene === null) {
    return "Please select a scene type (Interior/Exterior) first.";
  }
  return null;
}
