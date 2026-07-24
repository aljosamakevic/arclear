---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 05
subsystem: demo-pvp-orchestration
tags: [demo, coordinator, orchestration, anvil, fx, pvp, wr-01, wr-02]

# Dependency graph
requires:
  - phase: 04-01
    provides: buildPvPProposal/verifyPvPProposal/signPvPConsent/verifyPvPConsent/unionParticipants/rateConsistent consumed by the demo orchestration
  - phase: 04-04
    provides: PvPRouterClient (formula-gas executePvP) + pvpRouterAbi/pvpRouterBytecode for the anvil router deploy
  - phase: 01-consent-machinery (v2)
    provides: collectConsents/screenConsents/rebuildProposal/attemptRound machinery generalized (screenConsents reused directly per leg)
provides:
  - "demo/setup.ts dual-hub world: two mock tokens, two ClearingHubV2s, one PvPRouter bound to both on anvil; HUB_V2_EURC + PVP_ROUTER env on testnet"
  - "demo/fx.ts: FxQuote amount-pair mirror of the arc-stablecoin-fx App Kit quote shape (D-06 fallback) + quoteToRate + deterministic sampleQuote"
  - "demo/pvp.ts: fxTradePair, attemptPvPRound (chain-free two-pass PvP consent state machine), runPvPRound (chain-aware WR-01/WR-02 wrapper)"
  - "Coordinator.hold/release in-flight guard + ExecutedRound.pvp rate tag flowing through existing /state (D-12)"
affects: [04-06 e2e scenario + testnet deploy, 04-07 docs]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PvP consent fold (D-08): ONE provider call per union member returns leg consent(s) + PvPRound signature; screening reuses single-hub screenConsents per leg then verifies the bundle signature"
    - "Structured abort stage (quorum|consent|submit) on PvPAttemptOutcome so the wrapper classifies submit failures from chain nonces without ever parsing reason strings (WR-02)"
    - "PvPLegState structural interface: Coordinator satisfies it as-is — the wrapper composes two per-hub state surfaces without new authority (Pitfall 3)"

key-files:
  created: [demo/fx.ts, demo/pvp.ts, test/pvpRound.test.ts]
  modified: [demo/setup.ts, .env.example, demo/agents.ts, demo/coordinator.ts]

key-decisions:
  - "attemptPvPRound aborted outcome carries a structured `stage` field — the mechanism that makes nonce-only failure classification possible without error-string matching"
  - "fxTradePair derives the EURC amount with a guarded bigint quotient used ONLY as an amount constructor; the D-04 cross-multiplication check rejects any inexact input, keeping protocol math division-free"
  - "Pass-2 full recollection chosen over the unchanged-leg-consent optimization (RESEARCH open question 2) — why-comment at the rebuild site"
  - "runPvPRound exposes WR-01 pending records via an onPending hook (observable ordering proof in tests + reconciliation handle for integrators)"

patterns-established:
  - "D-09 simplest safe rule implemented: any pass-1 timeout/refusal by a union member excludes them from BOTH legs in one batch; both legs rebuild at unchanged per-hub nonces"
  - "Hold-based cross-hub concurrency guard: runPvPRound holds both coordinators for the bundle lifetime; runRound refuses as blocked-style data before any chain I/O"

requirements-completed: [PVP-01, PVP-02]

# Metrics
duration: ~18min
completed: 2026-07-24
---

# Phase 4 Plan 05: PvP Demo Orchestration Summary

**Dual-hub demo world (two tokens, two hubs, one router on anvil; HUB_V2_EURC/PVP_ROUTER env on testnet) plus the full PvP coordinator path: arc-stablecoin-fx amount-pair quote mirror, fxTradePair shared-ref FX trades, the chain-free two-pass attemptPvPRound state machine (D-07/D-08/D-09), and the chain-aware runPvPRound wrapper carrying WR-01/WR-02 discipline across both hubs — 15 new vitest tests, all chain-free.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-07-24T16:00:18Z
- **Completed:** 2026-07-24T16:18:31Z
- **Tasks:** 3 (Tasks 2 and 3 TDD)
- **Files modified:** 7

## Accomplishments

