---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 04
subsystem: contracts
tags: [solidity, foundry, merkle, redemption, nullifier, eip712, ring-buffer]

# Dependency graph
requires:
  - phase: 02 plan 02
    provides: contracts/src/lib/ManifestMerkle.sol (rootOf, verifyNonInclusion, NonInclusionProof)
  - phase: 02 plan 03
    provides: regenerated test/fixtures/digest.json with flat iou fields + iouSig for hashIou parity
provides:
  - "contracts/src/ClearingHubV2.sol: consumedIds executeRound (on-chain root derivation + nullifier gate), rootRing/lastRound/redeemed state, K/RING/MAX_IOU_LIFETIME UNCALIBRATED immutables, public hashIou, full redeemIOU recovery path"
  - "contracts/script/DeployV2.s.sol: env-tunable HUB_K/HUB_RING/HUB_MAX_IOU_LIFETIME with 3/16/86400 defaults, 25gwei doc preserved"
  - "contracts/test/ClearingHubV2Parity.t.sol: 4-arg deployCodeTo encoding + hashIou digest/recovery parity vs SDK fixture"
affects:
  - "02-05 (RoundBuilderV2 + ClearingHubV2.t.sol revert matrix/fuzz consume this contract surface)"
  - "02-06+ (SDK ABI regeneration, HubClient.executeRound consumedIds + redeemIOU writes)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "On-chain root derivation from calldata id list: signatures transitively bind the exact leaf set; calldata doubles as data availability for creditor proofs"
    - "Contract-derived proof regime: proof count/positions pinned to roundNonce/RING, never prover-chosen"
    - "Append-only storage layout below the v1-parity declarations for audit diffing"

key-files:
  created: []
  modified:
    - contracts/src/ClearingHubV2.sol
    - contracts/script/DeployV2.s.sol
    - contracts/test/ClearingHubV2Parity.t.sol

decisions:
  - "Staleness gate implemented in additive form `roundNonce < lastRound[debtor] + K` (equivalent to roundNonce - lastRound >= K per the checker-fixed formula, underflow-impossible by construction); NatSpec phrase 'absent from the last >= K executed rounds' matches the formula exactly"
  - "Coverage error's windowStart reports 0 in the expiry <= L fail-closed branch (the true window start would underflow; 0 is the honest floor)"
  - "redeemIOU placed between executeRound and hashRound; effects order follows the plan verbatim (nullify before balance check — revert atomicity makes order immaterial)"
  - "Contract-level @dev header updated to describe on-chain root derivation (the old 'a later phase swaps in a merkle root' sentence was now false)"

requirements-completed: [MERK-01, MERK-03, MERK-04]

# Metrics
metrics:
  duration: "8m"
  tasks: 3
  completed: "2026-07-23T01:04:43Z"
---

# Phase 2 Plan 04: ClearingHubV2 Redemption Evolution Summary

ClearingHubV2 grown in place into the redemption-capable hub: executeRound derives the manifest merkle root on-chain from consumedIds calldata (signed Round struct byte-identical, parity-proven), enforces the nullifier in both directions, records root-ring history and per-participant liveness, and redeemIOU implements the full D-07 gate with the L-bounded fail-closed coverage rule.

## What Was Built

