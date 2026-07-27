import { keccak256, stringToHex, type Address, type Hex, type WalletClient } from "viem";
import type { Account } from "viem/accounts";
import { net } from "../src/netting.js";
import { buildProposal, rebuildProposal } from "../src/round.js";
import { signIou } from "../src/iou.js";
import {
  buildPvPProposal,
  rateConsistent,
  unionParticipants,
  verifyPvPConsent,
} from "../src/pvp.js";
import type { NetResult, PvPProposal, RoundProposal, SignedIou } from "../src/types.js";
import { screenConsents, type ConsentCollection, type ExecutedRound } from "./coordinator.js";
import { quoteToRate, type FxQuote } from "./fx.js";

/**
 * Build and sign one cross-currency FX trade: a pair of opposite-direction
 * IOUs — `a` pays USDC to `b`, `b` pays the rate-exact EURC amount back to
 * `a` — sharing one `ref` (keccak of a trade id) so verifiers pair them
 * across hubs (shared-ref convention, D-04). Each IOU is signed against its
 * own hub's EIP-712 domain.
 */
export async function fxTradePair(
  a: { account: Account; address: Address },
  b: { account: Account; address: Address },
  usdcAmount: bigint,
  quote: FxQuote,
  opts: {
    hubUsdc: Address;
    hubEurc: Address;
    nonces: { usdc: bigint; eurc: bigint };
    expiry: bigint;
    chainId?: number;
    now?: bigint;
  },
): Promise<{ usdc: SignedIou; eurc: SignedIou }> {
  const { fxNumerator, fxDenominator } = quoteToRate(quote);
  // The quotient below is only an amount CONSTRUCTOR; the protocol-relevant
  // math is the D-04 bigint cross-multiplication check right after it, which
  // rejects any usdcAmount that has no exact EURC counterpart at this rate.
  const eurcAmount = (usdcAmount * fxNumerator) / fxDenominator;
  if (!rateConsistent(usdcAmount, eurcAmount, fxNumerator, fxDenominator)) {
    throw new Error(
      `usdcAmount ${usdcAmount} has no cross-multiplication-exact EURC amount at rate ` +
        `${fxNumerator}/${fxDenominator} — use a multiple of quote.amountIn`,
    );
  }
  const ref = keccak256(
    stringToHex(
      `fx:${a.address.toLowerCase()}:${b.address.toLowerCase()}:${opts.nonces.usdc}:${opts.nonces.eurc}`,
    ),
  );
  const usdc = await signIou(
    opts.hubUsdc,
    {
      debtor: a.address,
      creditor: b.address,
      amount: usdcAmount,
      nonce: opts.nonces.usdc,
      expiry: opts.expiry,
      ref,
    },
    a.account,
    opts.chainId,
    { now: opts.now },
  );
  const eurc = await signIou(
    opts.hubEurc,
    {
      debtor: b.address,
      creditor: a.address,
      amount: eurcAmount,
      nonce: opts.nonces.eurc,
      expiry: opts.expiry,
      ref,
    },
    b.account,
    opts.chainId,
    { now: opts.now },
  );
  return { usdc, eurc };
}

/**
 * A union member's answer to ONE PvP consent request (D-08 fold): the leg
 * consent(s) for every leg they belong to plus the PvPRound signature, in a
 * single verified step. Timeout is never an outcome a provider returns — it
 * is the collection deadline firing.
 */
export type PvPConsentOutcome =
  | { kind: "consent"; usdcConsent?: Hex; eurcConsent?: Hex; pvpSignature: Hex }
  | { kind: "refusal"; reason: string };

export type PvPConsentProvider = (
  proposal: PvPProposal,
  excluded: Address[],
) => Promise<PvPConsentOutcome>;

/** Deadline snapshot of one PvP collection pass (D-02 generalized). */
export interface PvPConsentCollection {
  /** lowercase addr -> the member's verified signature bundle. */
  consents: Map<string, { usdcConsent?: Hex; eurcConsent?: Hex; pvpSignature: Hex }>;
  refused: { address: Address; reason: string }[];
  timedOut: Address[];
}

