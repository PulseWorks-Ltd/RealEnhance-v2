import assert from "node:assert/strict";
import test from "node:test";

import { hasEditedArtifact } from "./retry-policy";

test("hasEditedArtifact returns true for top-level edit metadata", () => {
  assert.equal(
    hasEditedArtifact({
      latestEditUrl: "https://cdn.example.com/edit.jpg",
      editLatestJobId: "job-edit-1",
    }),
    true,
  );
});

test("hasEditedArtifact returns true for nested result edit metadata", () => {
  assert.equal(
    hasEditedArtifact({
      result: {
        editLatestUrl: "https://cdn.example.com/edit-nested.jpg",
      },
    }),
    true,
  );
});

test("hasEditedArtifact returns false when no edit metadata exists", () => {
  assert.equal(
    hasEditedArtifact({
      latestRetryUrl: "https://cdn.example.com/retry.jpg",
      retryLatestJobId: "job-retry-1",
    }),
    false,
  );
});
