export interface RegionEditJobPayload {
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "region-edit";
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
    name: string;
    credits: number;
    imageIds: ImageId[];
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
    originalPath: string;
    roomType?: string;
    sceneType?: string;
    history: ImageVersion[];
    currentVersionId: string;
    createdAt: string;
    updatedAt: string;
}
export type JobStatus = "queued" | "processing" | "complete" | "error";
export type SceneLabel = "exterior" | "living_room" | "kitchen" | "bathroom" | "bedroom" | "dining" | "twilight" | "floorplan" | "hallway" | "garage" | "balcony" | "other";
export interface EnhanceJobPayload {
    jobId: JobId;
    userId: UserId;
    imageId: ImageId;
    type: "enhance";
    options: {
        declutter: boolean;
        virtualStage: boolean;
        roomType: string;
        sceneType: string | "auto";
        replaceSky?: boolean;
        stagingStyle?: string;
        sampling?: {
            temperature?: number;
            topP?: number;
            topK?: number;
        };
        declutterIntensity?: "light" | "standard" | "heavy";
    };
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
