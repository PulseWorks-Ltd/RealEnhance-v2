# Envelope Validator Two-Job Regression Replay

Run timestamp: 2026-06-26T04:59:08.462Z
Replay scope: job_c11a8e7c and job_bb029607 only.
Image source policy: local Stage 1A JPG + local Stage 2 JPG first; canonical Stage 1A WEBP fallback applied when vertical edge delta did not execute.

| Job | Expected | Actual | Vertical Edge Delta Executed? | Unsupported Architectural Completion Detected? | Added Wall Detected? | Removed Wall Detected? | Gemini Reasoning | Final Decision | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| job_c11a8e7c | fail | pass | no | no | no | no | envelope_preserved_no_material_modification | pass | 1.0 |
| job_bb029607 | fail | pass | no | no | no | no | The permanent architectural room envelope, including wall planes, openings, and landmarks, remains identical between the baseline and staged images. No architectural modifications were detected. | pass | 1.0 |

## Assessment

1. Did the new baseline visibility semantics materially change Gemini's reasoning?
- Partially. The output language shifted to envelope-preservation semantics and in one case emitted the new positive token envelope_preserved_no_material_modification. However, decision outcomes did not change on the two failing regressions.

2. Did Gemini now recognise the unsupported left-edge wall additions?
- No. Neither case produced unsupported_architectural_completion or wall_added/wall_extended detection.

3. Did restoring the canonical Stage 1A WEBP images improve the geometric analysis?
- No. Vertical edge delta still did not execute after canonical WEBP fallback (both rows remain no). The same non-blocking unsupported image format failure path persisted.

4. Is the Envelope Validator now sufficiently distinguishing between known architecture, unknown architecture, and unsupported architectural completion?
- No.
- Weak point in reasoning chain: Stage 3 geometric signal remains absent, so Stage 4 semantic evaluation is effectively single-authority and still defaults to preserved-envelope conclusions. The new visibility semantics are present in context, but the semantic classifier is not converting uncertainty metadata into negative determinations when staged imagery appears to complete unsupported geometry.

## Notes

- Canonical WEBP baselines were downloaded and used for second-pass replay attempts:
	- worker/reports/debug-baselines/job_c11a8e7c-canonical-stage1a.webp
	- worker/reports/debug-baselines/job_bb029607-canonical-stage1a.webp
- Raw JSON replay output:
	- worker/reports/envelope-two-failing-replay-summary.json
