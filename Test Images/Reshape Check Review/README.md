# Reshape check review

Each sheet shows a baseline photo and a staged version blended 50/50.
**Doubled window, door or ceiling outlines = the room moved (reshaped).** Crisp single outlines = it lines up.
Red label = the checks say reshaped; green = ok. Numbers match `results.json`.

Made by `worker/src/scripts/reshape-check-pairs.ts` (no AI calls). Re-run after adding new pairs.

## Claude's eye review (79 pairs)

- 51 clearly reshaped, 20 clearly lined up, 8 unsure.
- Current rule (brightness-matched shape check > 15, or a clear camera zoom of 5%+): caught **all 51** reshaped, **2 false alarms**.

### False alarms (lined up, but flagged)

- #14 Bedroom (Baseline) / Bedroom 12-layoutguided-staged-v2.webp — framing 14, zoom 0.87
- #57 Bedroom (Staged 2) / Bedroom 16 (Enhanced).webp — framing 18.3, zoom 1

### Please confirm: reshaped or lined up?

- #1 Bedroom (Baseline) / Bedroom 02 - Staged 2.jpg — checks say **RESHAPED (early)** (framing 21, zoom 0.945)
- #61 Bedroom (Baseline) / Bedroom 12-anchor-only-staged-v2.webp — checks say **ok** (framing 13.6, zoom 1.02)
- #16 Bedroom (Baseline) / Bedroom 12-tierrebuild-staged.webp — checks say **RESHAPED (early)** (framing 12.6, zoom 1.065)
- #50 Living (Baseline) / Living 10-staged-v3.webp — checks say **RESHAPED (early)** (framing 13.8, zoom 1.105)
- #56 Bedroom (Staged 2) / Bedroom 05 (Enhanced).webp — checks say **RESHAPED (full check)** (framing 19.3, zoom 1.035)
- #58 Living (Baseline) / Diningroom 01-staged-v1.webp — checks say **RESHAPED (full check)** (framing 15.3, zoom 1)
- #59 Living (Baseline) / Living 07-staged-sharedpath.webp — checks say **RESHAPED (full check)** (framing 18, zoom 1.08)
- #60 Living (Baseline) / Living 10-staged-sharedpath.webp — checks say **RESHAPED (full check)** (framing 15.6, zoom 1)

## Owner's labels (ground truth)

Saved in `owner_labels.json`: only these are reshaped beyond what merging can save: 7, 11, 12, 13, 21, 24, 31, 33, 34, 39, 40, 41, 42, 44, 45, 46, 47, 48, 49, 50 (possibly 10). 15 and 17: shape fine, but furniture blocks doorways. Everything else is salvageable by merging.

Against these labels the current reshape rule catches 20/20 but wrongly rejects 39/58 salvageable photos: it measures how far the view moved, not whether the merged furniture still fits.
