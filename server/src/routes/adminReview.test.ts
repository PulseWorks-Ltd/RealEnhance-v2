import assert from "node:assert/strict";
import test from "node:test";

process.env.S3_BUCKET = "realenhance-bucket";
process.env.AWS_REGION = "ap-southeast-2";
const { reviewImageKey, summariseJob } = await import("../services/adminReviewModel.js");

test("review images: only uploads, outputs and staging work images can be opened", () => {
  assert.equal(reviewImageKey("debug-attempts/job_1/masked/attempt1/2_staged_raw.webp"), "debug-attempts/job_1/masked/attempt1/2_staged_raw.webp");
  assert.equal(reviewImageKey("https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/a.jpg"), "realenhance/outputs/a.jpg");
  assert.equal(reviewImageKey("private/other.json"), null);
  assert.equal(reviewImageKey("realenhance/../private/x"), null);
  assert.equal(reviewImageKey("https://evil.example.com/realenhance/a.jpg"), null);
  assert.equal(reviewImageKey(""), null);
});

test("review list: a staged job that fell back to the enhanced photo shows as 'fell back'", () => {
  const rec = {
    jobId: "job_1", status: "complete", createdAt: "2026-11-12T21:29:53Z",
    payload: { imageName: "07-bedroom.jpg", options: { roomType: "bedroom", virtualStage: true } },
    stage2Masked: { ok: false, attempts: 2, reasons: ["room changed to fit the furniture"], reports: [{ attempt: 1, outcome: "re-stage" }] },
    stageUrls: { "1A": "https://x/1a.jpg" },
  };
  const j = summariseJob(rec, null);
  assert.equal(j.outcome, "fell back");
  assert.equal(j.imageName, "07-bedroom.jpg");
  assert.deepEqual(j.staging?.reasons, ["room changed to fit the furniture"]);
  assert.equal(summariseJob({ ...rec, stage2Masked: { ok: true, attempts: 1, reports: [] } }, null).outcome, "published");
  assert.equal(summariseJob({ ...rec, status: "failed" }, null).outcome, "failed");
});

test("review detail: stage pictures are found under the names the worker saves them as", () => {
  const rec = {
    jobId: "job_2", status: "complete",
    payload: { label: "Bedroom_08.jpg", imageId: "img_x", options: { virtualStage: true } },
    stageUrls: { stage1A: "https://x/1a.jpg", stage1B: null, stage2: "https://x/2.jpg" },
  };
  const j = summariseJob(rec, null);
  assert.equal(j.imageName, "Bedroom_08.jpg");
  assert.equal(j.images.enhanced, "https://x/1a.jpg");
  assert.equal(j.images.staged, "https://x/2.jpg");
  assert.equal(summariseJob({ ...rec, stageUrls: { "1A": "https://x/old.jpg" } }, null).images.enhanced, "https://x/old.jpg");
});
