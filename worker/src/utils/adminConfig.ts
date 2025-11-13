import fs from "fs/promises";
import path from "path";

export type GeminiSampling = {
  temperature?: number;
  topP?: number;
  topK?: number;
};

export type GeminiConfig = {
  sampling?: {
    interior?: {
      enhance?: GeminiSampling;
      declutter?: GeminiSampling;
    };
    exterior?: {
      enhance?: GeminiSampling;
      declutter?: GeminiSampling;
    };
    default?: GeminiSampling;
  };
  declutterIntensity?: "light" | "standard" | "heavy";
  declutterIntensityByScene?: {
    interior?: "light" | "standard" | "heavy";
    exterior?: "light" | "standard" | "heavy";
  };
};

let lastConfigPath: string | null = null;
let cachedConfig: GeminiConfig | null = null;
let lastLoadMs = 0;
const CACHE_TTL_MS = 1000; // refresh at most once per second

function resolveConfigPath(): string {
  const p = process.env.GEMINI_CONFIG_PATH || path.resolve(process.cwd(), "gemini.config.json");
  return p;
}

export async function getAdminConfig(): Promise<GeminiConfig> {
  const now = Date.now();
  const cfgPath = resolveConfigPath();
  if (cachedConfig && lastConfigPath === cfgPath && now - lastLoadMs < CACHE_TTL_MS) {
    return cachedConfig;
  }
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as GeminiConfig;
    cachedConfig = parsed || {};
    lastConfigPath = cfgPath;
    lastLoadMs = now;
    return cachedConfig;
  } catch {
    // Missing or invalid config is fine; return empty
    cachedConfig = {};
    lastConfigPath = cfgPath;
    lastLoadMs = now;
    return cachedConfig;
  }
}
