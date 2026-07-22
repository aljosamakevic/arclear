---
phase: 01-threshold-consent-brief-phase-0
plan: 03
subsystem: coordinator
tags: [typescript, viem, fast-check, vitest, eip712, consent, state-machine]

# Dependency graph
requires:
  - phase: 01-threshold-consent-brief-phase-0 (plan 01)
    provides: rebuildProposal + excluded-aware verifyProposal in src/round.ts
provides:
  - collectConsents: wall-clock consent window with deterministic timeout snapshot (CONS-01, D-02)
  - applyMissSemantics: pure D-06/D-07 miss-counter helper (timeout++, consent reset, refusal unchanged)
  - attemptRound: chain-free two-pass exclude-and-recompute driver with structured settled/aborted/empty outcomes
  - Coordinator.runRound returns { outcome } instead of throwing; new phases rebuilding/collecting-consents-pass-2/aborted
  - ExecutedRound extended with excluded[] + passCount; state() serializes stall + miss info
  - AgentPersona.stalled failure-injection flag (D-13)
  - Invariant test suite pinning CONS-03/CONS-04, quorum floor (D-01), pass-2 abort (D-03)
affects: [01-04 (server/dashboard stall toggle + /round handler), 01-05 (griefing docs), phase-2 (miss counters feed redeemIOU flagging)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Consent-provider seam: per-member async provider; stall = never-resolving promise, refusal = data"
    - "Snapshot-then-ignore deadline: one shared setTimeout per pass, clearTimeout on early completion, unref, settled flag"
    - "Chain-free state-machine core with injected submit callback; caller owns all side effects"

key-files:
  created: []
  modified:
    - demo/coordinator.ts
    - demo/agents.ts
    - test/rebuild.test.ts
    - demo/e2e.ts
    - demo/server.ts

key-decisions:
  - "attemptRound returns pass1 ConsentCollection in settled/aborted variants so the caller applies miss semantics from the pass-1 snapshot only"
  - "Quorum abort reports passCount 1 (one collection pass performed); pass-2 stall/refusal abort reports passCount 2"
  - "WrongRoundNonce submit revert maps to a clean aborted outcome with passCount 0 (nonce race — pass context unavailable in catch)"
  - "Provider reads persona.stalled at call time so a mid-flight toggle takes effect on the next pass"

patterns-established:
  - "ConsentProvider: (proposal, excluded) => Promise<ConsentOutcome> — timeout is the coordinator's deadline, never a provider outcome"
  - "Structured RunRoundResult discriminated on outcome; HTTP 500 reserved for genuine faults"

requirements-completed: [CONS-01, CONS-02, CONS-03, CONS-04]

# Metrics
duration: 8min
completed: 2026-07-22
---

# Phase 1 Plan 03: Two-Pass Consent State Machine Summary

**Coordinator.runRound is now a two-pass exclude-and-recompute state machine: wall-clock consent windows with deterministic timeout snapshots, same-nonce rebuild over the consenting subset, clean structured aborts, and D-06/D-07 miss counters — pinned by fast-check properties with real EIP-712 signatures.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-22T14:44:54Z
- **Completed:** 2026-07-22T14:53:01Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- `collectConsents` races every participant's provider against ONE shared deadline timer; the {consents, refused, timedOut} partition is snapshotted immutably when it fires and late resolutions are ignored (CONS-01, D-02); timer cleared/unref'd — vitest exits with no open-handle warnings
- `attemptRound` chain-free core: pass-1 unanimity submits directly; otherwise timeouts∪refusals are excluded in one batch, the round rebuilds over the SAME roundNonce, quorum floor ≥2 is enforced (D-01), and pass 2 collects fresh signatures — any pass-2 stall/refusal aborts with nothing settled and a hard 2-pass cap (D-03); pass-1 signatures never carry over (T-01-10)
- Refusal is data end-to-end: the line-85 throw-on-refusal is gone; honest providers fold the excluded list into `verifyProposal` local recomputation (Plan 01 seam exercised end-to-end)
- CONS-03 property (25 runs, real repeated-byte-key accounts): every submission is index-aligned unanimously signed over the submitted digest under arbitrary stall/refusal subsets; aborts never call submit and never touch settledIds
- CONS-04 sequence test: a stalled member's IOUs are absent from manifest n, settle in manifest n+1, and consumed-id sets of any two settled rounds are disjoint

## Task Commits

Each task was committed atomically:

1. **Task 1: collectConsents seam + miss semantics + stall flag** — `e0c260c` (test, RED) → `b809721` (feat, GREEN)
2. **Task 2: two-pass attemptRound driver + Coordinator integration** — `9e6f280` (feat)
3. **Task 3: state-machine invariant properties** — `409500f` (test)

## Files Created/Modified
- `demo/coordinator.ts` — ConsentOutcome/ConsentProvider/ConsentCollection types, collectConsents, applyMissSemantics, attemptRound, RoundAttemptOutcome/RunRoundResult, reworked runRound (miss counters, consentWindowMs default 30s with per-call override, new phases, extended ExecutedRound, stall/miss state serialization)
- `demo/agents.ts` — AgentPersona gains mutable `stalled: boolean` (default false, D-13)
- `test/rebuild.test.ts` — +10 tests/properties: consent-window suite (5) and two-pass state-machine suite (5); 690 lines total
- `demo/e2e.ts` — adapted to structured runRound result (fails fast on non-settled outcome)
- `demo/server.ts` — /round returns the structured outcome; aborts are 200s, not 500s (Pitfall 6; Plan 04 wires the dashboard view)

## Decisions Made
- attemptRound exposes the pass-1 `ConsentCollection` in its settled/aborted variants so the coordinator applies miss semantics from the pass-1 snapshot only (pass-2 aborts still record pass-1 timeouts; refusals never counted)
- Quorum aborts report `passCount: 1` (one signature-collection pass actually ran); pass-2 aborts report 2; the WrongRoundNonce catch path reports 0 since pass context is unavailable there
- `RunRoundResult` includes an `empty` variant (nothing to net) rather than overloading `aborted` — the old throw is gone

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Adapted runRound call sites in demo/e2e.ts and demo/server.ts**
- **Found during:** Task 2 (runRound return type changed from `ExecutedRound` to `RunRoundResult`)
- **Issue:** Both files consumed the old return value directly; `npx tsc --noEmit` (a task acceptance criterion) would fail without touching them, but they were not in the plan's `files_modified`
- **Fix:** Minimal adaptations only — e2e exits with FAIL on non-settled outcomes; /round serializes the structured result and only prints the report when settled. Full handler/dashboard work stays in Plan 04
- **Files modified:** demo/e2e.ts, demo/server.ts
- **Verification:** `npx tsc --noEmit` exits 0; full `npm test` green
- **Committed in:** 9e6f280 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for the type-check gate; no scope creep — Plan 04 still owns the /round handler and dashboard surface.

## Issues Encountered
None.

## Known Stubs
None — no placeholder values or unwired data paths introduced.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 04 can wire the stall-toggle endpoint against `persona.stalled` (read at provider-call time, so toggles take effect immediately) and render `state().missed` / per-agent `stalled`/`missedWindows` plus `ExecutedRound.excluded`/`passCount`
- Plan 05's griefing analysis has its evidence: quorum/abort/disjoint-manifest invariants are pinned in test/rebuild.test.ts
- Wave gate green: `npm test` (38 tests) + `npm run test:contracts` (27 tests) + `npx tsc --noEmit`

## Self-Check: PASSED

- All modified files present (demo/coordinator.ts, demo/agents.ts, test/rebuild.test.ts, demo/e2e.ts, demo/server.ts)
- All task commits verified in git log (e0c260c, b809721, 9e6f280, 409500f)
- Working tree clean; `npm test` (38) + `npm run test:contracts` (27) + `npx tsc --noEmit` all green

---
*Phase: 01-threshold-consent-brief-phase-0*
*Completed: 2026-07-22*
