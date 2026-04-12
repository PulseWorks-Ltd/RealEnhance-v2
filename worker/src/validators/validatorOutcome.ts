import type { ValidationIssueTier, ValidationIssueType } from "./issueTypes";
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
  structuralSignals?: StructuralSignal[];
  maskedDriftRegions?: Array<{
    bbox: [number, number, number, number];
    score: number;
  }>;
  openingRegions?: Array<{
    bbox: [number, number, number, number];
    type: "window" | "door";
  }>;
};
