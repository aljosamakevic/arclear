---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 02
subsystem: contracts
tags: [solidity, foundry, merkle, keccak256, fuzz-testing, rfc6962]

# Dependency graph
requires:
  - phase: 01 (threshold consent / ClearingHubV2 baseline)
    provides: ClearingHubV2.sol conventions (pragma pin, NatSpec density, custom errors, test naming), foundry.toml fuzz config (512 runs, via_ir)
provides:
  - contracts/src/lib/ManifestMerkle.sol — Solidity sorted-leaf merkle library (rootOf, verifyInclusion, verifyNonInclusion, EMPTY_ROOT, InclusionProof/NonInclusionProof structs, UnsortedLeaves error)
  - contracts/test/ManifestMerkle.t.sol — 22 tests (12 unit-behavior, 5 structural/positive-path, 5 adversarial fuzz at 512 runs) incl. an in-Solidity proof builder mirroring the spec
affects: [02-03 merkle parity fixtures, 02-04 ClearingHubV2 executeRound/redeemIOU integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Solidity library with bool-returning never-reverting verify functions (callers convert to custom errors); only construction (rootOf) reverts"
    - "External harness contract wrapping internal library fns so vm.expectRevert can observe library reverts"
    - "In-test native Solidity proof builder (level walk + sibling collection) enabling fuzz-time proof generation and tampering"

key-files:
  created:
    - contracts/src/lib/ManifestMerkle.sol
    - contracts/test/ManifestMerkle.t.sol
  modified: []

key-decisions:
  - "verifyInclusion bounds-checks sibling consumption (returns false) instead of the research sketch's p.siblings[s++], which would panic-revert on short arrays and violate the never-reverts contract"
  - "leafCount-lie fuzz test excludes consume-trace-equivalent count claims via vm.assume: such claims hash byte-identical inputs (unobservable metadata, provably harmless to all security gates) — only trace-changing lies are adversarial and all are rejected"

patterns-established:
  - "Merkle hashing sites: keccak256(abi.encodePacked(bytes1(0x00), id)) for leaves, keccak256(abi.encodePacked(bytes1(0x01), l, r)) for nodes — the exact bytes the TS twin (02-01) must reproduce"
  - "NonInclusionKind enum order BelowFirst/AboveLast/Bracket = 0/1/2, locked for ABI/fixture parity"

requirements-completed: [MERK-02]

# Metrics
duration: 10min
completed: 2026-07-23
---

# Phase 2 Plan 02: Solidity ManifestMerkle Library Summary

**Sorted-leaf merkle library (promotion construction, RFC 6962 prefixes, bracketing non-inclusion) as pure Solidity with 22 unit + 512-run adversarial fuzz tests — the on-chain half of the dual-implementation spec**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-23T00:35:47Z
- **Completed:** 2026-07-23T00:45:18Z
- **Tasks:** 2 (Task 1 executed as TDD: RED → GREEN)
- **Files modified:** 2 created

## Accomplishments

- `ManifestMerkle` library implements the locked D-01..D-05 spec verbatim: strictly-ascending unique bytes32 leaves, `keccak256(0x00‖id)` / `keccak256(0x01‖l‖r)` domain-separated hashing, level-wise pairing with lone-node promotion (explicitly NOT RFC 6962's split, NOT Bitcoin duplication), `keccak256("")` empty-manifest sentinel
- Verify functions are pure, bool-returning, and provably never revert (short-circuit `&&` ordering guards every subtraction/increment; sibling access is bounds-checked); only `rootOf` reverts, with `UnsortedLeaves(index)` diagnostics
- Every threat-register class has a passing adversarial test: node-as-leaf second preimage (T-02-05), duplicated-odd-node ambiguity (T-02-06), index/leafCount lies (T-02-07), unsorted/duplicate input (T-02-08), plus sibling bit-flips and bracket adjacency/size lies
- Full contracts suite green (49 tests, 5 suites) — no regression in ClearingHub/ClearingHubV2Parity/DigestParity

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): failing tests for ManifestMerkle behaviors** - `7c83770` (test)
2. **Task 1 (GREEN): implement ManifestMerkle library** - `7a5e9b7` (feat)
3. **Task 2: adversarial fuzz + structural unit coverage** - `ce96c92` (test)

## TDD Gate Compliance

- RED gate: `7c83770` — 12 behavior tests committed against the non-existent library; `forge test` failed (compile error, expected RED state)
- GREEN gate: `7a5e9b7` — library implementation; all 12 tests pass unchanged
- REFACTOR gate: not needed — no cleanup commit

## Files Created/Modified

- `contracts/src/lib/ManifestMerkle.sol` - Sorted-leaf merkle library: `EMPTY_ROOT`, `InclusionProof`/`NonInclusionProof` structs, `NonInclusionKind` enum (0/1/2 order locked for TS parity), `UnsortedLeaves` error, `rootOf`/`verifyInclusion`/`verifyNonInclusion`. Full NatSpec incl. the promotion-not-RFC6962 note and the dual-implementation/fixture-lock statement
- `contracts/test/ManifestMerkle.t.sol` - `ManifestMerkleTest` (22 tests) + `ManifestMerkleHarness` (external wrapper for `vm.expectRevert` on `rootOf`); helpers `_sortedIds`, `_proofPath`, `_inclusionProof`, `_leafLevel`, `_consumeTrace` form a native Solidity proof builder mirroring the spec

## Decisions Made

1. **Bounds-checked sibling consumption in `verifyInclusion`.** The research code sketch used `p.siblings[s++]`, which panics (reverts) when the proof carries fewer siblings than the schedule demands — violating the plan's explicit "returns false (never reverts) for … wrong sibling count" behavior. Implemented as `if (s == p.siblings.length) return false;` before each access.
2. **`testFuzz_leafCountLie_rejected` constrains to consume-trace-changing lies.** During test design it was proven that a leafCount claim whose consume-direction trace equals the honest trace (e.g. leafCount 6 for index 0 of a 5-leaf tree) hashes byte-identical input and therefore verifies — correctly, since it is unobservable metadata that cannot alter the leaf, its position, the "is last leaf" gate (deflation to last always changes the level-0 trace), or bracket semantics. The fuzz test `vm.assume`s trace inequality and asserts rejection of every observable lie; the reasoning is documented in the test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in reference sketch] Never-revert contract enforced in verifyInclusion**
- **Found during:** Task 1 (GREEN implementation)
- **Issue:** RESEARCH.md's Solidity sketch indexes `p.siblings[s++]` unguarded; a too-short sibling array would panic-revert instead of returning false, breaking the locked verify-never-reverts API contract
- **Fix:** Explicit `s == p.siblings.length` check returning false before each sibling read
- **Files modified:** contracts/src/lib/ManifestMerkle.sol
- **Verification:** `test_verifyInclusion_wrongSiblingCount_false` (truncated and padded sibling arrays both return false without reverting)
- **Committed in:** 7a5e9b7

