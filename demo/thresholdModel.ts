import type { Hex } from "viem";
import { net } from "../src/netting.js";
import type { NetResult, SignedIou } from "../src/types.js";
import { addr, generateFlows, rng } from "./flowModel.js";

/**
 * Pure threshold-consent simulation model (D-01): a netting-level replica of
 * `demo/coordinator.ts` `attemptRound`'s two-pass exclude-and-recompute
 * semantics, driven by seeded per-member availability draws. No timers, no
 * async, no chain — fast enough for the ~1M simulated rounds CALB-01/CALB-02
 * need at 200 seeds/cell. Faithfulness to the real attemptRound is proven
 * separately by plan 03-02's exact-match cross-validation, which replays the
 * SAME draw stream (availabilityUniforms) and the SAME per-round flow batches
 * (roundFlowBatch / deriveRoundSeed) against the real coordinator.
 *
 * Per simulated round, mirroring attemptRound's five outcome branches:
 * 1. fresh seeded flow batch joins the open pool (round-unique ids);
 * 2. net() over the pool with accumulated settledIds (never settle twice);
 * 3. participants < 2  -> "empty" (attemptRound's exact quorum check);
 * 4. pass-1 offline candidates == none -> "settled-1pass";
 * 5. otherwise exclude ALL offline candidates in one batch (D-02), drop every
 *    IOU touching an excluded member (rebuildProposal's rule), re-net;
 *    rebuilt participants < 2 -> "aborted" (quorum floor);
 * 6. any rebuilt participant offline in its independent pass-2 draw ->
 *    "aborted" (D-03 hard 2-pass cap); else "settled-2pass".
 *
 * All money math is bigint (no division anywhere in protocol math); only
 * probabilities and latencies are numbers.
 */

/** Same round timestamp as demo/sweep.ts — far before every synthetic expiry. */
const NOW = 1_800_000_000n;

/** Parameters for one simulated multi-round history. */
export interface ThresholdParams {
  n: number;
  density: number;
  reciprocity: number;
  seed: number;
  /** Simulated rounds per history. */
  rounds: number;
  /** Constant per-round uptime p, or a per-round schedule for stress ramps. */
  uptime: number | number[];
  /** Passed through to generateFlows (IOUs per active direction). */
  maxIousPerEdge?: number;
}

/** One simulated round's outcome — rich enough for the CALB-01 sweep metrics
 * and the CALB-02 margin debit series. */
export interface ThresholdRoundRecord {
  kind: "settled-1pass" | "settled-2pass" | "aborted" | "empty";
  /** Lowercase addresses excluded in this round; [] for 1-pass rounds. */
  excluded: string[];
  settledVolume: bigint;
  /** Over the consumed set only, straight from NetResult. */
  grossVolume: bigint;
  consumedCount: number;
  /** Lowercase address -> signed delta; empty Map for aborted/empty rounds. */
  deltas: Map<string, bigint>;
  /** Lowercase debtor -> gross outflow over this round's CONSUMED set; empty
   * Map for aborted/empty rounds. Feeds 03-02's worst-participant-saving
   * metric and 03-03's margin debit series. */
  outflows: Map<string, bigint>;
}

/** A full simulated history plus the carry-over accounting CALB-01 reports. */
export interface ThresholdHistory {
  records: ThresholdRoundRecord[];
  /** Settlement latency in rounds for every IOU that was candidate-eligible
   * at least one round before it settled (excluded/carried paper only). */
  excludedLatencies: number[];
  /** Total IOUs generated across the history. */
  generatedCount: number;
  /** IOUs still open (never consumed) at horizon end. */
  unsettledCount: number;
}

/**
 * The SHARED availability draw stream (also replayed by 03-02's
 * cross-validation harness against the real attemptRound). Length
 * rounds*n*2, from rng(seed ^ 0x5eed) in fixed round-major order: for each
 * round r, for each member i, pass-1 uniform then pass-2 uniform. Member i is
 * online in pass k of round r iff uniforms[r*n*2 + i*2 + (k-1)] < p_r
 * (strict less-than).
 */
export function availabilityUniforms(seed: number, rounds: number, n: number): Float64Array {
  const rand = rng(seed ^ 0x5eed);
  const out = new Float64Array(rounds * n * 2);
  for (let k = 0; k < out.length; k++) out[k] = rand();
  return out;
}

/** Fixed per-round flow seed derivation — shared verbatim with 03-02. */
export function deriveRoundSeed(seed: number, round: number): number {
  return (seed * 31 + round * 2654435761) >>> 0;
}

/**
 * Round r's fresh flow batch with ROUND-UNIQUE ids. generateFlows resets its
 * id counter every call, so raw batches from different rounds share identical
 * ids — net() rule 1 would dedup them and rule 3 would drop them against
 * settledIds once an earlier round settles, silently discarding fresh paper.
 * We fold the round index into the high 8 nibbles of the 32-byte id and keep
 * generateFlows' per-batch counter in the low nibbles. Shared with 03-02's
 * cross-validation harness (which remaps addresses only, never ids).
 */
export function roundFlowBatch(
  seed: number,
  round: number,
  params: Pick<ThresholdParams, "n" | "density" | "reciprocity" | "maxIousPerEdge">,
): SignedIou[] {
  const batch = generateFlows({
    n: params.n,
    density: params.density,
    reciprocity: params.reciprocity,
    maxIousPerEdge: params.maxIousPerEdge,
    seed: deriveRoundSeed(seed, round),
  });
  const tag = (round >>> 0).toString(16).padStart(8, "0");
  return batch.map((s) => ({ ...s, id: `0x${tag}${s.id.slice(10)}` as Hex }));
}

