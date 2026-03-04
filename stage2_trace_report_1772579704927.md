# Stage 2 Trace Report (logs.1772579704927.log)

Detected jobs: 8
Batch split gap: 449.967s

## Batch 1

### job_08f58775-90d6-4433-a84c-3588fa917a88
- Stage 1B completed: yes
- Attempts per job: 3
- Retry count: 2

| Attempt | Image URL | Blocking validator | Failure reason(s) | Masked Drift | Wall Drift | Deviation | Structural degree | Final decision | Direct hardfail source |
|---:|---|---|---|---:|---:|---:|---:|---|---|
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579015994-realenhance-job_08f58775-90d6-4433-a84c-3588fa917a88-1772578986699-npji8jgicln-canonical-1A-2.webp | gemini mode=block hardFail=false | unknown; semantic_validator_failed: windows 6→6, doors 0→0, wall_drift 54.25%, openings +1/-0; masked_edge_failed: drift 71.94%, openings +1/-0 | 71.94 | 54.25 | n/a | n/a | needs_confirm_or_failed | none |
| 2 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579083117-realenhance-job_08f58775-90d6-4433-a84c-3588fa917a88-1772578986699-npji8jgicln-canonical-1A-2-retry1.webp | gemini mode=block hardFail=true | Perceptual diff failed: SSIM 0.277 < 0.97; Gemini structure: All architectural elements including walls, ceiling, floor, windows, and the existing ceiling light fixture remain identical in position, size, and form., The curtain systems (rods and drapes) are preserved exactly as in the BEFORE image., No camera shift, perspective change, or envelope geometry drift is detected., The room has been appropriately staged as a bedroom, adding suitable furniture without altering the underlying structure or blocking openings.; stage2_direct_hardfail: anchor_fixed_lighting_changed; semantic_validator_failed: windows 4→2, doors 0→0, wall_drift 44.52%, openings +1/-0; masked_edge_failed: drift 20.69%, openings +1/-0 | 20.69 | 44.52 | n/a | n/a | blocked | anchor_fixed_lighting_changed |
| 2 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579150867-realenhance-job_08f58775-90d6-4433-a84c-3588fa917a88-1772578986699-npji8jgicln-canonical-1A-2-retry1.webp | n/a | none logged | n/a | n/a | 9.01 | 9.01 | published | none |

### job_149cc163-03ef-4614-a2b5-71ef708cf162
- Stage 1B completed: yes
- Attempts per job: 2
- Retry count: 1

| Attempt | Image URL | Blocking validator | Failure reason(s) | Masked Drift | Wall Drift | Deviation | Structural degree | Final decision | Direct hardfail source |
|---:|---|---|---|---:|---:|---:|---:|---|---|
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579015460-realenhance-job_149cc163-03ef-4614-a2b5-71ef708cf162-1772578989035-v86om2jq1n8-canonical-1A-2.webp | n/a | none logged | n/a | n/a | n/a | n/a | unknown | none |
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579093703-realenhance-job_149cc163-03ef-4614-a2b5-71ef708cf162-1772578989035-v86om2jq1n8-canonical-1A-2.webp | gemini mode=block hardFail=false | No structural or architectural changes detected.; Camera viewpoint and perspective remain identical.; All walls, openings (window, door), ceiling, and floor are preserved.; Built-in recessed lights and power outlets are unchanged.; The room has been meaningfully staged as a bedroom while adhering to all structural constraints.; semantic_validator_failed: windows 3→3, doors 0→0, wall_drift 62.39%, openings +1/-0; masked_edge_failed: drift 43.06%, openings +0/-0 | 43.06 | 62.39 | 90.721 | n/a | published | none |

### job_66c66bcc-5019-4e02-8f2f-efac866585d9
- Stage 1B completed: yes
- Attempts per job: 3
- Retry count: 2

