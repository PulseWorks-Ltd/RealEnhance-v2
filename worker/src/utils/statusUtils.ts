import { getJob, updateJob } from "./persist";
import type { JobId } from "@realenhance/shared/types";
import { getEvidenceGatingVariant } from "../validators/evidenceGating";

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
    // Structured guard log per spec
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

  const existingValidatorMeta = (current as any)?.validatorMeta || {};
  const patchValidatorMeta = patch?.validatorMeta || {};
  const evidenceGatingVariant = getEvidenceGatingVariant(String(jobId));
  const mergedValidatorMeta = {
    ...existingValidatorMeta,
    ...patchValidatorMeta,
    evidenceGatingVariant,
  };
  await updateJob(jobId, { ...patch, validatorMeta: mergedValidatorMeta });
  console.info("[STATUS_WRITE_OK]", { jobId, newStatus: patch?.status, reason });
  return true;
}
