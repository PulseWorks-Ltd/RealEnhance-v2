export type StructuralConsensusStatus = "FAIL" | "PASS" | string;

export type StructuralConsensusInput = {
  stage: string;
  validationMode: string;
  jobId: string;
  semantic?: {
    windowsStatus?: StructuralConsensusStatus;
    wallDriftStatus?: StructuralConsensusStatus;
  };
  masked?: {
    maskedDriftStatus?: StructuralConsensusStatus;
    openingsStatus?: StructuralConsensusStatus;
  };
  composite?: {
    decision?: StructuralConsensusStatus;
  };
};

export type StructuralConsensusVerdict = {
  hardFail: boolean;
  category?: string;
  violationType?: string;
};

export type StructuralConsensusCase =
  | "CATASTROPHIC_BACKSTOP"
  | "SOFT_STRUCTURAL_REVIEW"
  | "NORMAL";

function isFail(value: StructuralConsensusStatus | undefined): boolean {
  return String(value || "").toUpperCase() === "FAIL";
}

export function countStructuralConsensusWarnings(input: StructuralConsensusInput): number {
  let derivedWarnings = 0;

  if (isFail(input.semantic?.windowsStatus)) derivedWarnings++;
  if (isFail(input.semantic?.wallDriftStatus)) derivedWarnings++;
  if (isFail(input.masked?.maskedDriftStatus)) derivedWarnings++;
  if (isFail(input.masked?.openingsStatus)) derivedWarnings++;
  if (isFail(input.composite?.decision)) derivedWarnings++;

  return derivedWarnings;
}

export function applyStructuralConsensusBackstop(
  verdict: StructuralConsensusVerdict,
  input: StructuralConsensusInput
): { applied: boolean; derivedWarnings: number } {
  if (!(input.stage === "2" && input.validationMode === "FULL_STAGE_ONLY")) {
    return { applied: false, derivedWarnings: 0 };
  }

  const derivedWarnings = countStructuralConsensusWarnings(input);

  if (derivedWarnings >= 5) {
    console.log("[STRUCTURAL_CONSENSUS_BACKSTOP] derivedWarnings>=5 forcing hardFail", {
      jobId: input.jobId,
      derivedWarnings,
    });

    verdict.hardFail = true;
    verdict.category = "structure";
    verdict.violationType = "structural_consensus";
    return { applied: true, derivedWarnings };
  }

  return { applied: false, derivedWarnings };
}

export function classifyStructuralConsensusCase(
  input: StructuralConsensusInput
): { derivedWarnings: number; mode: StructuralConsensusCase } {
  const derivedWarnings = countStructuralConsensusWarnings(input);

  if (derivedWarnings >= 5) {
    return { derivedWarnings, mode: "CATASTROPHIC_BACKSTOP" };
  }

  if (derivedWarnings === 3 || derivedWarnings === 4) {
    return { derivedWarnings, mode: "SOFT_STRUCTURAL_REVIEW" };
  }

  return { derivedWarnings, mode: "NORMAL" };
}
