---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 01
subsystem: sdk-merkle
tags: [merkle, non-inclusion, rfc6962, fast-check, viem]
requires: []
provides:
  - "src/merkle.ts: merkleRoot, inclusionProof, nonInclusionProof, verifyInclusion, verifyNonInclusion, EMPTY_MANIFEST_ROOT, InclusionProof/NonInclusionProof/NonInclusionKind types"
  - "test/merkle.test.ts: fast-check property suite locking the construction (D-16 TS side)"
affects:
  - "02-02 (Solidity twin ManifestMerkle.sol — must match acceptance semantics byte-for-byte)"
  - "02-03 (root swap in round.ts + shared merkle.json parity fixtures)"
tech-stack:
  added: []
  patterns:
    - "RFC 6962 0x00/0x01 prefix domain separation over a level-wise-promotion tree shape"
    - "Numbered-rule doc comment cross-referenced to docs/PROTOCOL.md (netting.ts idiom)"
    - "{ ok, reason? } verify functions that never throw; throwing build-time preconditions"
key-files:
  created:
    - src/merkle.ts
    - test/merkle.test.ts
  modified:
    - src/index.ts
decisions:
  - "verifyInclusion/verifyNonInclusion wrap hashing in try/catch so malformed hex in untrusted proofs returns { ok: false } instead of throwing"
  - "normalize() validates each id is bytes32 hex (^0x[0-9a-f]{64}$) before the ascending/unique check — guards the raw-ids trust boundary"
  - "nonInclusionProof on an empty manifest returns a placeholder proof (verification short-circuits on the sentinel root regardless)"
  - "Adversarial leafCount property refined: only schedule-CHANGING lies are rejected; schedule-equivalent understatements verify but are provably harmless (bind identical leaf+index)"
metrics:
  duration: "5m"
  tasks: 2
  completed: "2026-07-23T00:46:16Z"
---

# Phase 2 Plan 01: TS Merkle Manifest Module Summary

Sorted-leaf merkle library (RFC 6962-prefixed, lone-node promotion, adjacent-leaf bracketing non-inclusion) as a pure viem-only SDK module with a 20-test fast-check property suite — MERK-02's TypeScript half.

## What Was Built

- **`src/merkle.ts` (300 lines, viem-only):** implements D-01..D-05 verbatim —
  leaves `keccak256(0x00 ‖ id)`, ordered nodes `keccak256(0x01 ‖ l ‖ r)`,
  lone-node promotion, empty sentinel `keccak256("0x")` byte-equal to v1's
  `manifestHash([])`. Exports the proof types the Solidity structs in 02-02
  mirror exactly. Build functions throw on duplicate/descending/malformed
  input with offending index+values interpolated; verify functions return
  `{ ok, reason? }` and never throw.
- **`src/index.ts`:** barrel export inserted between `./netting.js` and
  `./round.js` (round.ts imports it in plan 02-03).
- **`test/merkle.test.ts` (426 lines):** all seven property groups from the
  plan plus every concrete case — sentinel, single-leaf, duplicate/descending
  rejection, uppercase normalization (Pitfall 7), sentinel short-circuit,
  never-throw guarantee.

## Task Commits

| Task | Phase | Commit | Message |
| ---- | ----- | ------ | ------- |
| 1 | RED | `40b0bc3` | test(02-01): add failing tests for sorted-leaf merkle module |
| 1 | GREEN | `017c534` | feat(02-01): implement sorted-leaf merkle manifest module |
| 2 | — | `399b7ce` | test(02-01): lock merkle properties with fast-check suite |

## Verification

- `npx tsc --noEmit` clean (strict mode, no `any`)
- `npx vitest run test/merkle.test.ts` — 20/20 green
- `npm test` — 62/62 green across 4 files (netting/eip712/rebuild suites unaffected)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Refined adversarial leafCount property (research A3 boundary found)**
- **Found during:** Task 2 (property design), confirmed empirically before coding the test
- **Issue:** The plan's property (5) asserts that mutating a valid proof's
  `leafCount` by ±δ (keeping `index < leafCount`) always makes
  `verifyInclusion` return `ok:false`. This is mathematically false for the
  locked construction: leafCount lies that leave the sibling-consumption
  schedule unchanged verify identically. Concrete counterexample: 4-leaf
  tree, index 0 — both (0, leafCount 4) and (0, leafCount 3) walk
  "consume-right, consume-right", so the lied proof hashes the same bytes to
  the same root and verifies `ok:true`. fast-check would have found this and
  failed the suite.
- **Security analysis:** harmless. A schedule-equivalent count lie re-asserts
  the SAME leaf at the SAME index, so no non-inclusion branch can be forged
  with it: `belowFirst` pins index 0 (genuinely first), `bracket` adjacency
  uses genuine indexes, and `aboveLast` forgery (a non-last member claiming
  `index == leafCount − 1`) always changes the schedule at the level where
  the true path consumes a right sibling — proven empirically by a dedicated
  property test.
- **Fix:** property (5) split into four tests: (a) index lies always rejected;
  (b) schedule-changing leafCount lies always rejected; (c) concrete test
  documenting the schedule-equivalent acceptance boundary; (d) last-leaf
  forgery via count lies rejected (both `verifyInclusion` and the composed
  `aboveLast` non-inclusion path).
- **Files modified:** test/merkle.test.ts
- **Commit:** `399b7ce`
- **Downstream note for 02-02/02-03:** the Solidity twin's fuzz tests must
  use the same refinement — a blanket "any ±δ leafCount mutation reverts/
  returns false" fuzz assertion WILL fail. The acceptance set is identical by
  spec (same walk), so parity is unaffected. PROTOCOL.md's soundness argument
  (research A3) should state this boundary explicitly.

**2. [Rule 2 - Missing critical functionality] Hardened inputs at the trust boundaries**
- **Found during:** Task 1
- **Issue:** (a) verify functions receive untrusted proof structures — invalid
  hex in `leaf`/`siblings` would make viem's `keccak256` throw, violating the
  never-throw contract; (b) build functions accept raw ids — a non-bytes32
  hex string would silently sort lexicographically-but-not-numerically,
  diverging from Solidity's bytes32 order (threat T-02-04 adjacent).
- **Fix:** (a) hashing wrapped in try/catch returning
  `{ ok: false, reason: "proof contains invalid hex" }`; (b) `normalize()`
  rejects any id not matching `^0x[0-9a-f]{64}$` (after lowercasing) with the
  offending index/value.
- **Files modified:** src/merkle.ts
- **Commit:** `017c534`

## TDD Gate Compliance

RED gate `40b0bc3` (test commit, suite failed on missing module) → GREEN gate
`017c534` (feat commit, 10/10 behavior tests pass) → Task 2 property extension
`399b7ce`. No refactor commit needed.

## Known Stubs

None — no placeholder values, no unwired data paths.

## Threat Flags

None — no new network endpoints, auth paths, file access, or schema changes.
All threat-register mitigations for this plan (T-02-01 prefixes + node-as-leaf
test, T-02-02 promotion + duplicate rejection, T-02-03 adversarial lies,
T-02-04 lowercase normalization) are implemented and property-tested; T-02-03's
mitigation is refined per Deviation 1.

## Self-Check: PASSED

- src/merkle.ts, test/merkle.test.ts, src/index.ts, 02-01-SUMMARY.md all exist on disk
- Commits 40b0bc3, 017c534, 399b7ce all present in git log
