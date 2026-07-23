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
  merkleRoot,
  nonInclusionProof,
  verifyNonInclusion,
  type NonInclusionKind,
  type NonInclusionProof,
} from "../src/merkle.js";
import { manifestHash, roundDigest, signConsent, buildProposal } from "../src/round.js";
import type { Iou } from "../src/types.js";

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
const ids = [id].sort() as Hex[];
const mh = manifestHash(ids);

const round = { roundNonce: 0n, participants, deltas, manifestHash: mh };
const digest = roundDigest(HUB, round);

const proposal = buildProposal(HUB, 0n, {
  participants,
  deltas,
  consumedIds: ids,
  settledVolume: 3_000_000n,
  grossVolume: 3_000_000n,
});

const consent = await signConsent(HUB, proposal, accounts[0]);
// accounts[0] IS the debtor (participants[0]) — staged for on-chain hashIou
// digest + recovery parity in plan 02-04.
const signedIou = await signIou(HUB, iou, accounts[0]);

const fixture = {
  hub: HUB,
  chainId: 5042002,
  roundNonce: 0,
  participants,
  deltas: deltas.map(String),
  manifestHash: mh,
  digest,
  iouId: id,
  signer0: participants[0],
  consent0: consent,
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

const merkleOut = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "merkle.json");
writeFileSync(merkleOut, JSON.stringify(merkle, null, 2) + "\n");
console.log(`wrote ${merkleOut}`);
console.log(`case8 root ${case8Root}`);
