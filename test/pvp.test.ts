import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import type { Address, Hex } from "viem";
import { ARC_TESTNET_CHAIN_ID } from "../src/domain.js";
import { pvpDigest, signPvPConsent, verifyPvPConsent } from "../src/pvp.js";
import type { PvPProposal, RoundProposal } from "../src/types.js";

const ROUTER = "0x9999999999999999999999999999999999999999" as Address;
const OTHER_ROUTER = "0x8888888888888888888888888888888888888888" as Address;

const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);

const D_U = ("0x" + "aa".repeat(32)) as Hex;
const D_E = ("0x" + "bb".repeat(32)) as Hex;

const BASE = {
  usdcLegDigest: D_U,
  eurcLegDigest: D_E,
  fxNumerator: 989_589n,
  fxDenominator: 1_000_000n,
};

/** Consent tests only read leg digests + rate; the rest of the leg is inert. */
function fakeLeg(digest: Hex): RoundProposal {
  return {
    roundNonce: 0n,
    participants: [],
    deltas: [],
    manifestHash: ("0x" + "00".repeat(32)) as Hex,
    digest,
    consumedIds: [],
  };
}

function fakePvPProposal(): PvPProposal {
  return {
    usdcLeg: fakeLeg(D_U),
    eurcLeg: fakeLeg(D_E),
    fxNumerator: BASE.fxNumerator,
    fxDenominator: BASE.fxDenominator,
    digest: pvpDigest(ROUTER, BASE),
  };
}

describe("pvpDigest", () => {
  it("is deterministic and changes when any of the 4 fields changes", () => {
    const d = pvpDigest(ROUTER, BASE);
    expect(pvpDigest(ROUTER, BASE)).toBe(d);
    expect(pvpDigest(ROUTER, { ...BASE, usdcLegDigest: D_E })).not.toBe(d);
    expect(pvpDigest(ROUTER, { ...BASE, eurcLegDigest: D_U })).not.toBe(d);
    expect(pvpDigest(ROUTER, { ...BASE, fxNumerator: BASE.fxNumerator + 1n })).not.toBe(d);
    expect(pvpDigest(ROUTER, { ...BASE, fxDenominator: BASE.fxDenominator + 1n })).not.toBe(d);
  });

  it("defaults chainId to Arc Testnet (5042002)", () => {
    expect(pvpDigest(ROUTER, BASE)).toBe(pvpDigest(ROUTER, BASE, ARC_TESTNET_CHAIN_ID));
    expect(pvpDigest(ROUTER, BASE)).not.toBe(pvpDigest(ROUTER, BASE, 31337));
  });

  it("binds the router address (domain separation)", () => {
    expect(pvpDigest(ROUTER, BASE)).not.toBe(pvpDigest(OTHER_ROUTER, BASE));
  });
});

describe("PvPRound consent", () => {
  it("sign/verify roundtrip: verifies for the signer, fails for anyone else", async () => {
    const proposal = fakePvPProposal();
    const consent = await signPvPConsent(ROUTER, proposal, alice);
    expect(await verifyPvPConsent(ROUTER, proposal, alice.address, consent)).toBe(true);
    expect(await verifyPvPConsent(ROUTER, proposal, bob.address, consent)).toBe(false);
  });

  it("a consent never verifies against a tampered bundle", async () => {
    const proposal = fakePvPProposal();
    const consent = await signPvPConsent(ROUTER, proposal, alice);
    const tampered = { ...proposal, fxNumerator: proposal.fxNumerator + 1n };
    expect(await verifyPvPConsent(ROUTER, tampered, alice.address, consent)).toBe(false);
  });

  it("throws for an account that cannot sign typed data", async () => {
    const noSign = { ...alice, signTypedData: undefined } as unknown as Account;
    await expect(signPvPConsent(ROUTER, fakePvPProposal(), noSign)).rejects.toThrow(
      /cannot sign typed data/,
    );
  });
});
