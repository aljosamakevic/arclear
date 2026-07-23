---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 07
subsystem: demo
tags: [typescript, viem, coordinator, e2e, redemption, merkle, events]

# Dependency graph
requires:
  - phase: 02 plan 06
    provides: "HubClient redemption surface (prepareRedemptionProofs, redeemIOU, fetchManifest, lastRound, redeemed), redeemedIds opt in net(), signIou L-convention"
  - phase: 02 plan 04
    provides: "ClearingHubV2 on-chain gates: staleness (roundNonce >= lastRound + K), nullifier, contract-derived proof regime, IouRedeemed event"
provides:
  - "demo/coordinator.ts: redeemedIds Set (separate from settledIds) + IouRedeemed log reconciliation (idempotent block watermark) + redeemedIds threaded through every netting path (attemptRound, provider verifyProposal, state preview, open-IOU filter)"
  - "demo/e2e.ts: full D-17 redemption scenario — K executed rounds of on-chain staleness, calldata-reconstructed proofs, creditor-submitted redeemIOU, exact base-unit assertions, permanent-exclusion tail"
  - "src/round.ts: redeemedIds optional opt (type-level) on rebuildProposal/verifyProposal so honest members exclude redeemed paper in their local recomputation"
affects:
  - "02-08 (PROTOCOL.md documents the log-reconciliation regime and cites this scenario as the MERK-03/MERK-04 acceptance evidence)"
  - "02-09+ (testnet redeploy runs this same e2e against Arc)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Log-driven state convergence: coordinator folds IouRedeemed events from getContractEvents with an idempotent Set + block watermark (re-covering the tip block is harmless, skipping is impossible)"
    - "On-chain-condition-driven e2e: staleness asserted from lastRound/roundNonce reads in the exact additive form redeemIOU checks (roundNonce >= lastRound + K), never from coordinator counters"

key-files:
  created: []
  modified:
    - demo/coordinator.ts
    - demo/e2e.ts
    - src/round.ts

decisions:
  - "redeemedIds kept as a SEPARATE Set from settledIds (plan directive) so the dashboard/report can distinguish settled-by-round from recovered-by-redemption; both are excluded from netting identically"
  - "reconcileRedeemedIds runs at the top of every runRound (adjacent to reconcilePendingSubmission), scanning IouRedeemed from a private block watermark; watermark set to the pre-query tip so overlapping ranges re-fold idempotently and no event can be skipped"
  - "e2e reads K from the contract (readContract K) instead of hardcoding 3, so the staleness loop and assertion track whatever the deployed hub was configured with"
  - "Staleness rounds pass othersOnly personas to simulateTraffic so fresh paper never touches the dark debtor; the debtor still appears in pass 1 (their redemption IOU is open) and is excluded via the existing 2-pass machinery — every round genuinely EXECUTES"

requirements-completed: [MERK-03, MERK-04]

# Metrics
metrics:
  duration: "9m"
  tasks: 2
  completed: "2026-07-23T01:41:45Z"
---

# Phase 2 Plan 07: Coordinator Redemption Wiring + D-17 E2E Scenario Summary

The reference coordinator now converges with on-chain redemption state from IouRedeemed logs alone (redeemed paper structurally can never re-enter a proposal), and the whole recovery story is proven live on anvil: a debtor dark past K executed rounds is redeemed against by their creditor using only calldata-reconstructed proofs, debited to the exact base unit, and the redeemed id never appears in any consumed manifest ever again.

## What Was Built

- **demo/coordinator.ts:**
  - `redeemedIds = new Set<Hex>()` on the Coordinator — deliberately separate from `settledIds` (settled-by-round vs recovered-by-redemption), with a doc comment stating it folds ONLY from confirmed IouRedeemed chain logs, never miss counters (D-09).
  - `reconcileRedeemedIds()` (private): `getContractEvents({eventName: "IouRedeemed", fromBlock: watermark})` against `clearingHubV2Abi`, folds each event's `id.toLowerCase() as Hex`, then advances the watermark to the pre-query tip — the Set fold is idempotent so the overlapping block can never double-count and a race can never skip. Called at the top of every `runRound`, right after `reconcilePendingSubmission`.
  - `redeemedIds` threaded through every netting path: `attemptRound` gained an optional `redeemedIds` arg folded into its shared `opts` (reaching `net()` and `rebuildProposal`), the provider closures pass `redeemedIds: this.redeemedIds` into `verifyProposal`, the `state()` preview nets with it, and the `openIous` getter drops redeemed ids so redeemed paper leaves the candidate view immediately.
  - `applyMissSemantics`, `screenConsents`, and the `pendingSubmission` block are byte-untouched (grep-verified on the diff).
