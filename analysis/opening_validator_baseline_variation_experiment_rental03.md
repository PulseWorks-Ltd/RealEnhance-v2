# Opening Validator Baseline Variation Experiment (Rental 03)

Generated at: 2026-06-04T01:49:04.965Z

## Test A: Same Image Against Itself

Baseline image: /workspaces/RealEnhance-v2/worker/test-data/Rental 03.jpg
Comparison image: /workspaces/RealEnhance-v2/worker/test-data/Rental 03.jpg

| Baseline # | Verdict | Issue Type | Confidence | Matched | Missing | Additional | Reconciliation Score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 2 | PASS | opening_resized_minor | 0.870 | 4 | 0 | 0 | 1.000 |
| 3 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 4 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 5 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 6 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 7 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 8 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 9 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 10 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 11 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 12 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 13 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 14 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 15 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 16 | PASS | opening_resized_minor | 0.863 | 4 | 0 | 0 | 1.000 |
| 17 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 18 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 19 | PASS | opening_relocated | 0.600 | 4 | 0 | 0 | 1.000 |
| 20 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |

Summary:
- Total runs: 20
- PASS: 20
- FAIL: 0
- Verdict consistency rate: 1.0000
- Unique verdict count: 1
- Confidence mean: 0.6266
- Confidence variance: 0.0064
- Confidence std dev: 0.0800

## Test B: Known Good Stage 2 Output

Baseline image: /workspaces/RealEnhance-v2/worker/test-data/Rental 03.jpg
Comparison image: /workspaces/RealEnhance-v2/tmp/rental03-stage2-1780536305731.png

| Baseline # | Verdict | Issue Type | Confidence | Matched | Missing | Additional | Reconciliation Score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | FAIL | opening_removed | 0.905 | 3 | 1 | 0 | 0.750 |
| 2 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 3 | FAIL | opening_removed | 0.922 | 3 | 1 | 0 | 0.750 |
| 4 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 5 | FAIL | opening_removed | 0.943 | 3 | 1 | 0 | 0.750 |
| 6 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 7 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 8 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 9 | FAIL | opening_removed | 0.948 | 3 | 1 | 0 | 0.750 |
| 10 | FAIL | opening_removed | 0.922 | 3 | 1 | 0 | 0.750 |
| 11 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 12 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 13 | FAIL | opening_removed | 0.910 | 3 | 1 | 0 | 0.750 |
| 14 | FAIL | opening_removed | 0.923 | 3 | 1 | 0 | 0.750 |
| 15 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |
| 16 | FAIL | opening_removed | 0.930 | 3 | 1 | 0 | 0.750 |
| 17 | FAIL | opening_removed | 0.905 | 3 | 1 | 0 | 0.750 |
| 18 | FAIL | opening_removed | 0.930 | 3 | 1 | 0 | 0.750 |
| 19 | FAIL | opening_removed | 0.948 | 3 | 1 | 0 | 0.750 |
| 20 | PASS | opening_removed | 0.600 | 3 | 1 | 0 | 0.750 |

Summary:
- Total runs: 20
- PASS: 9
- FAIL: 11
- Verdict consistency rate: 0.5500
- Unique verdict count: 2
- Confidence mean: 0.7793
- Confidence variance: 0.0264
- Confidence std dev: 0.1626

## Test C: Known Opening Failure Fixture

Baseline image: /workspaces/RealEnhance-v2/worker/test-data/Rental 03.jpg
Comparison image: /workspaces/RealEnhance-v2/Test Images/Declutter Validator Testing/Rental 03 - Opening Covered.jpg

| Baseline # | Verdict | Issue Type | Confidence | Matched | Missing | Additional | Reconciliation Score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 2 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 3 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 4 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 5 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 6 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 7 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 8 | PASS | opening_anomaly | 0.788 | 4 | 0 | 0 | 1.000 |
| 9 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 10 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 11 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 12 | PASS | opening_anomaly | 0.813 | 4 | 0 | 0 | 1.000 |
| 13 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 14 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 15 | PASS | opening_anomaly | 0.825 | 4 | 0 | 0 | 1.000 |
| 16 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 17 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 18 | PASS | opening_resized_minor | 0.825 | 4 | 0 | 0 | 1.000 |
| 19 | PASS | opening_anomaly | 0.600 | 4 | 0 | 0 | 1.000 |
| 20 | PASS | opening_anomaly | 0.800 | 4 | 0 | 0 | 1.000 |

Summary:
- Total runs: 20
- PASS: 20
- FAIL: 0
- Verdict consistency rate: 1.0000
- Unique verdict count: 1
- Confidence mean: 0.6525
- Confidence variance: 0.0083
- Confidence std dev: 0.0913

## Final Answers

A. Did baseline variation change Opening Validator verdicts? Yes
B. Did baseline stabilization appear necessary to achieve consistent outcomes? Yes
C. Confidence variance by test: A=0.0064, B=0.0264, C=0.0083
D. Estimated latency contributing to outcome improvements: 13189.66 ms (instability rate=0.1500, benchmark avg latency=87931.05 ms)

