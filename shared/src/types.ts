import type { EnhancedImageCompletionType } from "./completionTypes";
import type {
  EnhancedImageExecutionMode,
  EnhancedImagePersistenceStatus,
  EnhancedImageUserOutcome,
} from "./enhancedImageSemantics";

export interface ReinstateConfig {
  targetType: "window" | "doorway" | "opening" | "auto";
  geometry?: {
    bbox: { x: number; y: number; width: number; height: number };
    confidence?: number;
    openingId?: string;
  };
}

export interface RegionEditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "region-edit";
  sourceJobId?: string;
  parentJobId?: string;
  listingId?: string; // Optional: group multiple images under one listing for usage tracking
  baseVersionId: string;
  sourceStage?: "stage1A" | "stage1B" | "stage2";
  baselineStage?: "stage1A" | "stage1B" | "stage2";
  executionSourceStage?: "original" | "1A" | "1B" | "2" | "retry" | "edit";
  stageUrls?: Record<string, string | null>;
  galleryParentImageId?: string | null;
  mode: "Add" | "Remove" | "Replace" | "Restore" | "Reinstate";
  editIntent?: "add" | "remove" | "replace" | "reinstate";
  editSourceStage?: "stage1A" | "stage1B" | "stage2";
  instruction?: string;
  currentImageUrl?: string;
  baseImageUrl?: string;
  restoreFromUrl?: string;
  reinstateConfig?: ReinstateConfig;
  mask: unknown;
  stage1AReferenceUrl?: string;
  createdAt: string;
}
export type UserId = string;
export type ImageId = string;
export type JobId = string;

