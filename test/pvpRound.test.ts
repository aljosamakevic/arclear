import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem/accounts";
import { numberToHex, type Address, type Hex } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { signIou } from "../src/iou.js";
import { signConsent } from "../src/round.js";
import { rateConsistent, signPvPConsent, verifyPvPProposal } from "../src/pvp.js";
import type { HubClient } from "../src/client.js";
import { quoteToRate, sampleQuote } from "../demo/fx.js";
import {
  attemptPvPRound,
  fxTradePair,
  runPvPRound,
  type PvPConsentProvider,
  type PvPPending,
} from "../demo/pvp.js";
import { Coordinator, type ExecutedRound } from "../demo/coordinator.js";
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

describe("runPvPRound (chain-aware wrapper)", () => {
  const TX = ("0x" + "cd".repeat(32)) as Hex;

  function honestProviders(iousU: SignedIou[], iousE: SignedIou[]) {
    return providersFor([
      [alice, honest(alice, iousU, iousE)],
      [bob, honest(bob, iousU, iousE)],
      [carol, honest(carol, iousU, iousE)],
      [dave, honest(dave, iousU, iousE)],
    ]);
  }

  function fakeLegState(ious: SignedIou[]) {
    return {
      openIous: ious,
      settledIds: new Set<Hex>(),
      redeemedIds: new Set<Hex>(),
      rounds: [] as ExecutedRound[],
      held: [] as string[],
      hold(reason: string) {
        this.held.push(reason);
      },
      release() {
        this.held.pop();
      },
      /** WR-01 recording surface: latest record + full call log (order matters). */
      pending: undefined as (PvPPending & { txHash?: Hex }) | undefined,
      pendingLog: [] as (PvPPending & { txHash?: Hex })[],
      recordPendingSubmission(p: PvPPending & { txHash?: Hex }) {
        this.pending = p;
        this.pendingLog.push(p);
      },
      clearPendingSubmission() {
        this.pending = undefined;
      },
    };
  }

  /** Stateful nonce reader: first read returns `first`, later reads `later`.
   *  `hashes(nonce)` supplies RoundExecuted roundHash "logs" — default none. */
  function fakeReader(first: bigint, later?: bigint, hashes?: (nonce: bigint) => Hex[]) {
    let calls = 0;
    return {
      roundNonce: async () => {
        calls++;
        return calls === 1 ? first : (later ?? first);
      },
      roundExecutedHashes: async (nonce: bigint, _fromBlock: bigint) => hashes?.(nonce) ?? [],
    };
  }

  it("records pending state for BOTH hubs before broadcasting and holds both hubs in flight", async () => {
    const { iousU, iousE } = await baseScenario();
    const stateU = fakeLegState(iousU);
    const stateE = fakeLegState(iousE);
    let pendingSeen:
      | { usdc: { roundNonce: bigint; sentAtBlock: bigint }; eurc: { roundNonce: bigint } }
      | undefined;
    let pendingAtBroadcast = false;
    let heldAtBroadcast = 0;
    const out = await runPvPRound({
      usdc: { hub: HUB_U, reader: fakeReader(NONCE_U), state: stateU },
      eurc: { hub: HUB_E, reader: fakeReader(NONCE_E), state: stateE },
      router: ROUTER,
      routerClient: {
        executePvP: async () => {
          // WR-01: pending must already be recorded when the broadcast happens.
          pendingAtBroadcast = pendingSeen !== undefined;
          heldAtBroadcast = stateU.held.length + stateE.held.length;
          return TX;
        },
      },
      relayerWallet: {} as WalletClient,
      pub: {
        getBlockNumber: async () => 42n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
      providers: honestProviders(iousU, iousE),
      quote: QUOTE,
      windowMs: WINDOW_MS,
      now: NOW,
      onPending: (p) => {
        pendingSeen = p;
      },
    });
    expect(out.outcome).toBe("settled");
    expect(pendingAtBroadcast).toBe(true);
    expect(pendingSeen?.usdc.roundNonce).toBe(NONCE_U);
    expect(pendingSeen?.eurc.roundNonce).toBe(NONCE_E);
    expect(pendingSeen?.usdc.sentAtBlock).toBe(42n);
    // Pitfall 4: both hubs held while the bundle was in flight, released after.
    expect(heldAtBroadcast).toBe(2);
    expect(stateU.held.length).toBe(0);
    expect(stateE.held.length).toBe(0);
  });

  it("classifies a failed submission from both chains' nonces (moved nonce = blocked)", async () => {
    const { iousU, iousE } = await baseScenario();
    const stateU = fakeLegState(iousU);
    const stateE = fakeLegState(iousE);
    const out = await runPvPRound({
      usdc: { hub: HUB_U, reader: fakeReader(NONCE_U, NONCE_U + 1n), state: stateU },
      eurc: { hub: HUB_E, reader: fakeReader(NONCE_E, NONCE_E), state: stateE },
      router: ROUTER,
      routerClient: { executePvP: async () => TX },
      relayerWallet: {} as WalletClient,
      pub: {
        getBlockNumber: async () => 42n,
        waitForTransactionReceipt: async () => ({ status: "reverted" }),
      },
      providers: honestProviders(iousU, iousE),
      quote: QUOTE,
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(out.outcome).toBe("blocked");
    if (out.outcome !== "blocked") return;
    expect(out.reason).toMatch(/concurrent/);
    // Nothing folded on failure.
    expect(stateU.settledIds.size).toBe(0);
    expect(stateE.settledIds.size).toBe(0);
    expect(stateU.rounds.length).toBe(0);
    expect(stateE.rounds.length).toBe(0);
    // Definitively mined-and-reverted: nothing executed, nothing pending.
    expect(stateU.pending).toBeUndefined();
    expect(stateE.pending).toBeUndefined();
  });

  it("a reverted submission with unmoved nonces stays an abort (not blocked)", async () => {
    const { iousU, iousE } = await baseScenario();
    const stateU = fakeLegState(iousU);
    const stateE = fakeLegState(iousE);
    const out = await runPvPRound({
      usdc: { hub: HUB_U, reader: fakeReader(NONCE_U, NONCE_U), state: stateU },
      eurc: { hub: HUB_E, reader: fakeReader(NONCE_E, NONCE_E), state: stateE },
      router: ROUTER,
      routerClient: { executePvP: async () => TX },
      relayerWallet: {} as WalletClient,
      pub: {
        getBlockNumber: async () => 42n,
        waitForTransactionReceipt: async () => ({ status: "reverted" }),
      },
      providers: honestProviders(iousU, iousE),
      quote: QUOTE,
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(out.outcome).toBe("aborted");
    // Definitive revert clears the WR-01 pending records — nothing executed.
    expect(stateU.pending).toBeUndefined();
    expect(stateE.pending).toBeUndefined();
  });

  it("WR-02: a mined tx whose receipt wait fails is reconciled from RoundExecuted digests and folded as settled", async () => {
    const { iousU, iousE } = await baseScenario();
    const stateU = fakeLegState(iousU);
    const stateE = fakeLegState(iousE);
    // Each hub's "logs" report OUR OWN submitted digest at the submitted
    // nonce — the tx really mined; only the receipt transport failed.
    const readerU = fakeReader(NONCE_U, undefined, (nonce) =>
      stateU.pending !== undefined && nonce === stateU.pending.roundNonce
        ? [stateU.pending.digest]
        : [],
    );
    const readerE = fakeReader(NONCE_E, undefined, (nonce) =>
      stateE.pending !== undefined && nonce === stateE.pending.roundNonce
        ? [stateE.pending.digest]
        : [],
    );
    const out = await runPvPRound({
      usdc: { hub: HUB_U, reader: readerU, state: stateU },
      eurc: { hub: HUB_E, reader: readerE, state: stateE },
      router: ROUTER,
      routerClient: { executePvP: async () => TX },
      relayerWallet: {} as WalletClient,
      pub: {
        getBlockNumber: async () => 42n,
        waitForTransactionReceipt: async () => {
          throw new Error("transport: socket hang up");
        },
      },
      providers: honestProviders(iousU, iousE),
      quote: QUOTE,
      windowMs: WINDOW_MS,
      now: NOW,
    });
    // Pre-fix this was "aborted"/"blocked" and the consumed ids stayed
    // re-nettable — the double-settle hazard. Digest match reclassifies.
    expect(out.outcome).toBe("settled");
    if (out.outcome !== "settled") return;
    expect(out.txHash).toBe(TX);
    expect(out.rounds.usdc.pvp).toEqual({ fxNumerator: "989589", fxDenominator: "1000000" });
    // Consumed ids folded per hub — never re-nettable (WR-01 goal).
    expect(stateU.settledIds.size).toBeGreaterThan(0);
    expect(stateE.settledIds.size).toBeGreaterThan(0);
    expect(stateU.settledIds.size).toBe(out.rounds.usdc.iouCount);
    expect(stateE.settledIds.size).toBe(out.rounds.eurc.iouCount);
    // Recorded BEFORE broadcast (no txHash yet), re-recorded with the hash,
    // and cleared once folded.
    expect(stateU.pendingLog[0]?.txHash).toBeUndefined();
    expect(stateU.pendingLog[1]?.txHash).toBe(TX);
    expect(stateU.pending).toBeUndefined();
    expect(stateE.pending).toBeUndefined();
    // Held during flight, released after.
    expect(stateU.held.length).toBe(0);
    expect(stateE.held.length).toBe(0);
  });

  it("WR-01: a receipt-transport failure with no visible logs leaves reconcilable pending records on BOTH coordinators", async () => {
    const { iousU, iousE } = await baseScenario();
    const stateU = fakeLegState(iousU);
    const stateE = fakeLegState(iousE);
    const out = await runPvPRound({
      usdc: { hub: HUB_U, reader: fakeReader(NONCE_U), state: stateU },
      eurc: { hub: HUB_E, reader: fakeReader(NONCE_E), state: stateE },
      router: ROUTER,
      routerClient: { executePvP: async () => TX },
      relayerWallet: {} as WalletClient,
      pub: {
        getBlockNumber: async () => 42n,
        waitForTransactionReceipt: async () => {
          throw new Error("transport: connection reset");
        },
      },
      providers: honestProviders(iousU, iousE),
      quote: QUOTE,
      windowMs: WINDOW_MS,
      now: NOW,
    });
    // "Did our tx mine?" is genuinely open (no logs, unmoved nonces): the run
    // reports aborted as data …
    expect(out.outcome).toBe("aborted");
    // … but nothing is lost: both coordinators hold the full WR-01 pending
    // record their own reconcilePendingSubmission needs before the next
    // round — so the consumed ids can never be silently re-netted.
    expect(stateU.pending?.roundNonce).toBe(NONCE_U);
    expect(stateE.pending?.roundNonce).toBe(NONCE_E);
    expect(stateU.pending?.txHash).toBe(TX);
    expect(stateE.pending?.txHash).toBe(TX);
    expect(stateU.pending?.sentAtBlock).toBe(42n);
    expect(stateU.pending?.consumedIds.length).toBeGreaterThan(0);
    expect(stateE.pending?.consumedIds.length).toBeGreaterThan(0);
    // Nothing folded blindly.
    expect(stateU.settledIds.size).toBe(0);
    expect(stateE.settledIds.size).toBe(0);
    expect(stateU.rounds.length).toBe(0);
    expect(stateE.rounds.length).toBe(0);
  });

  it("hold blocks an ordinary Coordinator.runRound as a blocked-style result", async () => {
    const c = new Coordinator(
      HUB_U,
      {} as unknown as HubClient,
      {} as unknown as PublicClient,
      [],
      {} as unknown as WalletClient,
    );
    c.hold("PvP bundle in flight — ordinary rounds refused on both hubs");
    const r = await c.runRound(NOW);
    expect(r.outcome).toBe("aborted");
    if (r.outcome !== "aborted") return;
    expect(r.reason).toMatch(/in flight/);
  });

  it("a settled PvP run tags both hubs' rounds with the rate and folds per-hub settledIds", async () => {
    const { iousU, iousE } = await baseScenario();
    const stateU = fakeLegState(iousU);
    const stateE = fakeLegState(iousE);
    const out = await runPvPRound({
      usdc: { hub: HUB_U, reader: fakeReader(NONCE_U), state: stateU },
      eurc: { hub: HUB_E, reader: fakeReader(NONCE_E), state: stateE },
      router: ROUTER,
      routerClient: { executePvP: async () => TX },
      relayerWallet: {} as WalletClient,
      pub: {
        getBlockNumber: async () => 42n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
      providers: honestProviders(iousU, iousE),
      quote: QUOTE,
      windowMs: WINDOW_MS,
      now: NOW,
    });
    expect(out.outcome).toBe("settled");
    if (out.outcome !== "settled") return;
    expect(out.txHash).toBe(TX);
    expect(stateU.rounds.length).toBe(1);
    expect(stateE.rounds.length).toBe(1);
    expect(stateU.rounds[0].pvp).toEqual({ fxNumerator: "989589", fxDenominator: "1000000" });
    expect(stateE.rounds[0].pvp).toEqual({ fxNumerator: "989589", fxDenominator: "1000000" });
    // Pitfall 3: each hub's settledIds absorbs ONLY its own leg's ids.
    expect(stateU.settledIds.size).toBe(stateU.rounds[0].iouCount);
    expect(stateE.settledIds.size).toBe(stateE.rounds[0].iouCount);
    const uIds = new Set(iousU.map((s) => s.id.toLowerCase()));
    for (const id of stateU.settledIds) expect(uIds.has(id.toLowerCase())).toBe(true);
    const eIds = new Set(iousE.map((s) => s.id.toLowerCase()));
    for (const id of stateE.settledIds) expect(eIds.has(id.toLowerCase())).toBe(true);
    const overlap = [...stateU.settledIds].filter((id) => stateE.settledIds.has(id));
    expect(overlap.length).toBe(0);
  });
});