| Attempt | Image URL | Blocking validator | Failure reason(s) | Masked Drift | Wall Drift | Deviation | Structural degree | Final decision | Direct hardfail source |
|---:|---|---|---|---:|---:|---:|---:|---|---|
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579014346-realenhance-job_66c66bcc-5019-4e02-8f2f-efac866585d9-1772578989571-cictp6zh81r-canonical-1A-2.webp | n/a | none logged | n/a | n/a | n/a | n/a | unknown | none |
| 2 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579071635-realenhance-job_66c66bcc-5019-4e02-8f2f-efac866585d9-1772578989571-cictp6zh81r-canonical-1A-2-retry1.webp | gemini mode=block hardFail=true | Perceptual diff failed: SSIM 0.277 < 0.97; Gemini structure: All architectural elements including walls, ceiling, floor, windows, and the existing ceiling light fixture remain identical in position, size, and form., The curtain systems (rods and drapes) are preserved exactly as in the BEFORE image., No camera shift, perspective change, or envelope geometry drift is detected., The room has been appropriately staged as a bedroom, adding suitable furniture without altering the underlying structure or blocking openings.; stage2_direct_hardfail: anchor_fixed_lighting_changed; semantic_validator_failed: windows 4→2, doors 0→0, wall_drift 44.52%, openings +1/-0; masked_edge_failed: drift 20.69%, openings +1/-0 | 20.69 | 44.52 | n/a | n/a | blocked | anchor_fixed_lighting_changed |
| 3 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579143656-realenhance-job_66c66bcc-5019-4e02-8f2f-efac866585d9-1772578989571-cictp6zh81r-canonical-1A-2-retry2.webp | gemini mode=block hardFail=true | none logged | n/a | n/a | 9.01 | 9.01 | unknown | none |

### job_f6a3bc83-9003-4a4c-abaf-b43fed9bba41
- Stage 1B completed: yes
- Attempts per job: 4
- Retry count: 3

| Attempt | Image URL | Blocking validator | Failure reason(s) | Masked Drift | Wall Drift | Deviation | Structural degree | Final decision | Direct hardfail source |
|---:|---|---|---|---:|---:|---:|---:|---|---|
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579017620-realenhance-job_f6a3bc83-9003-4a4c-abaf-b43fed9bba41-1772578988126-didf9qehkys-canonical-1A-2.webp | gemini mode=block hardFail=false | unknown; semantic_validator_failed: windows 6→6, doors 0→0, wall_drift 54.25%, openings +1/-0; masked_edge_failed: drift 71.94%, openings +1/-0 | 71.94 | 54.25 | n/a | n/a | needs_confirm_or_failed | none |
| 2 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579097917-realenhance-job_f6a3bc83-9003-4a4c-abaf-b43fed9bba41-1772578988126-didf9qehkys-canonical-1A-2-retry1.webp | gemini mode=block hardFail=true | Perceptual diff failed: SSIM 0.536 < 0.97; Gemini structure: The room has been appropriately staged with furniture suitable for a bedroom., All architectural elements including walls, windows, doors, ceiling, floor, and built-in wardrobe remain unchanged in position, size, and form., There are no structural changes or camera shifts detected., Ceiling fixtures (downlights) are preserved., The built-in mirrored wardrobe maintains its exact footprint and silhouette.; semantic_validator_failed: windows 0→1, doors 0→0, wall_drift 38.04%, openings +1/-0; masked_edge_failed: drift 58.43%, openings +1/-0 | 58.43 | 38.04 | 90.721 | n/a | needs_confirm_or_failed | none |
| 3 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579167456-realenhance-job_f6a3bc83-9003-4a4c-abaf-b43fed9bba41-1772578988126-didf9qehkys-canonical-1A-2-retry2.webp | gemini mode=block hardFail=false | unknown; semantic_validator_failed: windows 4→3, doors 0→0, wall_drift 53.09%, openings +1/-0; masked_edge_failed: drift 18.67%, openings +1/-0; semantic_validator_failed: windows 0→0, doors 0→0, wall_drift 30.24%, openings +0/-0; masked_edge_failed: drift 47.70%, openings +1/-0 | 47.7 | 30.24 | n/a | n/a | needs_confirm_or_failed | none |
| 3 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579237885-realenhance-job_f6a3bc83-9003-4a4c-abaf-b43fed9bba41-1772578988126-didf9qehkys-canonical-1A-2-retry2.webp | gemini mode=block hardFail=false | unknown; semantic_validator_failed: windows 0→0, doors 0→0, wall_drift 30.24%, openings +0/-0; masked_edge_failed: drift 47.70%, openings +1/-0 | 47.7 | 30.24 | 81.073 | n/a | published | none |

### job_bb06eb07-8974-4c10-8022-58523ad69cc8
- Stage 1B completed: yes
- Attempts per job: 2
- Retry count: 1

