import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import { numberToHex, type Address, type Hex } from "viem";
import { signIou } from "../src/iou.js";
import { signConsent } from "../src/round.js";
import { rateConsistent, signPvPConsent, verifyPvPProposal } from "../src/pvp.js";
import { quoteToRate, sampleQuote } from "../demo/fx.js";
import {
  attemptPvPRound,
  fxTradePair,
  type PvPConsentProvider,
} from "../demo/pvp.js";
import type { PvPProposal, SignedIou } from "../src/types.js";

const HUB_U = "0x1111111111111111111111111111111111111111" as Address;
const HUB_E = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x9999999999999999999999999999999999999999" as Address;

const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
const carol = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);
const dave = privateKeyToAccount(("0x" + "44".repeat(32)) as Hex);

const NOW = 1_700_000_000n;
const EXPIRY = NOW + 3_600n;
const NONCE_U = 5n;
const NONCE_E = 7n;
const WINDOW_MS = 100;
const QUOTE = sampleQuote();

/** Ordinary (non-FX) IOU with a unique ref so it never pairs across hubs. */
async function iou(
  hub: Address,
  debtor: Account,
  creditor: Address,
  amount: bigint,
  refSeed: number,
): Promise<SignedIou> {
  return signIou(
    hub,
    {
      debtor: debtor.address,
      creditor,
      amount,
      nonce: BigInt(refSeed),
      expiry: EXPIRY,
      ref: numberToHex(refSeed, { size: 32 }),
    },
    debtor,
    undefined,
    { now: NOW },
  );
}

/**
 * Base world: alice/bob run an FX trade (5 USDC vs rate-exact EURC, shared
 * ref), carol has USDC-only paper, dave EURC-only. Union = {alice,bob,carol,dave}.
 */
async function baseScenario(opts: { extraEurc?: boolean } = {}) {
  const pair = await fxTradePair(
    { account: alice, address: alice.address },
    { account: bob, address: bob.address },
    5_000_000n,
    QUOTE,
    { hubUsdc: HUB_U, hubEurc: HUB_E, nonces: { usdc: 1n, eurc: 1n }, expiry: EXPIRY, now: NOW },
  );
  const iousU = [pair.usdc, await iou(HUB_U, carol, alice.address, 2_000_000n, 100)];
  const iousE = [pair.eurc, await iou(HUB_E, dave, bob.address, 1_000_000n, 200)];
  if (opts.extraEurc) {
    // A bob-free EURC flow so excluding bob still leaves EURC quorum.
    iousE.push(await iou(HUB_E, dave, alice.address, 1_500_000n, 201));
  }
  return { pair, iousU, iousE };
}

/** Honest member: re-verifies the whole bundle, refuses as data on mismatch. */
function honest(member: Account, iousU: SignedIou[], iousE: SignedIou[]): PvPConsentProvider {
  return async (proposal, excluded) => {
    const check = verifyPvPProposal(ROUTER, HUB_U, HUB_E, proposal, iousU, iousE, member.address, {
      now: NOW,
      usdc: { excluded, expectedRoundNonce: NONCE_U },
      eurc: { excluded, expectedRoundNonce: NONCE_E },
    });
    if (!check.ok) return { kind: "refusal", reason: check.reason ?? "verification failed" };
    const lc = member.address.toLowerCase();
    const inU = proposal.usdcLeg.participants.some((p) => p.toLowerCase() === lc);
    const inE = proposal.eurcLeg.participants.some((p) => p.toLowerCase() === lc);
    return {
      kind: "consent" as const,
      ...(inU ? { usdcConsent: await signConsent(HUB_U, proposal.usdcLeg, member) } : {}),
      ...(inE ? { eurcConsent: await signConsent(HUB_E, proposal.eurcLeg, member) } : {}),
      pvpSignature: await signPvPConsent(ROUTER, proposal, member),
    };
  };
}

const stall: PvPConsentProvider = () => new Promise(() => {});

function providersFor(entries: [Account, PvPConsentProvider][]): Map<string, PvPConsentProvider> {
  return new Map(entries.map(([m, p]) => [m.address.toLowerCase(), p]));
}

function recordingSubmit() {
  const calls: { proposal: PvPProposal; legSigs: { usdc: Hex[]; eurc: Hex[] }; pvpSigs: Hex[] }[] =
    [];
  const submit = async (
    proposal: PvPProposal,
    legSigs: { usdc: Hex[]; eurc: Hex[] },
    pvpSigs: Hex[],
  ): Promise<Hex> => {
    calls.push({ proposal, legSigs, pvpSigs });
    return ("0x" + "ab".repeat(32)) as Hex;
  };
  return { calls, submit };
}

