export interface RegionEditJobPayload {
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "region-edit";
    listingId?: string;
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
export type JobStatus = "queued" | "processing" | "complete" | "error";
/**
 * Declutter mode controls Stage 1B behavior:
 * - "light": Remove clutter/mess only, preserve all main furniture
 * - "stage-ready": Remove ALL furniture and clutter (empty room ready for staging)
 */
export type DeclutterMode = "light" | "stage-ready";
export type SceneLabel = "exterior" | "living_room" | "kitchen" | "bathroom" | "bedroom" | "dining" | "twilight" | "floorplan" | "hallway" | "garage" | "balcony" | "other";
export interface EnhanceJobPayload {
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "enhance";
    agencyId?: string | null;
    listingId?: string;
    manualSceneOverride?: boolean;
    options: {
        declutter: boolean;
        virtualStage: boolean;
        roomType: string;
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
        base1BUrl: string;
    };
    remoteOriginalUrl?: string;
    remoteOriginalKey?: string;
    createdAt: string;
}
export interface EditJobPayload {
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "edit";
    listingId?: string;
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
}