/**
 * PvP generalization of demo/coordinator.ts collectConsents: race every union
 * member's provider against ONE shared wall-clock deadline, snapshot the
 * partition immutably when it fires (D-02), route provider calls through the
 * microtask queue so a synchronously-throwing provider becomes a reasoned
 * refusal (WR-05), and unref the timer so a stalled provider can never hold
 * the process open. One provider call per union member per pass (D-08).
 */
function collectPvPConsents(
  proposal: PvPProposal,
  union: Address[],
  excluded: Address[],
  providers: Map<string, PvPConsentProvider>,
  windowMs: number,
): Promise<PvPConsentCollection> {
  const consents = new Map<string, { usdcConsent?: Hex; eurcConsent?: Hex; pvpSignature: Hex }>();
  const refused: { address: Address; reason: string }[] = [];
  const pending = new Set<string>(); // lowercase addrs still outstanding

  for (const member of union) {
    const key = member.toLowerCase();
    if (!providers.get(key)) {
      throw new Error(`no PvP consent provider for union member ${member}`);
    }
    pending.add(key);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timedOut = union.filter((m) => pending.has(m.toLowerCase()));
      resolve({ consents, refused, timedOut });
    };

    const timer = setTimeout(finish, windowMs);
    timer.unref?.();

    if (pending.size === 0) {
      finish();
      return;
    }

    for (const member of union) {
      const key = member.toLowerCase();
      const provider = providers.get(key)!;
      Promise.resolve()
        .then(() => provider(proposal, excluded))
        .then(
          (outcome) => {
            if (settled) return; // late — snapshot already taken (D-02)
            pending.delete(key);
            if (outcome.kind === "consent") {
              consents.set(key, {
                usdcConsent: outcome.usdcConsent,
                eurcConsent: outcome.eurcConsent,
                pvpSignature: outcome.pvpSignature,
              });
            } else {
              refused.push({ address: member, reason: outcome.reason });
            }
            if (pending.size === 0) finish();
          },
          (e) => {
            if (settled) return;
            pending.delete(key);
            refused.push({
              address: member,
              reason: e instanceof Error ? e.message : String(e),
            });
            if (pending.size === 0) finish();
          },
        );
    }
  });
}

/**
 * CR-01 generalized to the bundle: demote every collected bundle whose leg
 * consent(s) or PvPRound signature do not verify to a refusal-for-cause. Leg
 * consents are screened by REUSING the coordinator's screenConsents per hub;
 * the PvPRound signature is verified against the shared bundle digest. The
 * injected submit must only ever see signature sets that passed this screen.
 */
