---
phase: 01-threshold-consent-brief-phase-0
plan: 01
subsystem: sdk-round-protocol
tags: [netting, threshold-consent, rebuild, eip712, fast-check]
requires: []
provides:
  - "rebuildProposal: pure filter→net→buildProposal exclude-and-recompute (same roundNonce)"
  - "verifyProposal excluded-aware: opts.excluded folded into local recomputation with explicit refusals"
  - "shared module-private filterExcluded so rebuild and verify can never diverge"
affects:
  - "01-02 coordinator two-pass state machine (composes rebuildProposal)"
  - "01-03+ e2e stall scenarios (verifyProposal excluded opt)"
tech-stack:
  added: []
  patterns:
    - "out-of-band metadata folded into local recomputation (zero-trust; D-08)"
    - "single shared filter helper for coordinator and participant paths"
key-files:
  created:
    - test/rebuild.test.ts
  modified:
    - src/round.ts
decisions:
  - "self-excluded and excluded-in-participants checks run BEFORE the self-in-participants check so an excluded verifier gets an /excluded/ diagnostic, not 'self not in participant set'"
  - "filterExcluded returns the input array untouched when excluded is empty — zero behavior change for all existing pass-1 callers"
metrics:
  duration: 5m
  completed: 2026-07-22
---

# Phase 01 Plan 01: Pure Exclude-and-Recompute Core Summary

**One-liner:** rebuildProposal (drop IOUs touching excluded members → re-net → re-propose over the same roundNonce) plus excluded-aware verifyProposal, with 12 fast-check/unit tests pinning CONS-02/CONS-03/CONS-05 invariants and refusing every modeled coordinator lie.

## What Was Built

### Task 1: rebuildProposal (TDD)
- `src/round.ts` gains `rebuildProposal(hub, roundNonce, openIous, excluded, opts)` returning `{ proposal, result }`.
- Implementation is a pure composition: filter every SignedIou whose debtor OR creditor is in the lowercased excluded set → unchanged `net()` → existing fixture-locked `buildProposal()` digest path. No new netting math, no new imports.
- The excluded list is out-of-band coordinator metadata (D-08); `RoundProposal`/`types.ts` untouched.
- `test/rebuild.test.ts` (266 lines) reuses the `NOW`/`FUTURE`/`ADDRS`/`fakeIou`/`arbIou`/`arbIous` scaffolding from `test/netting.test.ts` plus `arbStalled = fc.subarray(ADDRS, { maxLength: ADDRS.length - 2 })`:
  - rebuild deltas sum to 0n for arbitrary IOU sets x excluded subsets (CONS-05)
  - no excluded address in rebuilt participants; no consumed id maps back to an IOU touching an excluded member (CONS-02)
  - shuffle determinism (participants, deltas, manifestHash, digest all equal)
  - cascade removal: a member whose only paper touches an excluded member drops out (rule 6)
  - settledIds still filter through the rebuild path (T-01-03 mitigation)

### Task 2: excluded-aware verifyProposal (TDD)
- `verifyProposal` opts widened with `excluded?: Address[]` — omitted means pass-1 semantics, zero behavior change (regression-tested).
- Three new early-return refusals, each `{ ok: false, reason }` with the failing address interpolated, never a throw:
  1. self in excluded set → `self ${self} is excluded from this round`
  2. any excluded address in `proposal.participants` → `excluded address ${p} present in participants`
  3. `myIous` filtered through the shared `filterExcluded` before `net()` — a withheld exclusion surfaces as the existing delta-mismatch refusal (T-01-01 mitigation)
- Module-private `filterExcluded(ious, excluded)` is the single filter used by both `rebuildProposal` and `verifyProposal` (1 definition + 2 call sites).
- Tests use real accounts (`0x11`/`0x22`/`0x33` keys) with `signIou`-built IOUs: honest rebuild verifies for every remaining member; all three lie shapes refused with reason regexes; consent signatures bind to the rebuilt digest and pass-1 consents can never replay against it (T-01-02 mitigation).

## Commits

| Commit | Type | Description |
|--------|------|-------------|
| 1c53992 | test | failing property tests for rebuildProposal (RED) |
| 96118e5 | feat | rebuildProposal as pure filter-net-repropose (GREEN) |
| 070b4f4 | test | failing lying-coordinator refusal tests (RED) |
| 294d04a | feat | excluded-aware verifyProposal + shared filterExcluded (GREEN) |

## Verification

- `npx vitest run test/rebuild.test.ts`: 12/12 pass (fast-check default 100 runs, no numRuns override)
- `npm test`: 28/28 pass (eip712 + netting regression green)
- `npx tsc --noEmit`: exit 0
- `git diff --stat aa10989..HEAD`: only `src/round.ts` and `test/rebuild.test.ts`; `netting.ts`, `types.ts`, `index.ts`, `domain.ts`, fixtures untouched (D-08, D-11)
- No `throw` inside the `verifyProposal` body

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None — both functions are fully wired implementations with property-test coverage.

## TDD Gate Compliance

RED→GREEN sequence present for both tasks (test commits 1c53992/070b4f4 precede feat commits 96118e5/294d04a). No refactor pass needed — GREEN implementations were already minimal.

## Self-Check: PASSED

- src/round.ts: FOUND (`export function rebuildProposal` x1, `excluded?: Address[]` x1, `filterExcluded` x3)
- test/rebuild.test.ts: FOUND (266 lines >= 120 min)
- Commits 1c53992, 96118e5, 070b4f4, 294d04a: FOUND in git log
