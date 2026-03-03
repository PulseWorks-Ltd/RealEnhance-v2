# Stage 2 Attempt Trace (logs.1772536741636.log)

Total jobs: 7 | Total attempts: 15

## job_09284be0-8506-4d35-ba9b-a4dc4001171d
- attempts_per_job: 1
- retry_count(final): 0
- final_decision: accept blockedBy=None
- attempt 1: blocker=anchor_region masked=60.56 wall=46.97 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536520004-realenhance-job_09284be0-8506-4d35-ba9b-a4dc4001171d-1772536432484-xgjj5m44aj-canonical-1A-2.webp
  - reasons: A curtain system, including a curtain rod and drapes, has been added to the window on the right. According to the decision rules, 'Curtain system addition' is a structural hard-fail condition. | anchor:island_changed

## job_35d85bd3-18f4-4c69-9f3f-abe2bd446fd8
- attempts_per_job: 1
- retry_count(final): 0
- final_decision: accept blockedBy=None
- attempt 1: blocker=anchor_region masked=45.56 wall=52.36 deg=None direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536518026-realenhance-job_35d85bd3-18f4-4c69-9f3f-abe2bd446fd8-1772536433351-fgdsv9snb6k-canonical-1A-2.webp
  - reasons: furniture_change | anchor:island_changed

## job_4ac47cff-16d2-4087-95a2-0be4976e3949
- attempts_per_job: 3
- retry_count(final): 2
- final_decision: fallback blockedBy=opening_preservation
- attempt 1: blocker=anchor_region masked=69.14 wall=71.15 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536466851-realenhance-job_4ac47cff-16d2-4087-95a2-0be4976e3949-1772536431629-m6pqxbr68hs-canonical-1A-2.webp
  - reasons: The room has been appropriately staged with furniture suitable for a bedroom. | No structural elements (walls, ceiling, floor, windows, doors, existing ceiling lights) have been altered.
- attempt 2: blocker=anchor_region masked=44.43 wall=63.76 deg=None direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536529159-realenhance-job_4ac47cff-16d2-4087-95a2-0be4976e3949-1772536431629-m6pqxbr68hs-canonical-1A-2-retry1.webp
  - reasons: unknown | anchor:island_changed
- attempt 3: blocker=anchor_region masked=37.71 wall=66.12 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536606560-realenhance-job_4ac47cff-16d2-4087-95a2-0be4976e3949-1772536431629-m6pqxbr68hs-canonical-1A-2-retry2.webp
  - reasons: structure | anchor:island_changed

## job_4d9505b4-e6ee-4398-8562-401c39356075
- attempts_per_job: 3
- retry_count(final): 2
- final_decision: fallback blockedBy=opening_preservation
- attempt 1: blocker=stage2_direct_hardfail masked=37.77 wall=31.68 deg=0.0 direct=None/anchor_fixed_lighting_changed
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536462225-realenhance-job_4d9505b4-e6ee-4398-8562-401c39356075-1772536434426-qi7znqharxs-canonical-1A-2.webp
  - reasons: Perceptual diff failed: SSIM 0.601 < 0.97 | stage2_direct_hardfail: anchor_fixed_lighting_changed
- attempt 2: blocker=anchor_region masked=4.39 wall=45.32 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536537368-realenhance-job_4d9505b4-e6ee-4398-8562-401c39356075-1772536434426-qi7znqharxs-canonical-1A-2-retry1.webp
  - reasons: style_only | anchor:island_changed
- attempt 3: blocker=anchor_region masked=33.78 wall=50.23 deg=0.0 direct=anchor/anchor_fixed_lighting_changed
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536587907-realenhance-job_4d9505b4-e6ee-4398-8562-401c39356075-1772536434426-qi7znqharxs-canonical-1A-2-retry2.webp
  - reasons: unknown | anchor:island_changed

## job_77f8133c-5151-4815-bd40-918d0529980e
- attempts_per_job: 3
- retry_count(final): 2
- final_decision: fallback blockedBy=opening_preservation
- attempt 1: blocker=masked_edge masked=35.89 wall=29.36 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536460854-realenhance-job_77f8133c-5151-4815-bd40-918d0529980e-1772536435095-s7lap6fsqlo-canonical-1A-2.webp
  - reasons: Perceptual diff failed: SSIM 0.655 < 0.97 | Gemini structure: A curtain system has been added to the main window (sheer curtains), which is a structural identity change and a hard-fail condition.
- attempt 2: blocker=anchor_region masked=35.27 wall=23.36 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536525926-realenhance-job_77f8133c-5151-4815-bd40-918d0529980e-1772536435095-s7lap6fsqlo-canonical-1A-2-retry1.webp
  - reasons: furniture_change | anchor:island_changed
- attempt 3: blocker=anchor_region masked=50.0 wall=21.91 deg=0.0 direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536587753-realenhance-job_77f8133c-5151-4815-bd40-918d0529980e-1772536435095-s7lap6fsqlo-canonical-1A-2-retry2.webp
  - reasons: The window blinds have been changed from roller blinds to slatted blinds. This constitutes a change in the 'curtain system' which is a structural hard-fail condition. | anchor:island_changed

## job_a786b599-ec1c-4b96-a029-b12083bff084
- attempts_per_job: 3
- retry_count(final): 2
- final_decision: fallback blockedBy=opening_preservation
- attempt 1: blocker=opening_preservation masked=73.64 wall=69.92 deg=None direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536461132-realenhance-job_a786b599-ec1c-4b96-a029-b12083bff084-1772536436501-23sfz6rblvp-canonical-1A-2.webp
- attempt 2: blocker=anchor_region masked=46.26 wall=34.68 deg=None direct=None/None
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536520187-realenhance-job_a786b599-ec1c-4b96-a029-b12083bff084-1772536436501-23sfz6rblvp-canonical-1A-2-retry1.webp
  - reasons: Suitable staged furniture has been introduced, transforming the empty room into a bedroom. | All architectural elements including walls, windows, ceiling, floor, and the existing light fixture remain immutable.
- attempt 3: blocker=stage2_direct_hardfail masked=58.75 wall=66.69 deg=0.0 direct=anchor/anchor_fixed_lighting_changed
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536584859-realenhance-job_a786b599-ec1c-4b96-a029-b12083bff084-1772536436501-23sfz6rblvp-canonical-1A-2-retry2.webp
  - reasons: Perceptual diff failed: SSIM 0.154 < 0.97 | Gemini structure: The core architectural elements including walls, windows, and ceiling structure remain unchanged., The existing ceiling light fixture, curtain rods, and curtains are perfectly preserved., There is no detectable camera shift, and the geometric envelope of the room is identical between BEFORE and AFTER., The room has been appropriately staged as a bedroom, introducing suitable staged furniture while preserving all fixed architecture and built-ins.

## job_c8ec53c4-dece-47f1-be28-107f385eef4f
- attempts_per_job: 1
- retry_count(final): 0
- final_decision: accept blockedBy=None
- attempt 1: blocker=stage2_direct_hardfail masked=100.0 wall=13.22 deg=0.0 direct=anchor/anchor_fixed_lighting_changed
  - url: https://realenhance-bucket.s3.ap-southeast-2.amazonaws.com/realenhance/outputs/1772536526380-realenhance-job_c8ec53c4-dece-47f1-be28-107f385eef4f-1772536435769-yvlgs2ix6ek-canonical-1A-2.webp
  - reasons: Perceptual diff failed: SSIM 0.630 < 0.97 | stage2_direct_hardfail: anchor_fixed_lighting_changed
