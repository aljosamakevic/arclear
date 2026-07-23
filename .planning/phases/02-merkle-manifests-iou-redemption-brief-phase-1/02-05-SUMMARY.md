---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 05
subsystem: contracts
tags: [solidity, foundry, testing, fuzz, gas, merkle, redemption, nullifier]

# Dependency graph
requires:
  - phase: 02 plan 04
    provides: "ClearingHubV2 contract surface: consumedIds executeRound, rootRing/lastRound/redeemed, hashIou, redeemIOU gate order + error signatures"
  - phase: 02 plan 02
    provides: "ManifestMerkle.sol (rootOf, verifyNonInclusion, InclusionProof/NonInclusionProof shapes)"
provides:
  - "contracts/test/utils/RoundBuilderV2.sol: V2 harness — ClearingHubV2 deploy at (K=3, RING=16, L=86400), consumedIds round helpers, _signIou/_iouDigest EIP-712 mirror, _executeRoundWithout on-chain staleness advancement, _proofsFor full positional proof-set replay"
  - "contracts/test/ClearingHubV2.t.sol: 26 tests — executeRound evolution, full redeemIOU revert matrix, bidirectional exclusivity, 3x 512-run fuzz, 4 gas measurements"
  - "contracts/.gas-snapshot: persisted test_gas entries"
  - "Measured gas coefficients for plan 02-06's size-parameterized client limits (see Gas Measurements below)"
affects:
  - "02-06 (HubClient.executeRound size-parameterized gas formula + redeemIOU flat limit consume the coefficients below verbatim)"
  - "02-08 (PROTOCOL.md references the bidirectional exclusivity tests, T-02-24)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Harness-side manifest replay log (mapping nonce => consumedIds) reconstructs the exact positional proof set redeemIOU demands — mirrors how a real creditor rebuilds proofs from calldata"
    - "Contained ids yield well-formed-but-failing proofs (never harness reverts), so the structural net->cannot-redeem direction is testable"
    - "expectRevert hygiene: all hub view calls (_proofsFor, hashIou, roundNonce) precomputed before vm.expectRevert so the expectation lands on the state-changing call"

key-files:
  created:
    - contracts/test/utils/RoundBuilderV2.sol
    - contracts/test/ClearingHubV2.t.sol
    - contracts/.gas-snapshot
  modified: []

decisions:
  - "Gas measured via gasleft() deltas around the call on FRESH state (all storage cold) — the worst case the client limit must cover, not warm steady-state"
  - "leafCount fuzz perturbation uses +5 (3->8 leaves) not +1: leafCount 3->4 at index 0 is sibling-schedule-equivalent and verifies true (inherent to schedule-determined verification, harmless because non-inclusion kind checks still bind); +5 guarantees a schedule mismatch"
  - "redeemIOU gas measured with 8-id manifests (depth-3 proofs) across all 16 ring slots — non-sentinel worst case at that manifest size; demo-scale 105-id manifests add ~4 siblings/proof (~40k total), covered by the recommended margin"
  - "Positive post-eviction coverage test added (warp so oldest buffered root predates expiry - L) beyond the plan's two revert branches — locks the coverage rule from both sides"

requirements-completed: [MERK-03, MERK-04]

# Metrics
metrics:
  duration: "11m"
  tasks: 3
  completed: "2026-07-23T01:19:41Z"
---

# Phase 2 Plan 05: ClearingHubV2 Test Matrix, Fuzz & Gas Measurement Summary

Dedicated V2 harness plus 26 forge tests locking MERK-03's full redeemIOU revert matrix against exact error signatures, MERK-04's bidirectional exclusivity on real chain state, 3 adversarial 512-run fuzz properties with state-untouched assertions, and measured (not estimated) gas at the mandated sizes — coefficients derived below for plan 02-06's client formula.

## What Was Built

