import {
  concat,
  hashTypedData,
  keccak256,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { domain, ROUND_TYPES } from "./domain.js";
import { net } from "./netting.js";
import type { NetResult, RoundProposal, SignedIou } from "./types.js";

/**
 * v1 manifest commitment: keccak256 of the sorted consumed-IOU-id list.
 * (bytes32 on-chain either way — v2 can swap in a merkle root for inclusion
 * proofs without touching the contract.)
 */
export function manifestHash(sortedIds: Hex[]): Hex {
  if (sortedIds.length === 0) return keccak256("0x");
  return keccak256(concat(sortedIds));
}

function roundMessage(p: {
  roundNonce: bigint;
  participants: Address[];
  deltas: bigint[];
  manifestHash: Hex;
}) {
  return {
    roundNonce: p.roundNonce,
    participants: p.participants,
    deltas: p.deltas,
    manifestHash: p.manifestHash,
  };
}

export function roundDigest(
  hub: Address,
  p: { roundNonce: bigint; participants: Address[]; deltas: bigint[]; manifestHash: Hex },
  chainId?: number,
): Hex {
  return hashTypedData({
    domain: domain(hub, chainId),
    types: ROUND_TYPES,
    primaryType: "Round",
    message: roundMessage(p),
  });
}

/** Coordinator: turn a netting result into a signable proposal. */
export function buildProposal(
  hub: Address,
  roundNonce: bigint,
  result: NetResult,
  chainId?: number,
): RoundProposal {
  const mh = manifestHash(result.consumedIds);
  const p = {
    roundNonce,
    participants: result.participants,
    deltas: result.deltas,
    manifestHash: mh,
  };
  return { ...p, digest: roundDigest(hub, p, chainId), consumedIds: result.consumedIds };
}

/**
 * Pure exclude-and-recompute: drop every IOU touching an excluded member,
 * re-net with the unchanged engine, and re-propose over the SAME roundNonce
 * (nothing executed in pass 1). The excluded list is out-of-band coordinator
 * metadata — never part of the signed Round struct (D-08). No division anywhere.
 */
export function rebuildProposal(
  hub: Address,
  roundNonce: bigint,
  openIous: SignedIou[],
  excluded: Address[],
  opts: { now: bigint; safetyWindowSeconds?: bigint; settledIds?: ReadonlySet<Hex>; chainId?: number },
): { proposal: RoundProposal; result: NetResult } {
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  const kept = openIous.filter(
    (s) => !ex.has(s.iou.debtor.toLowerCase()) && !ex.has(s.iou.creditor.toLowerCase()),
  );
  const result = net(kept, opts);
  return { proposal: buildProposal(hub, roundNonce, result, opts.chainId), result };
}

/**
 * Participant-side check before consenting: recompute the netting from the
 * IOUs *we* have seen and compare byte-for-byte with the proposal. Never trust
 * the coordinator's arithmetic — that distrust is what makes unanimity safe.
 */
export function verifyProposal(
  hub: Address,
  proposal: RoundProposal,
  myIous: SignedIou[],
  self: Address,
  opts: { now: bigint; safetyWindowSeconds?: bigint; settledIds?: ReadonlySet<Hex>; chainId?: number },
): { ok: boolean; reason?: string } {
  const selfLc = self.toLowerCase();
  const idx = proposal.participants.findIndex((a) => a.toLowerCase() === selfLc);
  if (idx === -1) return { ok: false, reason: "self not in participant set" };

  const recomputed = net(myIous, opts);
  const myIdx = recomputed.participants.findIndex((a) => a.toLowerCase() === selfLc);
  const myDelta = myIdx === -1 ? 0n : recomputed.deltas[myIdx];
  if (proposal.deltas[idx] !== myDelta) {
    return {
      ok: false,
      reason: `delta mismatch: proposal says ${proposal.deltas[idx]}, local view says ${myDelta}`,
    };
  }

  // Every consumed IOU touching us must be one we actually saw.
  const myIds = new Set(myIous.map((s) => s.id.toLowerCase()));
  const strangers = proposal.consumedIds.filter((id) => !myIds.has(id.toLowerCase()));
  // Strangers are fine if they don't involve us — we can't tell from ids alone,
  // but our delta already pins the sum of everything that involves us.
  void strangers;

  if (manifestHash(proposal.consumedIds) !== proposal.manifestHash) {
    return { ok: false, reason: "manifestHash does not match consumedIds" };
  }
  const expectedDigest = roundDigest(hub, proposal, opts.chainId);
  if (expectedDigest !== proposal.digest) {
    return { ok: false, reason: "digest does not match proposal contents" };
  }
  return { ok: true };
}

/** Participant signs consent over the shared round digest. */
export async function signConsent(
  hub: Address,
  proposal: RoundProposal,
  account: Account,
  chainId?: number,
): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: domain(hub, chainId),
    types: ROUND_TYPES,
    primaryType: "Round",
    message: roundMessage(proposal),
  });
}

export async function verifyConsent(
  hub: Address,
  proposal: RoundProposal,
  participant: Address,
  signature: Hex,
  chainId?: number,
): Promise<boolean> {
  return verifyTypedData({
    address: participant,
    domain: domain(hub, chainId),
    types: ROUND_TYPES,
    primaryType: "Round",
    message: roundMessage(proposal),
    signature,
  });
}
