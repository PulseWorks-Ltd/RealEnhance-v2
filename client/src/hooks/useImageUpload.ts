import { useCallback, useRef, useState } from "react";
import { MAX_IMAGE_UPLOAD_BYTES, processImage } from "@/utils/processImage";
import { runUploadQueue } from "@/utils/uploadQueue";
import { uploadToS3 } from "@/utils/uploadToS3";

export type ImageUploadStage = "idle" | "compressing" | "uploading";

interface UploadBatchProgress {
  completed: number;
  total: number;
  percent: number;
}

interface UseImageUploadOptions {
  onStageChange?: (stage: ImageUploadStage) => void;
  onBatchProgress?: (progress: UploadBatchProgress) => void;
  onFileProgress?: (index: number, progress: number) => void;
  signal?: AbortSignal;
}

function createProgressSnapshot(progressByIndex: Record<number, number>, total: number): UploadBatchProgress {
  const aggregate = Object.values(progressByIndex).reduce((sum, value) => sum + value, 0);
  const completed = Object.values(progressByIndex).filter((value) => value >= 100).length;

  return {
    completed,
    total,
    percent: total > 0 ? Math.round(aggregate / total) : 0,
  };
}

export function useImageUpload() {
  const [stage, setStage] = useState<ImageUploadStage>("idle");
  const [progressByIndex, setProgressByIndex] = useState<Record<number, number>>({});
  const progressRef = useRef<Record<number, number>>({});

  const resetUploadState = useCallback(() => {
    progressRef.current = {};
    setProgressByIndex({});
    setStage("idle");
  }, []);

  const handleUpload = useCallback(async (files: File[], options: UseImageUploadOptions = {}): Promise<string[]> => {
    if (!files.length) return [];

    const oversizeFile = files.find((file) => file.size > MAX_IMAGE_UPLOAD_BYTES);
    if (oversizeFile) {
      throw new Error(`${oversizeFile.name} exceeds the 25MB upload limit.`);
    }

    setStage("compressing");
    options.onStageChange?.("compressing");

    const processedFiles = await Promise.all(files.map((file) => processImage(file)));
    const nextProgress: Record<number, number> = Object.fromEntries(processedFiles.map((_, index) => [index, 0]));
    progressRef.current = nextProgress;
    setProgressByIndex(nextProgress);

    setStage("uploading");
    options.onStageChange?.("uploading");
    options.onBatchProgress?.(createProgressSnapshot(nextProgress, processedFiles.length));

    try {
      const tasks = processedFiles.map((file, index) => async () => {
        const key = await uploadToS3(file, {
          signal: options.signal,
          onProgress: (progress) => {
            const updated = {
              ...progressRef.current,
              [index]: progress,
            };
            progressRef.current = updated;
            setProgressByIndex(updated);
            options.onFileProgress?.(index, progress);
            options.onBatchProgress?.(createProgressSnapshot(updated, processedFiles.length));
          },
        });
        return key;
      });

      const keys = await runUploadQueue(tasks);
      const completedProgress = Object.fromEntries(processedFiles.map((_, index) => [index, 100]));
      progressRef.current = completedProgress;
      setProgressByIndex(completedProgress);
      options.onBatchProgress?.(createProgressSnapshot(completedProgress, processedFiles.length));
      setStage("idle");
      options.onStageChange?.("idle");
      return keys;
    } catch (error) {
      setStage("idle");
      options.onStageChange?.("idle");
      throw error;
    }
  }, []);

  return {
    handleUpload,
    progressByIndex,
    resetUploadState,
    stage,
  };
}