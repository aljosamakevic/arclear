---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 03
subsystem: sdk-merkle
tags: [merkle, fixtures, parity, eip712, foundry, viem]

# Dependency graph
requires:
  - phase: 02 plan 01
    provides: src/merkle.ts (merkleRoot, inclusionProof, nonInclusionProof, verify fns)
  - phase: 02 plan 02
    provides: contracts/src/lib/ManifestMerkle.sol (rootOf, verifyInclusion, verifyNonInclusion, EMPTY_ROOT)
provides:
  - "src/round.ts: manifestHash now returns the sorted-leaf merkle root (same name/signature/bytes32 field — MERK-01 SDK half)"
  - "test/fixtures/merkle.json: cross-stack merkle vectors (roots {0,1,2,3,5,8}, case8 inclusion + non-inclusion + negative + uppercase)"
  - "test/fixtures/digest.json: regenerated post-swap, extended with flat iou fields + iouSig for plan 02-04's hashIou parity"
  - "contracts/test/MerkleParity.t.sol: Foundry side of the byte-parity lock (MERK-02, D-16)"
affects:
  - "02-04 (on-chain hashIou parity consumes digest.json iou fields + iouSig; ClearingHubV2 executeRound/redeemIOU integration)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Flat vm.parseJson-addressable fixture keys (caseN_*, case8_inc{i}_*, case8_ni{Kind}_{a|b}_*) so Foundry reconstructs structs without nested JSON parsing"
    - "Fixture generator self-verifies every emitted vector (verifyNonInclusion checked at generation) and throws on construction drift"

key-files:
  created:
    - test/fixtures/merkle.json
    - contracts/test/MerkleParity.t.sol
  modified:
    - src/round.ts
    - test/genFixture.ts
    - test/fixtures/digest.json

decisions:
  - "digest.json regenerated inside Task 1 (unmodified generator) so the swap commit stays green — the plan sequenced regeneration in Task 2, but eip712.test.ts checks the fixture value"
  - "Bracket non-inclusion target derived as case8[3] + 1n (deterministic, generation-time asserted strictly between leaves 3 and 4); below/above targets are 0x00..00 / 0xff..ff with generation-time assertions"
  - "Negative vector exercised via three bracket attempts (member at upper anchor, member at lower anchor, non-adjacent skip) — all structurally or strictly-inequality rejected; no trace-equivalent leafCount-lie vectors per wave-1 refinement"

requirements-completed: [MERK-01, MERK-02]

# Metrics
metrics:
  duration: "7m"
  tasks: 3
  completed: "2026-07-23T00:56:00Z"
---

# Phase 2 Plan 03: Merkle Root Swap + Cross-Stack Parity Fixtures Summary

manifestHash preimage swapped to the sorted-leaf merkle root at its single choke point, shared merkle.json vectors emitted for both stacks, and TS-Solidity byte-parity locked by a 5-test Foundry parity suite reading only regenerable fixtures.

## What Was Built

- **src/round.ts:** `manifestHash(sortedIds)` now delegates to `merkleRoot`
  from `./merkle.js` — same exported name and `(sortedIds: Hex[]): Hex`
  signature, so `buildProposal`, `verifyProposal`, and `genFixture.ts` were
  untouched. The empty-manifest sentinel `keccak256("0x")` is preserved inside
  `merkleRoot` (D-04). Diff confined to the import block + manifestHash
  body/doc comment; `verifyProposal`'s recomputation transparently became a
  root check with the Phase-1 nonce/overlap pinning intact.
- **test/genFixture.ts (extended, not forked):** digest.json gains the six
  flat iou fields (`iouDebtor`, `iouCreditor`, `iouAmount`, `iouNonce`,
  `iouExpiry`, `iouRef`) plus `iouSig` signed by accounts[0] (the debtor),
  staging plan 02-04's on-chain `hashIou` digest + recovery parity. A second
  emitter writes merkle.json with flat keys: `caseN_ids`/`caseN_root` for
  n in {0,1,2,3,5,8}; per-leaf `case8_inc{i}_*` inclusion proofs;
  `case8_niBelow_*`/`case8_niAbove_*`/`case8_niBracket_*` non-inclusion
  vectors (kind as uint 0/1/2, flattened a/b proofs); `case8_negMemberId`;
  and the `caseUpper_*` normalization vector. Every non-inclusion vector is
  verified at generation time; targets are deterministic with generation-time
  assertions guarding the construction.
