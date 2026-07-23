import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Account } from "viem/accounts";
import { arcTestnet, MIN_MAX_FEE_PER_GAS } from "./domain.js";
import { clearingHubAbi } from "./abi/ClearingHub.js";
import { clearingHubV2Abi } from "./abi/ClearingHubV2.js";
import { nonInclusionProof, type InclusionProof, type NonInclusionProof } from "./merkle.js";
import type { Iou, RoundProposal } from "./types.js";

export { clearingHubAbi };

/**
 * executeRound gas formula coefficients — from forge-measured gasleft() deltas
 * (plan 02-05, 2026-07-23, fresh-state worst case at n=5): m=10 → 329,108;
 * m=105 → 691,708; m=250 → 1,254,993. The formula carries ≥1.5x margin at
 * every measured point (1.70x / 1.63x / 1.59x). Explicit gas is mandatory on
 * Arc: USDC is the gas token, so estimation reserves the whole balance.
 */
export const EXECUTE_ROUND_GAS_BASE = 300_000n;
export const EXECUTE_ROUND_GAS_PER_PARTICIPANT = 40_000n;
export const EXECUTE_ROUND_GAS_PER_ID = 6_000n;

/**
 * redeemIOU flat gas limit — measured 199,604 with RING=16 fully populated by
 * 8-id manifests (forge snapshot, plan 02-05, 2026-07-23). 500,000 is 2.51x
 * that, covering demo-scale ~105-id manifests (~4 extra siblings per proof,
 * ≈ +40k total).
 */
export const REDEEM_IOU_GAS = 500_000n;

export function publicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
}

export function walletClient(account: Account, rpcUrl?: string): WalletClient {
  return createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });
}

/** Solidity enum order: BelowFirst = 0, AboveLast = 1, Bracket = 2. */
const KIND_TO_UINT = { belowFirst: 0, aboveLast: 1, bracket: 2 } as const;

function toAbiInclusion(p: InclusionProof) {
  return {
    leaf: p.leaf,
    index: BigInt(p.index),
    leafCount: BigInt(p.leafCount),
    siblings: p.siblings,
  };
}

/** TS proof → ABI tuple: index/leafCount widen to bigint, kind to its enum uint. */
function toAbiProof(p: NonInclusionProof) {
  return { kind: KIND_TO_UINT[p.kind], a: toAbiInclusion(p.a), b: toAbiInclusion(p.b) };
}

/** Typed wrapper around one ClearingHubV2 deployment. */
export class HubClient {
  constructor(
    readonly hub: Address,
    readonly pub: PublicClient,
  ) {}

