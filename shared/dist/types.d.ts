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
    createdAt: string;
}
export type AnyJobPayload = EnhanceJobPayload | EditJobPayload;
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
    createdAt: string;
    updatedAt: string;
}
