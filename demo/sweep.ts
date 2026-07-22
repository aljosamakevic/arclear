/**
 * Compression sweep — answers "when is netting worth the coordination?"
 * with numbers instead of one tuned demo. Pure computation, no chain.
 *
 *   npm run sweep
 *
 * Outputs (committed to the repo):
 *   docs/sweep/sweep.csv                        full grid
 *   docs/sweep/compression-vs-reciprocity.svg   chart 1
 *   docs/sweep/collateral-vs-n.svg              chart 2
 *
 * Metrics per run:
 * - volume compression = 1 − settled/gross. NOTE: summed over all
 *   participants this is IDENTICAL to aggregate collateral saving
 *   (Σ net debits == Σ positive deltas by zero-sum), so we report it once.
 * - worst-participant collateral saving = min over net debtors of
 *   1 − netDebit_i / grossOutflow_i. This is what a single operator
 *   budgeting a collateral account actually cares about.
 *
 * Aggregation: median and p10 across seeds. Median is the marketing
 * number; p10 is what an operator budgets for.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { net } from "../src/netting.js";
import { generateFlows } from "./flowModel.js";

const SEEDS = 200;
const NOW = 1_800_000_000n;
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "sweep");
mkdirSync(outDir, { recursive: true });

interface RunMetrics {
  volComp: number; // 1 - settled/gross
  worstSaving: number; // worst net-debtor's collateral saving
  ious: number;
}

function run(n: number, density: number, reciprocity: number, seed: number): RunMetrics | null {
  const ious = generateFlows({ n, density, reciprocity, seed });
  if (ious.length === 0) return null;
  const r = net(ious, { now: NOW });
  const gross = r.grossVolume;
  if (gross === 0n) return null;

  const volComp = 1 - Number(r.settledVolume) / Number(gross);

  // per-participant gross outflow
  const outflow = new Map<string, bigint>();
  for (const s of ious) {
    const d = s.iou.debtor.toLowerCase();
    outflow.set(d, (outflow.get(d) ?? 0n) + s.iou.amount);
  }
  let worstSaving = 1;
  r.participants.forEach((p, i) => {
    const delta = r.deltas[i];
    if (delta >= 0n) return; // pure creditors need no collateral either way
    const out = outflow.get(p.toLowerCase()) ?? 0n;
    if (out === 0n) return;
    const saving = 1 - Number(-delta) / Number(out);
    if (saving < worstSaving) worstSaving = saving;
  });

  return { volComp, worstSaving, ious: ious.length };
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

interface Cell {
  n: number;
  density: number;
  reciprocity: number;
  runs: number;
  medVolComp: number;
  p10VolComp: number;
  medWorstSaving: number;
  p10WorstSaving: number;
  medIous: number;
}

function cell(n: number, density: number, reciprocity: number): Cell {
  const vol: number[] = [];
  const worst: number[] = [];
  const counts: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const m = run(n, density, reciprocity, seed * 7919 + n * 104729 + Math.round(reciprocity * 100));
    if (!m) continue;
    vol.push(m.volComp);
    worst.push(m.worstSaving);
    counts.push(m.ious);
  }
  return {
    n,
    density,
    reciprocity,
    runs: vol.length,
    medVolComp: percentile(vol, 50),
    p10VolComp: percentile(vol, 10),
    medWorstSaving: percentile(worst, 50),
    p10WorstSaving: percentile(worst, 10),
    medIous: percentile(counts, 50),
  };
}

console.log(`[sweep] ${SEEDS} seeds per cell …`);
const t0 = Date.now();

// Grid 1: compression vs reciprocity, several n, density fixed 0.5
const NS_CURVE = [3, 5, 10, 20, 50];
const RECIPS = Array.from({ length: 11 }, (_, i) => i / 10);
const grid1: Cell[] = [];
for (const n of NS_CURVE) {
  for (const rec of RECIPS) grid1.push(cell(n, 0.5, rec));
}

// Grid 2: collateral saving vs n, reciprocity fixed 0.8, density 0.5
const NS_SCALE = [2, 3, 4, 5, 8, 10, 15, 20, 30, 50];
const grid2: Cell[] = NS_SCALE.map((n) => cell(n, 0.5, 0.8));

// Grid 3: density sensitivity at n=10, reciprocity 0.8 (CSV only)
const DENSITIES = Array.from({ length: 10 }, (_, i) => (i + 1) / 10);
const grid3: Cell[] = DENSITIES.map((d) => cell(10, d, 0.8));

const all = [...grid1, ...grid2, ...grid3];
const csv = [
  "n,density,reciprocity,runs,median_volume_compression,p10_volume_compression,median_worst_participant_saving,p10_worst_participant_saving,median_iou_count",
  ...all.map((c) =>
    [c.n, c.density, c.reciprocity, c.runs, c.medVolComp.toFixed(4), c.p10VolComp.toFixed(4),
     c.medWorstSaving.toFixed(4), c.p10WorstSaving.toFixed(4), c.medIous].join(","),
  ),
].join("\n");
writeFileSync(join(outDir, "sweep.csv"), csv + "\n");

// ------------------------------------------------------------------ charts

const COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed"];

function lineChart(opts: {
  title: string;
  xLabel: string;
  yLabel: string;
  xs: number[];
  series: { name: string; ys: number[]; dashed?: boolean; color: string }[];
  xFmt?: (x: number) => string;
}): string {
  const W = 760, H = 460, ML = 64, MR = 160, MT = 48, MB = 56;
  const pw = W - ML - MR, ph = H - MT - MB;
  const xMin = Math.min(...opts.xs), xMax = Math.max(...opts.xs);
  const X = (x: number) => ML + ((x - xMin) / (xMax - xMin || 1)) * pw;
  const Y = (y: number) => MT + (1 - Math.max(0, Math.min(1, y))) * ph;
  const fmt = opts.xFmt ?? ((x: number) => String(x));

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">`;
  s += `<rect width="${W}" height="${H}" fill="white"/>`;
  s += `<text x="${ML}" y="26" font-size="16" font-weight="600" fill="#111">${opts.title}</text>`;
  for (let g = 0; g <= 10; g += 2) {
    const y = Y(g / 10);
    s += `<line x1="${ML}" y1="${y}" x2="${ML + pw}" y2="${y}" stroke="#e5e7eb"/>`;
    s += `<text x="${ML - 8}" y="${y + 4}" font-size="11" fill="#6b7280" text-anchor="end">${g * 10}%</text>`;
  }
  for (const x of opts.xs) {
    s += `<text x="${X(x)}" y="${MT + ph + 18}" font-size="11" fill="#6b7280" text-anchor="middle">${fmt(x)}</text>`;
  }
  s += `<text x="${ML + pw / 2}" y="${H - 14}" font-size="12" fill="#374151" text-anchor="middle">${opts.xLabel}</text>`;
  s += `<text x="18" y="${MT + ph / 2}" font-size="12" fill="#374151" text-anchor="middle" transform="rotate(-90 18 ${MT + ph / 2})">${opts.yLabel}</text>`;

  opts.series.forEach((ser, i) => {
    const pts = opts.xs.map((x, k) => `${X(x)},${Y(ser.ys[k])}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${ser.color}" stroke-width="2"${ser.dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
    const ly = MT + 14 + i * 18;
    s += `<line x1="${ML + pw + 12}" y1="${ly - 4}" x2="${ML + pw + 34}" y2="${ly - 4}" stroke="${ser.color}" stroke-width="2"${ser.dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
    s += `<text x="${ML + pw + 40}" y="${ly}" font-size="11" fill="#374151">${ser.name}</text>`;
  });
  return s + "</svg>";
}

writeFileSync(
  join(outDir, "compression-vs-reciprocity.svg"),
  lineChart({
    title: "Volume compression vs reciprocity (density 0.5, median of 200 seeds)",
    xLabel: "reciprocity — probability a flow has a counter-flow",
    yLabel: "volume compression",
    xs: RECIPS,
    series: [
      ...NS_CURVE.map((n, i) => ({
        name: `n=${n}`,
        color: COLORS[i],
        ys: grid1.filter((c) => c.n === n).map((c) => c.medVolComp),
      })),
      {
        name: "n=10 (p10)",
        color: COLORS[2],
        dashed: true,
        ys: grid1.filter((c) => c.n === 10).map((c) => c.p10VolComp),
      },
    ],
  }),
);

writeFileSync(
  join(outDir, "collateral-vs-n.svg"),
  lineChart({
    title: "Worst-participant collateral saving vs n (reciprocity 0.8, density 0.5)",
    xLabel: "participants (n)",
    yLabel: "collateral saving",
    xs: NS_SCALE,
    series: [
      { name: "median", color: COLORS[0], ys: grid2.map((c) => c.medWorstSaving) },
      { name: "p10 (budget case)", color: COLORS[3], dashed: true, ys: grid2.map((c) => c.p10WorstSaving) },
      { name: "volume (median)", color: COLORS[1], ys: grid2.map((c) => c.medVolComp) },
    ],
  }),
);

console.log(`[sweep] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${all.length} cells`);

// Console summary the findings write-up needs.
console.log("\nreciprocity threshold where median volume compression ≥ 30% (density 0.5):");
for (const n of NS_CURVE) {
  const row = grid1.filter((c) => c.n === n);
  const hit = row.find((c) => c.medVolComp >= 0.3);
  console.log(`  n=${String(n).padEnd(3)} → ${hit ? "reciprocity " + hit.reciprocity.toFixed(1) : "never"}`);
}
console.log("\ncompression vs n at reciprocity 0.8 (median volume / median worst-participant / p10 worst):");
for (const c of grid2) {
  console.log(
    `  n=${String(c.n).padEnd(3)} vol=${(c.medVolComp * 100).toFixed(1)}%  worst=${(c.medWorstSaving * 100).toFixed(1)}%  p10worst=${(c.p10WorstSaving * 100).toFixed(1)}%`,
  );
}
console.log("\ndensity sensitivity at n=10, reciprocity 0.8 (median volume compression):");
console.log("  " + grid3.map((c) => `${c.density.toFixed(1)}:${(c.medVolComp * 100).toFixed(0)}%`).join("  "));
