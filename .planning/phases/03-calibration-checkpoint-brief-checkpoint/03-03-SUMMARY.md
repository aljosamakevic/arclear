---
phase: 03-calibration-checkpoint-brief-checkpoint
plan: 03
subsystem: calibration-simulation
tags: [margin, ewma, calb-02, procyclicality, calibration-report, uncalibrated, gate-decision]
requirements: [CALB-02]
requires:
  - "03-01: demo/thresholdModel.ts (simulateThresholdHistory, ThresholdRoundRecord.deltas, per-round uptime schedules)"
  - "03-02: docs/sweep/threshold-sweep.csv (headline numbers), exact-equality cross-validation result (methodology citation)"
provides:
  - "demo/marginSweep.ts + sweep:margin script: causal EWMA-IM coverage grid + stress-ramp cap-binding analysis (D-06)"
  - "docs/sweep/margin-sweep.csv: committed CALB-02 grid — 12 flow cells x 12 (q,N) combos, 200 seeds x 64 rounds"
  - "docs/CALIBRATION.md: the phase's human-readable deliverable — headline table, methodology, margin coverage, recorded gate decision (D-08)"
affects:
  - "docs/V2-BRIEF.md consumers: margin data recorded as reference-brief material (CCP arc skipped)"
  - "Showcase submission: D-05 headline table with companion columns"
tech-stack:
  added: []
  patterns:
    - "Causal EWMA scoring: IM_t = q * ewma_(t-1) scored before the round's debit updates state — lookahead impossible by construction"
    - "Warmup exclusion (first N settled rounds per member) so immature EWMA state never flatters or damns coverage"
    - "Data-sparse cells report 0.0000 rather than imputing — flagged explicitly in the report as 'sparse, not safe'"
key-files:
  created:
    - demo/marginSweep.ts
    - docs/sweep/margin-sweep.csv
    - docs/CALIBRATION.md
  modified:
    - package.json
decisions:
  - "ROUNDS_PER_SEED hard-floored at 64 in code (Math.max clamp on --rounds) — the orchestrator directive 'never below 64' enforced mechanically, with the model's settled-id pruning as the only runtime lever"
  - "CALIBRATION.md tables transcribe raw CSV fractions (4 decimals) instead of re-rounded percentages so every number is literally grep-able back to its committed CSV row"
  - "cap_binding_fraction computed over all scored observations (not positive-debit only), matching the plan's definition; the ratio test cancels q, so binding is reported per lookback N"
metrics:
  duration: "~96 minutes (~41 min of it the full 200-seed x 64-round margin sweep)"
  completed: "2026-07-24"
  tasks: 2
  commits: 2
  tests: "83 passing (no new tests — reporting-layer scripts per plan)"
---

# Phase 3 Plan 03: Margin Coverage Sweep + CALIBRATION.md Summary

CALB-02 answered with committed data — no q<=2 scaling of a debit-EWMA covers the p99 tail debit in any of the 144 grid rows — and docs/CALIBRATION.md ships the phase's full deliverable: headline table with companion columns, exact-equality methodology, margin coverage tables, and the verbatim recorded gate decision.

## What Was Built

