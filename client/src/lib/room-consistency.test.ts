import assert from "node:assert/strict";
import test from "node:test";

import { getRoomConsistencyWaitingCopy, isWaitingForMasterApproval } from "./room-consistency";

test("isWaitingForMasterApproval prefers the explicit processing state", () => {
  assert.equal(
    isWaitingForMasterApproval({
      status: "processing",
      blockedStage: "2",
      roomConsistency: {
        viewRole: "reference",
        processingState: "WAITING_FOR_MASTER_APPROVAL",
      },
    }),
    true,
  );
});

test("isWaitingForMasterApproval falls back to persisted waiting metadata", () => {
  assert.equal(
    isWaitingForMasterApproval({
      status: "waiting",
      blockedStage: "2",
      validationNote: "Awaiting approved master view before Stage 2.",
      roomConsistency: {
        viewRole: "reference",
        currentStatus: "waiting_stage2",
        roomState: {
          masterApprovalStatus: "pending",
        },
      },
    }),
    true,
  );
});

test("isWaitingForMasterApproval ignores generic queue waits", () => {
  assert.equal(
    isWaitingForMasterApproval({
      status: "waiting",
      blockedStage: "2",
      validationNote: "Waiting for the previous room angle to finish Stage 2.",
      roomConsistency: {
        viewRole: "reference",
        currentStatus: "waiting_stage2",
        roomState: {
          masterApprovalStatus: "approved",
        },
      },
    }),
    false,
  );
});

test("getRoomConsistencyWaitingCopy returns the new approval label and subtitle", () => {
  assert.deepEqual(
    getRoomConsistencyWaitingCopy({
      status: "processing",
      blockedStage: "2",
      roomConsistency: {
        viewRole: "reference",
        processingState: "WAITING_FOR_MASTER_APPROVAL",
      },
    }),
    {
      isWaitingForApproval: true,
      badgeLabel: "Waiting on Approval",
      subtitle: "Waiting for master room approval before staging continues.",
    },
  );
});