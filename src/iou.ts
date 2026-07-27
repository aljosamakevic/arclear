import {
  hashTypedData,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { DEFAULT_MAX_IOU_LIFETIME_SECONDS, domain, IOU_TYPES } from "./domain.js";
import type { Iou, SignedIou } from "./types.js";

function iouMessage(iou: Iou) {
  return {
    debtor: iou.debtor,
    creditor: iou.creditor,
    amount: iou.amount,
    nonce: iou.nonce,
    expiry: iou.expiry,
    ref: iou.ref,
  };
}

/**
 * Memo for iouId, keyed by the Iou OBJECT then by "hub:chainId".
 *
 * Load-bearing for CR-01: since ids are now DERIVED wherever they are
 * consumed, `net()` hashes the whole pool on every call — and verifyProposal
 * re-nets once per participant per pass, so the demo's 105-IOU pool would
 * otherwise cost ~10^4 EIP-712 hashes per round. Keying on object identity is
 * sound because `Iou` is an immutable value object by contract (src/types.ts);
 * a caller who mutates one has already invalidated its signature.
 */
const idMemo = new WeakMap<Iou, Map<string, Hex>>();

/** Canonical id: the EIP-712 digest that is also what the debtor signs. */
export function iouId(hub: Address, iou: Iou, chainId?: number): Hex {
  const key = `${hub.toLowerCase()}:${chainId ?? ""}`;
  let perDomain = idMemo.get(iou);
  const hit = perDomain?.get(key);
  if (hit !== undefined) return hit;
  const id = hashTypedData({
    domain: domain(hub, chainId),
    types: IOU_TYPES,
    primaryType: "IOU",
    message: iouMessage(iou),
  });
  if (perDomain === undefined) {
    perDomain = new Map<string, Hex>();
    idMemo.set(iou, perDomain);
  }
  perDomain.set(key, id);
  return id;
}

/**
 * D-15 L-convention check: an IOU is signable only while `expiry <= now + L`.
 * `{ ok, reason }` — never throws (verification-path convention).
 */
export function checkIouLifetime(
  iou: Iou,
  opts: { now: bigint; maxIouLifetimeSeconds?: bigint },
): { ok: boolean; reason?: string } {
  const maxLifetime = opts.maxIouLifetimeSeconds ?? DEFAULT_MAX_IOU_LIFETIME_SECONDS;
  if (iou.expiry > opts.now + maxLifetime) {
    return {
      ok: false,
      reason: `expiry ${iou.expiry} exceeds now ${opts.now} + max lifetime ${maxLifetime}`,
    };
  }
  return { ok: true };
}

/**
 * Debtor signs the IOU. `account` must control `iou.debtor`. Refuses to sign
 * past the L-convention (`expiry <= now + L`): honoring it means every round
 * consuming this IOU executes inside [expiry − L, expiry), which is exactly
 * what makes the hub's redemption coverage rule complete for honest debtors —
 * a debtor violating the convention weakens only their own double-claim
 * protection.
 */
export async function signIou(
  hub: Address,
  iou: Iou,
  account: Account,
  chainId?: number,
  opts?: { now?: bigint; maxIouLifetimeSeconds?: bigint },
): Promise<SignedIou> {
  if (account.address.toLowerCase() !== iou.debtor.toLowerCase()) {
    throw new Error(`signer ${account.address} is not debtor ${iou.debtor}`);
  }
  const now = opts?.now ?? BigInt(Math.floor(Date.now() / 1000));
  const lifetime = checkIouLifetime(iou, {
    now,
    maxIouLifetimeSeconds: opts?.maxIouLifetimeSeconds,
  });
  if (!lifetime.ok) {
    throw new Error(`refusing to sign IOU: ${lifetime.reason}`);
  }
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  const signature = await account.signTypedData({
    domain: domain(hub, chainId),
    types: IOU_TYPES,
    primaryType: "IOU",
    message: iouMessage(iou),
  });
  return { iou, signature, id: iouId(hub, iou, chainId) };
}

/**
 * Verify the debtor's signature over the IOU AND that `signed.id` is the id
 * that IOU actually has.
 *
 * CR-01: the signature covers the IOU struct only, so a valid signature says
 * nothing about the accompanying `id` — and the id is what becomes the
 * manifest leaf (and therefore what the hub's non-inclusion regime treats as
 * "already settled"). A forged id lets the same signed IOU be settled in a
 * round AND later redeemed via redeemIOU, debiting the debtor twice. The id is
 * derived, never asserted (src/types.ts), so re-deriving it here is what makes
 * "verified" mean the whole object.
 */
export async function verifyIou(
  hub: Address,
  signed: SignedIou,
  chainId?: number,
): Promise<boolean> {
  if (signed.id?.toLowerCase() !== iouId(hub, signed.iou, chainId).toLowerCase()) return false;
  return verifyTypedData({
    address: signed.iou.debtor,
    domain: domain(hub, chainId),
    types: IOU_TYPES,
    primaryType: "IOU",
    message: iouMessage(signed.iou),
    signature: signed.signature,
  });
}
