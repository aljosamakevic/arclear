import type { Address, Hex } from "viem";
import type { SignedIou } from "../src/types.js";

/**
 * Parameterized synthetic flow generator for the compression sweep.
 *
 * Two knobs (plus participant count n):
 * - `density`     ∈ [0,1] — fraction of unordered pairs that trade at all.
 * - `reciprocity` ∈ [0,1] — probability that a flow A→B is matched by a
 *   return flow B→A within the same round. At 0 the flow graph is a DAG and
 *   bilateral netting has nothing to cancel; at 1 every edge has a
 *   counter-edge (amounts still independent).
 *
 * Pure and fast: IOUs get cheap synthetic ids (the netting engine only uses
 * ids for dedup) — no signing, no hashing, no chain.
 */

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FlowParams {
  n: number;
  density: number;
  reciprocity: number;
  seed: number;
  /** IOUs per active direction, uniform 1..maxIousPerEdge (default 4). */
  maxIousPerEdge?: number;
}

const FUTURE = 4_102_444_800n;

function addr(i: number): Address {
  return `0x${(i + 1).toString(16).padStart(40, "0")}` as Address;
}

export function generateFlows(p: FlowParams): SignedIou[] {
  const rand = rng(p.seed);
  const maxPerEdge = p.maxIousPerEdge ?? 4;
  const out: SignedIou[] = [];
  let counter = 0;

  const emit = (debtor: Address, creditor: Address) => {
    const k = 1 + Math.floor(rand() * maxPerEdge);
    for (let i = 0; i < k; i++) {
      // $0.005 – $0.95 in 6-dec base units
      const amount = BigInt(5_000 + Math.floor(rand() * 945_000));
      counter++;
      out.push({
        iou: {
          debtor,
          creditor,
          amount,
          nonce: BigInt(counter),
          expiry: FUTURE,
          ref: "0x0" as Hex,
        },
        signature: "0x" as Hex,
        id: `0x${counter.toString(16).padStart(64, "0")}` as Hex,
      });
    }
  };

  for (let i = 0; i < p.n; i++) {
    for (let j = i + 1; j < p.n; j++) {
      if (rand() >= p.density) continue;
      // primary direction chosen at random
      const [a, b] = rand() < 0.5 ? [i, j] : [j, i];
      emit(addr(a), addr(b));
      if (rand() < p.reciprocity) emit(addr(b), addr(a));
    }
  }
  return out;
}