- **contracts/test/utils/RoundBuilderV2.sol (365 lines, NEW — v1 RoundBuilder untouched):** ClearingHubV2 deployed at DeployV2 defaults `(usdc, 3, 16, 86400)`; MockUSDC imported from RoundBuilder.sol (no duplicate). Helpers: `_simpleRound` (participants, deltas, strictly-ascending consumedIds), `_buildSignatures` over the hub-derived digest (`hub.hashRound` with `ManifestMerkle.rootOf`), `_execute` (sign + execute + record manifest in the replay log), `_executeRoundWithout(absent[, ids])` — all-zero-delta rounds excluding one actor, advancing the ON-CHAIN staleness clock (Pitfall 4), `_makeIou` honoring the L-convention default (`expiry = block.timestamp + 86400`), `_signIou`/`_iouDigest` local EIP-712 mirror reproducing the exact RoundBuilder._digest domain recipe with the IOU typehash, `_proofsFor(id)` rebuilding the exact `min(roundNonce, RING)` positional proof set from the replay log, and `_inclusionProof` reconstructing trees byte-identically to `ManifestMerkle.rootOf` (0x00/0x01 prefixes, lone-node promotion).
- **contracts/test/ClearingHubV2.t.sol (26 tests):**
  - executeRound evolution: `rootRing` StoredRoot fields (root/nonce/executedAt), `lastRound == nonce+1` for every participant including a zero-delta consenter (non-participants stay 0), `UnsortedLeaves(1)` on descending consumedIds.
  - **Exclusivity both directions (MERK-04):** `test_revert_executeRound_nullifiedId` — full happy-path redemption, then a round consuming that id reverts `NullifiedIdInManifest` (redeem→cannot-net, D-14); `test_revert_redeemIOU_nonInclusionInvalid` — an id consumed in buffered round 1 structurally cannot yield a valid proof set, reverts `NonInclusionProofInvalid(1)` (net→cannot-redeem, D-15).
  - Happy path: debtor debited exactly, creditor credited, hub token balance conserved, `redeemed(id)` true, `IouRedeemed` via `vm.expectEmit` with all indexed fields.
  - Revert matrix with exact `abi.encodeWithSelector` diagnostics: `DebtorNotStale(1,3)` (recent participant), never-participated boundary BOTH sides (`DebtorNotStale(0,3)` at roundNonce==K-1, redeems at ==K — Pitfall 6), `CoverageWindowNotBuffered(1,1)` after RING+1=17 rounds with an L-convention expiry, `CoverageWindowNotBuffered(1,0)` for the expiry<=L fail-closed underflow branch, positive post-eviction coverage (warped so the window clears), `BadIouSignature` (non-debtor key), `AlreadyRedeemed(id)`, `ProofCountMismatch(3,2)` (dropped proof), `InsufficientCollateral(debtor,0,amount)` (withdraw-race honesty test), `ZeroAmount`, `SelfIou`.
  - Pause boundary: redeemIOU reverts while paused; `test_withdraw_worksWhilePaused_V2` (withdraw NEVER pausable, D-12).
  - Fuzz (512 runs each, all with state-untouched assertions on roundNonce + both collateral balances): `testFuzz_redeemProofSetSkip_reverts` (fuzz-chosen proof dropped → exact ProofCountMismatch, or two positions swapped over distinct non-empty manifests → positional mismatch), `testFuzz_redeemNullifierIdempotent` (replay/truncate/garbage re-attempts after redemption always exact `AlreadyRedeemed`, balances frozen), `testFuzz_redeemProofPerturbation_reverts` (index/leafCount/sibling tamper → exact `NonInclusionProofInvalid(k)` at the perturbed nonce).
  - Gas: `test_gas_executeRound_m{10,105,250}` (n=5, fresh state, gasleft() deltas, console2 labels) and `test_gas_redeemIOU_ring16` (all 16 ring slots populated with 8-id manifests, 16 real proofs). `.gas-snapshot` persisted via `forge snapshot --match-test test_gas`.

## Gas Measurements (for plan 02-06 — measured, not estimated)

All executeRound numbers: n=5 participants, fresh state (all storage cold — worst case), inner-call `gasleft()` delta:

| Operation | Config | Measured gas |
|-----------|--------|--------------|
| executeRound | n=5, m=10 | 329,108 |
| executeRound | n=5, m=105 | 691,708 |
| executeRound | n=5, m=250 | 1,254,993 |
| redeemIOU | RING=16 full, 8-id manifests (16 proofs, depth 3) | 199,604 |

**Derived deltas:**
- PER_ID marginal: (691,708 − 329,108)/95 = **3,817/id**; (1,254,993 − 691,708)/145 = **3,885/id** (mildly superlinear from memory expansion; use 3,885 as the measured worst marginal)
- Extrapolated n=5 fixed cost (m=0): 329,108 − 10×3,817 ≈ **290,938**

**Recommended client coefficients (>=1.5x margin, plan 02-06 consumes verbatim):**

```
executeRound: gas = BASE + PER_PARTICIPANT*n + PER_ID*m
  BASE            = 300_000n
  PER_PARTICIPANT = 40_000n
  PER_ID          = 6_000n
redeemIOU: flat gas = 500_000n
```

Margin check against measurement: m=10 → 560,000 (1.70x), m=105 → 1,130,000 (1.63x), m=250 → 2,000,000 (1.59x); redeemIOU 500,000 = 2.51x measured (covers demo-scale ~105-id manifests, which add ~4 siblings/proof ≈ ~40k). Note: BASE vs PER_PARTICIPANT split is a conservative allocation of the single measured n=5 fixed cost (only n=5 was mandated); their sum at n=5 (500,000) is what is measurement-anchored.

**Headroom flag (T-02-23 / STATE.md concern):** m=105 measured **691,708** — under the ~1.1M loud-flag threshold; the v1 flat 1,500,000 limit still covers demo scale as measured (2.17x). BUT the flat limit is dead beyond demo scale: measured m=250 is 1,254,993 (only 16% headroom under 1.5M), and the 1.5x-margin formula exceeds 1,500,000 for m > ~133. The size-parameterized formula in 02-06 is required, not optional.

## Task Commits

