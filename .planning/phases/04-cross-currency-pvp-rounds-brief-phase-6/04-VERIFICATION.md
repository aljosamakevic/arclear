---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
verified: 2026-07-24T18:05:00Z
status: passed
score: 28/28 must-haves verified
overrides_applied: 0
---

# Phase 4: Cross-Currency PvP Rounds Verification Report

**Phase Goal:** USDC and EURC legs settle atomically in a payment-vs-payment round — a miniature CLS on Arc; agreed per-round FX rate signed into the consent digest, tied to arc-stablecoin-fx
**Verified:** 2026-07-24T18:05:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Roadmap Success Criteria (the contract) first, then plan-frontmatter truths. All evidence is from the actual codebase / live chain / executed suites at HEAD — not from SUMMARY claims.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| SC1 | A cross-currency round settles both the USDC leg and the EURC leg atomically — both settle or neither does | ✓ VERIFIED | `contracts/src/PvPRouter.sol`: plain external `executeRound` calls, zero try/catch or low-level calls (grep across file: only doc-comment mentions). Forge revert matrix (11 revert tests, each asserting BOTH `roundNonce`s unchanged, e.g. `PvPRouter.t.sol:218-219, 268-269, 298-299`). Executed `npm run e2e:anvil`: positive — both legs mined in ONE tx `0xc0acd7…`, USDC nonce 6→7, EURC 0→1 (fresh hub), FX-exact balances; negative (a) withheld consent → aborted, both nonces + all collateral map-equal unchanged; negative (b) corrupted EURC sig → mined `status: reverted` receipt `0x5df618…`, both nonces + all collateral unchanged |
| SC2 | The agreed per-round FX rate is signed into the consent digest, tied to the official `arc-stablecoin-fx` sample | ✓ VERIFIED | `PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)` typehash byte-identical in `src/domain.ts:90-96` and `contracts/src/PvPRouter.sol:75-77`; `PvPParity.t.sol` PASS (TS pvpDigest == Solidity hashPvPRound for shared fixture + on-chain ECDSA recovery of viem consent). `demo/fx.ts` mirrors the `arc-stablecoin-fx` App Kit quote shape (`amountIn`/`amountOut` → `quoteToRate`); `docs/PROTOCOL.md:637-647` documents the tie-in as the sanctioned D-06 fallback |
| 1.1 | pvpDigest same digest for same 4 fields, different when any changes | ✓ VERIFIED | vitest 120/120 incl. `test/pvp.test.ts` digest suite; on-chain mirror `test_hashPvPRound_fieldSensitivity` PASS |
| 1.2 | PvPRound consent verifies true for member, false for others | ✓ VERIFIED | `test/pvp.test.ts` roundtrip suite passing; `PvPParity.t.sol` on-chain OZ ECDSA recovery of the fixture consent |
| 1.3 | verifyPvPProposal rejects tampered legs/rate/digest with `{ ok: false, reason }` | ✓ VERIFIED | tamper-rejection suite passing; hardened at HEAD by CR-01 fix — inclusion-symmetry check `src/pvp.ts:245-289` |
| 1.4 | unionParticipants merges strictly-ascending sets (identical/overlapping/disjoint) into one strictly-ascending union | ✓ VERIFIED | `src/pvp.ts` `unionParticipants` with WR-03 `prev` cursor guard (rejects unsorted/dupe/zero-address, mirrors `_unionOf`); fast-check property + guard tests passing |
| 2.1 | executePvP settles both legs in one tx or reverts entirely — no try/catch anywhere | ✓ VERIFIED | Grep: no `try`/`catch`/`.call(`/`delegatecall` in `PvPRouter.sol`; e2e forced-revert variant proves bubbling on-chain |
| 2.2 | Router stateless: only two immutable hub addresses; no funds, owner, pause, reentrancy guard | ✓ VERIFIED | Grep: zero `mapping`/`storage`/`Ownable`/`Pausable`/`ReentrancyGuard`; only `ClearingHubV2 public immutable hubUSDC/hubEURC` (lines 70-73); `test_constructor_immutables` PASS |
| 2.3 | PvPRound sigs only from sorted union of both legs' participants, one per member, index-aligned | ✓ VERIFIED | `test_revert_executePvP_badPvPSignature`, `_pvpSignatureCountMismatch`, `_unionDisorder` all PASS |
| 2.4 | Calldata legs not matching signed digests revert LegDigestMismatch before execution | ✓ VERIFIED | `test_revert_executePvP_legDigestMismatch` PASS; digest recomputed via `ManifestMerkle.rootOf` (`PvPRouter.sol:168-172`) |
| 3.1 | TS pvpDigest == Solidity hashPvPRound byte-identical for shared fixture (D-05) | ✓ VERIFIED | `forge test --match-path test/PvPParity.t.sol`: `test_pvpDigestMatchesSdkFixture` PASS |
| 3.2 | TS-signed PvPRound consent recovers to correct signer via OZ ECDSA on-chain | ✓ VERIFIED | Same parity test reads `pvpSigner0`/`pvpConsent0` from fixture and asserts recovery |
| 3.3 | Regenerating fixture changes no pre-existing key | ✓ VERIFIED | Ran `npm run fixture`: `digest.json` SHA `bda524d6…` byte-identical before/after, git clean |
| 4.1 | Full PvP round settles both legs in one tx: nonces advance, exact deltas, PvPExecuted | ✓ VERIFIED | `test_executePvP_bothLegsSettle`/`_identicalSets`/`_disjointSets` PASS with nonce+1 assertions (`PvPRouter.t.sol:93-94,141-142,177-178`); e2e balance assertions |
| 4.2 | Every failure mode reverts EVERYTHING; nonces + collateral unchanged after each | ✓ VERIFIED | 11-test revert matrix (bad leg sig, wrong nonce, insufficient collateral 2nd leg, paused hub, bad PvP sig, count mismatch, union disorder, digest mismatch, zero num/den, replay), each with unchanged-state assertions; all PASS |
| 4.3 | Single-leg direct submission SETTLES — machine-documented limitation | ✓ VERIFIED | `test_singleLegDirectSubmissionSettles` PASS; cited in `docs/THREAT-MODEL.md` rows 21 + residual-risk table (Herstatt-style downgrade, never unsigned movement) |
| 4.4 | executePvP gas measured at demo scale; client formula carries measured constants with provenance | ✓ VERIFIED | `test_gas_executePvP_small`/`_demoScale`; `docs/PROTOCOL.md:521-522` (563,814 / 1,734,897); `PVP_ROUTER_GAS_BASE` in `src/client.ts` with gas-snapshot provenance link |
| 5.1 | setupAnvil boots dual-hub world: two tokens, two V2 hubs, one router, all agents funded/deposited both hubs | ✓ VERIFIED | e2e:anvil executed the full bootstrap and settled rounds on both hubs |
| 5.2 | Testnet mode reads HUB_V2_EURC and PVP_ROUTER env keys with actionable errors | ✓ VERIFIED | `demo/setup.ts` contains `PVP_ROUTER` env handling (verify.artifacts `contains` check PASS); `.env.example` documents keys |
| 5.3 | attemptPvPRound: one provider call per union member, batch exclusion from BOTH legs, rebuild at unchanged nonces, clean two-pass abort (D-08/D-09) | ✓ VERIFIED | `test/pvpRound.test.ts` outcome suite with fake providers passing (part of vitest 120/120) |
| 5.4 | In-flight PvP bundle refuses ordinary rounds on both hubs; failure classified from chain nonces, never error strings | ✓ VERIFIED | `test/pvpRound.test.ts:565-569` ("PvP bundle in flight — ordinary rounds refused on both hubs"); WR-02 hardening classifies via `RoundExecuted` `roundHash` match FIRST, then nonces (`demo/pvp.ts:735-745`) |
| 6.1 | e2e proves both-or-neither POSITIVELY: atomic settle, FX-exact per-persona balances, gasUsed printed | ✓ VERIFIED | Executed: "pvp router tx mined successfully", "pvp gasUsed=507430", rate tag 989589/1000000 on both hub round records |
| 6.2 | e2e proves NEGATIVELY from CHAIN state, plus forced on-chain revert with mined status:reverted receipt | ✓ VERIFIED | Executed: both variants — nonces + collateral map-equal on both hubs after abort AND after mined revert |
| 6.3 | Dashboard shows at most a PvP badge — no new panels/endpoints (D-12) | ✓ VERIFIED | `public/dashboard.html:161-166`: single badge cell reading `r.pvp`, D-12 comment; no new endpoints in `demo/server.ts` |
| 7.1 | PROTOCOL.md documents PvPRound typehash, atomicity, num/den semantics, arc-stablecoin-fx tie-in with D-06 fallback, third superseded non-goal | ✓ VERIFIED | Lines 559 (exact typehash), 581 (check order), 637-647 (tie-in + D-06 fallback), 680 (superseded "no cross-currency rounds") |
| 7.2 | THREAT-MODEL.md states single-leg-extraction limitation PLAINLY; FX rate agreed, not oracle-derived | ✓ VERIFIED | Rows 21, 25 ("agreed, not oracle-derived"), 27 (counter-leg stripping caught post-CR-01), residual-risk row citing `test_singleLegDirectSubmissionSettles` |
| 7.3 | PvPRouter live on Arc testnet, source-verified, bound to existing V2 hubs, recorded in README | ✓ VERIFIED | Live `cast code` at `0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c` returns ~6.7KB bytecode; `cast call hubUSDC()` → `0x3b9a9617…5a16`, `hubEURC()` → `0xECcCD7E4…B85E` — exactly matching README V2 hub table (README:199-210); Blockscout API returns verified `PvPRouter.sol` source |
| 7.4 | A human has walked through the live router and e2e run and approved | ✓ VERIFIED | 04-07-SUMMARY frontmatter checkpoint record: `verified-by: user`, `verified-on: 2026-07-24`, evidence "User replied 'approved'" (arcscan verification, suites, e2e walkthrough, docs honesty review) |

