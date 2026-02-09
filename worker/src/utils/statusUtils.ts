import { getJob, updateJob } from "./persist";
import type { JobId } from "@realenhance/shared/types";

export function isTerminalStatus(status: string | undefined): boolean {
  return status === "complete" || status === "failed" || status === "error" || status === "FAILED_FINAL" || status === "cancelled";
}

export async function safeWriteJobStatus(
  jobId: JobId,
  patch: Record<string, any>,
  reason: string
): Promise<boolean> {
  const current = await getJob(jobId);
  const currentStatus = current?.status as string | undefined;

  if (isTerminalStatus(currentStatus)) {
    console.warn("[STATUS_LOCK_BLOCKED]", {
      jobId,
      current: currentStatus,
      attempted: patch?.status,
      reason,
    });
    console.warn("[LATE_WRITE_BLOCKED]", {
      jobId,
      current: currentStatus,
      attempted: patch?.status,
      reason,
    });
    return false;
  }

  await updateJob(jobId, patch);
  console.info("[STATUS_WRITE_OK]", { jobId, newStatus: patch?.status, reason });
  return true;
}
