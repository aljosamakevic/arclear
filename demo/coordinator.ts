import type { Address, Hex } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { net } from "../src/netting.js";
import { buildProposal, signConsent, verifyProposal } from "../src/round.js";
import { HubClient } from "../src/client.js";
import type { RoundProposal, SignedIou } from "../src/types.js";
import type { AgentPersona } from "./agents.js";

export type RoundPhase =
  | "idle"
  | "netting"
  | "collecting-consents"
  | "submitting"
  | "confirmed"
  | "failed";

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

  constructor(
    readonly hub: Address,
    readonly hubClient: HubClient,
    readonly pub: PublicClient,
    readonly personas: AgentPersona[],
    readonly relayerWallet: WalletClient,
    readonly chainId?: number,
  ) {}

  addIous(batch: SignedIou[]) {
    this.ious.push(...batch);
  }

  /** IOUs not yet consumed by an executed round. */
  get openIous(): SignedIou[] {
    return this.ious.filter((s) => !this.settledIds.has(s.id.toLowerCase() as Hex));
  }

  async runRound(now: bigint): Promise<ExecutedRound> {
    try {
      this.phase = "netting";
      this.phaseDetail = "computing net positions";
      const result = net(this.ious, { now, settledIds: this.settledIds });
      if (result.participants.length < 2) {
        throw new Error("nothing to net — need at least 2 participants with open IOUs");
      }
      const roundNonce = await this.hubClient.roundNonce();
      const proposal = buildProposal(this.hub, roundNonce, result, this.chainId);

      this.phase = "collecting-consents";
      const signatures: Hex[] = [];
      for (let i = 0; i < proposal.participants.length; i++) {
        const persona = this.personas.find(
          (p) => p.account.address.toLowerCase() === proposal.participants[i].toLowerCase(),
        );
        if (!persona) throw new Error(`no key for participant ${proposal.participants[i]}`);

        // Each agent re-derives the netting from its own view before signing.
        const check = verifyProposal(this.hub, proposal, this.openIous, persona.account.address, {
          now,
          settledIds: this.settledIds,
          chainId: this.chainId,
        });
        if (!check.ok) throw new Error(`${persona.name} refused consent: ${check.reason}`);

        signatures.push(await signConsent(this.hub, proposal, persona.account, this.chainId));
        this.phaseDetail = `${signatures.length}/${proposal.participants.length} consents`;
      }

      this.phase = "submitting";
      this.phaseDetail = "sending executeRound";
      const txHash = await this.hubClient.executeRound(this.relayerWallet, proposal, signatures);
      const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`tx reverted: ${txHash}`);

      for (const id of proposal.consumedIds) this.settledIds.add(id.toLowerCase() as Hex);

      const deltas: Record<string, string> = {};
      proposal.participants.forEach((p, i) => {
        deltas[p.toLowerCase()] = proposal.deltas[i].toString();
      });
      const executed: ExecutedRound = {
        roundNonce: proposal.roundNonce.toString(),
        txHash,
        manifestHash: proposal.manifestHash,
        participants: proposal.participants.length,
        grossVolume: result.grossVolume.toString(),
        settledVolume: result.settledVolume.toString(),
        iouCount: proposal.consumedIds.length,
        deltas,
      };
      this.rounds.push(executed);
      this.phase = "confirmed";
      this.phaseDetail = txHash;
      return executed;
    } catch (e) {
      this.phase = "failed";
      this.lastError = e instanceof Error ? e.message : String(e);
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
      rounds: this.rounds,
    };
  }
}