**Score:** 28/28 truths verified (2 roadmap SCs + 26 plan-frontmatter truths; no overrides)

### Required Artifacts

All 23 declared artifacts across 7 plans pass `gsd-sdk query verify.artifacts` (exists + min_lines + contains). Highlights:

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `src/pvp.ts` | pvpDigest/build/verify/sign/union/rateConsistent | ✓ VERIFIED | Substantive; CR-01 + WR-03 hardening present at HEAD |
| `contracts/src/PvPRouter.sol` | stateless atomic router | ✓ VERIFIED | Exact PvPRound typehash; immutables only |
| `contracts/test/PvPRouter.t.sol` | positive + revert matrix + limitation + gas | ✓ VERIFIED | 19 tests, all PASS |
| `contracts/test/PvPParity.t.sol` | deployCodeTo digest parity | ✓ VERIFIED | 1/1 PASS |
| `test/fixtures/digest.json` | pvp_* keys | ✓ VERIFIED | Regen byte-stable |
| `src/abi/PvPRouter.ts`, `src/client.ts` | abi/bytecode + PvPRouterClient with gas constants | ✓ VERIFIED | `PVP_ROUTER_GAS_BASE` + `roundExecutedHashes` reader (WR-02) |
| `demo/setup.ts`, `demo/fx.ts`, `demo/pvp.ts`, `test/pvpRound.test.ts` | dual-hub bootstrap, fx mirror, two-pass core | ✓ VERIFIED | e2e exercised end-to-end; WR-01/02 pending-persistence present |
| `demo/e2e.ts`, `public/dashboard.html` | PvP scenarios + badge | ✓ VERIFIED | e2e executed PASS; badge D-12-bounded |
| `contracts/script/DeployPvPRouter.s.sol`, `docs/PROTOCOL.md`, `docs/THREAT-MODEL.md`, `README.md` | deploy + docs + address row | ✓ VERIFIED | Deployed address cast-verified against README |

