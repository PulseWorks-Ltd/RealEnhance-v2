# Quarantined / unimplemented validators

**H3 finding (RealEnhance — Full Pipeline Integrity & Anomaly Audit, targeted
verification pass, 2026-08-29).** Every file in this directory is a
placeholder from an earlier design that was never actually completed. Do
not import from this directory into a live pipeline path.

## What's here and why

- **`semanticSegmenter.ts`** — `segmentImageClasses` is an explicit stub
  (its own header comment: "replace with a real ADE20K/DeepLab or similar
  model integration"). It always returns `{width: 0, height: 0, masks: []}`
  regardless of input — no actual image analysis occurs.
- **`classComparisons.ts`** — every exported comparator
  (`compareWalls`/`compareWindows`/`compareDoors`/`compareFloorMaterial`/
  `compareGrassConcrete`/`compareDrivewayPresence`/`compareVehicles`) is a
  literal `// Stub: always pass` → `return {pass:true}`, independent of
  whatever `semanticSegmenter.ts` gives it.
- **`wallValidator.ts`** — `validateWallStructure`: `// TODO: Implement
  real wall line detection and comparison` → hardcoded `{ok:true,
  reason:"none"}`. Was only ever reachable when `LOCAL_VALIDATOR_TIER=full`,
  which is not this project's active setting (`worker/.env` sets `"core"`),
  so in addition to being a stub it was already dormant in production.
- **`landcoverValidator.ts`** — `validateExteriorLandcover`: same pattern,
  and had zero callers anywhere in the codebase even before this move.
- **`stage1AStructuralValidator.ts`** — `validateStage1AStructure`: a whole
  file with zero callers anywhere in the codebase. Internally it also
  hardcoded every return path to `{ok: true, ...}` regardless of findings,
  so even if it had been wired up it could never have failed anything.
- **`orphanedStage1AStubs.ts`** — three functions
  (`computeStructuralChangeRatio`/`computeWindowIoU`/
  `computeLandcoverChangeRatio`) extracted from `stage1AValidator.ts`, each
  a `// TODO: Implement... always pass for now` stub with zero callers.

## What changed alongside this move

The functions that were actually **live-called** despite depending on this
stub chain — `stage1AValidator.ts`'s `validateStage1AStructural`,
`stage1BValidator.ts`'s `validateStage1BStructural`, and the per-class
portion of `stage2StructuralValidator.ts`'s `validateStage2Structural` —
have had their calls into this stub chain **removed**, not repointed here.
Each now returns its (unchanged, still-always-passing) result honestly
labeled `unimplemented: true` / `perClassStructuralComparisonUnimplemented:
true` instead of silently invoking code that could only ever report
success. `wallValidator`'s one caller (`runValidation.ts`'s
`LOCAL_VALIDATOR_TIER=full` branch) was changed the same way.

`stage2StructuralValidator.ts`'s real, working Sobel-edge structural IoU
check (unrelated to segmentation) was **not** touched by any of this — it
remains Stage 2's genuine structural protection.

## If real per-class structural validation is wanted later

A real implementation needs an actual segmentation model behind
`segmentImageClasses` (e.g. a real ADE20K/DeepLab integration, as the
original stub comment says) before any of `classComparisons.ts`'s
functions can be filled in meaningfully. Until then, nothing in this
directory should be imported by a live validator path — doing so would
silently reintroduce the exact false-sense-of-protection this move was
meant to eliminate.