async function screenPvPConsents(args: {
  router: Address;
  hubUsdc: Address;
  hubEurc: Address;
  proposal: PvPProposal;
  union: Address[];
  collection: PvPConsentCollection;
  chainId?: number;
}): Promise<PvPConsentCollection> {
  const { proposal, union, collection } = args;
  const checksummed = new Map(union.map((u) => [u.toLowerCase(), u] as const));
  const inLeg = (leg: RoundProposal, key: string) =>
    leg.participants.some((p) => p.toLowerCase() === key);

  // Per-leg ConsentCollection views over the folded bundles, screened by the
  // existing single-hub machinery.
  const legView = (leg: RoundProposal, pick: (o: { usdcConsent?: Hex; eurcConsent?: Hex }) => Hex | undefined): ConsentCollection => {
    const legConsents = new Map<string, Hex>();
    for (const p of leg.participants) {
      const o = collection.consents.get(p.toLowerCase());
      const sig = o === undefined ? undefined : pick(o);
      if (sig !== undefined) legConsents.set(p.toLowerCase(), sig);
    }
    return { consents: legConsents, refused: [], timedOut: [] };
  };
  const legU = await screenConsents(
    args.hubUsdc,
    proposal.usdcLeg,
    legView(proposal.usdcLeg, (o) => o.usdcConsent),
    args.chainId,
  );
  const legE = await screenConsents(
    args.hubEurc,
    proposal.eurcLeg,
    legView(proposal.eurcLeg, (o) => o.eurcConsent),
    args.chainId,
  );

  const consents = new Map<string, { usdcConsent?: Hex; eurcConsent?: Hex; pvpSignature: Hex }>();
  const refused = [...collection.refused];
  for (const [key, bundle] of collection.consents) {
    const address = checksummed.get(key) ?? (key as Address);
    if (inLeg(proposal.usdcLeg, key) && !legU.consents.has(key)) {
      refused.push({
        address,
        reason:
          bundle.usdcConsent === undefined ? "missing usdc leg consent" : "invalid usdc leg consent",
      });
      continue;
    }
    if (inLeg(proposal.eurcLeg, key) && !legE.consents.has(key)) {
      refused.push({
        address,
        reason:
          bundle.eurcConsent === undefined ? "missing eurc leg consent" : "invalid eurc leg consent",
      });
      continue;
    }
    let ok: boolean;
    try {
      ok = await verifyPvPConsent(args.router, proposal, address, bundle.pvpSignature, args.chainId);
    } catch {
      ok = false; // malformed signature bytes — refusal-equivalent, never a throw
    }
    if (!ok) {
      refused.push({ address, reason: "invalid PvPRound signature" });
      continue;
    }
    consents.set(key, bundle);
  }
  return { consents, refused, timedOut: collection.timedOut };
}

/** One leg's inputs to a PvP attempt — per-hub state stays separate (Pitfall 3). */
export interface PvPLegArgs {
  ious: SignedIou[];
  hub: Address;
  /** The hub's live roundNonce as read by the caller — legs build at it. */
  expectedRoundNonce: bigint;
  settledIds?: ReadonlySet<Hex>;
  redeemedIds?: ReadonlySet<Hex>;
}

/** Structured result of one two-pass PvP attempt. Aborts are expected
 * protocol behavior — data, never thrown errors (house convention). */
export type PvPAttemptOutcome =
  | {
      kind: "settled";
      proposal: PvPProposal;
      results: { usdc: NetResult; eurc: NetResult };
      legSignatures: { usdc: Hex[]; eurc: Hex[] };
      pvpSignatures: Hex[];
      txHash: Hex;
      excluded: Address[];
      passCount: 1 | 2;
      pass1: PvPConsentCollection;
    }
  | {
      kind: "aborted";
      reason: string;
      /** Structured failure point — classification never parses reason strings. */
      stage: "quorum" | "consent" | "submit";
      /** Present iff stage === "submit": exactly what was broadcast, so a
       * chain-aware caller can reconcile "did it actually mine?" against
       * RoundExecuted digests and fold it as settled (WR-01/WR-02). */
      submitted?: { proposal: PvPProposal; results: { usdc: NetResult; eurc: NetResult } };
      excluded: Address[];
      passCount: 1 | 2;
      pass1: PvPConsentCollection;
    }
  | { kind: "empty"; reason: string };

/**
 * Chain-free two-pass PvP consent state machine (D-07/D-08/D-09): net + build
 * each leg as an ORDINARY round at its unchanged per-hub nonce, bind them
 * with the rate into one PvPProposal, collect leg consents + PvPRound
 * signatures from the union in ONE provider call per member, exclude every
 * pass-1 non-responder/refuser from BOTH legs in one batch (simplest safe
 * rule), rebuild, recollect once, and abort cleanly after two passes.
 * Performs no chain I/O: the injected submit callback owns all side effects
 * and is called exactly once, only with fully screened signature sets.
 */
