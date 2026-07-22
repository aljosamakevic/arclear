import {
  hashTypedData,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { domain, IOU_TYPES } from "./domain.js";
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

/** Canonical id: the EIP-712 digest that is also what the debtor signs. */
export function iouId(hub: Address, iou: Iou, chainId?: number): Hex {
  return hashTypedData({
    domain: domain(hub, chainId),
    types: IOU_TYPES,
    primaryType: "IOU",
    message: iouMessage(iou),
  });
}

/** Debtor signs the IOU. `account` must control `iou.debtor`. */
export async function signIou(
  hub: Address,
  iou: Iou,
  account: Account,
  chainId?: number,
): Promise<SignedIou> {
  if (account.address.toLowerCase() !== iou.debtor.toLowerCase()) {
    throw new Error(`signer ${account.address} is not debtor ${iou.debtor}`);
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

/** Verify the debtor's signature over the IOU. */
export async function verifyIou(
  hub: Address,
  signed: SignedIou,
  chainId?: number,
): Promise<boolean> {
  return verifyTypedData({
    address: signed.iou.debtor,
    domain: domain(hub, chainId),
    types: IOU_TYPES,
    primaryType: "IOU",
    message: iouMessage(signed.iou),
    signature: signed.signature,
  });
}
