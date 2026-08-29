import {
  evaluateStage1BSourceStageInvariant,
  ROUTING_INVARIANT_REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT_CODE,
  type Stage1BSourceStageInvariantInput,
} from "../src/pipeline/routingInvariants";

function makeInput(overrides: Partial<Stage1BSourceStageInvariantInput> = {}): Stage1BSourceStageInvariantInput {
  return {
    isExteriorScene: false,
    stage1BRequired: true,
    stage1BRequested: true,
    stage2SourceStage: "1A",
    ...overrides,
  };
}

describe("evaluateStage1BSourceStageInvariant (C1 fix)", () => {
  it("fires when every signal agreed Stage 1B should run, interior scene, but Stage 2 used 1A", () => {
    const result = evaluateStage1BSourceStageInvariant(makeInput());
    expect(result.violated).toBe(true);
    expect(result.code).toBe(ROUTING_INVARIANT_REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT_CODE);
  });

  it("does NOT fire for exterior scenes even when the AI gate and the request both wanted Stage 1B (resolveStage2Routing forces 1A for exterior by design)", () => {
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ isExteriorScene: true })
    );
    expect(result.violated).toBe(false);
  });

  it("does NOT fire on stage1BRequired alone when the user/request never asked for Stage 1B — the job_1a4c8532 regression case", () => {
    // Real production case: the furniture-detector AI gate's own opinion
    // (stage1BRequired) was true, but the user's request never asked for
    // decluttering (stage1BRequested false). Per the documented contract,
    // the AI gate's opinion is subordinate to what was actually requested,
    // so Stage 2 correctly used 1A — this must not be flagged.
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ stage1BRequired: true, stage1BRequested: false })
    );
    expect(result.violated).toBe(false);
  });

  it("does NOT fire when the request asked for Stage 1B but the AI gate did not require it", () => {
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ stage1BRequired: false, stage1BRequested: true })
    );
    expect(result.violated).toBe(false);
  });

  it("does NOT fire when Stage 2 actually used Stage 1B output (light)", () => {
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ stage2SourceStage: "1B-light" })
    );
    expect(result.violated).toBe(false);
  });

  it("does NOT fire when Stage 2 actually used Stage 1B output (stage-ready)", () => {
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ stage2SourceStage: "1B-stage-ready" })
    );
    expect(result.violated).toBe(false);
  });

  it("does NOT fire when neither the gate nor the request wanted Stage 1B (ordinary enhance-only interior job)", () => {
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ stage1BRequired: false, stage1BRequested: false })
    );
    expect(result.violated).toBe(false);
  });

  it("exterior exemption applies regardless of stage2SourceStage value", () => {
    const result = evaluateStage1BSourceStageInvariant(
      makeInput({ isExteriorScene: true, stage2SourceStage: "1A" })
    );
    expect(result.violated).toBe(false);
  });
});
