import {
  hashTypedData,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { pvpDomain, PVP_TYPES } from "./domain.js";
import { verifyProposal } from "./round.js";
import type { PvPProposal, RoundProposal, SignedIou } from "./types.js";

function pvpMessage(p: {
  usdcLegDigest: Hex;
  eurcLegDigest: Hex;
  fxNumerator: bigint;
  fxDenominator: bigint;
}) {
  return {
    usdcLegDigest: p.usdcLegDigest,
    eurcLegDigest: p.eurcLegDigest,
    fxNumerator: p.fxNumerator,
    fxDenominator: p.fxDenominator,
  };
}

function proposalFields(proposal: PvPProposal) {
  return {
    usdcLegDigest: proposal.usdcLeg.digest,
    eurcLegDigest: proposal.eurcLeg.digest,
    fxNumerator: proposal.fxNumerator,
    fxDenominator: proposal.fxDenominator,
  };
}

/**
 * The EIP-712 PvPRound digest every union member signs — binds both leg
 * digests and the agreed rate. Typehash (byte-matches PvPRouter.sol):
 * PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)
 */
export function pvpDigest(
  router: Address,
  p: { usdcLegDigest: Hex; eurcLegDigest: Hex; fxNumerator: bigint; fxDenominator: bigint },
  chainId?: number,
): Hex {
  return hashTypedData({
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: pvpMessage(p),
  });
}

/** Union member signs consent over the shared PvPRound digest. */
export async function signPvPConsent(
  router: Address,
  proposal: PvPProposal,
  account: Account,
  chainId?: number,
): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: pvpMessage(proposalFields(proposal)),
  });
}

/** Verify a union member's PvPRound consent signature. */
export async function verifyPvPConsent(
  router: Address,
  proposal: PvPProposal,
  participant: Address,
  signature: Hex,
  chainId?: number,
): Promise<boolean> {
  return verifyTypedData({
    address: participant,
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: pvpMessage(proposalFields(proposal)),
    signature,
  });
}

/** Union of two strictly-ascending address lists, ascending — lowercase
 *  comparisons, checksummed output preserved. Same spec the router's on-chain
 *  sorted merge implements, INCLUDING its precondition (WR-03): the merged
 *  stream must be strictly ascending — which holds iff BOTH inputs are — and
 *  the zero address is rejected. Violations throw, exactly where the router
 *  would revert UnionNotStrictlyAscending. */
export function unionParticipants(a: Address[], b: Address[]): Address[] {
  const out: Address[] = [];
  let i = 0;
  let j = 0;
  // Mirrors _unionOf's `prev` starting at address(0): a zero-address entry
  // fails `next <= prev` immediately, as does any non-ascending step
  // (unsorted input or an in-list duplicate). Fixed-width lowercase hex
  // compares like the EVM's uint160 comparison.
  let prev = "0x" + "0".repeat(40);
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i].toLowerCase() : undefined;
    const y = j < b.length ? b[j].toLowerCase() : undefined;
    let pushed: Address;
    let next: string;
    if (y === undefined || (x !== undefined && x < y)) {
      pushed = a[i++];
      next = x as string;
    } else if (x === undefined || y < x) {
      pushed = b[j++];
      next = y;
    } else {
      // Same address in both legs: one union entry.
      pushed = a[i];
      next = x as string;
      i++;
      j++;
    }
    if (next <= prev) {
      throw new Error(
        `union not strictly ascending at ${pushed}: inputs must be strictly ascending and ` +
          `zero-address-free — the router would revert UnionNotStrictlyAscending`,
      );
    }
    prev = next;
    out.push(pushed);
  }
  return out;
}

/**
 * An FX trade pairing `u` USDC base units with `e` EURC base units is
 * consistent with the agreed rate iff `e * fxDenominator === u * fxNumerator`.
 * Convention: fxNumerator = EURC base units per fxDenominator USDC base units.
 * Pure bigint cross-multiplication — no division exists in protocol math (D-04).
 */
export function rateConsistent(
  u: bigint,
  e: bigint,
  fxNumerator: bigint,
  fxDenominator: bigint,
): boolean {
  return e * fxDenominator === u * fxNumerator;
}

/** Coordinator: bind two leg proposals and the agreed rate into one bundle. */
export function buildPvPProposal(
  router: Address,
  usdcLeg: RoundProposal,
  eurcLeg: RoundProposal,
  fxNumerator: bigint,
  fxDenominator: bigint,
  chainId?: number,
): PvPProposal {
  if (fxNumerator === 0n) throw new Error("fxNumerator must be nonzero");
  if (fxDenominator === 0n) throw new Error("fxDenominator must be nonzero");
  const digest = pvpDigest(
    router,
    {
      usdcLegDigest: usdcLeg.digest,
      eurcLegDigest: eurcLeg.digest,
      fxNumerator,
      fxDenominator,
    },
    chainId,
  );
  return { usdcLeg, eurcLeg, fxNumerator, fxDenominator, digest };
}

/** Per-leg verifyProposal passthrough — the WR-06 machinery applies per leg (D-07). */
interface LegVerifyOpts {
  safetyWindowSeconds?: bigint;
  settledIds?: ReadonlySet<Hex>;
  redeemedIds?: ReadonlySet<Hex>;
  excluded?: Address[];
  expectedRoundNonce?: bigint;
  pendingConsumedIds?: ReadonlySet<Hex>;
}

