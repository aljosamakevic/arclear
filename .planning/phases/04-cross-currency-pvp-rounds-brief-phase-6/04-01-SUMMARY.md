---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 01
subsystem: sdk
tags: [eip712, viem, typescript, fx, signing, fast-check]

# Dependency graph
requires:
  - phase: 01-consent-machinery (v2)
    provides: verifyProposal WR-06 opts (expectedRoundNonce, pendingConsumedIds) composed per leg
  - phase: v1 foundation
    provides: net()/buildProposal/signConsent round machinery, EIP-712 domain patterns, SignedIou shared-ref convention
provides:
  - PvPRound EIP-712 layer in the SDK — pvpDomain ("ArclearPvPRouter"/"1") + PVP_TYPES with canonical typehash
  - pvpDigest, signPvPConsent, verifyPvPConsent (mirror of round.ts consent trio)
  - unionParticipants sorted merge (same spec the router implements on-chain)
  - rateConsistent bigint cross-multiplication (D-04, no division)
  - buildPvPProposal + verifyPvPProposal participant-side bundle verification (D-07)
  - PvPProposal interface in src/types.ts; barrel export before client
affects: [04-02 PvPRouter.sol (typehash byte-match), 04-03 parity fixture, 04-04/04-05 demo coordinator + e2e, 04-06 client, 04-07 docs]

# Tech tracking
tech-stack:
  added: []
  patterns: [pvp.ts mirrors round.ts function-for-function, per-leg opts passthrough (usdc/eurc LegVerifyOpts), shared-ref FX-pair verification]

key-files:
  created: [src/pvp.ts, test/pvp.test.ts]
  modified: [src/domain.ts, src/types.ts, src/index.ts]

key-decisions:
  - "FX-pair rate checked per shared-ref IOU pair only, never per net delta (Pitfall 6) — why-comment in verifyPvPProposal"
  - "verifyPvPProposal check order: leg re-verification (prefixed reasons) -> FX-pair direction/rate -> bundle digest recompute"
  - "signPvPConsent error string matches round.ts exactly ('account cannot sign typed data') for convention parity"

patterns-established:
  - "Per-leg opts passthrough: opts.usdc / opts.eurc carry verifyProposal's full opts (WR-06 machinery generalizes per leg)"
  - "Canonical PvPRound typehash string documented byte-identically in src/domain.ts and src/pvp.ts doc comments for grep-able parity with PvPRouter.sol"

requirements-completed: [PVP-02]

# Metrics
duration: 7min
completed: 2026-07-24
---

# Phase 4 Plan 01: PvP SDK Consent Layer Summary

**PvPRound EIP-712 consent layer in the SDK: digest/sign/verify in the ArclearPvPRouter domain, sorted union merge, bigint cross-multiplication rate check, and full participant-side bundle verification composing verifyProposal per leg — 17 vitest tests including 2 fast-check properties**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-24T15:35:42Z
- **Completed:** 2026-07-24T15:42:30Z
- **Tasks:** 2 (both TDD)
- **Files modified:** 5

## Accomplishments
- `src/pvp.ts` (256 lines) mirrors `src/round.ts` function-for-function: `pvpDigest`, `signPvPConsent`, `verifyPvPConsent`, `unionParticipants`, `rateConsistent`, `buildPvPProposal`, `verifyPvPProposal`
- Canonical typehash `PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)` and domain `{"ArclearPvPRouter","1"}` present byte-identically in both `src/domain.ts` and `src/pvp.ts` for the parallel router agent and the wave-2 parity fixture
- `verifyPvPProposal` rejects every modeled tamper (leg delta, bundle digest, rate off by 1 base unit, same-direction FX pair) with diagnostic `{ ok: false, reason }` naming the failing leg / ref / amounts — never throws
- Full suite regression-free: 100/100 vitest tests pass, `tsc --noEmit` clean (strict)

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1: PvP domain, types, digest, consent sign/verify** — `cfea4f5` (test RED), `cacb90a` (feat GREEN)
2. **Task 2: unionParticipants, rateConsistent, buildPvPProposal, verifyPvPProposal + barrel** — `cb7976e` (test RED), `e90ca9b` (feat GREEN)

## TDD Gate Compliance

Both tasks followed RED → GREEN: failing tests committed first (module/exports missing, 11 failures observed for Task 2 RED), implementation committed second. No refactor commits needed.

## Files Created/Modified
- `src/pvp.ts` - PvPRound digest, consent sign/verify, union merge, rate check, bundle build + participant-side verification
- `src/domain.ts` - `pvpDomain(router, chainId)` + `PVP_TYPES` (field order: usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator) with canonical typehash doc comment
- `src/types.ts` - `PvPProposal` interface (two `RoundProposal` legs + fxNumerator/fxDenominator + digest)
- `src/index.ts` - `export * from "./pvp.js"` inserted after creditCap, before client (dependency order)
- `test/pvp.test.ts` - 17 tests: digest determinism/sensitivity/domain-binding, consent roundtrip + wrong-signer + tamper, union merge unit + fast-check property, rateConsistent fast-check property, zero-rate throws, verifyPvPProposal accept + 5-way reject matrix incl. per-leg WR-06 passthrough

## Decisions Made
- `signPvPConsent` throws the exact `round.ts` message `"account cannot sign typed data"` (no address interpolation) — the plan's behavior block specified this string and it matches the existing convention verbatim
- Per-leg verifyProposal opts modeled as a module-private `LegVerifyOpts` interface (includes `redeemedIds`/`excluded` beyond the four fields the plan listed, since they are part of verifyProposal's opts surface and the passthrough should be complete)
- FX-pair checks iterate the caller's IOU lists (not consumedIds) per the plan's shared-ref specification; refs appearing on only one hub are ignored (non-FX flows)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Known Stubs
None — all exported functions are fully wired and tested; no placeholder values or unwired data paths.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 04-02 (parallel, same wave) can rely on the typehash string and domain name being byte-identical to this plan's `src/domain.ts`/`src/pvp.ts` doc comments
- Plan 04-03's parity fixture has everything it needs: `pvpDigest` + `signPvPConsent` are exported through the barrel
- Demo plans (04-04/04-05) get `verifyPvPProposal` with per-leg WR-06 opts already generalized

## Self-Check: PASSED

All claimed files exist (src/pvp.ts, src/domain.ts, src/types.ts, src/index.ts, test/pvp.test.ts); all four task commits (cfea4f5, cacb90a, cb7976e, e90ca9b) verified in git log.

---
*Phase: 04-cross-currency-pvp-rounds-brief-phase-6*
*Completed: 2026-07-24*
