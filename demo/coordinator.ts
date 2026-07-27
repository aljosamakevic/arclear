import type { Address, Hex } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { iouId } from "../src/iou.js";
import { consumedIds, net } from "../src/netting.js";
import {
  buildProposal,
  rebuildProposal,
  signConsent,
  verifyConsent,
  verifyProposal,
} from "../src/round.js";
import { HubClient, MAX_LOG_SCAN_SPAN, scanWindows } from "../src/client.js";
import { clearingHubV3Abi } from "../src/abi/ClearingHubV3.js";
import type { NetResult, RoundProposal, SignedIou } from "../src/types.js";
import type { AgentPersona } from "./agents.js";
import { redactSensitive } from "./redact.js";

export type RoundPhase =
  | "idle"
  | "netting"
  | "collecting-consents"
  | "rebuilding"
  | "collecting-consents-pass-2"
  | "submitting"
  | "confirmed"
  | "aborted"
  | "failed";

/** A member's answer to a consent request. Timeout is NOT an outcome a
 * provider returns — it is the coordinator's deadline firing (CONS-01). */
export type ConsentOutcome =
  | { kind: "consent"; signature: Hex }
  | { kind: "refusal"; reason: string };

export type ConsentProvider = (
  proposal: RoundProposal,
  excluded: Address[],
) => Promise<ConsentOutcome>;

/** Deterministic deadline snapshot of one collection pass (D-02): consents,
 * reasoned refusals, and members with neither at snapshot time. */
export interface ConsentCollection {
  /** lowercase addr -> consent signature. */
  consents: Map<string, Hex>;
  refused: { address: Address; reason: string }[];
  timedOut: Address[];
}

/**
 * Race every participant's consent provider against ONE shared wall-clock
 * deadline. When the deadline fires, the partition {consents, refused,
 * timedOut} is snapshotted immutably — later resolutions are ignored (D-02).
 * The deadline timer is cleared on early completion and unref'd so a stalled
 * provider can never hold the process open.
 */
export async function collectConsents(
  proposal: RoundProposal,
  excluded: Address[],
  providers: Map<string, ConsentProvider>,
  windowMs: number,
): Promise<ConsentCollection> {
  const consents = new Map<string, Hex>();
  const refused: { address: Address; reason: string }[] = [];
  const pending = new Set<string>(); // lowercase addrs still outstanding

  for (const participant of proposal.participants) {
    const key = participant.toLowerCase();
    if (!providers.get(key)) {
      throw new Error(`no consent provider for participant ${participant}`);
    }
    pending.add(key);
  }

  return new Promise((resolve) => {
    // Snapshot-then-ignore guard: once settled, late resolutions mutate nothing.
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timedOut = proposal.participants.filter((p) => pending.has(p.toLowerCase()));
      resolve({ consents, refused, timedOut });
    };

    const timer = setTimeout(finish, windowMs);
    timer.unref?.();

    if (pending.size === 0) {
      finish();
      return;
    }

    for (const participant of proposal.participants) {
      const key = participant.toLowerCase();
      const provider = providers.get(key)!;
      // WR-05: route the call through the microtask queue so a provider that
      // throws SYNCHRONOUSLY becomes a rejection handled by the refusal path
      // below, instead of throwing out of the Promise executor and rejecting
      // the whole collection.
      Promise.resolve()
        .then(() => provider(proposal, excluded))
        .then(
        (outcome) => {
          if (settled) return; // late — snapshot already taken (D-02)
          pending.delete(key);
          if (outcome.kind === "consent") consents.set(key, outcome.signature);
          else refused.push({ address: participant, reason: outcome.reason });
          if (pending.size === 0) finish();
        },
        (e) => {
          // A throwing provider is treated as a reasoned refusal, never a crash.
          if (settled) return;
          pending.delete(key);
          refused.push({
            address: participant,
            reason: e instanceof Error ? e.message : String(e),
          });
          if (pending.size === 0) finish();
        },
      );
    }
  });
}

/**
 * CR-01 guard: demote every collected consent whose signature does not verify
 * against the proposal digest to a refusal-for-cause. An attacker answering
 * with garbage (or someone else's) signature is thereby excluded through the
 * normal exclude-and-recompute machinery instead of causing an on-chain
 * BadSignature revert — and, per D-07, never advances the miss counter.
 * `submit` must only ever see a signature set that passed this screen.
 */
export async function screenConsents(
  hub: Address,
  proposal: RoundProposal,
  collection: ConsentCollection,
  chainId?: number,
): Promise<ConsentCollection> {
  const consents = new Map<string, Hex>();
  const refused = [...collection.refused];
  for (const participant of proposal.participants) {
    const key = participant.toLowerCase();
    const signature = collection.consents.get(key);
    if (signature === undefined) continue;
    let ok: boolean;
    try {
      ok = await verifyConsent(hub, proposal, participant, signature, chainId);
    } catch {
      ok = false; // malformed signature bytes — refusal-equivalent, never a throw
    }
    if (ok) consents.set(key, signature);
    else refused.push({ address: participant, reason: "invalid consent signature" });
  }
  return { consents, refused, timedOut: collection.timedOut };
}

