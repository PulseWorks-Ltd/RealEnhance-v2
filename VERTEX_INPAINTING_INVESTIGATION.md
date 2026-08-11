# Vertex Mask-Constrained Inpainting — Investigation & Implementation Plan

**Status:** Investigation complete, no code written. Design/implementation intended for a **new branch** (working title: "Image Generation with Vertex Inpainting" — note git branch names can't contain spaces; suggested slug: `feature/vertex-mask-inpainting` or `image-generation-with-vertex-inpainting`).

**Origin:** Investigated 2026-08-11, on branch `testing-grok-imagine`, after a real Stage 2 failure where Grok's full-image generation removed a wall corner and extended a wall to fill the frame — a structural change that passed initial review. That failure (plus the broader difficulty of fully trusting prompt-only structural preservation) motivated exploring whether Vertex AI's mask-constrained inpainting could provide a **hard, physically-enforced** guarantee that structure outside a defined furniture-placement zone cannot be altered, instead of relying on prompts + post-hoc validators.

---

## 1. Where Stage 2 currently stands (context for whoever picks this up)

As of this session, on `testing-grok-imagine` (commits `faa8ba29` → `88c29e85`), Stage 2 uses:
- **Grok** (`grok-imagine-image-quality`) for full-image generation — no true inpainting mask; `worker/src/pipeline/stage2.ts`'s `stagingMaskBuffer` is only a **soft visual darkening overlay baked into the image pixels** as a prompt hint (Grok's edit API has no mask parameter). Nothing physically stops Grok from editing outside the "guided" region.
- Restored specialist validators (opening/fixture/floor/envelope) via `orchestrateSpecialistsWithRetry`, gated by `STAGE2_SPECIALIST_VALIDATORS` (default on).
- A corrective 2-image retry (`STAGE2_CORRECTIVE_RETRY`, default on) that, on a geometry-class structural failure on attempt 1, retries by editing the flawed candidate directly with the baseline as a reference image, instead of blind full regeneration.
- A strengthened Grok prompt (`STAGE2_PROMPT_GROK_NZ` in `stage2.ts`) with explicit wall-corner/room-boundary preservation language.

All of this is **prompt- and validator-based defense**, not a structural guarantee. This investigation is about whether inpainting can replace/reduce that defense with an actual constraint.

---

## 2. What already exists: `feature/vertex-secondary-inpainting-continuity`

A large (23,746 insertions, 62 files, ~97 commits), **currently-dormant/unmerged** branch. Its actual purpose is different from what we want to build: **multi-angle same-room consistency** — stage a "master" photo of a room normally, then stage other angles of the *same* room via Vertex inpainting constrained by a Gemini-generated occupancy mask, so furniture matches across angles.

**Not reachable in production today.** Gated behind: client must explicitly group photos with a shared `roomGroupId` (server-side, `server/src/routes/upload.ts`), specific env vars (`SECONDARY_CONTINUITY_PROVIDER=vertex`, `SECONDARY_CONTINUITY_RENDERER=imagen3`, `SECONDARY_CONTINUITY_PLANNER=gemini25pro`), and a **separate worker process** (`worker/src/vertexExperimentalWorker.ts`, identity `worker-vertex-experimental`) consuming its own BullMQ queue (`CONTINUITY_RENDER_QUEUE`). The normal worker explicitly refuses to render this inline (throws `secondary_continuity_routing_misconfigured` if misrouted). Architecturally isolated — nothing here conflicts with building something simpler alongside/after it.

**Validators are NOT relaxed for Vertex-inpainted output on this branch.** Confirmed by diffing and grepping all 7 structural validator files (`envelopeValidator.ts`, `fixtureValidator.ts`, `floorIntegrityValidator.ts`, `openingValidator.ts`, `openingPreservationValidator.ts`, `geminiSemanticValidator.ts`, `runValidation.ts`) against `main` — zero conditional branching on render provider anywhere. Every image, however rendered, goes through the identical full validator gauntlet. Worth remembering: the team that built the actual inpainting system didn't trust it enough to skip validation either.

