import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustedDimensionsMatch,
  isIdentityAdjustments,
  jobReferencesKey,
  sanitizeAdjustments,
  storageKeysFromUrl,
} from "./photoAdjustRules.js";

test("sanitizeAdjustments keeps only known sliders, in range", () => {
  const a = sanitizeAdjustments({ brightness: 999, shadows: "25", straighten: 3.14159, rotate: 450, evil: "x" });
  assert.equal(a.brightness, 100);
  assert.equal(a.shadows, 25);
  assert.equal(a.straighten, 3.1);
  assert.equal(a.rotate, 90);
  assert.equal(a.v, 1);
  assert.equal((a as any).evil, undefined);
  assert.ok(isIdentityAdjustments(sanitizeAdjustments({})));
  assert.ok(!isIdentityAdjustments(sanitizeAdjustments({ rotate: 90 })));
});

test("adjusted image must match the source size (swapped for quarter turns)", () => {
  const src = { width: 2528, height: 1696 };
  assert.ok(adjustedDimensionsMatch(src, { width: 2528, height: 1696 }, 0));
  assert.ok(adjustedDimensionsMatch(src, { width: 1696, height: 2528 }, 90));
  assert.ok(!adjustedDimensionsMatch(src, { width: 2528, height: 1696 }, 270));
  assert.ok(!adjustedDimensionsMatch(src, { width: 4000, height: 3000 }, 0));
});

test("storage keys come from signed, virtual-host and path-style URLs", () => {
  const keys = storageKeysFromUrl("https://bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/123-a%20b.jpg?X-Amz-Signature=abc");
  assert.ok(keys.includes("realenhance/outputs/123-a%20b.jpg"));
  assert.ok(keys.includes("realenhance/outputs/123-a b.jpg"));
  const pathStyle = storageKeysFromUrl("https://s3.amazonaws.com/bucket/realenhance/outputs/x.jpg");
  assert.ok(pathStyle.includes("realenhance/outputs/x.jpg"));
  assert.deepEqual(storageKeysFromUrl("not a url"), []);
});

test("an intermediate output is accepted only when the job lists that exact file", () => {
  const job = { userId: "u1", stageUrls: { "1A": "https://b.s3.amazonaws.com/realenhance/outputs/111-1A.webp" } };
  assert.ok(jobReferencesKey(job, ["realenhance/outputs/111-1A.webp"]));
  assert.ok(!jobReferencesKey(job, ["realenhance/outputs/999-other.webp"]));
  assert.ok(!jobReferencesKey(job, ["1A"]), "very short keys never match");
  assert.ok(!jobReferencesKey(null, ["realenhance/outputs/111-1A.webp"]));
});
