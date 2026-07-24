/**
 * Threshold-consent sweep (CALB-01) — answers "what member count does
 * threshold consent actually unlock under realistic per-round uptime" with
 * REALIZED (post-exclusion) compression, not idealized netting numbers.
 * Pure computation over demo/thresholdModel.ts, no chain. Sibling of the
 * untouched v1 demo/sweep.ts (D-09 — v1 reproducibility preserved).
 *
 *   npm run sweep:threshold                full D-03 grid, 200 seeds/cell
 *   npm run sweep:threshold -- --quick     reduced seeds for dev runs only
 *   npm run sweep:threshold -- --rounds N  override rounds per seed
 *
 * Output (committed): docs/sweep/threshold-sweep.csv — 500 data rows:
 * n {5,10,15,30,50} x p {1.0,0.97,0.95,0.9,0.8} x 20 v1 (density,reciprocity)
 * combos. Model faithfulness to the real attemptRound is proven by
 * test/thresholdCrossValidation.test.ts (exact-match, D-02).
 *
 * Metrics per cell (D-04), aggregated across seeds:
 * - realized compression = 1 − Σ settled / Σ gross over SETTLED rounds only
 *   (median + p10 across seeds) — the post-exclusion number
 * - worst-participant saving = per-seed minimum across settled rounds of the
 *   v1 per-round metric min over net debtors of 1 − netDebit/grossOutflow
 *   (median + p10 across seeds) — what an operator budgets collateral for
 * - carry-over settlement latency in rounds, pooled (mean + p95) — the
 *   CONS-04 carry-over cost. Counts ALL paper that settled ≥1 round after
 *   becoming eligible: delayed by exclusion OR by an aborted/empty round —
 *   not exclusively the excluded member's paper. The CSV columns keep their
 *   historical *_excluded_latency_rounds names (committed data unchanged).
 * - abort_rate = aborted / (settled + aborted) rounds
 * - exclusion_round_fraction = settled-2pass / all settled rounds
 * - unsettled_fraction = Σ unsettled / Σ generated IOUs at horizon end
 *
 * Statistical division is reporting code (matching demo/sweep.ts's style) —
 * all protocol math inside the model stays bigint.
 *
 * All numbers carry the UNCALIBRATED-INPUT-DATA label (D-07): synthetic
 * flows, assumed uptime — reference-brief material, not production calibration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simulateThresholdHistory } from "./thresholdModel.js";

const argv = process.argv.slice(2);
const quick = argv.includes("--quick");
const roundsIdx = argv.indexOf("--rounds");
const requestedRounds = roundsIdx !== -1 ? Number(argv[roundsIdx + 1]) : 10;
// Fail fast BEFORE any compute or CSV write: NaN (missing/non-numeric value)
// or a non-positive count would silently overwrite the committed CSV with
// all-zero rows (WR-02).
if (roundsIdx !== -1 && (!Number.isInteger(requestedRounds) || requestedRounds < 1)) {
  throw new Error(`--rounds requires a positive integer, got ${argv[roundsIdx + 1]}`);
}
/** Rounds per simulated history (overridable: --rounds N). */
const ROUNDS_PER_SEED = requestedRounds;
/** D-03 locks 200 seeds/cell for the committed CSV; --quick is dev-only. */
const SEEDS = quick ? 20 : 200;

const N_GRID = [5, 10, 15, 30, 50];
const P_GRID = [1.0, 0.97, 0.95, 0.9, 0.8];

/** The union of v1's (density, reciprocity) combos: (0.5, r) for r in
 * 0.0..1.0 step 0.1 (11), plus (d, 0.8) for d in 0.1..1.0 step 0.1 excluding
 * the duplicate (0.5, 0.8) (9 more) = 20 combos. */
const FLOW_COMBOS: { density: number; reciprocity: number }[] = [];
for (let i = 0; i <= 10; i++) FLOW_COMBOS.push({ density: 0.5, reciprocity: i / 10 });
for (let i = 1; i <= 10; i++) {
  if (i === 5) continue; // (0.5, 0.8) already present
  FLOW_COMBOS.push({ density: i / 10, reciprocity: 0.8 });
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "sweep");
mkdirSync(outDir, { recursive: true });

