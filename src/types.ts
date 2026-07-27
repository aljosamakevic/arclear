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

/**
 * One IOU a round consumes, bound to BOTH of its parties (v3 CR-01).
 *
 * V2 manifests committed a bare id, which bound the obligation to nobody: any
 * address pair could write a victim's id into a manifest and permanently
 * defeat its redemption. V3 commits `manifestLeafId(id, debtor, creditor)`
 * instead, so consuming real paper requires both parties to be signing
 * participants of the round.
 *
 * DERIVED, never asserted — exactly like `SignedIou.id`. Every field here is
 * recomputed from the IOU by whoever consumes this object; a coordinator's
 * copy is a cache of the derivation, never an input to it.
 */
export interface ConsumedIou {
  /** The IOU id — `hashIou(iou)`. Also the hub's redemption-nullifier key. */
  id: Hex;
  /** The IOU's debtor. */
  debtor: Address;
  /** The IOU's creditor. */
  creditor: Address;
  /**
   * `manifestLeafId(id, debtor, creditor)`: the manifest leaf AND the key of
   * the hub's permanent `consumed` ledger. Manifests sort ascending BY THIS,
   * never by raw id — that is what `ManifestMerkle.rootOf` receives on-chain.
   */
  leafId: Hex;
}

/**
 * `ClearingHubV3.ConsumedRef` as the ABI takes it: the id plus the two INDICES
 * into the round's `participants` array of the IOU's parties (either order —
 * `manifestLeafId` sorts the pair before hashing). Derived from
 * `ConsumedIou[]` at submission time by `consumedRefs()`, never carried
 * through the protocol: indices are meaningless without their participant
 * array, so the party-bearing `ConsumedIou` is the transportable form.
 */
export interface ConsumedRef {
  id: Hex;
  partyAIdx: number;
  partyBIdx: number;
}

/** Net position set produced by the netting engine. */
export interface NetResult {
  /** Strictly ascending participant addresses. */
  participants: Address[];
  /** Index-aligned deltas; always sums to 0n. Negative = net debtor. */
  deltas: bigint[];
  /**
   * Every IOU this netting consumes, ascending BY DERIVED LEAF (`leafId`) —
   * the manifest preimage. Both parties of every entry are guaranteed to be in
   * `participants` (netting rule 6), so `consumedRefs()` can always index them.
   */
  consumed: ConsumedIou[];
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
  /** Party-bound manifest preimage, ascending by `leafId`. */
  consumed: ConsumedIou[];
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
