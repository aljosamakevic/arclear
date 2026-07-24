---
phase: 03-calibration-checkpoint-brief-checkpoint
plan: 02
subsystem: calibration-simulation
tags: [threshold-consent, cross-validation, calb-01, sweep, exact-match, uncalibrated]
requirements: [CALB-01]
requires:
  - "03-01: demo/thresholdModel.ts (simulateThresholdHistory, availabilityUniforms, deriveRoundSeed, roundFlowBatch, ThresholdRoundRecord.outflows)"
provides:
  - "test/thresholdCrossValidation.test.ts: exact-match faithfulness proof — model vs real attemptRound (D-02)"
  - "demo/thresholdSweep.ts + sweep:threshold script: full D-03 grid driver with D-04 metrics and D-05 headline table"
  - "docs/sweep/threshold-sweep.csv: committed 500-cell x 200-seed calibration data (CALB-01 deliverable)"
affects:
  - "03-03: CALIBRATION.md consumes the headline table, the exact-equality tolerance statement, and the CSV"
tech-stack:
  added: []
  patterns:
    - "Address-remap-only harness: synthetic flowModel addresses remapped to deterministic viem signing accounts, ids untouched — netting equality preserved while EIP-712 consent signatures are real"
    - "Stall-as-timeout providers: offline members return never-resolving promises so unavailability can only manifest as coordinator-deadline timeouts, never refusals"
key-files:
  created:
    - test/thresholdCrossValidation.test.ts
    - demo/thresholdSweep.ts
    - docs/sweep/threshold-sweep.csv
  modified:
    - package.json
decisions:
  - "Cross-validation tolerance is EXACT equality (relative difference 0) — both sides consume identical seeded flows and availability draws; any future loosening is a model-fidelity bug, not a tolerance to widen (recorded for CALIBRATION.md methodology)"
  - "Full run kept at 200 seeds x 10 rounds despite ~51 min runtime — model pruning (the sanctioned lever) already applied in 03-01; SEEDS/grid locked by D-03; ROUNDS_PER_SEED=10 preserved for latency-signal quality per orchestrator directive that long runs are expected"
  - "Headline numbers presented together with abort_rate/unsettled_fraction — realized compression on settled rounds RISES under packet loss (aborts pool paper into bigger settles) while throughput collapses; reporting one without the other would flatter the number (03-CONTEXT: no massaging)"
metrics:
  duration: "~86 minutes (~51 min of it the full 200-seed sweep run)"
  completed: "2026-07-24"
  tasks: 2
  commits: 2
  tests: "83 passing (5 new: 4 cross-validation cells + vacuous-run guard)"
---

# Phase 3 Plan 02: Threshold Cross-Validation + CALB-01 Sweep Summary

Exact-match cross-validation proves the 03-01 model IS the real attemptRound's numbers (bigint equality, zero tolerance, 40 seeded histories), and the full 500-cell x 200-seed threshold sweep is committed with the D-05 headline table — realized compression under realistic uptime next to the idealized baseline.

## What Was Built

**`test/thresholdCrossValidation.test.ts` (216 lines) — the D-02 faithfulness proof:**
- Drives the REAL `attemptRound` (imported from `../demo/coordinator.js`) with real EIP-712 consent signatures (`signConsent` from `../src/round.js`), injected per-member providers, and an in-memory submit stub over the SAME `roundFlowBatch` flow batches and `availabilityUniforms` draws the model consumes.
- Cells n ∈ {5,15} × p ∈ {1.0,0.9}, 10 seeds × 5 rounds each. Member i's synthetic flowModel address is remapped to a deterministic viem account (private key = hex(i+1) padded to 64 nibbles); ids untouched, so `net()` consumes identical obligations on both sides.
- Offline members stall via never-resolving promises — the suite asserts `pass1.refused` is EMPTY on every settled/aborted outcome (an offline member must always manifest as a timeout; any refusal is a diagnosable signing/verification failure, not a tolerance case).
- Asserts per round: outcome-kind mapping, excluded count, and EXACT bigint equality of `settledVolume`, `grossVolume`, `consumedIds.length`, plus cumulative settled volume per history. Zero `toBeCloseTo` anywhere. Vacuous-run guard: the p=0.9 cells must exercise ≥1 two-pass settle and ≥1 exclusion (actual run: both far exceeded).
- Result: **all 40 (cell, seed) histories match exactly on the first run** — 5/5 tests green in 39s (< 3-minute budget).

**`demo/thresholdSweep.ts` (272 lines) + `sweep:threshold` script — the CALB-01 grid:**
- Full D-03 grid: n {5,10,15,30,50} × p {1.0,0.97,0.95,0.9,0.8} × 20 v1 (density,reciprocity) combos, 200 seeds × 10 rounds per cell (`--quick` and `--rounds` dev flags; committed CSV is the full run).
- Every D-04 metric as a CSV column (15-column header verbatim per plan): realized compression (median+p10, over settled rounds only), worst-participant saving (median+p10, v1 per-round metric over `ThresholdRoundRecord.outflows`), excluded-paper latency (mean+p95), abort_rate, exclusion_round_fraction, unsettled_fraction.
- `docs/sweep/threshold-sweep.csv`: 1 header + 500 data rows, all rows seeds=200/rounds_per_seed=10; grid coverage verified (5 n × 5 p × 20 combos).

