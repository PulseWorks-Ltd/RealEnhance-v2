/**
 * Centralized Generation Configuration System
 * 
 * Provides operation-specific AI generation parameters (temperature, topP, topK)
 * tailored to different enhancement scenarios and scene types.
 * 
 * Key Problem Areas Addressed:
 * - Exterior staging: Ultra-conservative to prevent furniture on grass/driveways and deck creation
 * - Interior furniture replacement: Maximum creativity to replace ALL furniture comprehensively
 * - Interior staging: Moderate controls to prevent wall/window modifications
 */

export type SceneType = 'interior' | 'exterior' | 'auto';
export type OperationType = 
  | 'quality-only'      // Stage 1A: Pure quality enhancement (brightness, sharpness, color)
  | 'furniture-removal' // Stage 1B: Remove all furniture/decor (runs after quality enhancement)
  | 'staging'           // Stage 2: Furniture placement only (ZERO quality changes)
  | 'furniture-replace' // Legacy: Aggressive furniture replacement mode
  | 'region-add'        // Region edit: Add furniture
  | 'region-remove'     // Region edit: Remove objects
  | 'region-replace'    // Region edit: Replace furniture
  | 'region-enhance'    // Region edit: Enhance quality
  | 'region-restore';   // Region edit: Restore original

export type RetryContext = 
  | 'none'              // Not a retry
  | 'compliance-fail'   // Retry after compliance violation (use more conservative settings)
  | 'aesthetic-miss';   // Retry after aesthetic dissatisfaction (use more creative settings)

export interface GenerationConfig {
  temperature: number;
  topP: number;
  topK: number;
}

export interface GenerationProfile {
  config: GenerationConfig;
  rationale: string;
}

// Centralized generation profile registry
const generationProfiles: Record<string, GenerationProfile> = {
  // ===== QUALITY-ONLY OPERATIONS (Stage 1A) =====
  // Stage 1A: Pure quality enhancement with NO architectural restrictions
  // Slightly higher temperature for better color correction and tonal adjustments
  'quality-only-interior': {
    config: { temperature: 0.35, topP: 0.90, topK: 40 },
    rationale: 'Stage 1A interior: Moderate creativity (temp=0.35) for quality enhancement - sufficient for good color correction and tonal adjustments without architectural restrictions'
  },
  'quality-only-exterior': {
    config: { temperature: 0.25, topP: 0.88, topK: 40 },
    rationale: 'Stage 1A exterior: Conservative creativity (temp=0.25) for quality enhancements (sky replacement, grass boost, surface brightening) while preserving structures'
  },

  // ===== FURNITURE REMOVAL (Stage 1B) =====
  // Conservative settings for clean furniture removal with architectural preservation
  'furniture-removal-interior': {
    config: { temperature: 0.35, topP: 0.75, topK: 40 },
    rationale: 'Stage 1B: Conservative removal (temp=0.35) - clean furniture removal while preserving all architectural elements'
  },

  // ===== STAGING OPERATIONS (Stage 2) =====
  // Ultra-conservative for furniture placement ONLY - no quality/lighting changes allowed
  'staging-interior': {
    config: { temperature: 0.15, topP: 0.7, topK: 40 },
    rationale: 'Stage 2 interior: Ultra-conservative staging (temp=0.15) - furniture placement ONLY with ZERO quality/lighting changes to ensure pixel-perfect color matching'
  },
  'staging-exterior': {
    config: { temperature: 0.08, topP: 0.3, topK: 40 },
    rationale: 'ULTRA-conservative exterior staging to prevent furniture on grass/driveways and deck creation'
  },

  // ===== FURNITURE REPLACEMENT MODE =====
  // Balanced settings: creative enough for comprehensive replacement, restrained enough for safety
  'furniture-replace-interior': {
    config: { temperature: 0.45, topP: 0.85, topK: 40 },
    rationale: 'Balanced furniture replacement - sufficient creativity to remove ALL existing furniture and replace comprehensively, with architectural guards enforcing preservation'
  },
  'furniture-replace-exterior': {
    config: { temperature: 0.28, topP: 0.65, topK: 40 },
    rationale: 'Moderate exterior furniture replacement - balanced between comprehensive replacement and spatial safety, relies on architectural validators'
  },

  // ===== REGION EDIT: ADD =====
  // Creative placement for user-specified regions
  'region-add-interior': {
    config: { temperature: 0.45, topP: 0.85, topK: 40 },
    rationale: 'Creative furniture placement in user-marked interior regions'
  },
  'region-add-exterior': {
    config: { temperature: 0.28, topP: 0.65, topK: 40 },
    rationale: 'Moderate creativity for exterior region additions - prevent grass/driveway staging'
  },

  // ===== REGION EDIT: REMOVE/RESTORE =====
  // Ultra-safe settings for destructive operations
  'region-remove-interior': {
    config: { temperature: 0.2, topP: 0.6, topK: 40 },
    rationale: 'Conservative removal to prevent unintended background reconstruction'
  },
  'region-remove-exterior': {
    config: { temperature: 0.1, topP: 0.4, topK: 40 },
    rationale: 'Ultra-safe exterior removal to prevent spatial expansion'
  },
  'region-restore-interior': {
    config: { temperature: 0.2, topP: 0.6, topK: 40 },
    rationale: 'Conservative restoration for predictable pixel-level operations'
  },
  'region-restore-exterior': {
    config: { temperature: 0.1, topP: 0.4, topK: 40 },
    rationale: 'Ultra-safe restoration for exterior scenes'
  },

  // ===== REGION EDIT: REPLACE =====
  // Moderate creativity for regional furniture replacement
  'region-replace-interior': {
    config: { temperature: 0.5, topP: 0.85, topK: 40 },
    rationale: 'Moderate-high creativity for replacing furniture in specific regions'
  },
  'region-replace-exterior': {
    config: { temperature: 0.3, topP: 0.7, topK: 40 },
    rationale: 'Moderate exterior replacement - balance between modern updates and spatial safety'
  },

  // ===== REGION EDIT: ENHANCE =====
  // Moderate adjustment for quality improvements
  'region-enhance-interior': {
    config: { temperature: 0.3, topP: 0.75, topK: 40 },
    rationale: 'Balanced quality enhancement for interior regions'
  },
  'region-enhance-exterior': {
    config: { temperature: 0.15, topP: 0.5, topK: 40 },
    rationale: 'Conservative quality enhancement for exterior regions'
  }
};

