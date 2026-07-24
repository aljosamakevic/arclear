---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
verified: 2026-07-24T10:52:00Z
status: passed
score: 14/14 must-haves verified
overrides_applied: 0
---

# Phase 2: Merkle Manifests & IOU Redemption Verification Report

**Phase Goal:** Claims become provable and recoverable on-chain — manifest roots support inclusion and non-inclusion proofs, and a creditor can redeem an unconsumed IOU directly against an unresponsive debtor's collateral
**Verified:** 2026-07-24
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `manifestHash` preimage is a sorted-leaf merkle root in the same `bytes32` field — no ClearingHub interface change | ✓ VERIFIED | `src/round.ts:20` delegates to `merkleRoot`; `ClearingHubV2.executeRound` derives `root = ManifestMerkle.rootOf(consumedIds)` (line 226) into the same signed Round struct; v1 `contracts/src/ClearingHub.sol` untouched since original commit `844ea1f`; `DigestParity.t.sol` (1 pass) + `ClearingHubV2Parity.t.sol` (2 pass) prove byte-identical digests |
| 2 | SC2: `src/merkle.ts` and `ManifestMerkle.sol` produce byte-identical roots, verify inclusion + non-inclusion, proven by shared TS↔Solidity fixtures | ✓ VERIFIED | `test/fixtures/merkle.json` (162 lines, leaf counts {0,1,2,3,5,8} + negative vectors); `MerkleParity.t.sol` reads it via `vm.readFile` (5 pass); `test/merkle.test.ts` fast-check suite (20 pass); `ManifestMerkle.t.sol` adversarial fuzz (22 pass) |
| 3 | SC3: creditor can call `redeemIOU(iou, sig, proofs[])` with non-inclusion proofs against last k round roots, debiting a stale debtor's collateral — gated on missing K consecutive executed rounds | ✓ VERIFIED | `contracts/src/ClearingHubV2.sol:318-370` full gate (trivia → staleness ≥ K → L-bounded coverage → EIP-712 sig via `hashIou` → nullifier → positional non-inclusion per buffered round); revert matrix all pass; live `npm run e2e:anvil`: "redeemIOU mined successfully", "Oracle collateral debited by exactly 300000 base units" |
| 4 | SC4: nullifier prevents re-redemption; redeem→cannot-net and net→cannot-redeem exclusivity tested | ✓ VERIFIED | `mapping(bytes32 => bool) redeemed` (line 95); `test_revert_redeemIOU_alreadyRedeemed`, `test_revert_executeRound_nullifiedId`, `testFuzz_redeemNullifierIdempotent` (512 runs), `test_revert_redeemIOU_nonInclusionInvalid` all pass; e2e: "redeemed id absent from the union of every consumed manifest (MERK-04/D-17)" |
| 5 | digest.json regenerated with full Iou fields + `iouSig`; all digest-parity tests green | ✓ VERIFIED | `test/fixtures/digest.json` contains `iouSig`; `DigestParity` + `ClearingHubV2Parity` suites pass |
| 6 | `hashIou(iou)` on-chain equals SDK `iouId` and recovers the fixture debtor from `iouSig` | ✓ VERIFIED | `ClearingHubV2.sol:405 hashIou`; `ClearingHubV2Parity.t.sol` (contains `hashIou` + `iouSig` assertions) passes |
| 7 | `executeRound` records `rootRing[nonce % RING]` and `lastRound[p] = nonce + 1` for every participant incl. zero-delta consenters | ✓ VERIFIED | `ClearingHubV2.sol:258,263`; `test_executeRound_writesRootRing` passes; e2e staleness precondition holds on-chain |
| 8 | `withdraw` remains never pausable; K/RING/MAX_IOU_LIFETIME are constructor immutables labeled uncalibrated | ✓ VERIFIED | `test_withdraw_worksWhilePaused_V2` passes; immutables at `ClearingHubV2.sol:101,106,114`; `DeployV2.s.sol:22` + `docs/PROTOCOL.md:360` label them UNCALIBRATED |
| 9 | Gas measured (not estimated) for executeRound m∈{10,105,250} and redeemIOU at RING=16; client uses explicit gas formula, never estimation | ✓ VERIFIED | `test_gas_executeRound_m10/m105/m250`, `test_gas_redeemIOU_ring16` pass; `src/client.ts:21-32` coefficients from forge-measured deltas (redeemIOU measured 199,604), explicit `gas:` on all writes |
| 10 | HubClient exposes consumedIds executeRound, redeemIOU, V2 reads (lastRound/redeemed/rootRing/hashIou), fetchManifest (calldata reconstruction), prepareRedemptionProofs (contract-derived range) against V2 ABI | ✓ VERIFIED | `src/client.ts` binds `clearingHubV2Abi` throughout; `fetchManifest` uses `decodeFunctionData` (line 168); `prepareRedemptionProofs` calls `nonInclusionProof` per buffered round (lines 184-191) |
| 11 | `signIou` enforces the L-convention with `checkIouLifetime` `{ok, reason}` helper; `net()` accepts `redeemedIds` excluded like `settledIds` | ✓ VERIFIED | `src/iou.ts:36-69`; `src/netting.ts:29-34`; vitest 64/64 pass |
| 12 | Coordinator reconciles `IouRedeemed` chain logs into `redeemedIds` and threads them into `net()`; review fixes WR-01 (pendingConsumedIds) and WR-02 (V2 ABI in reconcilePendingSubmission) applied | ✓ VERIFIED | `demo/coordinator.ts:397-405` (getContractEvents IouRedeemed via clearingHubV2Abi), `:508-528` (pendingConsumedIds into verifyProposal), `:434` (RoundExecuted via V2 ABI); fix commits `b69db11`, `970d782` exist |
| 13 | E2e D-17 redemption scenario passes end-to-end; Phase-1 hardening not regressed | ✓ VERIFIED | `npm run e2e:anvil` run live during verification: PASS — baseline + liveness + redemption (dark debtor → self-serve recovery → never nets again); `test/rebuild.test.ts` 26/26 pass |
| 14 | Docs + redeploy: PROTOCOL merkle/redemption spec (NOT-RFC-6962 stated, keep-alive griefing documented, non-goal superseded), THREAT-MODEL rows 14-20, README hub lineage (v1 + Phase-1 V2 + current V2), fresh redemption-capable hubs live on Arc Testnet | ✓ VERIFIED | `docs/PROTOCOL.md:14` "collateralized recovery path", `:282` "NOT an RFC 6962 tree", `:350-412` redemption gate spec; `docs/THREAT-MODEL.md:42-48` rows 14-20, `:56` non-goal marked "shipped in v2"; `README.md:110-138` full lineage table; on-chain bytecode confirmed via `cast code` (24,162 hex chars each) and arcscan API returns verified `ClearingHubV2.sol` source for both hubs |

