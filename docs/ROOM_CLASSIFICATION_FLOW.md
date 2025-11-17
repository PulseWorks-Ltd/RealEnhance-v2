# Room Classification Flow

## Overview
The worker detects a `roomTypeDetected` while respecting a user-selected `roomType`. The UI displays the user override if present; otherwise it falls back to the detected value. Scene (interior/exterior/room category) is also surfaced, plus staging gating.

## Data Fields
- `meta.roomTypeDetected`: Model + heuristic inference; NEVER overwrites user choice.
- `meta.roomType`: User-selected override (from upload or retry); authoritative for prompts & staging.
- `meta.scene.label`: Primary scene classification.
- `meta.allowStaging`: Boolean gating (exterior region rules, confidence, coverage).
- `meta.stagingRegion`: Optional region metadata for exterior staging (may be null).

## Precedence Rules
1. If user specified a `roomType` and it is not `auto`, UI uses it.
2. Else if `roomTypeDetected` exists, UI uses that.
3. Else UI shows `unknown` or nothing.

## Lifecycle
1. Upload: Server sets initial `options.roomType` (default `"unknown"`) and forwards `sceneType` (default `"auto"`).
2. Worker: Detects scene + room; stores interim meta (`roomTypeDetected`, user `roomType`).
3. Worker Completion: Final meta includes both values; status endpoints return `meta` untouched.
4. Client Polling: Batch processor merges `roomTypeDetected` only if current local roomType is empty or `auto`.
5. Override: Retry dialog lets user pick a new room type; new job carries override while detection still recorded separately.

## API Exposure
- `/api/status/batch` items contain `meta.roomTypeDetected` & `meta.roomType`.
- `/api/status/:jobId` same.

## Staging Gating Interaction
If `allowStaging` is false, UI shows a badge ("Staging blocked") regardless of room type chosen. Override does not force staging; gating is independent.

## Future Enhancements
- Confidence display for detected room type (tooltip).
- Normalization mapping (e.g. merge `dining` vs `living_room` into broader categories per profile).
- Multi-angle consistency: lock room type across angles with grouping key.
- Optional user toggle to revert to detected room type.

## Edge Cases
- If user selects an incompatible room type for an exterior scene, prompts may still generate staging; consider adding validation warning.
- When detection returns generic label ("other"), keep user override as-is if set.

## Environment Variables (Related to Staging/Structural Validation)
- `STAGE2_STRUCT_VALIDATOR_BLUR`: Blur sigma for structural validator (set to `0.4` recommended; `none` disables).
- `STAGE2_STRUCT_IOU_MIN`: Minimum structural IoU; lower (e.g. `0.5`) reduces false negatives.

---
Last updated: 2025-11-17.
