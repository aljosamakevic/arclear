import type { Address, Hex } from "viem";

/** A signed off-chain obligation: debtor owes creditor `amount` base units. */
export interface Iou {
  debtor: Address;
  creditor: Address;
  /** Token base units (6 decimals for USDC/EURC). */
  amount: bigint;
  /** Monotonic per (debtor → creditor) pair; makes every IOU unique. */
  nonce: bigint;
  /** Unix seconds. Expired IOUs are dropped by the netting engine. */
  expiry: bigint;
  /** Opaque reference: invoice id, x402 resource hash, memo hash. */
  ref: Hex;
}

export interface SignedIou {
  iou: Iou;
  signature: Hex;
  /**
   * hashTypedData of the IOU — dedup key and manifest leaf.
   *
   * DERIVED, never asserted: the debtor's signature covers `iou` only, so this
   * field carries no authority whatsoever. Every consumer that can reach the
   * hub address re-derives it with `iouId(hub, iou)` and ignores what is here
   * (CR-01) — treat it as a cache of the derivation, not as input.
   */
  id: Hex;
}

/** Net position set produced by the netting engine. */
export interface NetResult {
  /** Strictly ascending participant addresses. */
  participants: Address[];
  /** Index-aligned deltas; always sums to 0n. Negative = net debtor. */
  deltas: bigint[];
  /** Sorted ids of every IOU consumed by this netting. */
  consumedIds: Hex[];
  /** Sum of all positive deltas (== sum of |negative|): settled volume. */
  settledVolume: bigint;
  /** Sum of all IOU amounts before netting: gross volume. */
  grossVolume: bigint;
}

/** A round proposal awaiting unanimous consent. */
export interface RoundProposal {
  roundNonce: bigint;
  participants: Address[];
  deltas: bigint[];
  manifestHash: Hex;
  /** The EIP-712 digest every participant signs. */
  digest: Hex;
  consumedIds: Hex[];
}

/** A cross-currency PvP bundle: two leg proposals bound to one agreed rate. */
export interface PvPProposal {
  /** USDC-hub leg — an ordinary round proposal on the USDC hub. */
  usdcLeg: RoundProposal;
  /** EURC-hub leg — an ordinary round proposal on the EURC hub. */
  eurcLeg: RoundProposal;
  /** EURC base units per `fxDenominator` USDC base units (rate numerator). */
  fxNumerator: bigint;
  /** USDC base units the numerator is quoted against (rate denominator). */
  fxDenominator: bigint;
  /** The EIP-712 PvPRound digest every union member signs. */
  digest: Hex;
}
