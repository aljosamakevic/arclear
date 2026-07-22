import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import { signIou } from "../src/iou.js";
import type { SignedIou } from "../src/types.js";
import type { AgentPersona } from "./agents.js";

/**
 * Deterministic-ish traffic generator: each agent buys mostly from the next
 * agent in the ring (circular flows net toward zero) with some cross-traffic
 * so positions don't cancel perfectly. Amounts $0.05–$0.95 in 6-dec units.
 */
export async function simulateTraffic(
  hub: Address,
  personas: AgentPersona[],
  count: number,
  opts: { now: bigint; chainId?: number; amountDivisor?: bigint; startNonce?: Map<string, bigint> },
): Promise<SignedIou[]> {
  const n = personas.length;
  const nonces = opts.startNonce ?? new Map<string, bigint>();
  const out: SignedIou[] = [];

  for (let k = 0; k < count; k++) {
    const seed = keccak256(toHex(`traffic-${k}`));
    const r = (byte: number) => parseInt(seed.slice(2 + byte * 2, 4 + byte * 2), 16);

    const from = r(0) % n;
    // 70%: buy from the next agent in the ring; 30%: random counterparty.
    const to = r(1) % 10 < 7 ? (from + 1) % n : (from + 1 + (r(2) % (n - 1))) % n;
    if (to === from) continue;

    const debtor = personas[from];
    const creditor = personas[to];
    const amount = BigInt(50_000 + (r(3) * 3_530) % 900_000) / (opts.amountDivisor ?? 1n); // 0.05–0.95 USDC (÷ divisor)

    const pairKey = `${debtor.account.address}->${creditor.account.address}`;
    const nonce = (nonces.get(pairKey) ?? 0n) + 1n;
    nonces.set(pairKey, nonce);

    const signed = await signIou(
      hub,
      {
        debtor: debtor.account.address,
        creditor: creditor.account.address,
        amount,
        nonce,
        expiry: opts.now + 3_600n,
        ref: keccak256(toHex(`${debtor.name} buys from ${creditor.name} #${nonce}`)) as Hex,
      },
      debtor.account,
      opts.chainId,
    );
    out.push(signed);
  }
  return out;
}
