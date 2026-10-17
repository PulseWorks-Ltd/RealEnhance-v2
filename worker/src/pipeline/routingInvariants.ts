// Stage 2 source-stage routing invariant — extracted as a pure function so
// its logic can be unit-tested directly (see
// tests/stage1BSourceStageInvariant.test.ts) without loading worker.ts.
//
// HISTORY / WHY THIS WAS CORRECTED:
// The original check fired whenever `stage1BRequired && stage2SourceStage
// === "1A"`, where stage1BRequired is only the furniture-detector AI gate's
// own OPINION that decluttering would help — not a statement that the user
// or the request actually asked for it, and not a statement that Stage 1B
// even ran. A targeted verification pass found:
//   - 6 of 7 real occurrences were exterior scenes, where
//     resolveStage2Routing unconditionally forces sourceStage="1A" by
//     design ("Exterior: always use Stage 1A") — not a conflict at all.
//   - The 7th (job_1a4c8532, a real interior job) had no Stage 1B request
//     or lineage anywhere in its own log — the AI gate wanted decluttering,
//     the user's request never asked for it, and per this codebase's own
//     documented contract ("CONTRACT: Stage2 must prefer Stage1B lineage
//     over request flags" — worker.ts, near stage1BRequested's
//     declaration) the AI gate's opinion is explicitly subordinate to what
//     was actually requested. Using 1A was correct; the alarm was not.
// The corrected condition below only fires when the AI gate wanted Stage 1B
// AND the user/request actually asked for it AND the scene is interior —
// i.e. a case where every input agreed Stage 1B should run, yet Stage 2
// still ended up sourced from 1A. The invariant code is renamed
// (STAGE1B_SOURCE_STAGE_CONFLICT -> REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT)
// so a reader can't mistake it for firing on the AI gate's opinion alone.
export const ROUTING_INVARIANT_REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT_CODE =
  "ROUTING_INVARIANT_REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT" as const;

export type Stage1BSourceStageInvariantInput = {
  /** True for exterior scenes — always exempt; resolveStage2Routing forces sourceStage="1A" for these by design. */
  isExteriorScene: boolean;
  /** The furniture-detection AI gate's own opinion that Stage 1B would help. Advisory only — see module doc comment. */
  stage1BRequired: boolean;
  /** Whether the user/request itself asked for decluttering (declutter flag, stage2OnlyMode, or a retry plan that wants Stage 1B). */
  stage1BRequested: boolean;
  /** What Stage 2 actually used as its source image, per resolveStage2Routing's own sourceStage union. */
  stage2SourceStage: "1A" | "1B-light" | "1B-stage-ready";
};

export type Stage1BSourceStageInvariantResult = {
  violated: boolean;
  code: typeof ROUTING_INVARIANT_REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT_CODE;
};

/**
 * Detects a genuine Stage 2 source-stage routing conflict: every signal
 * agreed Stage 1B should run (the AI gate's opinion AND the user's actual
 * request), the scene is interior, but Stage 2 still generated from the raw
 * Stage 1A image. See the module doc comment above for the full history of
 * why the naive `stage1BRequired && sourceStage === "1A"` check produced
 * persistent false positives.
 */
export function evaluateStage1BSourceStageInvariant(
  input: Stage1BSourceStageInvariantInput
): Stage1BSourceStageInvariantResult {
  const violated =
    !input.isExteriorScene &&
    input.stage1BRequired === true &&
    input.stage1BRequested === true &&
    input.stage2SourceStage === "1A";
  return { violated, code: ROUTING_INVARIANT_REQUESTED_STAGE1B_SOURCE_STAGE_CONFLICT_CODE };
}
