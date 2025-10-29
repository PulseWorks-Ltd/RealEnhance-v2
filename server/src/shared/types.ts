// server/src/shared/types.ts

export type UserId = string;
export type JobId = string;

export interface AuthUser {
  id: UserId;
  name: string;
  email: string;
  credits: number;
  createdAt?: string;
  updatedAt?: string;
}

export type JobStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ImageOperation =
  | "enhance"
  | "denoise"
  | "sharpen"
  | "resize"
  | "upscale"
  | "watermark";

/** What the client/API sends when enqueuing a job */
export interface ImageJobPayload {
  userId: UserId;
  /** If file was uploaded to storage, a key/path you can fetch */
  fileKey?: string;
  /** If processing a remote URL directly */
  sourceUrl?: string;
  /** List of operations to apply in order */
  operations: ImageOperation[];
  /** Optional extra settings */
  options?: Record<string, unknown>;
  requestedAt: string; // ISO string
}

/** Result info saved after processing succeeds */
export interface ImageJobResult {
  outputUrl: string;        // public URL (or signed)
  width: number;
  height: number;
  sizeBytes: number;
  format?: "jpg" | "png" | "webp";
  meta?: Record<string, unknown>;
}

/** Queue item + persisted model */
export interface ImageJob {
  id: JobId;
  status: JobStatus;
  payload: ImageJobPayload;
  result?: ImageJobResult;
  error?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** Optional: credit ledger entry if your code records these */
export interface CreditLedgerEntry {
  id: string;
  userId: UserId;
  delta: number; // negative for spends, positive for purchases/grants
  reason: "job" | "purchase" | "admin";
  jobId?: JobId;
  createdAt: string;
}

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string };
export type ApiResponse<T> = ApiOk<T> | ApiErr;
