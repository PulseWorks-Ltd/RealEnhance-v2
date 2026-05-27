# Validator Authority Model

This document defines the authority and veto model for opening validator decisions.
It is normative for the decision object emitted by `runOpeningValidator`.

## Purpose

The validator now combines deterministic structural analysis, semantic corroboration, and advisory context. Without explicit policy boundaries, future changes can accidentally weaken deterministic guarantees.

This model prevents that drift by defining:
- Authority classes
- Veto semantics
- Deterministic supremacy rules
- Semantic corroboration limits
- Central invariants that must hold at runtime

## Decision Contract

`OpeningValidatorDecision` includes:
- `decision`: `pass | advisory | hard_fail`
- `authorityClass`: `CLASS_A | CLASS_B | CLASS_C | CLASS_D`
- `authority`: source authority key
- `vetoable`: whether this authority can be vetoed
- `signals`: normalized decision evidence tokens
- `decisionTrace`: ordered causal trace IDs
- `trace`: alias of `decisionTrace`
- `semanticCorroborated`: whether semantic corroboration contributed
- `vetoed`: whether a veto was applied

## Authority Classes

### CLASS_A
- Highest authority for deterministic structural breaks.
- Non-vetoable.
- Deterministic-origin only.
- Hard-fail authority is allowed.

Current authorities:
- `deterministic_added_opening`
- `deterministic_opening_break`
- `deterministic_hard_fail`

### CLASS_B
- Corroborated hard-fail path that includes semantic micro-check confirmation.
- Non-vetoable.
- Hard-fail authority is allowed.

Current authority:
- `light_anchor_corroborated`

### CLASS_C
- Advisory authority.
- Vetoable.
- Semantic/advisory only.
- Cannot hard-fail.

Current authorities:
- `added_opening_advisory`
- `advisory`

### CLASS_D
- Preservation/pass authority.
- Vetoable.
- Semantic/advisory only.
- Never hard-fail authority.

Current authority:
- `preserved`

## Deterministic Supremacy

Rules:
1. Deterministic structural hard-fail signals remain the top-level source of truth.
2. Semantic checks may corroborate deterministic conclusions.
3. Semantic checks must not silently promote advisory classes into hard-fail classes.
4. Any hard-fail output must come from an authority policy that explicitly allows hard-fail.

## Corroboration Limits

Semantic corroboration is bounded:
- It can reinforce deterministic risk assessment.
- It cannot bypass class policy constraints.
- It cannot convert CLASS_C or CLASS_D into hard-fail behavior.

## Veto Semantics

- `vetoed=true` is valid only for `vetoable=true` classes.
- CLASS_A and CLASS_B are non-vetoable.
- CLASS_C and CLASS_D are vetoable.

## Runtime Invariants

The decision builder enforces central runtime assertions:
1. CLASS_A must be non-vetoable.
2. CLASS_A must be deterministic-origin only.
3. CLASS_D must never produce hard-fail.
4. CLASS_D must remain semantic/advisory only.
5. Hard-fail can be emitted only by policies that allow hard-fail.
6. Veto cannot be applied to non-vetoable classes.

Invariant failures throw `OPENING_VALIDATOR_AUTHORITY_INVARIANT:*` errors.

## Decision Trace IDs

`decisionTrace` provides causal breadcrumbs for debugging and audits.
Trace IDs are stable, machine-readable event tokens.

Typical trace segments:
- `decision_trace_started`
- `deterministic_signal_detected`
- `opening_added_signal_detected`
- `authority_class_a_assigned`
- `semantic_corroboration_confirmed`
- `hard_fail_decision_selected`
- `veto_skipped_nonvetoable`

These traces complement authority metadata and make complex outcomes explainable without relying on implicit code-path inference.

## Change Control

When adding/changing authorities:
1. Update the central authority policy map in `openingValidator.ts`.
2. Keep invariants passing under all branches.
3. Add or update tests for class assignment and trace output.
4. Update this document in the same change.