  collateral(participant: Address): Promise<bigint> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "collateral",
      args: [participant],
    });
  }

  roundNonce(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubV2Abi, functionName: "roundNonce" })
      .then(BigInt);
  }

  token(): Promise<Address> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "token",
    });
  }

  /** Nonce of the round AFTER the participant's last consented round (0 = never). */
  lastRound(participant: Address): Promise<bigint> {
    return this.pub
      .readContract({
        address: this.hub,
        abi: clearingHubV2Abi,
        functionName: "lastRound",
        args: [participant],
      })
      .then(BigInt);
  }

  /** Nullifier check: has this IOU id already been redeemed on-chain? */
  redeemed(id: Hex): Promise<boolean> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "redeemed",
      args: [id],
    });
  }

  /** Buffered manifest root at ring slot `nonce % RING`. */
  rootRing(slot: bigint): Promise<{ root: Hex; nonce: bigint; executedAt: bigint }> {
    return this.pub
      .readContract({
        address: this.hub,
        abi: clearingHubV2Abi,
        functionName: "rootRing",
        args: [slot],
      })
      .then(([root, nonce, executedAt]) => ({
        root,
        nonce: BigInt(nonce),
        executedAt: BigInt(executedAt),
      }));
  }

  /** On-chain IOU digest — parity-locked against the SDK's iouId. */
  hashIou(iou: Iou): Promise<Hex> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "hashIou",
      args: [iou],
    });
  }

  /** The hub's RING immutable: how many executed-round roots stay buffered. */
  ringSize(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubV2Abi, functionName: "RING" })
      .then(BigInt);
  }

  /**
   * Reconstruct round `nonce`'s consumed-id manifest from executeRound
   * calldata. The id list is signature-bound: the unanimously signed digest
   * commits to the merkle root the contract derived from this exact calldata,
   * so a creditor needs only an RPC endpoint — NEVER a coordinator endpoint,
   * which could serve a fabricated leaf set to break non-inclusion proofs.
   */
  async fetchManifest(nonce: bigint): Promise<Hex[]> {
    const logs = await this.pub.getContractEvents({
      address: this.hub,
      abi: clearingHubV2Abi,
      eventName: "RoundExecuted",
      args: { roundNonce: nonce },
      fromBlock: 0n,
    });
    if (logs.length === 0) {
      throw new Error(`no RoundExecuted event for round nonce ${nonce} at hub ${this.hub}`);
    }
    const tx = await this.pub.getTransaction({ hash: logs[logs.length - 1].transactionHash });
    const { functionName, args } = decodeFunctionData({ abi: clearingHubV2Abi, data: tx.input });
    if (functionName !== "executeRound") {
      throw new Error(`round ${nonce} tx ${tx.hash} is not an executeRound call`);
    }
    return [...args[3]];
  }

  /**
   * Assemble the full contract-shaped proof array for redeeming `id`: the
   * buffered nonce range is derived from on-chain roundNonce/RING exactly as
   * redeemIOU derives it (ascending, count = min(roundNonce, RING)) — never
   * caller-chosen. Empty manifests yield the structurally-valid placeholder
   * (the contract short-circuits sentinel roots without reading content).
   * TOCTOU: if a round lands before the redemption mines, the contract's
   * count/position check reverts and the caller simply regenerates.
   */
  async prepareRedemptionProofs(id: Hex): Promise<NonInclusionProof[]> {
    const nonce = await this.roundNonce();
    const ring = await this.ringSize();
    const count = nonce < ring ? nonce : ring;
    const proofs: NonInclusionProof[] = [];
    for (let n = nonce - count; n < nonce; n++) {
      const ids = await this.fetchManifest(n);
      proofs.push(nonInclusionProof(ids, id));
    }
    return proofs;
  }

  /** On-chain digest — used to assert parity with the SDK's roundDigest. */
  hashRound(p: {
    roundNonce: bigint;
    participants: Address[];
    deltas: bigint[];
    manifestHash: Hex;
  }): Promise<Hex> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "hashRound",
      args: [p.roundNonce, p.participants, p.deltas, p.manifestHash],
    });
  }

  async deposit(wallet: WalletClient, amount: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "deposit",
      args: [amount],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: 200_000n,
    });
  }

  async withdraw(wallet: WalletClient, amount: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "withdraw",
      args: [amount],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: 200_000n,
    });
  }

  /** Submit a fully consented round. Permissionless — any relayer works. */
  async executeRound(
    wallet: WalletClient,
    proposal: RoundProposal,
    signatures: Hex[],
  ): Promise<Hex> {
    const gas =
      EXECUTE_ROUND_GAS_BASE +
      EXECUTE_ROUND_GAS_PER_PARTICIPANT * BigInt(proposal.participants.length) +
      EXECUTE_ROUND_GAS_PER_ID * BigInt(proposal.consumedIds.length);
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "executeRound",
      args: [
        proposal.roundNonce,
        proposal.participants,
        proposal.deltas,
        proposal.consumedIds,
        signatures,
      ],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas,
    });
  }

  /** Redeem a stale-debtor IOU against the hub's buffered non-inclusion regime. */
  async redeemIOU(
    wallet: WalletClient,
    iou: Iou,
    sig: Hex,
    proofs: NonInclusionProof[],
  ): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "redeemIOU",
      args: [iou, sig, proofs.map(toAbiProof)],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: REDEEM_IOU_GAS,
    });
  }
}