Only one new dependency was added for this whole subsystem: `@google-cloud/storage`. Vertex Imagen itself is called via **raw REST** (`apiClient.request()`), not a typed SDK method — the `@google/genai` SDK doesn't expose reference-image editing. Auth is pure ADC (`GoogleGenAI({vertexai:true, project, location})`), service-account JSON written to disk at boot from `GOOGLE_APPLICATION_CREDENTIALS_JSON`. BullMQ is already a dependency on the main worker — no new queueing infra needed if we want it.

---

## 3. Vertex Imagen's exact input contract (hard-won — preserve this)

Discovered via ~97 commits of iteration and a dedicated 1,314-line brute-force contract-discovery script (`worker/src/scripts/vertex-imagen-contract-probe.ts` on the vertex branch, which fired ~25 named payload-shape candidates at the live endpoint and logged accept/reject).

- **Endpoint:** raw REST `POST projects/{project}/locations/{location}/publishers/google/models/{model}:predict`, called via `(ai as any).apiClient.request({ path, body, httpMethod: "POST" })`.
- **Model:** `imagen-3.0-capability-001` (the Imagen family that supports reference-image-based editing/inpainting).
- **Payload shape** (`buildVertexEditPredictPayload`, `worker/src/providers/vertex/imageRendererProvider.ts:641` on the vertex branch):
  ```json
  {
    "instances": [{
      "prompt": "...",
      "referenceImages": [
        { "referenceId": 1, "referenceType": "REFERENCE_TYPE_RAW", "referenceImage": { "bytesBase64Encoded": "...", "mimeType": "image/png" } },
        { "referenceId": 2, "referenceType": "REFERENCE_TYPE_MASK", "referenceImage": { ... },
          "maskImageConfig": { "maskMode": "MASK_MODE_USER_PROVIDED", "maskDilation": 0 } }
      ]
    }],
    "parameters": { "editMode": "EDIT_MODE_INPAINT_INSERTION", "numberOfImages": 1 }
  }
  ```
- **Source and mask are both entries in one `referenceImages` array** — not top-level `image`/`mask` fields. This was the single biggest source of rejected payload shapes.
- **`maskImageConfig.maskMode` must be exactly `"MASK_MODE_USER_PROVIDED"`** — tells Vertex the mask is caller-supplied rather than auto-inferred. This is the field that makes "you give us the mask" work at all.
- **Image encoding:** each `referenceImage` leaf is either `{ bytesBase64Encoded, mimeType }` (inline) or `{ gcsUri, mimeType }` (upload to GCS first) — independently choosable per image. MIME types: `image/png`, `image/jpeg`, `image/webp` only.
- **Aspect ratio is constrained** to exactly `{1:1, 4:3, 3:4, 16:9, 9:16}`. Arbitrary real-estate photo ratios must be padded (transparent extend via `sharp`) to the nearest supported ratio before the call, then the result cropped back to original dimensions after (`resolveNearestImagenAspectRatio`, `imageRendererProvider.ts:193`).
- **`parameters.editMode`:** `EDIT_MODE_INPAINT_INSERTION` (+ `maskDilation: 0`) is the strict mode — Vertex will not touch pixels outside the mask. This is the mode we want for a hard structural guarantee (`EDIT_MODE_DEFAULT` is looser).
- **Response:** `predictions[0].bytesBase64Encoded` (with `.image.bytesBase64Encoded` / `.image.imageBytes` as fallback shapes seen in the wild) + `mimeType` (defaults `image/png`).

---

## 4. Gemini occupancy-mask generation — what's proven, what's missing

`worker/src/continuity/geminiOccupancyMask.ts` (vertex branch, 5,483 lines) proves the core mechanic: **Gemini can output a literal mask image**, not just JSON/boxes. Its prompts (`buildOccupancyPrompt`, `buildOriginalExtractorPassPrompt`) explicitly instruct `"Output IMAGE ONLY... WHITE=editable... BLACK=protected"`, and the response is parsed as an inline image part (`findFirstInlineImagePart`), then binarized (`selectBinarizationCandidate`). This directly validates the "Gemini paints a white-shaded placement zone" idea.

**Not directly reusable as-is:** the production function (`generateGeminiOccupancyMask` → `runOriginalExtractorPass`) is hardcoded to require **two images** (an already-staged "master" + a "secondary" target angle) and projects furniture from one onto the other. It has no empty-room, single-image mode. A new prompt needs to be written for "here is one empty room photo, propose furniture-placement zones" — the *pattern* (image-output, WHITE/BLACK semantics) is reusable; the prompt content is not.

