# Calibration Checkpoint — Threshold Consent & Margin Coverage (Phase 3)

> **UNCALIBRATED-INPUT-DATA.** Every number in this document is derived from
> synthetic flows (`demo/flowModel.ts`) and assumed per-round uptime
> distributions. This is reference-brief material — a legible record of how
> the mechanisms behave under stated assumptions — **not** production risk
> calibration. The label repeats on every table below that carries a risk
> number (D-07).

Data sources (committed, reproducible):

- `docs/sweep/threshold-sweep.csv` — CALB-01 grid, `npm run sweep:threshold`
- `docs/sweep/margin-sweep.csv` — CALB-02 grid, `npm run sweep:margin`
- `docs/sweep/sweep.csv` — v1 idealized baseline (single-shot netting)

Tables below transcribe values verbatim from the CSVs (fractions, 4 decimals;
debits in token base units) — nothing re-rounded, nothing invented.

**Data notes (empty-sample cells in `threshold-sweep.csv`).** In the
committed threshold CSV, rows where `abort_rate=1.0000` and
`unsettled_fraction=1.0000` — the 16 rows at **n=50, p=0.8** — never settled
a single round, so their `median_realized_compression`, `median_worst_saving`
and both latency statistics are **imputed 0.0000, not measured zeros**. In
adjacent high-abort cells (abort_rate > 0.95 at p=0.8/0.9), medians are
conditioned on the subset of seeds with at least one settled round, even
though the `seeds` column reads 200 — read them as survivorship-conditioned.
The sweep script now emits `NaN` for empty samples so future regenerations
distinguish no-data from zero; the committed CSV predates that marker and is
kept byte-identical. None of the cells cited in this document is imputed.

## 1. Why this sweep exists

Unanimity's idealized numbers were never the real numbers. v1's sweep measured
single-shot netting compression at perfect availability — but a round under
threshold consent is a two-pass exclude-and-recompute process: offline members
are excluded, their paper drops, the round re-nets over the survivors, and a
second stall aborts the attempt entirely. What an operator actually gets is
the **realized** compression of that process under imperfect uptime, net of
aborted rounds and carried-over paper. This sweep measures exactly that, with
a simulation model proven faithful to the real coordinator by exact-match
cross-validation (§4).

## 2. Headline — realized compression under realistic uptime (D-05)

Density 0.5, reciprocity 0.8 (the canonical v1 operating point), 200 seeds x
10 rounds per cell, from `docs/sweep/threshold-sweep.csv`.
**[UNCALIBRATED-INPUT-DATA]**

Each cell: median realized compression / p10 worst-participant saving
(fractions, verbatim from the CSV).

| n | p=1.0 (idealized; v1 baseline alongside) | p=0.95 | p=0.9 |
|---|------------------------------------------|--------|-------|
| 15 | 0.8519 / 0.1280 (v1: 0.8522 / 0.3248) | 0.8752 / 0.1553 | 0.9048 / 0.2629 |
| 30 | 0.8971 / 0.3260 (v1: 0.8962 / 0.4413) | 0.9342 / 0.4205 | 0.9505 / 0.5123 |
| 50 | 0.9205 / 0.4463 (v1: 0.9206 / 0.5309) | 0.9585 / 0.5701 | 0.9574 / 0.5256 |

The model's p=1.0 compression column tracks the v1 idealized sweep
(`docs/sweep/sweep.csv`, single-shot netting) within 0.1pp — the faithfulness
anchor. The p10 saving differs from v1 by construction: this sweep takes the
per-seed **minimum** across 10 rounds, a strictly harsher tail than v1's
single shot.

**Read the compression column together with its companion columns — never
alone.** Realized compression on settled rounds *rises* under packet loss
only because aborted rounds pool paper into larger, better-compressing
settles. The cost lands here (same cells, same CSV)
**[UNCALIBRATED-INPUT-DATA]**:

| n | p | abort_rate | unsettled_fraction | mean / p95 carry-over latency (rounds) |
|---|---|-----------|--------------------|----------------------------------------|
| 15 | 0.95 | 0.2685 | 0.0418 | 1.4019 / 3.0000 |
| 15 | 0.9 | 0.5850 | 0.1748 | 2.1370 / 5.0000 |
| 30 | 0.95 | 0.5890 | 0.1460 | 2.0683 / 5.0000 |
| 30 | 0.9 | 0.9030 | 0.6211 | 3.2702 / 7.0000 |
| 50 | 0.95 | 0.8410 | 0.4498 | 2.9697 / 7.0000 |
| 50 | 0.9 | 0.9860 | 0.9491 | 3.4830 / 7.0000 |

