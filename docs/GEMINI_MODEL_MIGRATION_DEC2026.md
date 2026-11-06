# Gemini model update (Google retires 2.5 Pro / 2.5 Flash on 1 Dec 2026)

Code defaults are set in `worker/src/ai/modelDefaults.ts`:

- **gemini-3.8-flash**: pass/fail image checks, layout planning, everything that used 2.5 Pro.
- **gemini-3.5-flash-lite**: simple detectors and first-pass checks (which escalate to 3.8 Flash).
- Text/JSON requests get at least 8,192 output tokens (`GEMINI_TEXT_MIN_OUTPUT_TOKENS`), so a
  model's "thinking" can't cut an answer off. Retiring model names are swapped automatically and
  logged as `[MODEL_RETIRED]` at worker start-up.

## Production checklist (do this when merging to `Testing/Enhance_Exterior_Outlook`)

Railway variables changed on the **test** environment, 6 Nov 2026. Make the same change in production:

| Variable | Set to |
|---|---|
| `STRUCTURAL_INVARIANT_MODEL` | `gemini-3.8-flash` |
| `OPENING_PRESERVATION_MODEL` | `gemini-3.8-flash` |
| `CONTINUITY_GEMINI_OCCUPANCY_MODEL` | `gemini-3.8-flash` (note: no code currently reads this variable, so it has no effect) |

After deploying, check the worker log: there should be no `[MODEL_RETIRED]` line. If there is,
it names any other variable still set to a retiring model and the value to use.
