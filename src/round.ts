import {
  hashTypedData,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { domain, ROUND_TYPES } from "./domain.js";
import { iouId } from "./iou.js";
import { manifestLeafId, merkleRoot } from "./merkle.js";
import { net } from "./netting.js";
import type {
  ConsumedIou,
  ConsumedRef,
  NetResult,
  RoundProposal,
  SignedIou,
} from "./types.js";

/**
 * v3 manifest commitment: the sorted-leaf merkle root over the PARTY-BOUND
 * leaves of the consumed set (construction spec: src/merkle.ts numbered rules
 * / docs/PROTOCOL.md). Same bytes32 field and Round EIP-712 struct as v1/v2 —
 * only the preimage changed again; the empty manifest still commits to
 * keccak256("0x") (D-04), so empty-round digests are unchanged across all
 * three versions.
 *
 * The leaves are recomputed here from each entry's `(id, debtor, creditor)`
 * rather than read from its `leafId` cache: this is the function every
 * verifier reaches for, and a cached leaf is exactly the kind of derived field
 * that must never be trusted (CR-01). `merkleRoot` then enforces strict ascent
 * and uniqueness, which is the same guard `ManifestMerkle.rootOf` applies
 * on-chain (`UnsortedLeaves`).
 */
export function manifestHash(consumed: readonly ConsumedIou[]): Hex {
  return merkleRoot(consumed.map((c) => manifestLeafId(c.id, c.debtor, c.creditor)));
}

/**
 * ABI form of a consumed set for `executeRound` / `executePvP`: each entry's
 * two parties resolved to their INDICES in `participants`.
 *
 * Order is preserved exactly — the hub requires ascent by derived leaf, which
 * is the order `net()` already produced, and reordering here would silently
 * break it. A party missing from `participants` is a caller bug (netting rule
 * 6 guarantees both parties are present), so it throws rather than returning
 * `{ ok, reason }`: the only callers are submitters that just built the set.
 */
export function consumedRefs(
  participants: readonly Address[],
  consumed: readonly ConsumedIou[],
): ConsumedRef[] {
  const idx = new Map<string, number>();
  participants.forEach((p, i) => idx.set(p.toLowerCase(), i));
  return consumed.map((c) => {
    const a = idx.get(c.debtor.toLowerCase());
    const b = idx.get(c.creditor.toLowerCase());
    if (a === undefined) {
      throw new Error(`consumed id ${c.id}: debtor ${c.debtor} is not a participant`);
    }
    if (b === undefined) {
      throw new Error(`consumed id ${c.id}: creditor ${c.creditor} is not a participant`);
    }
    // The hub rejects SelfConsumedRef; no IOU has one party (net() drops
    // nothing here, but a hand-built set could), so refuse before broadcast.
    if (a === b) throw new Error(`consumed id ${c.id}: both parties are participant ${a}`);
    return { id: c.id, partyAIdx: a, partyBIdx: b };
  });
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
  const mh = manifestHash(result.consumed);
  const p = {
    roundNonce,
    participants: result.participants,
    deltas: result.deltas,
    manifestHash: mh,
  };
  return { ...p, digest: roundDigest(hub, p, chainId), consumed: result.consumed };
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
  opts: {
    now: bigint;
    safetyWindowSeconds?: bigint;
    settledIds?: ReadonlySet<Hex>;
    redeemedIds?: ReadonlySet<Hex>;
    chainId?: number;
  },
): { proposal: RoundProposal; result: NetResult } {
  // CR-01: the hub is bound here, so ids are derived — a coordinator can never
  // rebuild a manifest around an id the debtor did not actually produce.
  const result = net(filterExcluded(openIous, excluded), { ...opts, hub });
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
 *
 * CR-01 — the local recomputation derives every id from (hub, iou) and every
 * manifest leaf from (id, debtor, creditor); the proposal's own ids and cached
 * leaves are only ever compared against, never adopted. Every obligation of
 * OURS that our recomputation consumed must be present in the manifest UNDER
 * ITS OWN PARTY PAIR.
 *
 * CR-04 — total: any malformed proposal (bad consumed set, out-of-range
 * deltas, non-address participants) is a refusal with a reason, never a throw.
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
    redeemedIds?: ReadonlySet<Hex>;
    excluded?: Address[];
    chainId?: number;
    expectedRoundNonce?: bigint;
    pendingConsumedIds?: ReadonlySet<Hex>;
  },
): { ok: boolean; reason?: string } {
  // CR-04 totality: this is a verification function — its contract is
  // `{ ok, reason }`, never a throw (CLAUDE.md). Every input below is
  // coordinator-supplied, and several of the primitives it feeds (merkleRoot's
  // strictly-ascending/bytes32 precondition, viem's int256 range check inside
  // roundDigest) are documented to throw on malformed data. An integrator's
  // auto-consent daemon must get a refusal for that, not a crash.
  try {
    return verifyProposalOrThrow(hub, proposal, myIous, self, opts);
  } catch (e) {
    return { ok: false, reason: `malformed proposal: ${e instanceof Error ? e.message : e}` };
  }
}

