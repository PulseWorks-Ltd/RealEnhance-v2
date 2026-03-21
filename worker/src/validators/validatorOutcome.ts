export type ValidatorOutcome = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
  hardFail: boolean;
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
