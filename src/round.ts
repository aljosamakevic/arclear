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
 * Drop every IOU touching an excluded member. Shared by rebuildProposal and
 * verifyProposal so the coordinator's rebuild and the participant's local
 * recomputation can never diverge.
 */
function filterExcluded(ious: SignedIou[], excluded: Address[]): SignedIou[] {
  if (excluded.length === 0) return ious;
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  return ious.filter(
    (s) => !ex.has(s.iou.debtor.toLowerCase()) && !ex.has(s.iou.creditor.toLowerCase()),
  );
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
  const result = net(filterExcluded(openIous, excluded), opts);
  return { proposal: buildProposal(hub, roundNonce, result, opts.chainId), result };
}

/**
 * Participant-side check before consenting: recompute the netting from the
 * IOUs *we* have seen and compare byte-for-byte with the proposal. Never trust
 * the coordinator's arithmetic — that distrust is what makes unanimity safe.
 * `opts.excluded` is out-of-band rebuild metadata folded into the local
 * recomputation: a coordinator lie about the excluded set produces a delta
 * mismatch or an explicit exclusion refusal, never a silent accept.
 *
 * WR-06 — double-consent hazard: on-chain safety binds each round
 * individually, so a coordinator concurrently collecting consents for two
 * overlapping proposals at nonces N and N+1 could settle the same paper
 * twice. Participants MUST track their outstanding (signed but unconfirmed)
 * consents: pass `opts.expectedRoundNonce` (the hub's live `roundNonce` as
 * *you* read it) and `opts.pendingConsumedIds` (the union of consumedIds
 * across your unconfirmed consents) to refuse such proposals as data.
 */
export function verifyProposal(
  hub: Address,
  proposal: RoundProposal,
  myIous: SignedIou[],
  self: Address,
  opts: {
    now: bigint;
    safetyWindowSeconds?: bigint;
    settledIds?: ReadonlySet<Hex>;
    excluded?: Address[];
    chainId?: number;
    /** Refuse unless proposal.roundNonce matches the caller's own chain read. */
    expectedRoundNonce?: bigint;
    /** Consumed ids of the caller's outstanding unconfirmed consents. */
    pendingConsumedIds?: ReadonlySet<Hex>;
  },
): { ok: boolean; reason?: string } {
  if (opts.expectedRoundNonce !== undefined && proposal.roundNonce !== opts.expectedRoundNonce) {
    return {
      ok: false,
      reason: `roundNonce mismatch: proposal says ${proposal.roundNonce}, local chain view says ${opts.expectedRoundNonce}`,
    };
  }
  if (opts.pendingConsumedIds !== undefined && opts.pendingConsumedIds.size > 0) {
    const pending = new Set<string>();
    for (const id of opts.pendingConsumedIds) pending.add(id.toLowerCase());
    for (const id of proposal.consumedIds) {
      if (pending.has(id.toLowerCase())) {
        return {
          ok: false,
          reason: `consumed id ${id} overlaps an outstanding unconfirmed consent — double-settle risk`,
        };
      }
    }
  }

  const selfLc = self.toLowerCase();
  const excluded = opts.excluded ?? [];
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  if (ex.has(selfLc)) {
    return { ok: false, reason: `self ${self} is excluded from this round` };
  }
  for (const p of proposal.participants) {
    if (ex.has(p.toLowerCase())) {
      return { ok: false, reason: `excluded address ${p} present in participants` };
    }
  }

  const idx = proposal.participants.findIndex((a) => a.toLowerCase() === selfLc);
  if (idx === -1) return { ok: false, reason: "self not in participant set" };

  const recomputed = net(filterExcluded(myIous, excluded), opts);
  const myIdx = recomputed.participants.findIndex((a) => a.toLowerCase() === selfLc);
  const myDelta = myIdx === -1 ? 0n : recomputed.deltas[myIdx];
  if (proposal.deltas[idx] !== myDelta) {
    return {
      ok: false,
      reason: `delta mismatch: proposal says ${proposal.deltas[idx]}, local view says ${myDelta}`,
    };
  }

  // No stranger-id check (IN-01): consumed ids we haven't seen locally are
  // fine as long as they don't involve us — we can't tell from ids alone, but
  // our delta already pins the sum of everything that involves us.

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
