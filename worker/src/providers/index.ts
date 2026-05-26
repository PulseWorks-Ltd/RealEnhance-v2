import { VertexContinuityRepairProvider } from "./vertex/continuityRepairProvider";
import type { ContinuityRepairProvider } from "./types";
import { VertexSecondaryContinuityError } from "../continuity/types";
import { nLog } from "../logger";

export function createContinuityRepairProvider(): ContinuityRepairProvider {
  const rawProvider = String(process.env.SECONDARY_CONTINUITY_PROVIDER || "").trim();
  const provider = String(rawProvider || "vertex").trim().toLowerCase();
  const selectedImplementation = provider === "vertex" ? "VertexContinuityRepairProvider" : null;

  nLog("[CONTINUITY_PROVIDER_RESOLUTION]", {
    rawEnvValues: {
      SECONDARY_CONTINUITY_PROVIDER: rawProvider || null,
      SECONDARY_CONTINUITY_RENDERER: String(process.env.SECONDARY_CONTINUITY_RENDERER || "").trim() || null,
      SECONDARY_CONTINUITY_PLANNER: String(process.env.SECONDARY_CONTINUITY_PLANNER || "").trim() || null,
    },
    normalizedValues: {
      provider,
      renderer: String(process.env.SECONDARY_CONTINUITY_RENDERER || "imagen3").trim().toLowerCase(),
      planner: String(process.env.SECONDARY_CONTINUITY_PLANNER || "gemini25pro").trim().toLowerCase(),
    },
    selectedImplementation,
    fallbackReasons: rawProvider ? [] : ["provider_env_missing_defaulted_to_vertex"],
  });

  if (provider === "vertex") {
    return new VertexContinuityRepairProvider();
  }
  throw new VertexSecondaryContinuityError(
    `Unsupported secondary continuity provider: ${provider}`,
    "unsupported_secondary_continuity_provider"
  );
}