/**
 * Miss-counter semantics D-06/D-07 over one collection outcome: timeout →
 * increment, consent → reset to 0, refusal → unchanged (refusal is the safety
 * mechanism working, not unresponsiveness). Mutates and returns `missed`
 * (lowercase address keys).
 */
export function applyMissSemantics(
  missed: Map<string, number>,
  outcome: ConsentCollection,
): Map<string, number> {
  for (const addr of outcome.timedOut) {
    const key = addr.toLowerCase();
    missed.set(key, (missed.get(key) ?? 0) + 1);
  }
  for (const key of outcome.consents.keys()) {
    missed.set(key.toLowerCase(), 0);
  }
  return missed;
}

/** Structured result of one two-pass round attempt. Aborts are expected
 * protocol behavior — data, never thrown errors (Pitfall 6). */
export type RoundAttemptOutcome =
  | {
      outcome: "settled";
      proposal: RoundProposal;
      result: NetResult;
      signatures: Hex[];
      txHash: Hex;
      excluded: Address[];
      passCount: 1 | 2;
      pass1: ConsentCollection;
    }
  | {
      outcome: "aborted";
      reason: string;
      excluded: Address[];
      passCount: 1 | 2;
      pass1: ConsentCollection;
    }
  | { outcome: "empty"; reason: string };

/**
 * Chain-free two-pass exclude-and-recompute core (CONS-01..03): net → propose
 * → collect pass 1 → [unanimous → submit] | [exclude timeouts∪refusals in one
 * batch (D-02) → rebuild over the SAME roundNonce (Pitfall 4) → quorum floor
 * ≥2 (D-01) → collect pass 2 → unanimous → submit | abort (D-03, hard 2-pass
 * cap)]. Pass-1 signatures never carry into pass 2 — the digest changed
 * (T-01-10). Performs no chain I/O and no settledIds mutation: the injected
 * submit callback and the caller own all side effects.
 */
export async function attemptRound(args: {
  hub: Address;
  roundNonce: bigint;
  openIous: SignedIou[];
  settledIds: ReadonlySet<Hex>;
  /** Ids extinguished on-chain via redeemIOU — excluded from netting exactly
   * like settledIds (D-14 off-chain half). */
  redeemedIds?: ReadonlySet<Hex>;
  providers: Map<string, ConsentProvider>;
  windowMs: number;
  now: bigint;
  chainId?: number;
  submit: (proposal: RoundProposal, signatures: Hex[]) => Promise<Hex>;
  onPhase?: (phase: RoundPhase, detail: string) => void;
}): Promise<RoundAttemptOutcome> {
  const { hub, roundNonce, openIous, settledIds, redeemedIds, providers, windowMs, now, chainId, submit } =
    args;
  const opts = { now, settledIds, redeemedIds, chainId };

  // CR-01: bind the hub so every manifest leaf is DERIVED from the IOU we
  // hold — a submitter-supplied `SignedIou.id` never reaches the manifest.
  const result = net(openIous, { ...opts, hub });
  if (result.participants.length < 2) {
    return {
      outcome: "empty",
      reason: "nothing to net — need at least 2 participants with open IOUs",
    };
  }
  const proposal = buildProposal(hub, roundNonce, result, chainId);

  args.onPhase?.("collecting-consents", `pass 1: ${proposal.participants.length} members`);
  // CR-01: every collected signature is locally verified before it can count.
  const pass1 = await screenConsents(
    hub,
    proposal,
    await collectConsents(proposal, [], providers, windowMs),
    chainId,
  );

  if (pass1.consents.size === proposal.participants.length) {
    // Signatures index-aligned with participants — the contract recovers per index.
    const signatures = proposal.participants.map((p) => pass1.consents.get(p.toLowerCase())!);
    const txHash = await submit(proposal, signatures);
    return { outcome: "settled", proposal, result, signatures, txHash, excluded: [], passCount: 1, pass1 };
  }

  // D-02: everyone who timed out or refused pass 1 is excluded together in ONE batch.
  const excluded: Address[] = [...pass1.timedOut, ...pass1.refused.map((r) => r.address)];

  args.onPhase?.("rebuilding", `excluding ${excluded.length} member(s), recomputing`);
  // Pitfall 4: SAME roundNonce as pass 1 — nothing executed yet.
  const rebuilt = rebuildProposal(hub, roundNonce, openIous, excluded, opts);

  if (rebuilt.result.participants.length < 2) {
    return {
      outcome: "aborted",
      reason: `quorum: rebuilt round has ${rebuilt.result.participants.length} participant(s), need at least 2 (D-01)`,
      excluded,
      passCount: 1,
      pass1,
    };
  }

  args.onPhase?.(
    "collecting-consents-pass-2",
    `pass 2: ${rebuilt.result.participants.length} members`,
  );
  // CR-01: an invalid pass-2 signature is a refusal → the incompleteness
  // branch below aborts cleanly (D-03) instead of reverting on-chain.
  const pass2 = await screenConsents(
    hub,
    rebuilt.proposal,
    await collectConsents(rebuilt.proposal, excluded, providers, windowMs),
    chainId,
  );

  if (pass2.consents.size !== rebuilt.proposal.participants.length) {
    // D-03: any pass-2 stall or refusal aborts cleanly — never a third collection.
    return {
      outcome: "aborted",
      reason: `pass 2 incomplete: ${pass2.timedOut.length} timeout(s), ${pass2.refused.length} refusal(s) — attempt aborted (D-03)`,
      excluded,
      passCount: 2,
      pass1,
    };
  }

  const signatures = rebuilt.proposal.participants.map((p) => pass2.consents.get(p.toLowerCase())!);
  const txHash = await submit(rebuilt.proposal, signatures);
  return {
    outcome: "settled",
    proposal: rebuilt.proposal,
    result: rebuilt.result,
    signatures,
    txHash,
    excluded,
    passCount: 2,
    pass1,
  };
}

