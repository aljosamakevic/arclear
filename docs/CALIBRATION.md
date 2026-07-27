# Calibration Checkpoint — Threshold Consent & Margin Coverage (Phase 3)

> **UNCALIBRATED-INPUT-DATA.** Every number in this document is derived from
> synthetic flows (`demo/flowModel.ts`) and assumed per-round uptime
> distributions. This is reference-brief material — a legible record of how
> the mechanisms behave under stated assumptions — **not** production risk
> calibration. The label repeats on every table below that carries a risk
> number (D-07).

Data sources (committed):

- `docs/sweep/threshold-sweep.csv` — CALB-01 grid, `npm run sweep:threshold`
- `docs/sweep/margin-sweep.csv` — CALB-02 grid, `npm run sweep:margin`
- `docs/sweep/sweep.csv` — v1 idealized baseline (single-shot netting)

Tables below transcribe values verbatim from the CSVs (fractions, 4 decimals;
debits in token base units) — nothing re-rounded, nothing invented.

### Data notes — read before quoting any number below

Both v2 CSVs were produced by earlier versions of their sweep scripts, which
imputed `0.0000` where a statistic had **no contributing observation at all**.
Both scripts now emit `NaN` instead. The committed CSVs are kept
byte-identical rather than regenerated, so the imputed cells are enumerated
here. Every claim in this document has been re-derived against the current
scripts; where a cited cell is imputed or thin, it is labeled at the point of
use.

**`threshold-sweep.csv` — not byte-reproducible today.** Re-running
`npm run sweep:threshold` reproduces every measured value exactly, but
rewrites the empty-sample markers of **117 of the 500 rows**:

| Rows | What changes on regeneration | Why the sample is empty |
|---|---|---|
| 100 rows at **p=1.0** (all n, all 20 flow combos) | both latency columns `0.0000` → `NaN` | at full uptime nothing is ever excluded or carried, so no latency observation exists — a meaningful "never delayed", not a measured zero |
| **16 rows at n=50, p=0.8** (`abort_rate=1.0000` ∧ `unsettled_fraction=1.0000`) | both latency columns *and* all four compression / worst-saving columns `0.0000` → `NaN` | not one round settled across 200 seeds |
| **1 row** at n=50, p=0.8, density 0.5, reciprocity 1.0 | both latency columns `0.0000` → `NaN` | one seed of 200 settled, and it carried nothing |

Independently re-derived from `demo/thresholdModel.ts`: `n=15, p=1.0, d=0.5,
r=0.8` reproduces `0.8519, 0.8391, 0.2755, 0.1280` byte-for-byte while its
latency columns come out `NaN`; `n=50, p=0.9, d=0.5, r=0.8` reproduces all
eleven columns byte-for-byte.

**`threshold-sweep.csv` — the `seeds` column overstates support in
high-abort cells.** Every row reports `seeds = 200`, but a seed contributes a
compression / worst-saving sample only if at least one of its 10 rounds
settled. Measured contributing-seed counts at density 0.5 / reciprocity 0.8:

| cell | seeds contributing | `seeds` column reads |
|---|---|---|
| n=15, p=0.9 | 199 / 200 | 200 |
| n=30, p=0.95 | 196 / 200 | 200 |
| **n=50, p=0.9** | **28 / 200** | 200 |
| n=50, p=0.8, d=0.5, r=1.0 | 1 / 200 | 200 |

The n=50/p=0.9 cell is quoted in the §2 headline table; **its 0.9574 / 0.5256
rests on 28 seeds, not 200**, and is flagged inline there.

**`margin-sweep.csv` — 36 of 144 rows are no-data rows imputed to 0.0000.**
A `(q,N)` row scores a member only after their first `N` *settled* rounds
(EWMA warmup). At high-abort flow cells no seed ever accumulates more than
`N` settled rounds, so the row has zero observations and the old script wrote
`0.0000` into all four value columns. Verified by re-running the affected
cells with instrumentation — every one of them has **zero** scored
observations *and* zero scored positive debits, so `coverage_rate`,
`p99_debit`, `p99_tail_coverage` **and** `cap_binding_fraction` are all
imputed there:

| flow cell | imputed lookbacks | rows | max settled rounds any seed reached (of 64) |
|---|---|---|---|
| n=30, p=0.9 | N=16, N=32 | 8 | 15 |
| n=50, p=0.95 | N=32 | 4 | 18 |
| n=50, p=0.9 | N=8, N=16, N=32 | 12 | 6 |
| n=30, ramp | N=32 | 4 | 23 |
| n=50, ramp | N=16, N=32 | 8 | 15 |