- `demo/setup.ts` genuinely dual-hub (RESEARCH-corrected: it deployed ONE hub before): setupAnvil deploys two mock tokens, two ClearingHubV2s with identical UNCALIBRATED args, and a PvPRouter with `args: [hubUsdc, hubEurc]` via `pvpRouterBytecode`; mints both tokens to every agent and deposits collateral on BOTH hubs; smoke verified on anvil — router immutables read back match the deployed hub pair and every agent has nonzero collateral on both hubs ("dual-hub bootstrap OK")
- Testnet mode reads `HUB_V2_EURC` and `PVP_ROUTER` with actionable error messages naming the missing key and the fix; `PVP_ROUTER=` documented in `.env.example`
- `demo/fx.ts`: `FxQuote { amountIn, amountOut, timestamp }` mirroring the arc-stablecoin-fx App Kit `estimateSwap` amount-pair quote shape with the D-06 fallback documented in the doc comment; `quoteToRate` is a pure relabeling (no division); `sampleQuote` deterministic near 0.989589 EURC/USDC in 6-decimal base units
- `attemptPvPRound` (chain-free, submit-injected): one provider call per union member per pass folding leg consent(s) + PvPRound signature (D-08); CR-01 screening generalized — leg consents screened by REUSING the coordinator's `screenConsents` per hub, PvPRound signatures via `verifyPvPConsent`, any invalid demoted to refusal; pass-1 non-responders/refusers excluded from BOTH legs in one batch (D-09), both legs rebuilt via `rebuildProposal` at unchanged per-hub nonces, full pass-2 recollection (optimization deliberately skipped, why-comment present), hard 2-pass cap; never throws for any tested input — all failures are outcome data with a structured `stage`
- `runPvPRound` (chain-aware, fully fake-able deps): holds BOTH coordinators for the bundle lifetime, records WR-01 pending state for both hubs BEFORE broadcasting (proven by the fake submit observing the onPending record), classifies failed submissions from both chains' nonces only — moved nonce → `blocked` as data, unmoved → `aborted`; `grep -c 'message.includes\|toMatch(/Wrong' demo/pvp.ts` = 0
- Settled PvP rounds appear in BOTH coordinators' rounds lists tagged `pvp: { fxNumerator, fxDenominator }`, each hub's settledIds absorbing ONLY its own leg's consumedIds (Pitfall 3); the tag flows through the existing `/state` serialization — `demo/server.ts` untouched (D-12)
- Suites: 15/15 pvpRound tests, full vitest 116/116 (was 111), `tsc --noEmit` clean; no coordinator regression (screenConsents, pendingSubmission reconciliation, miss counters, redeemedIds fold all untouched in behavior)

## Task Commits

1. **Task 1: Dual-hub + router bootstrap + FX personas** — `9f87a8e` (feat)
2. **Task 2: FX quote mirror + attemptPvPRound chain-free core** — `73b23fa` (test RED), `4dc8382` (feat GREEN)
3. **Task 3: runPvPRound wrapper + coordinator in-flight guard** — `e82fdc0` (test RED), `35fa178` (feat GREEN)

## TDD Gate Compliance

Tasks 2 and 3 followed RED → GREEN: failing tests committed first (Task 2 RED: module-not-found on demo/fx.js; Task 3 RED: 5 failures — runPvPRound/hold missing), implementations committed second. No refactor commits needed.

## Files Created/Modified

- `demo/setup.ts` - dual-hub + router anvil bootstrap, per-(token,hub) depositAll, HUB_V2_EURC/PVP_ROUTER testnet env guards, extended DemoEnv with per-field doc comments
- `.env.example` - `PVP_ROUTER=` under the V2 section with a one-line comment
- `demo/agents.ts` - Oracle and Trader designated as the EURC↔USDC FX traders (index 0 reserved, `stalled` untouched)
- `demo/fx.ts` - FxQuote amount-pair mirror (D-06 fallback documented), quoteToRate, sampleQuote
- `demo/pvp.ts` - fxTradePair, collectPvPConsents (D-02 snapshot + WR-05 microtask routing), screenPvPConsents, attemptPvPRound, PvPLegState/PvPRunDeps, runPvPRound
- `demo/coordinator.ts` - `hold(reason)`/`release()` + held-check at the top of runRound (before any chain I/O); `ExecutedRound.pvp?` optional rate tag
- `test/pvpRound.test.ts` - 15 tests: quote mirror (2), fxTradePair (2), attemptPvPRound behavior matrix (6), runPvPRound wrapper + hold (5); fake providers with deterministic accounts, recording fake submit, no anvil

## Decisions Made

- **`now: bigint` added to attemptPvPRound args:** the plan's argument sketch omitted it, but `net()` requires `now` for expiry filtering — required for correctness, mirrors `attemptRound`
- **Structured `stage` on the aborted outcome (`"quorum" | "consent" | "submit"`):** the wrapper must know a failure came from submission to trigger nonce classification; carrying it as data (plus `pass1` for refusal observability) is what satisfies the "never error-string-match" acceptance criterion mechanically
- **fxTradePair opts extended with `hubUsdc`/`hubEurc`/`chainId`/`now`:** the plan's sketch listed only `{nonces, expiry}`, but signing "against the correct hub domains" requires the hub addresses, and `signIou`'s L-convention check requires `now`
- **EURC amount construction:** one guarded bigint quotient as a constructor, immediately validated by `rateConsistent` cross-multiplication which throws for any usdcAmount without an exact EURC counterpart — protocol math (the check) stays division-free per the project constraint
- **`depositAll` re-parameterized** to take an explicit `{token, hub}` target instead of reading them off the env object — one call per hub pair keeps per-hub state separation structural
- **Testnet EURC funding deferred to 04-06:** setupTestnet constructs `hubClientEurc`/`routerClient` and derives `tokenEurc` per the plan; agent EURC top-up/deposit is the deploy-phase e2e:testnet concern (EURC is a plain ERC-20, not the gas token) — noted in a code comment

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] `now` parameter added to attemptPvPRound**
- **Found during:** Task 2
- **Issue:** the plan's argument sketch for attemptPvPRound had no `now`, but `net()` (called per leg) requires it — without it the legs cannot be built
- **Fix:** `now: bigint` added to the args object, threaded into per-leg net/rebuild opts
- **Files modified:** demo/pvp.ts, test/pvpRound.test.ts
- **Commit:** `4dc8382`