**No real semantic door/window/cabinetry/closet/tiled-wall exclusion exists today.** The closest thing, `worker/src/continuity/exclusionMask.ts`, is a crude non-AI heuristic: Laplacian edge-response thresholding + fixed border bands (2% side margins, 6% bottom band) — it protects "things near the frame edge or high-contrast," not "things that are semantically a door." It would miss a low-contrast mid-frame window and over-protect edge-adjacent plain walls. **This is a real gap versus what we want.** Recommended fix: don't rely on a downstream edge filter — ask Gemini to do the exclusion semantically, in the *same* vision call that produces the placement mask, since Gemini already understands what a door/window/cabinet looks like.

**Mask output format:** standalone binary grayscale PNG (0/255), not merged/baked into the source photo — this is the correct shape for Vertex's separate `REFERENCE_TYPE_MASK` entry.

**Directly reusable utilities (no continuity coupling):**
- `worker/src/continuity/maskValidation.ts` → `validateCompiledMask` — checks mask/image dimension match, strict binary integrity, non-empty, non-full-frame, and an "exclusion ate too much of the occupancy mask" guard. Generic, reusable as-is.
- `worker/src/continuity/maskCompiler.ts` → `applyExclusionMask` (line 225), `tinySemanticCleanup` (345), `removeTinyConnectedComponents` (628), `countConnectedComponents` (595), `findMaskBoundingBox` (63) — pure Buffer/geometry helpers, no master/secondary dependency.

---

## 5. Reuse map for the renderer (Vertex call itself)

- **High reuse — `worker/src/providers/vertex/imageRendererProvider.ts`:** `VertexImageRendererProvider.render()` (class at line 1563) and `buildVertexEditPredictPayload()` (line 641) already implement exactly the caller-supplied-mask contract needed. Can likely be called close to as-is via the `ImageRenderRequest`/`ImageRenderResponse` types in `worker/src/providers/types.ts` (lines 52-97), bypassing the planner entirely.
  - It also already contains a post-render **outside-mask drift validator** (`validateOutsideMaskDrift`, line 1466 — pixel-diff MAE + changed-pixel-ratio thresholds between input and output outside the mask). This is cheap, deterministic, and directly tests the actual invariant we care about ("did anything change where it wasn't supposed to"). **This is the piece to promote to the primary structural safety net**, replacing slow/costly Gemini-semantic validation for inpainted images (see §7).
- **Reuse as-is — `worker/src/providers/vertex/adc.ts`:** `getVertexGenAiClient()` / `getVertexProjectConfig()` — pure ADC setup, zero continuity coupling.
- **High reuse — `worker/src/providers/imageTransport.ts`:** `toVertexImagePayload()` (line 572, turns an image reference into the wire shape), `resolveImageSource()` (line 396), `ensureLocalImagePath()` (line 599) — generic transport helpers.
- **Reuse as-is — bootstrap files:** `worker/src/bootstrap/googleCredentials.ts`, `envValidation.ts`, `healthChecks.ts` — though `envValidation.ts`'s queue-name checks are continuity-queue-specific and should be dropped/adjusted for a new call path.
- **Do NOT reuse — `worker/src/providers/vertex/continuityRepairProvider.ts`:** its entire value-add (running its own Gemini planner, compiling a mask from a `PlacementPlan`) is precisely the machinery a Gemini/Grok-produced mask replaces. Call the renderer directly instead.

**Deployment simplification available:** the existing system needs a separate queue/worker because it's waiting on an async human "master approved" step. A single-image pipeline has no such wait — Vertex render can likely be called **synchronously, inline, inside the normal Stage 2 flow**. No new BullMQ queue or second worker service should be needed.

---

## 6. Proposed architecture (not yet built)

```
Stage 1A/1B output (empty room, structurally trusted)
        │
        ▼
[NEW] Gemini vision call: "propose furniture placement zones + explicitly exclude
       doors/windows/cabinetry/closets/tiled walls" → outputs a WHITE/BLACK mask image
       (pattern proven in geminiOccupancyMask.ts; prompt content is new)
        │
        ▼
[reuse] mask cleanup + validation
       (maskCompiler.ts utilities + maskValidation.ts's validateCompiledMask)
        │
        ▼
[reuse, near-verbatim] VertexImageRendererProvider.render()
       — EDIT_MODE_INPAINT_INSERTION, maskDilation: 0, aspect-ratio pad/crop
        │
        ▼
[reuse] validateOutsideMaskDrift — cheap deterministic structural safety net
        │
        ▼
Stage 2 output
```

