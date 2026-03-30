import assert from "node:assert/strict";
import test from "node:test";

import { resolveSelectedEditSource } from "./edit-source";

test("resolveSelectedEditSource preserves retry identity when stage 2 and retry share the same artifact URL", () => {
  const resolved = resolveSelectedEditSource({
    selectedTab: "2",
    stage2Url: "https://cdn.example.com/retry-output.jpg?v=123",
    retryLatestUrl: "https://cdn.example.com/retry-output.jpg?v=456",
    defaultJobId: "job-parent",
    retryArtifactJobId: "job-retry",
  });

  assert.deepEqual(resolved, {
    sourceUrl: "https://cdn.example.com/retry-output.jpg?v=456",
    sourceStage: "retry",
    selectedTab: "retried",
    sourceJobId: "job-retry",
  });
});

test("resolveSelectedEditSource keeps explicit stage 2 selection when retry artifact is different", () => {
  const resolved = resolveSelectedEditSource({
    selectedTab: "2",
    stage2Url: "https://cdn.example.com/stage2-original.jpg",
    retryLatestUrl: "https://cdn.example.com/stage2-retry.jpg",
    defaultJobId: "job-parent",
    retryArtifactJobId: "job-retry",
  });

  assert.deepEqual(resolved, {
    sourceUrl: "https://cdn.example.com/stage2-original.jpg",
    sourceStage: "2",
    selectedTab: "2",
    sourceJobId: "job-parent",
  });
});

test("resolveSelectedEditSource returns retry artifact for explicit retried selection", () => {
  const resolved = resolveSelectedEditSource({
    selectedTab: "retried",
    retryLatestUrl: "https://cdn.example.com/stage2-retry.jpg",
    retryArtifactJobId: "job-retry",
  });

  assert.deepEqual(resolved, {
    sourceUrl: "https://cdn.example.com/stage2-retry.jpg",
    sourceStage: "retry",
    selectedTab: "retried",
    sourceJobId: "job-retry",
  });
});