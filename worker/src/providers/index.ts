import { VertexContinuityRepairProvider } from "./vertex/continuityRepairProvider";
import type { ContinuityRepairProvider } from "./types";
import { VertexSecondaryContinuityError } from "../continuity/types";

export function createContinuityRepairProvider(): ContinuityRepairProvider {
  const provider = String(process.env.SECONDARY_CONTINUITY_PROVIDER || "vertex").trim().toLowerCase();
  if (provider === "vertex") {
    return new VertexContinuityRepairProvider();
  }
  throw new VertexSecondaryContinuityError(
    `Unsupported secondary continuity provider: ${provider}`,
    "unsupported_secondary_continuity_provider"
  );
}