# Structural Specialist Authority - Pre-Implementation Report

Date: 2026-06-23
Branch: feature/testing-reduced-logs

## 1) Exact code location where Envelope failures are currently passed through to Unified

Current pass-through is in worker stage2 orchestration:

- worker/src/worker.ts:13447
  - `ALLOWED_HARDFAIL_ISSUES` excludes envelope issue types.
- worker/src/worker.ts:13452
  - Inline comment explicitly states envelope issues are advisory-only.
- worker/src/worker.ts:13745
  - `categoricalBlock` is derived from whitelist-based hard-fail gating.
- worker/src/worker.ts:13873
  - `runUnifiedValidation(...)` runs when no categorical pre-unified block occurs.

This means Envelope hard-fail signals can still proceed into Unified adjudication and potentially pass.

Additionally, Unified currently allows local validator failures to be advisory when Gemini passes:

- worker/src/validators/runValidation.ts:1969
  - `[UNIFIED_AUTHORITY] Local validator failures overridden by Gemini PASS`

## 2) Exact existing conditions that trigger envelope_confirmed_structural_change + critical + hardFail

Envelope specialist parse path:

- worker/src/validators/envelopeValidator.ts:108
  - `reasonCode = "envelope_confirmed_structural_change"` when geometric certainty is true.
- worker/src/validators/envelopeValidator.ts:130
  - `issueTier = classifyIssueTier(issueType)` (critical for critical issue types).
- worker/src/validators/envelopeValidator.ts:132
  - `hardFail = hardFailEligible && confidence >= ENVELOPE_HARD_FAIL_CONFIDENCE_THRESHOLD`

Hard-fail eligibility is already existing semantics:

- envelopeDetectedChange
- geometricCertainty
- reasonCode == envelope_confirmed_structural_change
- confidence >= existing threshold

No new thresholds are required.

## 3) Escaped image evidence and post-change expectation

Known escaped case trace:

- logs.1782253107584.log contains:
  - envelope reason token: envelope_confirmed_structural_change
  - envelope issue type: envelope_corner_flattened
  - envelope issue tier: critical
  - envelope hard fail events logged
  - later Unified PASS override events
  - final publish URL for job_33341abb-55e9-42eb-8567-90bd4d8d8baa

Key evidence lines (from extracted trace artifact):

- envelope confirmed structural token observed
- VALIDATOR_HARD_FAIL observed for envelope
- UNIFIED_AUTHORITY override observed
- publish URL emitted afterward

Post-change expectation:

- same condition set will be blocked pre-unified
- image enters normal retry path
- no publish on that attempt

## 4) Estimated impact from Phase 2 findings (artifact-backed)

Source artifacts:

- analysis_envelope_fail_jobs.tsv
- analysis_envelope_overturned.tsv

Computed from repository artifacts:

- Unique envelope-fail jobs: 10
- Unique published overrides: 2
- Approximate affected share: 20.0% (2 / 10)

Notes:

- This uses the current artifact sample only.
- No extrapolation beyond the artifact scope.