function attemptArgs(
  iousU: SignedIou[],
  iousE: SignedIou[],
  providers: Map<string, PvPConsentProvider>,
  submit: (
    proposal: PvPProposal,
    legSigs: { usdc: Hex[]; eurc: Hex[] },
    pvpSigs: Hex[],
  ) => Promise<Hex>,
  rate?: { num: bigint; den: bigint },
) {
  const { fxNumerator, fxDenominator } = rate
    ? { fxNumerator: rate.num, fxDenominator: rate.den }
    : quoteToRate(QUOTE);
  return {
    usdc: { ious: iousU, hub: HUB_U, expectedRoundNonce: NONCE_U },
    eurc: { ious: iousE, hub: HUB_E, expectedRoundNonce: NONCE_E },
    router: ROUTER,
    fxNumerator,
    fxDenominator,
    providers,
    windowMs: WINDOW_MS,
    now: NOW,
    submit,
  };
}

describe("fx quote mirror (D-06 fallback)", () => {
  it("quoteToRate maps the amount pair to num/den and rejects zero amounts", () => {
    const rate = quoteToRate({ amountIn: 1_000_000n, amountOut: 989_589n, timestamp: 0 });
    expect(rate.fxNumerator).toBe(989_589n);
    expect(rate.fxDenominator).toBe(1_000_000n);
    expect(() => quoteToRate({ amountIn: 0n, amountOut: 1n, timestamp: 0 })).toThrow(/amountIn/);
    expect(() => quoteToRate({ amountIn: 1n, amountOut: 0n, timestamp: 0 })).toThrow(/amountOut/);
  });

  it("sampleQuote is deterministic per seed", () => {
    expect(sampleQuote()).toEqual(sampleQuote());
    expect(sampleQuote(3)).toEqual(sampleQuote(3));
    expect(sampleQuote().amountOut).toBe(989_589n);
    expect(sampleQuote().amountIn).toBe(1_000_000n);
  });
});

describe("fxTradePair", () => {
  it("builds a shared-ref, direction-swapped, cross-multiplication-exact pair", async () => {
    const { pair } = await baseScenario();
    expect(pair.usdc.iou.ref).toBe(pair.eurc.iou.ref);
    expect(pair.usdc.iou.debtor.toLowerCase()).toBe(pair.eurc.iou.creditor.toLowerCase());
    expect(pair.usdc.iou.creditor.toLowerCase()).toBe(pair.eurc.iou.debtor.toLowerCase());
    const { fxNumerator, fxDenominator } = quoteToRate(QUOTE);
    expect(
      rateConsistent(pair.usdc.iou.amount, pair.eurc.iou.amount, fxNumerator, fxDenominator),
    ).toBe(true);
    expect(pair.eurc.iou.amount).toBe(4_947_945n); // 5 * 989_589
  });

  it("throws when usdcAmount cannot produce an exact EURC amount", async () => {
    await expect(
      fxTradePair(
        { account: alice, address: alice.address },
        { account: bob, address: bob.address },
        1n, // 1 base unit at 989589/1000000 has no exact EURC counterpart
        QUOTE,
        { hubUsdc: HUB_U, hubEurc: HUB_E, nonces: { usdc: 9n, eurc: 9n }, expiry: EXPIRY, now: NOW },
      ),
    ).rejects.toThrow(/exact/);
  });
});

