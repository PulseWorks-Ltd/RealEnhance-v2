// server/src/shared/types.ts

/* ---------- Core IDs ---------- */
export type UserId = string;
export type JobId  = string;
export type ImageId = string;

/* ---------- Users ---------- */
export interface AuthUser {
  id: UserId;
  name: string;
  email: string;
  credits: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserRecord extends AuthUser {
  /** images owned by this user */
  imageIds: ImageId[];
}

/* ---------- Images / Library ---------- */

export interface ImageVersionEntry {
  /** stable id for this version (not the image id) */
  versionId: string;
  /** human-facing stage label (e.g., "uploaded", "enhanced x2") */
  stageLabel: string;
  /** storage path or URL to this version’s file */
  filePath: string;
  /** ISO timestamp */
  createdAt: string;
  /** optional note */
  note?: string;
}
export type ImageVersion = ImageVersionEntry;

export interface ImageRecord {
  /** main image identifier (primary key) */
  id: ImageId;

  /** legacy alias; always equals id */
  imageId: ImageId;

  /** owner relationship used by filters and guards */
  ownerUserId: UserId;

  /** current active version id (points to an entry in `history`) */
  currentVersionId: string;

  /** full timeline of created versions */
  history: ImageVersionEntry[];

  /** optional storage path for the original upload */
  originalPath?: string;

  /** optional convenience map of version -> URL/path */
  versions?: Partial<Record<"original"|"preview"|"processed"|"thumb"|"web", string>>;

  /** original source info if tracked */
  sourceUrl?: string;
  fileKey?: string;

  meta?: Record<string, unknown>;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/* ---------- Jobs / Processing ---------- */

export type JobStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobKind = "enhance" | "edit" | "ingest" | "cleanup";

/** Strongly-typed payloads you enqueue */
export interface EnhanceJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance";
  options: {
    declutter: boolean;
    virtualStage: boolean;
    roomType: string;
    sceneType: string;
  };
  createdAt: string; // ISO
}

export interface EditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "edit";
  baseVersionId: string;
  mode: "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  mask: unknown;
  createdAt: string; // ISO
}

export type AnyJobPayload = EnhanceJobPayload | EditJobPayload;

export interface ImageJobResult {
  outputUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  format?: "jpg" | "png" | "webp";
  meta?: Record<string, unknown>;
}

/** Persisted job record */
export interface JobRecord {
  /** keep id = jobId for simplicity */
  id: JobId;
  jobId?: JobId;

  /** link job to an image when applicable */
  imageId?: ImageId;

  /** used by routes/status.ts to assert ownership */
  userId: UserId;

  /** kind of job */
  type?: JobKind;

  status: JobStatus;

  /** what you enqueued */
  payload: AnyJobPayload;

  result?: ImageJobResult;
  error?: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/* ---------- API helpers ---------- */
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string };
export type ApiResponse<T> = ApiOk<T> | ApiErr;
