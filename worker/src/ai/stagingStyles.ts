// worker/src/ai/stagingStyles.ts

// Keep this file IMPORT-FREE to avoid circular deps.

const COMMON_RULES = `
General rules:
- Do NOT change walls, windows, doors, flooring or room architecture.
- Only add/replace furniture, bedding, lighting and décor.
- Keep the layout practical and photorealistic for real-estate marketing.
- Do not mix styles; follow ONLY the specified style.
`.trim();

/**
 * NZ Standard Real Estate Staging - The TRUE DEFAULT
 * This is the safest, most conservative staging style.
 * Always revert to this when in doubt.
 */
export const NZ_STANDARD_STAGING = {
  key: "nz_standard",
  label: "NZ Standard Real Estate",
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

function build(styleName: string, body: string): string {
  return [
    `You are an interior stylist staging a room for real-estate photos.`,
    `Apply ONLY the ${styleName.toUpperCase()} staging style as defined here:`,
    body.trim(),
    COMMON_RULES,
  ].join("\n\n");
}

/**
 * Return a concise, style-specific system prompt block
 * describing how to stage the room for the given style.
 */
export function getStagingStyleDirective(style: string): string {
  const key = (style || "").trim().toLowerCase();

  switch (key) {
    case "modern":
      return build(
        "Modern",
        `
Colour palette: crisp whites, blacks, greys, and walnut accents.
Furniture: low-profile platform beds, clean geometric forms, flat-front storage.
Materials: metal, glass, matte finishes, smooth surfaces.
Décor: abstract art, very few accessories, strong contrast and straight lines.
      `
      );

    case "contemporary":
      return build(
        "Contemporary",
        `
Colour palette: warm neutrals, taupe, beige, soft greys.
Furniture: soft edges, slightly rounded corners, upholstered headboards.
Materials: light wood, fabric textures, smooth but not glossy.
Décor: organic shapes, simple ceramics, modern prints, restrained styling.
      `
      );

    case "minimalist":
      return build(
        "Minimalist",
        `
Colour palette: mainly white, light beige and soft grey with almost no accent colour.
Furniture: extremely simple and functional, no ornament.
Materials: flat-front light wood, plain textiles, zero clutter.
Décor: at most one or two small objects, very clean surfaces, lots of negative space.
      `
      );

    case "scandinavian":
      return build(
        "Scandinavian",
        `
Colour palette: white, light beige, sand and soft grey.
Furniture: light oak or birch wood, simple legs, soft rounded edges.
Materials: natural textiles, knitted throws, jute or woven rugs.
Décor: soft neutral artwork, plants, simple table lamps, calm and airy overall feel.
      `
      );

    case "traditional":
      return build(
        "Traditional",
        `
Colour palette: warm creams, beiges, and medium-to-dark wood tones.
Furniture: classic shapes, paneled or framed fronts, matching nightstands.
Materials: polished wood, fabric shades, layered textiles.
Décor: framed landscape or classic art, matching lamps, cushions with subtle patterns.
      `
      );

    case "industrial":
      return build(
        "Industrial",
        `
Colour palette: charcoal, black, dark wood, raw timber and concrete neutrals.
Furniture: the bedframe MUST be black metal or very dark wood. Nightstands and tables MUST be dark timber or metal. Do NOT use pale or blonde wood.
Materials: steel, black metal, reclaimed or rough timber, concrete or stone textures.
Textiles: bedding MUST be charcoal or dark grey; white may only appear as a minor accent, never dominant.
Décor: Edison-bulb or metal lamps, monochrome or urban abstract art.
Prohibitions:
- Do NOT use light oak or Scandinavian-style furniture.
- Do NOT use jute or woven coastal rugs.
- Do NOT use bright white bedding as primary colour.
- Do NOT use coastal or soft Scandinavian décor.
If any real-estate convention conflicts with these rules, ALWAYS choose the Industrial option.
    `
      );

    case "coastal":
      return build(
        "Coastal",
        `
Colour palette: white, sand, driftwood, soft blue or seafoam accents.
Furniture: whitewashed or light natural wood, relaxed forms.
Materials: linen, rattan, wicker, woven rugs.
Décor: ocean or beach artwork, simple coastal objects, bright and breezy overall.
      `
      );

    case "japandi":
      return build(
        "Japandi",
        `
Colour palette: warm beige, natural wood, charcoal and muted neutrals.
Furniture: low, simple pieces with clean lines and soft edges.
Materials: natural wood, linen, bamboo, smooth ceramics.
Décor: very sparse; a few carefully placed organic shapes, calm and balanced composition.
      `
      );

    case "hamptons":
      return build(
        "Hamptons",
        `
Colour palette: white, cream, beige and navy blue.
Furniture: elegant white or light timber, upholstered headboards.
Materials: linen, woven textures, subtle metallics.
Décor: coastal-luxe artwork, blue cushions, tasteful symmetry and light, airy styling.
      `
      );

    case "urban loft":
      return build(
        "Urban Loft",
        `
Colour palette: concrete grey, black, deep wood, occasional brick red accents.
Furniture: metal frames, leather or dark fabric seating, simple blocky pieces.
Materials: exposed or rough textures, metal shelving, reclaimed timber.
Décor: cityscape or bold abstract art, industrial lighting, edgy and urban feel.
      `
      );

    case "modern farmhouse":
    case "farmhouse modern":
      return build(
        "Modern Farmhouse",
        `
Colour palette: white, black and warm natural wood.
Furniture: simple shaker or cross-detail pieces, sturdy timber bed.
Materials: rustic wood, soft cotton and linen, light metals.
Décor: black metal lamps, simple greenery, subtle farmhouse-inspired art or signage.
      `
      );

    case "luxe contemporary":
    case "contemporary luxe":
      return build(
        "Luxe Contemporary",
        `
Colour palette: cream, champagne, soft grey, charcoal and warm metallic accents.
Furniture: upholstered headboards, smooth curved forms, refined silhouettes.
Materials: velvet or plush textiles, brass or gold, stone or stone-look tops.
Décor: abstract art with metallic hints, statement lamps, layered cushions and throws.
      `
      );

    case "nz modern":
    case "kiwi modern":
      return build(
        "NZ Modern",
        `
Colour palette: warm timber, charcoal, crisp white and muted bush greens.
Furniture: modern NZ-style oak or similar timber, clean simple profiles.
Materials: wool or knit throws, natural fibres, subtle textures.
Décor: understated New Zealand landscape art or pottery, relaxed but refined composition.
      `
      );

    case "nz_standard":
    case "nz standard":
    case "nz standard real estate":
      // NZ Standard Real Estate - The TRUE DEFAULT
      return NZ_STANDARD_STAGING.prompt;

    default: {
      // Safe, conservative fallback – use NZ Standard
      console.warn(
        `[stagingStyles] Unknown staging style "${style}", defaulting to NZ Standard Real Estate.`
      );
      return NZ_STANDARD_STAGING.prompt;
    }
  }
}
