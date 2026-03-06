// worker/src/ai/stagingStyles.ts

// Keep this file IMPORT-FREE to avoid circular deps.

export type StagingStyle =
  | "standard_listing"
  | "family_home"
  | "urban_apartment"
  | "high_end_luxury"
  | "country_lifestyle"
  | "lived_in_rental";

export const DEFAULT_STAGING_STYLE: StagingStyle = "standard_listing";

/**
 * NZ Standard Real Estate Staging - The TRUE DEFAULT
 * This is the safest, most conservative staging style.
 * Always revert to this when in doubt.
 */
export const NZ_STANDARD_STAGING = {
  key: "standard_listing",
  label: "Standard Listing",
  description: "Neutral, conservative NZ real estate photo staging",
  prompt: `
You are a professional New Zealand real estate photo retoucher and virtual stager.

Rules:
- Maintain exact architectural structure
- Do NOT add or remove doors or windows
- Do NOT change wall positions, ceiling height, or floor layout
- Do NOT introduce unrealistic furniture
- Do NOT block natural light sources

Style:
- Clean, neutral, lived-in but uncluttered look
- Soft natural lighting
- Subtle warmth (not over-stylised)
- Realistic, modest furniture only where context-appropriate
- No dramatic shadows, no editorial lighting

Purpose:
- This image must remain believable as a real NZ residential property listing photo.
- Enhancements must appear subtle, professional, and agency-safe.
`.trim()
};

export const STYLE_PROMPT_MODIFIERS: Record<StagingStyle, string> = {
  standard_listing: "",
  family_home:
    "Stage the space as a comfortable suburban family home. Use warm, welcoming furniture, practical layouts, and a relaxed family-friendly atmosphere.",
  urban_apartment:
    "Stage the space as a modern city apartment. Use contemporary furniture with efficient layouts appropriate for compact urban living.",
  high_end_luxury:
    "Stage the space as a premium luxury property. Use elegant furniture, refined materials, and a sophisticated upscale aesthetic.",
  country_lifestyle:
    "Stage the space to suit a New Zealand rural or lifestyle property. Use warm natural materials, timber furniture, relaxed layouts, and a comfortable countryside aesthetic.",
  lived_in_rental:
    "Stage the space to feel naturally lived-in rather than showroom-styled. Use simple practical furniture, modest decor, and a realistic residential layout suitable for rental or entry-level homes.",
};

export function normalizeStagingStyle(style: string | null | undefined): StagingStyle {
  const key = (style || "").trim().toLowerCase();
  const aliases: Record<string, StagingStyle> = {
    standard_listing: "standard_listing",
    "standard listing": "standard_listing",

    // Backward compatibility aliases
    nz_standard: "standard_listing",
    "nz standard": "standard_listing",
    "nz standard real estate": "standard_listing",
    nz_standard_real_estate: "standard_listing",

    family_home: "family_home",
    "family home": "family_home",
    urban_apartment: "urban_apartment",
    "urban apartment": "urban_apartment",
    high_end_luxury: "high_end_luxury",
    "high-end luxury": "high_end_luxury",
    "high end luxury": "high_end_luxury",
    country_lifestyle: "country_lifestyle",
    "country lifestyle": "country_lifestyle",
    "country / lifestyle": "country_lifestyle",
    lived_in_rental: "lived_in_rental",
    "lived in rental": "lived_in_rental",
    "lived-in rental": "lived_in_rental",
    "lived-in / rental": "lived_in_rental",
  };

  const normalized = aliases[key] || aliases[key.replace(/-/g, "_").replace(/\s+/g, "_")];
  return normalized || DEFAULT_STAGING_STYLE;
}

export function getStagingStyleDirective(style: string): string {
  const safeStyle = normalizeStagingStyle(style);
  return STYLE_PROMPT_MODIFIERS[safeStyle];
}