- **contracts/src/ClearingHubV2.sol (+261 lines):**
  - `executeRound(nonce, participants, deltas, bytes32[] consumedIds, signatures)` — nullifier loop (`NullifiedIdInManifest`) before any signature work, `root = ManifestMerkle.rootOf(consumedIds)` (its `UnsortedLeaves` revert is the sorted-manifest guard), digest via the UNCHANGED `hashRound`, `lastRound[p] = nonce + 1` for every participant inside the existing effects loop, `rootRing[nonce % RING] = {root, nonce, executedAt}` before the nonce bump, `RoundExecuted` still carries the root in its `manifestHash` field.
  - `hashIou(Iou calldata)` public view over `IOU_TYPEHASH` byte-matching `IOU_TYPES` in src/domain.ts (uint64 expiry) — the canonical IOU id, parity-locked.
  - `redeemIOU(iou, sig, proofs[])` — gate order: trivia (`ZeroAmount`/`SelfIou`) → staleness (`DebtorNotStale`; never-participated stale once `roundNonce >= K`) → L-bounded coverage (`CoverageWindowNotBuffered`, fail-closed on the `expiry <= L` underflow branch, no timestamp-vs-expiry check per D-07d) → debtor sig over `hashIou` (`BadIouSignature`) → nullifier (`AlreadyRedeemed`) → exactly `min(roundNonce, RING)` non-inclusion proofs positionally matched to contract-derived ascending nonces (`ProofCountMismatch`/`NonInclusionProofInvalid`, sentinel roots pass structurally) → effects (nullify, full-amount debit with `InsufficientCollateral`, credit creditor, `IouRedeemed`). `whenNotPaused nonReentrant`; NatSpec carries the on-chain K-window definition, the never-participated edge, the L-convention safety argument, the TOCTOU regeneration note, and the best-effort/withdraw-race honesty note.
  - Constructor `(token, k, ring, maxIouLifetime)` with `BadConfig` zero-checks; EIP-712 domain and `Ownable(msg.sender)` byte-identical. All three immutables NatSpec-labeled UNCALIBRATED with the Phase-3 deferral (D-08).
  - `withdraw`/`deposit`/`pause`/`hashRound` bodies untouched; withdraw remains never-pausable (D-12).
- **contracts/script/DeployV2.s.sol:** `vm.envOr` params `HUB_K`/`HUB_RING`/`HUB_MAX_IOU_LIFETIME` (3/16/86400 defaults) cast to uint64; UNCALIBRATED comment + console.log labels; `--with-gas-price 25gwei` invocation preserved verbatim.
- **contracts/test/ClearingHubV2Parity.t.sol:** `deployCodeTo` encodes all four constructor args; existing hashRound + consent0 recovery assertions stay green against the regenerated digest.json; new `test_hashIouMatchesSdkFixture` asserts `hub.hashIou(iou) == .iouId` ("TS and Solidity IOU digests diverge") and `ECDSA.recover(hashIou, iouSig) == iouDebtor` ("IOU signature recovery diverges") — discharging the digest-parity obligation for the first on-chain implementation of the signed IOU struct (research Q5a).

## Task Commits

| Task | Phase | Commit | Message |
| ---- | ----- | ------ | ------- |
| 3 (test half, executed first as plan-level RED) | RED | `53f1a9f` | test(02-04): add failing hashIou parity + V2 constructor encoding (RED) |
| 1 | GREEN | `fd994a4` | feat(02-04): derive manifest root on-chain, track participation and root ring (GREEN) |
| 2 | — | `9b3a9b1` | feat(02-04): redeemIOU recovery path with fail-closed contract-derived proof regime |
| 3 (deploy half) | — | `9cc2398` | feat(02-04): DeployV2 carries env-tunable UNCALIBRATED K/RING/L params |

## TDD Gate Compliance

Tasks 1-2 carry `tdd="true"`, but this plan's behavior test matrix is deliberately owned by plan 02-05 (RoundBuilderV2.sol + ClearingHubV2.t.sol — creating them here would collide with that plan's file scope). The RED/GREEN cycle was honored at plan level by resequencing Task 3's parity-test half FIRST:

- RED gate: `53f1a9f` — parity test asserts `hashIou`/`Iou` against the unextended contract; `forge build` fails (identifier not found), same compile-error RED pattern plan 02-02 used.
- GREEN gate: `fd994a4` — Task 1 implementation; full suite 55/55 green including both new hashIou assertions.
- Task 2's `redeemIOU` has no in-plan test by design (02-05 Task 2 is its revert matrix); its gate order and NatSpec were verified against the behavior block and acceptance greps.

## Verification

