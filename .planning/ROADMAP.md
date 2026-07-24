# Roadmap: Arclear v2

## Overview

Arclear v2 evolves the shipped v1 netting primitive into a two-product clearing stack on Arc Testnet. The journey follows `docs/V2-BRIEF.md`'s dependency order exactly: first make netting live through member failure (threshold consent), then make claims provable and recoverable on-chain (merkle manifests + IOU redemption) — together a shippable "Arclear Net v2" release. A data-driven calibration checkpoint documents what the primitive delivers at scale, and cross-currency PvP rounds complete the submission surface. The CCP arc was removed from the roadmap on 2026-07-24 (see note below); `docs/V2-BRIEF.md` remains its vision artifact.

**Brief↔GSD phase mapping:** GSD phases 1–4 correspond to brief Phase 0, Phase 1, calibration checkpoint, Phase 6 respectively. Each phase title carries its brief number. (Brief Phases 2–5 — the CCP arc — removed 2026-07-24.)

**Structural notes:**

- **Phases 1+2 together are a shippable "Arclear Net v2" release** and the showcase resubmission moment.
- **Phase 3's decision gate is resolved** (2026-07-24: CCP skipped); its sweep now serves the submission and the reference brief.
- **Phase 4 (PvP) is independent** and completes the primitive's submission surface.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Threshold Consent (brief Phase 0)** - Exclude-and-recompute rounds keep settling through unresponsive members; unanimity over the final executed set (completed 2026-07-22)
- [x] **Phase 2: Merkle Manifests & IOU Redemption (brief Phase 1)** - Sorted-leaf merkle manifest roots with inclusion/non-inclusion proofs and an on-chain `redeemIOU` recovery path (completed 2026-07-24)
- [x] **Phase 3: Calibration Checkpoint (brief checkpoint)** - Sweep-driven empirical answers: what member count threshold consent unlocks under realistic uptime; margin-parameter data recorded for the reference brief (completed 2026-07-24)
- [x] **Phase 4: Cross-Currency PvP Rounds (brief Phase 6)** - USDC + EURC legs settle atomically with a per-round signed FX rate (miniature CLS) (completed 2026-07-24)

> **CCP arc removed (2026-07-24):** former Phases 4–7 (Novation, Margin, Default Waterfall, Membership) were removed from the roadmap by user decision — the CCP is a reference implementation, not a primitive others build on, and is decoupled from the submission's critical path (see Opus positioning review, 02-DISCUSSION context). `docs/V2-BRIEF.md` remains the vision artifact for that arc. Git history preserves the removed phase specs at commit `15fb231` and earlier.

## Phase Details

### Phase 1: Threshold Consent (brief Phase 0)

**Goal**: Rounds keep settling when members stall — threshold over the candidate set, unanimity over the final executed set, so no one's balance ever moves without their signature
**Depends on**: Nothing (first phase)
**Requirements**: CONS-01, CONS-02, CONS-03, CONS-04, CONS-05, CONS-06
**Success Criteria** (what must be TRUE):

  1. A round proposed over a candidate set settles even when a member never responds: on timeout the coordinator rebuilds from the consenting subset (excluded member's IOUs dropped, counterparties' deltas recomputed) and everyone in the final set signs the final digest
  2. Invariant test passes: every settled balance movement was signed for by its owner over the exact executed position set; exclusion rounds are zero-sum after redistribution
  3. An IOU excluded in round n settles cleanly in round n+1, and the same IOU can never settle twice
  4. Griefing analysis is documented: repeated refusal costs only repeated rebuild latency (worst case two signature-collection passes), never a safety cost
  5. `ClearingHubV2.sol` ships with the execution path mostly unchanged — the change lives in coordinator/SDK protocol and round-rebuild logic in `round.ts`

