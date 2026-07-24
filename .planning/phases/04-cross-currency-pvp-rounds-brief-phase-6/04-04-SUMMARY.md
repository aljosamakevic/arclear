---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 04
subsystem: contracts-pvp-testing-and-client
tags: [foundry, testing, gas, revert-matrix, viem-client, pvp-01]

# Dependency graph
requires:
  - phase: 04-01
    provides: unionParticipants + PvPProposal type consumed by PvPRouterClient's gas formula and Leg assembly
  - phase: 04-02
    provides: PvPRouter.sol (executePvP, hashPvPRound, full error surface) + the smoke setUp migrated into the harness
provides:
  - "contracts/test/utils/PvPRoundBuilder.sol: dual-hub + router harness (hub-parameterized digest/sign/fund helpers, sorted union merge, PvP consent builder, canonical _simplePvP bundle)"
  - "contracts/test/PvPRouter.t.sol: positive both-legs-settle in all three Q5 set regimes + 8-way revert matrix with post-revert both-or-neither assertions + replay test + test_singleLegDirectSubmissionSettles + 2 gas tests"
  - "Measured executePvP gas: 563,814 (n=3+3, m=10+10, union=4) and 1,734,897 (n=5+5, m=105+105, union=5) — in contracts/.gas-snapshot"
  - "src/abi/PvPRouter.ts: pvpRouterAbi + pvpRouterBytecode"
  - "src/client.ts: PVP_ROUTER_GAS_BASE (350k) / PVP_GAS_PER_UNION_SIG (15k) + PvPRouterClient with formula-gas executePvP write"
