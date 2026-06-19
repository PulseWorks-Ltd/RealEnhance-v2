# RealEnhance Validation Test: Validator-Guided Automatic Retry (Latest)

## Target
- Job: job_0a649ccd-e39d-48e8-aa5b-b081391fee82
- Mode: Stage 2 retry replay (attempt 2 path)
- Goal: verify that validator hard-fail signals become short auto retry instructions and are injected via the same retryInstructions path used by manual retry

## Primary Artifacts
- Latest replay report: /workspaces/RealEnhance-v2/analysis/validator_retry_replay_job_0a649ccd/evidence/replay_report_1781837294213.json
- Latest replay log: /workspaces/RealEnhance-v2/analysis/validator_retry_replay_job_0a649ccd.run.latest.log
- Replay image (attempt 2): /workspaces/RealEnhance-v2/analysis/validator_retry_replay_job_0a649ccd/outputs/replay_attempt2.webp
- Historical attempt 2 image: /workspaces/RealEnhance-v2/analysis/validator_retry_replay_job_0a649ccd/inputs/historical_attempt2.webp
- Stage 1A replay base image: /workspaces/RealEnhance-v2/analysis/validator_retry_replay_job_0a649ccd/inputs/stage1A_delivery.jpg

## Auto Guidance Generated (Latest Run)
- instructionCount: 3
- validatorInstructions:
	- Do not remove, seal, cover, wall over, resize or relocate any window openings.
	- Do not alter wall geometry, recesses, corners, or room envelope surfaces.
- layoutInstruction:
	- Place the bed against the wall on the right.

## Injection Evidence (Runtime)
From run.latest.log:
- [AUTO_RETRY_GUIDANCE_PROMPT] promptInjected=true instructionCount=3
- Retry completed with REPORT and REPLAY_IMAGE paths emitted

Note: stage2 prompt dump writing is currently not implemented in worker/src/pipeline/stage2.ts. The prompt file path is printed by the replay harness, but file content may be stale from earlier runs. Injection confirmation for this run therefore relies on runtime logs plus report JSON.

## Historical vs Replay (Attempt 2)

Historical attempt 2 (from latest report):
- opening.issueType: opening_removed
- opening.reason: opening_removed|opening_sealed|opening_relocated_review|opening_relocated|opening_resized|opening_band_mismatch
- unified.passed: false
- unified.hardFail: true

Replay attempt 2 (from latest report):
- opening.issueType: opening_resized_minor
- opening.reason: opening_resized|opening_band_mismatch
- unified.passed: true
- unified.hardFail: false
- unified.warnings:
	- Only flexible staging items (furniture, lamps, rug, decor) have been added.
	- No structural elements (walls, window openings, room envelope, camera viewpoint) have changed.
	- No fixed features (ceiling lights, window treatment type) have been altered or removed.

## Conclusion
- Auto retry guidance is generated in short human-like lines and injected in Stage 2 via retryInstructions.
- All specialist hard-fail issueType/reason signals are aggregated into retry triggers before guidance generation.
- Latest replay differs materially from failed historical retry and passes unified validation.

## Limitations
- Replay remains stochastic and is not byte-identical to original production execution.
- Local Redis is unavailable (ECONNREFUSED), but this path still completed generation and unified validation.