**Score:** 14/14 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/merkle.ts` | Pure merkle lib (root, inclusion/non-inclusion proofs, EMPTY_MANIFEST_ROOT) | ✓ VERIFIED | 300 lines, all exports present, imported by round.ts/client.ts, barrel-exported in index.ts |
| `test/merkle.test.ts` | fast-check property suite | ✓ VERIFIED | 426 lines, 20 tests pass |
| `contracts/src/lib/ManifestMerkle.sol` | Solidity library: rootOf, verifyInclusion, verifyNonInclusion, EMPTY_ROOT | ✓ VERIFIED | 147 lines, imported and called by ClearingHubV2 |
| `contracts/test/ManifestMerkle.t.sol` | Unit + adversarial fuzz | ✓ VERIFIED | 547 lines, 22 tests pass |
| `src/round.ts` | manifestHash delegating to merkleRoot | ✓ VERIFIED | Line 9 import, line 20 delegation |
| `test/fixtures/merkle.json` | Cross-stack vectors {0,1,2,3,5,8} + negatives | ✓ VERIFIED | 162 lines, consumed by both vitest and Foundry |
| `contracts/test/MerkleParity.t.sol` | Foundry parity via vm.readFile | ✓ VERIFIED | 5 tests pass |
| `test/fixtures/digest.json` | Regenerated with iou fields + iouSig | ✓ VERIFIED | Contains `iouSig`, parity suites green |
| `contracts/src/ClearingHubV2.sol` | rootRing/lastRound/redeemed, K/RING/L immutables, hashIou, consumedIds executeRound, redeemIOU | ✓ VERIFIED | 430 lines, all present, deployed on-chain |
| `contracts/script/DeployV2.s.sol` | Deploy with uncalibrated defaults | ✓ VERIFIED | Contains MAX_IOU_LIFETIME; broadcast records match live addresses |
| `contracts/test/ClearingHubV2Parity.t.sol` | hashIou/iouSig recovery parity | ✓ VERIFIED | 2 tests pass |
| `contracts/test/utils/RoundBuilderV2.sol` | V2 harness (new file, v1 RoundBuilder untouched) | ✓ VERIFIED | 365 lines, inherited by ClearingHubV2.t.sol |
| `contracts/test/ClearingHubV2.t.sol` | Revert matrix, exclusivity, fuzz, gas | ✓ VERIFIED | 459 lines, 26 tests pass incl. testFuzz_ |
| `src/abi/ClearingHubV2.ts` | Regenerated V2 ABI + bytecode | ✓ VERIFIED | 1072 lines, contains redeemIOU, sole ABI binding in client.ts |
| `src/client.ts` | V2 HubClient with gas formula + redemption helpers | ✓ VERIFIED | 283 lines, all methods present and wired |
| `src/iou.ts` | checkIouLifetime + L-enforcement | ✓ VERIFIED | Present, used by signIou |
| `src/netting.ts` | redeemedIds opt | ✓ VERIFIED | Present, used by coordinator |
| `demo/coordinator.ts` | IouRedeemed reconciliation + net() wiring | ✓ VERIFIED | 718 lines, all wiring confirmed incl. WR-01/WR-02 fixes |
| `demo/e2e.ts` | Redemption scenario with base-unit assertions | ✓ VERIFIED | 379 lines, ran live: PASS |
| `docs/PROTOCOL.md` | Merkle + redemption spec | ✓ VERIFIED | 515 lines, contains "collateralized recovery path" |
| `docs/THREAT-MODEL.md` | Rows: second-preimage, double-claim x2, keep-alive, exit race, TOCTOU | ✓ VERIFIED | Rows 14-20 present with test citations |
| `README.md` | V2 hub addresses alongside v1 and Phase-1 rows | ✓ VERIFIED | Contains redeemIOU + full three-generation hub lineage |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| src/round.ts | src/merkle.ts | `import { merkleRoot }` | ✓ WIRED | round.ts:9,20 |
| ClearingHubV2.executeRound | ManifestMerkle | `rootOf(consumedIds)` / `verifyNonInclusion` in redeemIOU | ✓ WIRED | Lines 226, 362 |
| redeemIOU nullifier | executeRound consumed-id check | shared `redeemed` mapping | ✓ WIRED | Lines 95, 222, 351, 370 |
| MerkleParity.t.sol | test/fixtures/merkle.json | vm.readFile | ✓ WIRED | Line 16, 5 tests pass |
| ClearingHubV2Parity.t.sol | digest.json iouId/iouSig | hashIou + ECDSA.recover | ✓ WIRED | 2 tests pass |
| src/client.ts | src/abi/ClearingHubV2.ts | clearingHubV2Abi binding | ✓ WIRED | Sole ABI for all hub calls |
| client.fetchManifest | executeRound calldata | decodeFunctionData | ✓ WIRED | client.ts:168 |
| client.prepareRedemptionProofs | src/merkle.ts nonInclusionProof | per-buffered-round loop | ✓ WIRED | client.ts:184-191 |
| demo/coordinator.ts | IouRedeemed logs | getContractEvents (V2 ABI) | ✓ WIRED | coordinator.ts:397-405 |
| demo/e2e.ts | prepareRedemptionProofs + redeemIOU | creditor recovery path | ✓ WIRED | e2e.ts:301-314, exercised live |
| ClearingHubV2.t.sol | RoundBuilderV2.sol | harness inheritance | ✓ WIRED | 26 tests pass |
| README hub table | deployed V2 addresses | arcscan-verifiable addresses | ✓ WIRED | Both addresses have live bytecode + verified source |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| TypeScript type-check | `npx tsc --noEmit` | exit 0, clean | ✓ PASS |
| SDK + property tests | `npm test` | 64/64 pass (4 files, incl. 20 merkle) | ✓ PASS |
| Contract suites | `forge test` | 81/81 pass across 7 suites (incl. 512-run fuzz) | ✓ PASS |
| Full e2e incl. redemption | `npm run e2e:anvil` | PASS — baseline + liveness + redemption (dark debtor → exact 300000 base-unit debit → permanent netting exclusion); anvil killed after | ✓ PASS |
| Deployed bytecode (USDC hub) | `cast code 0x3b9a…5a16 --rpc-url https://rpc.testnet.arc.network` | 24,162 hex chars of code | ✓ PASS |
| Deployed bytecode (EURC hub) | `cast code 0xECcC…B85E --rpc-url …` | 24,162 hex chars of code | ✓ PASS |
| Arcscan source verification | `curl testnet.arcscan.app/api/v2/smart-contracts/{addr}` | Both return verified `ClearingHubV2.sol` source | ✓ PASS |
| Broadcast records match | grep addresses in `contracts/broadcast/DeployV2.s.sol/5042002/` | run-1784888301724 (USDC), run-1784888317489 (EURC) | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist in this project and none are declared by any Phase-2 plan. Step 7c: SKIPPED (no probes declared or discovered).

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| ----------- | ------------ | ----------- | ------ | -------- |
| MERK-01 | 02-03, 02-04, 02-08 | manifestHash preimage is sorted-leaf merkle root, same bytes32 field, no ClearingHub interface change | ✓ SATISFIED | Truths 1, 5; v1 contract untouched; parity suites green |
| MERK-02 | 02-01, 02-02, 02-03, 02-08 | Dual TS/Solidity merkle with inclusion + non-inclusion and parity fixtures | ✓ SATISFIED | Truth 2; merkle.json consumed by both stacks |
| MERK-03 | 02-04, 02-05, 02-06, 02-07, 02-08 | redeemIOU with non-inclusion proofs vs last k roots, K-staleness gate | ✓ SATISFIED | Truths 3, 7, 9, 10, 13; live e2e redemption |
| MERK-04 | 02-04, 02-05, 02-06, 02-07, 02-08 | Nullifier + bidirectional exclusivity tested | ✓ SATISFIED | Truths 4, 11, 12; fuzz + e2e permanent exclusion |

