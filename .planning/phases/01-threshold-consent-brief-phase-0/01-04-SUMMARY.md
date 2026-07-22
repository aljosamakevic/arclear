---
phase: 01-threshold-consent-brief-phase-0
plan: 04
subsystem: demo
tags: [viem, anvil, http, dashboard, e2e, threshold-consent]

# Dependency graph
requires:
  - phase: 01-threshold-consent-brief-phase-0 (plan 01-02)
    provides: "src/abi/ClearingHubV2.ts — clearingHubV2Abi + clearingHubV2Bytecode"
  - phase: 01-threshold-consent-brief-phase-0 (plan 01-03)
    provides: "Coordinator structured runRound outcome, stall flags, miss counters, two-pass attemptRound"
provides:
  - "Anvil bootstrap deploys genuine ClearingHubV2 bytecode (Pitfall 2 closed end-to-end)"
  - "POST /stall?agent=Name toggle — failure injection distinguishable from refusal-for-cause (D-13)"
  - "Abort-aware POST /round: settled AND aborted are 200-structured outcomes (Pitfall 6)"
  - "Dashboard renders rebuild phases, stall toggles, miss counters, and exclusion-round history (D-14)"
  - "e2e liveness proof: stall → exclusion round settles → excluded paper settles next round → never twice (D-15, CONS-04)"
affects: [02-margin, ccp-demo, dashboard, e2e]

# Tech tracking
tech-stack:
  added: []
  patterns: ["metadata-tail bytecode assertion (compare last 53 CBOR bytes of eth_getCode vs creation bytecode)", "shared per-pair nonce map threaded through every simulateTraffic batch to keep IOU ids unique"]

key-files:
  created: []
  modified: [demo/setup.ts, demo/server.ts, public/dashboard.html, demo/e2e.ts]

key-decisions:
  - "Testnet mode reads HUB_V2_USDC with a throw-if-missing guard; HUB_USDC stays reserved for the live v1 Net product"
  - "/stall follows the server's URL-only convention (searchParams, no body parsing); unknown agent -> 404"
  - "Bytecode genuineness proven via the 53-byte CBOR metadata tail shared by creation and runtime code — immutable slots make full-suffix comparison impossible"
  - "e2e derives per-round consumed manifests as settledIds set-diffs, avoiding any Coordinator interface change (files stayed within plan scope)"

patterns-established:
  - "Failure injection surface: persona.stalled flipped over HTTP, observed via /state, rendered by dashboard"
  - "e2e check(cond, label) counter pattern: every assertion logs ✓/✗, exit(1) if any failed"

requirements-completed: [CONS-01, CONS-04]

# Metrics
duration: ~12min
completed: 2026-07-22
---

# Phase 1 Plan 04: Demo Surface & Liveness E2E Summary

**Anvil demo now runs genuine V2 bytecode with an HTTP stall toggle, abort-aware rounds, exclusion-history dashboard, and a green e2e proving stall → exclude-and-settle → re-settle → never twice**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-22T14:56:54Z
- **Completed:** 2026-07-22T15:08:30Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- `npm run e2e:anvil` proves the phase's core value end-to-end: Oracle stalls, round n settles in 2 passes without them (delta exactly 0n, 16 IOU ids untouched), round n+1 settles all 16 excluded ids, manifests disjoint (CONS-04)
- Anvil bootstrap deploys `clearingHubV2Bytecode`; e2e asserts the deployed code's CBOR metadata tail matches V2 and differs from v1 (Pitfall 2 closed)
- `POST /stall?agent=Name` flips a persona's stall flag over HTTP; `/state` carries stall flags + miss counters; aborted rounds return 200-structured JSON, 500 reserved for genuine faults (Pitfall 6)
- Dashboard shows rebuild/pass-2/aborted phases, per-agent stall toggle buttons with 💤 + missed-window badges, and Pass/Excluded columns in round history (D-13/D-14)

## Task Commits

Each task was committed atomically:

1. **Task 1: V2 bytecode bootstrap + /stall + abort-aware /round** - `414b38a` (feat)
2. **Task 2: Dashboard stall toggles, phase labels, exclusion history** - `43a6e66` (feat)
3. **Task 3: E2E liveness scenario** - `a306300` (feat)

## Files Created/Modified
- `demo/setup.ts` - Imports `clearingHubV2Abi`/`clearingHubV2Bytecode`; anvil deploys V2; testnet reads `HUB_V2_USDC` (v1 keys untouched); explicit-gas discipline preserved
- `demo/server.ts` - `POST /stall?agent=Name` toggle (URL-only, 404 on unknown); `/state` gains top-level `stalls` map; `/round` returns 200 for settled and aborted
- `public/dashboard.html` - Phase-label entries for `rebuilding`/`collecting-consents-pass-2`/`aborted`; per-agent stall buttons wired to `/stall`; rounds table Pass + Excluded columns; still a single static file, no new external deps
- `demo/e2e.ts` - Baseline round + D-15 liveness scenario with bytecode assertion, shared nonce map, far-future staller IOUs (Pitfall 5), consumed-manifest set-diff assertions, failure counter with exit(1)

## Decisions Made
- Consumed manifests per round derived as `settledIds` before/after set-diffs in e2e — keeps `ExecutedRound` unchanged and the plan's file scope intact
- Bytecode assertion compares the last 106 hex chars (53-byte CBOR metadata) of `eth_getCode` against creation bytecode: identical between creation/runtime code, unique per source, immune to immutable-slot patching; strict assert on anvil, warn-only on testnet
- A shared per-pair nonce `Map` is threaded through both `simulateTraffic` batches and the explicit staller IOUs — a second fresh map would regenerate identical (pair, nonce) ids already in `settledIds` and silently drop them
- Short `consentWindowMs` (2000ms) passed per-round via the existing `runRound(now, windowMs)` param, keeping the stall round fast without touching the Coordinator default

## Deviations from Plan

None - plan executed exactly as written. (The `/round` abort-aware handler was already in place from plan 01-03's minimal call-site adaptation; Task 1 verified it against the acceptance criteria rather than rewriting it.)

## Issues Encountered
None. `anvil`/`forge` needed `$HOME/.foundry/bin` on PATH for the e2e run — toolchain was present locally.

## Verification Evidence
- `npm run e2e:anvil` — exit 0; all liveness assertions logged ✓ (round n: passCount 2, Oracle excluded, Δ 0n, 16 ids absent; round n+1: 16 ids consumed, manifests disjoint; per-agent deltas match engine to the base unit across all three rounds)
- `npm test` — 38 passed (3 files)
- `npm run test:contracts` — 27 passed (4 suites, incl. 512-run fuzz)
- `npx tsc --noEmit` — exit 0

## Known Stubs
None — every surface added in this plan is wired to live data (personas, coordinator state, on-chain reads).

## Threat Flags
None — the new `/stall` endpoint and `/state` telemetry are exactly the surfaces registered in the plan's threat model (T-01-15 accept, T-01-17 accept); no unregistered network/auth/file surface introduced.

## User Setup Required
None for anvil. For `npm run e2e:testnet` / `npm run demo` (testnet): set `HUB_V2_USDC` in `.env` after deploying `ClearingHubV2` via `contracts/script/DeployV2.s.sol` (v1 `HUB_USDC` remains for Arclear Net).

## Next Phase Readiness
- Phase 1 demo surface complete: a reviewer can stall any agent from the dashboard and watch the exclusion round happen live
- CONS-01 and CONS-04 demonstrated end-to-end on V2 bytecode; margin/waterfall phases can build on the structured outcome + stall-injection surfaces

## Self-Check: PASSED

- All 4 modified files present on disk
- Task commits 414b38a, 43a6e66, a306300 all found in git log
- `npm run e2e:anvil`, `npm test`, `npm run test:contracts`, `npx tsc --noEmit` all green

---
*Phase: 01-threshold-consent-brief-phase-0*
*Completed: 2026-07-22*