| Task | Commit | Message |
| ---- | ------ | ------- |
| 1 | `179a20f` | test(02-05): add RoundBuilderV2 harness with consumedIds rounds, IOU mirror, proof replay |
| 2 | `21a0a78` | test(02-05): redeemIOU revert matrix and bidirectional exclusivity on-chain |
| 3 | `b7c86dc` | test(02-05): adversarial fuzz for proof regime and measured gas envelope |

## Verification

- `cd contracts && forge test` — 81/81 green across 7 suites (26 new in ClearingHubV2Test; all pre-existing suites untouched and green)
- All three fuzz tests at 512 runs with state-untouched assertions after expected reverts
- `forge snapshot --match-test test_gas` — 4 entries persisted to `contracts/.gas-snapshot`
- Both exclusivity directions proven on-chain: `test_revert_executeRound_nullifiedId` + `test_revert_redeemIOU_nonInclusionInvalid`
- Conservation asserted in the redemption happy path (hub token balance unchanged)
- Never-participated boundary tested on both sides (redeems at roundNonce == K, reverts at K-1), per 02-04's additive-form note
- grep: no duplicate `contract MockUSDC` (imported from RoundBuilder.sol); harness exposes `_simpleRound`, `_buildSignatures`, `_executeRoundWithout`, `_signIou`, `_iouDigest`, `_makeIou`, `_proofsFor`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] expectRevert consumed by harness view calls**
- **Found during:** Task 2 verification (10 failing tests: "next call did not revert as expected")
- **Issue:** `_proofsFor(id)` / `hub.hashIou(iou)` / `hub.roundNonce()` inlined as call arguments AFTER `vm.expectRevert` make external view calls to the hub first, consuming the revert expectation.
- **Fix:** Precompute all hub-touching values into locals before `vm.expectRevert` in every revert test.
- **Files modified:** contracts/test/ClearingHubV2.t.sol
- **Commit:** `21a0a78`

**2. [Rule 1 - Test-correctness] leafCount fuzz perturbation +5 instead of +1**
- **Found during:** Task 3 design
- **Issue:** Perturbing `leafCount` 3→4 at index 0 is sibling-schedule-equivalent (same consumption order → same recomputed root) and verifies TRUE — a +1 perturbation would make the fuzz property flaky-false. This is inherent to schedule-determined verification and harmless for security (the non-inclusion kind checks — index==0 / index==leafCount-1 / equal-leafCount adjacency — still bind), but the fuzz must pick perturbations guaranteed to fail.
- **Fix:** `leafCount += 5` (3→8): a full 8-leaf tree demands 3 siblings at every index, the proof carries at most 2 — deterministic schedule mismatch.
- **Files modified:** contracts/test/ClearingHubV2.t.sol
- **Commit:** `b7c86dc`

### Additions beyond the named test list (no scope change)

`test_redeemIOU_afterEviction_coverageWindowClear` (positive coverage case after eviction) added alongside the plan's two coverage revert branches — proves the coverage gate opens when the oldest buffered root genuinely predates `expiry - L`, not just that it closes.

## Known Stubs

None — every test exercises the real contract surface; no placeholder assertions, no skipped tests.

## Threat Flags

None beyond the plan's register. All mitigate dispositions discharged: T-02-21 (`testFuzz_redeemProofSetSkip_reverts` + `testFuzz_redeemProofPerturbation_reverts`), T-02-22 (`testFuzz_redeemNullifierIdempotent` with balance-freeze assertions), T-02-23 (measured m∈{10,105,250} + explicit headroom flag above), T-02-24 (both exclusivity directions on real state, referenced for 02-08's PROTOCOL.md). T-02-SC: no package installs occurred.

Observation worth recording (not a new surface): `verifyInclusion`'s (index, leafCount) binding is schedule-determined, so some leafCount lies (e.g. 3→4 at index 0) pass inclusion verification in isolation. Non-inclusion soundness is unaffected — the kind-specific checks (index==0, index==leafCount-1, equal leafCounts + adjacency) reject every such lie in the shapes redeemIOU accepts — but 02-08's PROTOCOL.md spec should state that verification binds the *schedule*, not the literal leafCount.

## Next Phase Readiness

- Gas coefficients above are ready for 02-06's `HubClient.executeRound` size-parameterized limit and `redeemIOU` flat limit (Arc explicit-gas discipline, Pitfall 8)
- The harness's `_proofsFor` replay-log pattern is the reference for the SDK-side proof builder (creditor reconstructs manifests from calldata)
- `.gas-snapshot` is now tracked; future `forge snapshot --match-test test_gas` runs diff against it

## Self-Check: PASSED

- contracts/test/utils/RoundBuilderV2.sol, contracts/test/ClearingHubV2.t.sol, contracts/.gas-snapshot — all on disk
- Commits 179a20f, 21a0a78, b7c86dc all present in git log
- No file deletions in any commit; working tree clean before SUMMARY
- forge test 81/81 green; forge snapshot persisted 4 test_gas entries

---
*Phase: 02-merkle-manifests-iou-redemption-brief-phase-1*
*Completed: 2026-07-23*
