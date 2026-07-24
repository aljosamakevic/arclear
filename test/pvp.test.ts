import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import type { Address, Hex } from "viem";
import { ARC_TESTNET_CHAIN_ID } from "../src/domain.js";
import { signIou } from "../src/iou.js";
import { net } from "../src/netting.js";
import { buildProposal } from "../src/round.js";
import {
  buildPvPProposal,
  pvpDigest,
  rateConsistent,
  signPvPConsent,
  unionParticipants,
  verifyPvPConsent,
  verifyPvPProposal,
} from "../src/pvp.js";
import type { Iou, PvPProposal, RoundProposal, SignedIou } from "../src/types.js";

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

// ---------------------------------------------------------------------------
// Task 2: union merge, rate cross-multiplication, bundle build + verification.
// ---------------------------------------------------------------------------

/** Lowercase-ascending address pool — fc.subarray preserves order, so every
 *  generated subset is itself strictly ascending. */
const POOL: Address[] = Array.from(
  { length: 8 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
);

const arbAscending = fc.subarray(POOL);

describe("unionParticipants", () => {
  it("identical, disjoint, and overlapping checksummed sets merge correctly", () => {
    // alice/bob/carol checksummed addresses sorted by lowercase hex order.
    const carol = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);
    const sorted = [alice.address, bob.address, carol.address].sort((x, y) =>
      x.toLowerCase() < y.toLowerCase() ? -1 : 1,
    );
    const [p0, p1, p2] = sorted;
    expect(unionParticipants([p0, p1], [p0, p1])).toEqual([p0, p1]);
    expect(unionParticipants([p0], [p1, p2])).toEqual([p0, p1, p2]);
    expect(unionParticipants([p0, p1], [p1, p2])).toEqual([p0, p1, p2]);
    expect(unionParticipants([], [p0])).toEqual([p0]);
    expect(unionParticipants([p0], [])).toEqual([p0]);
  });

  it("property: output is strictly ascending and equals the set union", () => {
    fc.assert(
      fc.property(arbAscending, arbAscending, (a, b) => {
        const out = unionParticipants(a, b);
        for (let i = 1; i < out.length; i++) {
          expect(out[i - 1].toLowerCase() < out[i].toLowerCase()).toBe(true);
        }
        const expected = new Set([...a, ...b].map((x) => x.toLowerCase()));
        expect(new Set(out.map((x) => x.toLowerCase()))).toEqual(expected);
        // Idempotence on identical inputs.
        expect(unionParticipants(a, a)).toEqual(a);
      }),
    );
  });

  it("WR-03: rejects unsorted input, in-list duplicates, and the zero address (matches _unionOf)", () => {
    const [p0, p1] = POOL;
    const ZERO = ("0x" + "0".repeat(40)) as Address;
    // Non-ascending merged stream: unsorted input list.
    expect(() => unionParticipants([p1, p0], [])).toThrow(/strictly ascending/);
    expect(() => unionParticipants([], [p1, p0])).toThrow(/strictly ascending/);
    // An in-list duplicate is a non-strict step (cross-list duplicates are
    // legal — same member on both legs merges to one union entry).
    expect(() => unionParticipants([p0, p0], [])).toThrow(/strictly ascending/);
    // The zero address fails against the address(0) seed, exactly like the
    // router's UnionNotStrictlyAscending.
    expect(() => unionParticipants([ZERO, p0], [])).toThrow(/strictly ascending/);
    expect(() => unionParticipants([], [ZERO])).toThrow(/strictly ascending/);
  });
});

describe("rateConsistent", () => {
  it("property: exact cross-multiplied pairs pass, off-by-one fails", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        (k, num, den) => {
          expect(rateConsistent(k * den, k * num, num, den)).toBe(true);
          expect(rateConsistent(k * den, k * num + 1n, num, den)).toBe(false);
        },
      ),
    );
  });
});

// --- honest two-leg fixture -------------------------------------------------

const HUB_USDC = "0x1111111111111111111111111111111111111111" as Address;
const HUB_EURC = "0x2222222222222222222222222222222222222222" as Address;
const NOW = 1_800_000_000n;

/** 1 USDC → 0.989589 EURC, base units (arc-stablecoin-fx amount-pair shape). */
const FX_NUM = 989_589n;
const FX_DEN = 1_000_000n;
/** Shared-ref FX pair key. */
const FX_REF = ("0x" + "ab".repeat(32)) as Hex;
/** Non-FX ref appearing on one hub only — never paired. */
const PLAIN_REF = ("0x" + "cc".repeat(32)) as Hex;

function iou(debtor: Address, creditor: Address, amount: bigint, ref: Hex, nonce = 1n): Iou {
  return { debtor, creditor, amount, nonce, expiry: NOW + 86_400n, ref };
}

interface Bundle {
  usdcIous: SignedIou[];
  eurcIous: SignedIou[];
  usdcLeg: RoundProposal;
  eurcLeg: RoundProposal;
  proposal: PvPProposal;
}