These rows are exactly the 36 whose `p99_debit` reads `0` — that column is
the reliable no-data marker in the committed CSV, since a genuine p99 over
positive debits can never be zero. Regenerating with the current script
writes `NaN` in all four columns and adds `scored_observations` /
`scored_positive_debits` so the support of every future row is visible
without this table.

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
| 50 | 0.9205 / 0.4463 (v1: 0.9206 / 0.5309) | 0.9585 / 0.5701 | **0.9574 / 0.5256** ⚠ |

⚠ **The n=50 / p=0.9 cell rests on 28 of its 200 seeds**, not 200: only 28
seeds settled a single round, and the other 172 contribute nothing to either
statistic. The `seeds` column of the CSV nonetheless reads 200 (see Data
notes). Read that cell as "of the 14% of runs that settled anything, this is
what they looked like" — the honest headline for n=50 at p=0.9 is the 0.9860
abort rate and 0.9491 unsettled fraction in the table below, not the
compression figure. Every other cell in this table rests on ≥ 196 of 200
seeds.

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
unsettled at the 10-round horizon — even though the few rounds that do settle
(28 of 200 seeds saw any) compress at 0.95+. Relaxing the hard 2-pass cap (more signature-collection
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

All twelve rows above carry data, but the support falls off sharply with the
lookback — measured scored positive-debit observations across the 200 seeds:
**52,606 (N=8), 29,440 (N=16), 307 (N=32)**. The N=32 column is a ~170×
thinner sample than N=8; treat its 0.2769 / 0.3453 / 0.4072 / 0.5049 coverage
figures as indicative, not comparable to the N=8 column at face value.

n=30, stress ramp (uptime 1.0 → 0.8 across the 64 rounds) — coverage_rate /
p99_tail_coverage **[UNCALIBRATED-INPUT-DATA]**:

| q \ N | 8 | 16 | 32 |
|-------|---|----|----|
| 1.0 | 0.2427 / 0.0000 | 0.1983 / 0.0000 | *no data* ⚠ |
| 1.25 | 0.2941 / 0.0000 | 0.2344 / 0.0000 | *no data* ⚠ |
| 1.5 | 0.3420 / 0.0000 | 0.2773 / 0.0000 | *no data* ⚠ |
| 2.0 | 0.4304 / 0.0000 | 0.3592 / 0.0000 | *no data* ⚠ |

p99 scored debit: 25220511 (N=8), 32089425 (N=16); no p99 exists for N=32.

⚠ **The N=32 column is a no-data column, and the committed CSV shows it as
`0.0000` — that is an imputation, not a measurement.** (An earlier revision of
this document asserted the opposite; the imputation was in
`demo/marginSweep.ts`, which has since been fixed to emit `NaN`.) The cause is
real and worth stating: the longest ramp history at n=30 reaches 23 settled
rounds across all 200 seeds, so the 32-round EWMA warmup consumes every
observation and **not one** scored observation exists — verified by
instrumenting the cell (`scored_observations = 0`, `scored_positive_debits =
0`). Support for the two columns that do carry data: 23,813 (N=8) and 3,101
(N=16) scored positive debits.

**Which (q,N) pairs cover the p99 tail: none of the ones we can measure.**
`p99_tail_coverage` reads 0.0000 in all 144 rows of the committed CSV, but
**36 of those rows are no-data rows** (see Data notes) and carry no evidence
either way. The finding rests on the **108 data-bearing rows** — in every one
of them, of the observations at or above that row's p99 scored debit,
**exactly zero** were covered by the IM held entering the round. That is a
measurement, not a rounding artifact, and it is unanimous across every
`(n, p, q, N)` combination with a sample. The 36 no-data rows sit at the most
abort-heavy flow cells, where no q/N would have been observable at all.

The mechanism is unsurprising: a mean-tracking EWMA of per-round debits
(which include many zero-debit rounds for each member) sits far below the p99
debit, and even q=2.0 covers only about half of all positive debits (best
cell in the whole grid: 0.5519 coverage at n=15, p=1.0, q=2.0, N=16). The
honest CALB-02 answer is unchanged by the imputation correction: **no q ≤ 2
scaling of a debit-EWMA survives the p99 rounds** on these synthetic flows,
on the evidence of 108 measured cells; a tail-covering IM needs a different
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
degrades. **Where warmup consumes every observation — n=50 at p=0.9 across
all three lookbacks, plus the N=32 columns under heavy aborts — the committed
CSV's `0.0000` is an imputed no-data marker, not a measured "the cap never
binds".** Those 36 rows are listed in the Data notes; regenerating with the
current script writes `NaN` there instead.

## 6. Decision record (D-08)

2026-07-24: CCP arc skipped by user decision; sweep documents the empirical basis

The margin data above is recorded for `docs/V2-BRIEF.md` as reference
material — there is no downstream CCP consumer of these parameters.
