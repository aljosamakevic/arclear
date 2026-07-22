---
phase: 01-threshold-consent-brief-phase-0
verified: 2026-07-22T23:44:25Z
status: passed
score: 21/21 must-haves verified
overrides_applied: 0
human_verification_completed:
  - test: "Live Arc Testnet deployment + dashboard exclusion-round walkthrough (Plan 01-05 Task 3 checkpoint)"
    approved_by: user
    approved_at: 2026-07-23
---

# Phase 1: Threshold Consent (brief Phase 0) Verification Report

**Phase Goal:** Rounds keep settling when members stall — threshold over the candidate set, unanimity over the final executed set, so no one's balance ever moves without their signature
**Verified:** 2026-07-22T23:44:25Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths — Roadmap Success Criteria (contract)

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A round proposed over a candidate set settles even when a member never responds: timeout → rebuild from consenting subset → final set signs final digest | ✓ VERIFIED | Ran `npm run e2e:anvil` in this verification: Oracle stalled → round n settled with `passCount 2`, Oracle excluded with Δ $0, none of Oracle's 16 IOU ids in round n's manifest. `attemptRound` two-pass state machine at `demo/coordinator.ts:206` (pass-1 collect → `rebuildProposal` with SAME roundNonce at :252 → pass-2 collect → submit) |
| 2 | Invariant test passes: every settled balance movement was signed by its owner over the exact executed position set; exclusion rounds are zero-sum after redistribution | ✓ VERIFIED | `test/rebuild.test.ts` CONS-03 property (verifies `verifyConsent` per index against the SUBMITTED proposal digest, `signatures.length === participants.length`); "rebuild deltas always sum to zero (CONS-05)" at :67. `npm test` 42/42 green, run here |
| 3 | An IOU excluded in round n settles cleanly in round n+1, and the same IOU can never settle twice | ✓ VERIFIED | e2e live output: "all 16 previously excluded IOU ids are in round n+1's consumed manifest", "consumed manifests of rounds n and n+1 are disjoint — nothing settles twice (CONS-04)"; CONS-04 sequence + disjointness properties in `test/rebuild.test.ts` |
| 4 | Griefing analysis documented: repeated refusal costs only rebuild latency, never a safety cost | ✓ VERIFIED | `docs/PROTOCOL.md` contains verbatim "a latency cost, never a safety cost" and "scalar debit in a stable unit"; "No threshold consent" non-goal removed (grep count 0); `docs/THREAT-MODEL.md` row 7 updated to shipped, refusal ≠ miss consistent |
| 5 | `ClearingHubV2.sol` ships with the execution path mostly unchanged — change lives in coordinator/SDK + `round.ts` | ✓ VERIFIED | Comment-stripped diff of V1 vs V2 shows ONLY the contract-name line differs; `DigestParityV2Test` passes against the UNCHANGED v1 fixture (`test/fixtures/digest.json` last touched by the v1 commit `844ea1f`, `git status` clean); `forge test` 27/27 green, run here |