**2. [Rule 1 - Test-spec precision] leafCount-lie fuzz bounded to observable lies**
- **Found during:** Task 2 (fuzz test design)
- **Issue:** The plan's literal "perturb leafCount … assert verifyInclusion false" is falsified by consume-trace-equivalent counts, which produce byte-identical verification input (see Decisions #2); asserting false unconditionally would make the fuzz test flaky-by-construction
- **Fix:** `vm.assume` on consume-trace inequality (`_consumeTrace` helper), with an in-test soundness comment explaining why trace-equivalent claims are harmless
- **Files modified:** contracts/test/ManifestMerkle.t.sol
- **Verification:** 512 fuzz runs green; all trace-changing lies rejected
- **Committed in:** ce96c92

---

**Total deviations:** 2 auto-fixed (both Rule 1)
**Impact on plan:** Both fixes were required for the locked API contract and test soundness. No scope creep; library surface matches the interfaces block exactly. **Note for 02-03/02-04 planners:** the trace-equivalence property means `leafCount` in a verified `InclusionProof` is position-schedule-bound, not independently attested — the security gates that consume it (AboveLast's `index == leafCount - 1`, Bracket's equal-count check) remain sound because every gate-affecting count lie changes the trace and is rejected.

## Issues Encountered

- Em-dash (—) in a Solidity string literal fails solc parsing (Error 8936, non-ASCII in non-unicode string); replaced with ASCII wording in one assertion message.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `ManifestMerkle` is ready for ClearingHubV2 integration (plan 02-04: `rootOf` in `executeRound`, `verifyNonInclusion` in `redeemIOU`)
- Hash-site bytes and enum ordering are locked for the TS twin (parallel plan 02-01) and the shared fixture parity lock (plan 02-03)
- MERK-02's Solidity-side obligations complete; byte-parity with TS is deliberately deferred to plan 02-03's fixtures (REQUIREMENTS.md tracking is owned by the orchestrator — not updated from this worktree)

## Self-Check: PASSED

- contracts/src/lib/ManifestMerkle.sol — FOUND
- contracts/test/ManifestMerkle.t.sol — FOUND
- Commit 7c83770 (test, RED) — FOUND
- Commit 7a5e9b7 (feat, GREEN) — FOUND
- Commit ce96c92 (test, Task 2) — FOUND
- `forge build` clean; `forge test` 49/49 green incl. 512-run fuzz

---
*Phase: 02-merkle-manifests-iou-redemption-brief-phase-1*
*Completed: 2026-07-23*