### Key Link Verification

18/18 wired. 13 verified by `gsd-sdk query verify.key-links`; 5 automated pattern misses re-verified manually (regex escaping artifacts, not real gaps):

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `src/index.ts` | `src/pvp.ts` | barrel export | ✓ WIRED | `src/index.ts:8` `export * from "./pvp.js";` (correct position: after round/creditCap, before client) |
| `contracts/src/PvPRouter.sol` | `ManifestMerkle.sol` | rootOf(consumedIds) | ✓ WIRED | Lines 168, 172: `ManifestMerkle.rootOf(...)` per leg |
| `PvPParity.t.sol` | `digest.json` | vm.readFile/parseJson | ✓ WIRED | Line 20: `vm.readFile("../test/fixtures/digest.json")` + parseJson* for all pvp keys |
| `test/pvp.test.ts` | `digest.json` | TS fixture lock | ✓ WIRED | Lines 384-408: shared fixture parity (D-05) describe block |
| `public/dashboard.html` | /state rounds | `r.pvp` field | ✓ WIRED | Lines 163-164: badge from `r.pvp.fxNumerator/fxDenominator` |
| (13 others) | — | — | ✓ WIRED | Automated pattern match |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `public/dashboard.html` PvP badge | `r.pvp` | `ExecutedRound.pvp` (`demo/coordinator.ts:330`) via existing `/state` serialization | Yes — e2e runtime asserted "both hubs' round records carry the PvP rate tag (989589/1000000)" | ✓ FLOWING |
| `src/client.ts` PvPRouterClient gas | `PVP_ROUTER_GAS_BASE` | Measured forge gas tests → `.gas-snapshot` provenance | Yes — constants match PROTOCOL measured rows | ✓ FLOWING |
| `demo/pvp.ts` submission classification | `RoundExecuted` logs | `HubClient.roundExecutedHashes` (`src/client.ts:131`) — real `getLogs` reader | Yes — tested with mined-successful/failing-receipt scenario | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| TypeScript type gate | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| SDK + demo suites | `npm test` | 8 files, 120/120 tests | ✓ PASS |
| Contract suites | `forge test` | 9 suites, 101/101 tests | ✓ PASS |
| Full e2e (PvP positive + 2 negatives) | `npm run e2e:anvil` | PASS line printed, exit 0; anvil killed after | ✓ PASS |
| Fixture determinism | `npm run fixture` + SHA compare | byte-identical | ✓ PASS |
| Live router bound to V2 hubs | `cast call hubUSDC()/hubEURC()` at `0x8287dD…fE8c` on `rpc.testnet.arc.network` | `0x3b9a…5a16` / `0xECcC…B85E` — matches README | ✓ PASS |
| Live router source verification | Blockscout API `smart-contracts/0x8287…` | Returns verified `PvPRouter.sol` source | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist or are declared by any phase 4 plan (`find scripts -path '*/tests/probe-*.sh'` → none). Behavioral verification is carried by the suites above. SKIPPED (no probes declared).

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| ----------- | ------------ | ----------- | ------ | -------- |
| PVP-01 | 04-02, 04-04, 04-05, 04-06, 04-07 | USDC + EURC legs settle atomically in a PvP round (miniature CLS) | ✓ SATISFIED | SC1 evidence: router code + revert matrix + e2e positive/negative on-chain assertions + live deployment |
| PVP-02 | 04-01, 04-02, 04-03, 04-05, 04-07 | Agreed per-round FX rate signed into consent digest; ties to official `arc-stablecoin-fx` sample | ✓ SATISFIED | SC2 evidence: rate fields in PvPRound EIP-712 struct both stacks, digest parity fixture, `demo/fx.ts` quote-shape mirror, PROTOCOL D-06 tie-in |