**Plans**: 5 plans

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Pure rebuild core in `src/round.ts` (rebuildProposal + excluded-aware verifyProposal) with fast-check invariants (wave 1)
- [x] 01-02-PLAN.md — ClearingHubV2.sol near-verbatim copy, digest-parity test vs existing fixture, deploy artifacts (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-03-PLAN.md — Coordinator two-pass state machine: consent providers, timeout snapshot, miss counters, abort semantics + invariant properties (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-04-PLAN.md — Demo wiring: V2 bytecode on anvil, stall toggle, dashboard exclusion display, e2e liveness scenario (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-05-PLAN.md — PROTOCOL.md griefing analysis, THREAT-MODEL reconciliation, Arc testnet V2 deploys + human verify (wave 4)

### Phase 2: Merkle Manifests & IOU Redemption (brief Phase 1)

**Goal**: Claims become provable and recoverable on-chain — manifest roots support inclusion and non-inclusion proofs, and a creditor can redeem an unconsumed IOU directly against an unresponsive debtor's collateral
**Depends on**: Phase 1 (excluded members need non-inclusion proofs to re-present IOUs; flagging relies on missed consent windows)
**Requirements**: MERK-01, MERK-02, MERK-03, MERK-04
**Success Criteria** (what must be TRUE):

  1. `manifestHash` preimage is a sorted-leaf merkle root in the same `bytes32` field — no ClearingHub interface change
  2. `src/merkle.ts` and `contracts/src/lib/ManifestMerkle.sol` produce byte-identical roots and verify both inclusion and non-inclusion (adjacent-leaf bracketing), proven by shared TS↔Solidity fixtures
  3. A creditor can call `redeemIOU(iou, sig, proofs[])` with non-inclusion proofs against the last k round roots and debit an unresponsive debtor's collateral directly — gated to debtors flagged after missing K consecutive consent windows
  4. Nullifier mapping prevents re-redemption; redeem→cannot-net and net→cannot-redeem exclusivity is tested

**Plans**: 8 plans

Plans:
**Wave 1** *(parallel)*

- [x] 02-01-PLAN.md — src/merkle.ts sorted-leaf merkle lib + fast-check property suite (wave 1)
- [x] 02-02-PLAN.md — ManifestMerkle.sol library + unit/adversarial fuzz tests (wave 1)

**Wave 2**

- [x] 02-03-PLAN.md — manifestHash root swap, merkle.json + iouSig fixtures, MerkleParity.t.sol (wave 2)

**Wave 3**

- [x] 02-04-PLAN.md — ClearingHubV2 extension: consumedIds executeRound, rootRing, lastRound, hashIou, redeemIOU; DeployV2 + parity constructor fix (wave 3)

**Wave 4**

- [x] 02-05-PLAN.md — RoundBuilderV2 harness, redeemIOU revert matrix, bidirectional exclusivity, fuzz, measured gas (wave 4)

**Wave 5**

- [x] 02-06-PLAN.md — SDK wiring: V2 ABI rebind, gas formula, redeemIOU/fetchManifest/prepareRedemptionProofs, L-convention, net() redeemedIds (wave 5)

**Wave 6**

- [x] 02-07-PLAN.md — Coordinator redeemed-id reconciliation + e2e redemption scenario (wave 6)

**Wave 7**

- [x] 02-08-PLAN.md — PROTOCOL/THREAT-MODEL/README docs, Arc testnet redeploy (USDC+EURC), human verify (wave 7)

Note: Phases 1+2 complete = shippable "Arclear Net v2" release (showcase resubmission moment).

### Phase 3: Calibration Checkpoint (brief checkpoint)

**Goal**: Empirical calibration data — the sweep answers what member count threshold consent actually unlocks under realistic uptime (the submission slide) and what q/N margin parameters would survive p10 rounds (recorded for the reference brief)
**Depends on**: Phase 1 (threshold-consent protocol to simulate), Phase 2 (Net v2 complete)
**Requirements**: CALB-01, CALB-02
**Success Criteria** (what must be TRUE):

  1. `demo/sweep.ts` simulates threshold-consent rounds with unresponsive members and produces an empirical answer to what member count threshold consent actually unlocks in practice
  2. The sweep simulates margin/undercollateralization scenarios and produces an empirical answer to what q/N margin parameters survive the p10 rounds
  3. The CCP scope decision is recorded with the supporting data — DECIDED 2026-07-24: CCP arc skipped (removed from roadmap); the sweep documents the empirical basis and the margin data feeds the reference brief

**Plans**: 3 plans

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Pure exclude-and-recompute threshold model in `demo/thresholdModel.ts` mirroring `attemptRound`, with fast-check invariant suite (wave 1)

**Wave 2** *(blocked on Wave 1)*

- [x] 03-02-PLAN.md — Exact-match cross-validation vs the real `attemptRound` (D-02) + full-grid threshold sweep to `docs/sweep/threshold-sweep.csv` with D-05 headline table (wave 2)

**Wave 3** *(blocked on Wave 2)*

- [x] 03-03-PLAN.md — EWMA margin coverage sweep (q x N grid + stress ramp) to `docs/sweep/margin-sweep.csv` + `docs/CALIBRATION.md` with recorded gate decision (wave 3)

Note: The original DECISION GATE was resolved by user decision on 2026-07-24 (skip the CCP arc). The sweep's value is now (a) the threshold-consent-under-uptime number for the showcase submission, and (b) documented calibration data backing `docs/V2-BRIEF.md` as the vision artifact.

### Phase 4: Cross-Currency PvP Rounds (brief Phase 6)

**Goal**: USDC and EURC legs settle atomically in a payment-vs-payment round — a miniature CLS on Arc
**Depends on**: Phase 1 (round protocol); Phase 2 (current V2 hubs)
**Requirements**: PVP-01, PVP-02
**Success Criteria** (what must be TRUE):

  1. A cross-currency round settles both the USDC leg and the EURC leg atomically — both settle or neither does
  2. The agreed per-round FX rate is signed into the consent digest, tied to the official `arc-stablecoin-fx` sample

**Plans**: 7 plans

Plans:
**Wave 1** *(parallel)*

- [x] 04-01-PLAN.md — SDK PvP consent layer: PVP_TYPES/pvpDomain, PvPProposal, pvpDigest/sign/verify, unionParticipants, rateConsistent, verifyPvPProposal + vitest suite (wave 1)
- [x] 04-02-PLAN.md — PvPRouter.sol: stateless atomic router (immutable hub pair, union-sig verification, plain-call leg execution) + smoke tests (wave 1)

**Wave 2** *(parallel, blocked on Wave 1)*

- [x] 04-03-PLAN.md — D-05 fixture pipeline: genFixture pvp_* keys, digest.json regen, TS fixture lock, PvPParity.t.sol deployCodeTo parity (wave 2)
- [x] 04-04-PLAN.md — Dual-hub PvPRoundBuilder harness, full revert matrix + single-leg documented-limitation test, measured gas + PvPRouterClient/abi module (wave 2)

**Wave 3** *(blocked on Wave 2)*

- [x] 04-05-PLAN.md — Dual-hub demo bootstrap (setup/env/personas), arc-stablecoin-fx quote mirror, attemptPvPRound two-pass core + runPvPRound wrapper + in-flight guard (wave 3)

**Wave 4** *(blocked on Wave 3)*

- [x] 04-06-PLAN.md — e2e both-or-neither on anvil (positive with FX-exact balances + gasUsed; negatives: aborted bundle + forced revert) + dashboard PvP badge (wave 4)

**Wave 5** *(blocked on Wave 4)*

- [x] 04-07-PLAN.md — PROTOCOL/THREAT-MODEL/README/CONCEPTS docs, DeployPvPRouter.s.sol + Arc testnet deploy + verify, human-verify checkpoint (wave 5)


## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Threshold Consent | 5/5 | Complete    | 2026-07-22 |
| 2. Merkle Manifests & IOU Redemption | 8/8 | Complete    | 2026-07-24 |
| 3. Calibration Checkpoint | 3/3 | Complete    | 2026-07-24 |
| 4. Cross-Currency PvP Rounds | 7/7 | Complete    | 2026-07-24 |
