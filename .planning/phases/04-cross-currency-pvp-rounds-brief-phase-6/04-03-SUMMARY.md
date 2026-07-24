---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 03
subsystem: testing-parity
tags: [fixtures, eip712, parity, foundry, vitest, pvp-02, d-05]

# Dependency graph
requires:
  - phase: 04-01
    provides: pvpDigest/buildPvPProposal/signPvPConsent/verifyPvPConsent through the barrel (src/pvp.ts)
  - phase: 04-02
    provides: PvPRouter.sol canonical typehash + hashPvPRound public view, constructor(hubUSDC_, hubEURC_) immutables
provides:
  - "pvp_* flat keys in test/fixtures/digest.json: pvpHubUsdc, pvpHubEurc, pvpRouter, pvpUsdcLegDigest, pvpEurcLegDigest, pvpFxNumerator, pvpFxDenominator, pvpDigest, pvpSigner0, pvpConsent0"
  - "TS fixture lock: test/pvp.test.ts 'shared fixture parity (D-05)' recomputes pvpDigest + verifies pvpConsent0"
  - "Solidity fixture lock: contracts/test/PvPParity.t.sol asserts hashPvPRound digest equality + ECDSA recovery over the same vector"
affects:
  - "04-04 (revert matrix can trust the digest path is parity-locked)"
  - "04-05/04-06 (coordinator/client sign against a digest provably identical to the chain's)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "pvp keys inserted mid-object (before iou_* group) so fixture regeneration is purely additive in the JSON diff"
    - "deployCodeTo with abi.encode'd hub-pair constructor args — immutables set at the fixture router address, no hub code required"

key-files:
  created: [contracts/test/PvPParity.t.sol]
  modified: [test/genFixture.ts, test/fixtures/digest.json, test/pvp.test.ts]

key-decisions:
  - "USDC leg reuses the fixture's existing round proposal (already built against HUB = pvpHubUsdc) — zero new signing paths for that leg"
  - "EURC leg reuses the same participant trio with IOU nonce 2 against the all-2s hub address, guaranteeing a distinct leg digest"
  - "pvp_* keys placed before the iou_* group in the fixture object so regeneration never rewrites a pre-existing line (trailing-comma hazard)"

requirements-completed: [PVP-02]

# Metrics
duration: 5min
completed: 2026-07-24
---

# Phase 4 Plan 03: PvPRound Shared Fixture + Cross-Stack Parity Summary

**D-05 satisfied for the PvPRound struct: one regenerated fixture vector (rate 989589/1000000, router at 0x33…33) locked on both stacks — vitest recomputes pvpDigest and verifies the consent off-chain, PvPParity.t.sol reproduces the digest via hashPvPRound and recovers the same viem signature via OZ ECDSA on-chain**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-07-24T15:45:47Z
- **Completed:** 2026-07-24T15:51:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- `test/genFixture.ts` emits ten `pvp_*` flat keys: fixture hub pair (0x11…11 / 0x22…22), router (0x33…33), both leg digests (USDC leg = the existing fixture round; EURC leg = same trio, nonce 2, EURC hub domain), the App-Kit-shaped rate pair `989589/1000000`, `pvpDigest`, and the sorted-first account's consent
- Regeneration is byte-stable and purely additive: `git diff test/fixtures/digest.json` after `npm run fixture` shows 10 added lines only — every pre-existing digest/merkle key byte-identical; second regeneration produces an empty diff
- `test/pvp.test.ts` gained the fixture-lock test (18 tests total): recomputes `pvpDigest` from the raw fixture values at chainId 5042002 and asserts `verifyPvPConsent(pvpSigner0, pvpConsent0)` — TS side locked
- `contracts/test/PvPParity.t.sol` (56 lines) deployCodeTo's the real `PvPRouter` at the fixture address with the fixture hub pair as constructor args, then asserts (1) `hashPvPRound(...) == pvpDigest` with a failure message naming D-05, (2) `ECDSA.recover(digest, pvpConsent0) == pvpSigner0` — Solidity side locked
- Full regression: 101/101 vitest, 86/86 forge (9 suites), `tsc --noEmit` clean

## Task Commits

1. **Task 1: genFixture pvp_* keys + regeneration + TS fixture lock** — `f087c9a` (test)
2. **Task 2: PvPParity.t.sol — Solidity side of the D-05 lock** — `3300b06` (test)

## Files Created/Modified
- `test/genFixture.ts` - pvp section: hub/router constants, EURC leg via buildProposal, buildPvPProposal + signPvPConsent, ten flat keys in the fixture object
- `test/fixtures/digest.json` - regenerated (never hand-edited); pvp keys added, all pre-existing keys untouched
- `test/pvp.test.ts` - "shared fixture parity (D-05)" describe block; node:fs/path/url imports added
- `contracts/test/PvPParity.t.sol` - deployCodeTo parity test: digest equality + signature recovery, all vectors from digest.json (zero hardcoded 32-byte hex literals)

## Decisions Made
- pvp keys inserted **before** the `iou_*` group in the fixture object: appending at the end would rewrite the current last JSON line to gain a trailing comma, breaking the plan's "only additions in the diff" gate — mid-object insertion keeps regeneration purely additive
- USDC leg is the fixture's existing round proposal verbatim (it was already built against HUB = pvpHubUsdc), so `pvpUsdcLegDigest == digest` by construction — one fewer signing path, same parity coverage
- EURC leg digest differentiation via both a distinct IOU nonce (2) and the EURC hub domain, per the plan's belt-and-suspenders instruction

## Deviations from Plan

None - plan executed exactly as written. (The mid-object key placement is an implementation detail chosen to satisfy the plan's own additive-diff gate, not a deviation from it.)

## Threat Flags

None — no new security surface beyond the plan's threat model; both new tests mitigate T-04-12/T-04-13/T-04-14 as registered.

## Known Stubs
None — both parity locks are fully wired against real implementations (viem hashTypedData/signTypedData vs PvPRouter.hashPvPRound/OZ ECDSA).

## User Setup Required
None.

## Next Phase Readiness
- 04-04's revert matrix can rely on the digest path being parity-locked: any `BadPvPSignature` it observes is a genuine signature problem, never encoding drift
- 04-05/04-06 (coordinator + client) sign PvPRound consents against a digest provably identical to the chain's
- Typehash/domain drift between `src/pvp.ts`/`src/domain.ts` and `PvPRouter.sol` now breaks CI-visible tests on both stacks (Pitfall 5 closed)

## Self-Check: PASSED

- test/genFixture.ts (pvpDigest present) — FOUND
- test/fixtures/digest.json (pvpRouter present) — FOUND
- contracts/test/PvPParity.t.sol (56 lines ≥ 40, readFile digest.json, deployCodeTo) — FOUND
- Commits f087c9a, 3300b06 — FOUND on worktree branch

---
*Phase: 04-cross-currency-pvp-rounds-brief-phase-6*
*Completed: 2026-07-24*