/** Structured runRound result — the /round handler branches on `outcome`
 * instead of catching throws (Pitfall 6). */
export type RunRoundResult =
  | { outcome: "settled"; round: ExecutedRound }
  | { outcome: "aborted"; reason: string; excluded: string[]; passCount: number }
  | { outcome: "empty"; reason: string };

export interface ExecutedRound {
  roundNonce: string;
  txHash: Hex;
  manifestHash: Hex;
  participants: number;
  grossVolume: string;
  settledVolume: string;
  iouCount: number;
  /** address (lowercase) -> signed delta in base units, as strings. */
  deltas: Record<string, string>;
  /** Members excluded by the pass-1 snapshot (lowercase); [] for 1-pass rounds (D-14). */
  excluded: string[];
  /** Signature-collection passes it took to settle: 1 or 2 (hard cap, D-03). */
  passCount: number;
  /** Present iff this round settled as one leg of an atomic PvP bundle: the
   * agreed rate as num/den base-unit strings (D-04). Flows through /state's
   * existing rounds serialization — no new endpoint (D-12). */
  pvp?: { fxNumerator: string; fxDenominator: string };
}

/** One broadcast (or attempted broadcast) awaiting a verdict from chain state. */
export interface PendingSubmission {
  roundNonce: bigint;
  digest: Hex;
  consumedIds: Hex[];
  sentAtBlock: bigint;
  txHash?: Hex;
}

/**
 * CR-02: how long a pending record whose transaction can still plausibly mine
 * keeps blocking new rounds. Past this the record moves to
 * `unresolvedSubmissions` (still reconciled every round, just no longer
 * blocking), so a transport failure degrades into a delay instead of a
 * permanent wedge. Arc blocks are fast; 50 is far beyond any honest inclusion
 * delay while staying short enough that a hosted demo recovers by itself.
 */
export const PENDING_MAX_BLOCKS = 50n;

/**
 * CR-02: hard cap on unresolved records. Reaching it means many broadcasts in
 * a row died with the nonce unmoved — a broken relayer, not a transient blip —
 * and the safe answer is to stop assembling rounds, not to forget evidence.
 */
export const MAX_UNRESOLVED_SUBMISSIONS = 16;

/**
 * Demo coordinator: accumulates signed IOUs, runs netting rounds through the
 * full lifecycle. Holds no keys and no authority — every agent independently
 * verifies the proposal before consenting, and execution is permissionless.
 */
export class Coordinator {
  ious: SignedIou[] = [];
  settledIds = new Set<Hex>();
  /** Ids extinguished on-chain via redeemIOU (D-14). Kept SEPARATE from
   * settledIds so the dashboard/report can distinguish settled-by-round from
   * recovered-by-redemption. Folded ONLY from confirmed IouRedeemed chain
   * logs — never from miss counters, which are early warning only (D-09). */
  redeemedIds = new Set<Hex>();
  phase: RoundPhase = "idle";
  phaseDetail = "";
  rounds: ExecutedRound[] = [];
  lastError?: string;
  /** lowercase address -> consecutive missed consent windows (D-06). */
  missed = new Map<string, number>();
  /** Default wall-clock consent window per collection pass (D-05). */
  readonly consentWindowMs: number;
  /** Submitted executeRound not yet folded into settledIds (WR-01/CONS-04). */
  private pendingSubmission?: PendingSubmission;

  /**
   * CR-02: submissions evicted from the pending slot before their fate was
   * known (a broadcast whose transport died with a transaction that may still
   * be sitting in the mempool). Unblocking on them is only safe BECAUSE they
   * stay here: every later reconcile re-asks the chain "did this digest
   * execute?" and folds its consumedIds the moment it did. A record leaves
   * this list only when it is definitively resolved — executed (folded) or
   * impossible (the hub's monotonic roundNonce moved past it, so the
   * transaction can now only revert WrongRoundNonce).
   */
  private unresolvedSubmissions: PendingSubmission[] = [];

  /** External hold (Pitfall 4): while set, runRound refuses to start. The
   * PvP wrapper holds BOTH hubs' coordinators while a bundle is in flight so
   * no ordinary round can advance either leg's nonce. Holding grants no
   * authority — it can only PREVENT this instance from assembling rounds. */
  private holdReason?: string;

  constructor(
    readonly hub: Address,
    readonly hubClient: HubClient,
    readonly pub: PublicClient,
    readonly personas: AgentPersona[],
    readonly relayerWallet: WalletClient,
    readonly chainId?: number,
    opts: { consentWindowMs?: number } = {},
  ) {
    this.consentWindowMs = opts.consentWindowMs ?? 30_000;
    // Redemption scans start at the hub client's earliestBlock, never at
    // genesis — the public Arc RPC prunes old history and rejects
    // fromBlock: 0 (anvil/tests keep the 0n default). The ?? guard keeps
    // structurally-typed test stubs (cast without the field) at 0n.
    this.redemptionScanBlock = hubClient.earliestBlock ?? 0n;
  }