| Attempt | Image URL | Blocking validator | Failure reason(s) | Masked Drift | Wall Drift | Deviation | Structural degree | Final decision | Direct hardfail source |
|---:|---|---|---|---:|---:|---:|---:|---|---|
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579014025-realenhance-job_bb06eb07-8974-4c10-8022-58523ad69cc8-1772578987274-rh1z8gdkg7a-canonical-1A-2.webp | n/a | none logged | n/a | n/a | n/a | n/a | unknown | none |
| 1 | https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772579087851-realenhance-job_bb06eb07-8974-4c10-8022-58523ad69cc8-1772578987274-rh1z8gdkg7a-canonical-1A-2.webp | n/a | none logged | n/a | n/a | 63.968 | n/a | published | none |

## Batch 2

### job_260202ff-6e04-4652-82da-d498e9fe3c41
- Stage 1B completed: yes
- Attempts per job: 0
- Retry count: 0
- No Stage 2 image URL was published in this log window.
- Observed Stage 2 attempts: [1]
- Blocking validator: Gemini semantic validator in block mode (hardFail events observed: yes)
- Failure reason sample: 2026-03-03T23:11:56.425973501Z [inf]  [LOCAL_VALIDATE] stage=2 status=needs_confirm reasons=["Perceptual diff failed: SSIM 0.762 < 0.97","Gemini structure: The interior plumbing fixture (kitchen island faucet) has been replaced with a different style and color, which constitutes a 'reshaped' or 'modified' fixture. This is an automatic hard failure under INTERIOR PLUMBING FIXTURES rules.","stage2_direct_hardfail: faucet_change confidence=1.000"]
- Local readings (latest seen): masked drift=30.79, wall drift=13.81, deviation=14.69, structural degree=14.69
- Direct hardfail source sample: 2026-03-03T23:11:56.425973501Z [inf]  [LOCAL_VALIDATE] stage=2 status=needs_confirm reasons=["Perceptual diff failed: SSIM 0.762 < 0.97","Gemini structure: The interior plumbing fixture (kitchen island faucet) has been replaced with a different style and color, which constitutes a 'reshaped' or 'modified' fixture. This is an automatic hard failure under INTERIOR PLUMBING FIXTURES rules.","stage2_direct_hardfail: faucet_change confidence=1.000"]

### job_24b02873-e94a-45a5-b3a5-ec6d9c137203
- Stage 1B completed: yes
- Attempts per job: 0
- Retry count: 0
- No Stage 2 image URL was published in this log window.
- Observed Stage 2 attempts: [1]
- Blocking validator: Gemini semantic validator in block mode (hardFail events observed: yes)
- Failure reason sample: 2026-03-03T23:11:52.578332723Z [inf]  [LOCAL_VALIDATE] stage=2 status=needs_confirm reasons=["Perceptual diff failed: SSIM 0.249 < 0.97","Gemini structure: A TV mount, considered a fixed structural element or built-in, was removed from the wall. This constitutes a change to the fixed architecture of the wall and violates the immutability of built-ins/anchor geometry in REFRESH_OR_DIRECT mode."]
- Local readings (latest seen): masked drift=13.23, wall drift=2.98, deviation=22.947, structural degree=None
- Direct hardfail source sample: 2026-03-03T23:11:52.686364233Z [inf]  [STAGE2_DIRECT_STRUCTURAL_CHECK] hardFail=true reasons=stage2_direct_hardfail: anchor_fixed_lighting_changed

### job_21140c7a-e28c-47b0-a402-24d36803c17c
- Stage 1B completed: yes
- Attempts per job: 0
- Retry count: 0
- No Stage 2 image URL was published in this log window.
- Observed Stage 2 attempts: [1]
- Blocking validator: Gemini semantic validator in block mode (hardFail events observed: yes)
- Failure reason sample: 2026-03-03T23:11:52.691705579Z [inf]  [LOCAL_VALIDATE] stage=2 status=needs_confirm reasons=["Perceptual diff failed: SSIM 0.154 < 0.97","stage2_direct_hardfail: anchor_fixed_lighting_changed","semantic_validator_failed: windows 1→2, doors 1→0, wall_drift 67.05%, openings +0/-1","masked_edge_failed: drift 71.99%, openings +0/-1"]
- Local readings (latest seen): masked drift=90.58, wall drift=70.51, deviation=139.243, structural degree=None
- Direct hardfail source sample: 2026-03-03T23:11:52.691705579Z [inf]  [LOCAL_VALIDATE] stage=2 status=needs_confirm reasons=["Perceptual diff failed: SSIM 0.154 < 0.97","stage2_direct_hardfail: anchor_fixed_lighting_changed","semantic_validator_failed: windows 1→2, doors 1→0, wall_drift 67.05%, openings +0/-1","masked_edge_failed: drift 71.99%, openings +0/-1"]
