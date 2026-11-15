import { retryPriorityHint, RETRY_PRIORITY_TAG } from "../src/pipeline/stage2Masked/core";
import { RETRY_PRIORITY_TAG as STAGE2_TAG } from "../src/pipeline/stage2";

describe("retry priority instruction (wall pushed back / floor raised)", () => {
  it("is tagged for the top of the prompt, with the same tag the Stage 2 prompt looks for", () => {
    expect(RETRY_PRIORITY_TAG).toBe(STAGE2_TAG);
    expect(retryPriorityHint([80, 95]).startsWith(RETRY_PRIORITY_TAG)).toBe(true);
  });
  it("says where, keeps the room, and lets furniture run off the photo", () => {
    const h = retryPriorityHint([80, 95]);
    expect(h).toMatch(/on the right of the photo/);
    expect(h).toMatch(/Do not push any wall back, do not raise or lower the floor/);
    expect(h).toMatch(/run off the edge of the photo/);
    expect(h).toMatch(/true real-world size/);
  });
  it("never asks for legs to touch the floor (that made Gemini move the floor)", () => {
    expect(retryPriorityHint(null)).not.toMatch(/touch|reach the floor|rest on/i);
  });
});