- **contracts/test/MerkleParity.t.sol:** bare Test contract (no hub
  deployment) reading only merkle.json via the existing `fs_permissions`
  grant. `test_rootParity` (all six counts + EMPTY_ROOT sentinel),
  `test_inclusionParity` (8/8 TS proofs accepted), `test_nonInclusionParity`
  (all three kinds accepted), `test_negativeVector` (member id rejected by
  three bracket attempts), `test_uppercaseNormalizationParity` (bytes32
  numeric order == SDK lowercase-hex sort order, Pitfall 7).

## Task Commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Swap manifestHash body to merkleRoot | `d992466` | src/round.ts, test/fixtures/digest.json |
| 2 | Extend genFixture — merkle.json + iou/iouSig | `e68de62` | test/genFixture.ts, test/fixtures/digest.json, test/fixtures/merkle.json |
| 3 | MerkleParity.t.sol byte-parity lock | `cf4bb99` | contracts/test/MerkleParity.t.sol |

## Verification

- `npx tsc --noEmit` clean (strict mode)
- `npm test` — 62/62 green across 4 files (eip712/rebuild suites pass unmodified)
- `cd contracts && forge test` — 54/54 green across 6 suites (MerkleParity 5/5, DigestParity + ClearingHubV2Parity green against regenerated values, ManifestMerkle 22/22, fuzz 512 runs)
- `npm run fixture` double-run byte-identical (shasum-verified determinism — T-02-09 mitigation)
- digest.json `manifestHash` changed from `0x00e648f6…` (flat keccak concat) to `0xfe0153fb…` (merkle root); `digest` and `consent0` regenerated accordingly; encoding unchanged (T-02-11 mitigation proven)
- git diff of src/round.ts confined to import block + manifestHash body/doc comment

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] digest.json regenerated within Task 1 instead of Task 2**
- **Found during:** Task 1 verification
- **Issue:** The plan sequenced fixture regeneration in Task 2, but Task 1's
  acceptance requires `npm test` green — `eip712.test.ts` asserts
  `manifestHash([f.iouId]) === f.manifestHash` against the stale pre-swap
  digest.json value, so it failed after the swap (exactly Pitfall 1: expected
  regeneration, not breakage).
- **Fix:** Ran `npm run fixture` with the (then-unmodified) generator inside
  Task 1 and committed the regenerated digest.json with the swap, keeping the
  commit green. Task 2 regenerated again with the extended generator. No
  fixture value was ever hand-edited (T-02-09 upheld).
- **Files modified:** test/fixtures/digest.json
- **Commit:** `d992466`

## Trace-Equivalence Handling (wave-1 refinement honored)

Per the 02-01/02-02 SUMMARY deviations, schedule/trace-equivalent leafCount
understatements verify identically by construction and are provably harmless.
The parity vectors therefore contain only honest proofs plus negative vectors
that are rejected for observable reasons (member id at a bracket anchor —
strict inequality; non-adjacent bracket — structural adjacency check). No
trace-equivalent-lie vector was emitted as a "must reject" case.

## Known Stubs

None — no placeholder values, no unwired data paths.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes. New file
access is the fixture read in MerkleParity.t.sol via the pre-existing
`fs_permissions` grant (in-plan, T-02-09/T-02-10/T-02-11 all mitigated:
regeneration-only + determinism check; uppercase + bracket + negative
vectors; DigestParity/ClearingHubV2Parity green post-regeneration).

## Next Phase Readiness

- `manifestHash` is now provable: plan 02-04 can verify inclusion and
  non-inclusion against any executed round's committed root
- digest.json carries the full fixture Iou + `iouSig` for 02-04's
  `hub.hashIou(iou) == iouId` and `ECDSA.recover(hashIou, iouSig) == debtor`
  parity assertions
- merkle.json is the regenerable single source of truth for both stacks —
  any future construction drift breaks MerkleParity, not production

## Self-Check: PASSED

- src/round.ts (modified), test/genFixture.ts (modified),
  test/fixtures/digest.json (iouSig present), test/fixtures/merkle.json
  (77 keys), contracts/test/MerkleParity.t.sol — all exist on disk
- Commits d992466, e68de62, cf4bb99 all present in git log
- No file deletions in any commit; working tree clean before SUMMARY

---
*Phase: 02-merkle-manifests-iou-redemption-brief-phase-1*
*Completed: 2026-07-23*
