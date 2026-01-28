# Validator Environment Variables - Quick Reference

## Production Configuration (Recommended)

For the worker service, set these environment variables:

```bash
# Local validators (OpenCV, stage-aware, unified validators)
LOCAL_VALIDATOR_MODE=log        # advisory only; no blocking

# Gemini confirmation gate (ONLY blocker)
GEMINI_VALIDATOR_MODE=block     # block on Gemini-confirmed fails

# Fail-open behavior if Gemini confirm errors
GEMINI_CONFIRM_FAIL_OPEN=1      # default fail-open (set 0 to fail-closed)

# OpenCV structural validator configuration (still advisory)
STRUCTURE_VALIDATOR_URL=https://your-opencv-validator.railway.app
STRUCTURE_VALIDATOR_SENSITIVITY=5.0
```

## All Available Variables

| Variable | Default | Values | Description |
|----------|---------|--------|-------------|
| `LOCAL_VALIDATOR_MODE` | `log` | `log`, `block` | Local validators advisory-only; `block` means "needs Gemini confirm" (never hard-block locally) |
| `GEMINI_VALIDATOR_MODE` | `block` | `log`, `block` | Gemini confirm gating; only blocker when set to `block` |
| `GEMINI_CONFIRM_FAIL_OPEN` | `1` | `0`, `1` | When Gemini confirm errors: `1` = allow, `0` = block |
| `STRUCTURE_VALIDATOR_URL` | (none) | URL | OpenCV microservice endpoint (advisory) |
| `STRUCTURE_VALIDATOR_SENSITIVITY` | `5.0` | Number | Deviation threshold in degrees (higher = more permissive) |
| `STAGE1A_MIN_EDGE_IOU` | `0.65` | 0.0-1.0 | Edge IoU threshold for Stage 1A |
| `VALIDATOR_MODE`, `STRUCTURE_VALIDATOR_MODE`, `REALISM_VALIDATOR_MODE`, `STAGE1B_VALIDATION_MODE` | (deprecated) | legacy | Supported for backward compatibility; mapped to `LOCAL_VALIDATOR_MODE` / `GEMINI_VALIDATOR_MODE` with startup warnings |

## Mode Behavior

| Mode | Local Validators | Gemini Confirm | Blocks Images? | Use Case |
|------|------------------|----------------|----------------|----------|
| `log` | Run + log only | Optional (non-blocking) | ❌ No | Production advisory/telemetry |
| `block` | Run + mark needsConfirm | Runs; only blocker | ✅ Yes (Gemini-confirmed only) | Tighten+confirm flow |

## Configuration Precedence

New primary vars are `LOCAL_VALIDATOR_MODE` and `GEMINI_VALIDATOR_MODE`.
Legacy vars (`VALIDATOR_MODE`, `STRUCTURE_VALIDATOR_MODE`, `STAGE1B_VALIDATION_MODE`, `REALISM_VALIDATOR_MODE`) are still read for backward compatibility and will emit a startup warning. Defaults: local=`log`, gemini=`block`.

### Examples

```bash
# Gemini-only blocking (recommended)
LOCAL_VALIDATOR_MODE=log
GEMINI_VALIDATOR_MODE=block

# Fully advisory (no blocking anywhere)
LOCAL_VALIDATOR_MODE=log
GEMINI_VALIDATOR_MODE=log

# Force confirm on local risk (still Gemini-only blocking)
LOCAL_VALIDATOR_MODE=block
GEMINI_VALIDATOR_MODE=block
```

## Startup Verification

After setting variables, verify configuration in Railway worker logs:

```
[validator-config] Resolved modes: local=log gemini=block
[validator-config] Legacy env vars in play: VALIDATOR_MODE (if used)
[validator-config] Legacy env snapshot: {"VALIDATOR_MODE":"log",...}
```

## Common Configurations

### Gemini-only Blocking (current)
```bash
LOCAL_VALIDATOR_MODE=log
GEMINI_VALIDATOR_MODE=block
```

### Fully Advisory (no blocking)
```bash
LOCAL_VALIDATOR_MODE=log
GEMINI_VALIDATOR_MODE=log
```

### Local Risk → Gemini Confirm
```bash
LOCAL_VALIDATOR_MODE=block
GEMINI_VALIDATOR_MODE=block
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
