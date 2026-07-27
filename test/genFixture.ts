/**
 * Generates test/fixtures/digest.json and test/fixtures/merkle.json — the
 * shared vectors that lock encoding/construction parity between the SDK
 * (viem) and the contracts (forge tests DigestParity.t.sol,
 * ClearingHubV2Parity.t.sol, and MerkleParity.t.sol read these same files).
 * Deterministic by construction — regenerate via `npm run fixture`; never
 * hand-edit any value.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { iouId, signIou } from "../src/iou.js";
import {
  inclusionProof,
  manifestLeafId,
  merkleRoot,
  nonInclusionProof,
  verifyNonInclusion,
  type NonInclusionKind,
  type NonInclusionProof,
} from "../src/merkle.js";
import { buildPvPProposal, signPvPConsent } from "../src/pvp.js";
import { manifestHash, roundDigest, signConsent, buildProposal } from "../src/round.js";
import type { ConsumedIou, Iou } from "../src/types.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;

const keys = [
  "0x0000000000000000000000000000000000000000000000000000000000000a01",
  "0x0000000000000000000000000000000000000000000000000000000000000a02",
  "0x0000000000000000000000000000000000000000000000000000000000000a03",
] as const;

const accounts = keys
  .map((k) => privateKeyToAccount(k as Hex))
  .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));

const participants = accounts.map((a) => a.address);
const deltas = [-3_000_000n, 1_000_000n, 2_000_000n];

const iou: Iou = {
  debtor: participants[0],
  creditor: participants[1],
  amount: 3_000_000n,
  nonce: 1n,
  expiry: 4_102_444_800n, // 2100-01-01
  ref: "0x" + "ab".repeat(32) as Hex,
};
const id = iouId(HUB, iou);
// v3: the manifest preimage is the PARTY-BOUND leaf, not the raw id. The
// fixture carries the id and both parties alongside the derived leaf so the
// Solidity side can re-derive the whole chain id -> leaf -> root -> digest
// rather than being handed an opaque manifestHash.
const consumed: ConsumedIou[] = [
  { id, debtor: iou.debtor, creditor: iou.creditor, leafId: manifestLeafId(id, iou.debtor, iou.creditor) },
];
const mh = manifestHash(consumed);

const round = { roundNonce: 0n, participants, deltas, manifestHash: mh };
const digest = roundDigest(HUB, round);

const proposal = buildProposal(HUB, 0n, {
  participants,
  deltas,
  consumed,
  settledVolume: 3_000_000n,
  grossVolume: 3_000_000n,
});

const consent = await signConsent(HUB, proposal, accounts[0]);
// accounts[0] IS the debtor (participants[0]) — staged for on-chain hashIou
// digest + recovery parity in plan 02-04. Fixed `now` = expiry − L keeps
// generation deterministic under the L-convention check (boundary-safe: <=).
const signedIou = await signIou(HUB, iou, accounts[0], undefined, {
  now: 4_102_444_800n - 86_400n,
});

// ---------------------------------------------------------------------------
// pvp_* keys — PvPRound cross-stack vector (PVP-02, D-05). PvPParity.t.sol
// reads these same flat keys and asserts hashPvPRound + ECDSA recovery parity.
// ---------------------------------------------------------------------------

const PVP_HUB_USDC = HUB; // USDC leg reuses the fixture hub above
const PVP_HUB_EURC = "0x2222222222222222222222222222222222222222" as Address;
const PVP_ROUTER = "0x3333333333333333333333333333333333333333" as Address;

// USDC leg: the fixture's existing round proposal (already built against HUB).
const pvpUsdcLeg = proposal;

// EURC leg: same participant trio, distinct IOU nonce (and hub domain) so its
// digest necessarily differs from the USDC leg's.
const eurcIou: Iou = { ...iou, nonce: 2n };
const eurcId = iouId(PVP_HUB_EURC, eurcIou);
const eurcConsumed: ConsumedIou[] = [
  {
    id: eurcId,
    debtor: eurcIou.debtor,
    creditor: eurcIou.creditor,
    leafId: manifestLeafId(eurcId, eurcIou.debtor, eurcIou.creditor),
  },
];
const pvpEurcLeg = buildProposal(PVP_HUB_EURC, 0n, {
  participants,
  deltas,
  consumed: eurcConsumed,
  settledVolume: 3_000_000n,
  grossVolume: 3_000_000n,
});

// Rate vector mirrors the arc-stablecoin-fx amount-pair example:
// 1_000_000 USDC base units <-> 989_589 EURC base units.
const pvpProposal = buildPvPProposal(PVP_ROUTER, pvpUsdcLeg, pvpEurcLeg, 989_589n, 1_000_000n);
const pvpConsent0 = await signPvPConsent(PVP_ROUTER, pvpProposal, accounts[0]);

const fixture = {
  hub: HUB,
  chainId: 5042002,
  roundNonce: 0,
  participants,
  deltas: deltas.map(String),
  manifestHash: mh,
  digest,
  iouId: id,
  // v3 manifest chain: the single consumed obligation, its two parties, and
  // the leaf they derive. ClearingHubV3Parity.t.sol asserts
  // hub.manifestLeafId(consumedId0, partyA, partyB) == consumedLeaf0 and
  // rootOf([consumedLeaf0]) == manifestHash, so nothing between the IOU and
  // the signed digest is taken on trust across the stack boundary.
  consumedId0: consumed[0].id,
  consumedPartyA0: consumed[0].debtor,
  consumedPartyB0: consumed[0].creditor,
  consumedLeaf0: consumed[0].leafId,
  signer0: participants[0],
  consent0: consent,
  // pvp_* keys inserted BEFORE the iou_* group so regeneration is purely
  // additive in the JSON diff (appending at the end would rewrite the last
  // pre-existing line to gain a trailing comma).
  pvpHubUsdc: PVP_HUB_USDC,
  pvpHubEurc: PVP_HUB_EURC,
  pvpRouter: PVP_ROUTER,
  pvpUsdcLegDigest: pvpUsdcLeg.digest,
  pvpEurcLegDigest: pvpEurcLeg.digest,
  pvpFxNumerator: String(pvpProposal.fxNumerator),
  pvpFxDenominator: String(pvpProposal.fxDenominator),
  pvpDigest: pvpProposal.digest,
  pvpSigner0: participants[0],
  pvpConsent0,
  iouDebtor: iou.debtor,
  iouCreditor: iou.creditor,
  iouAmount: String(iou.amount),
  iouNonce: String(iou.nonce),
  iouExpiry: String(iou.expiry),
  iouRef: iou.ref,
  iouSig: signedIou.signature,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "digest.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}`);
console.log(`digest ${digest}`);

// ---------------------------------------------------------------------------
// merkle.json — cross-stack merkle vectors (MERK-02, D-16). FLAT keys only so
// Foundry's vm.parseJson* can address each value by JSON path.
// ---------------------------------------------------------------------------

/** Deterministic sorted-lowercase bytes32 leaf set derived from fixed strings. */
function sortedLeafSet(n: number): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < n; i++) {
    out.push(keccak256(toHex(`merkle-fixture-leaf-${i}`)).toLowerCase() as Hex);
  }
  return out.sort();
}

