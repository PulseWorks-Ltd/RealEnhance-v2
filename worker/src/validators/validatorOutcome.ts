import type { StructuredIssue, ValidationIssueTier, ValidationIssueType } from "./issueTypes";
import type { StructuralSignal } from "./structuralSignal";

export enum ValidatorAuthority {
  PASS = "pass",
  ADVISORY = "advisory",
  BLOCKING = "blocking",
}

export function assertValidatorAuthorityInvariant(params: {
  authority: ValidatorAuthority;
  passed: boolean;
  hardFail: boolean;
  source: string;
}): void {
  if (params.authority === ValidatorAuthority.BLOCKING && params.passed) {
    throw new Error(`[VALIDATOR_AUTHORITY_INVARIANT] ${params.source}: blocking authority cannot be passed=true`);
  }
  if (params.authority === ValidatorAuthority.PASS && !params.passed) {
    throw new Error(`[VALIDATOR_AUTHORITY_INVARIANT] ${params.source}: pass authority cannot be passed=false`);
  }
  if (params.authority === ValidatorAuthority.BLOCKING && params.hardFail !== true) {
    throw new Error(`[VALIDATOR_AUTHORITY_INVARIANT] ${params.source}: blocking authority requires hardFail=true`);
  }
  if (params.hardFail === true && params.authority !== ValidatorAuthority.BLOCKING) {
    throw new Error(`[VALIDATOR_AUTHORITY_INVARIANT] ${params.source}: hardFail=true requires blocking authority`);
  }
}

export type ValidatorOutcome = {
  status: "pass" | "fail";
  authority: ValidatorAuthority;
  decision?: "pass" | "advisory" | "fail";
  verificationRequests?: string[];
  reason: string;
  confidence: number;
  hardFail: boolean;
  advisory?: boolean;
  issueType: ValidationIssueType;
  issueTier: ValidationIssueTier;
  advisorySignals: string[];
  primaryStructuredIssue?: StructuredIssue;
  structuredIssues?: StructuredIssue[];
  structuralSignals?: StructuralSignal[];
  maskedDriftRegions?: Array<{
    bbox: [number, number, number, number];
    score: number;
  }>;
  openingRegions?: Array<{
    bbox: [number, number, number, number];
    type: "window" | "door";
  }>;
  fixtureRepair?: {
    supported: boolean;
    repairType?: "FIXTURE_ADDED" | "FIXTURE_REMOVED" | "FIXTURE_MODIFIED";
    fixtureClass?: "LIGHTING" | "HVAC" | "UNKNOWN";
    fixtureStateChange?: "ADDED" | "REMOVED" | "MODIFIED" | "UNKNOWN";
    action?: "added" | "removed" | "modified" | "unknown";
    localizationMode?: "diff_zone_ceiling" | "diff_zone_hvac";
    reasonTokens?: string[];
  };
};
