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
 * D-15 signing convention bound L: refuse to sign IOUs with expiry > now + L.
 * UNCALIBRATED (86,400s); Phase 3 owns the real calibration.
 *
 * v3 DEMOTED THIS FROM A PROTOCOL REQUIREMENT TO A HYGIENE CONVENTION. Under
 * V2 it was load-bearing: redemption's coverage precondition compared the
 * oldest buffered root's timestamp against `expiry - L`, so an IOU signed past
 * the convention weakened its own redeemability. ClearingHubV3 deleted both
 * `MAX_IOU_LIFETIME` and the coverage rule (CR-02) — redemption is now an O(1)
 * `consumed[leafId]` read with no timing component at all, so nothing on-chain
 * reads L any more.
 *
 * It is kept because bounding how long signed paper can sit outstanding is
 * still sound counterparty-risk practice (it bounds the window in which a
 * debtor's collateral must remain sufficient), NOT because any hub enforces it.
 */
export const DEFAULT_MAX_IOU_LIFETIME_SECONDS = 86_400n;

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

/**
 * EIP-712 domain for PvPRound bundles. The router — not a hub — is the
 * verifying contract: a router deployment is permanently bound to one hub
 * pair via constructor immutables, so a PvPRound signature in this domain is
 * consent to legs on exactly that pair. Distinct name keeps wallet display
 * and fixtures self-describing.
 *
 * v3: the name is `"ArclearPvPRouterV3"`, matching PvPRouterV3.sol. Both the
 * name AND `verifyingContract` differ from the V2 router's
 * `("ArclearPvPRouter", "1")`, so a bundle consent signed for one router can
 * never be replayed as consent for the other — even though PVP_ROUND_TYPEHASH
 * is byte-identical between them.
 */
export function pvpDomain(router: Address, chainId: number = ARC_TESTNET_CHAIN_ID) {
  return {
    name: "ArclearPvPRouterV3",
    version: "1",
    chainId,
    verifyingContract: router,
  } as const;
}

/**
 * Canonical typehash (byte-matches PvPRouterV3.sol, and PvPRouter.sol before
 * it — only the domain separator distinguishes the two routers):
 * PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)
 */
export const PVP_TYPES = {
  PvPRound: [
    { name: "usdcLegDigest", type: "bytes32" },
    { name: "eurcLegDigest", type: "bytes32" },
    { name: "fxNumerator", type: "uint256" },
    { name: "fxDenominator", type: "uint256" },
  ],
} as const;