### Observable Truths — Plan-Level Must-Haves (deduplicated against SCs above)

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 6 | No excluded address in rebuilt participants; no consumed id touches an excluded member (CONS-02) | ✓ VERIFIED | Property tests in `test/rebuild.test.ts`; shared `filterExcluded` helper (3 occurrences in `src/round.ts`: definition + rebuild + verify call sites) |
| 7 | Participant independently re-verifies a rebuilt proposal from own IOU view given the excluded list | ✓ VERIFIED | `verifyProposal` opts includes `excluded?: Address[]` (`src/round.ts`); honest-rebuild-verifies test; e2e providers pass excluded through |
| 8 | Lying coordinator (excluded-in-participants, self-excluded, withheld exclusion) refused with diagnostic reason, never throws | ✓ VERIFIED | Refusal tests assert `ok === false` + reason regex; zero `throw` statements inside `verifyProposal` body; post-review WR-06 fix adds `expectedRoundNonce`/`pendingConsumedIds` refusals (`src/round.ts:126-128`) |
| 9 | V2 reproduces the EXISTING digest fixture exactly — no regeneration (D-11) | ✓ VERIFIED | `contracts/test/ClearingHubV2Parity.t.sol:15` reads `../test/fixtures/digest.json`; `deployCodeTo("ClearingHubV2.sol:ClearingHubV2", ...)` at :32; passes in forge run |
| 10 | TS can deploy genuine V2 bytecode on anvil (`src/abi/ClearingHubV2.ts`) | ✓ VERIFIED | Exports `clearingHubV2Abi` + `clearingHubV2Bytecode`; `demo/setup.ts:16` imports it; zero imports of the v1 abi remain in setup; e2e asserts deployed bytecode tail vs V2 |
| 11 | DeployV2 forge script with Arc gas discipline | ✓ VERIFIED | `contracts/script/DeployV2.s.sol` exists, compiles (forge build implied by test run), usage documents `--with-gas-price 25gwei` |
| 12 | Pass-2 stall/refusal aborts cleanly: nothing settles, settledIds untouched, hard 2-pass cap (D-03) | ✓ VERIFIED | `attemptRound` aborted outcome (`demo/coordinator.ts:189`); tests assert `submitCalls.length === 0` on abort; `settledIds.add` only on confirmed settlement (:398 reconciliation, :550 confirmed path) |
| 13 | Miss counters D-06/D-07: timeout → increment, consent → reset, refusal → unchanged | ✓ VERIFIED | `applyMissSemantics` exported (`demo/coordinator.ts:161`) with dedicated unit test |
| 14 | Anvil demo/e2e runs genuine ClearingHubV2 bytecode (Pitfall 2 closed) | ✓ VERIFIED | Import swap in `demo/setup.ts`; testnet mode reads `HUB_V2_USDC` with throw-if-missing guard (:141); e2e bytecode-tail assertion |
| 15 | Per-agent stall toggle via HTTP, visible in /state, distinguishable from refusal (D-13) | ✓ VERIFIED | `POST /stall` handler (`demo/server.ts:102-113`), `stalls` map in /state (:72); `stalled: boolean` on all 5 personas (`demo/agents.ts:14,25-29`) |
| 16 | Pass-2 abort returns HTTP 200 structured; 500 reserved for faults (Pitfall 6) | ✓ VERIFIED | `/round` handler returns structured outcome for settled AND aborted (`demo/server.ts:118-132`); `printReport` only on settled; post-review 409 `roundInFlight` guard (:122-127) |
| 17 | Dashboard shows rebuild phases, exclusion rounds, stall toggles (D-14) | ✓ VERIFIED | `public/dashboard.html` contains "rebuilding", "collecting-consents-pass-2", "aborted" phase labels, `/stall` button wiring, `passCount` in round history, `fetch("/state")` poll; no external script tags. Visual behavior human-approved via checkpoint |
| 18 | "No threshold consent" non-goal superseded everywhere | ✓ VERIFIED | grep count 0 in `docs/PROTOCOL.md`; THREAT-MODEL limitations describe threshold consent as shipped |
| 19 | THREAT-MODEL.md consistent: refusal ≠ miss, limitations updated to shipped | ✓ VERIFIED | Row 7 (`docs/THREAT-MODEL.md:27`) states refusal never counts as miss; redemption row references timeout-only counter |
| 20 | Fresh V2 hubs (USDC + EURC) live on Arc Testnet; v1 hubs stay live (D-12) | ✓ VERIFIED | Independent `cast code` against `https://rpc.testnet.arc.network` in this verification: both `0xa984c64e...47f3c` (USDC) and `0x57A04759...32Cb3` (EURC) return non-empty bytecode. v1 rows retained in README. Deployment walkthrough human-approved 2026-07-23 |
| 21 | README documents V2 hub addresses alongside v1 | ✓ VERIFIED | `README.md:107-121` — v1 table intact, "Arclear Net v2 (ClearingHubV2)" table with both addresses + arcscan links; `.env.example` has `HUB_V2_USDC=`/`HUB_V2_EURC=` alongside v1 keys |

