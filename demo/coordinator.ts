import type { Address, Hex } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { net } from "../src/netting.js";
import {
  buildProposal,
  rebuildProposal,
  signConsent,
  verifyConsent,
  verifyProposal,
} from "../src/round.js";
import { clearingHubAbi, HubClient } from "../src/client.js";
import type { NetResult, RoundProposal, SignedIou } from "../src/types.js";
import type { AgentPersona } from "./agents.js";

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
      provider(proposal, excluded).then(
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
  providers: Map<string, ConsentProvider>;
  windowMs: number;
  now: bigint;
  chainId?: number;
  submit: (proposal: RoundProposal, signatures: Hex[]) => Promise<Hex>;
  onPhase?: (phase: RoundPhase, detail: string) => void;
}): Promise<RoundAttemptOutcome> {
  const { hub, roundNonce, openIous, settledIds, providers, windowMs, now, chainId, submit } =
    args;
  const opts = { now, settledIds, chainId };

  const result = net(openIous, opts);
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
}

/**
 * Demo coordinator: accumulates signed IOUs, runs netting rounds through the
 * full lifecycle. Holds no keys and no authority — every agent independently
 * verifies the proposal before consenting, and execution is permissionless.
 */
export class Coordinator {
  ious: SignedIou[] = [];
  settledIds = new Set<Hex>();
  phase: RoundPhase = "idle";
  phaseDetail = "";
  rounds: ExecutedRound[] = [];
  lastError?: string;
  /** lowercase address -> consecutive missed consent windows (D-06). */
  missed = new Map<string, number>();
  /** Default wall-clock consent window per collection pass (D-05). */
  readonly consentWindowMs: number;
  /** Submitted executeRound not yet folded into settledIds (WR-01/CONS-04). */
  private pendingSubmission?: {
    roundNonce: bigint;
    digest: Hex;
    consumedIds: Hex[];
    sentAtBlock: bigint;
    txHash?: Hex;
  };

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
  }

  addIous(batch: SignedIou[]) {
    this.ious.push(...batch);
  }

  /** IOUs not yet consumed by an executed round. */
  get openIous(): SignedIou[] {
    return this.ious.filter((s) => !this.settledIds.has(s.id.toLowerCase() as Hex));
  }

  /**
   * WR-01 (CONS-04 "never twice"): a submitted executeRound whose receipt wait
   * failed (RPC transport error, crash) may still have mined. Before netting
   * again, reconcile against chain state: fold the pending proposal's
   * consumedIds into settledIds iff its RoundExecuted log is on-chain — the
   * logged `roundHash` IS the EIP-712 digest participants signed — and refuse
   * to start a new round while the submission is still genuinely in flight.
   */
  private async reconcilePendingSubmission(): Promise<
    { blocked: false } | { blocked: true; reason: string }
  > {
    const pending = this.pendingSubmission;
    if (!pending) return { blocked: false };
    const onChainNonce = await this.hubClient.roundNonce();
    if (onChainNonce > pending.roundNonce) {
      // The nonce was consumed — by our round or by a concurrent one.
      const logs = await this.pub.getContractEvents({
        address: this.hub,
        abi: clearingHubAbi,
        eventName: "RoundExecuted",
        args: { roundNonce: pending.roundNonce },
        fromBlock: pending.sentAtBlock,
      });
      const ours = logs.some(
        (l) => (l.args.roundHash ?? "").toLowerCase() === pending.digest.toLowerCase(),
      );
      if (ours) {
        for (const id of pending.consumedIds) this.settledIds.add(id.toLowerCase() as Hex);
      }
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
    return {
      blocked: true,
      reason:
        "previous submission still unconfirmed — refusing to start a new round (CONS-04)",
    };
  }

  async runRound(now: bigint, windowMs?: number): Promise<RunRoundResult> {
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
            const check = verifyProposal(
              this.hub,
              proposal,
              openIous,
              persona.account.address,
              { now, settledIds: this.settledIds, excluded, chainId: this.chainId },
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
        const sentAtBlock = await this.pub.getBlockNumber();
        this.pendingSubmission = {
          roundNonce: proposal.roundNonce,
          digest: proposal.digest,
          consumedIds: proposal.consumedIds,
          sentAtBlock,
        };
        const txHash = await this.hubClient.executeRound(this.relayerWallet, proposal, signatures);
        this.pendingSubmission.txHash = txHash;
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
          throw new Error(`tx reverted: ${txHash}`);
        }
        return txHash;
      };

      const attempt = await attemptRound({
        hub: this.hub,
        roundNonce,
        openIous,
        settledIds: this.settledIds,
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
      for (const id of proposal.consumedIds) this.settledIds.add(id.toLowerCase() as Hex);
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
        iouCount: proposal.consumedIds.length,
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
      if (msg.includes("WrongRoundNonce")) {
        this.phase = "aborted";
        this.phaseDetail = "stale roundNonce — a concurrent round executed";
        return { outcome: "aborted", reason: msg, excluded: [], passCount: 0 };
      }
      this.phase = "failed";
      this.lastError = msg;
      throw e;
    }
  }

  /** Aggregate stats for the dashboard. */
  async state(now: bigint) {
    const open = this.openIous;
    const preview = net(this.ious, { now, settledIds: this.settledIds });
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
      lastError: this.lastError,
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
