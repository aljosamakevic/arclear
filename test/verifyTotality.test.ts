import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { signIou } from "../src/iou.js";
import { net } from "../src/netting.js";
import { buildProposal, manifestHash, verifyProposal } from "../src/round.js";
import { manifestLeafId } from "../src/merkle.js";
import { buildPvPProposal, verifyPvPProposal } from "../src/pvp.js";
import type { ConsumedIou, Iou, RoundProposal } from "../src/types.js";

/**
 * B-CR-04 regression: `verifyProposal` (and `verifyPvPProposal`, which
 * composes it) is a verification function, so its contract is `{ ok, reason }`
 * — never a throw (CLAUDE.md). It was reachable-throwing on coordinator-
 * supplied data: `manifestHash` -> `merkleRoot` -> `normalize` throws on
 * duplicate / descending / non-bytes32 ids, and viem throws on out-of-range
 * deltas inside `roundDigest`. An integrator following QUICKSTART §3.5 writes
 * `if (!check.ok) throw` — so one malformed proposal killed the whole
 * auto-consent daemon instead of being refused.
 */

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const HUB_EURC = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;
const NOW = 1_800_000_000n;

const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);

function iou(debtor: Address, creditor: Address, amount: bigint, nonce = 1n): Iou {
  return {
    debtor,
    creditor,
    amount,
    nonce,
    expiry: NOW + 3_600n,
    ref: ("0x" + "00".repeat(32)) as Hex,
  };
}

/**
 * A consumed entry whose parties ARE the proposal's participants and whose
 * leafId is self-consistent — so the v3 structural gate passes and
 * verification reaches the merkle/digest primitives that used to throw. That
 * reachability is the whole point: a refusal produced by the structural gate
 * would prove nothing about totality.
 */
function wellFormedEntry(id: Hex): ConsumedIou {
  return {
    id,
    debtor: alice.address,
    creditor: bob.address,
    leafId: manifestLeafId(id, alice.address, bob.address),
  };
}

/** An entry carrying an unhashable id — leaf derivation itself throws. */
function badIdEntry(id: Hex): ConsumedIou {
  return {
    id,
    debtor: alice.address,
    creditor: bob.address,
    // Placeholder: manifestLeafId(id, ...) cannot be computed for this id at
    // all, which is exactly the throwing path under test.
    leafId: ("0x" + "00".repeat(32)) as Hex,
  };
}

const ID_A = ("0x" + "11".repeat(32)) as Hex;
const ID_B = ("0x" + "ff".repeat(32)) as Hex;

/**
 * v3 note: ascent is BY DERIVED LEAF, so a descending vector must be built
 * from real leaves rather than hand-picked ids — sorting by id says nothing
 * about the order merkleRoot will see.
 */
const DESCENDING_BY_LEAF: ConsumedIou[] = (() => {
  const x = wellFormedEntry(ID_A);
  const y = wellFormedEntry(ID_B);
  return x.leafId > y.leafId ? [x, y] : [y, x];
})();

/** Malformed consumed sets, the same four classes the audit executed. */
const MALFORMED: Record<string, ConsumedIou[]> = {
  duplicate: [wellFormedEntry(ID_A), wellFormedEntry(ID_A)],
  descending: DESCENDING_BY_LEAF,
  "short hex": [badIdEntry("0xdead" as Hex)],
  "non-hex": [badIdEntry("nope" as unknown as Hex)],
};

/**
 * A structurally valid two-participant proposal in which the CALLER holds no
 * paper and nets to zero — so verification runs past the delta check and
 * reaches the merkle/digest primitives that used to throw.
 */
function bystanderProposal(consumed: ConsumedIou[], deltas: [bigint, bigint]): RoundProposal {
  const participants = [alice.address, bob.address].sort((x, y) =>
    x.toLowerCase() < y.toLowerCase() ? -1 : 1,
  );
  return {
    roundNonce: 0n,
    participants,
    deltas,
    manifestHash: ("0x" + "ab".repeat(32)) as Hex,
    digest: ("0x" + "cd".repeat(32)) as Hex,
    consumed,
  };
}

