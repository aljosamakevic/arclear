import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { iouId, signIou, verifyIou } from "../src/iou.js";
import { consumedIds, net } from "../src/netting.js";
import { buildProposal, consumedRefs, manifestHash, roundDigest, verifyProposal } from "../src/round.js";
import { manifestLeafId } from "../src/merkle.js";
import type { HubClient } from "../src/client.js";
import type { Iou, SignedIou } from "../src/types.js";
import { Coordinator } from "../demo/coordinator.js";

/**
 * B-CR-01 regression: `SignedIou.id` carries no signature and is therefore
 * worthless as input.
 *
 * The attack the audit executed: Bob holds Alice's validly-signed IOU and
 * submits it with `id` replaced by 0x00…01. Pre-fix, `verifyIou` returned
 * true, `net()` put the FORGED id in the manifest, and Alice's own
 * `verifyProposal` returned `{ ok: true }` — so Alice paid the round, the real
 * id was never committed to any buffered root, and once she went stale Bob
 * redeemed the SAME IOU on-chain (redeemIOU recomputes the real id itself),
 * debiting her twice. The contracts are immutable, so refusal has to happen
 * here.
 */

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_HUB = "0x2222222222222222222222222222222222222222" as Address;
const NOW = 1_800_000_000n;
const FORGED_ID = ("0x" + "00".repeat(31) + "01") as Hex;

const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
const carol = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);

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

const sign = (i: Iou, account: typeof alice) =>
  signIou(HUB, i, account, undefined, { now: NOW });

