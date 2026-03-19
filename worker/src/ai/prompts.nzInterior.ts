export function buildStage1AInteriorPromptNZStandard(roomType: string): string {
  return `REALENHANCE — STAGE 1A INTERIOR ENHANCEMENT (NZ HIGH-END)

TASK
Perform a professional real estate photometric enhancement inspired by flambient techniques.
This is a light-balancing operation only.

Treat the input image as a fixed visual record of the scene.
Do NOT generate, reconstruct, or reinterpret any part of the image.

---

I. PIXEL IDENTITY & NON-GENERATION LOCK (ABSOLUTE)

FIXED IMAGE PRINCIPLE
Treat the input as a fixed pixel-based representation of reality.
You must not reinterpret, re-segment, or re-estimate the scene.

NO NEW INFORMATION
All visible detail in the output must come directly from the input image.
Do NOT introduce, reconstruct, or infer any new visual information.

NO RESYNTHESIS
Do NOT:

* inpaint or fill missing regions
* reconstruct blown or dark areas
* generate detail where none exists
* replace regions with synthetic content

EDGE & STRUCTURE PRESERVATION
All edges, boundaries, and silhouettes must remain in the exact same positions.
Do NOT:

* shift edges
* soften or blur boundaries
* reshape transitions to simulate lighting

---

II. OPENING STATE & GEOMETRY LOCK (ABSOLUTE)

STATE PRESERVATION
All doors, windows, and openings must remain exactly as they appear.

* Closed doors remain closed
* Open doors remain open
* Ambiguous openings must remain unchanged

NO STATE INTERPRETATION
Do not reinterpret unclear geometry or “improve” visibility of openings.

APERTURE FIXITY
Do NOT alter:

* size
* shape
* visible area
* depth or perceived depth

Do not convert flat surfaces into openings or add voids.

---

III. EXTERIOR & OCCLUSION LOCK (STRICT)

NO EXTERIOR RECONSTRUCTION
Enhance visibility ONLY where real pixel detail exists.

If an exterior view is:

* blown out
* overexposed
* obscured

It must remain visually consistent with the input.

Do NOT:

* add sky, clouds, or foliage
* reconstruct outdoor scenes
* change exterior content or color

NO OCCLUSION REVEAL
Do not reveal anything hidden in shadows or blocked regions.

If an area is non-informative in the input, it must remain non-informative.

NO LIGHT BLEED
Window highlights must not bleed into surrounding surfaces.
Architectural boundaries must remain crisp.

---

IV. PHOTOMETRIC ADJUSTMENTS ONLY

PERMITTED OPERATIONS
You may adjust:

* exposure
* brightness
* contrast
* white balance
* tonal distribution

These adjustments must act on existing visible pixels only.

WHITE BALANCE
Target neutral daylight (“Gallery White” ~5500K).
Remove color casts without making the image sterile or altering exterior tones.

DEPTH PRESERVATION
Maintain natural light fall-off and shadow structure to preserve 3D depth.

BLACK POINT
Maintain deep, rich blacks in shadow areas.
Avoid lifting shadows to the point where depth or realism is lost.

TEXTURE PRESERVATION
Preserve all material detail, including:

* timber grain
* stone texture
* fabric weave

Do NOT flatten, smooth, or “white-over” surfaces.

---

V. STRUCTURAL INTEGRITY (NON-NEGOTIABLE)

NO GEOMETRIC CHANGE
Do NOT:

* warp
* rotate
* straighten
* reframe
* alter perspective

Camera position and composition must remain identical.

NO CONTENT CHANGE
Do NOT:

* add, remove, or move objects
* declutter or tidy
* perform staging or styling

Everything must remain exactly as it is.

---

FINAL PRINCIPLE

This is a photometric correction, not an image transformation.

If a detail is not clearly present in the input image,
it must not appear in the output.

---

OUTPUT
Return only the enhanced image.`.trim();
}

export function buildStage1AInteriorPromptNZHighEnd(roomType: string): string {
  // Keep high-end mode on the same structural-safe Pro-Camera directive for consistency.
  return buildStage1AInteriorPromptNZStandard(roomType);
}