  /** Freeze ordinary rounds (a PvP bundle is in flight on this hub pair). */
  hold(reason: string) {
    this.holdReason = reason;
  }

  /** Lift the freeze — the PvP bundle settled, aborted, or was reconciled. */
  release() {
    this.holdReason = undefined;
  }

  /**
   * WR-01 (PvP half): record an externally-broadcast submission that consumes
   * this hub's paper — the PvP wrapper calls this for its leg BEFORE
   * broadcasting the router transaction. The record feeds the SAME
   * reconcilePendingSubmission machinery ordinary rounds use: if the receipt
   * transport fails mid-flight, the next runRound folds or discards the leg
   * from RoundExecuted logs instead of silently re-netting consumed ids.
   * Grants no authority — it can only make this instance MORE conservative.
   */
  recordPendingSubmission(p: PendingSubmission) {
    const cur = this.pendingSubmission;
    // CR-03: the pending record is the ONLY copy of the data needed to fold a
    // settlement whose receipt was lost. Overwriting it with a different
    // submission (a PvP leg landing on a coordinator that is already awaiting
    // a receipt) destroys that evidence. Refuse.
    //
    // v3 changed what is at stake here, and it is worth being precise about.
    // Under V2 the loss was a genuine DOUBLE-SETTLE: the hub gated only on
    // `redeemed[]`, so re-netting settled paper simply succeeded a second time
    // and off-chain settledIds was the sole defense. ClearingHubV3's permanent
    // `consumed` ledger closes that on-chain (`AlreadyConsumed`), so the loss
    // is now a LIVENESS failure instead: the coordinator re-proposes paper the
    // chain will refuse, burning a round and relayer gas until it re-learns
    // what settled. Strictly less severe, still worth refusing outright.
    if (cur !== undefined && cur.digest.toLowerCase() !== p.digest.toLowerCase()) {
      throw new Error(
        `refusing to overwrite an unreconciled pending submission (round ${cur.roundNonce}, ` +
          `digest ${cur.digest}) with round ${p.roundNonce} digest ${p.digest} — ` +
          `reconcile it before recording another`,
      );
    }
    this.pendingSubmission = p;
  }

  /** True while a submission's fate is unknown — a second submitter must not
   *  start one here (CR-03). Includes records that stopped blocking but are
   *  still awaiting a chain verdict. */
  hasPendingSubmission(): boolean {
    return this.pendingSubmission !== undefined || this.unresolvedSubmissions.length > 0;
  }

  /** Drop the pending record — its outcome was confirmed and folded (or it
   * definitively reverted with nothing executed). */
  clearPendingSubmission() {
    this.pendingSubmission = undefined;
  }

  /**
   * CR-01: re-derive every incoming id from (hub, iou) before the paper enters
   * the pool. `net()` derives independently, so this is not what makes the
   * manifest safe — it keeps the coordinator's OWN bookkeeping (openIous,
   * settledIds folds, the dashboard's id column) keyed on the same id the
   * manifest and the hub's nullifier use, instead of on whatever the submitter
   * claimed.
   */
  addIous(batch: SignedIou[]) {
    for (const s of batch) {
      const id = iouId(this.hub, s.iou, this.chainId);
      this.ious.push(s.id === id ? s : { ...s, id });
    }
  }

  /** IOUs not yet consumed by an executed round nor redeemed on-chain. */
  get openIous(): SignedIou[] {
    return this.ious.filter(
      (s) =>
        !this.settledIds.has(s.id.toLowerCase() as Hex) &&
        !this.redeemedIds.has(s.id.toLowerCase() as Hex),
    );
  }

  /** Highest block already folded into redeemedIds; scans resume here.
   * Initialized in the constructor to hubClient.earliestBlock. */
  private redemptionScanBlock: bigint;

  /**
   * D-14 (off-chain half): redemption happens OUTSIDE the coordinator — a
   * creditor submits redeemIOU directly — so the coordinator's view must
   * converge from chain logs alone. Fold every confirmed IouRedeemed event's
   * id into redeemedIds so redeemed paper can never re-enter a proposal.
   * Miss counters are never consulted: on-chain nullifiers are the only
   * source of redemption truth (D-09).
   */
  private async reconcileRedeemedIds(): Promise<void> {
    // cacheTime: 0 — viem's 4 s getBlockNumber cache would make `tip` an
    // UPPER scan bound in the past, so a redemption mined seconds ago is
    // missed, its id survives into the next proposal, and the round reverts
    // NullifiedIdInManifest (safe on-chain, wasted round + relayer gas).
    // Same defect class as E-CR-03 in fetchManifest.
    const tip = await this.pub.getBlockNumber({ cacheTime: 0 });
    // Windowed scan: live Arc providers cap per-request log spans (and prune
    // genesis history), and the first scan of a session starts back at the
    // hub's deploy block. Later scans resume near the tip → single window.
    for (const [fromBlock, toBlock] of scanWindows(
      this.redemptionScanBlock,
      tip,
      MAX_LOG_SCAN_SPAN,
    )) {
      const logs = await this.pub.getContractEvents({
        address: this.hub,
        abi: clearingHubV3Abi,
        eventName: "IouRedeemed",
        fromBlock,
        toBlock,
      });
      for (const l of logs) {
        const id = l.args.id;
        if (id) this.redeemedIds.add(id.toLowerCase() as Hex);
      }
    }
    // Next scan re-covers the tip block — the Set fold is idempotent, so an
    // overlapping range can never double-count and a race can never skip.
    this.redemptionScanBlock = tip;
  }

