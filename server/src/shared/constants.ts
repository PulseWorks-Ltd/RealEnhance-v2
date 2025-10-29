// server/src/shared/constants.ts

/** How many credits one processed image costs */
export const CREDITS_PER_IMAGE = 1;

/** BullMQ queue name for image-processing jobs */
export const JOB_QUEUE_NAME = "image-jobs";

/** Optional: tune concurrency if your worker reads this */
export const MAX_CONCURRENT_JOBS = 3;

/** Optional: limit uploads (if your routes check this) */
export const MAX_UPLOAD_MB = 25;

/** Optional: accepted mime/extension hints */
export const SUPPORTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export const SUPPORTED_IMAGE_EXT = ["jpg", "jpeg", "png", "webp"] as const;