## D-05 Headline Table

Density 0.5, reciprocity 0.8, 200 seeds × 10 rounds — **[UNCALIBRATED-INPUT-DATA]** (synthetic flows, assumed uptime; D-07 labeling applies to every number below).

Median realized compression / p10 worst-participant saving:

| n | p=1.0 (idealized) | p=0.95 | p=0.9 |
|---|-------------------|--------|-------|
| 15 | 85.2% / 12.8% | 87.5% / 15.5% | 90.5% / 26.3% |
| 30 | 89.7% / 32.6% | 93.4% / 42.0% | 95.0% / 51.2% |
| 50 | 92.0% / 44.6% | 95.8% / 57.0% | 95.7% / 52.6% |

v1 idealized baseline (docs/sweep/sweep.csv, single-shot netting): n=15 85.2%/32.5%, n=30 89.6%/44.1%, n=50 92.1%/53.1% — the model's p=1.0 compression column tracks v1 within 0.1pp (p10 saving differs by construction: this sweep takes the per-seed MINIMUM across 10 rounds, a strictly harsher tail than v1's single shot).

**The honest reading (the numbers were not massaged — 03-CONTEXT):** realized compression on settled rounds *rises* under packet loss because aborted rounds pool paper into larger, better-compressing settles. The cost lands in the companion columns, which are the real story:

| n | p | abort_rate | unsettled_fraction | mean excl. latency (rounds) |
|---|---|-----------|--------------------|------------------------------|
| 15 | 0.95 | 0.27 | 0.04 | 1.40 |
| 15 | 0.9 | 0.59 | 0.17 | 2.14 |
| 30 | 0.95 | 0.59 | 0.15 | 2.07 |
| 30 | 0.9 | 0.90 | 0.62 | 3.27 |
| 50 | 0.95 | 0.84 | 0.45 | 2.97 |
| 50 | 0.9 | 0.99 | 0.95 | 3.48 |

Answer to CALB-01's question: under the hard 2-pass abort cap (D-03), threshold consent practically unlocks **n≈15 at p=0.9 and n≈30 at p=0.95**; at n=50 with p≤0.9 the round machinery effectively stops settling (99% aborts, 95% of paper unsettled at the 10-round horizon) even though the rounds that do settle compress at 95%+.

## Verification Evidence

- `npx vitest run test/thresholdCrossValidation.test.ts` — 5/5 green in 39s, exact equality throughout
- `npm test` — 83/83 green; `npx tsc --noEmit` — clean
- `grep -c "toBeCloseTo" test/thresholdCrossValidation.test.ts` = 0; `grep -c "refused"` ≥ 1; imports from `../demo/coordinator.js` and `../src/round.js` confirmed
- `awk 'END { exit NR == 501 ? 0 : 1 }' docs/sweep/threshold-sweep.csv` — 501 rows; 15 columns; all rows seeds=200, rounds_per_seed=10; 5×5×20 grid coverage verified
- Console run prints the D-05 headline table (n=15/30/50 × p=1.0/0.95/0.9) plus the v1 baseline

## Deviations from Plan

None — plan executed exactly as written. One runtime note: the full sweep took ~51 minutes (plan anticipated ~15). The plan's first lever (model-internal settled-id pruning) was already applied in 03-01; the second lever (reducing ROUNDS_PER_SEED) was deliberately NOT taken — the orchestrator pre-authorized long runs and locked SEEDS/grid, and rounds=10 preserves the latency/carry-over signal quality. The committed CSV records rounds_per_seed=10 in every row.

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| 49cd19f | test | Exact-match cross-validation — model vs real attemptRound (D-02) |
| 3c19ace | feat | Threshold sweep driver, full-grid CSV, sweep:threshold script (CALB-01) |

## Known Stubs

None — the test's in-memory `submit` stub is the plan-specified cross-validation harness design (chain-free by construction), not a placeholder.

## Threat Flags

None — simulation + reporting only; no new protocol surface, no new dependencies (D-09 honored: imports confined to vitest/viem/node:fs and in-repo modules).

## Next Phase Readiness

- 03-03 consumes: the headline table above, the exact-equality tolerance statement (methodology section of CALIBRATION.md), and `docs/sweep/threshold-sweep.csv`
- Every published number derived from this data must carry the UNCALIBRATED-INPUT-DATA label (D-07, T-03-01)
- The abort/unsettled companion columns MUST travel with the compression headline — compression alone overstates the result under packet loss

## Self-Check: PASSED

- test/thresholdCrossValidation.test.ts — FOUND
- demo/thresholdSweep.ts — FOUND
- docs/sweep/threshold-sweep.csv — FOUND (501 rows)
- Commits 49cd19f, 3c19ace — FOUND in git log
