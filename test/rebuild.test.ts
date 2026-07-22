import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { rebuildProposal } from "../src/round.js";
import type { SignedIou } from "../src/types.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const NOW = 1_800_000_000n;
const FUTURE = NOW + 3_600n;

const ADDRS: Address[] = Array.from(
  { length: 6 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
);

/** Test IOUs don't need real signatures — the engine keys on `id`. */
function fakeIou(
  debtor: Address,
  creditor: Address,
  amount: bigint,
  nonce: bigint,
  expiry: bigint = FUTURE,
): SignedIou {
  const id = keccak256(
    toHex(`${debtor}|${creditor}|${amount}|${nonce}|${expiry}`),
  ) as Hex;
  return {
    iou: { debtor, creditor, amount, nonce, expiry, ref: id },
    signature: "0x",
    id,
  };
}

const arbIou = fc
  .record({
    d: fc.integer({ min: 0, max: 5 }),
    c: fc.integer({ min: 0, max: 5 }),
    amount: fc.bigInt({ min: 1n, max: 10_000_000n }),
    nonce: fc.bigInt({ min: 0n, max: 1_000n }),
  })
  .filter(({ d, c }) => d !== c)
  .map(({ d, c, amount, nonce }) => fakeIou(ADDRS[d], ADDRS[c], amount, nonce));

const arbIous = fc.array(arbIou, { minLength: 0, maxLength: 200 });

/** Arbitrary excluded-member subset — never everyone (a round needs ≥2 members). */
const arbStalled = fc.subarray(ADDRS, { maxLength: ADDRS.length - 2 });

describe("rebuildProposal properties", () => {
  it("rebuild deltas always sum to zero (CONS-05)", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const { result } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        expect(result.deltas.reduce((a, b) => a + b, 0n)).toBe(0n);
      }),
    );
  });

  it("no excluded address in rebuilt participants (CONS-02)", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const ex = new Set(excluded.map((a) => a.toLowerCase()));
        const { result } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        for (const p of result.participants) {
          expect(ex.has(p.toLowerCase())).toBe(false);
        }
      }),
    );
  });

  it("no consumed id touches an excluded member (CONS-02)", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const ex = new Set(excluded.map((a) => a.toLowerCase()));
        const byId = new Map(ious.map((s) => [s.id.toLowerCase(), s]));
        const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        for (const id of proposal.consumedIds) {
          const s = byId.get(id.toLowerCase());
          expect(s).toBeDefined();
          expect(ex.has(s!.iou.debtor.toLowerCase())).toBe(false);
          expect(ex.has(s!.iou.creditor.toLowerCase())).toBe(false);
        }
      }),
    );
  });

  it("is deterministic under input shuffling", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, fc.infiniteStream(fc.nat()), (ious, excluded, rand) => {
        const shuffled = [...ious];
        const it_ = rand[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (it_.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const a = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        const b = rebuildProposal(HUB, 0n, shuffled, excluded, { now: NOW });
        expect(b.proposal.participants).toEqual(a.proposal.participants);
        expect(b.proposal.deltas).toEqual(a.proposal.deltas);
        expect(b.proposal.manifestHash).toBe(a.proposal.manifestHash);
        expect(b.proposal.digest).toBe(a.proposal.digest);
      }),
    );
  });

  it("cascade: a member whose only IOUs touch an excluded member drops out", () => {
    // B's only paper touches A (excluded). C↔D keep the round alive.
    // Rule 6: no consumed IOUs → B never appears in the rebuilt set.
    const ious = [
      fakeIou(ADDRS[0], ADDRS[1], 10n, 1n),
      fakeIou(ADDRS[2], ADDRS[3], 5n, 1n),
    ];
    const { result } = rebuildProposal(HUB, 0n, ious, [ADDRS[0]], { now: NOW });
    const lower = result.participants.map((p) => p.toLowerCase());
    expect(lower).not.toContain(ADDRS[0].toLowerCase());
    expect(lower).not.toContain(ADDRS[1].toLowerCase());
    expect(lower).toEqual([ADDRS[2].toLowerCase(), ADDRS[3].toLowerCase()]);
  });

  it("settled ids never appear in rebuilt consumedIds", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const settled = new Set<Hex>(
          ious.filter((_, i) => i % 2 === 0).map((s) => s.id.toLowerCase() as Hex),
        );
        const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, {
          now: NOW,
          settledIds: settled,
        });
        for (const id of proposal.consumedIds) {
          expect(settled.has(id.toLowerCase() as Hex)).toBe(false);
        }
      }),
    );
  });
});
