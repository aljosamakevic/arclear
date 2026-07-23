import type { Address, Hex } from "viem";
import type { NetResult, SignedIou } from "./types.js";

/**
 * Deterministic multilateral netting. Pure function; bigint arithmetic only —
 * there is no division anywhere in the protocol.
 *
 * Rules (spec: docs/PROTOCOL.md — third parties must implement identically):
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
  },
): NetResult {
  const safety = opts.safetyWindowSeconds ?? 60n;
  const settled = opts.settledIds ?? new Set<Hex>();
  const redeemed = opts.redeemedIds ?? new Set<Hex>();

  const seen = new Set<Hex>();
  const positions = new Map<string, bigint>(); // lowercase address -> delta
  const original = new Map<string, Address>(); // lowercase -> checksummed
  const consumedIds: Hex[] = [];
  let grossVolume = 0n;

  for (const s of ious) {
    const id = s.id.toLowerCase() as Hex;
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
