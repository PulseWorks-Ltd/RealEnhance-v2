jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { withConsensus } from "../src/pipeline/stage2Masked/core";

const answers = (list: any[]) => {
  let n = 0;
  return { run: async (_k: number) => list[n++], calls: () => n };
};
const fails = (r: any) => Boolean(r.failed);

describe("AI check consensus", () => {
  it("two agreeing answers decide, no third call", async () => {
    const a = answers([{ failed: true, id: 1 }, { failed: true, id: 2 }, { failed: false }]);
    const r = await withConsensus(a.run, fails);
    expect(r.failed).toBe(true);
    expect(a.calls()).toBe(2);
  });
  it("a split asks a third time, and the third decides", async () => {
    const a = answers([{ failed: true }, { failed: false }, { failed: false, id: 3 }]);
    const r = await withConsensus(a.run, fails);
    expect(r.failed).toBe(false);
    expect(a.calls()).toBe(3);
    expect(r.consensus?.votes).toEqual([true, false, false]);
  });
  it("needs two fail votes to reject; an error never counts", async () => {
    const a = answers([{ error: "timeout", failed: false }, { failed: true }, { error: "timeout", failed: false }]);
    expect((await withConsensus(a.run, fails)).failed).toBe(false);
    const b = answers([{ error: "timeout", failed: false }, { failed: true, hint: "x" }, { failed: true, hint: "y" }]);
    expect((await withConsensus(b.run, fails)).failed).toBe(true);
  });
});