**Score:** 21/21 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/round.ts` | rebuildProposal + excluded-aware verifyProposal | ✓ VERIFIED | Exports at :87; pure filter→`net(kept)`→`buildProposal` composition (:95); wired into coordinator + tests |
| `test/rebuild.test.ts` | Property/state-machine suites, min 120/250 lines | ✓ VERIFIED | 810 lines, 26 tests including CR-01 badSignature regression; all pass |
| `contracts/src/ClearingHubV2.sol` | Near-verbatim v2 contract, min 170 lines | ✓ VERIFIED | 183 lines; only non-comment diff vs v1 is the contract name; withdraw `external nonReentrant` without whenNotPaused; ROUND_TYPEHASH string count 1; WR-04 merkle NatSpec corrected |
| `contracts/test/ClearingHubV2Parity.t.sol` | Digest parity vs existing fixture | ✓ VERIFIED | Passes in forge run against unchanged fixture |
| `contracts/script/DeployV2.s.sol` | TOKEN_ADDRESS-parameterized deploy | ✓ VERIFIED | Compiles; gas-price discipline documented |
| `src/abi/ClearingHubV2.ts` | V2 abi + bytecode exports | ✓ VERIFIED | Both exports present; consumed by `demo/setup.ts` |
| `demo/coordinator.ts` | collectConsents + attemptRound + Coordinator | ✓ VERIFIED | All exports present plus post-review `screenConsents` (:131) and `pendingSubmission` reconciliation (:342-400) |
| `demo/agents.ts` | stalled flag | ✓ VERIFIED | Field + factory init on all personas |
| `demo/setup.ts` | V2 deploy on anvil, HUB_V2_* on testnet | ✓ VERIFIED | Import swap complete, guard present |
| `demo/server.ts` | /stall + abort-aware /round + enriched /state | ✓ VERIFIED | All three present + 409 concurrency guard |
| `public/dashboard.html` | Stall toggles, phase labels, exclusion history | ✓ VERIFIED | All grep gates pass; single static file |
| `demo/e2e.ts` | Liveness scenario with assertions | ✓ VERIFIED | Ran live: PASS (baseline + stall → exclude → re-settle → never twice) |
| `docs/PROTOCOL.md` | Threshold-consent spec + griefing analysis | ✓ VERIFIED | Both verbatim acceptance sentences present; numbered-rule section |
| `docs/THREAT-MODEL.md` | Reconciled rows | ✓ VERIFIED | Row 7 + limitations updated |
| `README.md` | V2 addresses alongside v1 | ✓ VERIFIED | Both tables present; addresses confirmed live on-chain |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `src/round.ts` rebuildProposal | `net()` | filter then re-net | ✓ WIRED | `net(kept` in rebuild body |
| `src/round.ts` rebuildProposal | buildProposal | fixture-locked digest path | ✓ WIRED | `:95` |
| `ClearingHubV2Parity.t.sol` | `test/fixtures/digest.json` | vm.readFile of SAME fixture | ✓ WIRED | `:15` (tool false-negative: pattern matched with `../` prefix) |
| `src/abi/ClearingHubV2.ts` | forge out JSON | generated abi+bytecode | ✓ WIRED | bytecode differs from v1 (e2e tail check) |
| coordinator attemptRound | rebuildProposal | pass-2 rebuild, same nonce | ✓ WIRED | `demo/coordinator.ts:252` — same `roundNonce` variable, no `+1n` |
| coordinator default provider | verifyProposal | re-verify with excluded list | ✓ WIRED | `:450` |
| coordinator | settledIds | add only on confirmed settlement | ✓ WIRED | `:398` (reconciliation), `:550` (confirmed); never on abort — tests assert |
| `demo/setup.ts` | `src/abi/ClearingHubV2.ts` | V2 import | ✓ WIRED | `:16` |
| `/round` handler | runRound structured outcome | 200 for settled AND aborted | ✓ WIRED | `demo/server.ts:118-132` |
| dashboard | `GET /state` | poll rendering stalls/misses/history | ✓ WIRED | `fetch("/state")` at `:107` |
| PROTOCOL griefing section | THREAT-MODEL row 7 | consistent refusal≠miss | ✓ WIRED | Terminology matches both files |
| README hub table | deployed V2 addresses | arcscan-verifiable | ✓ WIRED | `cast code` non-empty for both, checked here |

Note: `gsd-sdk query verify.key-links` reported false negatives where `from:` fields contain prose (e.g. "src/round.ts rebuildProposal") — every link was re-verified manually above.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Type gate | `npx tsc --noEmit` | clean | ✓ PASS |
| SDK + state-machine invariants | `npm test` | 42/42 (eip712 7, netting 9, rebuild 26) | ✓ PASS |
| Contracts incl. digest parity v1+v2 | `forge test` | 27/27, fuzz 512 runs | ✓ PASS |
| Canonical liveness scenario (phase goal) | `npm run e2e:anvil` | PASS — stall → passCount-2 exclusion round → excluded 16 IOUs settle in n+1 → manifests disjoint | ✓ PASS |
| V2 hubs live on Arc Testnet | `cast code <addr> --rpc-url https://rpc.testnet.arc.network` | non-empty bytecode for both README addresses | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
| ----------- | ------------- | ----------- | ------ | -------- |
| CONS-01 | 01-03, 01-04 | Candidate-set proposal + consent window | ✓ SATISFIED | `collectConsents` deadline snapshot + tests; stall toggle demo surface; e2e |
| CONS-02 | 01-01, 01-03 | Timeout rebuild from consenting subset | ✓ SATISFIED | `rebuildProposal` + exclusion-completeness properties; coordinator wiring |
| CONS-03 | 01-01, 01-03 | Unanimity-over-executed-set invariant tested | ✓ SATISFIED | CONS-03 property with real EIP-712 signatures + `verifyConsent`; CR-01 fix adds `screenConsents` so submit only sees locally-verified signatures |
| CONS-04 | 01-03, 01-04 | Excluded IOU settles n+1, never twice | ✓ SATISFIED | Disjoint-manifest property + live e2e proof; WR-01 pending-submission reconciliation closes the double-settle window |
| CONS-05 | 01-01, 01-05 | Zero-sum exclusion rounds + griefing analysis documented | ✓ SATISFIED | Zero-sum property (`test/rebuild.test.ts:67`); PROTOCOL.md griefing section with verbatim acceptance sentence |
| CONS-06 | 01-02, 01-05 | V2 ships with execution path mostly unchanged | ✓ SATISFIED | Name-only code diff, digest parity vs unchanged fixture, live testnet deploys |

No orphaned requirements: REQUIREMENTS.md maps exactly CONS-01..06 to Phase 1, and all six are claimed across plan frontmatter.

**Tracking note (non-blocking):** `.planning/REQUIREMENTS.md` still shows CONS-05 as unchecked (line 16) and "Pending" (line 89) even though the codebase evidence satisfies it. This is a stale tracking checkbox, not a code gap — the orchestrator should tick it when bundling phase artifacts.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | none | — | No TBD/FIXME/XXX/TODO/HACK/placeholder markers in any phase-modified file; no stub returns; no console.log-only handlers |

### Code-Review Fix Confirmation (HEAD state)

The review pass (01-REVIEW.md, status `fixes_applied`) claimed 11 fixes. Spot-confirmed at HEAD:
- CR-01: `screenConsents` exists (`demo/coordinator.ts:131`) and is called on BOTH passes (:233, :270); `badSignature` regression provider in `test/rebuild.test.ts:455-476`
- WR-01: `pendingSubmission` reconciliation (:342-400) folds consumed ids on confirmed-but-unrecorded rounds
- WR-02: nonce-race detection from chain state (graceful abort driven by re-read nonce)
- WR-03: `roundInFlight` 409 guard (`demo/server.ts:122-127`)
- WR-04: V2 NatSpec now correctly says keccak256 manifest, merkle root deferred (:27)
- WR-06: `expectedRoundNonce`/`pendingConsumedIds` opts on `verifyProposal` (`src/round.ts:126-128`)
Deferred items (IN-02/03/04/06/07) are info-level with documented rationale and do not block the phase goal.

### Human Verification Required

None outstanding. The single human-verify item for this phase (Plan 01-05 Task 3 blocking checkpoint: arcscan contract pages + dashboard exclusion-round walkthrough + PROTOCOL.md skim) was completed and approved by the user on 2026-07-23. This verification independently re-confirmed the machine-checkable halves (on-chain bytecode via `cast code`, e2e exclusion round live).

### Gaps Summary

No gaps. All five roadmap success criteria are observably true in the codebase, all 21 merged must-have truths verified, all six requirement IDs satisfied, all automated suites re-run green during verification (tsc, vitest 42/42, forge 27/27, e2e:anvil PASS), and both V2 hubs confirmed live on Arc Testnet by direct RPC query. The one follow-up is administrative: tick the CONS-05 checkbox in `.planning/REQUIREMENTS.md`.

---

_Verified: 2026-07-22T23:44:25Z_
_Verifier: Claude (gsd-verifier)_
