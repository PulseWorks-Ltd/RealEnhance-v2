# Stage 1A blown-out window guard fixtures

Each folder: `before_gemini.webp` (the image sent to Gemini) and `gemini_output.webp` (Gemini's Stage 1A
output; "Enhance Exterior Outlook" on, gemini-3.1-flash-image at 2K). Used by
worker/tests/stage1ABlownWindowGuard.test.ts.

- Bedroom_14_invented / _oldprompt — both windows blown out (plain white, blinds on the left);
  Gemini painted sky, fence, roofs and trees into them. Should be detected and repaired.
- Bedroom_05_real_view, Living_07_real_view, Bedroom_11_real_view — real views through the glass;
  only the sky turned blue (gemini_output here is the finished Stage 1A image). Should be left alone.
