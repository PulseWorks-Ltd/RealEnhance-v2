# Structural Specialist Authority - Deliverables

Date: 2026-06-23
Branch: feature/testing-reduced-logs

## 1) Files changed

- worker/src/worker.ts
  - Added pre-unified enforcement gate for confirmed critical envelope hard-fails.
  - Added concise production-mode audit emission for STRUCTURAL_HARD_FAIL.
- STRUCTURAL_SPECIALIST_AUTHORITY_PRECHECK.md
  - Pre-implementation analysis report with code-path and impact metrics.

## 2) Enforcement flow before and after

Before:

Envelope FAIL (critical/confirmed/hardFail)
-> not in ALLOWED_HARDFAIL_ISSUES pre-unified whitelist
-> proceeds to runUnifiedValidation(...)
-> Unified may PASS
-> image can be published

After:

Envelope FAIL + critical + confirmed structural token + hardFail
-> STRUCTURAL_SPECIALIST_AUTHORITY gate triggers before runUnifiedValidation(...)
-> immediate VALIDATION_FAIL for attempt
-> normal Stage2 retry path
-> if retries exhausted, fallback/block path as existing behavior

## 3) Example concise audit log output (production mode)

When PRODUCTION_LOG_MODE=true and the authority gate triggers:

{
  "jobId": "job_33341abb-55e9-42eb-8567-90bd4d8d8baa",
  "validator": "Envelope",
  "event": "STRUCTURAL_HARD_FAIL",
  "reason": "envelope_confirmed_structural_change",
  "confidence": 0.95
}

## 4) Verification run using known escaped image

Known escaped image/job:

- job_33341abb-55e9-42eb-8567-90bd4d8d8baa
- source log artifact: logs.1782253107584.log

Observed in trace (before fix):

- Envelope produced envelope_confirmed_structural_change
- Envelope logged VALIDATOR_HARD_FAIL and issueTier critical
- Later Unified override logged: "[UNIFIED_AUTHORITY] Local validator failures overridden by Gemini PASS"
- Publish URL emitted for the same job

Post-fix gate condition checks against the same observed trace values:

- envelopeSignal.hardFail == true
- specialistResults.envelope.issueTier == "critical"
- reason/advisory contains "envelope_confirmed_structural_change"

Result with fix:

- pre-unified gate triggers
- decisionReason = structural_specialist_authority:envelope_confirmed_structural_change
- attempt enters retry path immediately
- Unified adjudication is bypassed for this condition set

## 5) Confirmation of enforcement guarantee

Confirmed by implementation in worker/src/worker.ts:

- Confirmed critical envelope hard-fail now blocks pre-unified.
- Unified adjudication no longer gets control for this exact condition set.
- Existing retry and fallback semantics remain unchanged.
- No changes made to Opening/Floor/Fixture validators, Unified scoring, retry thresholds, or prompts.

## Implementation references

- envelope authority gate insertion in worker/src/worker.ts around lines 13530-13620
- existing envelope condition semantics:
  - worker/src/validators/envelopeValidator.ts:108
  - worker/src/validators/envelopeValidator.ts:130
  - worker/src/validators/envelopeValidator.ts:132
- existing pass-through location:
  - worker/src/worker.ts:13447-13873
  - worker/src/validators/runValidation.ts:1969

## Impact estimate from Phase 2 artifacts

Using repository artifacts only (no extrapolation):

- analysis_envelope_fail_jobs.tsv: 10 unique envelope-fail jobs
- analysis_envelope_overturned.tsv: 2 unique published overrides
- Approximate affected share: 20.0%