/** alice sells 1 USDC to bob for 0.989589 EURC (shared FX_REF pair), plus one
 *  ordinary same-currency USDC IOU so net deltas mix FX and non-FX flows. */
async function honestBundle(): Promise<Bundle> {
  const at = { now: NOW };
  const usdcIous = [
    await signIou(HUB_USDC, iou(alice.address, bob.address, FX_DEN, FX_REF), alice, undefined, at),
    await signIou(HUB_USDC, iou(bob.address, alice.address, 40n, PLAIN_REF), bob, undefined, at),
  ];
  const eurcIous = [
    await signIou(HUB_EURC, iou(bob.address, alice.address, FX_NUM, FX_REF), bob, undefined, at),
  ];
  const usdcLeg = buildProposal(HUB_USDC, 0n, net(usdcIous, { now: NOW }));
  const eurcLeg = buildProposal(HUB_EURC, 0n, net(eurcIous, { now: NOW }));
  const proposal = buildPvPProposal(ROUTER, usdcLeg, eurcLeg, FX_NUM, FX_DEN);
  return { usdcIous, eurcIous, usdcLeg, eurcLeg, proposal };
}

describe("buildPvPProposal", () => {
  it("throws on a zero numerator or denominator", async () => {
    const { usdcLeg, eurcLeg } = await honestBundle();
    expect(() => buildPvPProposal(ROUTER, usdcLeg, eurcLeg, 0n, FX_DEN)).toThrow(/fxNumerator/);
    expect(() => buildPvPProposal(ROUTER, usdcLeg, eurcLeg, FX_NUM, 0n)).toThrow(/fxDenominator/);
  });

  it("digest commits to the two leg digests and the rate", async () => {
    const { usdcLeg, eurcLeg, proposal } = await honestBundle();
    expect(proposal.digest).toBe(
      pvpDigest(ROUTER, {
        usdcLegDigest: usdcLeg.digest,
        eurcLegDigest: eurcLeg.digest,
        fxNumerator: FX_NUM,
        fxDenominator: FX_DEN,
      }),
    );
  });
});

