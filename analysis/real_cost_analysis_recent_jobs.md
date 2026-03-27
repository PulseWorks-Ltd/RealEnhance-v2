# RealEnhance Recent Pipeline Cost Analysis

- Sampled image workflows: 32
- Supplemental region-edit workflows: 5
- Logs: logs.1774007640474.log, logs.1774087485754.log, logs.1774126834785.log, logs.1774232618776.log, logs.1774350748550.log, logs.1774415998089.log, logs.1774528848370.log

## Strict Findings

- No per-call Gemini token usage metadata found in sampled production logs for image-generation stages 1A, 1B, or 2.
- Gemini validator calls are observable, but the exact validator model used per call is not emitted in sampled logs.
- No dedicated repair-layer call marker was found in the sampled logs; repair-layer cost is therefore observed as zero/unlogged, not proven absent in the system.
- Official Gemini pricing page was fetched successfully but not parseable into model-level constants from static HTML in this environment.

## Distribution

- pctImagesUsingStage1B: 15.62
- pctImagesTriggeringRetry: 34.38
- pctImagesTriggeringGeminiValidator: 0.0
- pctImagesTriggeringRepairLayer: 0.0

## Avg Calls Per Stage

- 1A: 0.875
- 1B: 0.1875
- 2: 1.6875

## Top Observed Call Drivers

- Stage 2 retries: 22
- Stage 1B base usage: 4
- Stage 1B retries: 1

## Cost Status

- Numeric cost per image is not defensible from the sampled logs because token usage metadata is absent and model-level pricing constants were not recoverable in parseable form from static HTML in this environment.
- The JSON artifact contains the full per-job structured dataset for pricing backfill once token telemetry or approved constants are supplied.
