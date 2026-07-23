import {
  createPublicClient,
  createWalletClient,
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
import type { InclusionProof, NonInclusionProof } from "./merkle.js";
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