affects: [04-05 demo bootstrap/coordinator (PvPRouterClient + pvpRouterBytecode), 04-06 deploy/e2e (gas formula, abi), 04-07 THREAT-MODEL prose (cites test_singleLegDirectSubmissionSettles)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PvPBundle struct as the harness unit of tamper: build valid via _simplePvP, mutate one field, expectRevert typed selector, assert both-or-neither postcondition"
    - "_submit(bundle) makes the router call the ONLY external call after vm.expectRevert/vm.expectEmit, keeping cheatcode targeting exact"
    - "PvP gas formula composes: router base + 2x leg base + leg per-participant/per-id coefficients (single source of truth from plan 02-05) + per-union-signature term"

key-files:
  created: [contracts/test/utils/PvPRoundBuilder.sol, src/abi/PvPRouter.ts]
  modified: [contracts/test/PvPRouter.t.sol, contracts/.gas-snapshot, src/client.ts]

key-decisions:
  - "wrongLegNonce test signs the EURC leg over nonce+1 from scratch (not a calldata tamper) — a nonce tamper would trip LegDigestMismatch first, masking the WrongRoundNonce bubble under test"
  - "unionDisorder test recomputes the leg digest over the swapped participants so digest binding passes and the union merge is provably the check that fires (router-local, before any hub call)"
  - "PVP_ROUTER_GAS_BASE fitted at 350k (research expected ~150k) because the 1.5x margin at the demo point requires BASE + 5*PER_SIG >= 342,346 — margin dominates the raw overhead estimate"

patterns-established:
  - "Post-revert both-or-neither postcondition: every matrix test asserts 2 roundNonces + 4 collateral reads (USDC debtor/creditor + EURC debtor/creditor) captured AFTER tampering, checked after the revert"

requirements-completed: [PVP-01]

# Metrics
duration: ~13min
completed: 2026-07-24
---

# Phase 4 Plan 04: PvP Revert Matrix, Gas Measurement + PvPRouterClient Summary

**PVP-01 proven exhaustively in Foundry: both-or-neither positively across overlapping/disjoint/identical participant sets and against an 8-way revert matrix with post-revert state assertions on both hubs; the single-leg direct-submission limitation is a passing test; executePvP gas is measured (563,814 small / 1,734,897 demo-scale) and drives the PvPRouterClient formula with >=1.5x margin and explicit gas on every Arc write.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-07-24T15:44:50Z
- **Completed:** 2026-07-24T15:58:00Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- `contracts/test/utils/PvPRoundBuilder.sol` (301 lines): dual-hub harness — two MockUSDC tokens, two ClearingHubV2 (UNCALIBRATED K=3/RING=16/L=86400), one PvPRouter; RoundBuilderV2's helpers ported hub-parameterized (`_digestV2`, `_signRound`, `_buildSignatures`, `_fundAndDeposit`); PvP layer: `_union` sorted merge, `_signPvP`/`_buildPvPSignatures` (index-aligned), `_buildLeg`, `_bundle`, and canonical `_simplePvP` (USDC leg {A,B,C}, EURC leg {B,C,D}, union 4, rate 989589/1000000)
- Positive path proven with exact per-actor collateral deltas + nonce advances on BOTH hubs + `PvPExecuted` via `vm.expectEmit`, in all three RESEARCH Q5 set regimes (overlapping, disjoint union=concatenation, identical union=set)
- 8-way revert matrix, every test with 6 post-revert assertions (2 nonces + 4 collateral reads on both hubs), all typed via `abi.encodeWithSelector`, zero string-revert assertions: `BadSignature(0)` bubbled after the USDC leg executed (THE atomicity proof), `WrongRoundNonce`, `InsufficientCollateral(actors[1],0,3e6)` via post-consent withdraw, `EnforcedPause`, `BadPvPSignature(1)`, `PvPSignatureCountMismatch(4,3)`, `UnionNotStrictlyAscending`, `LegDigestMismatch(0|1)`
- `test_revert_executePvP_replaySameBundle`: identical calldata re-submission dies `WrongRoundNonce` — structural replay protection, no router state (T-04-17)
- `test_singleLegDirectSubmissionSettles`: bare `hubUSDC.executeRound` with the USDC leg's calldata SETTLES (positive assertions: nonce +1, all three deltas applied), then the router bundle reverts `WrongRoundNonce` — the machine documentation D-13 cites, header comment stating the accept-and-document disposition and referencing docs/THREAT-MODEL.md (T-04-16)
- Suites: 100/100 forge (was 85), 100/100 vitest, `tsc --noEmit` clean

## Measured executePvP Gas (for 04-05/04-06)

| Point | Legs | Manifests | Union | Measured (gasleft delta) | Snapshot line |
|-------|------|-----------|-------|--------------------------|---------------|
| small | n=3 + n=3 | m=10 + m=10 | 4 | **563,814** | `PvPRouterTest:test_gas_executePvP_small() (gas: 991157)` |
| demo scale | n=5 + n=5 | m=105 + m=105 | 5 | **1,734,897** | `PvPRouterTest:test_gas_executePvP_demoScale() (gas: 6193500)` |

Client formula (`src/client.ts`): `PVP_ROUTER_GAS_BASE(350_000) + 2*EXECUTE_ROUND_GAS_BASE + EXECUTE_ROUND_GAS_PER_PARTICIPANT*(n1+n2) + EXECUTE_ROUND_GAS_PER_ID*(m1+m2) + PVP_GAS_PER_UNION_SIG(15_000)*nUnion`
- Demo point: 350,000 + 600,000 + 400,000 + 1,260,000 + 75,000 = **2,685,000 = 1.55x** measured 1,734,897
- Small point: 350,000 + 600,000 + 240,000 + 120,000 + 60,000 = **1,370,000 = 2.43x** measured 563,814
- `grep -c 'estimateGas\|estimateContractGas' src/client.ts` = 0 (T-04-18)

## Task Commits

1. **Task 1: PvPRoundBuilder harness + positive both-legs-settle tests** — `4ba0fbd` (test)
2. **Task 2: Full revert matrix + single-leg documented-limitation test** — `184a43a` (test)
3. **Task 3: Gas measurement + snapshot + abi module + PvPRouterClient** — `5f9a7fe` (feat)

## Files Created/Modified

- `contracts/test/utils/PvPRoundBuilder.sol` - dual-hub + router harness, PvPBundle struct, union/consent/leg builders, `_simplePvP`, `_submit`
- `contracts/test/PvPRouter.t.sol` - 19 tests: 4 smoke (from 04-02, behavior unchanged) + 3 positive + 8 matrix + replay + single-leg limitation + 2 gas
- `contracts/.gas-snapshot` - 2 new `PvPRouterTest:test_gas_executePvP_*` lines appended
- `src/abi/PvPRouter.ts` - `pvpRouterAbi` (19 entries) + `pvpRouterBytecode`, generated from `contracts/out/PvPRouter.sol/PvPRouter.json` (ClearingHubV2.ts module shape)
- `src/client.ts` - `PVP_ROUTER_GAS_BASE`/`PVP_GAS_PER_UNION_SIG` with provenance comments; `PvPRouterClient` (constructor(router, rpcUrl?), `hubUSDC`/`hubEURC`/`hashPvPRound` reads, `executePvP` write with formula gas + `MIN_MAX_FEE_PER_GAS`); `toAbiLeg` helper assembling Leg tuples from embedded RoundProposals

## Decisions Made

- **wrongLegNonce built from scratch, not tampered:** mutating the nonce on a signed bundle would fail digest binding (`LegDigestMismatch`) before ever reaching the hub — the test signs the EURC leg consistently over nonce+1 so `WrongRoundNonce` is provably the bubbled error, doubling as a second atomicity proof (USDC leg executes first, then fully reverts)
- **unionDisorder keeps digest binding valid:** the leg digest is recomputed over the swapped participants so step (2) passes and `UnionNotStrictlyAscending` at step (4) is what fires — proving the check is router-local, before any hub call (leg/pvp signatures are stale but unreached)
- **PVP_ROUTER_GAS_BASE = 350k, not the research's ~150k raw-overhead estimate:** the binding constraint is the >=1.5x margin at the demo point (BASE + 5*PER_SIG >= 342,346 given the reused leg coefficients); PER_SIG stays at the research's 15k magnitude and BASE absorbs the margin
- **Snapshot lines from `forge snapshot --match-test`**, not hand-computed: the snapshot format records full-test gas (setup included), while the console2-logged gasleft() deltas are the call-only numbers the formula is fitted against — both documented, different purposes

## Deviations from Plan

None - plan executed exactly as written. (One acceptance-criteria note: the plan's Task 2 count says "all ten matrix tests" — the matrix is 8 revert modes + replay + single-leg = 10 tests as enumerated, all present and passing.)

## Issues Encountered

None.

## Known Stubs

None — the harness, matrix, abi module, and client are fully wired; no placeholder values or unwired data paths.

## Threat Flags

None — no security surface beyond the plan's threat model. T-04-15 (atomicity matrix), T-04-16 (single-leg, accepted + machine-documented), T-04-17 (replay), T-04-18 (gas underestimation) all carry their planned dispositions.

## User Setup Required

None.

## Next Phase Readiness

- 04-05 (demo bootstrap/coordinator) gets `PvPRouterClient` + `pvpRouterBytecode` for anvil deployment and the measured gas numbers above
- 04-06 (deploy/e2e) can cite the demo-scale measured 1,734,897 and the 2,685,000 formula limit; e2e should print actual `gasUsed` for the record (RESEARCH A3)
- 04-07 (THREAT-MODEL prose) cites `test_singleLegDirectSubmissionSettles` as the machine documentation for single-leg extraction

## Self-Check: PASSED

All claimed files exist (PvPRoundBuilder.sol, PvPRouter.t.sol, .gas-snapshot, src/abi/PvPRouter.ts, src/client.ts); all three task commits (4ba0fbd, 184a43a, 5f9a7fe) verified in git log on the worktree branch.

---
*Phase: 04-cross-currency-pvp-rounds-brief-phase-6*
*Completed: 2026-07-24*