export async function attemptPvPRound(args: {
  usdc: PvPLegArgs;
  eurc: PvPLegArgs;
  router: Address;
  fxNumerator: bigint;
  fxDenominator: bigint;
  providers: Map<string, PvPConsentProvider>;
  windowMs: number;
  now: bigint;
  chainId?: number;
  submit: (
    proposal: PvPProposal,
    legSigs: { usdc: Hex[]; eurc: Hex[] },
    pvpSigs: Hex[],
  ) => Promise<Hex>;
}): Promise<PvPAttemptOutcome> {
  const { usdc, eurc, router, fxNumerator, fxDenominator, providers, windowMs, now, chainId } =
    args;
  // CR-01: each leg carries its own hub, so both legs' ids are derived from
  // the hub they were signed against (ids are hub-domain-separated, Pitfall 3).
  const legOpts = (leg: PvPLegArgs) => ({
    now,
    settledIds: leg.settledIds,
    redeemedIds: leg.redeemedIds,
    chainId,
    hub: leg.hub,
  });

  const resultU = net(usdc.ious, legOpts(usdc));
  if (resultU.participants.length < 2) {
    return {
      kind: "empty",
      reason: `usdc leg: nothing to net — ${resultU.participants.length} participant(s), need at least 2`,
    };
  }
  const resultE = net(eurc.ious, legOpts(eurc));
  if (resultE.participants.length < 2) {
    return {
      kind: "empty",
      reason: `eurc leg: nothing to net — ${resultE.participants.length} participant(s), need at least 2`,
    };
  }

  const legU = buildProposal(usdc.hub, usdc.expectedRoundNonce, resultU, chainId);
  const legE = buildProposal(eurc.hub, eurc.expectedRoundNonce, resultE, chainId);
  const proposal = buildPvPProposal(router, legU, legE, fxNumerator, fxDenominator, chainId);
  const union = unionParticipants(legU.participants, legE.participants);

  const screenArgs = { router, hubUsdc: usdc.hub, hubEurc: eurc.hub, chainId };
  const pass1 = await screenPvPConsents({
    ...screenArgs,
    proposal,
    union,
    collection: await collectPvPConsents(proposal, union, [], providers, windowMs),
  });

  const finalize = async (
    p: PvPProposal,
    results: { usdc: NetResult; eurc: NetResult },
    u: Address[],
    pass: PvPConsentCollection,
    excluded: Address[],
    passCount: 1 | 2,
  ): Promise<PvPAttemptOutcome> => {
    // Signatures index-aligned: per-leg with that leg's participants (the
    // hubs recover per index), PvP with the sorted union (the router does).
    const legSignatures = {
      usdc: p.usdcLeg.participants.map((m) => pass.consents.get(m.toLowerCase())!.usdcConsent!),
      eurc: p.eurcLeg.participants.map((m) => pass.consents.get(m.toLowerCase())!.eurcConsent!),
    };
    const pvpSignatures = u.map((m) => pass.consents.get(m.toLowerCase())!.pvpSignature);
    try {
      const txHash = await args.submit(p, legSignatures, pvpSignatures);
      return {
        kind: "settled",
        proposal: p,
        results,
        legSignatures,
        pvpSignatures,
        txHash,
        excluded,
        passCount,
        pass1,
      };
    } catch (e) {
      // Submission failure surfaces as data; the chain-aware wrapper
      // classifies it from RoundExecuted digests and BOTH chains' nonces —
      // never from this string. `submitted` carries the broadcast bundle so
      // that reconciliation can fold a mined-but-receipt-lost settlement.
      return {
        kind: "aborted",
        stage: "submit",
        reason: e instanceof Error ? e.message : String(e),
        submitted: { proposal: p, results },
        excluded,
        passCount,
        pass1,
      };
    }
  };

  if (pass1.consents.size === union.length) {
    return finalize(proposal, { usdc: resultU, eurc: resultE }, union, pass1, [], 1);
  }

  // D-09 simplest safe rule: everyone who timed out or refused pass 1 is
  // excluded from BOTH legs together in ONE batch — a member dropped from one
  // leg cannot linger in the other, so no cross-leg identity mismatch exists.
  const excluded: Address[] = [...pass1.timedOut, ...pass1.refused.map((r) => r.address)];

  // Both legs rebuild at their UNCHANGED per-hub nonces — nothing executed.
  const rebuiltU = rebuildProposal(usdc.hub, usdc.expectedRoundNonce, usdc.ious, excluded, legOpts(usdc));
  const rebuiltE = rebuildProposal(eurc.hub, eurc.expectedRoundNonce, eurc.ious, excluded, legOpts(eurc));

  if (rebuiltU.result.participants.length < 2 || rebuiltE.result.participants.length < 2) {
    return {
      kind: "aborted",
      stage: "quorum",
      reason:
        `quorum: rebuilt legs have ${rebuiltU.result.participants.length} (usdc) / ` +
        `${rebuiltE.result.participants.length} (eurc) participant(s), each needs at least 2 (D-01)`,
      excluded,
      passCount: 1,
      pass1,
    };
  }

  // The leg digests changed, so the PvPRound digest changed transitively —
  // EVERY signature (both legs' consents and all PvPRound signatures) is
  // recollected in pass 2. The unchanged-leg optimization (keeping consents
  // for a leg whose digest happens to be identical) is real but deliberately
  // skipped: it buys a rare saving at the cost of per-leg consent bookkeeping
  // across passes (RESEARCH open question 2 — full recollection chosen).
  const proposal2 = buildPvPProposal(
    router,
    rebuiltU.proposal,
    rebuiltE.proposal,
    fxNumerator,
    fxDenominator,
    chainId,
  );
  const union2 = unionParticipants(rebuiltU.proposal.participants, rebuiltE.proposal.participants);

  const pass2 = await screenPvPConsents({
    ...screenArgs,
    proposal: proposal2,
    union: union2,
    collection: await collectPvPConsents(proposal2, union2, excluded, providers, windowMs),
  });

  if (pass2.consents.size !== union2.length) {
    // Hard 2-pass cap (D-03/D-09): any pass-2 stall or refusal aborts the
    // whole bundle cleanly — nothing settles on either hub, never a pass 3.
    return {
      kind: "aborted",
      stage: "consent",
      reason:
        `pass 2 incomplete: ${pass2.timedOut.length} timeout(s), ` +
        `${pass2.refused.length} refusal(s) — bundle aborted (D-03)`,
      excluded,
      passCount: 2,
      pass1,
    };
  }

  return finalize(
    proposal2,
    { usdc: rebuiltU.result, eurc: rebuiltE.result },
    union2,
    pass2,
    excluded,
    2,
  );
}