No orphaned requirements: REQUIREMENTS.md maps exactly PVP-01/PVP-02 to Phase 4, and both are claimed by plans. (Note: the REQUIREMENTS.md traceability table still shows both as "Pending" — bookkeeping to flip at milestone audit, not an implementation gap.)

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | — | — | None. Zero TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers across all 20 phase-modified files |

Post-review hardening independently confirmed at HEAD (not trusted from REVIEW.md):
- **CR-01** — `verifyPvPProposal` FX-pair inclusion symmetry: lowercase consumed-id sets from both leg manifests, joint-consumption assertion with "inclusion asymmetry" refusal (`src/pvp.ts:245-289`); attack regression test reproduces the stripping attack in BOTH directions (`test/pvp.test.ts:315-368`)
- **WR-01** — `runPvPRound` records pending on BOTH coordinators before broadcast, re-records with txHash, clears only on definitive revert/confirmed fold (`demo/pvp.ts:696-714`; `Coordinator.recordPendingSubmission` `demo/coordinator.ts:400-412`); tested pending-before-broadcast (`test/pvpRound.test.ts:359-397`)
- **WR-02** — submission-failure classification matches `RoundExecuted` `roundHash` against leg digests FIRST via `HubClient.roundExecutedHashes` before any nonce comparison (`demo/pvp.ts:735-773`)
- **WR-03** — `unionParticipants` strict-ascending/zero-address guard mirroring `_unionOf` (`src/pvp.ts`)

### Human Verification Required

None outstanding. The phase's single human item (04-07-T3: live router + e2e walkthrough) was approved by the user on 2026-07-24 and is recorded with evidence in 04-07-SUMMARY frontmatter (`verified-by: user`, "User replied 'approved'"). No plan contains deferred `<human-check>` blocks on auto tasks.

### Gaps Summary

No gaps. Both roadmap success criteria are observably true in the codebase and on the live chain: atomicity is enforced by construction (plain-call bubbling, stateless router) and proven by executed chain-state assertions in both directions; the FX rate is a first-class field of the signed PvPRound digest with cross-stack byte parity, sourced through an `arc-stablecoin-fx`-shaped quote. The one honest limitation (single-leg extraction outside the router) is deliberately accepted, machine-documented by a settling test, and stated plainly in THREAT-MODEL — exactly as the plan required. The critical review finding (counter-leg stripping) is fixed at HEAD with a both-direction attack regression test.

Disconfirmation pass results: (1) no partially-met requirement found — the single-leg residual is scoped out by design with documentation, not silently; (2) revert-matrix tests genuinely assert unchanged state (nonce + collateral), not just revert selectors; (3) the receipt-transport error path — the classic untested path — is covered by WR-01/02 tests (mined-successful tx with failing receipt wait classifies `settled` and folds).

---

_Verified: 2026-07-24T18:05:00Z_
_Verifier: Claude (gsd-verifier)_
