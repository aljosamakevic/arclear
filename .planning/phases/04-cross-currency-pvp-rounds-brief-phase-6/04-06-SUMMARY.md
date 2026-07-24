---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 06
subsystem: e2e-pvp-proof
tags: [e2e, anvil, pvp, both-or-neither, dashboard, d-11, d-12, pitfall-7]

# Dependency graph
requires:
  - phase: 04-05
    provides: runPvPRound/attemptPvPRound/fxTradePair/sampleQuote + dual-hub anvil bootstrap (two hubs, one router, both tokens funded/deposited) + ExecutedRound.pvp rate tag
  - phase: 04-04
    provides: PvPRouterClient.executePvP (formula gas) — called directly for the forced-revert variant
  - phase: 04-01
    provides: verifyPvPProposal/signPvPConsent used by the e2e's honest union-member providers
provides:
  - "demo/e2e.ts PvP scenario (anvil): positive atomic settlement with FX-exact per-persona balances on both hubs + measured gasUsed print (A3 record)"
  - "demo/e2e.ts negative (a): persistent FX-trader refusal → bundle aborts — nonces + full collateral maps asserted unchanged ON-CHAIN on both hubs"
  - "demo/e2e.ts negative (b): corrupted EURC leg signature submitted directly → mined status:reverted receipt, nothing settles on either hub"
  - "public/dashboard.html PvP badge column in the rounds table (D-12 bound: badge only, rate in cell title)"
