# Room brief vs anchor-locked planner

| Photo | Planner | OK | AI calls (by model) | Input tok | Output tok | Thinking tok | Seconds | Notes |
|---|---|---|---|---|---|---|---|---|
| Kitchen 01 | old (anchor-locked) | no | 2 (gemini-2.5-pro×2) | 0 | 0 | 0 | 61 | baseline_extraction_failed:ServerError: got status: 502 Bad Gateway. {"error":{"message":"exception parsing response","code":502,"status":"Bad Gateway"}} |
| Kitchen 01 | new (room brief) | yes | 1 (gemini-3.8-flash×1) | 2236 | 1228 | 610 | 19.8 |  |
| Kitchen 12 | old (anchor-locked) | no | 2 (gemini-2.5-pro×2) | 0 | 0 | 0 | 60.6 | baseline_extraction_failed:ServerError: got status: 502 Bad Gateway. {"error":{"message":"exception parsing response","code":502,"status":"Bad Gateway"}} |
| Kitchen 12 | new (room brief) | yes | 2 (gemini-3.8-flash×2) | 2238 | 1529 | 991 | 50.6 |  |
