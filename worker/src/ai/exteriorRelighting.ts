import sharp from "sharp";

import type { EnvironmentType, LightingDecision, LightingProfile } from "./exteriorEnvironmentAnalyzer";
import { siblingOutPath } from "../utils/images";

export interface ImageStats {
  specularRatio: number;
  saturation: number;
  contrast: number;
}

export interface WetSurfaceContext {
  environment: EnvironmentType;
  groundPlaneDetected: boolean;
}

type SkyColor = { r: number; g: number; b: number };

type RawImageData = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
  wetMask: Uint8Array;
  imageStats: ImageStats;
  strength: number;
  structuralLock: typeof structuralLock;
};

export const structuralLock = {
  preventGeometryChanges: true,
  preventMaskExpansion: true,
  preventSkyLeakage: true,
} as const;

const WOOD_HUE_MIN = 10;
const WOOD_HUE_MAX = 35;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHsl(red: number, green: number, blue: number): { h: number; s: number; l: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) {
    return { h: 0, s: 0, l: lightness };
  }

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === r) {
    hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    hue = ((b - r) / delta + 2) / 6;
  } else {
    hue = ((r - g) / delta + 4) / 6;
  }

  return { h: hue * 360, s: saturation, l: lightness };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb(hue: number, saturation: number, lightness: number): SkyColor {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = clamp01(saturation);
  const l = clamp01(lightness);

  if (s === 0) {
    const channel = clampChannel(l * 255);
    return { r: channel, g: channel, b: channel };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: clampChannel(hueToRgb(p, q, h + 1 / 3) * 255),
    g: clampChannel(hueToRgb(p, q, h) * 255),
    b: clampChannel(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function getLuminance(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function isWoodHue(hue: number): boolean {
  return hue >= WOOD_HUE_MIN && hue <= WOOD_HUE_MAX;
}

function profileSettings(profile: LightingProfile): {
  brightness: number;
  saturation: number;
  contrast: number;
} {
  switch (profile) {
    case "bright_premium":
      return { brightness: 1.12, saturation: 1.08, contrast: 1.07 };
    case "light_sunny":
      return { brightness: 1.08, saturation: 1.05, contrast: 1.05 };
    case "dusk_dawn":
      return { brightness: 1.06, saturation: 1.06, contrast: 1.04 };
    case "overcast":
    default:
      return { brightness: 1.07, saturation: 1.04, contrast: 1.04 };
  }
}

export function detectWetSurface(imageStats: ImageStats): boolean {
  return detectWetSurfaceWithContext(imageStats, {
    environment: "uncertain",
    groundPlaneDetected: true,
  });
}

export function detectWetSurfaceWithContext(
  imageStats: ImageStats,
  context: WetSurfaceContext
): boolean {
  return (
    context.environment !== "interior" &&
    context.groundPlaneDetected === true &&
    imageStats.specularRatio > 0.18 &&
    imageStats.saturation < 0.35 &&
    imageStats.contrast < 0.5
  );
}

function detectGroundPlane(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  environment: EnvironmentType
): boolean {
  if (environment === "interior") {
    return false;
  }

  const startRow = Math.max(0, Math.floor(height * 0.52));
  let candidateCount = 0;
  let totalCount = 0;

  for (let y = startRow; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const channelIndex = index * channels;
      const red = data[channelIndex] ?? 0;
      const green = data[channelIndex + 1] ?? 0;
      const blue = data[channelIndex + 2] ?? 0;
      const { h, s, l } = rgbToHsl(red, green, blue);
      const neutralHardscape = s < 0.32 && l > 0.18 && l < 0.88;
      const timberGround = isWoodHue(h) && l > 0.15 && l < 0.8;
      if (neutralHardscape || timberGround) {
        candidateCount += 1;
      }
      totalCount += 1;
    }
  }

  return totalCount > 0 && (candidateCount / totalCount) >= 0.38;
}

function buildSkyMask(data: Uint8ClampedArray, width: number, height: number, channels: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const topLimit = Math.max(1, Math.floor(height * 0.58));

  for (let y = 0; y < topLimit; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const channelIndex = index * channels;
      const red = data[channelIndex] ?? 0;
      const green = data[channelIndex + 1] ?? 0;
      const blue = data[channelIndex + 2] ?? 0;
      const { h, s, l } = rgbToHsl(red, green, blue);
      const blueSky = h >= 185 && h <= 245 && s >= 0.18 && l >= 0.38;
      const overcastSky = l >= 0.62 && s <= 0.18 && blue >= red - 12;
      if (blueSky || overcastSky) {
        mask[index] = 1;
      }
    }
  }

  return mask;
}

function fallbackSkyColor(environment: EnvironmentType): SkyColor {
  switch (environment) {
    case "exterior_sunny":
      return { r: 156, g: 194, b: 238 };
    case "exterior_partial_cover":
      return { r: 166, g: 198, b: 232 };
    case "exterior_overcast":
      return { r: 184, g: 194, b: 206 };
    default:
      return { r: 172, g: 186, b: 202 };
  }
}

function sampleSkyColor(
  data: Uint8ClampedArray,
  skyMask: Uint8Array,
  width: number,
  height: number,
  channels: number,
  environment: EnvironmentType
): SkyColor {
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let count = 0;

  for (let index = 0; index < width * height; index += 1) {
    if (!skyMask[index]) continue;
    const channelIndex = index * channels;
    redSum += data[channelIndex] ?? 0;
    greenSum += data[channelIndex + 1] ?? 0;
    blueSum += data[channelIndex + 2] ?? 0;
    count += 1;
  }

  if (count < Math.max(64, Math.floor(width * height * 0.01))) {
    return fallbackSkyColor(environment);
  }

  return {
    r: Math.round(redSum / count),
    g: Math.round(greenSum / count),
    b: Math.round(blueSum / count),
  };
}

function computeImageStats(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  channels: number
): ImageStats {
  const startRow = Math.max(0, Math.floor(height * 0.45));
  let specularCount = 0;
  let totalCount = 0;
  let saturationSum = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;

  for (let y = startRow; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const channelIndex = index * channels;
      const red = data[channelIndex] ?? 0;
      const green = data[channelIndex + 1] ?? 0;
      const blue = data[channelIndex + 2] ?? 0;
      const { s } = rgbToHsl(red, green, blue);
      const luminance = getLuminance(red, green, blue);
      const specular = luminance > 0.78 && s < 0.2;

      if (specular) specularCount += 1;
      saturationSum += s;
      luminanceSum += luminance;
      luminanceSqSum += luminance * luminance;
      totalCount += 1;
    }
  }

  const meanLuminance = totalCount > 0 ? luminanceSum / totalCount : 0;
  const variance = totalCount > 0 ? Math.max(0, (luminanceSqSum / totalCount) - (meanLuminance * meanLuminance)) : 0;
  const contrast = clamp01(Math.sqrt(variance) * 2.2);

  return {
    specularRatio: totalCount > 0 ? specularCount / totalCount : 0,
    saturation: totalCount > 0 ? saturationSum / totalCount : 0,
    contrast,
  };
}

function buildWetMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  channels: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const startRow = Math.max(0, Math.floor(height * 0.46));

  for (let y = startRow; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const channelIndex = index * channels;
      const red = data[channelIndex] ?? 0;
      const green = data[channelIndex + 1] ?? 0;
      const blue = data[channelIndex + 2] ?? 0;
      const { s, l } = rgbToHsl(red, green, blue);
      const reflective = l > 0.42 && s < 0.24;
      const highlight = l > 0.72 && s < 0.18;
      if (reflective || highlight) {
        mask[index] = 1;
      }
    }
  }

  return mask;
}