- **src/round.ts (deviation, type-level only):** `redeemedIds?: ReadonlySet<Hex>` added to the opts types of `rebuildProposal` and `verifyProposal`. Both already forward their whole opts object to `net()` (which accepts `redeemedIds` since 02-06), so this is zero-behavior-change type widening — but without it, honest members' local recomputation would include redeemed paper, mismatch the coordinator's deltas, and refuse every post-redemption proposal.
- **demo/e2e.ts (new scenario after the liveness scenario; every pre-existing assertion untouched):**
  1. One redemption IOU debtor=Oracle (staller) → creditor=Trader, fixed 300,000 base units (÷ divisor), expiry = now + 86,400 (L-convention boundary), added to the coordinator.
  2. Oracle goes dark; `K` read from the contract; K rounds of fresh traffic among the OTHER four personas each settle (2-pass exclusion — the open redemption IOU pulls Oracle into pass 1, the existing machinery excludes them), advancing the on-chain clock.
  3. Staleness precondition asserted in the contract's exact additive form: `roundNonce (6) >= lastRound (3) + K (3)` from `hubClient.lastRound`/`roundNonce` reads — zero references to coordinator miss counters (grep-verified).
  4. Creditor path: `prepareRedemptionProofs(id)` (calldata reconstruction), own `createWalletClient`, `hubClient.redeemIOU`, receipt success asserted.
  5. Exact-base-unit checks: debtor debited by exactly 300,000, creditor credited by exactly 300,000, `redeemed(id) === true`.
  6. Exclusivity tail: Oracle unstalled, 40 IOUs of all-personas traffic plus two explicit IOUs touching Oracle both directions; tail round settles with Oracle participating; redeemed id absent from the tail round's consumed manifest AND from `coordinator.settledIds` (the union of every consumed manifest ever) — MERK-04/D-17.

## Task Commits

| Task | Commit | Message |
| ---- | ------ | ------- |
| 1 | `830bd69` | feat(02-07): coordinator redeemed-id reconciliation and netting exclusion |
| 2 | `9629ed7` | feat(02-07): e2e redemption scenario — dark debtor to permanent exclusion (D-17) |

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 64/64 green (no vitest surface changed)
- `npm run e2e:anvil` — exit 0; all scenarios green: baseline (1-pass), liveness (stall → exclude → re-settle → disjoint manifests), redemption (3/3 staleness rounds, on-chain staleness assertion, redeemIOU mined, exact debit/credit, redeemed(id) true, tail-round + union exclusivity)
- Greps: `redeemedIds` assigned only at declaration and inside `reconcileRedeemedIds` (event path); no `missed`/miss-counter reference anywhere in demo/e2e.ts; diff shows `applyMissSemantics`/`screenConsents`/`pendingSubmission` untouched
- Port 8545 free after the run (anvil killed on every exit path); no orphan processes
- No file deletions in any commit; working tree clean before SUMMARY

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] redeemedIds missing from rebuildProposal/verifyProposal opts types**
- **Found during:** Task 1
- **Issue:** The plan wires `redeemedIds` "through net() opts wherever the coordinator nets", but two of those nets happen inside `rebuildProposal` (pass-2 recompute) and `verifyProposal` (every honest member's local recomputation), whose opts types didn't declare `redeemedIds`. Without the field, members recompute deltas that include redeemed paper → delta mismatch → refusal of every post-redemption proposal (the tail round would spiral to abort).
- **Fix:** Type-level widening: `redeemedIds?: ReadonlySet<Hex>` added to both opts types in src/round.ts. Runtime behavior for existing callers is unchanged (both functions already forward opts to `net()`, which has accepted the key since 02-06).
- **Files modified:** src/round.ts (outside the plan's files_modified list; 11 lines, type + doc comment only)
- **Commit:** `830bd69`

**2. [Rule 1 - Bug] e2e variable name collision with the bytecode-tail helper**
- **Found during:** Task 2 verification (tsc)
- **Issue:** The new tail-round variable `tail` collided with the pre-existing `tail(h)` metadata-tail helper at demo/e2e.ts:39.
- **Fix:** Renamed to `tailRound`.
- **Files modified:** demo/e2e.ts
- **Commit:** `9629ed7`

Otherwise: plan executed as written.

## Known Stubs

None — the reconciliation is fully wired to live chain logs, the e2e drives real contract state end-to-end, and no placeholder values or unwired data paths exist.

## Threat Flags

None beyond the plan's register. All mitigate dispositions discharged: T-02-29 (log-driven redeemedIds fold + net()/openIous exclusion in Task 1; on-chain NullifiedIdInManifest remains the backstop), T-02-30 (e2e asserts the exact on-chain additive staleness form from lastRound/roundNonce reads; grep confirms zero miss-counter references), T-02-31 (screenConsents/pendingSubmission/applyMissSemantics byte-untouched in the diff; rebuild.test.ts suite still 64/64 green). T-02-SC: no package installs occurred.

## Next Phase Readiness

- 02-08 (PROTOCOL.md) can cite this scenario as the running-system evidence for MERK-03 (creditor recovery from chain data alone) and MERK-04 (redeemed id never settles), and document the coordinator's log-reconciliation regime (redeemedIds from IouRedeemed events, miss counters demoted to early warning)
- The testnet redeploy plan runs this same e2e via `npm run e2e:testnet` — note the redemption scenario adds K+1 extra executed rounds plus one redeemIOU write to the testnet gas budget
- Zero-authority property preserved: redemption happens entirely outside the coordinator (creditor's own wallet), and the coordinator's view converges from public logs

## Self-Check: PASSED

- demo/coordinator.ts (contains "IouRedeemed"), demo/e2e.ts (contains "redeemIOU"), src/round.ts (redeemedIds opts) — all on disk with required content
- Commits 830bd69, 9629ed7 present in git log
- tsc clean; vitest 64/64; e2e:anvil exit 0 with all new checks passing; port 8545 free
