# Retry Endpoint Canonicalization

## Canonical Endpoint

Use `POST /api/batch/retry-single` as the single retry execution path.

## Legacy Endpoint

`POST /api/retry` is deprecated and disabled.

It now returns `410 retry_endpoint_deprecated` with guidance to use:

- `POST /api/batch/retry-single`

## Why this is canonical

`/api/batch/retry-single` is the only route that enforces full retry semantics used by the UI:

- Baseline stage/source resolution (`baselineStage`, `sourceStage`, `sourceUrl`)
- Stage-aware retry routing and fallback behavior
- Billing reservation consistency for free retry flow
- Retry limits and contract enforcement
- Ownership checks against parent job metadata

The legacy `/api/retry` clone path did not implement the same behavior and was creating duplicate retry logic.
