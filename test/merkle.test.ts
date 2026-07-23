import { describe, expect, it } from "vitest";
import { concat, keccak256, toHex, type Hex } from "viem";
import {
  EMPTY_MANIFEST_ROOT,
  inclusionProof,
  merkleRoot,
  nonInclusionProof,
  verifyInclusion,
  verifyNonInclusion,
  type InclusionProof,
} from "../src/merkle.js";

/** Deterministic unique bytes32 ids, sorted ascending (keccak over a counter). */
function makeIds(n: number, salt = 0): Hex[] {
  const out = new Set<Hex>();
  let i = 0;
  while (out.size < n) out.add(keccak256(toHex(`merkle-id|${salt}|${i++}`)));
  return [...out].sort() as Hex[];
}

const ZERO = ("0x" + "00".repeat(32)) as Hex;
const MAX = ("0x" + "ff".repeat(32)) as Hex;

describe("merkle construction (concrete cases)", () => {
  it("empty manifest hits the v1 sentinel keccak256('0x') (D-04)", () => {
    expect(EMPTY_MANIFEST_ROOT).toBe(keccak256("0x"));
    expect(merkleRoot([])).toBe(EMPTY_MANIFEST_ROOT);
  });

  it("single-leaf root is keccak256(0x00 ‖ id)", () => {
    const [id] = makeIds(1);
    expect(merkleRoot([id])).toBe(keccak256(concat(["0x00", id])));
  });

  it("throws on a duplicated leaf with the offending value (D-03 ambiguity guard)", () => {
    const ids3 = makeIds(3);
    const dup = [...ids3, ids3[2]];
    expect(() => merkleRoot(dup)).toThrowError(/duplicate/);
    expect(() => merkleRoot(dup)).toThrowError(new RegExp(ids3[2].slice(2, 10)));
  });

  it("throws on descending input with the offending values in the message", () => {
    const [a, b] = makeIds(2);
    expect(() => merkleRoot([b, a])).toThrowError(/ascending/);
    expect(() => merkleRoot([b, a])).toThrowError(new RegExp(a.slice(2, 10)));
  });

  it("uppercase-hex input produces the identical root (Pitfall 7 normalization)", () => {
    const ids8 = makeIds(8);
    const upper = ids8.map((id) => ("0x" + id.slice(2).toUpperCase()) as Hex);
    expect(merkleRoot(upper)).toBe(merkleRoot(ids8));
  });
});

describe("proof round-trips (behavior)", () => {
  it("inclusionProof verifies against the root for every index", () => {
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const idsN = makeIds(n, n);
      const root = merkleRoot(idsN);
      for (let i = 0; i < n; i++) {
        expect(verifyInclusion(inclusionProof(idsN, i), root)).toEqual({
          ok: true,
        });
      }
    }
  });

  it("non-inclusion round-trips below-first, above-last, and bracket", () => {
    const ids9 = makeIds(9);
    const absent = ids9[4];
    const tree = ids9.filter((_, i) => i !== 4);
    const root = merkleRoot(tree);

    const below = nonInclusionProof(tree, ZERO);
    expect(below.kind).toBe("belowFirst");
    expect(verifyNonInclusion(ZERO, below, root)).toEqual({ ok: true });

    const above = nonInclusionProof(tree, MAX);
    expect(above.kind).toBe("aboveLast");
    expect(verifyNonInclusion(MAX, above, root)).toEqual({ ok: true });

    const bracket = nonInclusionProof(tree, absent);
    expect(bracket.kind).toBe("bracket");
    expect(verifyNonInclusion(absent, bracket, root)).toEqual({ ok: true });
  });

  it("nonInclusionProof throws when the id IS a manifest member", () => {
    const ids5 = makeIds(5);
    expect(() => nonInclusionProof(ids5, ids5[2])).toThrowError(/member/);
  });

  it("verifyNonInclusion short-circuits ok on the empty-manifest sentinel", () => {
    const ids2 = makeIds(2);
    // Proof content is garbage relative to the sentinel — must still pass.
    const junk = nonInclusionProof(ids2, ZERO);
    expect(verifyNonInclusion(ids2[0], junk, EMPTY_MANIFEST_ROOT)).toEqual({
      ok: true,
    });
  });

  it("verify functions never throw on malformed proofs", () => {
    const bad: InclusionProof = {
      leaf: "0xzz" as Hex,
      index: 0,
      leafCount: 1,
      siblings: [],
    };
    expect(verifyInclusion(bad, EMPTY_MANIFEST_ROOT).ok).toBe(false);
    const [id] = makeIds(1);
    const root = merkleRoot([id]);
    expect(
      verifyNonInclusion(ZERO, { kind: "belowFirst", a: bad, b: bad }, root).ok,
    ).toBe(false);
  });
});
