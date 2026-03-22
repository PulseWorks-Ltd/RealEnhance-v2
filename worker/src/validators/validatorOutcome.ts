import type { ValidationIssueTier, ValidationIssueType } from "./issueTypes";

export type ValidatorOutcome = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
  hardFail: boolean;
  issueType: ValidationIssueType;
  issueTier: ValidationIssueTier;
  advisorySignals: string[];
  maskedDriftRegions?: Array<{
    bbox: [number, number, number, number];
    score: number;
  }>;
  openingRegions?: Array<{
    bbox: [number, number, number, number];
    type: "window" | "door";
  }>;
};
