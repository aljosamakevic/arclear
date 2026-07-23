# Roadmap: Arclear v2

## Overview

Arclear v2 evolves the shipped v1 netting primitive into a two-product clearing stack on Arc Testnet. The journey follows `docs/V2-BRIEF.md`'s dependency order exactly: first make netting live through member failure (threshold consent), then make claims provable and recoverable on-chain (merkle manifests + IOU redemption) — together a shippable "Arclear Net v2" release. A data-driven calibration checkpoint then gates the CCP scope before any CCP code is written. The CCP arc (novation → margin → default waterfall → membership) builds `ArclearCCP.sol` as a separate contract sharing the settlement layer, each phase deliberately breaking one v1 invariant with the replacement invariant tested first. Cross-currency PvP rounds are independent and can run parallel to the CCP arc.

**Brief↔GSD phase mapping:** GSD phases 1–8 correspond to brief Phase 0, Phase 1, calibration checkpoint, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6 respectively. Each phase title carries its brief number.

**Structural notes:**

- **Phases 1+2 together are a shippable "Arclear Net v2" release** and the showcase resubmission moment.
- **Phase 3 is a decision gate**: its sweep data can revisit CCP scope (Phases 4–7) before CCP code is written.
- **Phase 8 (PvP) is independent** of the CCP arc and parallelizable with Phases 4–7.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Threshold Consent (brief Phase 0)** - Exclude-and-recompute rounds keep settling through unresponsive members; unanimity over the final executed set (completed 2026-07-22)
- [ ] **Phase 2: Merkle Manifests & IOU Redemption (brief Phase 1)** - Sorted-leaf merkle manifest roots with inclusion/non-inclusion proofs and an on-chain `redeemIOU` recovery path
- [ ] **Phase 3: Calibration Checkpoint (brief checkpoint)** - Sweep-driven decision gate: what member count threshold consent unlocks, what q/N margin params survive p10 rounds
- [ ] **Phase 4: Novation — ArclearCCP.sol (brief Phase 2)** - Members face the hub; matched-book invariant holds under any novation/settlement sequence
- [ ] **Phase 5: Margin (brief Phase 3)** - EWMA-based IM, variation margin calls, permissionless `declareDefault`, procyclicality cap — all parameters labeled uncalibrated
- [ ] **Phase 6: Default Waterfall (brief Phase 4)** - Standard 7-tranche waterfall incl. operator skin-in-the-game, legible tranche-by-tranche, conservation invariant
- [ ] **Phase 7: Membership & Governance (brief Phase 5)** - Admission registry, minimum guaranty contribution, suspension path; honest permissionless→permissioned documentation
- [ ] **Phase 8: Cross-Currency PvP Rounds (brief Phase 6)** - USDC + EURC legs settle atomically with a per-round signed FX rate (miniature CLS); independent/parallelizable

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

- [ ] 02-06-PLAN.md — SDK wiring: V2 ABI rebind, gas formula, redeemIOU/fetchManifest/prepareRedemptionProofs, L-convention, net() redeemedIds (wave 5)

**Wave 6**

- [ ] 02-07-PLAN.md — Coordinator redeemed-id reconciliation + e2e redemption scenario (wave 6)

**Wave 7**

- [ ] 02-08-PLAN.md — PROTOCOL/THREAT-MODEL/README docs, Arc testnet redeploy (USDC+EURC), human verify (wave 7)

Note: Phases 1+2 complete = shippable "Arclear Net v2" release (showcase resubmission moment).

### Phase 3: Calibration Checkpoint (brief checkpoint)

**Goal**: Data gates CCP scope before any CCP code is written — the sweep answers what member count threshold consent unlocks and what q/N margin parameters survive p10 rounds
**Depends on**: Phase 1 (threshold-consent protocol to simulate), Phase 2 (Net v2 complete before CCP work starts)
**Requirements**: CALB-01, CALB-02
**Success Criteria** (what must be TRUE):

  1. `demo/sweep.ts` simulates threshold-consent rounds with unresponsive members and produces an empirical answer to what member count threshold consent actually unlocks in practice
  2. The sweep simulates margin/undercollateralization scenarios and produces an empirical answer to what q/N margin parameters survive the p10 rounds
  3. A go/revise decision on CCP scope (Phases 4–7) is recorded with the supporting data — if the answers are ugly, scope is revisited before `ArclearCCP.sol` exists

**Plans**: TBD

Note: **DECISION GATE** — this phase's output can change the scope of Phases 4–7. Do not start Phase 4 until the checkpoint decision is recorded.

### Phase 4: Novation — ArclearCCP.sol (brief Phase 2)

