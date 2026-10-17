# Stage 1A blown-out window guard fixtures

Each folder: `before_gemini.webp` (the image sent to Gemini) and `gemini_output.webp` (Gemini's Stage 1A
output; "Enhance Exterior Outlook" on, gemini-3.1-flash-image at 2K). Used by
worker/tests/stage1ABlownWindowGuard.test.ts.

- Bedroom_14_invented / _oldprompt — both windows blown out (plain white, blinds on the left);
  Gemini painted sky, fence, roofs and trees into them. Should be detected and repaired.
- Bedroom_05_real_view, Living_07_real_view, Bedroom_11_real_view — real views through the glass;
  only the sky turned blue (gemini_output here is the finished Stage 1A image). Should be left alone.
- Living_trimmed_hedge — production, Oct 2026: the big window showed only shrubs above the fence (no
  sky); Gemini cut the shrubs down and painted blue sky. Before is the canonical image (2048x1494),
  Gemini returned 4:3, so the two don't line up pixel for pixel. Used by the invented-sky guard
  (vegetation -> sky): should be detected and the shrubs put back.
