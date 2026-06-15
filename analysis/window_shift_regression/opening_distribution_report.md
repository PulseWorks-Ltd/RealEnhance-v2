# Opening Validator Distribution and Threshold Analysis

## Cohort Definition
- Change date split: 2026-06-01
- Pre successful sample size: 30 (from 335 successful jobs)
- Post successful sample size: 25 (from 25 successful jobs)
- Failed cohort size: 38

## Resize Distribution (pct)
| Cohort | n | min | median | mean | p75 | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Pre success | 7 | 26.300 | 53.400 | 57.700 | 79.500 | 92.500 | 92.500 | 92.500 |
| Post success | 5 | 27.400 | 30.900 | 43.300 | 51.200 | 68.120 | 73.760 | 79.400 |
| Failed | 8 | 26.600 | 76.700 | 69.987 | 98.000 | 98.180 | 98.390 | 98.600 |

## Relocation Proxy Distribution (pct)
| Cohort | n | min | median | mean | p75 | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Pre success | 0 |  |  |  |  |  |  |  |
| Post success | 24 | 0.000 | 0.000 | 23.333 | 50.000 | 85.000 | 100.000 | 100.000 |
| Failed | 3 | 0.000 | 50.000 | 41.667 | 62.500 | 70.000 | 72.500 | 75.000 |

## Outliers
- Outliers counted when resize or relocation proxy exceeds >20, >30, >40, >50.
- Outlier rows in sampled success cohorts: 18

## Failure Separation
- Resize success p95: 92.500
- Fraction of failed resize <= success p95 (overlap): 0.500
- Fraction of failed resize > success p95: 0.500
- Relocation success p95: 100.000
- Fraction of failed relocation <= success p95 (overlap): 1.000
- Fraction of failed relocation > success p95: 0.000

## Threshold Options
### Option A (Conservative)
- Resize threshold: 92.500
- Relocation proxy threshold: 100.000
- Rationale: Set threshold at successful p95 to minimize false positives; will miss moderate anomalies.

### Option B (Balanced)
- Resize threshold: 91.190
- Relocation proxy threshold: 85.000
- Rationale: Set threshold at successful p90 to improve sensitivity while keeping most successful edits unflagged.

### Option C (Aggressive)
- Resize threshold: 76.700
- Relocation proxy threshold: 50.000
- Rationale: Set threshold near failed median to catch more likely failures, with higher false-positive risk.

## Caveats
- Relocation value is a proxy from reason-token counts, not direct geometric displacement.
- Some logs emit limited structured opening metrics; samples are restricted to observed values.