/** One hub's WR-01 pending record: what was in flight, recorded BEFORE broadcast. */
export interface PvPPending {
  roundNonce: bigint;
  digest: Hex;
  consumedIds: Hex[];
  sentAtBlock: bigint;
}

/**
 * The per-hub state surface the wrapper mutates. demo/coordinator.ts's
 * Coordinator satisfies it structurally (openIous getter, settledIds/
 * redeemedIds/rounds fields, hold/release) — the wrapper gains NO authority:
 * it can only freeze round assembly and fold confirmed settlement data.
 */
export interface PvPLegState {
  readonly openIous: SignedIou[];
  settledIds: Set<Hex>;
  redeemedIds: Set<Hex>;
  rounds: ExecutedRound[];
  hold(reason: string): void;
  release(): void;
  /** WR-01: record this leg's in-flight submission BEFORE broadcast, so the
   * state owner's own reconcile machinery (Coordinator's
   * reconcilePendingSubmission) folds or discards it from RoundExecuted logs
   * before its next round — even if this wrapper never returns. */
  recordPendingSubmission(p: PvPPending & { txHash?: Hex }): void;
  /** Drop the pending record once its outcome is known and folded (settled)
   * or definitively nothing-executed (mined-and-reverted). */
  clearPendingSubmission(): void;
  /** CR-03: true while this state already owns a submission whose fate is
   * unknown. Recording over one destroys the only copy of the data needed to
   * fold it, so the bundle must not start. Optional so structurally-typed
   * stubs stay valid; the state owner's own recordPendingSubmission is the
   * backstop that refuses the clobber outright. */
  hasPendingSubmission?(): boolean;
}