describe("CR-01: SignedIou.id is never trusted", () => {
  it("verifyIou refuses a valid signature carrying a forged id", async () => {
    const signed = await sign(iou(alice.address, bob.address, 100n), alice);
    expect(await verifyIou(HUB, signed)).toBe(true);

    const forged: SignedIou = { ...signed, id: FORGED_ID };
    // The signature is untouched and still valid over the IOU struct...
    expect(forged.signature).toBe(signed.signature);
    // ...but the object as a whole is not what it claims to be.
    expect(await verifyIou(HUB, forged)).toBe(false);
  });

  it("verifyIou refuses an id derived against a different hub", async () => {
    const i = iou(alice.address, bob.address, 100n);
    const signed = await sign(i, alice);
    const wrongDomain: SignedIou = { ...signed, id: iouId(OTHER_HUB, i) };
    expect(await verifyIou(HUB, wrongDomain)).toBe(false);
  });

  it("net() commits the DERIVED id to the manifest, never the submitted one", async () => {
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const b = await sign(iou(carol.address, alice.address, 40n), carol);
    const forged: SignedIou = { ...a, id: FORGED_ID };

    const result = net([forged, b], { now: NOW, hub: HUB });
    const ids = consumedIds(result.consumed).map((i) => i.toLowerCase());
    expect(ids).toContain(a.id.toLowerCase()); // the id redeemIOU will recompute
    expect(ids).not.toContain(FORGED_ID); // the id Bob wanted committed
    // Deltas are unaffected — the attack was always invisible in the money.
    expect(result.deltas.reduce((x, y) => x + y, 0n)).toBe(0n);
  });

  it("dedup survives forgery: one obligation, two claimed ids, one manifest leaf", async () => {
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const b = await sign(iou(carol.address, alice.address, 40n), carol);
    const twice = net([a, { ...a, id: FORGED_ID }, b], { now: NOW, hub: HUB });
    const once = net([a, b], { now: NOW, hub: HUB });
    expect(twice).toEqual(once);
  });

  it("the debtor refuses a proposal whose manifest carries the forged id", async () => {
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const b = await sign(iou(carol.address, alice.address, 40n), carol);
    const forged: SignedIou = { ...a, id: FORGED_ID };

    // A coordinator that trusts submitted ids (the shipped behavior, now only
    // reachable via the explicit opt-out) builds exactly the audit's proposal.
    const trusting = net([forged, b], { now: NOW, unsafeTrustProvidedIds: true });
    const proposal = buildProposal(HUB, 0n, trusting);
    const proposedIds = consumedIds(proposal.consumed).map((i) => i.toLowerCase());
    expect(proposedIds).toContain(FORGED_ID);
    expect(proposedIds).not.toContain(a.id.toLowerCase());

    // Alice's delta is IDENTICAL either way, so the delta check cannot catch
    // this — the id-presence check is what refuses.
    const check = verifyProposal(HUB, proposal, [a, b], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/missing from the proposal manifest/);
    expect(check.reason).toContain(a.id.toLowerCase());

    // And the honest proposal over the same paper still verifies for everyone.
    const honest = buildProposal(HUB, 0n, net([a, b], { now: NOW, hub: HUB }));
    for (const account of [alice, bob, carol]) {
      expect(verifyProposal(HUB, honest, [a, b], account.address, { now: NOW }).ok).toBe(true);
    }
  });

  it("omission variant: cancelling IOUs dropped from the manifest are refused", async () => {
    // Alice owes Bob 100 and Carol owes Alice 100: her delta is 0 whether or
    // not those two are in the round, so a coordinator can drop both and still
    // present the delta she expects. Padding keeps the round non-degenerate.
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const b = await sign(iou(carol.address, alice.address, 100n, 2n), carol);
    const pad = await sign(iou(bob.address, carol.address, 7n, 3n), bob);
    const padded = await sign(iou(carol.address, bob.address, 7n, 4n), carol);

    const full = net([a, b, pad, padded], { now: NOW, hub: HUB });
    const stripped = net([pad, padded], { now: NOW, hub: HUB });
    // Alice is still a participant with delta 0 in the full round.
    const aliceIdx = full.participants.findIndex(
      (p) => p.toLowerCase() === alice.address.toLowerCase(),
    );
    expect(full.deltas[aliceIdx]).toBe(0n);

    // The coordinator proposes the stripped manifest but keeps Alice in the
    // participant set at her (unchanged) zero delta.
    const proposal = buildProposal(HUB, 0n, {
      ...stripped,
      participants: full.participants,
      deltas: full.deltas,
    });
    const check = verifyProposal(HUB, proposal, [a, b, pad, padded], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/missing from the proposal manifest/);
  });

  it("the coordinator re-derives ids as paper enters the pool", async () => {
    const c = new Coordinator(
      HUB,
      { earliestBlock: 0n } as unknown as HubClient,
      {} as unknown as PublicClient,
      [],
      {} as unknown as WalletClient,
    );
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    c.addIous([{ ...a, id: FORGED_ID }]);
    // The pool — and therefore openIous, the settledIds folds keyed off it,
    // and the dashboard's id column — holds the derived id, not the claim.
    expect(c.ious[0].id).toBe(a.id);
    expect(c.ious[0].signature).toBe(a.signature);
  });

  it("stranger ids stay allowed (IN-01): paper that is not ours is not our business", async () => {
    const mine = await sign(iou(alice.address, bob.address, 100n), alice);
    const theirs = await sign(iou(bob.address, carol.address, 5n, 9n), bob);
    // Alice never saw `theirs`, yet it is in the round — she still consents.
    const proposal = buildProposal(HUB, 0n, net([mine, theirs], { now: NOW, hub: HUB }));
    expect(verifyProposal(HUB, proposal, [mine], alice.address, { now: NOW }).ok).toBe(true);
  });
});

/**
 * v3 CR-01: the manifest leaf binds the PARTIES, not just the id.
 *
 * V2 committed a bare id, so a manifest entry said nothing about whose
 * obligation it was. That is what let anyone poison a victim's id into a
 * manifest and permanently defeat its redemption. ClearingHubV3 commits
 * `manifestLeafId(id, lo, hi)` and keys its consumption ledger on that leaf,
 * which moves the attack off-chain: a coordinator can no longer make the CHAIN
 * mark our paper consumed, but it can still hand US a proposal that LOOKS like
 * it consumes our paper while committing a leaf the hub will never write for
 * us. If we sign that, our obligation stays live under a round that claims to
 * have netted it. The refusals below are what stop it.
 */