/** Enum parity with Solidity NonInclusionKind (BelowFirst/AboveLast/Bracket). */
function kindToUint(kind: NonInclusionKind): number {
  return kind === "belowFirst" ? 0 : kind === "aboveLast" ? 1 : 2;
}

/** Flatten a NonInclusionProof vector under `prefix` into `into`. */
function flattenNonInclusion(
  into: Record<string, unknown>,
  prefix: string,
  targetId: Hex,
  proof: NonInclusionProof,
): void {
  into[`${prefix}_kind`] = kindToUint(proof.kind);
  into[`${prefix}_targetId`] = targetId;
  for (const [side, p] of [["a", proof.a], ["b", proof.b]] as const) {
    into[`${prefix}_${side}_leaf`] = p.leaf;
    into[`${prefix}_${side}_index`] = p.index;
    into[`${prefix}_${side}_leafCount`] = p.leafCount;
    into[`${prefix}_${side}_siblings`] = p.siblings;
  }
}

const merkle: Record<string, unknown> = {};

for (const n of [0, 1, 2, 3, 5, 8]) {
  const leaves = sortedLeafSet(n);
  merkle[`case${n}_ids`] = leaves;
  merkle[`case${n}_root`] = merkleRoot(leaves);
}

const case8 = sortedLeafSet(8);
const case8Root = merkleRoot(case8);

// one inclusion proof per leaf
for (let i = 0; i < 8; i++) {
  const p = inclusionProof(case8, i);
  merkle[`case8_inc${i}_leaf`] = p.leaf;
  merkle[`case8_inc${i}_index`] = p.index;
  merkle[`case8_inc${i}_leafCount`] = p.leafCount;
  merkle[`case8_inc${i}_siblings`] = p.siblings;
}

// non-inclusion targets: below the first leaf, above the last leaf, and
// strictly inside an interior gap (adjacent-leaf bracket). All deterministic;
// the assertions guard the (fixed) fixture construction.
const below = ("0x" + "00".repeat(32)) as Hex;
const above = ("0x" + "ff".repeat(32)) as Hex;
if (!(below < case8[0])) throw new Error("below target is not below first leaf");
if (!(above > case8[7])) throw new Error("above target is not above last leaf");
const bracket = toHex(BigInt(case8[3]) + 1n, { size: 32 }).toLowerCase() as Hex;
if (!(case8[3] < bracket && bracket < case8[4])) {
  throw new Error("bracket target does not fall strictly between leaves 3 and 4");
}

for (const [prefix, target] of [
  ["case8_niBelow", below],
  ["case8_niAbove", above],
  ["case8_niBracket", bracket],
] as const) {
  const proof = nonInclusionProof(case8, target);
  const check = verifyNonInclusion(target, proof, case8Root);
  if (!check.ok) throw new Error(`${prefix} vector does not verify: ${check.reason}`);
  flattenNonInclusion(merkle, prefix, target, proof);
}