  /**
   * Did THIS exact submission execute? The logged `roundHash` IS the EIP-712
   * digest the participants signed, so a digest match at the record's nonce is
   * proof — independent of whose transaction carried it or whether we ever saw
   * a receipt. Folds the consumedIds on a match.
   */
  private async foldIfExecuted(record: PendingSubmission): Promise<boolean> {
    const logs = await this.pub.getContractEvents({
      address: this.hub,
      // WR-02 (review): bind to the deployed contract's ABI. The v1/v2/v3
      // RoundExecuted signatures happen to be byte-identical today, but a
      // future event change must not silently zero out this "was our round
      // mined?" check — that would re-propose already-settled paper.
      abi: clearingHubV3Abi,
      eventName: "RoundExecuted",
      args: { roundNonce: record.roundNonce },
      fromBlock: record.sentAtBlock,
    });
    const ours = logs.some(
      (l) => (l.args.roundHash ?? "").toLowerCase() === record.digest.toLowerCase(),
    );
    if (ours) {
      for (const id of record.consumedIds) this.settledIds.add(id.toLowerCase() as Hex);
    }
    return ours;
  }

  /**
   * v3 exclusivity self-heal. ClearingHubV3 makes "one IOU, one settlement" an
   * ON-CHAIN invariant: a round naming a leaf some earlier round already netted
   * reverts `AlreadyConsumed`, and one naming a redeemed id reverts
   * `NullifiedIdInManifest`. V2 had neither gate — it accepted the duplicate
   * and settled the same paper twice — so under V3 the coordinator's
   * `settledIds`/`redeemedIds` stopped being a nicety and became a LIVENESS
   * REQUIREMENT: a single stale entry makes every subsequent round revert, and
   * since the nonce never moves, nothing else in the reconcile machinery can
   * tell the coordinator why.
   *
   * This is the "why". Explicit gas skips simulation, so no decoded custom
   * error ever reaches us — the classification must come from chain STATE. For
   * each entry of the reverted proposal we ask the two ledgers directly and
   * fold whatever they confirm, so the next round is assembled without that
   * paper and settles normally. Returns how many entries were extinguished
   * out from under us; 0 means the revert had some other cause.
   *
   * Reads are O(m) and only ever run on the failure path.
   */
  private async foldAlreadyExtinguished(proposal: RoundProposal): Promise<number> {
    let folded = 0;
    for (const c of proposal.consumed) {
      // `consumed` is keyed by the PARTY-BOUND leaf — the same key
      // executeRound writes and redeemIOU reads. Asking by raw id would ask
      // the wrong question entirely.
      if (await this.hubClient.consumed(c.leafId)) {
        this.settledIds.add(c.id.toLowerCase() as Hex);
        folded++;
        continue;
      }
      if (await this.hubClient.redeemed(c.id)) {
        this.redeemedIds.add(c.id.toLowerCase() as Hex);
        folded++;
      }
    }
    return folded;
  }

  /**
   * CR-02: is one of OUR OWN transactions still able to mine? The relayer's
   * pending-vs-latest transaction count answers it exactly: equal counts mean
   * the mempool holds nothing of ours, so a submission whose nonce never moved
   * definitively did not execute and never will. Unknown (no relayer address,
   * an RPC that cannot answer) is treated as "yes, possibly" — the block bound
   * is what guarantees progress in that case, never an optimistic guess.
   */
  private async relayerMayStillMine(): Promise<boolean> {
    const from = this.relayerWallet?.account?.address;
    if (from === undefined || typeof this.pub.getTransactionCount !== "function") return true;
    try {
      const [latest, pending] = await Promise.all([
        this.pub.getTransactionCount({ address: from, blockTag: "latest" }),
        this.pub.getTransactionCount({ address: from, blockTag: "pending" }),
      ]);
      return pending !== latest;
    } catch {
      return true;
    }
  }

  /**
   * CR-02: re-ask the chain about every submission we stopped blocking on.
   * Executed → fold. Nonce moved past it → it can only revert WrongRoundNonce
   * now, so it is dead. Anything else stays on the list.
   */
  private async reconcileUnresolvedSubmissions(onChainNonce: bigint): Promise<void> {
    if (this.unresolvedSubmissions.length === 0) return;
    const keep: PendingSubmission[] = [];
    for (const record of this.unresolvedSubmissions) {
      if (await this.foldIfExecuted(record)) continue; // settled — folded
      if (onChainNonce > record.roundNonce) continue; // can never execute now
      keep.push(record);
    }
    this.unresolvedSubmissions = keep;
  }

