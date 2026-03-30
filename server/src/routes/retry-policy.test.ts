import assert from "node:assert/strict";
import test from "node:test";

import { jobHasEditedArtifact } from "./retry-policy.js";

test("jobHasEditedArtifact returns true for parent edit metadata", () => {
  assert.equal(
    jobHasEditedArtifact({
      latestEditUrl: "https://cdn.example.com/edit.jpg",
      editLatestJobId: "job-edit-parent",
    }),
    true,
  );
});

test("jobHasEditedArtifact returns true for meta-carried edit metadata", () => {
  assert.equal(
    jobHasEditedArtifact({
      meta: {
        editLatestUrl: "https://cdn.example.com/edit-meta.jpg",
      },
    }),
    true,
  );
});

test("jobHasEditedArtifact returns false for non-edited jobs", () => {
  assert.equal(
    jobHasEditedArtifact({
      latestRetryUrl: "https://cdn.example.com/retry.jpg",
    }),
    false,
  );
});