export interface UserRecord {
  id: UserId;
  email: string;
  emailVerified?: boolean;
  name?: string; // Legacy full name (kept for backward compatibility)
  firstName?: string;
  lastName?: string;
  passwordHash?: string;  // Optional: undefined for OAuth-only users
  authProvider: "email" | "google" | "both";  // Track authentication method (both = email+password AND Google)
  googleId?: string;  // Optional: Google profile ID for account linking
  credits: number; // DEPRECATED: Kept for backward compatibility, not enforced
  imageIds: ImageId[];
  agencyId?: string | null; // Optional: links user to an agency for usage tracking
  role?: "owner" | "admin" | "member"; // Agency role, defaults to "member"
  isActive?: boolean; // Whether user can log in, defaults to true
  isSystemUser?: boolean;
  creditUsageCount?: number;
  hasSeenWelcome?: boolean;
  hasReceivedSignupCredits?: boolean;
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

export interface EnhancedImage {
  id: string;
  agencyId: string;
  userId: string;
  jobId: string;
  propertyId?: string | null;
  parentImageId?: string | null;
  source?: "stage2" | "region-edit" | null;
  stagesCompleted: string[];
  completionType?: "full_success" | "fallback_1b" | "fallback_1a" | null;
  userOutcome?: EnhancedImageUserOutcome | null;
  executionMode?: EnhancedImageExecutionMode | null;
  persistenceStatus?: EnhancedImagePersistenceStatus | null;
  storageKey?: string | null;
  publicUrl: string;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  originalS3Key?: string | null;
  enhancedS3Key?: string | null;
  thumbS3Key?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
  isExpired?: boolean;
  expiresAt?: string | null;
  auditRef?: string | null;
  traceId?: string | null;
  stage12AttemptId?: string | null;
  stage2AttemptId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnhancedImageListItem {
  id: string;
  jobId: string;
  thumbnailUrl: string;
  publicUrl: string;
  originalUrl?: string | null;
  stagesCompleted: string[];
  completionType?: "full_success" | "fallback_1b" | "fallback_1a" | null;
  userOutcome?: EnhancedImageUserOutcome | null;
  executionMode?: EnhancedImageExecutionMode | null;
  persistenceStatus?: EnhancedImagePersistenceStatus | null;
  createdAt: string;
  auditRef?: string | null;
  propertyId?: string | null;
  parentImageId?: string | null;
  source?: "stage2" | "region-edit" | null;
  versionCount: number;
}

export interface EnhancedImageGalleryProperty {
  id: string;
  address: string;
  normalizedAddress: string;
  images: EnhancedImageListItem[];
}

// Backward-compatible alias used by the client gallery view.
export type PropertyFolder = EnhancedImageGalleryProperty;

export interface EnhancedImageGalleryResponse {
  properties: EnhancedImageGalleryProperty[];
  unassignedImages: EnhancedImageListItem[];
  total: number;
  images: EnhancedImageListItem[];
}

export type JobStatus = "queued" | "awaiting_payment" | "processing" | "complete" | "cancelled" | "error" | "failed";

/**
 * Declutter mode controls Stage 1B behavior:
 * - "light": Remove clutter/mess only, preserve all main furniture
 * - "stage-ready": Structured retain declutter (preserve anchors, remove secondary items)
 */
export type DeclutterMode = "light" | "stage-ready";

export interface RoomConsistencyStateV1 {
  roomId: string;
  primaryImageId?: string | null;
  primaryJobId?: string | null;
  styleProfile?: {
    stagingStyle?: string;
    roomType?: string;
    sceneType?: string;
  };
  lightingProfile?: {
    brightnessProfile?: "low" | "balanced" | "bright";
    warmthProfile?: "cool" | "neutral" | "warm";
    weatherMood?: "neutral" | "sunny" | "overcast";
    directionHint?: "left" | "right" | "center" | "unknown";
    shadowSoftness?: "soft" | "medium" | "hard";
  };
  furnitureMemory?: {
    persistentIdentityGoal?: string;
    materialPalette?: string[];
    colorContinuity?: "strict" | "balanced";
  };
  relationalSummary?: {
    placementDirective?: string;
    anchorVisibility?: "low" | "medium" | "high";
  };
  consistencySettings?: {
    enforceFurnitureIdentity?: boolean;
    enforceStyleContinuity?: boolean;
    enforceLightingContinuity?: boolean;
    enforceRelationalContinuity?: boolean;
  };
  consistencyModeEnabled?: boolean;
  processingState?: "WAITING_FOR_MASTER_APPROVAL" | "PROCESSING_STAGE2" | "MASTER_READY" | "MASTER_APPROVED";
  masterApproved?: boolean;
  masterApprovalStatus?: "pending" | "ready" | "approved";
  masterStagedImageUrl?: string;
  masterReadyAt?: string;
  masterApprovedAt?: string;
  furnitureContinuityHints?: string;
}

export interface RoomConsistencyContextV1 {
  enabled: boolean;
  roomId: string;
  clientBatchId?: string;
  viewRole: "primary" | "reference";
  primaryImageId?: string | null;
  primaryJobId?: string | null;
  groupSize?: number;
  sequenceIndex?: number;
  stage2BlockedUntilMasterApproval?: boolean;
  processingState?: "WAITING_FOR_MASTER_APPROVAL" | "PROCESSING_STAGE2" | "MASTER_READY" | "MASTER_APPROVED";
  approvedMasterImageUrl?: string | null;
  internalFollowup?: boolean;
  followupParentJobId?: string | null;
  primarySelection?: {
    method: "auto" | "manual";
    score: number;
    reasons: string[];
  };
  roomState?: RoomConsistencyStateV1;
}

export interface RoomConsistencyImageEntryV1 {
  imageId: string;
  initialJobId?: string | null;
  userId?: string | null;
  clientBatchId?: string | null;
  viewRole: "primary" | "reference";
  sequenceIndex: number;
  stage2Released?: boolean;
  stage2Completed?: boolean;
  waitingForApproval?: boolean;
  latestStage2JobId?: string | null;
  latestApprovedMasterJobId?: string | null;
}

export interface RoomConsistencyGroupStateV1 {
  roomId: string;
  clientBatchId?: string | null;
  createdAt: string;
  updatedAt: string;
  masterImageId: string;
  masterJobId?: string | null;
  masterApprovalStatus: "pending" | "ready" | "approved";
  pendingMasterApproval?: boolean;
  masterReadyAt?: string | null;
  masterApprovedAt?: string | null;
  approvedMasterImageUrl?: string | null;
  approvedMasterImageId?: string | null;
  approvedMasterAttempt?: string | null;
  continuityGroupStatus?: "pending_master" | "master_ready" | "master_approved" | "processing_secondaries" | "completed";
  images: RoomConsistencyImageEntryV1[];
  nextSecondarySequenceIndex: number;
  activeSecondaryImageId?: string | null;
}

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

export interface RetryExecutionPlan {
  runStage1A: boolean;
  runStage1B: boolean;
  runStage2: boolean;
  stage2Baseline?: "1A" | "1B" | "original_upload";
  baselineUrl?: string;
  sourceStage?: string;
}

export interface EnhanceJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance";
  jobType?: "initial" | "retry" | "edit";
  agencyId?: string | null; // Optional: agency ID for usage billing
  propertyId?: string | null;
  listingId?: string; // Optional: group multiple images under one listing for usage tracking
  manualSceneOverride?: boolean;
  options: {
    declutter: boolean;
    virtualStage: boolean;
    stage2Only?: boolean;
    roomType: RoomType | string;
    sceneType: string | "auto";
    replaceSky?: boolean;  // Sky replacement toggle (auto-enabled for exterior)
    stagingStyle?: string;  // Staging style (defaults to standard_listing)
    declutterMode?: DeclutterMode;  // Light declutter or structured-retain declutter
    // Optional tuning controls
    sampling?: {
      temperature?: number;
      topP?: number;
      topK?: number;
    };
    declutterIntensity?: "light" | "standard" | "heavy";
    stagingPreference?: "refresh" | "full";
    manualSceneOverride?: boolean; // Per-image manual scene flag
    scenePrediction?: {  // Client-side scene prediction for SKY_SAFE forcing
      scene: string | null;
      confidence: number;
      reason?: string;
      features?: Record<string, number>;
      source?: string;
    };
    roomConsistencyV1?: RoomConsistencyContextV1;
  };
  // ✅ Smart Stage-2-only retry mode
  stage2OnlyMode?: {
    enabled: boolean;
    baseStage?: "1A" | "1B";
    base1BUrl?: string;  // URL of Stage-1B output to reuse
    base1AUrl?: string;  // URL of Stage-1A output to reuse when declutter baseline is not required
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    stage1BMode?: "light" | "stage-ready";
  };
  sourceStage?: "original" | "1A" | "1B" | "2" | "stage1A" | "stage1B" | "stage2";
  sourceUrl?: string | null;
  baselineStage?: "stage1A" | "stage1B" | "stage2";
  stageUrls?: Record<string, string | null>;
  executionPlan?: RetryExecutionPlan;
  remoteOriginalUrl?: string; // S3 URL of original if uploaded
  remoteOriginalKey?: string; // S3 key of original if uploaded
  retryType?: string;
  retrySourceStage?: string | null;
  retrySourceUrl?: string | null;
  retrySourceKey?: string | null;
  retryBaselineStage?: string | null;
  retryBaselineUrl?: string | null;
  retryRequestedStages?: Array<"1A" | "1B" | "2">;
  retryStagesToRun?: Array<"1A" | "1B" | "2">;
  retryParentImageId?: string | null;
  galleryParentImageId?: string | null;
  retryParentJobId?: string | null;
  retryClientBatchId?: string | null;
  createdAt: string;
}

export interface EditJobPayload {
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "edit";
  jobType?: "edit";
  listingId?: string; // Optional: group multiple images under one listing for usage tracking
  baseVersionId: string;
  mode: "Add" | "Remove" | "Replace" | "Restore" | "Reinstate";
  instruction: string;
  mask: unknown;
  allowStaging?: boolean;
  stagingStyle?: string;
  propertyId?: string;
  sourceImageId?: string;
  createdAt: string;
}

export type AnyJobPayload = EnhanceJobPayload | EditJobPayload | RegionEditJobPayload;

export interface JobRecord {
  id?: JobId;
  jobId: JobId;
  userId: UserId;
  imageId: ImageId;
  type: "enhance" | "edit" | "region-edit";
  status: JobStatus;
  payload?: (AnyJobPayload & Record<string, any>) | null;
  clientBatchId?: string | null;
  agencyId?: string | null;
  propertyId?: string | null;
  roomConsistency?: (RoomConsistencyContextV1 & Record<string, any>) | null;
  errorMessage?: string;