affects: [04-07 docs, testnet deploy runbook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PvPView snapshot: one {openU, openE, nonceU, nonceE, at} capture per PvP attempt — every provider verifies against the SAME view the attempt nets from (WR-03 generalized to two hubs)"
    - "Map-equal collateral assertion (Pitfall 7): negative proofs compare full per-hub snapshots read fresh from chain, never coordinator state"
    - "Recording-submit capture: attemptPvPRound with a submit that records proposal+signatures without broadcasting — the seam for corrupting and replaying a bundle against the real router"

key-files:
  created: []
  modified: [demo/e2e.ts, public/dashboard.html]

key-decisions:
  - "PvP e2e scenario is anvil-gated: testnet EURC hub funding/deposits are the deploy-phase concern (04-05 note); e2e:testnet logs an explicit skip line"
  - "Negative (a) sabotage design: the saboteur refuses EVERY pass AND the EURC leg is FX-only, so the D-09 both-legs exclusion breaks EURC quorum — guaranteeing the abort instead of the liveness settle-without-them path"
  - "Signature corruption flips one nibble inside r: structurally valid signature, wrong recovered signer → deterministic BadSignature revert on the EURC hub, bubbled by the router"

patterns-established:
  - "Expected deltas recomputed by the e2e's own net() call per hub (independent of wrapper output), then asserted against on-chain collateral to the base unit on BOTH hubs"

requirements-completed: [PVP-01]

# Metrics
duration: ~9min
completed: 2026-07-24
---

# Phase 4 Plan 06: PvP e2e Both-or-Neither + Dashboard Badge Summary

**The phase's executable success criterion demonstrated on anvil: an atomic cross-currency PvP round settles both legs in one router tx with FX-exact per-persona balances (measured `pvp gasUsed=507442`), a sabotaged bundle settles NEITHER leg (proven from chain nonces + full collateral maps on both hubs), a corrupted-signature bundle mines with a `status: "reverted"` receipt leaving both hubs untouched — plus the D-12-bounded PvP badge in the dashboard rounds table.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-07-24T16:28:00Z
- **Completed:** 2026-07-24T16:37:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- **Positive (D-11 first half):** 2 FX trade pairs (Trader pays 3+2 USDC, Oracle pays the rate-exact 4.947945 EURC back at sampleQuote's 989589/1000000) mixed with ordinary non-FX IOUs on EACH hub (Crawler→Summarizer, Auditor→Crawler on USDC; Summarizer→Oracle, Trader→Auditor on EURC), exercising the Pitfall-6-safe design — rate checks per pair, never per delta. Asserted: both hub roundNonces advanced exactly 1; every persona's on-chain collateral delta equals the e2e's OWN local `net()` recomputation to the base unit on BOTH hubs (10 delta checks); router receipt success; both hubs' round records carry the `pvp` rate tag; single pass; router bytecode metadata-tail matches the local PvPRouter artifact
- **A3 gas record:** `[e2e] pvp gasUsed=507442` (this run; 507478/507490 on prior runs — varies a few units with calldata bytes). This is the live e2e-scale bundle (4+4 IOUs, warm collateral slots); the forge fresh-state worst case at full demo scale (105+105 ids) remains 1,734,897 from plan 04-04 — both far below any plausible block gas limit
- **Negative (a) — consent withheld (D-11 second half):** the Trader persona persistently refuses; the EURC leg is FX-only so the D-09 both-legs exclusion drops it below quorum → the whole bundle aborts even though the USDC leg was fully consentable. Asserted from CHAIN state (Pitfall 7): both roundNonces unchanged, both hubs' full per-persona collateral snapshots map-equal before/after — 5 check() lines
- **Negative (b) — forced on-chain revert (T-04-25):** attemptPvPRound with a recording submit captures a fully consented bundle without broadcasting; one EURC leg signature gets a nibble flipped in r and the bundle is submitted directly via `routerClient.executePvP` — the tx mines with `status: "reverted"` (BadSignature bubbled through the router on a real node), both nonces and both collateral maps unchanged — 6 check() lines
- **Dashboard (D-12):** rounds table gains a PvP column; rows with `r.pvp` render a badge (existing `.badge` CSS) with `fx rate num/den` in the cell title; no new panels, endpoints, or polling; `demo/server.ts` untouched (`git diff demo/server.ts` empty; grep gate = 5 ≥ 1)
- **Phase gate green:** 116/116 vitest, 101/101 forge, `npm run e2e:anvil` exit 0 with all pre-existing scenarios (baseline, liveness, redemption) unchanged; `tsc --noEmit` clean; no orphan anvil on 8545 after runs

## Task Commits

1. **Task 1: e2e PvP positive scenario — atomic settlement with FX-exact balances** — `0d46ef9` (feat)
2. **Task 2: e2e negative scenarios + dashboard PvP badge** — `cfa45e3` (feat)

## Files Created/Modified

- `demo/e2e.ts` - PvP scenario block (anvil-gated): EURC-hub Coordinator, per-hub snapshot/assertDeltas generalization (optional HubClient param, default preserves all existing call sites), `mapsEqual` helper, fxPair/ordinaryIou seeders continuing each hub's pair-nonce sequences, PvPView-snapshotted honest consent providers, positive + two negative variants, gasUsed print, updated PASS verdict line
- `public/dashboard.html` - PvP column in the rounds table (th + per-row badge cell, colspan 8→9)

## Decisions Made

- **Anvil gating:** the plan scopes the scenario to "the anvil e2e run"; on testnet the EURC hub has no agent deposits yet (deferred by 04-05 to the deploy phase), so the block is `mode === "anvil"`-gated with an explicit skip log — `e2e:testnet` keeps exiting 0 on the existing scenarios
- **Sabotage shape:** a lone pass-1 refusal normally just excludes the refuser (liveness, not sabotage). Making the EURC leg FX-only makes the FX trader structurally essential, so the exclusion breaks quorum and the bundle aborts at passCount 1 (stage `quorum`); the provider itself refuses unconditionally on every call, so the refusal is persistent regardless of pass
- **Expected deltas are independently recomputed** by the e2e via `net()` over the same open-IOU view (not read back from the wrapper's ExecutedRound), so the balance assertions cross-check the whole pipeline rather than echoing it

## Deviations from Plan

None - plan executed exactly as written (the anvil gating and quorum-break sabotage shape above are scoping/design choices inside the plan's stated bounds, documented for the record).

## Issues Encountered

None. Port 8545 was free before and after every run; no foreign anvil holders observed.

## Known Stubs

None — all new e2e paths assert against live chain state; the dashboard badge reads the already-serialized `rounds[].pvp` field (populated whenever a PvP round is folded into a coordinator; the demo server's single-hub `/round` endpoint simply never produces one, so the column shows "—" there, by D-12 design).

## Threat Flags

None — no new security surface beyond the plan's threat model. T-04-24 (vacuous negative) mitigated by on-chain nonce + map-equal collateral assertions on both hubs; T-04-25 (half-settle on a live node) mitigated by the mined `status: "reverted"` variant; T-04-26 (dashboard scope creep) mitigated: badge only, `demo/server.ts` diff empty.

## User Setup Required

None for anvil. Testnet PvP e2e remains blocked on `HUB_V2_EURC`/`PVP_ROUTER` deployment plus agent EURC funding/deposits (deploy-phase concern).

## Next Phase Readiness

- PVP-01's success criterion is now executable and green: `npm run e2e:anvil` proves both-or-neither positively and negatively with FX-exact balances (D-11)
- 04-07 docs can cite the measured gas figures (e2e live ~507k; forge fresh-state demo-scale worst case 1,734,897) for the A3 assumption log

## Self-Check: PASSED

- `demo/e2e.ts` modified and contains `gasUsed` (artifact must-have) — FOUND
- `public/dashboard.html` contains `pvp` outside comments (grep = 5) — FOUND
- Commits `0d46ef9`, `cfa45e3` — FOUND in git log on `worktree-agent-a2cdd775f99c9528a`
- `git diff demo/server.ts` — empty (no endpoint additions)

---
*Phase: 04-cross-currency-pvp-rounds-brief-phase-6*
*Completed: 2026-07-24*