/**
 * Get the appropriate generation config for a given operation and context
 */
export function getGenerationConfig(
  operation: OperationType,
  sceneType: SceneType,
  retryContext: RetryContext = 'none'
): { config: GenerationConfig; profile: string; rationale: string } {
  // Resolve scene type (default to interior if auto)
  const resolvedScene = sceneType === 'auto' ? 'interior' : sceneType;
  
  // Build profile key
  const baseProfileKey = `${operation}-${resolvedScene}`;
  
  // Get base profile
  const profile = generationProfiles[baseProfileKey];
  
  if (!profile) {
    console.warn(`[GENERATION CONFIG] No profile found for ${baseProfileKey}, using defaults`);
    return {
      config: { temperature: 0.3, topP: 0.8, topK: 40 },
      profile: 'default',
      rationale: 'Fallback default config - no specific profile found'
    };
  }
  
  // Apply retry modifiers if applicable
  let finalConfig = { ...profile.config };
  let modifierNote = '';
  
  if (retryContext === 'compliance-fail') {
    // Reduce creativity after compliance failures (30% reduction)
    finalConfig.temperature = Math.max(0.05, finalConfig.temperature * 0.7);
    finalConfig.topP = Math.max(0.3, finalConfig.topP * 0.7);
    modifierNote = ' [RETRY: Compliance fail modifier applied: -30% temp/topP for safety]';
  } else if (retryContext === 'aesthetic-miss') {
    // Increase creativity after aesthetic misses (15% increase, capped)
    finalConfig.temperature = Math.min(0.9, finalConfig.temperature * 1.15);
    finalConfig.topP = Math.min(0.98, finalConfig.topP * 1.15);
    modifierNote = ' [RETRY: Aesthetic miss modifier applied: +15% temp/topP for variation]';
  }
  
  return {
    config: finalConfig,
    profile: baseProfileKey,
    rationale: profile.rationale + modifierNote
  };
}

/**
 * Log generation config selection for telemetry and debugging
 */
export function logGenerationConfig(
  operation: OperationType,
  sceneType: SceneType,
  retryContext: RetryContext,
  result: { config: GenerationConfig; profile: string; rationale: string }
): void {
  console.log(`[GENERATION CONFIG] Selected profile: ${result.profile}`);
  console.log(`[GENERATION CONFIG] Operation: ${operation}, Scene: ${sceneType}, Retry: ${retryContext}`);
  console.log(`[GENERATION CONFIG] Config: temp=${result.config.temperature}, topP=${result.config.topP}, topK=${result.config.topK}`);
  console.log(`[GENERATION CONFIG] Rationale: ${result.rationale}`);
}