describe("v3 CR-01: the manifest leaf binds both parties", () => {
  /** Rebuild a proposal around a tampered consumed set, keeping the manifest
   *  root and digest internally consistent — so ONLY the party binding can
   *  fire, never a stale-hash mismatch. */
  const reseal = (
    base: Awaited<ReturnType<typeof buildProposal>>,
    consumed: typeof base.consumed,
  ) => {
    const p = { ...base, consumed, manifestHash: manifestHash(consumed) };
    return { ...p, digest: roundDigest(HUB, p) };
  };

  it("refuses a manifest carrying OUR id under a foreign party pair", async () => {
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const pad = await sign(iou(bob.address, carol.address, 7n, 3n), bob);
    const honest = buildProposal(HUB, 0n, net([a, pad], { now: NOW, hub: HUB }));
    // Sanity: the honest proposal is acceptable to Alice.
    expect(verifyProposal(HUB, honest, [a, pad], alice.address, { now: NOW }).ok).toBe(true);

    // Re-attribute Alice's obligation to bob/carol — the ids match, the deltas
    // match, and the manifest is self-consistent. Only the pair is a lie.
    const poisoned = honest.consumed.map((c) =>
      c.id.toLowerCase() === a.id.toLowerCase()
        ? {
            id: c.id,
            debtor: bob.address,
            creditor: carol.address,
            leafId: manifestLeafId(c.id, bob.address, carol.address),
          }
        : c,
    );
    const forged = reseal(honest, [...poisoned].sort((x, y) => (x.leafId < y.leafId ? -1 : 1)));

    const check = verifyProposal(HUB, forged, [a, pad], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    // Alice's OWN leaf is what is missing — the id being present is irrelevant.
    expect(check.reason).toMatch(/missing from the proposal manifest/);
    expect(check.reason).toContain(a.id.toLowerCase());
  });

  it("refuses an entry whose cached leafId does not bind its stated parties", async () => {
    // The cache is derived data (like SignedIou.id) and is equally worthless as
    // input. Left unchecked, the omission check reads leaves and would compare
    // against a leaf nobody can reproduce.
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const honest = buildProposal(HUB, 0n, net([a], { now: NOW, hub: HUB }));
    const lying = honest.consumed.map((c) => ({ ...c, leafId: ("0x" + "ee".repeat(32)) as Hex }));
    const forged = { ...honest, consumed: lying };

    const check = verifyProposal(HUB, forged, [a], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/leafId does not bind the stated parties/);
  });

  it("refuses an entry naming a party who is not a participant", async () => {
    // Unrepresentable on-chain: refs index INTO participants, so such an entry
    // could only ever revert PartyIndexOutOfRange. Refusing here means a member
    // never signs a round that is structurally incapable of executing.
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const honest = buildProposal(HUB, 0n, net([a], { now: NOW, hub: HUB }));
    const outsider = "0x9999999999999999999999999999999999999999" as Address;
    const forged = reseal(
      honest,
      honest.consumed.map((c) => ({
        ...c,
        creditor: outsider,
        leafId: manifestLeafId(c.id, c.debtor, outsider),
      })),
    );

    const check = verifyProposal(HUB, forged, [a], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/is not a participant/);
  });

  it("consumedRefs resolves parties to indices and refuses what the hub would", async () => {
    const a = await sign(iou(alice.address, bob.address, 100n), alice);
    const pad = await sign(iou(bob.address, carol.address, 7n, 3n), bob);
    const proposal = buildProposal(HUB, 0n, net([a, pad], { now: NOW, hub: HUB }));
    const refs = consumedRefs(proposal.participants, proposal.consumed);

    expect(refs).toHaveLength(proposal.consumed.length);
    refs.forEach((r, i) => {
      const entry = proposal.consumed[i];
      // Index resolution must round-trip back to the exact committed leaf —
      // this is precisely the derivation executeRound performs on-chain.
      expect(
        manifestLeafId(
          r.id,
          proposal.participants[r.partyAIdx],
          proposal.participants[r.partyBIdx],
        ),
      ).toBe(entry.leafId);
      expect(r.partyAIdx).not.toBe(r.partyBIdx); // hub reverts SelfConsumedRef
    });

    // Refs stay in manifest order: reordering them would break the hub's
    // ascent-by-leaf requirement and the root would not match the signed one.
    expect(refs.map((r) => r.id)).toEqual(proposal.consumed.map((c) => c.id));

    // A party outside the participant set is a caller bug, and this is a
    // submitter-side builder, so it throws rather than returning { ok, reason }.
    expect(() =>
      consumedRefs([alice.address], proposal.consumed),
    ).toThrow(/is not a participant/);
  });
});
