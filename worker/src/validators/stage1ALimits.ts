/**
 * Stage 1A Validator Limits
 *
 * These thresholds define what changes are acceptable in Stage 1A enhancement.
 * Stage 1A is ONLY allowed to change global photographic properties - NOT content.
 */

export const STAGE1A_VALIDATOR_LIMITS = {
  // Edge-based structure deviation
  MAX_EDGE_SHIFT: 0.035,        // 3.5% - allows for compression artifacts but blocks structure changes
  MAX_EDGE_LOSS: 0.02,          // 2% - blocks removal of objects/furniture
  MAX_ANGLE_DEVIATION: 2.0,     // degrees - blocks perspective changes

  // Pixel-level content change
  MAX_MEAN_PIXEL_DIFF: 0.012,  // 1.2% average change - global lighting adjustments only
  MAX_LOCAL_REGION_DIFF: 0.04, // 4% in any local tile - catches object additions/removals

  // Feature matching (ORB/SIFT-like)
  MIN_FEATURE_MATCH_RATIO: 0.985 // 98.5% of keypoints must persist - blocks content reinterpretation
};

/**
 * What Stage 1A Is Allowed To Change:
 * ✅ Global brightness / exposure
 * ✅ Global contrast
 * ✅ White balance
 * ✅ Noise reduction
 * ✅ Micro-sharpening
 * ✅ Compression artifact cleanup
 *
 * What Stage 1A Must NEVER Change:
 * ❌ Any furniture
 * ❌ Any décor
 * ❌ Any wall art / framed images
 * ❌ Any clutter
 * ❌ Any kitchen bench items
 * ❌ Any shelves / sideboards
 * ❌ Any electronics
 * ❌ Any curtains / blinds
 * ❌ Any windows / doors
 * ❌ Any built-in units
 * ❌ Any outdoor greenery through windows
 */