/** Group IOUs by lowercase ref — "lowercase ref -> ious sharing it". */
function byRef(ious: SignedIou[]): Map<string, SignedIou[]> {
  const map = new Map<string, SignedIou[]>();
  for (const s of ious) {
    const key = s.iou.ref.toLowerCase();
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return map;
}

/**
 * Union-member check before consenting to a PvP bundle: re-verify each leg we
 * belong to with the ordinary round machinery, check every shared-ref FX pair
 * against the agreed rate by cross-multiplication, and recompute the bundle
 * digest. Never trust the coordinator's arithmetic — same distrust that makes
 * per-leg unanimity safe (D-07).
 */
export function verifyPvPProposal(
  router: Address,
  hubUsdc: Address,
  hubEurc: Address,
  proposal: PvPProposal,
  myIousUsdc: SignedIou[],
  myIousEurc: SignedIou[],
  self: Address,
  opts: {
    now: bigint;
    chainId?: number;
    usdc?: LegVerifyOpts;
    eurc?: LegVerifyOpts;
  },
): { ok: boolean; reason?: string } {
  const selfLc = self.toLowerCase();

  // (1) Re-verify each leg the member belongs to — reason prefixed with the leg.
  if (proposal.usdcLeg.participants.some((p) => p.toLowerCase() === selfLc)) {
    const check = verifyProposal(hubUsdc, proposal.usdcLeg, myIousUsdc, self, {
      now: opts.now,
      chainId: opts.chainId,
      ...opts.usdc,
    });
    if (!check.ok) return { ok: false, reason: `usdc leg: ${check.reason}` };
  }
  if (proposal.eurcLeg.participants.some((p) => p.toLowerCase() === selfLc)) {
    const check = verifyProposal(hubEurc, proposal.eurcLeg, myIousEurc, self, {
      now: opts.now,
      chainId: opts.chainId,
      ...opts.eurc,
    });
    if (!check.ok) return { ok: false, reason: `eurc leg: ${check.reason}` };
  }

  // (2) FX-pair check (shared-ref convention, D-04): a ref on both hubs is a
  // cross-currency trade — exactly one IOU per side, directions swapped, and
  // amounts consistent with the rate by cross-multiplication. The rate is
  // deliberately NOT checked against net deltas: deltas mix FX and non-FX
  // flows, so a delta-level rate assertion is false in general (Pitfall 6)
  // and would refuse honest rounds.
  const usdcByRef = byRef(myIousUsdc);
  const eurcByRef = byRef(myIousEurc);
  // Leg-manifest id sets for the CR-01 inclusion-symmetry check below —
  // "lowercase id -> present in that leg's consumedIds".
  const usdcConsumed = new Set(proposal.usdcLeg.consumedIds.map((i) => i.toLowerCase()));
  const eurcConsumed = new Set(proposal.eurcLeg.consumedIds.map((i) => i.toLowerCase()));
  for (const [ref, uList] of usdcByRef) {
    const eList = eurcByRef.get(ref);
    if (!eList) continue;
    if (uList.length !== 1 || eList.length !== 1) {
      return {
        ok: false,
        reason: `FX ref ${ref} must pair exactly one IOU per hub: found ${uList.length} USDC, ${eList.length} EURC`,
      };
    }
    const u = uList[0].iou;
    const e = eList[0].iou;
    if (
      u.debtor.toLowerCase() !== e.creditor.toLowerCase() ||
      u.creditor.toLowerCase() !== e.debtor.toLowerCase()
    ) {
      return {
        ok: false,
        reason: `FX ref ${ref} direction violation: legs must be debtor/creditor-swapped between hubs`,
      };
    }
    if (!rateConsistent(u.amount, e.amount, proposal.fxNumerator, proposal.fxDenominator)) {
      return {
        ok: false,
        reason: `FX ref ${ref} rate inconsistency: ${u.amount} USDC vs ${e.amount} EURC does not cross-multiply to ${proposal.fxNumerator}/${proposal.fxDenominator}`,
      };
    }
    // CR-01 inclusion symmetry: a rate-consistent, direction-swapped pair is
    // only safe if BOTH sides are jointly consumed or jointly deferred by the
    // proposed legs. Without this, a coordinator can consume the member's
    // paying IOU on one leg while stripping their receiving IOU from the
    // other (padding that leg with unrelated paper to keep quorum) — the
    // per-leg verifyProposal above never runs for a leg the member was
    // stripped from, so this cross-leg check is the ONLY guard.
    const uIn = usdcConsumed.has(uList[0].id.toLowerCase());
    const eIn = eurcConsumed.has(eList[0].id.toLowerCase());
    if (uIn !== eIn) {
      const [inSide, outSide, outLeg] = uIn
        ? (["USDC", "EURC", "eurc"] as const)
        : (["EURC", "USDC", "usdc"] as const);
      return {
        ok: false,
        reason:
          `FX ref ${ref} inclusion asymmetry: the ${inSide} side is consumed by its leg but the ` +
          `${outSide} counter-IOU is missing from the ${outLeg} leg's consumedIds — one side of ` +
          `the trade would settle without its twin`,
      };
    }
  }

  // (3) The bundle digest must commit to exactly the two locally-verified leg
  // digests and this rate.
  const expectedDigest = pvpDigest(router, proposalFields(proposal), opts.chainId);
  if (expectedDigest !== proposal.digest) {
    return { ok: false, reason: "digest does not match proposal contents" };
  }
  return { ok: true };
}
