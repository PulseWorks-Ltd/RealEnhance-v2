import assert from "node:assert/strict";
import test from "node:test";

import { friendlyEditError } from "./edit-errors";

test("friendlyEditError: an Add that didn't fit asks for a larger area", () => {
  const m = friendlyEditError("Whole-image Add failed after 2 attempts: the new piece runs past the marked area (24% of the band's edge); the new piece is mostly outside the marked area (31% inside)");
  assert.match(m, /couldn't fit the item/);
  assert.match(m, /hasn't been changed/);
});

test("friendlyEditError: changed surroundings", () => {
  assert.match(friendlyEditError("Whole-image Replace failed after 2 attempts: 76% of the area around the item changed"), /changed more of the room/);
});

test("friendlyEditError: nothing changed", () => {
  assert.match(friendlyEditError("nothing changed inside the marked area"), /didn't change the area/);
});

test("friendlyEditError: anything else gets the general note", () => {
  assert.equal(friendlyEditError(""), "The edit couldn't be completed. Please try again. Your image hasn't been changed.");
});