**Open/unverified:**
- Whether **Grok** can produce a literal mask image the way Gemini does. Grok's `grokAnalyzeImages` (used in `region-detector.ts`) returns text/JSON, not an image; `grokImageEdit` edits an image but isn't a "describe regions as a mask" primitive. **Recommend starting the mask-generation step on Gemini** (proven path) and treating Grok-for-masking as an unverified stretch goal, not an assumption to build on.
- Mask quality/semantic correctness becomes the single point of failure once the render step is hard-constrained — a wrong mask (e.g. a sliver of window included) is a smaller, more contained failure than full-image drift, but not zero. Needs its own empirical testing pass (likely much shorter than the ~97-commit slog the continuity branch went through, since single-image mask generation is a simpler task than master→secondary projection).
- Blend seams at mask boundaries are a quality risk (not structural) — `maskDilation` tuning is the lever.
- Cost/latency: this is 2 AI calls minimum per image (Gemini mask + Vertex render) instead of 1 Grok call — not yet estimated against current per-image cost.
- Vertex GCP project/billing/quota setup needs confirming as production-ready (the vertex branch's health checks prove connectivity was achieved in testing, not that it's provisioned for production volume).

---

## 7. Validator strategy recommendation

Don't cut structural validation to zero — **replace the expensive kind with the cheap kind**. Today's opening/fixture/floor/envelope + Unified Gemini-semantic validators are slow, costly, and (as this whole session's debugging demonstrated) fragile in their own right. `validateOutsideMaskDrift` is fast, deterministic, and tests the actual invariant directly. Recommended target state for inpainted Stage 2 images: keep that single cheap check as the primary gate; specialist/Unified Gemini validators become optional spot-check/QA sampling rather than a blocking per-image gate.

---

## 8. Suggested phases for the new branch

1. Build the empty-room Gemini mask-generation prompt + call (new code, pattern borrowed from `geminiOccupancyMask.ts`), including semantic door/window/cabinetry/closet/tiled-wall exclusion in the same prompt.
2. Port the reusable mask cleanup/validation utilities (§4) and wire them together into a small new mask-compile function (much simpler than `compileDeterministicMask` — no master/secondary/planner concept).
3. Port `VertexImageRendererProvider`, `adc.ts`, `imageTransport.ts`, bootstrap files (§5) with continuity-specific bits stripped.
4. Wire a synchronous call into `stage2.ts` (or a new sibling module) behind an env flag (e.g. `STAGE2_RENDERER=vertex_inpaint`), so it can run side-by-side with the existing Grok path for comparison.
5. Port `validateOutsideMaskDrift` as the structural safety net; decide whether to keep specialist/Unified validators active in parallel (log-only) during the trial period to compare confidence.
6. Empirically test mask quality on a real sample of rooms across room types before trusting it broadly.

---

## Appendix: env vars / secrets referenced on the vertex branch (for provisioning)

`GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (default `us-central1`), `VERTEX_GCS_BUCKET` / `VERTEX_CONTINUITY_GCS_BUCKET`, `VERTEX_CONTINUITY_GCS_PREFIX`, `SECONDARY_CONTINUITY_RENDERER` (model select, default `imagen-3.0-capability-001`), `VERTEX_CONTINUITY_GUIDANCE_SCALE`, `VERTEX_IMAGEN_FLAT_REFERENCE_SCHEMA`, `VERTEX_IMAGEN_ASPECT_RATIO_NORMALIZATION`, `VERTEX_CONTINUITY_STRICT_INSERTION`, `VERTEX_CONTINUITY_OUTSIDE_MASK_MAX_MAE` / `_MAX_CHANGED_RATIO` / `_CHANGE_THRESHOLD`. Not all of these will be relevant to a simpler single-image version — re-audit against the ported code rather than copying wholesale.

New dependency needed: `@google-cloud/storage` (only if using GCS transport for large images — inline base64 may suffice for a single-worker synchronous design and could avoid this dependency entirely).
