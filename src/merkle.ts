import { concat, keccak256, type Hex } from "viem";

/** RFC 6962 leaf-domain prefix: leaves hash as keccak256(0x00 ‖ id). */
const LEAF_PREFIX: Hex = "0x00";
/** RFC 6962 node-domain prefix: nodes hash as keccak256(0x01 ‖ left ‖ right). */
const NODE_PREFIX: Hex = "0x01";

/**
 * D-04 sentinel: the empty manifest commits to keccak256("0x") — byte-equal to
 * the v1 `manifestHash([])` value, so empty-round behavior is unchanged.
 */
export const EMPTY_MANIFEST_ROOT: Hex = keccak256("0x");

/**
 * Claim that `leaf` (a raw IOU id, pre-leaf-hash) sits at `index` in a
 * manifest of `leafCount` sorted leaves. `siblings` is bottom-up; promotion
 * levels consume no sibling. Mirrored exactly by the Solidity struct.
 */
export interface InclusionProof {
  /** Raw IOU id (pre-leaf-hash). */
  leaf: Hex;
  /** 0-based position in the sorted leaf list. */
  index: number;
  /** Total leaves in that round's manifest. */
  leafCount: number;
  /** Bottom-up sibling hashes; promotion levels consume no sibling. */
  siblings: Hex[];
}

/** Variant tags in Solidity enum order (BelowFirst = 0, AboveLast = 1, Bracket = 2). */
export type NonInclusionKind = "belowFirst" | "aboveLast" | "bracket";

/**
 * Claim that an id is absent from a committed manifest: below the first leaf,
 * above the last leaf, or strictly between two adjacent leaves (bracket).
 */
export interface NonInclusionProof {
  kind: NonInclusionKind;
  /** belowFirst: first leaf | aboveLast: last leaf | bracket: lower neighbor. */
  a: InclusionProof;
  /** Bracket only: upper neighbor (ignored otherwise; a copy of `a` as placeholder). */
  b: InclusionProof;
}

/** Leaf hash: keccak256(0x00 ‖ id) — rule 2. */
function leafHash(id: Hex): Hex {
  return keccak256(concat([LEAF_PREFIX, id]));
}

/** Node hash: keccak256(0x01 ‖ left ‖ right), ordered — rule 3. */
function nodeHash(left: Hex, right: Hex): Hex {
  return keccak256(concat([NODE_PREFIX, left, right]));
}

/**
 * Lowercases ids, then enforces the build-time precondition: well-formed
 * bytes32 hex, strictly ascending, unique. Throws with the offending
 * index/values (caller-bug precondition, not a `{ ok, reason }` check).
 */
function normalize(sortedIds: Hex[]): Hex[] {
  const ids = sortedIds.map((id) => id.toLowerCase() as Hex);
  for (let i = 0; i < ids.length; i++) {
    if (!/^0x[0-9a-f]{64}$/.test(ids[i])) {
      throw new Error(`id at index ${i} is not bytes32 hex: ${ids[i]}`);
    }
    if (i > 0 && ids[i - 1] >= ids[i]) {
      throw new Error(
        ids[i - 1] === ids[i]
          ? `duplicate id at index ${i}: ${ids[i]}`
          : `ids not strictly ascending at index ${i}: ${ids[i - 1]} >= ${ids[i]}`,
      );
    }
  }
  return ids;
}

/**
 * Sorted-leaf merkle root over consumed-IOU ids. Pure function; keccak
 * hashing only — no division anywhere in the protocol (index arithmetic is
 * shift-based). The 0x00/0x01 prefixes are RFC 6962 domain separation, but
 * the tree SHAPE is level-wise pairing with lone-node promotion — NOT the
 * RFC 6962 largest-power-of-two split.
 *
 * Rules (spec: docs/PROTOCOL.md — third parties must implement identically):
 * 1. Ids normalize to lowercase, then must be strictly ascending and unique
 *    (build-time precondition: throws otherwise; lowercase hex lexicographic
 *    order == numeric bytes32 order).
 * 2. Leaf: keccak256(0x00 ‖ id).
 * 3. Node: keccak256(0x01 ‖ left ‖ right) — ordered concatenation, NEVER sorted.
 * 4. Level up: pair (2j, 2j+1) → parent j; odd level width → the last node
 *    promotes upward UNCHANGED (no Bitcoin-style duplication).
 * 5. Empty list → sentinel keccak256("0x") (byte-equal to v1 manifestHash([])).
 */