**Goal**: Members face the hub instead of each other — bilateral obligations are extinguished into hub-facing positions with the matched-book invariant written first
**Depends on**: Phase 3 (checkpoint decision gates CCP scope), Phase 2 (shared settlement layer, provable claims)
**Requirements**: NOVA-01, NOVA-02, NOVA-03
**Success Criteria** (what must be TRUE):

  1. `novate(IOU[] ious, bytes[] sigs)` verifies both parties' signatures and margin headroom, extinguishes the bilateral obligation, and writes position deltas — both members now face the hub
  2. Matched-book invariant (written before the handler) holds under any sequence of novations and settlements: `Σ openPosition == 0 && hubPosition == 0` — a nonzero `hubPosition` is a solvency bug
  3. CCP `executeRound` settles `openPosition → 0` against variation margin and collateral

**Plans**: TBD

### Phase 5: Margin (brief Phase 3)

**Goal**: The hub sizes initial and variation margin to cover a defaulter's likely loss — undercollateralized clearing with every parameter honest about its uncalibrated status
**Depends on**: Phase 4 (margin applies to novated hub-facing positions)
**Requirements**: MARG-01, MARG-02, MARG-03, MARG-04, MARG-05
**Success Criteria** (what must be TRUE):

  1. Initial margin computes as `IM = q × EWMA(rolling peak intra-cycle net debit)` per member with lookback N; q and N are exposed governance parameters explicitly documented as uncalibrated
  2. Variation margin works end-to-end: open positions marked each round, adverse-side members topped up within a window via `callMargin(member, amount, deadline)`
  3. `declareDefault(member)` succeeds when called by anyone after a missed margin deadline — no operator discretion to hide a failure
  4. Procyclicality cap binds: IM rises at most X% per round under a simulated stress ramp, and the solvency-vs-stability trade is documented explicitly
  5. Tests show margin covers the modeled 99th-percentile debit on sweep-generated histories

**Plans**: TBD

### Phase 6: Default Waterfall (brief Phase 4)

**Goal**: When a member fails to pay, the hub pays anyway — from a defined, legible, tranche-by-tranche resource stack, with conservation proven after every execution
**Depends on**: Phase 5 (waterfall consumes margin and guaranty resources; defaults are declared via margin flow)
**Requirements**: WATR-01, WATR-02, WATR-03
**Success Criteria** (what must be TRUE):

  1. `DefaultWaterfall.sol` implements the standard 7-tranche order (defaulter VM → defaulter IM → defaulter guaranty contribution → operator skin-in-the-game → survivors' guaranty fund pro rata → capped assessments → VM-gains haircut), each tranche a separate internal function returning the residual
  2. Close-out valuation is the scalar uncovered debit — no volatile mark, no auction, no hedging (stated in the docs)
  3. Tests cover tranche-by-tranche exhaustion, the good case (stops at tranche 3, zero mutualization), and a default deep enough to reach assessments
  4. Conservation invariant holds after any waterfall execution: `total assets == total liabilities + fund balances`

**Plans**: TBD

### Phase 7: Membership & Governance (brief Phase 5)

**Goal**: Undercollateralized credit means knowing who you extend it to — admission, minimum guaranty contribution, and suspension exist, and the docs say plainly where permissionlessness ends
**Depends on**: Phase 6 (membership gates the complete CCP risk stack; guaranty minimums reference waterfall tranches)
**Requirements**: MEMB-01, MEMB-02
**Success Criteria** (what must be TRUE):

  1. Membership registry supports admission with a minimum guaranty contribution and a suspension path
  2. README states plainly where the design stops being permissionless — the permissionless→permissioned transition documented as the real cost of becoming a clearinghouse, with Arclear Net v1 remaining the permissionless product

**Plans**: TBD

### Phase 8: Cross-Currency PvP Rounds (brief Phase 6)

**Goal**: USDC and EURC legs settle atomically in a payment-vs-payment round — a miniature CLS on Arc
**Depends on**: Phase 1 (round protocol); independent of Phases 4–7 and parallelizable with them
**Requirements**: PVP-01, PVP-02
**Success Criteria** (what must be TRUE):

  1. A cross-currency round settles both the USDC leg and the EURC leg atomically — both settle or neither does
  2. The agreed per-round FX rate is signed into the consent digest, tied to the official `arc-stablecoin-fx` sample

**Plans**: TBD

Note: This phase has no dependency on the CCP arc — it can be scheduled any time after Phase 1, in parallel with Phases 4–7.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Exception: Phase 8 is independent and may run in parallel with Phases 4–7.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Threshold Consent | 5/5 | Complete    | 2026-07-22 |
| 2. Merkle Manifests & IOU Redemption | 5/8 | In Progress|  |
| 3. Calibration Checkpoint | 0/TBD | Not started | - |
| 4. Novation — ArclearCCP.sol | 0/TBD | Not started | - |
| 5. Margin | 0/TBD | Not started | - |
| 6. Default Waterfall | 0/TBD | Not started | - |
| 7. Membership & Governance | 0/TBD | Not started | - |
| 8. Cross-Currency PvP Rounds | 0/TBD | Not started | - |