- `cd contracts && forge build` — 0 errors (only pre-existing lint notes)
- `cd contracts && forge test` — 55/55 green across 6 suites (v1 ClearingHub 23, ClearingHubFuzz, DigestParity, ManifestMerkle 22 incl. 512-run fuzz, MerkleParity 5, ClearingHubV2Parity 2)
- git diff vs base: `withdraw`/`deposit`/`hashRound` bodies unchanged; `EIP712("ArcClearingHub", "1")` and `Ownable(msg.sender)` byte-identical; no pause modifier on withdraw
- Acceptance greps: `bytes32[] calldata consumedIds` (L210), `lastRound[p] = nonce_ + 1` inside the effects loop (L258), `rootRing[nonce_ % RING]` before the nonce bump (L263), UNCALIBRATED x3 in contract NatSpec (+3 in deploy script), IOU_TYPEHASH string exact
- All ten new custom errors declared and used; zero string reverts
- No TS files touched (SDK ABI regeneration is a later plan's scope)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] DeployV2.s.sol compile fix pulled into Task 1's commit**
- **Found during:** Task 1 verification (`forge build`)
- **Issue:** Changing the constructor to 4 args broke DeployV2.s.sol's compile (`new ClearingHubV2(IERC20(token))`), and Task 1's acceptance requires a clean build — but the deploy script is Task 3's file.
- **Fix:** Minimal one-line fix (hardcoded 3/16/86400 defaults) committed with Task 1 (`fd994a4`); the full envOr/doc/console treatment landed in Task 3's own commit (`9cc2398`).
- **Files modified:** contracts/script/DeployV2.s.sol

**2. [Rule 1 - Doc correctness] Contract-level @dev header updated**
- **Found during:** Task 1
- **Issue:** The header claimed `manifestHash` carries "the keccak256 of the sorted consumed-IOU-id list (… a later phase swaps in a sorted-leaf merkle root without touching the contract)" — false after this plan.
- **Fix:** Header now describes on-chain root derivation from consumedIds calldata, the redemption state, and that pause additionally gates redemptions.
- **Files modified:** contracts/src/ClearingHubV2.sol
- **Commit:** `fd994a4`

### Sequencing deviation (documented, no scope change)

Task 3's parity-test half was executed before Task 1 to serve as the TDD RED gate (see TDD Gate Compliance). File scope, content, and assertions match the plan's Task 3 action exactly.

## Known Stubs

None — no placeholder values, no unwired data paths. K/RING/MAX_IOU_LIFETIME defaults are deliberately UNCALIBRATED and labeled as such everywhere (that is the plan's honest-calibration requirement, not a stub).

## Threat Flags

None beyond the plan's register — no new surface outside the threat model. All mitigate dispositions implemented: T-02-12 (L-bounded fail-closed coverage incl. underflow branch), T-02-13 (nullifier write + NullifiedIdInManifest in executeRound), T-02-14 (ECDSA.recover over parity-tested hashIou), T-02-15 (redeemed[id] over the EIP-712 hub+chain-bound digest), T-02-16/17 (contract-derived positional proof regime), T-02-18 (proof count pinned to min(roundNonce, RING)), T-02-19 (purely on-chain staleness gate, no attestation), T-02-20 (UNCALIBRATED NatSpec + deploy comment). On-chain enforcement tests for these arrive in 02-05's matrix.

## Next Phase Readiness

- Contract surface frozen for 02-05's RoundBuilderV2/ClearingHubV2.t.sol revert matrix + fuzz + gas measurement
- SDK-side obligations queued for later plans: regenerate `src/abi/ClearingHubV2.ts`, HubClient.executeRound consumedIds + size-parameterized gas, HubClient.redeemIOU with explicit gas, signIou L-convention enforcement (`expiry <= signTime + L`)
- Note for 02-05: the staleness comparison is implemented additively (`roundNonce < lastRound + K`); boundary tests should hit `roundNonce - lastRound == K` (passes) and `== K-1` (reverts), plus the never-participated `roundNonce == K` boundary

## Self-Check: PASSED

- contracts/src/ClearingHubV2.sol (redeemIOU present), contracts/script/DeployV2.s.sol (MAX_IOU_LIFETIME env), contracts/test/ClearingHubV2Parity.t.sol (hashIou assertions) — all on disk
- Commits 53f1a9f, fd994a4, 9b3a9b1, 9cc2398 all present in git log
- No file deletions in any commit; working tree clean before SUMMARY
- forge build 0 errors; forge test 55/55 green

---
*Phase: 02-merkle-manifests-iou-redemption-brief-phase-1*
*Completed: 2026-07-23*