export function merkleRoot(sortedIds: Hex[]): Hex {
  const ids = normalize(sortedIds); // rule 1
  if (ids.length === 0) return EMPTY_MANIFEST_ROOT; // rule 5
  let level = ids.map(leafHash); // rule 2
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let j = 0; j + 1 < level.length; j += 2) {
      next.push(nodeHash(level[j], level[j + 1])); // rule 3 + rule 4 pairing
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]); // rule 4 promotion
    level = next;
  }
  return level[0];
}

/** Builds the bottom-up sibling path for the leaf at `index` (throws on bad index). */
export function inclusionProof(sortedIds: Hex[], index: number): InclusionProof {
  const ids = normalize(sortedIds);
  if (!Number.isInteger(index) || index < 0 || index >= ids.length) {
    throw new Error(`index ${index} out of range for ${ids.length} leaves`);
  }
  const siblings: Hex[] = [];
  let level = ids.map(leafHash);
  let i = index;
  while (level.length > 1) {
    if ((i & 1) === 1) siblings.push(level[i - 1]);
    else if (i !== level.length - 1) siblings.push(level[i + 1]);
    // else: lone node promotes unchanged — no sibling at this level (rule 4)
    const next: Hex[] = [];
    for (let j = 0; j + 1 < level.length; j += 2) {
      next.push(nodeHash(level[j], level[j + 1]));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
    i >>= 1;
  }
  return { leaf: ids[index], index, leafCount: ids.length, siblings };
}

/**
 * Builds the adjacent-leaf bracketing proof that `id` is absent (D-05).
 * Throws if `id` IS a member — non-inclusion of a member is unprovable.
 * For an empty manifest the returned proof is a placeholder: verification
 * short-circuits on the sentinel root regardless of content.
 */
export function nonInclusionProof(sortedIds: Hex[], id: Hex): NonInclusionProof {
  const ids = normalize(sortedIds);
  const target = id.toLowerCase() as Hex;
  if (ids.length === 0) {
    const placeholder: InclusionProof = {
      leaf: target,
      index: 0,
      leafCount: 0,
      siblings: [],
    };
    return { kind: "belowFirst", a: placeholder, b: { ...placeholder } };
  }
  if (target < ids[0]) {
    const a = inclusionProof(ids, 0);
    return { kind: "belowFirst", a, b: { ...a } };
  }
  const last = ids.length - 1;
  if (target > ids[last]) {
    const a = inclusionProof(ids, last);
    return { kind: "aboveLast", a, b: { ...a } };
  }
  const at = ids.indexOf(target);
  if (at !== -1) {
    throw new Error(
      `id ${target} is a manifest member at index ${at} — non-inclusion is unprovable`,
    );
  }
  // Interior gap: ids[lo] < target < ids[lo + 1].
  let lo = 0;
  for (let i = 1; i < ids.length && ids[i] < target; i++) lo = i;
  return {
    kind: "bracket",
    a: inclusionProof(ids, lo),
    b: inclusionProof(ids, lo + 1),
  };
}

/**
 * Verifies an inclusion claim against a committed root. Never throws
 * (project check-function convention); `ok` semantics match the Solidity
 * bool exactly. Valid iff `index < leafCount`, ALL siblings are consumed
 * exactly by the walk, and the computed root equals `root`.
 */
export function verifyInclusion(
  proof: InclusionProof,
  root: Hex,
): { ok: boolean; reason?: string } {
  const { index, leafCount, siblings } = proof;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(leafCount) ||
    index < 0 ||
    leafCount < 1
  ) {
    return { ok: false, reason: `malformed proof: index ${index}, leafCount ${leafCount}` };
  }
  if (index >= leafCount) {
    return { ok: false, reason: `index ${index} out of range for leafCount ${leafCount}` };
  }
  let h: Hex;
  let i = index;
  let w = leafCount;
  let s = 0; // siblings consumed
  try {
    h = leafHash(proof.leaf);
    while (w > 1) {
      if ((i & 1) === 1) {
        if (s >= siblings.length) {
          return { ok: false, reason: `sibling list exhausted at width ${w}` };
        }
        h = nodeHash(siblings[s++], h); // sibling on the LEFT
      } else if (i !== w - 1) {
        if (s >= siblings.length) {
          return { ok: false, reason: `sibling list exhausted at width ${w}` };
        }
        h = nodeHash(h, siblings[s++]); // sibling on the RIGHT
      }
      // else: lone node promotes unchanged — consumes no sibling (rule 4)
      i >>= 1;
      w = (w + 1) >> 1;
    }
  } catch {
    return { ok: false, reason: "proof contains invalid hex" };
  }
  if (s !== siblings.length) {
    return { ok: false, reason: `${siblings.length - s} unconsumed siblings` };
  }
  if (h !== root.toLowerCase()) {
    return { ok: false, reason: "computed root does not match" };
  }
  return { ok: true };
}

