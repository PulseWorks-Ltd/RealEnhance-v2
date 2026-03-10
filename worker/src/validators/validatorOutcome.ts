export type ValidatorOutcome = {
  status: "pass" | "fail";
  reason: string;
  confidence: number;
  hardFail: boolean;
  advisorySignals: string[];
};