function verifyProposalOrThrow(
  hub: Address,
  proposal: RoundProposal,
  myIous: SignedIou[],
  self: Address,
  opts: {
    now: bigint;
    safetyWindowSeconds?: bigint;
    settledIds?: ReadonlySet<Hex>;
    /** Ids extinguished on-chain via redeemIOU — excluded from the local
     * recomputation exactly like settledIds (D-14). */
    redeemedIds?: ReadonlySet<Hex>;
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
    for (const c of proposal.consumed) {
      if (pending.has(c.id.toLowerCase())) {
        return {
          ok: false,
          reason: `consumed id ${c.id} overlaps an outstanding unconfirmed consent — double-settle risk`,
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

  // CR-01: `hub` binds the recomputation, so every id below is DERIVED from
  // the IOU we hold — the coordinator's `SignedIou.id` never enters our view.
  const mine = filterExcluded(myIous, excluded);
  const recomputed = net(mine, { ...opts, hub });
  const myIdx = recomputed.participants.findIndex((a) => a.toLowerCase() === selfLc);
  const myDelta = myIdx === -1 ? 0n : recomputed.deltas[myIdx];
  if (proposal.deltas[idx] !== myDelta) {
    return {
      ok: false,
      reason: `delta mismatch: proposal says ${proposal.deltas[idx]}, local view says ${myDelta}`,
    };
  }

  // v3 CR-01 (structural): every consumed entry must name two DISTINCT parties
  // that are both listed participants, and its cached `leafId` must be the leaf
  // those parties actually derive. All three are what the submitter's
  // `consumedRefs()` and the hub's own derivation will produce, so a mismatch
  // here is a proposal that could only ever fail on-chain — refuse it as data
  // instead of paying for a doomed round. Checking the cache is not paranoia:
  // the omission check below reads leaves, and an unchecked `leafId` would let
  // a coordinator present a self-consistent-looking manifest whose entries
  // attribute our paper to somebody else.
  const participantSet = new Set(proposal.participants.map((p) => p.toLowerCase()));
  for (const c of proposal.consumed) {
    const d = c.debtor.toLowerCase();
    const cr = c.creditor.toLowerCase();
    if (!participantSet.has(d)) {
      return { ok: false, reason: `consumed id ${c.id}: debtor ${c.debtor} is not a participant` };
    }
    if (!participantSet.has(cr)) {
      return {
        ok: false,
        reason: `consumed id ${c.id}: creditor ${c.creditor} is not a participant`,
      };
    }
    if (d === cr) {
      return { ok: false, reason: `consumed id ${c.id}: debtor and creditor are the same party` };
    }
    if (manifestLeafId(c.id, c.debtor, c.creditor).toLowerCase() !== c.leafId.toLowerCase()) {
      return {
        ok: false,
        reason: `consumed id ${c.id}: leafId does not bind the stated parties`,
      };
    }
  }

  // No stranger-id check (IN-01): consumed leaves we haven't seen locally are
  // fine as long as they don't involve us — we can't tell from leaves alone,
  // but our delta already pins the sum of everything that involves us.
  //
  // CR-01 (omission variant): the converse is NOT covered by the delta check.
  // Our delta pins only the SUM of our flows, so a coordinator can drop a pair
  // of our IOUs that cancel — or swap one of ours for a forged id — and still
  // present the delta we expect. Anything of OURS that our own recomputation
  // consumed must therefore appear in the manifest we are about to sign, or
  // that paper stays live while we consent to a round claiming to consume it.
  //
  // v3 strengthens this from ids to LEAVES: matching on the party-bound leaf
  // additionally rejects a manifest that carries our id under somebody else's
  // party pair — which commits a leaf the hub will never mark consumed for us,
  // leaving our obligation live under a round that claims to have netted it.
  const proposed = new Set<string>();
  for (const c of proposal.consumed) proposed.add(c.leafId.toLowerCase());
  const inRound = new Set<string>();
  for (const c of recomputed.consumed) inRound.add(c.leafId.toLowerCase());
  for (const s of mine) {
    if (s.iou.debtor.toLowerCase() !== selfLc && s.iou.creditor.toLowerCase() !== selfLc) continue;
    const id = iouId(hub, s.iou, opts.chainId);
    const leaf = manifestLeafId(id, s.iou.debtor, s.iou.creditor).toLowerCase();
    if (!inRound.has(leaf)) continue; // expired/settled/redeemed locally too
    if (!proposed.has(leaf)) {
      return {
        ok: false,
        reason: `my consumed id ${id.toLowerCase()} is missing from the proposal manifest`,
      };
    }
  }

  if (manifestHash(proposal.consumed) !== proposal.manifestHash) {
    return { ok: false, reason: "manifestHash does not match the consumed set" };
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