/** One hub's injected dependencies: address, a HubClient-shaped reader
 *  (live nonce + RoundExecuted digests), and the coordinator (or equivalent)
 *  state surface. */
export interface PvPLegDeps {
  hub: Address;
  reader: {
    roundNonce(): Promise<bigint>;
    /** RoundExecuted roundHash values for `roundNonce` since `fromBlock` —
     * matched against the submitted leg digest to distinguish "our round
     * executed" from "a concurrent one did" (WR-02). */
    roundExecutedHashes(roundNonce: bigint, fromBlock: bigint): Promise<Hex[]>;
  };
  state: PvPLegState;
}

export interface PvPRunDeps {
  usdc: PvPLegDeps;
  eurc: PvPLegDeps;
  router: Address;
  /** PvPRouterClient-shaped submitter — formula-gas atomic submission. */
  routerClient: {
    executePvP(
      wallet: WalletClient,
      proposal: PvPProposal,
      legSignatures: { usdc: Hex[]; eurc: Hex[] },
      pvpSignatures: Hex[],
    ): Promise<Hex>;
  };
  relayerWallet: WalletClient;
  pub: {
    getBlockNumber(): Promise<bigint>;
    waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }>;
  };
  providers: Map<string, PvPConsentProvider>;
  quote: FxQuote;
  windowMs: number;
  now: bigint;
  chainId?: number;
  /** Observability hook: fires with both hubs' WR-01 pending records the
   * moment they are taken — always BEFORE the broadcast. */
  onPending?: (pending: { usdc: PvPPending; eurc: PvPPending }) => void;
}

/** Structured wrapper result — callers branch on `outcome`, never on throws. */
export type PvPRunResult =
  | { outcome: "settled"; txHash: Hex; rounds: { usdc: ExecutedRound; eurc: ExecutedRound } }
  | { outcome: "blocked"; reason: string }
  | { outcome: "aborted"; reason: string }
  | { outcome: "empty"; reason: string };

/**
 * Chain-aware PvP wrapper: hold BOTH hubs (Pitfall 4 — no ordinary round may
 * advance either nonce while the bundle is in flight), read both live nonces,
 * source the rate from the FX quote, run the chain-free attemptPvPRound with
 * a submit that records WR-01 pending state ON both coordinators before
 * broadcasting, and classify any submission failure from chain state — first
 * by matching each hub's RoundExecuted digest ("did OUR tx mine?"), then from
 * the two chains' nonces — never from error strings (WR-02). On settlement
 * each hub's settledIds absorbs ONLY its own leg's consumedIds and both
 * coordinators' rounds gain a PvP-tagged entry (per-hub state stays separate,
 * Pitfall 3).
 *
 * WR-01 (both halves): the pending records are persisted via each leg state's
 * recordPendingSubmission BEFORE the broadcast — so even if this wrapper dies
 * or misclassifies, each coordinator's own reconcilePendingSubmission folds
 * or discards the leg from RoundExecuted logs before its next round; consumed
 * ids can never be silently re-netted. A receipt-transport failure whose tx
 * in fact mined is additionally reconciled HERE: both legs' logged roundHash
 * matching the submitted digests reclassifies the run as settled and folds
 * immediately. The optional onPending hook remains observability-only.
 */
