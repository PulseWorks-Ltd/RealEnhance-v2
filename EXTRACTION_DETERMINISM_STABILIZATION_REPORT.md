# Extraction Determinism Stabilization Report

## Scope

Focused operational stabilization for extraction determinism under concurrency.

Explicitly out of scope:
- validator redesign
- prompt rewrites
- Gemini quality tuning

## 1. Extraction Instability Report

### Confirmed instability sources

1. Graph identity hashing did not include opening bbox geometry.
   - Prior behavior: two extractions with materially different opening coordinates could still share the same graph hash if type/band/class fields matched.
   - Impact: bbox drift and some geometry drift were undercounted in baseline agreement telemetry.

2. Opening sequence evaluation used x-only ordering for wall token sequences.
   - Prior behavior: equal-x openings or fixtures could preserve original array order from extraction output.
   - Impact: same geometry could emit different left-to-right sequence results when extraction arrival order changed.

3. Canonical extracted opening/fixture arrays were not explicitly sorted after baseline normalization.
   - Prior behavior: downstream consumers inherited provider/output ordering.
   - Impact: reconciliation, wall-sequence checks, and forensic comparisons were exposed to ordering noise.

4. Candidate reconciliation ranking used score-only sorting.
   - Prior behavior: equal-score candidates were not ordered by a deterministic semantic tiebreak.
   - Impact: debug traces and top-candidate selection order were more fragile than necessary.

5. Structural extraction sessions were not isolated from one another within a worker process.
   - Prior behavior: separate jobs could enter extraction concurrently with no extraction-specific cap.
   - Impact: concurrency, heap pressure, and request overlap could amplify nondeterministic extractor outputs.

### Instrumentation added

New structured events:
- `[STRUCTURAL_BASELINE_SESSION_ACQUIRED]`
- `[STRUCTURAL_BASELINE_SESSION_RELEASED]`
- `[STRUCTURAL_BASELINE_PASS_DETAIL]`
- `[STRUCTURAL_BASELINE_VARIANCE]`
- `[OPENING_RECONCILIATION_TRACE]`

Measured fields now include:
- opening count variance
- graph hash variance
- signature variance
- bbox variance
- wall-index variance
- vertical-band variance
- confidence variance
- reconciliation hash
- matched vs unmatched openings
- extraction wait time and active extraction session count
- heap/rss snapshots at extraction acquisition/release

### Concurrency amplification findings

Static audit conclusion:
- extraction ordering noise was present before concurrency entered the system
- concurrent load could amplify it by changing arrival order, resource timing, and extraction overlap
- the baseline telemetry previously under-reported geometry variance because graph hashing omitted bbox coordinates

Runtime production quantification is now enabled by the new events above; no live concurrent replay was executed in this workspace.

## 2. Determinism Hotspot Report

### Unstable ordering hotspots

Primary hotspot: `worker/src/validators/openingPreservationValidator.ts`

Stabilized areas:
- canonical opening sort after baseline normalization
- canonical anchor fixture sort after baseline normalization
- score-tie ordering in reconciliation
- equal-x ordering in wall sequence evaluation
- graph histogram ranking tie-break by hash

### Reconciliation drift sources

Primary risk pattern:
- small extraction differences changed candidate ordering or wall token ordering
- downstream logic then surfaced advisory or mismatch state even when geometry was effectively unchanged

Added guard:
- deterministic semantic tiebreaks now apply when scores or x-coordinates are equal

### Graph instability sources

Primary risk pattern:
- graph hash was too coarse because it excluded bbox geometry

Added guard:
- graph hashing now includes quantized bbox coordinates, preserving stability for sub-precision noise while distinguishing material geometry drift

### Normalization instability

Added guard:
- normalized bbox coordinates are now quantized deterministically (`OPENING_COORDINATE_PRECISION`, default `4`)

## 3. Open-Plan Scaling Report

Expected high-risk conditions remain:
- open-plan rooms
- wide-angle photography
- high opening counts
- edge-positioned windows
- distant openings

Reason:
- these scenes increase tie frequency in ordering, increase wall-assignment ambiguity, and magnify small bbox drift into reconciliation drift

Comparison vs bedrooms:
- bedrooms typically have fewer openings and lower sequence ambiguity
- open-plan scenes are more likely to produce near-tied positions, multi-wall ambiguity, and higher downstream graph entropy

This patch does not weaken open-plan enforcement. It reduces deterministic drift amplification in the extraction/reconciliation path and adds telemetry needed to quantify open-plan scaling under live replay.

## 4. Stabilization Changes Implemented

### Files changed

- `worker/src/validators/openingPreservationValidator.ts`
- `worker/tests/openingPreservationDeterminism.test.ts`

### Deterministic guards added

In `worker/src/validators/openingPreservationValidator.ts`:
- deterministic bbox quantization
- geometry-aware graph hashing
- canonical opening ordering
- canonical anchor fixture ordering
- deterministic reconciliation tie-breaks
- deterministic equal-x wall sequence ordering
- deterministic graph histogram ranking tie-breaks
- extraction-session serialization inside the worker process
- per-pass structural variance telemetry
- reconciliation hash telemetry

### Concurrency controls added

New extraction-specific limit:
- `OPENING_EXTRACTION_MAX_CONCURRENCY` default `1`

Purpose:
- isolate structural extraction sessions from destructive in-process overlap
- reduce contention across heap, Gemini extraction overlap, and validation-side extraction timing

## 5. Before/After Metrics

### Verified in this workspace

Focused test file:
- `worker/tests/openingPreservationDeterminism.test.ts`

Current result:
- 3/3 tests passing

Validated outcomes:
- sub-precision bbox noise preserves the same graph hash
- material bbox geometry drift changes the graph hash
- reversed equal-x extraction order no longer produces opening signature drift

### Operational metrics now exposed for live collection

Collect from logs using the new events:
- graph agreement rate
- opening count stability
- reconciliation stability
- bbox drift frequency
- wall-index drift frequency
- vertical-band drift frequency
- confidence drift frequency

### Remaining gap

The workspace validation did not include:
- live concurrent replay
- memory-pressure replay
- retry-overlap replay
- open-plan vs bedroom benchmark runs

Those measurements should be taken next using the new telemetry rather than inferred from legacy graph hash counts.
