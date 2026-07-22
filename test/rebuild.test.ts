import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signIou } from "../src/iou.js";
import { net } from "../src/netting.js";
import {
  buildProposal,
  rebuildProposal,
  roundDigest,
  signConsent,
  verifyConsent,
  verifyProposal,
} from "../src/round.js";
import type { Iou, SignedIou } from "../src/types.js";

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

// ---------------------------------------------------------------------------
// Task 2: excluded-aware verifyProposal — honest rebuilds verify, every
// modeled coordinator lie is refused with a diagnostic reason.
// ---------------------------------------------------------------------------

const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
const carol = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);

function iou(debtor: Address, creditor: Address, amount: bigint, nonce = 1n): Iou {
  return {
    debtor,
    creditor,
    amount,
    nonce,
    expiry: NOW + 86_400n,
    ref: ("0x" + "00".repeat(32)) as Hex,
  };
}

/** Four real signed IOUs among alice/bob/carol; excluding carol changes every delta. */
async function threeMemberEconomy(): Promise<SignedIou[]> {
  return [
    await signIou(HUB, iou(alice.address, bob.address, 100n), alice),
    await signIou(HUB, iou(bob.address, alice.address, 30n), bob),
    await signIou(HUB, iou(carol.address, alice.address, 50n), carol),
    await signIou(HUB, iou(bob.address, carol.address, 20n), bob),
  ];
}

describe("verifyProposal with excluded set", () => {
  it("honest rebuild verifies for every remaining participant", async () => {
    const ious = await threeMemberEconomy();
    const excluded = [carol.address];
    const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
    for (const account of [alice, bob]) {
      const check = verifyProposal(HUB, proposal, ious, account.address, {
        now: NOW,
        excluded,
      });
      expect(check.ok).toBe(true);
    }
  });

  it("refuses when self is in the excluded set", async () => {
    const ious = await threeMemberEconomy();
    const excluded = [carol.address];
    const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
    const check = verifyProposal(HUB, proposal, ious, carol.address, {
      now: NOW,
      excluded,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/excluded/);
  });

  it("refuses when an excluded address appears in participants", async () => {
    const ious = await threeMemberEconomy();
    const excluded = [carol.address];
    const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
    // Lying coordinator: sneak the excluded address back into participants with
    // a zero delta and recompute manifestHash + digest so only this check fires.
    const participants = [...proposal.participants, carol.address];
    const deltas = [...proposal.deltas, 0n];
    const p = {
      roundNonce: proposal.roundNonce,
      participants,
      deltas,
      manifestHash: proposal.manifestHash,
    };
    const tampered = {
      ...p,
      digest: roundDigest(HUB, p),
      consumedIds: proposal.consumedIds,
    };
    const check = verifyProposal(HUB, tampered, ious, alice.address, {
      now: NOW,
      excluded,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/excluded/);
  });

  it("withheld exclusion produces a delta mismatch refusal", async () => {
    const ious = await threeMemberEconomy();
    const { proposal } = rebuildProposal(HUB, 0n, ious, [carol.address], { now: NOW });
    // Participant is NOT told who was dropped: local net() over the unfiltered
    // view disagrees with the rebuilt deltas — zero-trust refusal.
    const check = verifyProposal(HUB, proposal, ious, alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/delta mismatch/);
  });

  it("consent signatures bind to the rebuilt digest, never replay from pass 1", async () => {
    const ious = await threeMemberEconomy();
    const pass1 = buildProposal(HUB, 0n, net(ious, { now: NOW }));
    const { proposal: rebuilt } = rebuildProposal(HUB, 0n, ious, [carol.address], {
      now: NOW,
    });
    expect(rebuilt.digest).not.toBe(pass1.digest);

    const consent = await signConsent(HUB, rebuilt, alice);
    expect(await verifyConsent(HUB, rebuilt, alice.address, consent)).toBe(true);
    expect(await verifyConsent(HUB, rebuilt, bob.address, consent)).toBe(false);

    // A pass-1 consent can never be replayed against the pass-2 digest.
    const consent1 = await signConsent(HUB, pass1, alice);
    expect(await verifyConsent(HUB, rebuilt, alice.address, consent1)).toBe(false);
  });

  it("omitted excluded opt keeps pass-1 semantics for existing callers", async () => {
    const ious = await threeMemberEconomy();
    const pass1 = buildProposal(HUB, 0n, net(ious, { now: NOW }));
    for (const account of [alice, bob, carol]) {
      const check = verifyProposal(HUB, pass1, ious, account.address, { now: NOW });
      expect(check.ok).toBe(true);
    }
  });
});
