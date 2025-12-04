export type OperationKind = "enhance" | "edit" | "region-edit";

export interface JobMetadata {
  jobId: string;
  userId: string;
  operation: OperationKind;
  imageId: string;
  originalImageUrl?: string;
  baseKey?: string;
  stages?: { run1A?: boolean; run1B?: boolean; run2?: boolean };
  prompt?: string;
  instruction?: string;
  mask?: string | null;
  options?: Record<string, any>;
  createdAt: string;
  retryOf?: string;
}
