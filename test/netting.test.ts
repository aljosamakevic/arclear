import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { consumedIds, net } from "../src/netting.js";
import type { SignedIou } from "../src/types.js";

const NOW = 1_800_000_000n;
const FUTURE = NOW + 3_600n;

const ADDRS: Address[] = Array.from(
  { length: 6 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
);

/**
 * These are ENGINE-ALGEBRA properties (zero-sum, shuffle determinism, dedup,
 * expiry, ordering) over fabricated ids that are not EIP-712 digests, so the
 * suite states the CR-01 binding explicitly as "trust the given ids". The
 * derived-id path — the one every real caller uses — is covered by
 * test/forgedId.test.ts.
 */
const UNBOUND = { unsafeTrustProvidedIds: true } as const;

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

describe("netting engine properties", () => {
  it("deltas always sum to zero", () => {
    fc.assert(
      fc.property(arbIous, (ious) => {
        const r = net(ious, { now: NOW, ...UNBOUND });
        expect(r.deltas.reduce((a, b) => a + b, 0n)).toBe(0n);
      }),
    );
  });

  it("is deterministic under input shuffling", () => {
    fc.assert(
      fc.property(arbIous, fc.infiniteStream(fc.nat()), (ious, rand) => {
        const shuffled = [...ious];
        const it_ = rand[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (it_.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        expect(net(shuffled, { now: NOW, ...UNBOUND })).toEqual(net(ious, { now: NOW, ...UNBOUND }));
      }),
    );
  });

  it("dedup: netting a multiset equals netting the set", () => {
    fc.assert(
      fc.property(arbIous, (ious) => {
        const doubled = [...ious, ...ious];
        expect(net(doubled, { now: NOW, ...UNBOUND })).toEqual(net(ious, { now: NOW, ...UNBOUND }));
      }),
    );
  });

  it("expired IOUs never affect the result", () => {
    fc.assert(
      fc.property(arbIous, arbIous, (live, toExpire) => {
        const expired = toExpire.map((s) => {
          const iou = { ...s.iou, expiry: NOW - 1n };
          return { ...s, iou, id: keccak256(toHex(`expired|${s.id}`)) as Hex };
        });
        expect(net([...live, ...expired], { now: NOW, ...UNBOUND })).toEqual(
          net(live, { now: NOW, ...UNBOUND }),
        );
      }),
    );
  });

  it("already-settled ids are excluded", () => {
    const a = fakeIou(ADDRS[0], ADDRS[1], 5n, 1n);
    const b = fakeIou(ADDRS[1], ADDRS[0], 3n, 1n);
    const r = net([a, b], { now: NOW, ...UNBOUND, settledIds: new Set([a.id]) });
    expect(consumedIds(r.consumed)).toEqual([b.id.toLowerCase()]);
    expect(r.grossVolume).toBe(3n);
  });

  it("participants are strictly ascending", () => {
    fc.assert(
      fc.property(arbIous, (ious) => {
        const { participants } = net(ious, { now: NOW, ...UNBOUND });
        for (let i = 1; i < participants.length; i++) {
          expect(
            participants[i - 1].toLowerCase() < participants[i].toLowerCase(),
          ).toBe(true);
        }
      }),
    );
  });

  it("zero-net participant with consumed IOUs stays in the round", () => {
    // B receives 5 from A and pays 5 to C: net zero but their paper is consumed.
    const ious = [
      fakeIou(ADDRS[0], ADDRS[1], 5n, 1n),
      fakeIou(ADDRS[1], ADDRS[2], 5n, 1n),
    ];
    const r = net(ious, { now: NOW, ...UNBOUND });
    expect(r.participants).toHaveLength(3);
    const idx = r.participants.findIndex(
      (p) => p.toLowerCase() === ADDRS[1].toLowerCase(),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(r.deltas[idx]).toBe(0n);
  });

  it("settledVolume equals sum of positive deltas and never exceeds gross", () => {
    fc.assert(
      fc.property(arbIous, (ious) => {
        const r = net(ious, { now: NOW, ...UNBOUND });
        const pos = r.deltas.filter((d) => d > 0n).reduce((a, b) => a + b, 0n);
        expect(r.settledVolume).toBe(pos);
        expect(r.settledVolume <= r.grossVolume).toBe(true);
      }),
    );
  });

  it("perfectly circular flows settle zero on-chain value", () => {
    // A→B→C→A, same amount: 100% compression.
    const ious = [
      fakeIou(ADDRS[0], ADDRS[1], 7n, 1n),
      fakeIou(ADDRS[1], ADDRS[2], 7n, 1n),
      fakeIou(ADDRS[2], ADDRS[0], 7n, 1n),
    ];
    const r = net(ious, { now: NOW, ...UNBOUND });
    expect(r.grossVolume).toBe(21n);
    expect(r.settledVolume).toBe(0n);
    expect(r.deltas.every((d) => d === 0n)).toBe(true);
  });
});
