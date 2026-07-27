import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { checkIouLifetime, iouId, signIou, verifyIou } from "../src/iou.js";
import {
  buildProposal,
  manifestHash,
  roundDigest,
  signConsent,
  verifyConsent,
  verifyProposal,
} from "../src/round.js";
import { net } from "../src/netting.js";
import type { Iou } from "../src/types.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const NOW = 1_800_000_000n;

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

describe("EIP-712 sign/verify", () => {
  it("IOU roundtrip: debtor signs, anyone verifies", async () => {
    const signed = await signIou(HUB, iou(alice.address, bob.address, 42n), alice, undefined, {
      now: NOW,
    });
    expect(await verifyIou(HUB, signed)).toBe(true);
    expect(signed.id).toBe(iouId(HUB, signed.iou));
  });

  it("rejects a signer that is not the debtor", async () => {
    await expect(
      signIou(HUB, iou(alice.address, bob.address, 42n), bob, undefined, { now: NOW }),
    ).rejects.toThrow(/not debtor/);
  });

  it("iouId is stable and unique per nonce", () => {
    const a = iouId(HUB, iou(alice.address, bob.address, 42n, 1n));
    const b = iouId(HUB, iou(alice.address, bob.address, 42n, 1n));
    const c = iouId(HUB, iou(alice.address, bob.address, 42n, 2n));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("id differs across hubs (domain binding)", () => {
    const other = "0x2222222222222222222222222222222222222222" as Address;
    const m = iou(alice.address, bob.address, 42n);
    expect(iouId(HUB, m)).not.toBe(iouId(other, m));
  });

  it("consent roundtrip and proposal verification", async () => {
    const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, {
      now: NOW,
    });
    const b = await signIou(HUB, iou(bob.address, alice.address, 30n, 1n), bob, undefined, {
      now: NOW,
    });
    const result = net([a, b], { now: NOW, hub: HUB });
    const proposal = buildProposal(HUB, 0n, result);

    // both parties verify against their own view before consenting
    for (const [account, mine] of [
      [alice, [a, b]],
      [bob, [a, b]],
    ] as const) {
      const check = verifyProposal(HUB, proposal, [...mine], account.address, { now: NOW });
      expect(check.ok).toBe(true);
    }

    const consent = await signConsent(HUB, proposal, alice);
    expect(await verifyConsent(HUB, proposal, alice.address, consent)).toBe(true);
    expect(await verifyConsent(HUB, proposal, bob.address, consent)).toBe(false);
  });

  it("verifyProposal rejects a tampered delta", async () => {
    const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, {
      now: NOW,
    });
    const result = net([a], { now: NOW, hub: HUB });
    const proposal = buildProposal(HUB, 0n, result);
    const tampered = {
      ...proposal,
      deltas: proposal.deltas.map((d, i) => (i === 0 ? d + 1n : d - 1n)),
    };
    const check = verifyProposal(HUB, tampered, [a], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    // Anchored, not an OR-regex: `/delta mismatch|digest/` could never fail on
    // the digest path, so it silently asserted nothing about which branch fired.
    expect(check.reason).toMatch(/^delta mismatch/);
  });

  /**
   * D-CR-05: three of verifyProposal's five refusal branches had no test, so
   * each could be deleted with the whole suite green. They are the participant's
   * last line of defense against a coordinator that shows one thing and commits
   * to another — signConsent takes `manifestHash` verbatim from the proposal
   * object, and ClearingHubV2.executeRound derives the root from the SUBMITTED
   * consumedIds, so an unbound manifest field means a signature given for list
   * L1 settles list L2.
   */
  it("refuses a proposal whose manifestHash does not commit to the shown consumedIds", async () => {
    const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, {
      now: NOW,
    });
    const b = await signIou(HUB, iou(bob.address, alice.address, 30n, 1n), bob, undefined, {
      now: NOW,
    });
    const proposal = buildProposal(HUB, 0n, net([a, b], { now: NOW, hub: HUB }));

    // The coordinator shows the honest ids (so the delta and id-presence checks
    // pass) but commits to a different manifest, then recomputes the digest so
    // ONLY the manifest binding can fire.
    const swapped = { ...proposal, manifestHash: manifestHash([("0x" + "cd".repeat(32)) as Hex]) };
    const forged = { ...swapped, digest: roundDigest(HUB, swapped) };

    const check = verifyProposal(HUB, forged, [a, b], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("manifestHash does not match consumedIds");
  });

  it("refuses a proposal whose digest field does not match its contents", async () => {
    const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, {
      now: NOW,
    });
    const proposal = buildProposal(HUB, 0n, net([a], { now: NOW, hub: HUB }));
    const check = verifyProposal(
      HUB,
      { ...proposal, digest: ("0x" + "ff".repeat(32)) as Hex },
      [a],
      alice.address,
      { now: NOW },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("digest does not match proposal contents");
  });

  it("refuses a proposal that omits self from the participant set", async () => {
    // A round strictly between bob and carol: alice has no position in it, so
    // consenting would sign a full-position digest she is not a party to.
    const other = await signIou(HUB, iou(bob.address, carol.address, 25n, 7n), bob, undefined, {
      now: NOW,
    });
    const proposal = buildProposal(HUB, 0n, net([other], { now: NOW, hub: HUB }));
    expect(
      proposal.participants.map((p) => p.toLowerCase()),
    ).not.toContain(alice.address.toLowerCase());

    const check = verifyProposal(HUB, proposal, [], alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("self not in participant set");
  });

  it("L-convention D-15: refuses expiry > now + L, signs the <= boundary", async () => {
    const bad = { ...iou(alice.address, bob.address, 42n), expiry: NOW + 86_401n };
    await expect(
      signIou(HUB, bad, alice, undefined, { now: NOW }),
    ).rejects.toThrow(/exceeds now/);
    // checkIouLifetime never throws — it reports.
    const check = checkIouLifetime(bad, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/exceeds now/);
    // Boundary: expiry == now + L is signable (<= convention).
    const edge = { ...iou(alice.address, bob.address, 42n), expiry: NOW + 86_400n };
    await expect(signIou(HUB, edge, alice, undefined, { now: NOW })).resolves.toBeDefined();
    expect(checkIouLifetime(edge, { now: NOW }).ok).toBe(true);
    // Custom L override tightens/loosens the same rule.
    expect(checkIouLifetime(edge, { now: NOW, maxIouLifetimeSeconds: 3_600n }).ok).toBe(false);
  });

  it("net() excludes redeemedIds exactly like settledIds (D-14)", async () => {
    const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, {
      now: NOW,
    });
    const b = await signIou(HUB, iou(bob.address, alice.address, 30n, 1n), bob, undefined, {
      now: NOW,
    });
    const filtered = net([a, b], { now: NOW, hub: HUB, redeemedIds: new Set([a.id]) });
    expect(filtered.consumedIds).toEqual([b.id.toLowerCase()]);
    const unfiltered = net([a, b], { now: NOW, hub: HUB });
    expect(unfiltered.consumedIds).toHaveLength(2);
  });

  it("matches the shared fixture consumed by the Foundry parity test", () => {
    const raw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "digest.json"),
      "utf8",
    );
    const f = JSON.parse(raw);
    const digest = roundDigest(f.hub, {
      roundNonce: BigInt(f.roundNonce),
      participants: f.participants,
      deltas: f.deltas.map(BigInt),
      manifestHash: f.manifestHash,
    });
    expect(digest).toBe(f.digest);
    expect(manifestHash([f.iouId])).toBe(f.manifestHash);
  });
});