describe("attemptPvPRound", () => {
  it("settles in one pass when every union member consents", async () => {
    const { iousU, iousE } = await baseScenario();
    const providers = providersFor([
      [alice, honest(alice, iousU, iousE)],
      [bob, honest(bob, iousU, iousE)],
      [carol, honest(carol, iousU, iousE)],
      [dave, honest(dave, iousU, iousE)],
    ]);
    const { calls, submit } = recordingSubmit();
    const out = await attemptPvPRound(attemptArgs(iousU, iousE, providers, submit));
    expect(out.kind).toBe("settled");
    if (out.kind !== "settled") return;
    expect(out.passCount).toBe(1);
    expect(calls.length).toBe(1);
    // Complete, index-aligned signature sets for both legs and the union.
    expect(calls[0].legSigs.usdc.length).toBe(out.proposal.usdcLeg.participants.length);
    expect(calls[0].legSigs.eurc.length).toBe(out.proposal.eurcLeg.participants.length);
    expect(calls[0].pvpSigs.length).toBe(4);
    expect(out.txHash).toBe(("0x" + "ab".repeat(32)) as Hex);
  });

  it("excludes a pass-1 non-responder from BOTH legs and settles pass 2 at unchanged nonces", async () => {
    const { iousU, iousE } = await baseScenario({ extraEurc: true });
    const providers = providersFor([
      [alice, honest(alice, iousU, iousE)],
      [bob, stall], // bob (in BOTH legs) never answers pass 1
      [carol, honest(carol, iousU, iousE)],
      [dave, honest(dave, iousU, iousE)],
    ]);
    const { calls, submit } = recordingSubmit();
    const out = await attemptPvPRound(attemptArgs(iousU, iousE, providers, submit));
    expect(out.kind).toBe("settled");
    if (out.kind !== "settled") return;
    expect(out.passCount).toBe(2);
    expect(out.excluded.map((a) => a.toLowerCase())).toEqual([bob.address.toLowerCase()]);
    // The excluded member appears in NEITHER rebuilt leg.
    const bobLc = bob.address.toLowerCase();
    expect(out.proposal.usdcLeg.participants.some((p) => p.toLowerCase() === bobLc)).toBe(false);
    expect(out.proposal.eurcLeg.participants.some((p) => p.toLowerCase() === bobLc)).toBe(false);
    // Both rebuilt legs kept their original per-hub nonces (nothing executed).
    expect(out.proposal.usdcLeg.roundNonce).toBe(NONCE_U);
    expect(out.proposal.eurcLeg.roundNonce).toBe(NONCE_E);
    expect(calls.length).toBe(1);
  });

  it("aborts on a pass-2 refusal without submitting", async () => {
    const { iousU, iousE } = await baseScenario({ extraEurc: true });
    let carolCalls = 0;
    const flakyCarol: PvPConsentProvider = async (proposal, excluded) => {
      carolCalls++;
      if (carolCalls >= 2) return { kind: "refusal", reason: "changed my mind" };
      return honest(carol, iousU, iousE)(proposal, excluded);
    };
    const providers = providersFor([
      [alice, honest(alice, iousU, iousE)],
      [bob, stall],
      [carol, flakyCarol],
      [dave, honest(dave, iousU, iousE)],
    ]);
    const { calls, submit } = recordingSubmit();
    const out = await attemptPvPRound(attemptArgs(iousU, iousE, providers, submit));
    expect(out.kind).toBe("aborted");
    if (out.kind !== "aborted") return;
    expect(out.passCount).toBe(2);
    expect(calls.length).toBe(0);
  });

  it("returns empty when a leg has nothing to net", async () => {
    const { iousE } = await baseScenario();
    const { calls, submit } = recordingSubmit();
    const out = await attemptPvPRound(
      attemptArgs([], iousE, providersFor([]), submit),
    );
    expect(out.kind).toBe("empty");
    expect(calls.length).toBe(0);
  });

  it("aborts as data when exclusion drops a leg below quorum", async () => {
    // Without the extra EURC flow, excluding bob empties the EURC leg.
    const { iousU, iousE } = await baseScenario();
    const providers = providersFor([
      [alice, honest(alice, iousU, iousE)],
      [bob, stall],
      [carol, honest(carol, iousU, iousE)],
      [dave, honest(dave, iousU, iousE)],
    ]);
    const { calls, submit } = recordingSubmit();
    const out = await attemptPvPRound(attemptArgs(iousU, iousE, providers, submit));
    expect(out.kind).toBe("aborted");
    if (out.kind !== "aborted") return;
    expect(out.reason).toMatch(/quorum/);
    expect(calls.length).toBe(0);
  });

  it("a rate violating the FX pair is refused by honest members and never submitted", async () => {
    const { iousU, iousE } = await baseScenario();
    const providers = providersFor([
      [alice, honest(alice, iousU, iousE)],
      [bob, honest(bob, iousU, iousE)],
      [carol, honest(carol, iousU, iousE)],
      [dave, honest(dave, iousU, iousE)],
    ]);
    const { calls, submit } = recordingSubmit();
    // Amounts were built at 989589/1000000; propose an off-by-one rate.
    const out = await attemptPvPRound(
      attemptArgs(iousU, iousE, providers, submit, { num: 989_590n, den: 1_000_000n }),
    );
    expect(out.kind).toBe("aborted");
    if (out.kind !== "aborted") return;
    expect(out.pass1.refused.some((r) => /rate/.test(r.reason))).toBe(true);
    expect(calls.length).toBe(0);
  });
});
