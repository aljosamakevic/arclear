/**
 * EWMA initial-margin coverage sweep (CALB-02, D-06) — answers "what q/N
 * margin parameters would survive the p10/p99 rounds" over the SAME simulated
 * flow histories the threshold model produces. Pure computation over
 * demo/thresholdModel.ts, no chain. Sibling of demo/thresholdSweep.ts (D-09 —
 * zero new dependencies, v1 sweep untouched).
 *
 *   npm run sweep:margin                 full grid, 200 seeds/cell
 *   npm run sweep:margin -- --quick      reduced seeds for dev runs only
 *   npm run sweep:margin -- --rounds N   override rounds per seed (floor 64)
 *
 * Flow cells (12), all at density 0.5 / reciprocity 0.8 (the canonical v1
 * operating point):
 * - 9 constant-uptime cells: n {15,30,50} x p {1.0,0.95,0.9}
 * - 3 stress-ramp cells: n {15,30,50} with per-round uptime ramping linearly
 *   1.0 (round 0) -> 0.8 (final round) — the D-06 procyclicality stress
 *
 * Per (flow cell, seed): one simulateThresholdHistory run; each member's
 * realized debit series over SETTLED rounds only (debit = -delta when
 * delta < 0n, else 0n; aborted/empty rounds contribute no observation and do
 * not advance EWMA state). Then for each (q, N) in q {1.0,1.25,1.5,2.0} x
 * EWMA lookback N {8,16,32}:
 * - EWMA per member, smoothing lambda = 2 / (N + 1), state seeded at 0
 * - CAUSALITY: IM_t = q * ewma_(t-1) — the margin held ENTERING settled round
 *   t is computed from rounds strictly before t. Never lookahead: the EWMA
 *   state is updated with round t's debit only AFTER IM_t is scored.
 * - Warmup: each member's first N settled rounds are excluded from scoring
 *   (EWMA state immature)
 * - coverage_rate = fraction of scored positive-debit observations with
 *   IM_t >= debit_t, pooled across the cell's seeds
 * - p99_debit = 99th percentile of scored positive debits (base units,
 *   integer); p99_tail_coverage = fraction of observations at or above
 *   p99_debit that IM covered — the "does q/N survive the tail" answer
 * - cap_binding_fraction = fraction of scored observations where the uncapped
 *   IM demanded a rise of more than 25% over the previous round's IM (where a
 *   +25%-per-round IM rise cap — the procyclicality guard — would bind and
 *   leave the member under-margined)
 * - scored_observations / scored_positive_debits = the two sample sizes those
 *   ratios divide by, emitted so every row is self-verifying
 *
 * EMPTY SAMPLES ARE NaN, NEVER 0. At high-abort cells the warmup (first N
 * settled rounds per member) can consume every settled round, leaving a (q,N)
 * row with no observation at all. Such rows emit "NaN" — a measured 0.0000 and
 * "no data" must never be conflated (mirrors demo/thresholdSweep.ts). The
 * committed docs/sweep/margin-sweep.csv PREDATES this marker: 36 of its 144
 * rows are zero-observation cells whose four value columns read imputed
 * 0.0000, and it has neither sample-size column. It is kept byte-identical;
 * docs/CALIBRATION.md "Data notes (margin-sweep.csv)" enumerates the affected
 * rows.
 *
 * Statistical division is reporting code (matching demo/sweep.ts's style) —
 * all protocol math inside the model stays bigint. Do not tune q/N or the
 * ramp to flatter coverage: honest numbers are the deliverable.
 *
 * All numbers carry the UNCALIBRATED-INPUT-DATA label (D-07): synthetic
 * flows, assumed uptime — reference-brief material, not production calibration.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addr } from "./flowModel.js";
import { simulateThresholdHistory } from "./thresholdModel.js";

const argv = process.argv.slice(2);
const quick = argv.includes("--quick");
const roundsIdx = argv.indexOf("--rounds");
const requestedRounds = roundsIdx !== -1 ? Number(argv[roundsIdx + 1]) : 64;
// Fail fast BEFORE any compute or CSV write: NaN (missing/non-numeric value)
// or a non-positive count would defeat the Math.max floor (Math.max(64, NaN)
// is NaN) and silently overwrite the committed CSV with all-zero rows (WR-02).
if (roundsIdx !== -1 && (!Number.isInteger(requestedRounds) || requestedRounds < 1)) {
  throw new Error(`--rounds requires a positive integer, got ${argv[roundsIdx + 1]}`);
}
/** Rounds per simulated history. Hard floor 64 (>= 2x the largest lookback
 * N=32 so EWMA state matures) — the sanctioned runtime lever is the model's
 * internal settled-id pruning, never shorter histories. */
const ROUNDS_PER_SEED = Math.max(64, requestedRounds);
if (requestedRounds < 64) {
  console.warn(`[sweep:margin] --rounds ${requestedRounds} below floor, clamped to 64`);
}
/** 200 seeds/cell for the committed CSV; --quick is dev-only. */
const SEEDS = quick ? 20 : 200;

