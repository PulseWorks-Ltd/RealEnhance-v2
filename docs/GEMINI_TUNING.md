# Gemini Tuning (Worker)

This document explains how to tune Gemini sampling and declutter intensity at runtime without redeploys.

## Runtime config file (preferred)

- Path (default): `worker/gemini.config.json`
- Override path with env: `GEMINI_CONFIG_PATH=/absolute/or/relative/path.json`

Example `gemini.config.json`:

```
{
  "sampling": {
    "interior": {
      "enhance": { "temperature": 0.6, "topP": 0.9, "topK": 40 },
      "declutter": { "temperature": 0.45, "topP": 0.8, "topK": 40 }
    },
    "exterior": {
      "enhance": { "temperature": 0.4, "topP": 0.8, "topK": 40 },
      "declutter": { "temperature": 0.35, "topP": 0.75, "topK": 40 }
    },
    "default": { "temperature": 0.5, "topP": 0.85, "topK": 40 }
  },
  "declutterIntensity": "standard",
  "declutterIntensityByScene": {
    "interior": "standard",
    "exterior": "light"
  }
}
```

Notes:
- Precedence: explicit API options > config file > env vars > built-in defaults.
- The worker re-reads the file frequently; changes take effect without redeploy or restart (up to ~1s delay).

## Env vars (fallback)

Global:
- `GEMINI_TEMP`, `GEMINI_TOP_P` (or `GEMINI_TOPP`), `GEMINI_TOP_K`

Per-scene:
- Interior: `GEMINI_TEMP_INTERIOR`, `GEMINI_TOP_P_INTERIOR` (or `GEMINI_TOPP_INTERIOR`), `GEMINI_TOP_K_INTERIOR`
- Exterior: `GEMINI_TEMP_EXTERIOR`, `GEMINI_TOP_P_EXTERIOR` (or `GEMINI_TOPP_EXTERIOR`), `GEMINI_TOP_K_EXTERIOR`

Declutter intensity (optional):
- `GEMINI_DECLUTTER_INTENSITY` = `light` | `standard` | `heavy`

## Defaults (when no overrides)

- Interior, enhance-only: temp 0.55, topP 0.85, topK 40
- Interior, declutter: temp 0.45, topP 0.80, topK 40
- Exterior, enhance-only: temp 0.40, topP 0.80, topK 40
- Exterior, declutter: temp 0.35, topP 0.75, topK 40
- `strictMode` nudges down variability (temp −0.15, topP −0.05, topK −5).

## Cleanup toggles (prompt hints)

- Stage 1A (enhance-only): exterior hardscape cleanup only (driveways/concrete/decks). Interior floor cleanup is disabled here.
- Stage 1B (declutter): interior floor cleanup enabled; exterior hardscape cleanup enabled.