function applySkyAdjustments(
  data: Uint8ClampedArray,
  skyMask: Uint8Array,
  channels: number,
  profile: LightingProfile,
  strength: number
): void {
  const skyStrength = clamp01(strength * 0.4);
  const satBoost = profile === "bright_premium" ? 1 + (0.06 * skyStrength) : 1 + (0.04 * skyStrength);
  const lumBoost = 1 + (0.05 * skyStrength);

  for (let index = 0; index < skyMask.length; index += 1) {
    if (!skyMask[index]) continue;
    const channelIndex = index * channels;
    const { h, s, l } = rgbToHsl(
      data[channelIndex] ?? 0,
      data[channelIndex + 1] ?? 0,
      data[channelIndex + 2] ?? 0
    );
    const adjusted = hslToRgb(h, clamp01(s * satBoost), clamp01(l * lumBoost));
    data[channelIndex] = adjusted.r;
    data[channelIndex + 1] = adjusted.g;
    data[channelIndex + 2] = adjusted.b;
  }
}

export function applyWetSurfaceCoherence(
  imageData: RawImageData,
  skyColor: SkyColor,
  environment: EnvironmentType
): void {
  const { data, width, height, channels, wetMask, strength, structuralLock: lock } = imageData;
  const reflectGain = environment === "exterior_partial_cover" ? 0.1 : 0.08;
  const highlightBoost = environment === "exterior_partial_cover" ? 1.1 : 1.075;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!wetMask[index]) continue;
      const channelIndex = index * channels;
      const { h, s, l } = rgbToHsl(
        data[channelIndex] ?? 0,
        data[channelIndex + 1] ?? 0,
        data[channelIndex + 2] ?? 0
      );
      const highlight = l > 0.64 && s < 0.2;
      const reflective = l > 0.45 && s < 0.24;

      let red = data[channelIndex] ?? 0;
      let green = data[channelIndex + 1] ?? 0;
      let blue = data[channelIndex + 2] ?? 0;

      if (highlight) {
        red += skyColor.r * reflectGain;
        green += skyColor.g * reflectGain;
        blue += skyColor.b * (reflectGain + 0.04);
        const lumScale = 1 + ((highlightBoost - 1) * strength);
        red *= lumScale;
        green *= lumScale;
        blue *= lumScale;
      }

      let adjusted = rgbToHsl(red, green, blue);

      if (isWoodHue(adjusted.h)) {
        const satBoost = 1 + ((environment === "exterior_partial_cover" ? 0.12 : 0.1) * strength);
        adjusted = {
          ...adjusted,
          s: clamp01(adjusted.s * satBoost),
          l: clamp01(adjusted.l * 1.05),
        };
      }

      if (reflective) {
        adjusted = {
          ...adjusted,
          l: clamp01(adjusted.l * (1 + (0.04 * strength))),
        };
      }

      const rgb = hslToRgb(adjusted.h, adjusted.s, adjusted.l);
      data[channelIndex] = rgb.r;
      data[channelIndex + 1] = rgb.g;
      data[channelIndex + 2] = rgb.b;
    }
  }

  const kernelRadius = 1;
  const localContrast = environment === "exterior_partial_cover" ? 1.1 : 1.06;
  const source = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (!wetMask[index]) continue;

      let neighborLuma = 0;
      let samples = 0;
      for (let ky = -kernelRadius; ky <= kernelRadius; ky += 1) {
        for (let kx = -kernelRadius; kx <= kernelRadius; kx += 1) {
          const sampleIndex = ((y + ky) * width + (x + kx)) * channels;
          neighborLuma += getLuminance(
            source[sampleIndex] ?? 0,
            source[sampleIndex + 1] ?? 0,
            source[sampleIndex + 2] ?? 0
          );
          samples += 1;
        }
      }

      const avgLuma = neighborLuma / Math.max(1, samples);
      const channelIndex = index * channels;
      const currentLuma = getLuminance(
        data[channelIndex] ?? 0,
        data[channelIndex + 1] ?? 0,
        data[channelIndex + 2] ?? 0
      );
      const delta = (currentLuma - avgLuma) * (localContrast - 1);
      const scale = 1 + delta;

      data[channelIndex] = clampChannel((data[channelIndex] ?? 0) * scale);
      data[channelIndex + 1] = clampChannel((data[channelIndex + 1] ?? 0) * scale);
      data[channelIndex + 2] = clampChannel((data[channelIndex + 2] ?? 0) * scale);
    }
  }

  for (let y = Math.floor(height * 0.68); y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const channelIndex = index * channels;
      const luma = getLuminance(
        data[channelIndex] ?? 0,
        data[channelIndex + 1] ?? 0,
        data[channelIndex + 2] ?? 0
      );
      const leftLuma = getLuminance(
        data[channelIndex - channels] ?? 0,
        data[channelIndex - channels + 1] ?? 0,
        data[channelIndex - channels + 2] ?? 0
      );
      const rightLuma = getLuminance(
        data[channelIndex + channels] ?? 0,
        data[channelIndex + channels + 1] ?? 0,
        data[channelIndex + channels + 2] ?? 0
      );
      if (luma < 0.32 && leftLuma - luma > 0.08 && rightLuma - luma > 0.08) {
        const darken = 0.92 + (0.04 * (1 - strength));
        for (let ky = 0; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            const targetIndex = ((y + ky) * width + (x + kx)) * channels;
            data[targetIndex] = clampChannel((data[targetIndex] ?? 0) * darken);
            data[targetIndex + 1] = clampChannel((data[targetIndex + 1] ?? 0) * darken);
            data[targetIndex + 2] = clampChannel((data[targetIndex + 2] ?? 0) * darken);
          }
        }
      }
    }
  }

  if (lock.preventSkyLeakage) {
    // Any sky-specific tweaks must stay inside the sky mask.
  }
}