/** v1-style seed mixing (seed * 7919 + n * 104729 + parameter terms) so
 * cells are decorrelated across the whole 4-dimensional grid. */
function mixSeed(s: number, n: number, p: number, density: number, reciprocity: number): number {
  return (
    (s * 7919 +
      n * 104729 +
      Math.round(reciprocity * 100) +
      Math.round(density * 100) * 31 +
      Math.round(p * 100) * 131) >>>
    0
  );
}

/** Empty samples return NaN — rendered verbatim ("NaN") by toFixed in the
 * CSV, so a cell with zero contributing observations is never conflated with
 * a measured 0.0000. NOTE: the committed docs/sweep/threshold-sweep.csv
 * predates this marker; its fully-empty cells (n=50, p=0.8: abort_rate
 * 1.0000 ∧ unsettled_fraction 1.0000) read imputed 0.0000 — see
 * docs/CALIBRATION.md "Data notes". */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

interface CellRow {
  n: number;
  p: number;
  density: number;
  reciprocity: number;
  medComp: number;
  p10Comp: number;
  medWorst: number;
  p10Worst: number;
  meanLatency: number;
  p95Latency: number;
  abortRate: number;
  exclusionFraction: number;
  unsettledFraction: number;
}

function cell(n: number, p: number, density: number, reciprocity: number): CellRow {
  const compressions: number[] = [];
  const worstSavings: number[] = [];
  const latencies: number[] = [];
  let settledRounds = 0;
  let abortedRounds = 0;
  let twoPassRounds = 0;
  let generated = 0;
  let unsettled = 0;

  for (let s = 1; s <= SEEDS; s++) {
    const h = simulateThresholdHistory({
      n,
      density,
      reciprocity,
      seed: mixSeed(s, n, p, density, reciprocity),
      rounds: ROUNDS_PER_SEED,
      uptime: p,
    });

    let sumSettled = 0n;
    let sumGross = 0n;
    let seedWorst = Infinity;
    for (const rec of h.records) {
      if (rec.kind === "aborted") {
        abortedRounds++;
        continue;
      }
      if (rec.kind === "empty") continue;
      settledRounds++;
      if (rec.kind === "settled-2pass") twoPassRounds++;
      sumSettled += rec.settledVolume;
      sumGross += rec.grossVolume;

      // v1 per-round metric: min over net debtors of 1 − netDebit/grossOutflow
      // over this round's CONSUMED set (outflows is the frozen 03-01 field).
      let roundWorst = 1;
      for (const [member, delta] of rec.deltas) {
        if (delta >= 0n) continue; // pure creditors need no collateral
        const outflow = rec.outflows.get(member) ?? 0n;
        if (outflow === 0n) continue;
        const saving = 1 - Number(-delta) / Number(outflow);
        if (saving < roundWorst) roundWorst = saving;
      }
      if (roundWorst < seedWorst) seedWorst = roundWorst;
    }
    for (const l of h.excludedLatencies) latencies.push(l);
    generated += h.generatedCount;
    unsettled += h.unsettledCount;

    // Realized (post-exclusion) compression over settled rounds only (D-04).
    if (sumGross > 0n) compressions.push(1 - Number(sumSettled) / Number(sumGross));
    if (seedWorst !== Infinity) worstSavings.push(seedWorst);
  }

  const attempted = settledRounds + abortedRounds;
  return {
    n,
    p,
    density,
    reciprocity,
    medComp: percentile(compressions, 50),
    p10Comp: percentile(compressions, 10),
    medWorst: percentile(worstSavings, 50),
    p10Worst: percentile(worstSavings, 10),
    meanLatency: mean(latencies),
    p95Latency: percentile(latencies, 95),
    abortRate: attempted === 0 ? 0 : abortedRounds / attempted,
    exclusionFraction: settledRounds === 0 ? 0 : twoPassRounds / settledRounds,
    unsettledFraction: generated === 0 ? 0 : unsettled / generated,
  };
}