const DENSITY = 0.5;
const RECIPROCITY = 0.8;
const N_GRID = [15, 30, 50];
const P_GRID = [1.0, 0.95, 0.9];
const Q_GRID = [1.0, 1.25, 1.5, 2.0];
const LOOKBACK_GRID = [8, 16, 32];

/** One flow cell: constant uptime p, or the D-06 linear stress ramp. */
interface FlowCell {
  n: number;
  /** CSV p_or_ramp value: the constant p or the literal "ramp-1.0-0.8". */
  label: string;
  uptime: number | number[];
  /** Scalar folded into the seed mix so cells stay decorrelated. */
  pCode: number;
}

/** Linear per-round uptime schedule from 1.0 (round 0) to 0.8 (final round). */
function rampSchedule(rounds: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < rounds; r++) out.push(1.0 - 0.2 * (rounds === 1 ? 1 : r / (rounds - 1)));
  return out;
}

const FLOW_CELLS: FlowCell[] = [];
for (const n of N_GRID) {
  for (const p of P_GRID) {
    FLOW_CELLS.push({ n, label: String(p), uptime: p, pCode: Math.round(p * 100) });
  }
}
for (const n of N_GRID) {
  FLOW_CELLS.push({
    n,
    label: "ramp-1.0-0.8",
    uptime: rampSchedule(ROUNDS_PER_SEED),
    pCode: 9999,
  });
}

/** v1-style seed mixing so cells are decorrelated across the grid (matches
 * thresholdSweep's convention; ramp cells use pCode 9999). */
function mixSeed(s: number, n: number, pCode: number): number {
  return (
    (s * 7919 +
      n * 104729 +
      Math.round(RECIPROCITY * 100) +
      Math.round(DENSITY * 100) * 31 +
      pCode * 131) >>>
    0
  );
}

/** Empty samples are reported as NaN (rendered verbatim "NaN" by toFixed) and
 * never as a measured 0.0000 — the same convention demo/thresholdSweep.ts uses.
 * Two independent sample sizes drive a row and are emitted alongside it:
 * `scoredObservations` (all post-warmup observations, the denominator of
 * cap_binding_fraction) and `scoredPositiveDebits` (the subset with a positive
 * debit, the denominator of coverage_rate / p99_debit / p99_tail_coverage).
 * A row can legitimately have observations but no positive debits, so the two
 * are marked independently. NOTE: the committed docs/sweep/margin-sweep.csv
 * predates this marker and these two columns — 36 of its 144 rows are
 * zero-observation cells whose four value columns read imputed 0.0000; see
 * docs/CALIBRATION.md "Data notes (margin-sweep.csv)". */
interface ComboRow {
  q: number;
  lookback: number;
  /** Post-warmup observations (denominator of capBindingFraction). */
  scoredObservations: number;
  /** Post-warmup observations with a positive debit (denominator of the rest). */
  scoredPositiveDebits: number;
  coverageRate: number;
  /** null when no positive debit was scored — rendered "NaN", never 0. */
  p99Debit: bigint | null;
  p99TailCoverage: number;
  capBindingFraction: number;
}

/** CSV cell for a possibly-absent bigint statistic. */
function fmtDebit(x: bigint | null): string {
  return x === null ? "NaN" : x.toString();
}

