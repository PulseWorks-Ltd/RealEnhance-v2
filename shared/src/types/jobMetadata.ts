export type StageUrls = {
  stage1a?: string;
  stage1b?: string;
  stage2?: string;
  publish?: string;
};

export type RequestedStages = {
  stage1a?: boolean;
  stage1b?: "light" | "full" | undefined;
  stage2?: boolean;
  stage2Mode?: "empty" | "refresh" | "auto";
};

export type JobOwnershipMetadata = {
  userId: string;
  imageId: string;
  jobId: string;
  createdAt: string; // ISO
  requestedStages?: RequestedStages;
  stageUrls?: StageUrls;
  resultUrl?: string;
  s3?: { key?: string; versionId?: string | null; fallbackVersionKey?: string };
  warnings?: string[];
  debug?: { stage2ModeUsed?: "empty" | "refresh"; validatorSummary?: any };
  // Allow forward-compatible fields without breaking
  [key: string]: any;
};