export async function runPvPRound(deps: PvPRunDeps): Promise<PvPRunResult> {
  const { usdc, eurc } = deps;
  const holdReason = "PvP bundle in flight — ordinary rounds refused on both hubs";
  usdc.state.hold(holdReason);
  eurc.state.hold(holdReason);
  try {
    // CR-03: `hold` is only consulted at runRound's ENTRY, so it cannot stop a
    // round already awaiting a receipt. If either leg's coordinator still owns
    // an unreconciled submission, recording ours would destroy the only copy
    // of the data needed to fold it — and with no on-chain settled-id
    // nullifier, that is a real double-settlement. Blocked-as-data.
    for (const [name, legDeps] of [
      ["usdc", usdc],
      ["eurc", eurc],
    ] as const) {
      if (legDeps.state.hasPendingSubmission?.()) {
        return {
          outcome: "blocked",
          reason:
            `${name} hub has an unreconciled submission in flight — refusing to start a PvP ` +
            `bundle until it is resolved (CONS-04)`,
        };
      }
    }
    const nonceU = await usdc.reader.roundNonce();
    const nonceE = await eurc.reader.roundNonce();
    const { fxNumerator, fxDenominator } = quoteToRate(deps.quote);

    // What submit actually broadcast — the WR-01/WR-02 reconciliation record.
    let inFlight:
      | { pending: { usdc: PvPPending; eurc: PvPPending }; txHash?: Hex }
      | undefined;

    // Fold a CONFIRMED settlement into both hubs' state. Shared by the direct
    // settled path and the digest-reconciled receipt-failure path (WR-02) so
    // the two can never diverge. Clears both pending records: folded means
    // there is nothing left to reconcile (WR-01).
    const foldSettled = (
      proposal: PvPProposal,
      results: { usdc: NetResult; eurc: NetResult },
      txHash: Hex,
      excluded: Address[],
      passCount: number,
    ): PvPRunResult => {
      const legRound = (leg: RoundProposal, result: NetResult): ExecutedRound => {
        const deltas: Record<string, string> = {};
        leg.participants.forEach((p, i) => {
          deltas[p.toLowerCase()] = leg.deltas[i].toString();
        });
        return {
          roundNonce: leg.roundNonce.toString(),
          txHash,
          manifestHash: leg.manifestHash,
          participants: leg.participants.length,
          grossVolume: result.grossVolume.toString(),
          settledVolume: result.settledVolume.toString(),
          iouCount: leg.consumedIds.length,
          deltas,
          excluded: excluded.map((a) => a.toLowerCase()),
          passCount,
          pvp: { fxNumerator: fxNumerator.toString(), fxDenominator: fxDenominator.toString() },
        };
      };
      // Pitfall 3: each hub's settledIds absorbs ONLY its own leg (ids are
      // hub-domain-separated by construction).
      const roundU = legRound(proposal.usdcLeg, results.usdc);
      const roundE = legRound(proposal.eurcLeg, results.eurc);
      for (const id of proposal.usdcLeg.consumedIds) {
        usdc.state.settledIds.add(id.toLowerCase() as Hex);
      }
      for (const id of proposal.eurcLeg.consumedIds) {
        eurc.state.settledIds.add(id.toLowerCase() as Hex);
      }
      usdc.state.rounds.push(roundU);
      eurc.state.rounds.push(roundE);
      usdc.state.clearPendingSubmission();
      eurc.state.clearPendingSubmission();
      return { outcome: "settled", txHash, rounds: { usdc: roundU, eurc: roundE } };
    };

    const attempt = await attemptPvPRound({
      usdc: {
        ious: usdc.state.openIous,
        hub: usdc.hub,
        expectedRoundNonce: nonceU,
        settledIds: usdc.state.settledIds,
        redeemedIds: usdc.state.redeemedIds,
      },
      eurc: {
        ious: eurc.state.openIous,
        hub: eurc.hub,
        expectedRoundNonce: nonceE,
        settledIds: eurc.state.settledIds,
        redeemedIds: eurc.state.redeemedIds,
      },
      router: deps.router,
      fxNumerator,
      fxDenominator,
      providers: deps.providers,
      windowMs: deps.windowMs,
      now: deps.now,
      chainId: deps.chainId,
      submit: async (proposal, legSigs, pvpSigs) => {
        const sentAtBlock = await deps.pub.getBlockNumber();
        const pending = {
          usdc: {
            roundNonce: proposal.usdcLeg.roundNonce,
            digest: proposal.usdcLeg.digest,
            consumedIds: proposal.usdcLeg.consumedIds,
            sentAtBlock,
          },
          eurc: {
            roundNonce: proposal.eurcLeg.roundNonce,
            digest: proposal.eurcLeg.digest,
            consumedIds: proposal.eurcLeg.consumedIds,
            sentAtBlock,
          },
        };
        // WR-01: persist the in-flight submission ON both coordinators BEFORE
        // broadcasting — a receipt-transport failure (or a wrapper crash) can
        // then only ever be reconciled from chain state by each coordinator's
        // reconcilePendingSubmission; consumed ids are never silently
        // re-netted. onPending stays a pure observability hook.
        inFlight = { pending };
        usdc.state.recordPendingSubmission({ ...pending.usdc });
        eurc.state.recordPendingSubmission({ ...pending.eurc });
        deps.onPending?.(pending);
        const txHash = await deps.routerClient.executePvP(
          deps.relayerWallet,
          proposal,
          legSigs,
          pvpSigs,
        );
        inFlight.txHash = txHash;
        usdc.state.recordPendingSubmission({ ...pending.usdc, txHash });
        eurc.state.recordPendingSubmission({ ...pending.eurc, txHash });
        const receipt = await deps.pub.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") {
          // Definitively mined-and-reverted — nothing executed on either hub,
          // nothing left to reconcile (mirrors the single-hub submit).
          // Classification below reads chain nonces (WR-02), never this string.
          usdc.state.clearPendingSubmission();
          eurc.state.clearPendingSubmission();
          inFlight = undefined;
          throw new Error(`pvp tx reverted: ${txHash}`);
        }
        return txHash;
      },
    });

    if (attempt.kind === "empty") return { outcome: "empty", reason: attempt.reason };

    if (attempt.kind === "aborted") {
      if (attempt.stage === "submit") {
        // WR-02: FIRST ask "did OUR OWN tx actually mine?" — a receipt-
        // transport failure after a successful broadcast advances both nonces
        // by our own tx, so nonce comparison alone would mislabel a genuine
        // settlement as blocked. The logged RoundExecuted roundHash IS the
        // signed leg digest; both legs matching means the router executed our
        // exact bundle (the router settles both legs atomically).
        if (inFlight?.txHash !== undefined && attempt.submitted !== undefined) {
          const { pending } = inFlight;
          const [hashesU, hashesE] = await Promise.all([
            usdc.reader.roundExecutedHashes(pending.usdc.roundNonce, pending.usdc.sentAtBlock),
            eurc.reader.roundExecutedHashes(pending.eurc.roundNonce, pending.eurc.sentAtBlock),
          ]);
          const ourU = hashesU.some(
            (h) => h.toLowerCase() === pending.usdc.digest.toLowerCase(),
          );
          const ourE = hashesE.some(
            (h) => h.toLowerCase() === pending.eurc.digest.toLowerCase(),
          );
          if (ourU && ourE) {
            return foldSettled(
              attempt.submitted.proposal,
              attempt.submitted.results,
              inFlight.txHash,
              attempt.excluded,
              attempt.passCount,
            );
          }
        }
        // Then classify from BOTH chains' nonces: a moved nonce with a digest
        // that is NOT ours means a concurrent round executed on that hub —
        // expected protocol behavior returned as data, not a fault. Pending
        // records (if any) stay on the coordinators for their own reconcile.
        const afterU = await usdc.reader.roundNonce();
        const afterE = await eurc.reader.roundNonce();
        if (afterU !== nonceU || afterE !== nonceE) {
          return {
            outcome: "blocked",
            reason:
              `concurrent round advanced a hub nonce (USDC ${nonceU}→${afterU}, ` +
              `EURC ${nonceE}→${afterE}) — PvP bundle stale, retry from a fresh pass`,
          };
        }
      }
      return { outcome: "aborted", reason: attempt.reason };
    }

    // Settled with a confirmed receipt — fold directly.
    return foldSettled(
      attempt.proposal,
      attempt.results,
      attempt.txHash,
      attempt.excluded,
      attempt.passCount,
    );
  } finally {
    usdc.state.release();
    eurc.state.release();
  }
}
