type EvidenceGatingMode = "off" | "on" | "ab";
export type EvidenceGatingVariant = "off" | "on" | "A_off" | "B_on";

const LEGACY_EVIDENCE_GATING = (process.env.VALIDATOR_EVIDENCE_GATING ?? "false") === "true" ||
  (process.env.VALIDATOR_EVIDENCE_GATING ?? "false") === "1";

const resolveGatingMode = (): EvidenceGatingMode => {
  const raw = (process.env.VALIDATOR_EVIDENCE_GATING_MODE || "").trim().toLowerCase();
  if (raw === "off" || raw === "on" || raw === "ab") return raw;
  if (LEGACY_EVIDENCE_GATING) return "on";
  return "off";
};

const simpleHash = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

export const getEvidenceGatingVariant = (jobId?: string): EvidenceGatingVariant => {
  const mode = resolveGatingMode();
  if (mode === "off") return "off";
  if (mode === "on") return "on";

  const hash = simpleHash(jobId || "unknown");
  return (hash % 2 === 0) ? "A_off" : "B_on";
};

export const isEvidenceGatingEnabledForJob = (jobId?: string): boolean => {
  const variant = getEvidenceGatingVariant(jobId);
  return variant === "on" || variant === "B_on";
};