/**
 * Simulate one multi-round exclude-and-recompute history. Pure and seeded:
 * the same params always produce a byte-identical history — all randomness
 * flows from availabilityUniforms and deriveRoundSeed so plan 03-02 can
 * replay identical histories against the real attemptRound.
 */
export function simulateThresholdHistory(params: ThresholdParams): ThresholdHistory {
  const { n, rounds, seed, uptime } = params;
  const uniforms = availabilityUniforms(seed, rounds, n);
  const members: string[] = [];
  for (let i = 0; i < n; i++) members.push(addr(i).toLowerCase());

  const settledIds = new Set<Hex>();
  let openPool: SignedIou[] = [];
  const firstEligibleRound = new Map<string, number>();
  const records: ThresholdRoundRecord[] = [];
  const excludedLatencies: number[] = [];
  let generatedCount = 0;

  const nonSettlingRecord = (
    kind: "aborted" | "empty",
    excluded: string[],
  ): ThresholdRoundRecord => ({
    kind,
    excluded,
    settledVolume: 0n,
    grossVolume: 0n,
    consumedCount: 0,
    deltas: new Map<string, bigint>(),
    outflows: new Map<string, bigint>(),
  });

  const settle = (
    result: NetResult,
    kind: "settled-1pass" | "settled-2pass",
    excluded: string[],
    r: number,
  ): void => {
    const consumed = new Set<string>(result.consumedIds);
    const deltas = new Map<string, bigint>();
    result.participants.forEach((p, i) => deltas.set(p.toLowerCase(), result.deltas[i]));
    const outflows = new Map<string, bigint>();
    for (const s of openPool) {
      if (!consumed.has(s.id.toLowerCase())) continue;
      const debtor = s.iou.debtor.toLowerCase();
      outflows.set(debtor, (outflows.get(debtor) ?? 0n) + s.iou.amount);
    }
    // CONS-04 "never twice": consumed ids join settledIds only on settlement.
    for (const id of result.consumedIds) {
      settledIds.add(id);
      const latency = r - (firstEligibleRound.get(id) ?? r);
      // Paper that settled in its first eligible round is not excluded paper.
      if (latency >= 1) excludedLatencies.push(latency);
    }
    // Value-neutral prune (net() rule 3 drops them anyway) — keeps long
    // histories linear instead of quadratic in generated paper.
    openPool = openPool.filter((s) => !settledIds.has(s.id.toLowerCase() as Hex));
    records.push({
      kind,
      excluded,
      settledVolume: result.settledVolume,
      grossVolume: result.grossVolume,
      consumedCount: result.consumedIds.length,
      deltas,
      outflows,
    });
  };

  for (let r = 0; r < rounds; r++) {
    const p = typeof uptime === "number" ? uptime : uptime[r];

    // 1. Fresh round-unique paper joins the open pool.
    const batch = roundFlowBatch(seed, r, params);
    generatedCount += batch.length;
    for (const s of batch) {
      openPool.push(s);
      firstEligibleRound.set(s.id.toLowerCase(), r);
    }

    // 2. Candidate netting over the open pool (rule 3 drops settled ids).
    const result = net(openPool, { now: NOW, settledIds });

    // 3. Mirror attemptRound's exact check: participant count, not deltas.
    if (result.participants.length < 2) {
      records.push(nonSettlingRecord("empty", []));
      continue;
    }

    // 4. Pass-1 availability: offline members intersected with candidates.
    const candidateSet = new Set(result.participants.map((a) => a.toLowerCase()));
    const excluded: string[] = [];
    for (let i = 0; i < n; i++) {
      const online = uniforms[r * n * 2 + i * 2] < p;
      if (!online && candidateSet.has(members[i])) excluded.push(members[i]);
    }
    if (excluded.length === 0) {
      settle(result, "settled-1pass", [], r);
      continue;
    }

    // 5. D-02 single-batch exclusion + rebuildProposal's drop rule: filter
    // every IOU whose debtor OR creditor is excluded, then re-net. (We skip
    // rebuildProposal itself — its keccak digests are pure waste at ~1M
    // simulated rounds; 03-02 proves this is not a semantic difference.)
    const ex = new Set(excluded);
    const filtered = openPool.filter(
      (s) => !ex.has(s.iou.debtor.toLowerCase()) && !ex.has(s.iou.creditor.toLowerCase()),
    );
    const rebuilt = net(filtered, { now: NOW, settledIds });
    if (rebuilt.participants.length < 2) {
      records.push(nonSettlingRecord("aborted", excluded)); // quorum floor (D-01)
      continue;
    }

    // 6. Pass-2 availability: every rebuilt participant checked against its
    // INDEPENDENT pass-2 uniform; any stall aborts (D-03 hard 2-pass cap).
    const rebuiltSet = new Set(rebuilt.participants.map((a) => a.toLowerCase()));
    let stalled = false;
    for (let i = 0; i < n; i++) {
      if (!rebuiltSet.has(members[i])) continue;
      if (!(uniforms[r * n * 2 + i * 2 + 1] < p)) {
        stalled = true;
        break;
      }
    }
    if (stalled) {
      records.push(nonSettlingRecord("aborted", excluded));
      continue;
    }
    settle(rebuilt, "settled-2pass", excluded, r);
  }

  return { records, excludedLatencies, generatedCount, unsettledCount: openPool.length };
}
