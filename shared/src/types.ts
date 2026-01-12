export interface RegionEditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "region-edit";
  listingId?: string; // Optional: group multiple images under one listing for usage tracking
  baseVersionId: string;
  mode: "Add" | "Remove" | "Restore";
  instruction?: string;
  mask: unknown;
  createdAt: string;
}
export type UserId = string;
export type ImageId = string;
export type JobId = string;

export interface UserRecord {
  id: UserId;
  email: string;
  name?: string; // Legacy full name (kept for backward compatibility)
  firstName?: string;
  lastName?: string;
  passwordHash?: string;  // Optional: undefined for OAuth-only users
  authProvider: "email" | "google";  // Track authentication method
  credits: number; // DEPRECATED: Kept for backward compatibility, not enforced
  imageIds: ImageId[];
  agencyId?: string | null; // Optional: links user to an agency for usage tracking
  role?: "owner" | "admin" | "member"; // Agency role, defaults to "member"
  isActive?: boolean; // Whether user can log in, defaults to true
  plan?: "free" | "individual" | "agency"; // Future: plan-based limits
  usageStats?: {
    monthlyImages: number;
    monthlyListings: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ImageVersion {
  versionId: string;     // e.g. "v_<uuid>"
  stageLabel: string;    // "1A" | "1B" | "2" | "edit"
  filePath: string;      // where that version output is saved
  createdAt: string;
  note?: string;         // optional description, e.g. "virtual staged"
}

export interface ImageRecord {
  imageId: ImageId;
  ownerUserId: UserId;
  agencyId?: string;     // Agency that owns this image (for retention tracking)

  originalPath: string;  // uploaded source
  roomType?: string;     // "bedroom" | "kitchen" | ...
  sceneType?: string;    // "interior" | "exterior"

  history: ImageVersion[];     // chronological stack of versions
  currentVersionId: string;    // versionId of latest
  createdAt: string;
  updatedAt: string;
}

export type JobStatus = "queued" | "processing" | "complete" | "error";

/**
 * Declutter mode controls Stage 1B behavior:
 * - "light": Remove clutter/mess only, preserve all main furniture
 * - "stage-ready": Remove ALL furniture and clutter (empty room ready for staging)
 */
export type DeclutterMode = "light" | "stage-ready";

export type SceneLabel =
  | "exterior"
  | "living_room"
  | "kitchen"
  | "bathroom"
  | "bedroom"
  | "dining"
  | "twilight"
  | "floorplan"
  | "hallway"
  | "garage"
  | "balcony"
  | "other";

export interface EnhanceJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance";
  agencyId?: string | null; // Optional: agency ID for usage billing
  listingId?: string; // Optional: group multiple images under one listing for usage tracking
  manualSceneOverride?: boolean;
  options: {
    declutter: boolean;
    virtualStage: boolean;
    roomType: string;
    sceneType: string | "auto";
    replaceSky?: boolean;  // Sky replacement toggle (auto-enabled for exterior)
    stagingStyle?: string;  // Staging style (defaults to nz_standard)
    declutterMode?: DeclutterMode;  // Light (keeps furniture) or Stage-ready (full removal)
    // Optional tuning controls
    sampling?: {
      temperature?: number;
      topP?: number;
      topK?: number;
    };
    declutterIntensity?: "light" | "standard" | "heavy";
  };
  // ✅ Smart Stage-2-only retry mode
  stage2OnlyMode?: {
    enabled: boolean;
    base1BUrl: string;  // URL of Stage-1B output to reuse
  };
  createdAt: string;
}

export interface EditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "edit";
  listingId?: string; // Optional: group multiple images under one listing for usage tracking
  baseVersionId: string;
  mode: "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  mask: unknown;
  allowStaging?: boolean;
  stagingStyle?: string;
  createdAt: string;
}

export type AnyJobPayload = EnhanceJobPayload | EditJobPayload | RegionEditJobPayload;

export interface JobRecord {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance" | "edit";
  status: JobStatus;
  errorMessage?: string;

  // enhancement results:
  stageOutputs?: {
    "1A"?: string;
    "1B"?: string;
    "2"?: string;
  };

  // edit results:
  resultVersionId?: string;

  // auxiliary metadata (e.g., scene classification)
  meta?: {
    scene?: { label: SceneLabel; confidence: number };
    /** Room type inferred by worker (model + heuristics). Never overwrites user choice. */
    roomTypeDetected?: string;
    /** User selected / requested room type (authoritative for prompts & staging). */
    roomType?: string;
    [k: string]: any;
  };

  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// ENHANCED IMAGES HISTORY - Quota-Bound Retention
// ============================================================================

/**
 * Enhancement attempt audit record (INTERNAL USE ONLY)
 * Provides full traceability from stored images back to validator decisions.
 * NEVER expose validator details to users.
 */
export interface EnhancementAttempt {
  attemptId: string; // UUID
  jobId: JobId;
  stage: 'stage12' | 'stage2' | 'edit' | 'region_edit';
  attemptNumber: number;

  // Model & prompt tracking
  modelUsed?: string; // e.g., "gemini-1.5-flash-002"
  promptVersion?: string; // e.g., "v2.1" or hash

  // Validator results (INTERNAL ONLY)
  validatorPassed?: boolean;
  validatorSummaryInternal?: Record<string, any>; // scores, warnings, structural checks

  // Traceability
  traceId: string; // correlates with worker logs

  createdAt: string;
}

/**
 * Enhanced image record with quota-bound retention
 * Retention window: up to 3 months of plan allowance (monthly_included_images * 3)
 * Oldest images expire first (FIFO)
 */
export interface EnhancedImage {
  id: string; // UUID

  // Ownership & scoping
  agencyId: string;
  userId: UserId;
  jobId: JobId;

  // Stage completion tracking
  stagesCompleted: string[]; // e.g., ['1A', '1B', '2'] or ['1A', '2']

  // Storage
  storageKey: string; // S3 key
  publicUrl: string; // Full public URL
  thumbnailUrl?: string; // Optional thumbnail

  // File metadata
  sizeBytes?: number;
  contentType?: string;

  // Retention & expiry
  isExpired: boolean;
  expiresAt?: string; // Computed based on retention policy

  // Audit & traceability (NEVER expose validator details to users)
  auditRef: string; // Short human-friendly reference (e.g., "RE-7F3K9Q")
  traceId: string; // Correlates with worker logs
  stage12AttemptId?: string; // UUID reference
  stage2AttemptId?: string; // UUID reference

  createdAt: string;
  updatedAt: string;
}

/**
 * Enhanced image list item (for API responses)
 * Excludes sensitive audit data
 */
export interface EnhancedImageListItem {
  id: string;
  thumbnailUrl: string;
  publicUrl: string;
  stagesCompleted: string[];
  createdAt: string;
  auditRef: string; // May be shown to users as generic "Support reference"
}
