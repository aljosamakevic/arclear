import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { net } from "../src/netting.js";
import type { SignedIou } from "../src/types.js";
import {
  availabilityUniforms,
  roundFlowBatch,
  simulateThresholdHistory,
  type ThresholdParams,
} from "../demo/thresholdModel.js";

const NOW = 1_800_000_000n;

/** flowModel's addr(i) formula — lowercase, matching the model's member keys. */
function memberAddr(i: number): string {
  return `0x${(i + 1).toString(16).padStart(40, "0")}`;
}

/** Round-0 pass-1/pass-2 uniforms per member, from the shared draw stream. */
function roundZeroUniforms(seed: number, n: number): { p1: number[]; p2: number[] } {
  const u = availabilityUniforms(seed, 1, n);
  return {
    p1: Array.from({ length: n }, (_, i) => u[i * 2]),
    p2: Array.from({ length: n }, (_, i) => u[i * 2 + 1]),
  };
}

/** Deterministic seed search so forced-exclusion scenarios need no mocking. */
function findSeed(pred: (seed: number) => boolean): number {
  for (let s = 1; s <= 5000; s++) if (pred(s)) return s;
  throw new Error("no seed in 1..5000 satisfies the scenario predicate");
}

describe("thresholdModel attemptRound-mirroring behaviors", () => {
  it("p=1.0 degenerates to plain net() over the open pool, all settled-1pass", () => {
    const params: ThresholdParams = {
      n: 5,
      density: 1,
      reciprocity: 0.6,
      seed: 42,
      rounds: 3,
      uptime: 1.0,
    };
    const h = simulateThresholdHistory(params);
    expect(h.records).toHaveLength(3);

    // Independent replica: accumulate batches, net directly, compare per round.
    const settledIds = new Set<Hex>();
    let pool: SignedIou[] = [];
    h.records.forEach((rec, r) => {
      pool = pool.concat(roundFlowBatch(params.seed, r, params));
      const direct = net(pool, { now: NOW, settledIds });
      expect(rec.kind).toBe("settled-1pass");
      expect(rec.excluded).toEqual([]);
      expect(rec.settledVolume).toBe(direct.settledVolume);
      expect(rec.grossVolume).toBe(direct.grossVolume);
      expect(rec.consumedCount).toBe(direct.consumedIds.length);
      for (const id of direct.consumedIds) settledIds.add(id);
    });
    expect(h.excludedLatencies).toEqual([]);
    expect(h.unsettledCount).toBe(0);
  });

  it("forced exclusion: settled-2pass, no paper touching the excluded member, carry settles later exactly once", () => {
    const n = 5;
    // Seed where member 0's round-0 pass-1 uniform strictly dominates every
    // other member's pass-1 AND pass-2 uniform: with p = that value, member 0
    // is offline in pass 1 and everyone else survives both passes.
    const seed = findSeed((s) => {
      const { p1, p2 } = roundZeroUniforms(s, n);
      return (
        p1.slice(1).every((u) => u < p1[0]) &&
        p2.slice(1).every((u) => u < p1[0])
      );
    });
    const p0 = roundZeroUniforms(seed, n).p1[0];
    const params: ThresholdParams = {
      n,
      density: 1,
      reciprocity: 1,
      seed,
      rounds: 3,
      uptime: [p0, 1.0, 1.0],
    };
    const h = simulateThresholdHistory(params);
    const m0 = memberAddr(0);
    const b0 = roundFlowBatch(seed, 0, params);
    const b1 = roundFlowBatch(seed, 1, params);
    const b2 = roundFlowBatch(seed, 2, params);
    const touching0 = b0.filter(
      (s) => s.iou.debtor.toLowerCase() === m0 || s.iou.creditor.toLowerCase() === m0,
    );
    expect(touching0.length).toBeGreaterThan(0); // density 1: member 0 trades

    // Round 0: two-pass settle excluding only member 0; none of its paper consumed.
    expect(h.records[0].kind).toBe("settled-2pass");
    expect(h.records[0].excluded).toEqual([m0]);
    expect(h.records[0].deltas.has(m0)).toBe(false);
    expect(h.records[0].outflows.has(m0)).toBe(false);
    expect(h.records[0].consumedCount).toBe(b0.length - touching0.length);

    // Round 1 (p=1.0): fresh batch + carried member-0 paper settles, exactly once.
    expect(h.records[1].kind).toBe("settled-1pass");
    expect(h.records[1].consumedCount).toBe(b1.length + touching0.length);
    expect(h.records[2].consumedCount).toBe(b2.length);
    expect(h.generatedCount).toBe(b0.length + b1.length + b2.length);
    expect(h.unsettledCount).toBe(0);
    // Every carried IOU settled one round after first eligibility.
    expect(h.excludedLatencies).toEqual(touching0.map(() => 1));
  });

  it("pass-2 stall aborts: empty deltas, nothing enters settledIds, all paper carries", () => {
    const n = 5;
    // Member 0 offline in pass 1 (excluded); some other member online in pass 1
    // but offline in its independent pass-2 draw -> the rebuilt attempt aborts.
    const seed = findSeed((s) => {
      const { p1, p2 } = roundZeroUniforms(s, n);
      return (
        p1.slice(1).every((u) => u < p1[0]) &&
        p2.some((u, i) => i !== 0 && u >= p1[0])
      );
    });
    const p0 = roundZeroUniforms(seed, n).p1[0];
    const params: ThresholdParams = {
      n,
      density: 1,
      reciprocity: 1,
      seed,
      rounds: 2,
      uptime: [p0, 1.0],
    };
    const h = simulateThresholdHistory(params);
    const b0 = roundFlowBatch(seed, 0, params);
    const b1 = roundFlowBatch(seed, 1, params);

    expect(h.records[0].kind).toBe("aborted");
    expect(h.records[0].excluded).toEqual([memberAddr(0)]);
    expect(h.records[0].deltas.size).toBe(0);
    expect(h.records[0].outflows.size).toBe(0);
    expect(h.records[0].consumedCount).toBe(0);
    expect(h.records[0].settledVolume).toBe(0n);

    // Nothing entered settledIds: round 1's candidate pool holds ALL paper.
    expect(h.records[1].kind).toBe("settled-1pass");
    expect(h.records[1].consumedCount).toBe(b0.length + b1.length);
    expect(h.unsettledCount).toBe(0);
  });

  it("fewer than 2 candidate participants -> empty (participant-count check, not deltas)", () => {
    const params: ThresholdParams = {
      n: 4,
      density: 0,
      reciprocity: 0,
      seed: 7,
      rounds: 2,
      uptime: 1.0,
    };
    const h = simulateThresholdHistory(params);
    expect(h.records).toHaveLength(2);
    for (const rec of h.records) {
      expect(rec.kind).toBe("empty");
      expect(rec.excluded).toEqual([]);
      expect(rec.deltas.size).toBe(0);
      expect(rec.consumedCount).toBe(0);
    }
    expect(h.generatedCount).toBe(0);
    expect(h.unsettledCount).toBe(0);
  });

  it("quorum abort: rebuild leaving fewer than 2 participants -> aborted", () => {
    const n = 2;
    // Member 0 offline in pass 1; with n=2 every IOU touches member 0, so the
    // rebuild nets over nothing and the quorum floor (< 2 participants) trips.
    const seed = findSeed((s) => {
      const { p1 } = roundZeroUniforms(s, n);
      return p1[1] < p1[0];
    });
    const p0 = roundZeroUniforms(seed, n).p1[0];
    const params: ThresholdParams = {
      n,
      density: 1,
      reciprocity: 1,
      seed,
      rounds: 1,
      uptime: [p0],
    };
    const h = simulateThresholdHistory(params);
    expect(h.records[0].kind).toBe("aborted");
    expect(h.records[0].excluded).toEqual([memberAddr(0)]);
    expect(h.records[0].deltas.size).toBe(0);
    expect(h.records[0].consumedCount).toBe(0);
    expect(h.unsettledCount).toBe(h.generatedCount);
  });

  it("roundFlowBatch ids are unique across rounds (no cross-round dedup)", () => {
    const params = { n: 5, density: 1, reciprocity: 1 };
    const ids = [0, 1, 2].flatMap((r) => roundFlowBatch(99, r, params).map((s) => s.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("availabilityUniforms(1, 2, 3) has length 12 and is reproducible", () => {
    const a = availabilityUniforms(1, 2, 3);
    const b = availabilityUniforms(1, 2, 3);
    expect(a.length).toBe(12);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const u of a) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});
