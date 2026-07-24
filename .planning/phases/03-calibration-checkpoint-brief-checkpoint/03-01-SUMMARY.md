---
phase: 03-calibration-checkpoint-brief-checkpoint
plan: 01
subsystem: calibration-simulation
tags: [threshold-consent, exclude-and-recompute, fast-check, seeded-determinism, calb-01]
requires: []
provides:
  - "demo/thresholdModel.ts: pure exclude-and-recompute simulation model mirroring attemptRound (D-01)"
  - "Shared draw streams for 03-02 cross-validation: availabilityUniforms, deriveRoundSeed, roundFlowBatch"
  - "ThresholdParams / ThresholdRoundRecord / ThresholdHistory interfaces (frozen contract for 03-02/03-03)"
affects:
  - "03-02 cross-validation harness (replays the same streams against the real attemptRound)"
  - "03-03 threshold sweep + margin analysis (consumes ThresholdHistory records)"
tech-stack:
  added: []
  patterns:
    - "Round-unique id rewriting (round index in high 8 nibbles) to defeat generateFlows' per-call counter reset"
    - "Round-major shared uniform stream (rng(seed ^ 0x5eed)) so model and real coordinator replay identical draws"
key-files:
  created:
    - demo/thresholdModel.ts
    - test/thresholdModel.test.ts
  modified:
    - demo/flowModel.ts
decisions:
  - "Exported addr() from demo/flowModel.ts instead of duplicating the formula — model and generator must key identical member addresses (divergence would silently break 03-02's replay)"
  - "Aborted/empty records carry grossVolume 0n (nothing consumed), matching the interface's 'over the consumed set only' definition"
  - "Open pool pruned after each settled round (value-neutral: net() rule 3 drops settled ids anyway) — the sanctioned runtime optimization for 03-03's 64-round histories"
metrics:
  duration: "~7 minutes"
  completed: "2026-07-24"
  tasks: 2
  commits: 3
  tests: "78 passing (14 new: 7 behaviors + 7 fast-check properties)"
---

# Phase 3 Plan 01: Threshold-Consent Simulation Model Summary

Pure seeded exclude-and-recompute simulation model mirroring `attemptRound`'s five outcome branches at netting level, with round-unique IOU ids and shared draw streams enabling 03-02's exact-match cross-validation.

## What Was Built

**`demo/thresholdModel.ts` (256 lines, 7 exports, zero new deps — D-09):**
- `simulateThresholdHistory(params)` — per round: fresh round-unique flow batch → `net(openPool, { now, settledIds })` → participants < 2 → `"empty"` (attemptRound's exact participant-count check) → pass-1 offline candidates → none → `"settled-1pass"`, else single-batch exclusion (D-02) → drop every IOU whose debtor OR creditor is excluded (rebuildProposal's rule, without the keccak digests) → re-net → rebuilt participants < 2 → `"aborted"` (quorum floor) → any rebuilt participant offline in its independent pass-2 draw → `"aborted"` (D-03 hard 2-pass cap) → else `"settled-2pass"`.
- `availabilityUniforms(seed, rounds, n)` — `Float64Array` of length `rounds*n*2` from `rng(seed ^ 0x5eed)`, round-major (round → member → pass 1, pass 2); online iff uniform `< p_r` strict. The SHARED stream 03-02 replays.
- `deriveRoundSeed(seed, round)` — `((seed * 31 + round * 2654435761) >>> 0)`, shared with 03-02.
- `roundFlowBatch(seed, round, params)` — wraps `generateFlows` and rewrites every id round-uniquely (round index in the high 8 nibbles, generateFlows' counter in the low nibbles) so `net()` rules 1/3 can never silently dedup fresh paper against a prior round's ids.
- Latency accounting: latency `>= 1` (settled after first eligible round) pushed into `excludedLatencies`; `unsettledCount` = open pool at horizon end. All money math bigint; only probabilities/latencies are numbers.

**`test/thresholdModel.test.ts` (347 lines):**
- 7 behavior tests (TDD: written first, failing, then implemented to green): p=1.0 degeneracy to plain `net()` verified against an independent replica; forced exclusion via deterministic seed search (2-pass settle, excluded member's paper untouched, carried paper settles later exactly once with latency 1); pass-2 stall abort (empty deltas, nothing enters settledIds, all paper carries); density-0 empty rounds; n=2 quorum abort; round-unique ids; `availabilityUniforms(1,2,3)` length-12 reproducibility.
- 7 `fc.assert` properties (25 runs each, n 3–12, density 0.3–1, reciprocity 0–1, uptime 0.5–1, rounds 2–6, seed int32): zero-sum settled deltas; never-twice (`Σ consumedCount === generatedCount − unsettledCount`); deep-equal determinism; p=1.0 idealized equivalence (only 1-pass/empty, empty latencies, trailing-empty accounting); conservation (`settledVolume <= grossVolume`); abort safety (no leaked consumption); round-unique ids across arbitrary histories.

## Verification Evidence

- `npx vitest run test/thresholdModel.test.ts` — 14/14 green
- `npm test` — 78/78 green in 3.7s (netting/eip712/merkle/rebuild suites untouched)
- `npx tsc --noEmit` — clean (strict, no `any`)
- `grep -c "export" demo/thresholdModel.ts` = 7 (>= 7); `grep -c "fc.assert" test/thresholdModel.test.ts` = 7 (>= 7)
- Imports confined to `viem` (types), `../src/*`, `./flowModel.js` — D-09 honored

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exported `addr` from `demo/flowModel.ts`**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** The plan directs the model to use "flowModel's addr(i)" for member addresses, but `addr` was module-private in `demo/flowModel.ts`
- **Fix:** Added `export` + doc comment to the existing function (additive, non-breaking); duplicating the formula instead would risk silent divergence with 03-02's replay harness
- **Files modified:** demo/flowModel.ts
- **Commit:** c3ef19f

## TDD Gate Compliance

- RED: a704d79 `test(03-01)` — behavior tests failing against the missing module
- GREEN: c3ef19f `feat(03-01)` — implementation, all 7 behaviors pass
- REFACTOR: not needed — implementation landed clean on first green

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| a704d79 | test | Failing behavior tests for the simulation model (RED) |
| c3ef19f | feat | thresholdModel implementation + addr export (GREEN) |
| 3d37a0b | test | fast-check property suite (7 invariant properties) |

## Known Stubs

None — every export is fully wired; no placeholders, no hardcoded empty values.

## Next Phase Readiness

- The interfaces block is now the frozen contract: 03-02's cross-validation harness replays `availabilityUniforms` + `roundFlowBatch` verbatim; 03-03 consumes `ThresholdRoundRecord.outflows` for the margin debit series
- `redeemedIds` intentionally unused (redemption out of model scope, per plan)
- All published numbers derived from this model must carry the UNCALIBRATED label (D-07, T-03-01)

## Self-Check: PASSED

- demo/thresholdModel.ts — FOUND
- test/thresholdModel.test.ts — FOUND
- Commits a704d79, c3ef19f, 3d37a0b — FOUND in git log