  /**
   * WR-01 (CONS-04 "never twice"): a submitted executeRound whose receipt wait
   * failed (RPC transport error, crash) may still have mined. Before netting
   * again, reconcile against chain state: fold the pending proposal's
   * consumedIds into settledIds iff its RoundExecuted log is on-chain — the
   * logged `roundHash` IS the EIP-712 digest participants signed — and refuse
   * to start a new round while the submission is still genuinely in flight.
   *
   * CR-02: "still in flight" is now BOUNDED and self-healing. The old third
   * branch returned blocked forever for the commonest failure of all — an
   * executeRound call that threw before any transaction existed (a 429), which
   * left a record with no txHash and an unmoved nonce that nothing could ever
   * resolve. Three escapes now exist, in increasing order of caution: the
   * relayer's own mempool proves nothing of ours can mine; the receipt proves
   * a revert; or the record ages out of the blocking slot into
   * `unresolvedSubmissions`, where it keeps being reconciled every round.
   */
  private async reconcilePendingSubmission(): Promise<
    { blocked: false } | { blocked: true; reason: string }
  > {
    const pending = this.pendingSubmission;
    const onChainNonce = await this.hubClient.roundNonce();
    await this.reconcileUnresolvedSubmissions(onChainNonce);
    if (this.unresolvedSubmissions.length >= MAX_UNRESOLVED_SUBMISSIONS) {
      return {
        blocked: true,
        reason:
          `${this.unresolvedSubmissions.length} submissions are still unresolved on-chain — ` +
          `refusing to assemble more rounds until the relayer's transactions settle (CONS-04)`,
      };
    }
    if (!pending) return { blocked: false };
    if (onChainNonce > pending.roundNonce) {
      // The nonce was consumed — by our round or by a concurrent one. Either
      // way ours can no longer execute, so the record is resolved here.
      await this.foldIfExecuted(pending);
      this.pendingSubmission = undefined;
      return { blocked: false };
    }
    if (pending.txHash) {
      const receipt = await this.pub
        .getTransactionReceipt({ hash: pending.txHash })
        .catch(() => null);
      if (receipt) {
        // Mined but the nonce did not advance — it reverted; nothing executed.
        this.pendingSubmission = undefined;
        return { blocked: false };
      }
    }

    // Nothing executed at this nonce: executeRound is roundNonce's only writer
    // and it is monotonic, so an unmoved nonce PROVES this submission has not
    // settled. The sole residual risk is one of our own transactions still
    // waiting in the mempool.
    if (!(await this.relayerMayStillMine())) {
      this.pendingSubmission = undefined;
      return { blocked: false };
    }

    const tip = await this.pub.getBlockNumber({ cacheTime: 0 }).catch(() => undefined);
    if (tip !== undefined && tip > pending.sentAtBlock + PENDING_MAX_BLOCKS) {
      // Aged out of the blocking slot. It is NOT forgotten: it keeps being
      // reconciled every round until the chain says executed or impossible,
      // which is what makes unblocking here safe.
      this.unresolvedSubmissions.push(pending);
      this.pendingSubmission = undefined;
      this.lastError = redactSensitive(
        `submission for round ${pending.roundNonce} unconfirmed after ${PENDING_MAX_BLOCKS} ` +
          `blocks — still tracked for reconciliation, new rounds resumed`,
      );
      return { blocked: false };
    }

    return {
      blocked: true,
      reason:
        "previous submission still unconfirmed — refusing to start a new round (CONS-04)",
    };
  }

