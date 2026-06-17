# Specialist Validator Review Package

## Scope
- Total rows: 5
- Batches: client-batch-1779874978753-98968a98-574e-4e07-882f-e9f8f5f4b877, kaipuke-stage2-validators-1774360443942
- Sources: logs.1779875931772.json, kaipuke-stage2-validators-1774360443942.json

## Notes
- This package is data-only. No validation code or thresholds were modified.
- Fields not present in source artifacts are emitted as empty values.

## Escaped Specialist Failures (fail + published=true)
- Count: 1

## Confidence Bands
### opening
- 0.00-0.30: 0
- 0.30-0.50: 0
- 0.50-0.70: 1
- 0.70-0.80: 0
- 0.80-0.90: 0
- 0.90-1.00: 3

### envelope
- 0.00-0.30: 0
- 0.30-0.50: 0
- 0.50-0.70: 0
- 0.70-0.80: 0
- 0.80-0.90: 0
- 0.90-1.00: 4

### flooring
- 0.00-0.30: 0
- 0.30-0.50: 0
- 0.50-0.70: 0
- 0.70-0.80: 0
- 0.80-0.90: 0
- 0.90-1.00: 4

### fixture
- 0.00-0.30: 0
- 0.30-0.50: 0
- 0.50-0.70: 0
- 0.70-0.80: 0
- 0.80-0.90: 0
- 0.90-1.00: 5

## Threshold Simulation (Additional Images)
- opening | Current Threshold | threshold=0.9 | additional=2 | deltaVsCurrent=0
- opening | Alternative Threshold A | threshold=0.85 | additional=2 | deltaVsCurrent=0
- opening | Alternative Threshold B | threshold=0.8 | additional=2 | deltaVsCurrent=0
- opening | Alternative Threshold C | threshold=0.75 | additional=2 | deltaVsCurrent=0
- envelope | Current Threshold | threshold=n/a | additional=0 | deltaVsCurrent=0
- envelope | Alternative Threshold A | threshold=0.85 | additional=4 | deltaVsCurrent=4
- envelope | Alternative Threshold B | threshold=0.8 | additional=4 | deltaVsCurrent=4
- envelope | Alternative Threshold C | threshold=0.75 | additional=4 | deltaVsCurrent=4
- flooring | Current Threshold | threshold=0.9 | additional=4 | deltaVsCurrent=0
- flooring | Alternative Threshold A | threshold=0.85 | additional=4 | deltaVsCurrent=0
- flooring | Alternative Threshold B | threshold=0.8 | additional=4 | deltaVsCurrent=0
- flooring | Alternative Threshold C | threshold=0.75 | additional=4 | deltaVsCurrent=0
- fixture | Current Threshold | threshold=0.9 | additional=5 | deltaVsCurrent=0
- fixture | Alternative Threshold A | threshold=0.85 | additional=5 | deltaVsCurrent=0
- fixture | Alternative Threshold B | threshold=0.8 | additional=5 | deltaVsCurrent=0
- fixture | Alternative Threshold C | threshold=0.75 | additional=5 | deltaVsCurrent=0
