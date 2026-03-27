import assert from "node:assert/strict";
import test from "node:test";

import { getCardArtifactView, resolveSafeStageUrl } from "./card-artifacts";

test("getCardArtifactView defaults cleanly for enhance-only cards", () => {
  const enhanceOnlyCard = {
    status: "completed",
    jobId: "job-enhance-only",
    imageId: "img-enhance-only",
    originalImageUrl: "https://cdn.example.com/original.jpg",
    stageUrls: {
      "1A": "https://cdn.example.com/stage1a.jpg",
      "1B": "https://cdn.example.com/stage1b.jpg",
      "2": "https://cdn.example.com/stage2.jpg",
    },
    finalOutputUrl: "https://cdn.example.com/stage2.jpg",
  };

  const view = getCardArtifactView(enhanceOnlyCard);
  assert.equal(view.active?.key, "2");
  assert.equal(view.active?.artifactType, "original");
  assert.deepEqual(
    view.available.map((artifact) => artifact.key),
    ["original", "1A", "1B", "2"]
  );
});

test("getCardArtifactView builds canonical inventory for enhance -> retry -> edit -> retry chain", () => {
  const baseCard = {
    status: "completed",
    jobId: "job-a",
    imageId: "img-a",
    originalImageUrl: "https://cdn.example.com/original.jpg",
    stageUrls: {
      "1A": "https://cdn.example.com/stage1a.jpg",
      "1B": "https://cdn.example.com/stage1b.jpg",
      "2": "https://cdn.example.com/stage2-original.jpg",
    },
    finalOutputUrl: "https://cdn.example.com/stage2-original.jpg",
  };

  const enhancedView = getCardArtifactView(baseCard);
  assert.equal(enhancedView.active?.key, "2");
  assert.equal(enhancedView.active?.artifactType, "original");
  assert.deepEqual(
    enhancedView.available.map((artifact) => artifact.key),
    ["original", "1A", "1B", "2"]
  );

  const retriedCard = {
    ...baseCard,
    latestRetryUrl: "https://cdn.example.com/stage2-retry-b.jpg",
    retryLatestUrl: "https://cdn.example.com/stage2-retry-b.jpg",
    retryLatestJobId: "job-b",
    parentJobId: "job-a",
  };

  const retryView = getCardArtifactView(retriedCard);
  assert.equal(retryView.active?.key, "retried");
  assert.equal(retryView.active?.artifactType, "retry");
  assert.deepEqual(
    retryView.available.map((artifact) => artifact.key),
    ["original", "1A", "1B", "2", "retried"]
  );

  const editedRetryCard = {
    ...retriedCard,
    latestEditUrl: "https://cdn.example.com/stage2-edit-c.jpg",
    editLatestUrl: "https://cdn.example.com/stage2-edit-c.jpg",
    editLatestJobId: "job-c",
    completionSource: "region-edit",
  };

  const editView = getCardArtifactView(editedRetryCard);
  assert.equal(editView.active?.key, "edited");
  assert.equal(editView.active?.artifactType, "edit");
  assert.equal(editView.active?.url, "https://cdn.example.com/stage2-edit-c.jpg");
  assert.deepEqual(
    editView.available.map((artifact) => artifact.key),
    ["original", "1A", "1B", "2", "retried", "edited"]
  );

  const explicitRetrySelection = getCardArtifactView(editedRetryCard, { selectedKey: "retried" });
  assert.equal(explicitRetrySelection.active?.key, "retried");
  assert.equal(explicitRetrySelection.active?.url, "https://cdn.example.com/stage2-retry-b.jpg");

  const retriedAgainCard = {
    ...editedRetryCard,
    latestRetryUrl: "https://cdn.example.com/stage2-retry-d.jpg",
    retryLatestUrl: "https://cdn.example.com/stage2-retry-d.jpg",
    retryLatestJobId: "job-d",
  };

  const chainedView = getCardArtifactView(retriedAgainCard);
  assert.equal(chainedView.available.some((artifact) => artifact.key === "edited"), true);
  assert.equal(chainedView.available.some((artifact) => artifact.key === "retried"), true);
  assert.equal(chainedView.active?.key, "edited");
  assert.equal(chainedView.active?.url, "https://cdn.example.com/stage2-edit-c.jpg");

  const explicitChainedRetry = getCardArtifactView(retriedAgainCard, { selectedKey: "retried" });
  assert.equal(explicitChainedRetry.active?.key, "retried");
  assert.equal(explicitChainedRetry.active?.url, "https://cdn.example.com/stage2-retry-d.jpg");

  const polledUpdateAfterRetrySelection = {
    ...retriedAgainCard,
    latestEditUrl: "https://cdn.example.com/stage2-edit-e.jpg",
    editLatestUrl: "https://cdn.example.com/stage2-edit-e.jpg",
    editLatestJobId: "job-e",
  };
  const stickyRetrySelection = getCardArtifactView(polledUpdateAfterRetrySelection, { selectedKey: "retried" });
  assert.equal(stickyRetrySelection.active?.key, "retried");
  assert.equal(stickyRetrySelection.active?.url, "https://cdn.example.com/stage2-retry-d.jpg");

  const lineageShapeCard = {
    ...polledUpdateAfterRetrySelection,
    parentJobId: "job-a",
    retryLatestJobId: "job-d",
    editLatestJobId: "job-e",
    retryInfo: { parentJobId: "job-a" },
    result: {
      parentJobId: "job-a",
      retryInfo: { parentJobId: "job-a" },
    },
  };
  const lineageView = getCardArtifactView(lineageShapeCard);
  assert.equal(lineageView.active?.key, "edited");
  assert.equal(
    lineageView.available.every((artifact) => ["original", "1A", "1B", "2", "retried", "edited"].includes(artifact.key)),
    true
  );
});

test("resolveSafeStageUrl follows canonical artifact view", () => {
  const data = {
    status: "completed",
    stageUrls: {
      "1A": "https://cdn.example.com/stage1a.jpg",
      "2": "https://cdn.example.com/stage2-original.jpg",
    },
    latestRetryUrl: "https://cdn.example.com/stage2-retry.jpg",
    latestEditUrl: "https://cdn.example.com/stage2-edit.jpg",
  };

  const resolved = resolveSafeStageUrl(data);
  assert.deepEqual(resolved, {
    url: "https://cdn.example.com/stage2-edit.jpg",
    stage: null,
  });
});