  async runRound(now: bigint, windowMs?: number): Promise<RunRoundResult> {
    // Pitfall 4: refuse to start while a PvP bundle holds this hub — an
    // ordinary round advancing the nonce would make the router revert
    // WrongRoundNonce on an otherwise-valid bundle. Blocked-as-data, no I/O.
    if (this.holdReason !== undefined) {
      this.phase = "aborted";
      this.phaseDetail = this.holdReason;
      return { outcome: "aborted", reason: this.holdReason, excluded: [], passCount: 0 };
    }
    try {
      this.phase = "netting";
      this.phaseDetail = "computing net positions";
      this.lastError = undefined;

      // WR-01: reconcile any submitted-but-unconfirmed round before re-netting,
      // so the same paper can never be settled twice by an unknowing restart.
      const reconciled = await this.reconcilePendingSubmission();
      if (reconciled.blocked) {
        this.phase = "aborted";
        this.phaseDetail = reconciled.reason;
        return { outcome: "aborted", reason: reconciled.reason, excluded: [], passCount: 0 };
      }

      // D-14: converge redeemedIds with on-chain nullifier state before
      // netting — a redemption submitted by any creditor since the last round
      // must drop its paper from this round's candidate view.
      await this.reconcileRedeemedIds();

      const roundNonce = await this.hubClient.roundNonce();

      // WR-03: ONE IOU snapshot per attempt — the proposal and every provider
      // must verify against the same set even while /simulate streams new
      // IOUs into `this.ious` mid-round.
      const openIous = this.openIous;

      // Provider map: a stalled persona never answers (D-13); an honest one
      // re-derives the netting from its own view — folding the excluded list
      // into the local recomputation — and refuses AS DATA on any mismatch.
      const providers = new Map<string, ConsentProvider>();
      for (const persona of this.personas) {
        providers.set(persona.account.address.toLowerCase(), (proposal, excluded) => {
          if (persona.stalled) return new Promise<ConsentOutcome>(() => {});
          return (async (): Promise<ConsentOutcome> => {
            // WR-06 (second half): union of consumed ids across outstanding
            // signed-but-unconfirmed consents, read LIVE at verification time.
            // The demo's sequential single-round invariant keeps this empty
            // in practice, but the wiring must exist — an integrator copying
            // this reference for a concurrent coordinator inherits the
            // double-settle guard instead of a dead branch.
            // (Demo simplification: personas share the coordinator's
            // pendingSubmission view; real members track their own consents.)
            const pendingConsumedIds = new Set<Hex>(
              (this.pendingSubmission?.consumedIds ?? []).map(
                (id) => id.toLowerCase() as Hex,
              ),
            );
            const check = verifyProposal(
              this.hub,
              proposal,
              openIous,
              persona.account.address,
              {
                now,
                settledIds: this.settledIds,
                redeemedIds: this.redeemedIds,
                excluded,
                chainId: this.chainId,
                // WR-06: pin the proposal to the round nonce read from chain.
                // (Demo simplification: personas share the coordinator's read;
                // real members read the hub's roundNonce themselves.)
                expectedRoundNonce: roundNonce,
                pendingConsumedIds,
              },
            );
            if (!check.ok) return { kind: "refusal", reason: `${persona.name}: ${check.reason}` };
            return {
              kind: "consent",
              signature: await signConsent(this.hub, proposal, persona.account, this.chainId),
            };
          })();
        });
      }

      const submit = async (proposal: RoundProposal, signatures: Hex[]): Promise<Hex> => {
        this.phase = "submitting";
        this.phaseDetail = "sending executeRound";
        // WR-01: record the in-flight submission BEFORE broadcasting, so a
        // receipt-transport failure is reconciled on the next round instead of
        // silently re-netting (and re-settling) the same paper.
        // Cached tip is fine here (unlike the two scan UPPER bounds): this is
        // a LOWER bound for the reconciliation scan, so staleness can only
        // widen the range — never hide a RoundExecuted log.
        const sentAtBlock = await this.pub.getBlockNumber();
        // CR-03: through the guarded setter, so this can never silently
        // destroy an unreconciled record (e.g. a PvP leg recorded concurrently
        // on this same coordinator).
        const record: PendingSubmission = {
          roundNonce: proposal.roundNonce,
          digest: proposal.digest,
          consumedIds: consumedIds(proposal.consumed),
          sentAtBlock,
        };
        this.recordPendingSubmission(record);
        const txHash = await this.hubClient.executeRound(this.relayerWallet, proposal, signatures);
        record.txHash = txHash;
        this.recordPendingSubmission(record);
        const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") {
          // Definitively mined-and-reverted: nothing executed, nothing pending.
          this.pendingSubmission = undefined;
          // WR-02: classify a nonce race from chain state, not error strings —
          // the explicit gas limit skips simulation, so no decoded custom
          // error ever reaches us. A nonce that moved past ours means a
          // concurrent round executed: expected protocol behavior, not a fault.
          const onChainNonce = await this.hubClient.roundNonce();
          if (onChainNonce !== proposal.roundNonce) {
            throw new Error(
              `WrongRoundNonce: on-chain nonce is ${onChainNonce}, submitted round used ` +
                `${proposal.roundNonce} — a concurrent round executed (tx ${txHash})`,
            );
          }
          // v3: the nonce did NOT move, so no round executed — which leaves
          // the exclusivity gates as the likely cause. Ask both ledgers and
          // fold what they confirm, so the next round is assembled clean
          // instead of re-proposing paper the chain will keep refusing.
          const extinguished = await this.foldAlreadyExtinguished(proposal);
          if (extinguished > 0) {
            throw new Error(
              `AlreadyConsumed: ${extinguished} of ${proposal.consumed.length} obligation(s) in ` +
                `round ${proposal.roundNonce} were already netted or redeemed on-chain — folded ` +
                `into local state, next round rebuilds without them (tx ${txHash})`,
            );
          }
          throw new Error(`tx reverted: ${txHash}`);
        }
        return txHash;
      };

      const attempt = await attemptRound({
        hub: this.hub,
        roundNonce,
        openIous,
        settledIds: this.settledIds,
        redeemedIds: this.redeemedIds,
        providers,
        windowMs: windowMs ?? this.consentWindowMs,
        now,
        chainId: this.chainId,
        submit,
        onPhase: (phase, detail) => {
          this.phase = phase;
          this.phaseDetail = detail;
        },
      });

      if (attempt.outcome === "empty") {
        this.phase = "idle";
        this.phaseDetail = attempt.reason;
        return attempt;
      }

      // D-06/D-07: misses come from the PASS-1 snapshot only — a pass-2 abort
      // still records pass-1 timeouts; refusals are never counted.
      applyMissSemantics(this.missed, attempt.pass1);

      if (attempt.outcome === "aborted") {
        this.phase = "aborted";
        this.phaseDetail = attempt.reason;
        // settledIds and rounds untouched — nothing settled.
        return {
          outcome: "aborted",
          reason: attempt.reason,
          excluded: attempt.excluded.map((a) => a.toLowerCase()),
          passCount: attempt.passCount,
        };
      }

      const { proposal, result } = attempt;
      // Consumed ids join settledIds ONLY on confirmed settlement, never on abort.
      for (const c of proposal.consumed) this.settledIds.add(c.id.toLowerCase() as Hex);
      this.pendingSubmission = undefined; // folded — nothing left to reconcile (WR-01)

      const deltas: Record<string, string> = {};
      proposal.participants.forEach((p, i) => {
        deltas[p.toLowerCase()] = proposal.deltas[i].toString();
      });
      const executed: ExecutedRound = {
        roundNonce: proposal.roundNonce.toString(),
        txHash: attempt.txHash,
        manifestHash: proposal.manifestHash,
        participants: proposal.participants.length,
        grossVolume: result.grossVolume.toString(),
        settledVolume: result.settledVolume.toString(),
        iouCount: proposal.consumed.length,
        deltas,
        excluded: attempt.excluded.map((a) => a.toLowerCase()),
        passCount: attempt.passCount,
      };
      this.rounds.push(executed);
      this.phase = "confirmed";
      this.phaseDetail = attempt.txHash;
      return { outcome: "settled", round: executed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Pitfall 4: a concurrent round advanced the nonce between passes —
      // expected protocol behavior, not a fault. Next round is a fresh pass 1.
      // The marker is produced by submit's own chain-state check (WR-02).
      // Classify on the RAW message, then redact — every string below this
      // point is served to unauthenticated callers (E-CR-02).
      if (msg.includes("WrongRoundNonce")) {
        this.phase = "aborted";
        this.phaseDetail = "stale roundNonce — a concurrent round executed";
        return { outcome: "aborted", reason: redactSensitive(msg), excluded: [], passCount: 0 };
      }
      // v3 exclusivity class: someone else netted or redeemed our paper. The
      // ledger reads in submit already folded it, so this is a recoverable
      // ABORT, not a fault — wedging in `failed` would be the actual bug, since
      // the very next round rebuilds without the extinguished obligations.
      if (msg.includes("AlreadyConsumed")) {
        this.phase = "aborted";
        this.phaseDetail = "obligations already extinguished on-chain — rebuilding next round";
        return { outcome: "aborted", reason: redactSensitive(msg), excluded: [], passCount: 0 };
      }
      this.phase = "failed";
      // E-CR-02: `lastError` is durable state served by GET /state and painted
      // by every open dashboard. A raw viem transport error carries the
      // token-bearing RPC URL — the field must never hold one. The caller
      // still gets the unredacted Error (the server logs it privately).
      this.lastError = redactSensitive(msg);
      throw e;
    }
  }

