type ProcessingStateValue = string | null | undefined;

function normalizeProcessingState(value: ProcessingStateValue): string {
  return String(value || "").trim().toUpperCase();
}

export function isWaitingForMasterApproval(params: {
  roomConsistency: any;
  blockedStage?: string | null;
  validationNote?: string | null;
  status?: string | null;
}): boolean {
  const roomConsistency = params.roomConsistency || {};
  const viewRole = String(roomConsistency?.viewRole || "").trim().toLowerCase();
  const blockedStage = String(params.blockedStage || "").trim();
  const processingState = normalizeProcessingState(
    roomConsistency?.processingState || roomConsistency?.roomState?.processingState,
  );
  const currentStatus = String(roomConsistency?.currentStatus || "").trim().toLowerCase();
  const masterApprovalStatus = String(
    roomConsistency?.roomState?.masterApprovalStatus || roomConsistency?.masterApprovalStatus || "",
  )
    .trim()
    .toLowerCase();
  const validationNote = String(params.validationNote || "").trim().toLowerCase();
  const status = String(params.status || "").trim().toLowerCase();

  if (viewRole !== "reference") {
    return false;
  }

  if (processingState === "WAITING_FOR_MASTER_APPROVAL") {
    return true;
  }

  return (
    blockedStage === "2" &&
    (status === "waiting" || currentStatus === "waiting_stage2") &&
    (masterApprovalStatus === "pending" ||
      masterApprovalStatus === "ready" ||
      validationNote.includes("awaiting approved master"))
  );
}

export function getRoomConsistencyWaitingCopy(params: {
  roomConsistency: any;
  blockedStage?: string | null;
  validationNote?: string | null;
  status?: string | null;
}): { isWaitingForApproval: boolean; badgeLabel: string; subtitle: string | null } {
  const isWaitingForApproval = isWaitingForMasterApproval(params);
  return {
    isWaitingForApproval,
    badgeLabel: isWaitingForApproval ? "Waiting on Approval" : "Waiting",
    subtitle: isWaitingForApproval
      ? "Waiting for master room approval before staging continues."
      : null,
  };
}