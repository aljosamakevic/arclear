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
import type { RoundProposal } from "./types.js";

export { clearingHubAbi };

export function publicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
}

export function walletClient(account: Account, rpcUrl?: string): WalletClient {
  return createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });
}

/** Typed wrapper around one ClearingHub deployment. */
export class HubClient {
  constructor(
    readonly hub: Address,
    readonly pub: PublicClient,
  ) {}

  collateral(participant: Address): Promise<bigint> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubAbi,
      functionName: "collateral",
      args: [participant],
    });
  }

  roundNonce(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubAbi, functionName: "roundNonce" })
      .then(BigInt);
  }

  token(): Promise<Address> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubAbi,
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
      abi: clearingHubAbi,
      functionName: "hashRound",
      args: [p.roundNonce, p.participants, p.deltas, p.manifestHash],
    });
  }

  async deposit(wallet: WalletClient, amount: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubAbi,
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
      abi: clearingHubAbi,
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
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubAbi,
      functionName: "executeRound",
      args: [
        proposal.roundNonce,
        proposal.participants,
        proposal.deltas,
        proposal.manifestHash,
        signatures,
      ],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: 1_500_000n,
    });
  }
}