describe("verifyPvPProposal", () => {
  it("accepts an honest bundle for every union member", async () => {
    const { usdcIous, eurcIous, proposal } = await honestBundle();
    for (const account of [alice, bob]) {
      const check = verifyPvPProposal(
        ROUTER, HUB_USDC, HUB_EURC, proposal, usdcIous, eurcIous, account.address,
        { now: NOW },
      );
      expect(check).toEqual({ ok: true });
    }
  });

  it("rejects a tampered leg delta with the failing-leg prefix", async () => {
    const { usdcIous, eurcIous, proposal } = await honestBundle();
    const tamperedLeg = {
      ...proposal.usdcLeg,
      deltas: proposal.usdcLeg.deltas.map((d, i) => (i === 0 ? d + 1n : d - 1n)),
    };
    const tampered = { ...proposal, usdcLeg: tamperedLeg };
    const check = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, tampered, usdcIous, eurcIous, alice.address,
      { now: NOW },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/^usdc leg: /);
  });

  it("rejects a tampered bundle digest", async () => {
    const { usdcIous, eurcIous, proposal } = await honestBundle();
    const tampered = { ...proposal, digest: ("0x" + "ff".repeat(32)) as Hex };
    const check = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, tampered, usdcIous, eurcIous, alice.address,
      { now: NOW },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/digest/);
  });

  it("rejects a rate broken by one base unit, naming the ref and amounts", async () => {
    const { usdcIous, eurcIous, usdcLeg, eurcLeg } = await honestBundle();
    const skewed = buildPvPProposal(ROUTER, usdcLeg, eurcLeg, FX_NUM + 1n, FX_DEN);
    const check = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, skewed, usdcIous, eurcIous, alice.address,
      { now: NOW },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/rate/);
    expect(check.reason).toContain(FX_REF);
    expect(check.reason).toContain(FX_DEN.toString());
    expect(check.reason).toContain(FX_NUM.toString());
  });

  it("rejects a same-direction FX pair as a direction violation", async () => {
    const at = { now: NOW };
    // Both legs alice → bob: a valid pair must be debtor/creditor-swapped.
    const usdcIous = [
      await signIou(HUB_USDC, iou(alice.address, bob.address, FX_DEN, FX_REF), alice, undefined, at),
    ];
    const eurcIous = [
      await signIou(HUB_EURC, iou(alice.address, bob.address, FX_NUM, FX_REF), alice, undefined, at),
    ];
    const usdcLeg = buildProposal(HUB_USDC, 0n, net(usdcIous, { now: NOW }));
    const eurcLeg = buildProposal(HUB_EURC, 0n, net(eurcIous, { now: NOW }));
    const proposal = buildPvPProposal(ROUTER, usdcLeg, eurcLeg, FX_NUM, FX_DEN);
    const check = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, proposal, usdcIous, eurcIous, alice.address,
      { now: NOW },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/direction/);
  });

  it("CR-01 regression: refuses a bundle consuming the paying USDC IOU while the receiving EURC counter-IOU is stripped (quorum padded)", async () => {
    const at = { now: NOW };
    const carol = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);
    const dave = privateKeyToAccount(("0x" + "44".repeat(32)) as Hex);
    // Alice's trade: 1,000,000 USDC base units out for 989,589 EURC base
    // units back, one shared ref — the reviewer's reproduced attack shape.
    const fxU = await signIou(
      HUB_USDC, iou(alice.address, bob.address, FX_DEN, FX_REF), alice, undefined, at,
    );
    const fxE = await signIou(
      HUB_EURC, iou(bob.address, alice.address, FX_NUM, FX_REF), bob, undefined, at,
    );
    // Malicious coordinator: consume alice's paying IOU on the USDC leg but
    // OMIT her receiving IOU from the EURC leg, padding that leg with an
    // unrelated dave→carol flow to keep quorum.
    const pad = await signIou(
      HUB_EURC, iou(dave.address, carol.address, 10n, PLAIN_REF), dave, undefined, at,
    );
    const usdcLeg = buildProposal(HUB_USDC, 0n, net([fxU], { now: NOW }));
    const eurcLeg = buildProposal(HUB_EURC, 0n, net([pad], { now: NOW }));
    const proposal = buildPvPProposal(ROUTER, usdcLeg, eurcLeg, FX_NUM, FX_DEN);
    // Attack preconditions hold: alice is in the USDC leg, stripped from the
    // EURC leg, and her counter-IOU is not consumed anywhere.
    const aliceLc = alice.address.toLowerCase();
    expect(proposal.usdcLeg.participants.some((p) => p.toLowerCase() === aliceLc)).toBe(true);
    expect(proposal.eurcLeg.participants.some((p) => p.toLowerCase() === aliceLc)).toBe(false);
    expect(proposal.eurcLeg.consumedIds.map((i) => i.toLowerCase())).not.toContain(
      fxE.id.toLowerCase(),
    );
    // Pre-fix this returned { ok: true } — alice would sign away her USDC
    // with no EURC coming in. The verdict must flip to a refusal-as-data
    // naming the missing counter-leg consumption.
    const check = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, proposal, [fxU], [fxE], alice.address,
      { now: NOW },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/inclusion asymmetry/);
    expect(check.reason).toMatch(/EURC counter-IOU is missing from the eurc leg/);
    expect(check.reason).toContain(FX_REF);

    // Mirror direction: EURC side consumed, USDC counter-IOU stripped.
    const padU = await signIou(
      HUB_USDC, iou(dave.address, carol.address, 10n, PLAIN_REF), dave, undefined, at,
    );
    const usdcLeg2 = buildProposal(HUB_USDC, 0n, net([padU], { now: NOW }));
    const eurcLeg2 = buildProposal(HUB_EURC, 0n, net([fxE], { now: NOW }));
    const proposal2 = buildPvPProposal(ROUTER, usdcLeg2, eurcLeg2, FX_NUM, FX_DEN);
    const check2 = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, proposal2, [fxU], [fxE], alice.address,
      { now: NOW },
    );
    expect(check2.ok).toBe(false);
    expect(check2.reason).toMatch(/inclusion asymmetry/);
    expect(check2.reason).toMatch(/USDC counter-IOU is missing from the usdc leg/);
  });

  it("passes per-leg WR-06 opts through: wrong expectedRoundNonce on one leg refuses", async () => {
    const { usdcIous, eurcIous, proposal } = await honestBundle();
    const check = verifyPvPProposal(
      ROUTER, HUB_USDC, HUB_EURC, proposal, usdcIous, eurcIous, alice.address,
      { now: NOW, eurc: { expectedRoundNonce: 5n } },
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/^eurc leg: .*roundNonce mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Shared fixture lock (D-05): the same PvPRound vector PvPParity.t.sol reads.
// ---------------------------------------------------------------------------

describe("shared fixture parity (D-05)", () => {
  it("matches the pvp vector consumed by the Foundry parity test", async () => {
    const raw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "digest.json"),
      "utf8",
    );
    const f = JSON.parse(raw);
    const fxNumerator = BigInt(f.pvpFxNumerator);
    const fxDenominator = BigInt(f.pvpFxDenominator);
    const digest = pvpDigest(
      f.pvpRouter,
      {
        usdcLegDigest: f.pvpUsdcLegDigest,
        eurcLegDigest: f.pvpEurcLegDigest,
        fxNumerator,
        fxDenominator,
      },
      f.chainId,
    );
    expect(digest).toBe(f.pvpDigest);
    // Consent parity: the fixture signer's viem signature verifies over a
    // proposal rebuilt from the fixture's leg digests + rate alone.
    const proposal: PvPProposal = {
      usdcLeg: fakeLeg(f.pvpUsdcLegDigest),
      eurcLeg: fakeLeg(f.pvpEurcLegDigest),
      fxNumerator,
      fxDenominator,
      digest,
    };
    expect(
      await verifyPvPConsent(f.pvpRouter, proposal, f.pvpSigner0, f.pvpConsent0, f.chainId),
    ).toBe(true);
  });
});
