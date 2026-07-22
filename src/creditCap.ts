import type { Address } from "viem";
import type { SignedIou } from "./types.js";

/**
 * Bilateral credit caps — the "tab with a limit". Purely client-side risk
 * policy: a creditor refuses to render further service once a debtor's
 * unsettled paper to them exceeds the configured cap. Worst-case loss per
 * counterparty is bounded by the cap.
 */
export class CreditCapTracker {
  private exposure = new Map<string, bigint>(); // "debtor->creditor" lowercase

  constructor(
    /** Max unsettled base units we extend to any single debtor. */
    readonly defaultCap: bigint,
    private caps: Map<string, bigint> = new Map(), // per-debtor override, lowercase
  ) {}

  private key(debtor: Address, creditor: Address): string {
    return `${debtor.toLowerCase()}->${creditor.toLowerCase()}`;
  }

  capFor(debtor: Address): bigint {
    return this.caps.get(debtor.toLowerCase()) ?? this.defaultCap;
  }

  exposureOf(debtor: Address, creditor: Address): bigint {
    return this.exposure.get(this.key(debtor, creditor)) ?? 0n;
  }

  /** Would accepting this new obligation push the debtor over their cap? */
  wouldExceedCap(debtor: Address, creditor: Address, amount: bigint): boolean {
    return this.exposureOf(debtor, creditor) + amount > this.capFor(debtor);
  }

  /** Record an accepted IOU. */
  record(iou: SignedIou): void {
    const k = this.key(iou.iou.debtor, iou.iou.creditor);
    this.exposure.set(k, (this.exposure.get(k) ?? 0n) + iou.iou.amount);
  }

  /** After a settled round, consumed paper no longer counts as exposure. */
  settle(ious: SignedIou[]): void {
    for (const s of ious) {
      const k = this.key(s.iou.debtor, s.iou.creditor);
      const next = (this.exposure.get(k) ?? 0n) - s.iou.amount;
      this.exposure.set(k, next > 0n ? next : 0n);
    }
  }
}
