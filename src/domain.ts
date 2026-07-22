import { defineChain, type Address } from "viem";

export const ARC_TESTNET_CHAIN_ID = 5042002;

/** Arc Testnet: USDC-native gas, 20 gwei min base fee (use ≥ 25 gwei). */
export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  fees: {
    // Floor above the 20 gwei minimum base fee so txs never hang pending.
    baseFeeMultiplier: 1.5,
  },
});

/** ERC-20 interface addresses on Arc Testnet (6 decimals each). */
export const USDC: Address = "0x3600000000000000000000000000000000000000";
export const EURC: Address = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

export const MIN_MAX_FEE_PER_GAS = 25_000_000_000n; // 25 gwei

/**
 * Shared EIP-712 domain for IOUs and Rounds. Binding `verifyingContract` to
 * the hub binds the token too (one hub per ERC-20), and `chainId` kills
 * cross-chain replay. Defaults to Arc Testnet; pass the live chain id when
 * targeting anything else (e.g. a local anvil).
 */
export function domain(hub: Address, chainId: number = ARC_TESTNET_CHAIN_ID) {
  return {
    name: "ArcClearingHub",
    version: "1",
    chainId,
    verifyingContract: hub,
  } as const;
}

export const IOU_TYPES = {
  IOU: [
    { name: "debtor", type: "address" },
    { name: "creditor", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "ref", type: "bytes32" },
  ],
} as const;

export const ROUND_TYPES = {
  Round: [
    { name: "roundNonce", type: "uint64" },
    { name: "participants", type: "address[]" },
    { name: "deltas", type: "int256[]" },
    { name: "manifestHash", type: "bytes32" },
  ],
} as const;