export async function applyExteriorRelighting(
  inputPath: string,
  decision: LightingDecision,
  environment: EnvironmentType = "uncertain"
): Promise<string> {
  if (!decision.shouldRelight || decision.strength <= 0) {
    return inputPath;
  }

  const image = sharp(inputPath).rotate().removeAlpha().toColourspace("srgb");
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const width = info.width || 0;
  const height = info.height || 0;
  const channels = info.channels || 3;

  if (!width || !height || channels < 3) {
    return inputPath;
  }

  const output = new Uint8ClampedArray(data);
  const imageStats = computeImageStats(output, width, height, channels);
  const groundPlaneDetected = detectGroundPlane(output, width, height, channels, environment);
  const wetSurface = detectWetSurfaceWithContext(imageStats, {
    environment,
    groundPlaneDetected,
  });
  const wetBoostedStrength = wetSurface
    ? Math.min(decision.strength + 0.1, 0.85)
    : Math.min(decision.strength, 0.85);
  const strength = clamp01(wetBoostedStrength);
  const skyMask = buildSkyMask(output, width, height, channels);
  const skyColor = sampleSkyColor(output, skyMask, width, height, channels, environment);
  const wetMask = buildWetMask(output, width, height, channels);
  const settings = profileSettings(decision.profile);
  const brightnessBoost = Math.min(0.15, (settings.brightness - 1) * strength);
  const saturationBoost = Math.min(0.12, (settings.saturation - 1) * strength);
  const contrastBoost = Math.min(0.12, (settings.contrast - 1) * strength);
  const midtoneContrastBoost = environment === "exterior_partial_cover" ? 1.1 : 1.0;

  for (let index = 0; index < width * height; index += 1) {
    const channelIndex = index * channels;
    const original = rgbToHsl(
      output[channelIndex] ?? 0,
      output[channelIndex + 1] ?? 0,
      output[channelIndex + 2] ?? 0
    );

    let lightness = clamp01(original.l * (1 + brightnessBoost));
    let saturation = clamp01(original.s * (1 + saturationBoost));

    if (midtoneContrastBoost > 1 && lightness >= 0.2 && lightness <= 0.8) {
      lightness = clamp01(0.5 + ((lightness - 0.5) * midtoneContrastBoost));
    }

    if (contrastBoost > 0) {
      lightness = clamp01(0.5 + ((lightness - 0.5) * (1 + contrastBoost)));
    }

    const adjusted = hslToRgb(original.h, saturation, lightness);
    output[channelIndex] = adjusted.r;
    output[channelIndex + 1] = adjusted.g;
    output[channelIndex + 2] = adjusted.b;
  }

  if (structuralLock.preventSkyLeakage) {
    applySkyAdjustments(output, skyMask, channels, decision.profile, strength);
  }

  if (decision.shouldReplaceSky && wetSurface) {
    applyWetSurfaceCoherence({
      data: output,
      width,
      height,
      channels,
      wetMask,
      imageStats,
      strength,
      structuralLock,
    }, skyColor, environment);
  }

  const outputPath = siblingOutPath(inputPath, "-env-relit");
  await sharp(Buffer.from(output), {
    raw: { width, height, channels },
  })
    .webp({ quality: 95, effort: 6 })
    .toFile(outputPath);

  return outputPath;
}