  // Canonical pipeline tracking
  currentStage?: string;          // e.g., "upload-original" | "1A" | "1B" | "2" | "finalizing"
  finalStage?: string;            // stage that produced the final output ("1A" | "1B" | "2")
  resultStage?: string;           // alias for finalStage (legacy compatibility)
  resultUrl?: string | null;      // final public URL when complete
  originalUrl?: string | null;    // published original URL for before/after
  stageUrls?: Record<string, string | null>; // per-stage URLs surfaced mid-pipeline
  latestEditUrl?: string | null;
  editLatestUrl?: string | null;
  editLatestJobId?: string | null;
  latestRetryUrl?: string | null;
  retryLatestUrl?: string | null;
  retryLatestJobId?: string | null;
  editOutputs?: string[];
  retryOutputs?: string[];
  attempts?: { current?: number; max?: number };
  retryReason?: string | null;
  fallbackUsed?: string | null;   // e.g., "light_declutter_backstop"

  // Validation summary surfaced to UI (non-sensitive)
  validation?: {
    hardFail?: boolean;
    warnings?: string[];
    normalized?: boolean;
    modeConfigured?: string;
    modeEffective?: string;
    blockingEnabled?: boolean;
    blockedStage?: string;
    fallbackStage?: string | null;
    note?: string | null;
  };

  /** Which stage was blocked by validators (if any) */
  blockedStage?: string | null;
  /** Which stage we fell back to when a later stage was blocked */
  fallbackStage?: string | null;
  /** Human-friendly validation note for display */
  validationNote?: string | null;

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
  modelUsed?: string; // e.g., "gemini-2.5-flash"
  promptVersion?: string; // e.g., "v2.1" or hash

  // Validator results (INTERNAL ONLY)
  validatorPassed?: boolean;
  validatorSummaryInternal?: Record<string, any>; // scores, warnings, structural checks

  // Traceability
  traceId: string; // correlates with worker logs

  createdAt: string;
}

