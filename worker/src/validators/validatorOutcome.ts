import type { StructuredIssue, ValidationIssueTier, ValidationIssueType } from "./issueTypes";
import type { StructuralSignal } from "./structuralSignal";

export type ValidatorOutcome = {
  status: "pass" | "fail";
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
    repairType?:
      | "PENDANT_LIGHT_ADDED"
      | "HANGING_LIGHT_ADDED"
      | "SUSPENDED_CEILING_FIXTURE_ADDED"
      | "DECORATIVE_CEILING_FEATURE_LIGHT_ADDED"
      | "HVAC_VENT_ADDED"
      | "HVAC_VENT_REMOVED"
      | "HVAC_VENT_MODIFIED";
    action?: "added" | "removed" | "modified" | "unknown";
    localizationMode?: "diff_zone_ceiling" | "diff_zone_hvac";
    reasonTokens?: string[];
  };
};
