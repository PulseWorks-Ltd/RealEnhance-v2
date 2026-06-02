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
    repairType?: "FIXTURE_ADDED" | "FIXTURE_REMOVED" | "FIXTURE_MODIFIED";
    fixtureClass?: "LIGHTING" | "HVAC" | "UNKNOWN";
    fixtureStateChange?: "ADDED" | "REMOVED" | "MODIFIED" | "UNKNOWN";
    action?: "added" | "removed" | "modified" | "unknown";
    localizationMode?: "diff_zone_ceiling" | "diff_zone_hvac";
    reasonTokens?: string[];
  };
};
