import { getJob, updateJobIf } from "./persist";
import type { JobId } from "@realenhance/shared/types";
import { getEvidenceGatingVariant } from "../validators/evidenceGating";

export function isTerminalStatus(status: string | undefined): boolean {
  return status === "complete" || status === "completed" || status === "failed" || status === "error" || status === "FAILED_FINAL" || status === "cancelled";
}

export async function safeWriteJobStatus(
  jobId: JobId,
  patch: Record<string, any>,
  reason: string
): Promise<boolean> {
  const evidenceGatingVariant = getEvidenceGatingVariant(String(jobId));
  const patchWithEvidence = {
    ...patch,
    validatorMeta: {
      ...(patch?.validatorMeta || {}),
      evidenceGatingVariant,
    },
  };

  const result = await updateJobIf(
    jobId,
    patchWithEvidence,
    (current: any) => {
      const currentStatus = current?.status as string | undefined;
      return !isTerminalStatus(currentStatus);
    }
  );

  if (!result.updated) {
    const currentStatus = result.current?.status as string | undefined;
    console.log(`[status_guard] BLOCK overwrite terminal status jobId=${String(jobId)} current=${currentStatus} attempted=${patch?.status} reason=${reason}`);
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

  console.info("[STATUS_WRITE_OK]", { jobId, newStatus: patch?.status, reason });
  return true;
}
