export interface RegionEditJobPayload {
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "region-edit";
    sourceJobId?: string;
    parentJobId?: string;
    listingId?: string;
    baseVersionId: string;
    sourceStage?: "stage1A" | "stage1B" | "stage2";
    baselineStage?: "stage1A" | "stage1B" | "stage2";
    executionSourceStage?: "original" | "1A" | "1B" | "2" | "retry" | "edit";
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
    createdAt: string;
}
export type UserId = string;
export type ImageId = string;
export type JobId = string;
export interface UserRecord {
    id: UserId;
    email: string;
    emailVerified?: boolean;
    name?: string;
    firstName?: string;
    lastName?: string;
    passwordHash?: string;
    authProvider: "email" | "google" | "both";
    googleId?: string;
    credits: number;
    imageIds: ImageId[];
    agencyId?: string | null;
    role?: "owner" | "admin" | "member";
    isActive?: boolean;
    hasSeenWelcome?: boolean;
    plan?: "free" | "individual" | "agency";
    usageStats?: {
        monthlyImages: number;
        monthlyListings: number;
    };
    createdAt: string;
    updatedAt: string;
}
export interface ImageVersion {
    versionId: string;
    stageLabel: string;
    filePath: string;
    createdAt: string;
    note?: string;
}
export interface ImageRecord {
    imageId: ImageId;
    ownerUserId: UserId;
    agencyId?: string;
    originalPath: string;
    roomType?: string;
    sceneType?: string;
    history: ImageVersion[];
    currentVersionId: string;
    createdAt: string;
    updatedAt: string;
}
export type JobStatus = "queued" | "awaiting_payment" | "processing" | "complete" | "cancelled" | "error" | "failed";
/**
 * Declutter mode controls Stage 1B behavior:
 * - "light": Remove clutter/mess only, preserve all main furniture
 * - "stage-ready": Structured retain declutter (preserve anchors, remove secondary items)
 */
export type DeclutterMode = "light" | "stage-ready";
export type RoomType = "bedroom" | "living_room" | "dining_room" | "kitchen" | "kitchen_dining" | "kitchen_living" | "living_dining" | "multiple_living" | "study" | "office" | "bathroom" | "bathroom_1" | "bathroom_2" | "laundry" | "garage" | "basement" | "attic" | "hallway" | "sunroom" | "staircase" | "entryway" | "closet" | "pantry" | "outdoor" | "other" | "unknown" | "auto";
export type SceneLabel = "exterior" | "living_room" | "kitchen" | "bathroom" | "bedroom" | "dining" | "twilight" | "floorplan" | "hallway" | "garage" | "balcony" | "other";
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
    agencyId?: string | null;
    propertyId?: string | null;
    listingId?: string;
    manualSceneOverride?: boolean;
    options: {
        declutter: boolean;
        virtualStage: boolean;
        stage2Only?: boolean;
        roomType: RoomType | string;
        sceneType: string | "auto";
        replaceSky?: boolean;
        stagingStyle?: string;
        declutterMode?: DeclutterMode;
        sampling?: {
            temperature?: number;
            topP?: number;
            topK?: number;
        };
        declutterIntensity?: "light" | "standard" | "heavy";
        stagingPreference?: "refresh" | "full";
        manualSceneOverride?: boolean;
        scenePrediction?: {
            scene: string | null;
            confidence: number;
            reason?: string;
            features?: Record<string, number>;
            source?: string;
        };
    };
    stage2OnlyMode?: {
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
    remoteOriginalUrl?: string;
    remoteOriginalKey?: string;
    retryType?: string;
    retrySourceStage?: string | null;
    retrySourceUrl?: string | null;
    retrySourceKey?: string | null;
    retryBaselineStage?: string | null;
    retryBaselineUrl?: string | null;
    retryRequestedStages?: Array<"1A" | "1B" | "2">;
    retryStagesToRun?: Array<"1A" | "1B" | "2">;
    retryParentImageId?: string | null;
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
    listingId?: string;
    baseVersionId: string;
    mode: "Add" | "Remove" | "Replace" | "Restore";
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
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "enhance" | "edit";
    status: JobStatus;
    errorMessage?: string;
    currentStage?: string;
    finalStage?: string;
    resultStage?: string;
    resultUrl?: string | null;
    originalUrl?: string | null;
    stageUrls?: Record<string, string | null>;
    latestEditUrl?: string | null;
    editLatestUrl?: string | null;
    latestRetryUrl?: string | null;
    retryLatestUrl?: string | null;
    editOutputs?: string[];
    retryOutputs?: string[];
    attempts?: {
        current?: number;
        max?: number;
    };
    retryReason?: string | null;
    fallbackUsed?: string | null;
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
    stageOutputs?: {
        "1A"?: string;
        "1B"?: string;
        "2"?: string;
    };
    resultVersionId?: string;
    meta?: {
        scene?: {
            label: SceneLabel;
            confidence: number;
        };
        /** Room type inferred by worker (model + heuristics). Never overwrites user choice. */
        roomTypeDetected?: string;
        /** User selected / requested room type (authoritative for prompts & staging). */
        roomType?: string;
        [k: string]: any;
    };
    createdAt: string;
    updatedAt: string;
}
/**
 * Enhancement attempt audit record (INTERNAL USE ONLY)
 * Provides full traceability from stored images back to validator decisions.
 * NEVER expose validator details to users.
 */
export interface EnhancementAttempt {
    attemptId: string;
    jobId: JobId;
    stage: 'stage12' | 'stage2' | 'edit' | 'region_edit';
    attemptNumber: number;
    modelUsed?: string;
    promptVersion?: string;
    validatorPassed?: boolean;
    validatorSummaryInternal?: Record<string, any>;
    traceId: string;
    createdAt: string;
}
/**
 * Enhanced image record with quota-bound retention
 * Retention window: up to 3 months of plan allowance (monthly_included_images * 3)
 * Oldest images expire first (FIFO)
 */
export interface EnhancedImage {
    id: string;
    agencyId: string;
    userId: UserId;
    jobId: JobId;
    propertyId?: string | null;
    parentImageId?: string | null;
    source?: 'stage2' | 'region-edit';
    stagesCompleted: string[];
    storageKey: string;
    publicUrl: string;
    thumbnailUrl?: string;
    originalUrl?: string | null;
    originalS3Key?: string | null;
    enhancedS3Key?: string | null;
    thumbS3Key?: string | null;
    sizeBytes?: number;
    contentType?: string;
    isExpired: boolean;
    expiresAt?: string;
    auditRef: string;
    traceId: string;
    stage12AttemptId?: string;
    stage2AttemptId?: string;
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
    originalUrl?: string | null;
    stagesCompleted: string[];
    createdAt: string;
    auditRef: string;
    propertyId?: string | null;
    parentImageId?: string | null;
    source?: 'stage2' | 'region-edit';
    versionCount?: number;
}
export interface PropertyFolder {
    id: string;
    address: string;
    normalizedAddress: string;
    images: EnhancedImageListItem[];
}
export interface EnhancedImageGalleryResponse {
    properties: PropertyFolder[];
    unassignedImages: EnhancedImageListItem[];
    total: number;
    images?: EnhancedImageListItem[];
}