No orphaned requirements: REQUIREMENTS.md maps exactly MERK-01..04 to Phase 2, and all four are claimed across plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No TBD/FIXME/XXX/TODO/HACK markers in any phase-modified file | — | — |

Note: `placeholder` string matches in `src/merkle.ts:41,136-149` and `src/client.ts:179` are legitimate domain usage (structurally-valid sentinel proof for empty manifests), and `DeployV2.s.sol:22` / `PROTOCOL.md:361` use "demo-scale placeholders" as the deliberate uncalibrated-parameter label required by D-08. Not stubs.

### Human Verification Required

None outstanding. The single `<human-check>` in the phase (02-08 checkpoint: arcscan walkthrough + e2e + PROTOCOL.md review) was approved by the user on 2026-07-24, and all three walkthrough items were independently re-verified programmatically during this verification (arcscan API source verification, live e2e:anvil run, PROTOCOL.md spec grep).

### Gaps Summary

No gaps. All four roadmap success criteria are observably true in the codebase, backed by 81 passing Foundry tests (including 512-run adversarial fuzz), 64 passing vitest tests, cross-stack byte-parity fixtures, a live end-to-end redemption run on anvil, and redemption-capable V2 hubs with verified source live on Arc Testnet. Code-review warnings WR-01/WR-02 were fixed post-execution (commits `b69db11`, `970d782`) and confirmed present; the four INFO findings are documented deferrals (hardening/ergonomics on the SDK/demo layer, one requiring a future contract revision) and do not block the phase goal.

---

_Verified: 2026-07-24T10:52:00Z_
_Verifier: Claude (gsd-verifier)_
