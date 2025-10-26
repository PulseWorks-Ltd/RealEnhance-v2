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
  versionId: string;     // e.g. "v_<uuid>"
  stageLabel: string;    // "1A" | "1B" | "2" | "edit"
  filePath: string;      // where that version output is saved
  createdAt: string;
  note?: string;         // optional description, e.g. "virtual staged"
}

export interface ImageRecord {
  imageId: ImageId;
  ownerUserId: UserId;

  originalPath: string;  // uploaded source
  roomType?: string;     // "bedroom" | "kitchen" | ...
  sceneType?: string;    // "interior" | "exterior"

  history: ImageVersion[];     // chronological stack of versions
  currentVersionId: string;    // versionId of latest
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

  // enhancement results:
  stageOutputs?: {
    "1A"?: string;
    "1B"?: string;
    "2"?: string;
  };

  // edit results:
  resultVersionId?: string;

  createdAt: string;
  updatedAt: string;
}