// NEGATIVE vector: an id that IS a leaf — no non-inclusion claim about it may
// ever verify (the parity test asserts verifyNonInclusion returns false).
merkle["case8_negMemberId"] = case8[4];

// UPPERCASE vector (Pitfall 7 lock): one input id rendered in uppercase hex.
// TS lowercases before hashing; Solidity parses bytes32 numerically (case
// insensitive) — equal roots prove lowercase-hex sort order == bytes32 order.
const upperPair = sortedLeafSet(2);
const upperInput = [
  ("0x" + upperPair[0].slice(2).toUpperCase()) as Hex,
  upperPair[1],
];
merkle["caseUpper_inputIds"] = upperInput;
merkle["caseUpper_root"] = merkleRoot(upperInput);

// ---------------------------------------------------------------------------
// v3_* keys — the PARTY-BOUND LEAF vectors (CR-01). Three implementations now
// derive this leaf: src/merkle.ts, ClearingHubV3.manifestLeafId and
// PvPRouterV3's local mirror. MerkleParityV3.t.sol asserts all three against
// these vectors, so a divergence in any one of them fails a test rather than
// silently producing manifests the other two cannot reproduce.
// ---------------------------------------------------------------------------

/** Deterministic address from a fixed label — no key material needed, the leaf
 *  derivation never signs anything. */
function fixtureAddr(label: string): Address {
  return ("0x" + keccak256(toHex(label)).slice(-40)) as Address;
}

// Single-leaf vector, plus the SWAPPED-argument form. Order-insensitivity is
// load-bearing: it is what removes the role-swap footgun where a coordinator
// that transposed debtor and creditor would commit a leaf the creditor's own
// redemption check never reads.
{
  const leafIdInput = keccak256(toHex("merkle-fixture-v3-id")).toLowerCase() as Hex;
  const lo = fixtureAddr("merkle-fixture-v3-party-lo");
  const hi = fixtureAddr("merkle-fixture-v3-party-hi");
  // Assert the fixture's own construction: the two must actually differ, and
  // we record which is numerically lower so the Solidity side can check the
  // canonical ordering rather than just the output hash.
  if (lo.toLowerCase() === hi.toLowerCase()) throw new Error("v3 leaf parties collide");
  const [low, high] =
    lo.toLowerCase() < hi.toLowerCase() ? [lo, hi] : [hi, lo];
  const leaf = manifestLeafId(leafIdInput, low, high);
  const swapped = manifestLeafId(leafIdInput, high, low);
  if (leaf !== swapped) throw new Error("manifestLeafId is not order-insensitive");
  merkle["v3Leaf_id"] = leafIdInput;
  merkle["v3Leaf_partyLo"] = low;
  merkle["v3Leaf_partyHi"] = high;
  merkle["v3Leaf_expected"] = leaf;
}

// Multi-entry manifest vector in CONSUMED-REF ORDER: the arrays below are
// index-aligned and already sorted ASCENDING BY DERIVED LEAF, which is the
// order ClearingHubV3.executeRound requires and ManifestMerkle.rootOf enforces.
// Emitting them in that order is what pins the sort discipline across stacks —
// a Solidity implementation that sorted by raw id would fail `rootOf`.
{
  const entries = [] as { id: Hex; partyA: Address; partyB: Address; leaf: Hex }[];
  for (let i = 0; i < 5; i++) {
    const entryId = keccak256(toHex(`merkle-fixture-v3-entry-${i}`)).toLowerCase() as Hex;
    const partyA = fixtureAddr(`merkle-fixture-v3-entry-${i}-a`);
    const partyB = fixtureAddr(`merkle-fixture-v3-entry-${i}-b`);
    entries.push({ id: entryId, partyA, partyB, leaf: manifestLeafId(entryId, partyA, partyB) });
  }
  entries.sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));
  const leaves = entries.map((e) => e.leaf);
  const rawIds = entries.map((e) => e.id);
  // The whole point of the vector: leaf order is NOT id order. If the fixture
  // ever degenerates into a case where they coincide, it stops testing the
  // thing it exists to test.
  const idsAscending = rawIds.every((v, i) => i === 0 || rawIds[i - 1] < v);
  if (idsAscending) {
    throw new Error("v3 manifest vector is ascending by raw id too — it no longer pins leaf order");
  }
  merkle["v3Manifest_ids"] = rawIds;
  merkle["v3Manifest_partyA"] = entries.map((e) => e.partyA);
  merkle["v3Manifest_partyB"] = entries.map((e) => e.partyB);
  merkle["v3Manifest_leaves"] = leaves;
  merkle["v3Manifest_root"] = merkleRoot(leaves);
}

const merkleOut = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "merkle.json");
writeFileSync(merkleOut, JSON.stringify(merkle, null, 2) + "\n");
console.log(`wrote ${merkleOut}`);
console.log(`case8 root ${case8Root}`);
