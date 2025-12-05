# Validator Environment Variables - Quick Reference

## Production Configuration (Recommended)

For Railway worker service, set these environment variables:

```bash
# Enable log-only mode for all structural validators
VALIDATOR_MODE=log

# Optional: Explicitly set structure validator mode (inherits from VALIDATOR_MODE if not set)
STRUCTURE_VALIDATOR_MODE=log

# OpenCV structural validator configuration
STRUCTURE_VALIDATOR_URL=https://your-opencv-validator.railway.app
STRUCTURE_VALIDATOR_SENSITIVITY=5.0

# Keep realism validators disabled during log-only phase
# REALISM_VALIDATOR_MODE=off  # Optional, already disabled by default
```

## All Available Variables

| Variable | Default | Values | Description |
|----------|---------|--------|-------------|
| `VALIDATOR_MODE` | `off` | `off`, `log`, `retry`, `block` | Global default for all validators |
| `STRUCTURE_VALIDATOR_MODE` | (inherits) | `off`, `log`, `retry`, `block` | Overrides for structural validators |
| `REALISM_VALIDATOR_MODE` | (inherits) | `off`, `log`, `retry`, `block` | Overrides for Gemini realism validators |
| `STRUCTURE_VALIDATOR_URL` | (none) | URL | OpenCV microservice endpoint |
| `STRUCTURE_VALIDATOR_SENSITIVITY` | `5.0` | Number | Deviation threshold in degrees (higher = more permissive) |
| `STAGE1A_MIN_EDGE_IOU` | `0.65` | 0.0-1.0 | Edge IoU threshold for Stage 1A |

## Mode Behavior

| Mode | Validator Runs? | Logs Results? | Blocks Images? | Use Case |
|------|----------------|---------------|----------------|----------|
| `off` | ❌ No | ❌ No | ❌ No | Development, debugging |
| `log` | ✅ Yes | ✅ Yes | ❌ No | **Production metric collection** |
| `retry` | ✅ Yes | ✅ Yes | ⚠️ Triggers retry | Future: smart retries |
| `block` | ✅ Yes | ✅ Yes | ✅ Yes | Testing, strict QC |

## Configuration Precedence

The system resolves validator modes in this order:

1. **Kind-specific environment variable** (e.g., `STRUCTURE_VALIDATOR_MODE`)
2. **Global `VALIDATOR_MODE`**
3. **Default: `off`** (safe default)

### Examples

```bash
# Example 1: All validators in log mode
VALIDATOR_MODE=log
# Result: structure=log, realism=log (but realism is disabled in code)

# Example 2: Structure log, realism off
VALIDATOR_MODE=log
REALISM_VALIDATOR_MODE=off
# Result: structure=log, realism=off

# Example 3: Structure block, everything else off
STRUCTURE_VALIDATOR_MODE=block
# Result: structure=block, realism=off (global default)

# Example 4: Everything off (development)
VALIDATOR_MODE=off
# Result: structure=off, realism=off
```

## Startup Verification

After setting variables, verify configuration in Railway worker logs:

```
[validator-config] === Validator Configuration ===
[validator-config] VALIDATOR_MODE: log
[validator-config] STRUCTURE_VALIDATOR_MODE: (not set)
[validator-config] REALISM_VALIDATOR_MODE: (not set)
[validator-config] Resolved modes:
[validator-config]   - global: log
[validator-config]   - structure: log
[validator-config]   - realism: log
[validator-config] ================================
```

## Common Configurations

### Production (Current Phase: Metric Collection)
```bash
VALIDATOR_MODE=log
STRUCTURE_VALIDATOR_URL=https://opencv-validator.railway.app
STRUCTURE_VALIDATOR_SENSITIVITY=5.0
```

### Development (No Validation)
```bash
VALIDATOR_MODE=off
```

### Testing (Blocking Mode)
```bash
VALIDATOR_MODE=block
STRUCTURE_VALIDATOR_URL=http://localhost:8000
```

### Selective Blocking (Future Phase)
```bash
VALIDATOR_MODE=log
STRUCTURE_VALIDATOR_MODE=block  # Only structure validators block
```

## Troubleshooting

### Validators Not Running

**Symptom:** No `[validator:...]` logs

**Fix:**
```bash
# Ensure mode is not "off"
VALIDATOR_MODE=log
```

### OpenCV Validator Not Running

**Symptom:** No `[structureValidator]` logs

**Checks:**
1. Is `STRUCTURE_VALIDATOR_URL` set?
2. Is structural validator mode enabled?
3. Is Stage 2 running? (OpenCV only runs on Stage 2)

**Fix:**
```bash
STRUCTURE_VALIDATOR_MODE=log
STRUCTURE_VALIDATOR_URL=https://your-service.railway.app
```

### Images Being Blocked in Log Mode

**Symptom:** Jobs failing with validation errors

**This should NEVER happen!** If it does:

**Immediate Fix:**
```bash
# Disable all validators
VALIDATOR_MODE=off
```

**Then investigate:**
1. Check `STRUCTURE_VALIDATOR_MODE` is not `block`
2. Review code changes
3. Check for bugs in validator mode logic

## Related Documentation

- [VALIDATOR_LOG_ONLY_MODE.md](VALIDATOR_LOG_ONLY_MODE.md) - Complete usage guide
- [VALIDATOR_IMPLEMENTATION_SUMMARY.md](VALIDATOR_IMPLEMENTATION_SUMMARY.md) - Implementation details
- [STRUCTURAL_VALIDATOR.md](STRUCTURAL_VALIDATOR.md) - OpenCV validator documentation

## Quick Links

- **Set Railway Env Vars:** Railway Dashboard → Service → Variables
- **View Logs:** Railway Dashboard → Service → Deployments → View Logs
- **Search Logs:** Use Railway log search or `grep` patterns

---

**Last Updated:** 2024-12-05