All other differences from the plan's sketches (stage field, fxTradePair opts, pass1 on outcomes) are additive interface completions documented under Decisions Made; the behavior list executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None — every export is fully wired and unit-tested; no placeholder values or unwired data paths. (`runPvPRound`'s receipt-transport-failure residual is documented in its doc comment with the reconciliation handle exposed via `onPending`; the nonce-only classification is the planned D-09/Pitfall-4 behavior, not a stub.)

## Threat Flags

None — no security surface beyond the plan's threat model. T-04-19 (zero-authority: hold can only prevent assembly, never forge), T-04-20 (leg signatures published only inside the router submit; `finalize` passes them exclusively to the injected submit), T-04-21 (in-flight hold + WR-01 pendings + nonce classification), T-04-22 (verifyPvPProposal cross-multiplication in every honest provider), T-04-23 (per-hub settledIds folds, disjointness unit-tested) all carry their planned mitigations.

## User Setup Required

None for anvil. Testnet PvP runs will need `HUB_V2_EURC` and `PVP_ROUTER` set after the 04-06 deploy (error messages point to the README).

## Next Phase Readiness

- 04-06 (e2e) composes `setup("anvil")` → `fxTradePair`/simulated traffic → `runPvPRound` with two Coordinators as leg states; both-or-neither positive/negative scenarios have every hook they need (recording submit for sabotage, hold observability, per-hub settledIds assertions)
- The measured-gas `PvPRouterClient.executePvP` from 04-04 is the production submit; the fake-submit seam is identical in shape
- Dashboard PvP badge (if 04-06/04-07 adds one) reads `rounds[].pvp` from the existing `/state` payload — no server change needed

## Self-Check: PASSED

All claimed files exist (demo/fx.ts, demo/pvp.ts, test/pvpRound.test.ts, demo/setup.ts, .env.example, demo/agents.ts, demo/coordinator.ts); all five task commits (9f87a8e, 73b23fa, 4dc8382, e82fdc0, 35fa178) verified in git log on the worktree branch.

---
*Phase: 04-cross-currency-pvp-rounds-brief-phase-6*
*Completed: 2026-07-24*
