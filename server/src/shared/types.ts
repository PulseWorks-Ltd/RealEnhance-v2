// server/src/shared/types.ts

/* ---------- Core IDs ---------- */
export type UserId = string;
export type JobId  = string;
export type ImageId = string;

/* ---------- Users ---------- */
export interface AuthUser {
  id: UserId;
  name?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email: string;
  credits: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord extends AuthUser {
  /** images owned by this user */
  imageIds: ImageId[];
  /** Optional password hash for email/password authentication */
  passwordHash?: string;
  /** Authentication provider: "email" for email/password, "google" for OAuth, "both" for linked accounts */
  authProvider: "email" | "google" | "both";
  /** Optional Google profile ID for account linking */
  googleId?: string;
  /** Optional agency ID for multi-user agency accounts */
  agencyId?: string | null;
  /** Agency role: owner, admin, or member */
  role?: "owner" | "admin" | "member";
  /** Whether user account is active (can log in) */
  isActive?: boolean;
  /** Future: plan-based limits (not enforced yet) */
  plan?: "free" | "individual" | "agency";
  /** Usage tracking for analytics (not enforcement) */
  usageStats?: {
    monthlyImages: number;
    monthlyListings: number;
  };
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

  /** agency that owns this image (for retention tracking) */
  agencyId?: string;

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
  | "enhance"
  | "edit"
  | "region-edit"
  | "diagnosis"
  | "classification"
  | "credit-purchase"
  | "credit-grant"
  | "credit-revoke"
  | "credit-refund"
  | "credit-adjust"
  | "credit-expire"
  | "credit-restore"
  | "credit-transfer"
  | "credit-batch-grant"
  | "credit-batch-revoke"
  | "credit-batch-refund"
  | "credit-batch-adjust"
  | "credit-batch-expire"
  | "credit-batch-restore"
  | "credit-batch-transfer"
  | "credit-batch-purchase";

// Declutter mode tuning for Stage 1B
export type DeclutterMode = "light" | "stage-ready";

export type JobKind =
  | "enhance"
  | "edit"
  | "region-edit"
  | "diagnosis"
  | "classification"
  | "credit-purchase"
  | "credit-grant"
  | "credit-revoke"
  | "credit-refund"
  | "credit-adjust"
  | "credit-expire"
  | "credit-restore"
  | "credit-transfer"
  | "credit-batch-grant"
  | "credit-batch-revoke"
  | "credit-batch-refund"
  | "credit-batch-adjust"
  | "credit-batch-expire"
  | "credit-batch-restore"
  | "credit-batch-transfer"
  | "credit-batch-purchase";

/** Strongly-typed payloads you enqueue */
export interface EnhanceJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance";
  agencyId?: string | null;          // Usage/billing context
  listingId?: string;                // Optional grouping across listings
  manualSceneOverride?: boolean;     // Top-level override flag (legacy support)
  options: {
    declutter: boolean;
    virtualStage: boolean;
    roomType: string;
    sceneType: string | "auto";
    replaceSky?: boolean;            // Sky replacement toggle (auto-enable exteriors)
    stagingStyle?: string;           // Staging style (defaults to nz_standard)
    declutterMode?: DeclutterMode;   // Stage 1B mode
    declutterIntensity?: "light" | "standard" | "heavy";
    manualSceneOverride?: boolean;   // Per-image manual scene flag
    scenePrediction?: {              // Client-side scene prediction for SKY_SAFE forcing
      scene: string | null;
      confidence: number;
      reason?: string;
      features?: Record<string, number>;
      source?: string;
    };
    sampling?: {                     // Optional sampling overrides
      temperature?: number;
      topP?: number;
      topK?: number;
    };
  };
  stage2OnlyMode?: {                 // Smart Stage-2 retry mode
    enabled: boolean;
    base1BUrl: string;
  };
  remoteOriginalUrl?: string;        // S3 URL of original if uploaded
  remoteOriginalKey?: string;        // S3 key of original if uploaded
  createdAt: string;
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
  allowStaging?: boolean;
  stagingStyle?: string;
}

export interface RegionEditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "region-edit";
  baseVersionId: string;
  mode: "Add" | "Remove" | "Restore";
  instruction?: string;
  mask: unknown;
  createdAt: string; // ISO
  allowStaging?: boolean;
  stagingStyle?: string;
}

export type AnyJobPayload = EnhanceJobPayload | EditJobPayload | RegionEditJobPayload;

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
  meta?: {
    scene?: { label: string; confidence: number };
    [k: string]: any;
  };
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/* ---------- API helpers ---------- */
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string };
export type ApiResponse<T> = ApiOk<T> | ApiErr;