**What threshold consent actually unlocks:** under the hard 2-pass abort cap,
the practical ceiling is **n≈15 at p=0.9 and n≈30 at p=0.95** (0.9342
compression / 0.4205 p10 saving); at n=50 with p≤0.9 the round machinery
effectively stops settling — 0.9860 abort rate and 0.9491 of all paper still
unsettled at the 10-round horizon — even though the rounds that do settle
compress at 0.95+. Relaxing the hard 2-pass cap (more signature-collection
passes per round) is the documented lever for larger n; it is future work,
not measured here.

## 3. Methodology

**Model (D-01).** `demo/thresholdModel.ts` is a pure, seeded netting-level
replica of `demo/coordinator.ts` `attemptRound`'s two-pass
exclude-and-recompute semantics. Rules, in order, per simulated round:

1. A fresh seeded flow batch (round-unique ids) joins the open pool.
2. `net()` runs over the pool with accumulated `settledIds` — carried paper
   re-enters every round; consumed paper can **never settle twice**.
3. Fewer than 2 participants → empty round (attemptRound's exact quorum
   check).
4. No offline pass-1 candidates → 1-pass settle.
5. Otherwise all offline candidates are excluded in a **single batch**; every
   IOU touching an excluded member (as debtor or creditor) drops
   (`rebuildProposal`'s rule); the round re-nets. Rebuilt participants < 2 →
   abort (quorum floor 2).
6. Any rebuilt participant offline in its independent pass-2 draw → abort —
   the **hard 2-pass cap**. Otherwise 2-pass settle. Aborted/excluded paper
   carries into the next round.

**Determinism.** All randomness flows from two shared streams:
`availabilityUniforms(seed, rounds, n)` (round-major uniforms,
`rng(seed ^ 0x5eed)`) and `deriveRoundSeed(seed, round)` for per-round flow
batches. The same parameters always produce a byte-identical history.

**Scale.** 200 seeds per cell (matching v1 methodology). Rounds per seed: 10
for the threshold grid (500 cells: n {5,10,15,30,50} x p {1.0,0.97,0.95,0.9,0.8}
x 20 (density, reciprocity) combos), 64 for the margin grid (so EWMA state
matures past the largest lookback N=32).

**Cross-validation (D-02) — the faithfulness proof.**
`test/thresholdCrossValidation.test.ts` drives the **real** `attemptRound`
(real EIP-712 consent signatures, injected per-member providers, offline
members stall as timeouts) over the same flow batches and availability draws
the model consumes: cells n ∈ {5, 15} x p ∈ {1.0, 0.9}, 10 seeds each.
**Tolerance is exact equality** — outcome kind, excluded set size,
`settledVolume`, `grossVolume`, and consumed-id count match as exact bigints
in all 40 (cell, seed) histories, zero floating-point comparisons. Any future
divergence is a model-fidelity bug, not a tolerance to widen.

## 4. Carry-over cost of exclusion

The price of exclude-and-recompute is **carry-over latency**: the metric
counts every IOU that settled at least one round after it became eligible —
paper delayed by exclusion **or by an aborted or empty round**. When a round
aborts, the whole pool carries, including paper of members who were online
and never excluded; at the abort-heavy cells cited here abort carry-over, not
exclusion of the measured IOU's parties, dominates the observations. (The CSV
keeps its historical column names `mean_excluded_latency_rounds` /
`p95_excluded_latency_rounds` — the committed data is unchanged; read them as
carry-over latency.) At the headline cells
(table in §2, latency columns) **[UNCALIBRATED-INPUT-DATA]**: mean latency
runs 1.4019 rounds (n=15, p=0.95) to 3.4830 rounds (n=50, p=0.9) with p95 at
3–7 rounds — and at the abort-heavy cells most paper (0.6211 at n=30 p=0.9,
0.9491 at n=50 p=0.9) has not settled at all within the 10-round horizon.
Latency numbers are conditional on eventual settlement; the unsettled
fraction is the dominant cost where aborts dominate.

