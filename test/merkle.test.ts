import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { concat, keccak256, toHex, type Hex } from "viem";
import {
  EMPTY_MANIFEST_ROOT,
  inclusionProof,
  merkleRoot,
  nonInclusionProof,
  verifyInclusion,
  verifyNonInclusion,
  type InclusionProof,
  type NonInclusionProof,
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

const arbLeafSet = fc
  .record({ n: fc.integer({ min: 1, max: 64 }), salt: fc.nat() })
  .map(({ n, salt }) => makeIds(n, salt));

/**
 * Test-side mirror of the verification walk's sibling-consumption schedule:
 * one char per level — L (sibling left), R (sibling right), P (promotion).
 * Two (index, leafCount) pairs with equal schedules consume identical bytes.
 */
function schedule(index: number, leafCount: number): string {
  let i = index;
  let w = leafCount;
  let out = "";
  while (w > 1) {
    if ((i & 1) === 1) out += "L";
    else if (i !== w - 1) out += "R";
    else out += "P";
    i >>= 1;
    w = (w + 1) >> 1;
  }
  return out;
}

describe("property 1: root determinism under shuffle (D-16)", () => {
  it("root of the re-sorted shuffle equals root of the sorted input", () => {
    fc.assert(
      fc.property(arbLeafSet, fc.infiniteStream(fc.nat()), (ids, rand) => {
        const shuffled = [...ids];
        const it_ = rand[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (it_.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        expect(merkleRoot([...shuffled].sort())).toBe(merkleRoot(ids));
      }),
    );
  });
});

describe("property 2: inclusion completeness", () => {
  it("every leaf's inclusionProof verifies against the root", () => {
    fc.assert(
      fc.property(arbLeafSet, (ids) => {
        const root = merkleRoot(ids);
        for (let i = 0; i < ids.length; i++) {
          expect(verifyInclusion(inclusionProof(ids, i), root)).toEqual({
            ok: true,
          });
        }
      }),
    );
  });
});

describe("property 3: non-inclusion completeness", () => {
  it("nonInclusionProof verifies for absent ids in every position class", () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 1, max: 64 }),
          salt: fc.nat(),
          pick: fc.nat(),
        }),
        ({ n, salt, pick }) => {
          const all = makeIds(n + 1, salt);
          const k = pick % (n + 1);
          const absent = all[k];
          const tree = all.filter((_, i) => i !== k);
          const root = merkleRoot(tree);
          const proof = nonInclusionProof(tree, absent);
          const expected =
            k === 0 ? "belowFirst" : k === n ? "aboveLast" : "bracket";
          expect(proof.kind).toBe(expected);
          expect(verifyNonInclusion(absent, proof, root)).toEqual({ ok: true });
        },
      ),
    );
  });
});

describe("property 4: exclusion soundness", () => {
  it("verifyNonInclusion rejects every hand-constructed proof for a member id", () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 1, max: 64 }),
          salt: fc.nat(),
          pick: fc.nat(),
        }),
        ({ n, salt, pick }) => {
          const ids = makeIds(n, salt);
          const root = merkleRoot(ids);
          const m = pick % n;
          const target = ids[m];
          const first = inclusionProof(ids, 0);
          const last = inclusionProof(ids, n - 1);
          const attempts: NonInclusionProof[] = [
            { kind: "belowFirst", a: first, b: { ...first } },
            { kind: "aboveLast", a: last, b: { ...last } },
          ];
          if (m > 0) {
            attempts.push({
              kind: "bracket",
              a: inclusionProof(ids, m - 1),
              b: inclusionProof(ids, m),
            });
          }
          if (m < n - 1) {
            attempts.push({
              kind: "bracket",
              a: inclusionProof(ids, m),
              b: inclusionProof(ids, m + 1),
            });
          }
          for (const attempt of attempts) {
            expect(verifyNonInclusion(target, attempt, root).ok).toBe(false);
          }
        },
      ),
    );
  });
});

