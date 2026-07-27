import type { Address, Hex } from "viem";
import { iouId } from "./iou.js";
import type { NetResult, SignedIou } from "./types.js";

/**
 * How `net()` establishes each IOU's id. Exactly one of the two shapes is
 * required — the binding is never implicit (CR-01).
 *
 * - `{ hub }`: ids are DERIVED from (hub, iou, chainId). A caller-supplied
 *   `SignedIou.id` is ignored entirely. This is the only safe mode for real
 *   paper: the id is the manifest leaf, and a manifest committing to a forged
 *   id leaves the real id un-nullified for a later redeemIOU double-debit.
 * - `{ unsafeTrustProvidedIds: true }`: ids are taken verbatim from the input.
 *   ONLY for synthetic/simulation pools whose ids are not EIP-712 digests at
 *   all (demo/flowModel.ts, demo/thresholdModel.ts). Never for signed paper.
 */
export type NetIdBinding =
  | { hub: Address; chainId?: number; unsafeTrustProvidedIds?: never }
  | { hub?: never; chainId?: number; unsafeTrustProvidedIds: true };

/**
 * Deterministic multilateral netting. Pure function; bigint arithmetic only —
 * there is no division anywhere in the protocol.
 *
 * Rules (spec: docs/PROTOCOL.md — third parties must implement identically):
 * 0. Ids are derived from (hub, iou), never read from the input, unless the
 *    caller explicitly opts into `unsafeTrustProvidedIds` (CR-01).
 * 1. Dedup by IOU id (identical ids are the same obligation).
 * 2. Drop expired: `expiry <= now + safetyWindow`.
 * 3. Drop already-settled ids (present in `settledIds`) and redeemed ids
 *    (present in `redeemedIds` — D-14: a redeemed IOU is extinguished on-chain
 *    and must never re-enter netting).
 * 4. Sum flows per participant: debtor -amount, creditor +amount.
 * 5. Participants sorted ascending by address (lowercase hex order).
 * 6. A participant stays in the round (with delta possibly 0) iff at least one
 *    of their IOUs was consumed — consent is what extinguishes their paper.
 *    Addresses with no consumed IOUs never appear.
 * 7. `consumedIds` sorted ascending — the manifest preimage.
 *
 * Output invariant: deltas sum to exactly 0n.
 */
export function net(
  ious: SignedIou[],
  opts: {
    now: bigint;
    safetyWindowSeconds?: bigint;
    settledIds?: ReadonlySet<Hex>;
    redeemedIds?: ReadonlySet<Hex>;
  } & NetIdBinding,
): NetResult {
  const safety = opts.safetyWindowSeconds ?? 60n;
  const settled = opts.settledIds ?? new Set<Hex>();
  const redeemed = opts.redeemedIds ?? new Set<Hex>();
  const hub = opts.hub;

  const seen = new Set<Hex>();
  const positions = new Map<string, bigint>(); // lowercase address -> delta
  const original = new Map<string, Address>(); // lowercase -> checksummed
  const consumedIds: Hex[] = [];
  let grossVolume = 0n;

  for (const s of ious) {
    // rule 0: derive, never trust — the forged id would otherwise become the
    // manifest leaf while the real id stayed redeemable (CR-01).
    const id = (
      hub === undefined ? s.id : iouId(hub, s.iou, opts.chainId)
    ).toLowerCase() as Hex;
    if (seen.has(id)) continue; // rule 1
    seen.add(id);
    if (s.iou.expiry <= opts.now + safety) continue; // rule 2
    if (settled.has(id) || settled.has(s.id)) continue; // rule 3 (settled)
    if (redeemed.has(id) || redeemed.has(s.id)) continue; // rule 3 (redeemed, D-14)

    const debtor = s.iou.debtor.toLowerCase();
    const creditor = s.iou.creditor.toLowerCase();
    positions.set(debtor, (positions.get(debtor) ?? 0n) - s.iou.amount);
    positions.set(creditor, (positions.get(creditor) ?? 0n) + s.iou.amount);
    original.set(debtor, s.iou.debtor);
    original.set(creditor, s.iou.creditor);
    consumedIds.push(id);
    grossVolume += s.iou.amount;
  }

  const sortedAddrs = [...positions.keys()].sort(); // rule 5 (hex lexicographic == numeric)
  const participants = sortedAddrs.map((a) => original.get(a)!);
  const deltas = sortedAddrs.map((a) => positions.get(a)!);
  consumedIds.sort(); // rule 7

  let settledVolume = 0n;
  for (const d of deltas) if (d > 0n) settledVolume += d;

  return { participants, deltas, consumedIds, settledVolume, grossVolume };
}