## 5. Margin coverage (CALB-02, D-06)

Would an EWMA-based initial margin `IM_t = q x EWMA_(t-1)(debit, lookback N)`
have covered realized per-round net debits? Causal by construction: the IM
held entering settled round t is computed only from rounds before t; each
member's first N settled rounds are warmup (unscored). Grid: q ∈ {1.0, 1.25,
1.5, 2.0} x N ∈ {8, 16, 32}, 200 seeds x 64 rounds, density 0.5, reciprocity
0.8, from `docs/sweep/margin-sweep.csv`.

n=30, constant p=0.95 — coverage_rate / p99_tail_coverage
**[UNCALIBRATED-INPUT-DATA]**:

| q \ N | 8 | 16 | 32 |
|-------|---|----|----|
| 1.0 | 0.3089 / 0.0000 | 0.3007 / 0.0000 | 0.2769 / 0.0000 |
| 1.25 | 0.3729 / 0.0000 | 0.3672 / 0.0000 | 0.3453 / 0.0000 |
| 1.5 | 0.4306 / 0.0000 | 0.4270 / 0.0000 | 0.4072 / 0.0000 |
| 2.0 | 0.5294 / 0.0000 | 0.5321 / 0.0000 | 0.5049 / 0.0000 |

p99 scored debit: 18888673 (N=8), 18488244 (N=16), 15538573 (N=32) base units.

n=30, stress ramp (uptime 1.0 → 0.8 across the 64 rounds) — coverage_rate /
p99_tail_coverage **[UNCALIBRATED-INPUT-DATA]**:

| q \ N | 8 | 16 | 32 |
|-------|---|----|----|
| 1.0 | 0.2427 / 0.0000 | 0.1983 / 0.0000 | 0.0000 / 0.0000 |
| 1.25 | 0.2941 / 0.0000 | 0.2344 / 0.0000 | 0.0000 / 0.0000 |
| 1.5 | 0.3420 / 0.0000 | 0.2773 / 0.0000 | 0.0000 / 0.0000 |
| 2.0 | 0.4304 / 0.0000 | 0.3592 / 0.0000 | 0.0000 / 0.0000 |

p99 scored debit: 25220511 (N=8), 32089425 (N=16); the N=32 column is
data-sparse (no ramp history at n=30 accumulates more than 32 settled rounds,
so warmup consumes every observation — reported as 0.0000, not imputed).

**Which (q,N) pairs cover the p99 tail: none.** `p99_tail_coverage` is 0.0000
in all 144 rows of the grid — a mean-tracking EWMA of per-round debits
(which include many zero-debit rounds for each member) sits far below the p99
debit, and even q=2.0 covers only about half of all positive debits (best
cell in the whole grid: 0.5519 coverage at n=15, p=1.0, q=2.0, N=16). The
honest CALB-02 answer is that **no q ≤ 2 scaling of a debit-EWMA survives the
p99 rounds** on these synthetic flows; a tail-covering IM needs a different
estimator (e.g. a rolling peak or quantile, as float-free integer arithmetic
allows) or a q far above this grid.

**Procyclicality (+25%/round IM rise cap).** `cap_binding_fraction` — the
fraction of scored observations where the uncapped IM demanded a rise of more
than 25% over the previous round (i.e. where the rise cap would bind and
leave the member under-margined) — depends on N but not q (the ratio test
cancels q) **[UNCALIBRATED-INPUT-DATA]**: at n=30, constant p=0.95 it is
0.2203 (N=8), 0.1456 (N=16), 0.0683 (N=32); under the stress ramp it rises to
0.2605 (N=8) and 0.2217 (N=16). Longer lookbacks smooth demanded rises but
track the debit level worse (lower coverage above); the ramp confirms the
expected procyclical bind — IM demand climbs fastest exactly when uptime
degrades. Cells where warmup consumes all observations (n=50 at p=0.9 across
the board; N=32 under heavy aborts) report 0.0000 and should be read as
data-sparse, not safe.

## 6. Decision record (D-08)

2026-07-24: CCP arc skipped by user decision; sweep documents the empirical basis

The margin data above is recorded for `docs/V2-BRIEF.md` as reference
material — there is no downstream CCP consumer of these parameters.