  /** Aggregate stats for the dashboard. */
  async state(now: bigint) {
    const open = this.openIous;
    const preview = net(this.ious, {
      now,
      settledIds: this.settledIds,
      redeemedIds: this.redeemedIds,
      hub: this.hub,
      chainId: this.chainId,
    });
    const collateral: Record<string, string> = {};
    for (const p of this.personas) {
      collateral[p.account.address] = (
        await this.hubClient.collateral(p.account.address)
      ).toString();
    }

    const grossOut: Record<string, bigint> = {};
    const grossIn: Record<string, bigint> = {};
    for (const s of open) {
      grossOut[s.iou.debtor] = (grossOut[s.iou.debtor] ?? 0n) + s.iou.amount;
      grossIn[s.iou.creditor] = (grossIn[s.iou.creditor] ?? 0n) + s.iou.amount;
    }

    return {
      phase: this.phase,
      phaseDetail: this.phaseDetail,
      // Second, independent application of the sanitizer at the actual wire
      // boundary (E-CR-02). `lastError` is already redacted at assignment;
      // redactSensitive is idempotent, so this only guards a future writer.
      // `phaseDetail` is deliberately NOT redacted: on a confirmed round it is
      // the tx hash the dashboard turns into an ArcScan link, and it is only
      // ever set from coordinator-constructed strings, never from a raw error.
      lastError: this.lastError === undefined ? undefined : redactSensitive(this.lastError),
      agents: this.personas.map((p) => ({
        name: p.name,
        emoji: p.emoji,
        role: p.role,
        address: p.account.address,
        stalled: p.stalled,
        missedWindows: this.missed.get(p.account.address.toLowerCase()) ?? 0,
        collateral: collateral[p.account.address],
        grossOut: (grossOut[p.account.address] ?? 0n).toString(),
        grossIn: (grossIn[p.account.address] ?? 0n).toString(),
        netDelta: (() => {
          const i = preview.participants.findIndex(
            (a) => a.toLowerCase() === p.account.address.toLowerCase(),
          );
          return i === -1 ? "0" : preview.deltas[i].toString();
        })(),
      })),
      openIous: open.slice(-25).map((s) => ({
        id: s.id,
        debtor: s.iou.debtor,
        creditor: s.iou.creditor,
        amount: s.iou.amount.toString(),
        ref: s.iou.ref,
      })),
      openIouCount: open.length,
      totalIouCount: this.ious.length,
      preview: {
        grossVolume: preview.grossVolume.toString(),
        settledVolume: preview.settledVolume.toString(),
        participants: preview.participants.length,
      },
      consentWindowMs: this.consentWindowMs,
      /** lowercase address -> consecutive missed windows (D-06). */
      missed: Object.fromEntries(this.missed),
      rounds: this.rounds,
    };
  }
}