/**
 * Verifies a non-inclusion claim for `id` against a committed root. Never
 * throws. Sentinel root ⇒ trivially absent. Strict inequalities everywhere,
 * so `id == leaf` can never pass any branch. Inclusion of the anchor leaves
 * is verified BEFORE any ordering comparison, so comparisons only ever run
 * against hash-bound leaves.
 */
export function verifyNonInclusion(
  id: Hex,
  proof: NonInclusionProof,
  root: Hex,
): { ok: boolean; reason?: string } {
  if (root.toLowerCase() === EMPTY_MANIFEST_ROOT) return { ok: true }; // sentinel short-circuit
  const target = id.toLowerCase() as Hex;
  const { kind, a, b } = proof;
  if (kind === "belowFirst") {
    if (a.index !== 0) {
      return { ok: false, reason: `belowFirst anchor must sit at index 0, got ${a.index}` };
    }
    const va = verifyInclusion(a, root);
    if (!va.ok) return { ok: false, reason: `first-leaf inclusion failed: ${va.reason}` };
    if (!(target < (a.leaf.toLowerCase() as Hex))) {
      return { ok: false, reason: `id ${target} is not below first leaf ${a.leaf}` };
    }
    return { ok: true };
  }
  if (kind === "aboveLast") {
    if (a.index !== a.leafCount - 1) {
      return {
        ok: false,
        reason: `aboveLast anchor must sit at index ${a.leafCount - 1}, got ${a.index}`,
      };
    }
    const va = verifyInclusion(a, root);
    if (!va.ok) return { ok: false, reason: `last-leaf inclusion failed: ${va.reason}` };
    if (!(target > (a.leaf.toLowerCase() as Hex))) {
      return { ok: false, reason: `id ${target} is not above last leaf ${a.leaf}` };
    }
    return { ok: true };
  }
  if (kind === "bracket") {
    if (a.leafCount !== b.leafCount) {
      return {
        ok: false,
        reason: `bracket leafCount mismatch: ${a.leafCount} != ${b.leafCount}`,
      };
    }
    if (b.index !== a.index + 1) {
      return {
        ok: false,
        reason: `bracket neighbors not adjacent: ${a.index} then ${b.index}`,
      };
    }
    const va = verifyInclusion(a, root);
    if (!va.ok) return { ok: false, reason: `lower-neighbor inclusion failed: ${va.reason}` };
    const vb = verifyInclusion(b, root);
    if (!vb.ok) return { ok: false, reason: `upper-neighbor inclusion failed: ${vb.reason}` };
    const lower = a.leaf.toLowerCase() as Hex;
    const upper = b.leaf.toLowerCase() as Hex;
    if (!(lower < target && target < upper)) {
      return {
        ok: false,
        reason: `id ${target} does not fall strictly between ${lower} and ${upper}`,
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unknown proof kind: ${String(kind)}` };
}