/** All 12 (q,N) rows for one flow cell. */
function runCell(fc: FlowCell): ComboRow[] {
  const members: string[] = [];
  for (let i = 0; i < fc.n; i++) members.push(addr(i).toLowerCase());

  // Per-seed, member-major debit series over settled rounds only. A settled
  // round yields one observation per member (0n for non-participants and net
  // creditors); aborted/empty rounds yield none and never advance EWMA state.
  const seriesBySeed: bigint[][][] = [];
  for (let s = 1; s <= SEEDS; s++) {
    const h = simulateThresholdHistory({
      n: fc.n,
      density: DENSITY,
      reciprocity: RECIPROCITY,
      seed: mixSeed(s, fc.n, fc.pCode),
      rounds: ROUNDS_PER_SEED,
      uptime: fc.uptime,
    });
    const series: bigint[][] = members.map(() => []);
    for (const rec of h.records) {
      if (rec.kind !== "settled-1pass" && rec.kind !== "settled-2pass") continue;
      for (let i = 0; i < members.length; i++) {
        const delta = rec.deltas.get(members[i]) ?? 0n;
        series[i].push(delta < 0n ? -delta : 0n);
      }
    }
    seriesBySeed.push(series);
  }

  const rows: ComboRow[] = [];
  for (const q of Q_GRID) {
    for (const lookback of LOOKBACK_GRID) {
      const lambda = 2 / (lookback + 1);
      let scoredAll = 0;
      let capBinding = 0;
      // Scored positive-debit observations with their coverage outcome —
      // kept so the p99 tail can be re-scanned after the percentile is known.
      const positives: { debit: bigint; covered: boolean }[] = [];

      for (const series of seriesBySeed) {
        for (const memberSeries of series) {
          let ewma = 0;
          let imPrev = 0;
          for (let t = 0; t < memberSeries.length; t++) {
            // IM entering settled round t — computed BEFORE observing round
            // t's debit (causal: only rounds < t feed ewma).
            const im = q * ewma;
            const debit = Number(memberSeries[t]);
            if (t >= lookback) {
              scoredAll++;
              // Uncapped IM demanded a >25% rise over last round's IM: the
              // +25%/round rise cap would bind here.
              if (im > 1.25 * imPrev) capBinding++;
              if (memberSeries[t] > 0n) {
                positives.push({ debit: memberSeries[t], covered: im >= debit });
              }
            }
            imPrev = im;
            ewma = lambda * debit + (1 - lambda) * ewma;
          }
        }
      }

      const coveredCount = positives.reduce((acc, o) => acc + (o.covered ? 1 : 0), 0);
      // p99 over scored positive debits (bigint-exact; same index convention
      // as thresholdSweep's percentile helper). null — never 0n — when the
      // sample is empty, so no-data is never read as "the p99 debit was zero".
      let p99Debit: bigint | null = null;
      if (positives.length > 0) {
        const sorted = positives.map((o) => o.debit).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        p99Debit = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))];
      }
      const tail = p99Debit === null ? [] : positives.filter((o) => o.debit >= p99Debit);
      const tailCovered = tail.reduce((acc, o) => acc + (o.covered ? 1 : 0), 0);

      rows.push({
        q,
        lookback,
        scoredObservations: scoredAll,
        scoredPositiveDebits: positives.length,
        // NaN, not 0: a cell with zero contributing observations must never be
        // conflated with a measured 0.0000 (mirrors thresholdSweep's marker).
        coverageRate: positives.length === 0 ? NaN : coveredCount / positives.length,
        p99Debit,
        p99TailCoverage: tail.length === 0 ? NaN : tailCovered / tail.length,
        capBindingFraction: scoredAll === 0 ? NaN : capBinding / scoredAll,
      });
    }
  }
  return rows;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "sweep");
mkdirSync(outDir, { recursive: true });

console.log(
  `[sweep:margin] ${SEEDS} seeds x ${ROUNDS_PER_SEED} rounds per cell, ` +
    `${FLOW_CELLS.length} flow cells x ${Q_GRID.length * LOOKBACK_GRID.length} (q,N) combos ` +
    `… [UNCALIBRATED-INPUT-DATA]`,
);
const t0 = Date.now();

const HEADER =
  "n,p_or_ramp,density,reciprocity,seeds,rounds_per_seed,q,ewma_lookback," +
  "scored_observations,scored_positive_debits," +
  "coverage_rate,p99_debit,p99_tail_coverage,cap_binding_fraction";
const lines: string[] = [HEADER];

for (const fc of FLOW_CELLS) {
  const c0 = Date.now();
  const rows = runCell(fc);
  for (const r of rows) {
    lines.push(
      [
        fc.n,
        fc.label,
        DENSITY,
        RECIPROCITY,
        SEEDS,
        ROUNDS_PER_SEED,
        r.q,
        r.lookback,
        r.scoredObservations,
        r.scoredPositiveDebits,
        r.coverageRate.toFixed(4),
        fmtDebit(r.p99Debit),
        r.p99TailCoverage.toFixed(4),
        r.capBindingFraction.toFixed(4),
      ].join(","),
    );
  }
  // Rank only rows that have data — a NaN row is no-data, not a worst case.
  const scored = rows.filter((r) => r.scoredPositiveDebits > 0);
  const noData = rows.length - scored.length;
  if (scored.length === 0) {
    console.log(
      `[sweep:margin] n=${fc.n} ${fc.label}: NO DATA — all ${rows.length} (q,N) rows have ` +
        `zero scored positive-debit observations (warmup consumes every settled round) ` +
        `(${((Date.now() - c0) / 1000).toFixed(1)}s, total ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    continue;
  }
  const best = scored.reduce((a, b) => (b.coverageRate > a.coverageRate ? b : a));
  const worst = scored.reduce((a, b) => (b.coverageRate < a.coverageRate ? b : a));
  console.log(
    `[sweep:margin] n=${fc.n} ${fc.label}: best (q=${best.q},N=${best.lookback}) ` +
      `cov ${(best.coverageRate * 100).toFixed(1)}% tail ${(best.p99TailCoverage * 100).toFixed(1)}% | ` +
      `worst (q=${worst.q},N=${worst.lookback}) cov ${(worst.coverageRate * 100).toFixed(1)}% ` +
      `tail ${(worst.p99TailCoverage * 100).toFixed(1)}% ` +
      (noData > 0 ? `| ${noData}/${rows.length} rows NO DATA ` : "") +
      `(${((Date.now() - c0) / 1000).toFixed(1)}s, total ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}

writeFileSync(join(outDir, "margin-sweep.csv"), lines.join("\n") + "\n");
console.log(
  `[sweep:margin] wrote docs/sweep/margin-sweep.csv (${lines.length - 1} data rows) ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)}s [UNCALIBRATED-INPUT-DATA]`,
);