console.log(
  `[sweep:threshold] ${SEEDS} seeds x ${ROUNDS_PER_SEED} rounds per cell, ` +
    `${N_GRID.length * P_GRID.length * FLOW_COMBOS.length} cells … [UNCALIBRATED-INPUT-DATA]`,
);
const t0 = Date.now();

const rows: CellRow[] = [];
for (const n of N_GRID) {
  for (const p of P_GRID) {
    const g0 = Date.now();
    for (const combo of FLOW_COMBOS) rows.push(cell(n, p, combo.density, combo.reciprocity));
    console.log(
      `[sweep:threshold] n=${n} p=${p} done (${((Date.now() - g0) / 1000).toFixed(1)}s, ` +
        `total ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }
}

const HEADER =
  "n,p,density,reciprocity,seeds,rounds_per_seed,median_realized_compression," +
  "p10_realized_compression,median_worst_saving,p10_worst_saving," +
  "mean_excluded_latency_rounds,p95_excluded_latency_rounds,abort_rate," +
  "exclusion_round_fraction,unsettled_fraction";
const csv = [
  HEADER,
  ...rows.map((c) =>
    [
      c.n,
      c.p,
      c.density,
      c.reciprocity,
      SEEDS,
      ROUNDS_PER_SEED,
      c.medComp.toFixed(4),
      c.p10Comp.toFixed(4),
      c.medWorst.toFixed(4),
      c.p10Worst.toFixed(4),
      c.meanLatency.toFixed(4),
      c.p95Latency.toFixed(4),
      c.abortRate.toFixed(4),
      c.exclusionFraction.toFixed(4),
      c.unsettledFraction.toFixed(4),
    ].join(","),
  ),
].join("\n");
writeFileSync(join(outDir, "threshold-sweep.csv"), csv + "\n");
console.log(
  `[sweep:threshold] wrote docs/sweep/threshold-sweep.csv (${rows.length} data rows) ` +
    `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);

// ------------------------------------------------------- D-05 headline table

const HEADLINE_NS = [15, 30, 50];
const HEADLINE_PS = [1.0, 0.95, 0.9];
const find = (n: number, p: number) =>
  rows.find((c) => c.n === n && c.p === p && c.density === 0.5 && c.reciprocity === 0.8)!;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);

console.log(
  "\nD-05 headline — realized compression (median) / worst-participant saving (p10)",
);
console.log(
  `density 0.5, reciprocity 0.8, ${SEEDS} seeds x ${ROUNDS_PER_SEED} rounds [UNCALIBRATED-INPUT-DATA]\n`,
);
console.log(
  "        " +
    HEADLINE_PS.map((p) => `p=${p.toFixed(2)}${p === 1.0 ? " (ideal)" : ""}`.padEnd(26)).join(""),
);
for (const n of HEADLINE_NS) {
  const cells = HEADLINE_PS.map((p) => {
    const c = find(n, p);
    return `comp ${pct(c.medComp)} p10 ${pct(c.p10Worst)}`.padEnd(26);
  });
  console.log(`  n=${String(n).padEnd(4)}${cells.join("")}`);
}

// v1 idealized baseline for eyeballing: single-shot netting at p=1.0 from the
// committed v1 sweep (grid2: density 0.5, reciprocity 0.8). The threshold
// model's p=1.0 column should closely track these.
const v1Path = join(outDir, "sweep.csv");
if (existsSync(v1Path)) {
  const v1 = readFileSync(v1Path, "utf8").trim().split("\n").slice(1);
  console.log("\nv1 idealized baseline (docs/sweep/sweep.csv, single-shot netting, p=1.0):");
  for (const n of HEADLINE_NS) {
    const row = v1
      .map((l) => l.split(","))
      .find((f) => Number(f[0]) === n && Number(f[1]) === 0.5 && Number(f[2]) === 0.8);
    if (!row) continue;
    console.log(
      `  n=${String(n).padEnd(4)}vol ${pct(Number(row[4]))}  p10worst ${pct(Number(row[7]))}`,
    );
  }
}
