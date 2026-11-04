import assert from "node:assert/strict";
import test from "node:test";

import { creditCoverageFor, photosCoveredBy } from "./credit-coverage";

test("29 staged rooms at 2 credits, 5 credits held: 2 now, 6 with a 7-credit pack (Nov 2026 Hero Pack case)", () => {
  const perPhoto = Array.from({ length: 29 }, () => 2);
  assert.deepEqual(creditCoverageFor(perPhoto, 5, 7), { total: 29, nowCount: 2, nowCredits: 4, withPackCount: 6 });
});

test("stops at the first photo that doesn't fit (batch order is kept)", () => {
  assert.deepEqual(photosCoveredBy([1, 2, 1], 2), { count: 1, credits: 1 });
});

test("a pack that covers the whole batch", () => {
  const c = creditCoverageFor([1, 1, 2], 0, 7);
  assert.equal(c.withPackCount, c.total);
  assert.equal(c.nowCount, 0);
});
