import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { iouId, signIou, verifyIou } from "../src/iou.js";
import { net } from "../src/netting.js";
import { buildProposal, verifyProposal } from "../src/round.js";
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
    const ids = result.consumedIds.map((i) => i.toLowerCase());
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
    expect(proposal.consumedIds.map((i) => i.toLowerCase())).toContain(FORGED_ID);
    expect(proposal.consumedIds.map((i) => i.toLowerCase())).not.toContain(a.id.toLowerCase());

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
