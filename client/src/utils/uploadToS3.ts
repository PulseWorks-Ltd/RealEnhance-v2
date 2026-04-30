import { api } from "@/lib/api";
import { withDevice } from "@/lib/withDevice";

interface UploadUrlResponse {
  url: string;
  key: string;
}

interface UploadToS3Options {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

const MAX_UPLOAD_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 500;

class S3UploadError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", abortHandler);
      resolve();
    }, ms);

    const abortHandler = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Upload aborted", "AbortError"));
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

function putFileToSignedUrl(url: string, file: File, options: UploadToS3Options = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      options.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(100);
        resolve();
        return;
      }
      reject(new S3UploadError(
        `S3 upload failed with status ${xhr.status}`,
        xhr.status,
        xhr.status >= 500,
      ));
    };

    xhr.onerror = () => reject(new S3UploadError("S3 upload failed", xhr.status || 0, true));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));

    const abortHandler = () => xhr.abort();
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    xhr.send(file);
  });
}

export async function uploadToS3(file: File, options: UploadToS3Options = {}): Promise<string> {
  const response = await fetch(api("/api/upload-url"), withDevice({
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
    }),
    signal: options.signal,
  }));

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.message || "Failed to get upload URL");
  }

  const { url, key } = await response.json() as UploadUrlResponse;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await putFileToSignedUrl(url, file, options);
      return key;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      const uploadError = error instanceof S3UploadError
        ? error
        : new S3UploadError((error as Error)?.message || "S3 upload failed", 0, true);
      const hasAttemptsRemaining = attempt < MAX_UPLOAD_ATTEMPTS;

      if (!uploadError.retryable || !hasAttemptsRemaining) {
        throw uploadError;
      }

      const retryDelayMs = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
      await delay(retryDelayMs, options.signal);
    }
  }

  return key;
}