describe("property 5: adversarial index/leafCount lies", () => {
  it("rejects index lies (±δ, kept in range)", () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 2, max: 64 }),
          salt: fc.nat(),
          pick: fc.nat(),
          delta: fc.integer({ min: 1, max: 3 }),
          up: fc.boolean(),
        }),
        ({ n, salt, pick, delta, up }) => {
          const ids = makeIds(n, salt);
          const root = merkleRoot(ids);
          const m = pick % n;
          const lied = up ? m + delta : m - delta;
          fc.pre(lied >= 0 && lied < n && lied !== m);
          const proof = inclusionProof(ids, m);
          expect(verifyInclusion({ ...proof, index: lied }, root).ok).toBe(
            false,
          );
        },
      ),
    );
  });

  it("rejects leafCount lies that alter the consumption schedule", () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 1, max: 64 }),
          salt: fc.nat(),
          pick: fc.nat(),
          delta: fc.integer({ min: 1, max: 3 }),
          up: fc.boolean(),
        }),
        ({ n, salt, pick, delta, up }) => {
          const ids = makeIds(n, salt);
          const root = merkleRoot(ids);
          const m = pick % n;
          const lied = up ? n + delta : n - delta;
          fc.pre(lied >= 1 && m < lied && lied !== n);
          fc.pre(schedule(m, lied) !== schedule(m, n));
          const proof = inclusionProof(ids, m);
          expect(verifyInclusion({ ...proof, leafCount: lied }, root).ok).toBe(
            false,
          );
        },
      ),
    );
  });

  it("schedule-equivalent leafCount understatements bind the identical (leaf, index) claim", () => {
    // Known boundary of the locked construction (research A3, refined during
    // execution): a leafCount lie that leaves the walk's sibling-consumption
    // schedule unchanged (e.g. index 0, leafCount 4 -> 3: both walk "RR")
    // verifies — it re-asserts the SAME leaf at the SAME index, so no
    // first/last/adjacency claim can be forged with it (see the
    // last-leaf-forgery property below for the security-relevant direction).
    const ids4 = makeIds(4);
    const root = merkleRoot(ids4);
    const p = inclusionProof(ids4, 0);
    expect(schedule(0, 3)).toBe(schedule(0, 4));
    expect(verifyInclusion({ ...p, leafCount: 3 }, root)).toEqual({ ok: true });
    // A schedule-CHANGING lie on the same proof still fails:
    expect(schedule(0, 5)).not.toBe(schedule(0, 4));
    expect(verifyInclusion({ ...p, leafCount: 5 }, root).ok).toBe(false);
  });

  it("rejects last-leaf forgery: a non-last member claiming index == leafCount - 1", () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 2, max: 64 }),
          salt: fc.nat(),
          pick: fc.nat(),
        }),
        ({ n, salt, pick }) => {
          const ids = makeIds(n, salt);
          const root = merkleRoot(ids);
          const m = pick % (n - 1); // strictly non-last member
          const honest = inclusionProof(ids, m);
          const liedCount = m + 1; // claims m is the last leaf
          const consumed = [...schedule(m, liedCount)].filter(
            (c) => c !== "P",
          ).length;
          const candidates = [
            honest.siblings.slice(0, consumed),
            honest.siblings.slice(honest.siblings.length - consumed),
          ];
          for (const siblings of candidates) {
            const forged = { ...honest, leafCount: liedCount, siblings };
            expect(verifyInclusion(forged, root).ok).toBe(false);
            expect(
              verifyNonInclusion(
                MAX,
                { kind: "aboveLast", a: forged, b: { ...forged } },
                root,
              ).ok,
            ).toBe(false);
          }
        },
      ),
    );
  });
});

describe("property 6: sibling tampering", () => {
  it("rejects proofs with a single flipped sibling byte", () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: 2, max: 64 }),
          salt: fc.nat(),
          pick: fc.nat(),
          sib: fc.nat(),
          byte: fc.integer({ min: 0, max: 31 }),
        }),
        ({ n, salt, pick, sib, byte }) => {
          const ids = makeIds(n, salt);
          const root = merkleRoot(ids);
          const m = pick % n;
          const proof = inclusionProof(ids, m);
          fc.pre(proof.siblings.length > 0);
          const s = sib % proof.siblings.length;
          const target = proof.siblings[s];
          const pos = 2 + byte * 2;
          const orig = parseInt(target.slice(pos, pos + 2), 16);
          const flipped = (orig ^ 0xff).toString(16).padStart(2, "0");
          const tampered = (target.slice(0, pos) +
            flipped +
            target.slice(pos + 2)) as Hex;
          const siblings = [...proof.siblings];
          siblings[s] = tampered;
          expect(verifyInclusion({ ...proof, siblings }, root).ok).toBe(false);
        },
      ),
    );
  });
});

describe("property 7: node-as-leaf second preimage (prefix domain separation)", () => {
  it("an internal node's child-pair concatenation offered as a leaf with a truncated proof fails", () => {
    for (const n of [4, 8]) {
      const ids = makeIds(n, 100 + n);
      const root = merkleRoot(ids);
      const leafHashes = ids.map((id) => keccak256(concat(["0x00", id])));
      // Level-1 nodes of the true tree.
      const level1: Hex[] = [];
      for (let j = 0; j + 1 < leafHashes.length; j += 2) {
        level1.push(
          keccak256(concat(["0x01", leafHashes[j], leafHashes[j + 1]])),
        );
      }
      // Attack: offer the CHILD-PAIR CONCATENATION as a fake 64-byte "leaf"
      // of a half-size tree. Without the 0x00/0x01 prefixes, leafHash(fake)
      // would equal the internal node and the truncated proof would verify.
      for (let j = 0; j < level1.length; j++) {
        const fakeLeaf = concat([leafHashes[2 * j], leafHashes[2 * j + 1]]);
        // Sibling path of node j within the level-1 "tree".
        const siblings: Hex[] = [];
        let level = level1;
        let i = j;
        while (level.length > 1) {
          if ((i & 1) === 1) siblings.push(level[i - 1]);
          else if (i !== level.length - 1) siblings.push(level[i + 1]);
          const next: Hex[] = [];
          for (let q = 0; q + 1 < level.length; q += 2) {
            next.push(keccak256(concat(["0x01", level[q], level[q + 1]])));
          }
          if (level.length % 2 === 1) next.push(level[level.length - 1]);
          level = next;
          i >>= 1;
        }
        const forged: InclusionProof = {
          leaf: fakeLeaf,
          index: j,
          leafCount: level1.length,
          siblings,
        };
        expect(verifyInclusion(forged, root).ok).toBe(false);
      }
    }
  });
});
