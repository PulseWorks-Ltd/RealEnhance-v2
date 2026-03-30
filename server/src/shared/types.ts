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
  emailVerified?: boolean;
  credits: number;
  hasSeenWelcome?: boolean;
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
  | "awaiting_payment"
  | "processing"
  | "complete"
  | "cancelled"
  | "error"
  | "failed";

// Declutter mode tuning for Stage 1B (stage-ready token retained for compatibility)
export type DeclutterMode = "light" | "stage-ready";

export type RoomType =
  | "bedroom"
  | "living_room"
  | "dining_room"
  | "kitchen"
  | "kitchen_dining"
  | "kitchen_living"
  | "living_dining"
  | "multiple_living"
  | "study"
  | "office"
  | "bathroom"
  | "bathroom_1"
  | "bathroom_2"
  | "laundry"
  | "garage"
  | "basement"
  | "attic"
  | "hallway"
  | "sunroom"
  | "staircase"
  | "entryway"
  | "closet"
  | "pantry"
  | "outdoor"
  | "other"
  | "unknown"
  | "auto";

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

export interface RetryExecutionPlan {
  runStage1A: boolean;
  runStage1B: boolean;
  runStage2: boolean;
  stage2Baseline?: "1A" | "1B" | "original_upload";
  baselineUrl?: string;
  sourceStage?: string;
}

/** Strongly-typed payloads you enqueue */
export interface EnhanceJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance";
  jobType?: "initial" | "retry" | "edit";
  agencyId?: string | null;          // Usage/billing context
  propertyId?: string | null;
  galleryParentImageId?: string | null;
  clientBatchId?: string | null;
  listingId?: string;                // Optional grouping across listings
  manualSceneOverride?: boolean;     // Top-level override flag (legacy support)
  options: {
    declutter: boolean;
    virtualStage: boolean;
    roomType: RoomType | string;
    sceneType: string | "auto";
    stage2Only?: boolean;
    replaceSky?: boolean;            // Sky replacement toggle (auto-enable exteriors)
    stagingStyle?: string;           // Staging style (defaults to standard_listing)
    declutterMode?: DeclutterMode;   // Stage 1B mode (light or structured-retain)
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
    baseStage?: "1A" | "1B";
    base1BUrl?: string;
    base1AUrl?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    stage1BMode?: "light" | "stage-ready";
  };
  sourceStage?: "original" | "1A" | "1B" | "2" | "stage1A" | "stage1B" | "stage2";
  sourceUrl?: string | null;
  baselineStage?: "stage1A" | "stage1B" | "stage2";
  stageUrls?: Record<string, string | null>;
  executionPlan?: RetryExecutionPlan;
  remoteOriginalUrl?: string;        // S3 URL of original if uploaded
  remoteOriginalKey?: string;        // S3 key of original if uploaded
  createdAt: string;
}

export interface EditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "edit";
  jobType?: "edit";
  baseVersionId: string;
  mode: "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  mask: unknown;
  createdAt: string; // ISO
  allowStaging?: boolean;
  stagingStyle?: string;
  propertyId?: string;
  sourceImageId?: string;
}

export interface RegionEditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  sourceJobId?: string;
  parentJobId?: string;
  sourceStage?: "stage1A" | "stage1B" | "stage2";
  executionSourceStage?: "original" | "1A" | "1B" | "2" | "retry" | "edit";
  sourceImageId?: ImageId;
  propertyId?: string;
  galleryParentImageId?: string | null;
  type: "region-edit";
  baseVersionId: string;
  baselineStage?: "stage1A" | "stage1B" | "stage2";
  stageUrls?: Record<string, string | null>;
  mode: "Add" | "Remove" | "Replace" | "Restore";
  editIntent?: "add" | "remove" | "replace";
  editSourceStage?: "stage1A" | "stage1B" | "stage2";
  instruction?: string;
  currentImageUrl?: string;
  baseImageUrl?: string;
  restoreFromUrl?: string;
  mask: unknown;
  stage1AReferenceUrl?: string;
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
  latestEditUrl?: string | null;
  editLatestUrl?: string | null;
  editLatestJobId?: string | null;
  latestRetryUrl?: string | null;
  retryLatestUrl?: string | null;
  retryLatestJobId?: string | null;
  editOutputs?: string[];
  retryOutputs?: string[];
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