describe("CR-04: verifyProposal is total", () => {
  for (const [name, consumed] of Object.entries(MALFORMED)) {
    it(`refuses a ${name} consumed set as data instead of throwing`, () => {
      const proposal = bystanderProposal(consumed, [0n, 0n]);
      let check!: { ok: boolean; reason?: string };
      expect(() => {
        check = verifyProposal(HUB, proposal, [], alice.address, { now: NOW });
      }).not.toThrow();
      expect(check.ok).toBe(false);
      expect(check.reason).toBeTruthy();
      // The primitive's own diagnostic survives into the reason.
      expect(() => manifestHash(consumed)).toThrow();
    });

    it(`refuses a ${name} consumed set through verifyPvPProposal too`, async () => {
      const at = { now: NOW };
      const eurcIou = await signIou(HUB_EURC, iou(bob.address, alice.address, 5n), bob, undefined, at);
      const eurcLeg = buildProposal(HUB_EURC, 0n, net([eurcIou], { now: NOW, hub: HUB_EURC }));
      const bundle = buildPvPProposal(
        ROUTER,
        bystanderProposal(consumed, [0n, 0n]),
        eurcLeg,
        1n,
        1n,
      );
      let check!: { ok: boolean; reason?: string };
      expect(() => {
        check = verifyPvPProposal(ROUTER, HUB, HUB_EURC, bundle, [], [eurcIou], alice.address, {
          now: NOW,
        });
      }).not.toThrow();
      expect(check.ok).toBe(false);
      expect(check.reason).toBeTruthy();
    });
  }

  it("refuses out-of-range deltas (viem's int256 bound) instead of throwing", () => {
    // Empty manifest hashes fine, so verification reaches roundDigest — where
    // viem rejects a delta that does not fit int256. The caller's OWN delta
    // stays 0 (matching their empty local view) so the out-of-range value is
    // the first thing that can fail.
    const shape = bystanderProposal([], [0n, 0n]);
    const mine = shape.participants.findIndex(
      (p) => p.toLowerCase() === alice.address.toLowerCase(),
    );
    const deltas: [bigint, bigint] = mine === 0 ? [0n, 2n ** 300n] : [2n ** 300n, 0n];
    // Correct (sentinel) root for the empty manifest, so the only thing left
    // to check is the digest.
    const proposal = { ...bystanderProposal([], deltas), manifestHash: manifestHash([]) };
    let check!: { ok: boolean; reason?: string };
    expect(() => {
      check = verifyProposal(HUB, proposal, [], alice.address, { now: NOW });
    }).not.toThrow();
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/malformed proposal/);
  });

  it("refuses structurally broken proposals (null fields, wrong types)", () => {
    const junk = [
      { ...bystanderProposal([], [0n, 0n]), consumed: null as unknown as ConsumedIou[] },
      { ...bystanderProposal([], [0n, 0n]), participants: null as unknown as Address[] },
      { ...bystanderProposal([], [0n, 0n]), deltas: null as unknown as bigint[] },
      { ...bystanderProposal([], [0n, 0n]), participants: ["not-an-address" as Address, bob.address] },
    ];
    for (const proposal of junk) {
      let check!: { ok: boolean; reason?: string };
      expect(() => {
        check = verifyProposal(HUB, proposal, [], alice.address, { now: NOW });
      }).not.toThrow();
      expect(check.ok).toBe(false);
    }
  });

  it("property: never throws for arbitrary proposal shapes", () => {
    const arbHexish = fc.oneof(
      fc.hexaString({ minLength: 0, maxLength: 70 }).map((s) => `0x${s}` as Hex),
      fc.string().map((s) => s as Hex),
      fc.constant(("0x" + "00".repeat(32)) as Hex),
    );
    const arbProposal = fc.record({
      roundNonce: fc.bigInt({ min: 0n, max: 2n ** 300n }),
      participants: fc.array(
        fc.oneof(
          fc.constant(alice.address),
          fc.constant(bob.address),
          fc.string().map((s) => s as Address),
        ),
        { maxLength: 5 },
      ),
      deltas: fc.array(fc.bigInt({ min: -(2n ** 300n), max: 2n ** 300n }), { maxLength: 5 }),
      manifestHash: arbHexish,
      digest: arbHexish,
      consumed: fc.array(
        fc.record({
          id: arbHexish,
          debtor: fc.oneof(fc.constant(alice.address), fc.string().map((x) => x as Address)),
          creditor: fc.oneof(fc.constant(bob.address), fc.string().map((x) => x as Address)),
          leafId: arbHexish,
        }),
        { maxLength: 5 },
      ),
    });
    fc.assert(
      fc.property(arbProposal, (proposal) => {
        const check = verifyProposal(HUB, proposal as RoundProposal, [], alice.address, {
          now: NOW,
        });
        expect(typeof check.ok).toBe("boolean");
        if (!check.ok) expect(typeof check.reason).toBe("string");
      }),
      { numRuns: 500 },
    );
  });

  it("a well-formed proposal still verifies (the guard is not a blanket refusal)", async () => {
    const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, {
      now: NOW,
    });
    const proposal = buildProposal(HUB, 0n, net([a], { now: NOW, hub: HUB }));
    expect(verifyProposal(HUB, proposal, [a], alice.address, { now: NOW }).ok).toBe(true);
  });
});
