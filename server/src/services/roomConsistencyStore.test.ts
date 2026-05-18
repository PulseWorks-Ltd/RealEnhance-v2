import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRoomConsistencyMasterApproval,
  applyRoomConsistencyMasterReady,
  applyRoomConsistencySecondaryClaim,
  applyRoomConsistencySecondaryCompletion,
} from "./roomConsistencyStore.js";
import type { RoomConsistencyGroupStateV1 } from "../shared/types.js";

function buildGroup(): RoomConsistencyGroupStateV1 {
  return {
    roomId: "room-1",
    clientBatchId: "batch-1",
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    masterImageId: "img-master-original",
    masterJobId: "job-master-original",
    masterApprovalStatus: "pending",
    pendingMasterApproval: true,
    masterReadyAt: null,
    masterApprovedAt: null,
    approvedMasterImageUrl: null,
    approvedMasterImageId: null,
    approvedMasterAttempt: null,
    continuityGroupStatus: "pending_master",
    nextSecondarySequenceIndex: 1,
    activeSecondaryImageId: null,
    images: [
      {
        imageId: "img-master-original",
        initialJobId: "job-master-original",
        viewRole: "primary",
        sequenceIndex: 0,
      },
      {
        imageId: "img-secondary-1",
        initialJobId: "job-secondary-1",
        viewRole: "reference",
        sequenceIndex: 1,
        waitingForApproval: true,
      },
      {
        imageId: "img-secondary-2",
        initialJobId: "job-secondary-2",
        viewRole: "reference",
        sequenceIndex: 2,
        waitingForApproval: true,
      },
    ],
  };
}

test("successful master retry can become the approved continuity master", () => {
  const ready = applyRoomConsistencyMasterReady({
    group: buildGroup(),
    masterImageId: "img-master-retry",
    masterJobId: "job-master-retry-2",
    stagedImageUrl: "https://cdn.example.com/master-retry.jpg",
    now: "2026-05-18T00:01:00.000Z",
  });

  assert.equal(ready.masterImageId, "img-master-retry");
  assert.equal(ready.masterJobId, "job-master-retry-2");
  assert.equal(ready.approvedMasterAttempt, "job-master-retry-2");
  assert.equal(ready.pendingMasterApproval, true);
  assert.equal(ready.masterApprovalStatus, "ready");
  assert.equal(ready.continuityGroupStatus, "master_ready");

  const approved = applyRoomConsistencyMasterApproval({
    group: ready,
    approvedMasterImageUrl: "https://cdn.example.com/master-retry.jpg",
    masterImageId: "img-master-retry",
    masterJobId: "job-master-retry-2",
    now: "2026-05-18T00:02:00.000Z",
  });

  assert.equal(approved.masterImageId, "img-master-retry");
  assert.equal(approved.approvedMasterImageId, "img-master-retry");
  assert.equal(approved.masterJobId, "job-master-retry-2");
  assert.equal(approved.approvedMasterAttempt, "job-master-retry-2");
  assert.equal(approved.approvedMasterImageUrl, "https://cdn.example.com/master-retry.jpg");
  assert.equal(approved.masterApprovalStatus, "approved");
  assert.equal(approved.pendingMasterApproval, false);
  assert.equal(approved.continuityGroupStatus, "processing_secondaries");
});

test("approving the master retry releases all waiting secondary images without completing them", () => {
  const approved = applyRoomConsistencyMasterApproval({
    group: applyRoomConsistencyMasterReady({
      group: buildGroup(),
      masterImageId: "img-master-retry",
      masterJobId: "job-master-retry-2",
      stagedImageUrl: "https://cdn.example.com/master-retry.jpg",
    }),
    approvedMasterImageUrl: "https://cdn.example.com/master-retry.jpg",
    masterImageId: "img-master-retry",
    masterJobId: "job-master-retry-2",
  });

  const secondaries = approved.images.filter((image) => image.viewRole === "reference");
  assert.equal(secondaries.length, 2);
  assert.deepEqual(
    secondaries.map((image) => image.waitingForApproval),
    [false, false],
  );
  assert.deepEqual(
    secondaries.map((image) => image.latestApprovedMasterJobId),
    ["job-master-retry-2", "job-master-retry-2"],
  );
  assert.deepEqual(
    secondaries.map((image) => image.stage2Completed === true),
    [false, false],
  );
});

test("secondary claim and completion advance the continuity group exactly once per sequence slot", () => {
  const approved = applyRoomConsistencyMasterApproval({
    group: applyRoomConsistencyMasterReady({
      group: buildGroup(),
      masterImageId: "img-master-retry",
      masterJobId: "job-master-retry-2",
      stagedImageUrl: "https://cdn.example.com/master-retry.jpg",
    }),
    approvedMasterImageUrl: "https://cdn.example.com/master-retry.jpg",
    masterImageId: "img-master-retry",
    masterJobId: "job-master-retry-2",
  });

  const claimed = applyRoomConsistencySecondaryClaim({
    group: approved,
    imageId: "img-secondary-1",
    stage2JobId: "job-secondary-followup-1",
  });

  assert.equal(claimed.activeSecondaryImageId, "img-secondary-1");
  assert.equal(
    claimed.images.find((image) => image.imageId === "img-secondary-1")?.latestStage2JobId,
    "job-secondary-followup-1",
  );

  const completedFirst = applyRoomConsistencySecondaryCompletion({
    group: claimed,
    imageId: "img-secondary-1",
  });
  assert.equal(completedFirst.activeSecondaryImageId, null);
  assert.equal(completedFirst.nextSecondarySequenceIndex, 2);
  assert.equal(completedFirst.continuityGroupStatus, "processing_secondaries");

  const completedSecond = applyRoomConsistencySecondaryCompletion({
    group: applyRoomConsistencySecondaryClaim({
      group: completedFirst,
      imageId: "img-secondary-2",
      stage2JobId: "job-secondary-followup-2",
    }),
    imageId: "img-secondary-2",
  });
  assert.equal(completedSecond.nextSecondarySequenceIndex, Number.MAX_SAFE_INTEGER);
  assert.equal(completedSecond.continuityGroupStatus, "completed");
});