**`demo/marginSweep.ts` (259 lines) + `sweep:margin` script — the CALB-02 grid (D-06):**
- 12 flow cells at density 0.5 / reciprocity 0.8: n {15,30,50} x p {1.0,0.95,0.9} constant-uptime plus 3 stress-ramp cells (per-round uptime array 1.0 -> 0.8, exercising thresholdModel's schedule support). 200 seeds x 64 rounds per cell (`--quick` dev flag; `--rounds` clamped to floor 64).
- Per member, per settled round: realized debit = max(0n, -delta) from `ThresholdRoundRecord.deltas`; aborted/empty rounds contribute no observation and never advance EWMA state.
- Per (q, N) in {1.0,1.25,1.5,2.0} x {8,16,32}: causal EWMA (lambda = 2/(N+1), IM entering round t uses only rounds < t), N-round warmup, then coverage_rate (positive-debit observations covered), p99_debit (bigint-exact percentile, base units), p99_tail_coverage, and cap_binding_fraction (uncapped IM rise > 25% over the prior round — where the procyclicality guard would bind).
- `docs/sweep/margin-sweep.csv`: 1 header + 144 data rows, 12-column header verbatim per plan, seeds=200 / rounds_per_seed=64 in every committed row.

**`docs/CALIBRATION.md` (190 lines) — the phase deliverable (D-08):**
- All 7 plan sections: UNCALIBRATED banner; why-this-sweep framing; D-05 headline table (raw CSV fractions, v1 baseline alongside p=1.0) WITH the abort_rate/unsettled_fraction/latency companion table and the honest unlock reading (n≈15 at p=0.9, n≈30 at p=0.95; n=50 at p<=0.9 stalls at 0.9860 abort / 0.9491 unsettled; 2-pass-cap relaxation noted as future work); methodology (6 numbered model rules, seeded determinism, 200 seeds, exact-equality cross-validation citing test/thresholdCrossValidation.test.ts); carry-over cost; margin coverage tables (n=30 at p=0.95 + ramp) with the p99-tail verdict and cap-binding numbers; decision record with the verbatim string "2026-07-24: CCP arc skipped by user decision; sweep documents the empirical basis".

## The CALB-02 Findings (honest, unmassaged)

- **No (q,N) pair covers the p99 tail — anywhere.** p99_tail_coverage = 0.0000 in all 144 rows. A mean-tracking EWMA (fed many zero-debit rounds per member) sits far below the tail; best overall coverage_rate in the grid is 0.5519 (n=15, p=1.0, q=2.0, N=16). A tail-covering IM needs a different estimator (rolling peak/quantile) or q far above 2 — recorded as the reference-brief conclusion.
- **Coverage ordering is sane:** q=2.0/N=8 strictly beats q=1.0/N=32 in 11/12 flow cells (acceptance floor was 10); the single non-strict cell is n=50/p=0.9 where 99% aborts leave zero scored observations (0.0000 vs 0.0000).
- **The +25%/round rise cap binds procyclically:** cap_binding_fraction depends on N only (the ratio test cancels q) — at n=30: 0.2203/0.1456/0.0683 for N=8/16/32 at constant p=0.95, rising to 0.2605/0.2217 (N=8/16) under the stress ramp. IM demand climbs fastest exactly when uptime degrades.
- **Data-sparse cells report zeros, not imputations:** n=50/p=0.9 (all combos) and N=32 under heavy aborts never accumulate enough settled rounds to clear warmup; CALIBRATION.md flags these as "sparse, not safe".

## Verification Evidence

- `docs/sweep/margin-sweep.csv`: `awk 'END { exit NR == 145 ? 0 : 1 }'` passes; header matches the 12-column spec verbatim; 0 rows with seeds != 200 or rounds != 64; 36 ramp rows with p_or_ramp = "ramp-1.0-0.8"
- Grep gates: gate-decision string appears exactly once; "UNCALIBRATED" appears 7 times (>= 3)
- Spot-checks: 0.9574 (n=50/p=0.9 median compression) present in both CALIBRATION.md and threshold-sweep.csv; 0.4270 (n=30, q=1.5, N=16 coverage) present in both CALIBRATION.md and margin-sweep.csv
- Phase acceptance: `npm test` 83/83 green; `npx tsc --noEmit` clean; `npm run sweep:threshold -- --quick` and `npm run sweep:margin -- --quick` both complete end-to-end (committed CSVs restored from HEAD afterward — quick runs overwrite the full-run files by design)
- No new dependencies in package.json (D-09); imports confined to node:fs/node:path/node:url and in-repo modules

## Deviations from Plan

None — plan executed exactly as written. Two notes, neither a deviation: (1) the full margin sweep took ~41 minutes (dominated by the n=50/p=0.9 cell at ~17 min, where near-total aborts keep the open pool large); the sanctioned lever (model settled-id pruning) was already in place from 03-01 and ROUNDS_PER_SEED stayed at 64 per directive. (2) After the final `--quick` acceptance runs, the two committed CSVs were restored file-specifically from HEAD so the committed data remains the full 200-seed runs.

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| 9a10681 | feat | EWMA margin coverage sweep — CALB-02 grid + stress ramp (D-06), committed full-run CSV, sweep:margin script |
| 45b5f6a | docs | CALIBRATION.md — headline + companion tables, methodology, margin coverage, verbatim gate decision |

## Known Stubs

None — both scripts are fully wired to the committed data; no placeholders, no hardcoded empty values.

## Threat Flags

None — simulation + reporting only (T-03-01 mitigated as planned: numbers transcribed from committed CSVs at CSV precision, UNCALIBRATED labels on every risk table, ugly results reported as-is; T-03-SC moot: zero new dependencies).

## Next Phase Readiness

- The phase's deliverable chain is complete: threshold-sweep.csv + margin-sweep.csv + CALIBRATION.md, all committed and mutually grep-consistent
- docs/V2-BRIEF.md can cite CALIBRATION.md directly as the empirical basis recorded at the skipped CCP gate
- If a future phase revisits margin, the recorded conclusion is that the estimator (not just q/N) must change to cover the tail

## Self-Check: PASSED

- demo/marginSweep.ts — FOUND
- docs/sweep/margin-sweep.csv — FOUND (145 lines, seeds=200 throughout)
- docs/CALIBRATION.md — FOUND (gate string x1, UNCALIBRATED x7)
- Commits 9a10681, 45b5f6a — FOUND in git log
