# Requirements: Arclear v2

**Defined:** 2026-07-22
**Core Value:** A CCP is defined by operating *through* a member failure: the system must keep settling when members stall or default, with every risk mechanism legible, invariant-tested, and honest about its calibration status.

## v1 Requirements

Requirements for the v2 milestone (this roadmap). Derived 1:1 from `docs/V2-BRIEF.md` Phases 0–6 + calibration checkpoint.

### Threshold Consent (brief Phase 0)

- [x] **CONS-01**: Coordinator can propose a round over a *candidate* set and collect consents within a timeout window
- [x] **CONS-02**: On timeout, coordinator rebuilds the round from the consenting subset — excluded member's IOUs drop from the manifest, counterparties' deltas are recomputed, and everyone in the final set signs the final digest
- [x] **CONS-03**: Invariant holds and is tested: every settled balance movement was signed for by its owner over the exact executed position set
- [x] **CONS-04**: An IOU excluded in round n settles cleanly in round n+1, and the same IOU can never settle twice
- [ ] **CONS-05**: Exclusion rounds are zero-sum after redistribution; griefing cost (repeated refusal = repeated rebuild latency, never a safety cost) is analyzed and documented
- [x] **CONS-06**: `ClearingHubV2.sol` ships with the execution path mostly unchanged — the change lives in coordinator/SDK protocol and round-rebuild logic in `round.ts`

### Merkle Manifests & IOU Redemption (brief Phase 1)

- [ ] **MERK-01**: `manifestHash` preimage is a sorted-leaf merkle root — same `bytes32` field, no ClearingHub interface change
- [ ] **MERK-02**: `src/merkle.ts` + `contracts/src/lib/ManifestMerkle.sol` build roots and prove inclusion and non-inclusion (adjacent-leaf bracketing), with TS↔Solidity proof parity fixtures
- [ ] **MERK-03**: A creditor can call `redeemIOU(iou, sig, proofs[])` with non-inclusion proofs against the last k round roots to debit an unresponsive debtor's collateral directly (debtor flagged after missing K consecutive consent windows)
- [ ] **MERK-04**: A nullifier mapping prevents re-redemption; redeem→cannot-net and net→cannot-redeem exclusivity is tested

### Calibration Checkpoint (brief checkpoint, between Phases 1 and 2)

- [ ] **CALB-01**: `demo/sweep.ts` extended to simulate threshold-consent rounds with unresponsive members — answers what member count threshold consent actually unlocks in practice
- [ ] **CALB-02**: Sweep simulates margin/undercollateralization scenarios — answers what q/N margin parameters survive the p10 rounds; if answers are ugly, CCP scope is revisited with data

### Novation (brief Phase 2)

- [ ] **NOVA-01**: `ArclearCCP.sol` `novate(IOU[] ious, bytes[] sigs)` verifies both parties' signatures and margin headroom, extinguishes the bilateral obligation, and writes position deltas — both members face the hub
- [ ] **NOVA-02**: Matched-book invariant written first and holds: `Σ openPosition == 0 && hubPosition == 0` under any sequence of novations/settlements
- [ ] **NOVA-03**: CCP `executeRound` settles `openPosition → 0` against variation margin and collateral

### Margin (brief Phase 3)

- [ ] **MARG-01**: Initial margin `IM = q × EWMA(rolling peak intra-cycle net debit)` per member with lookback N; q and N exposed as governance parameters, documented as uncalibrated
- [ ] **MARG-02**: Variation margin: open positions marked each round; adverse-side members top up within a window via `callMargin(member, amount, deadline)`
- [ ] **MARG-03**: `declareDefault(member)` is callable by anyone after a missed margin deadline (permissionless default declaration)
- [ ] **MARG-04**: Procyclicality cap: IM may rise at most X% per round; the solvency-vs-stability trade is documented explicitly
- [ ] **MARG-05**: Tests show margin covers the modeled 99th-percentile debit on sweep-generated histories and the cap binds under a simulated stress ramp

### Default Waterfall (brief Phase 4)

- [ ] **WATR-01**: `DefaultWaterfall.sol` implements the standard 7-tranche order (defaulter VM → defaulter IM → defaulter guaranty contribution → operator skin-in-the-game → survivors' guaranty fund pro rata → capped assessments → VM-gains haircut), each tranche a separate internal function returning the residual
- [ ] **WATR-02**: Close-out valuation is the scalar uncovered debit — no volatile mark, no auction, no hedging
- [ ] **WATR-03**: Tests cover tranche-by-tranche exhaustion, the good case (stops at tranche 3, zero mutualization), a default reaching assessments, and the conservation invariant `total assets == total liabilities + fund balances` after any waterfall execution

### Membership & Governance (brief Phase 5)

- [ ] **MEMB-01**: Membership registry with admission, minimum guaranty contribution, and a suspension path
- [ ] **MEMB-02**: README states plainly where the design stops being permissionless — the permissionless→permissioned transition is documented as the real cost of becoming a clearinghouse (Arclear Net v1 remains the permissionless product)

### Cross-Currency PvP (brief Phase 6, independent/parallelizable)

- [ ] **PVP-01**: USDC + EURC legs settle atomically in a payment-vs-payment round (miniature CLS)
- [ ] **PVP-02**: An agreed per-round FX rate is signed into the consent digest; ties to the official `arc-stablecoin-fx` sample

## v2 Requirements

None — milestone scope is fixed by `docs/V2-BRIEF.md`. New ideas route through `/gsd:capture` or the next milestone.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Mainnet deployment | Testnet reference implementation only |
| Real-money custody | Same |
| Calibrated production risk parameters | Production needs backtesting; parameters deliberately labeled uncalibrated |
| UI beyond existing dashboard pattern | Not the point of the project |
| Fee-on-transfer tokens | Out of protocol scope |
| Extending `ClearingHub.sol` into the CCP | Novation/margin/waterfall break v1 invariants on purpose; CCP is a separate contract sharing the settlement layer |
| Outvote-style k-of-n consent | Fixed decision: exclude-and-recompute, never outvote — a non-signer must never have their balance moved without consent |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONS-01 | Phase 1 | Complete |
| CONS-02 | Phase 1 | Complete |
| CONS-03 | Phase 1 | Complete |
| CONS-04 | Phase 1 | Complete |
| CONS-05 | Phase 1 | Pending |
| CONS-06 | Phase 1 | Complete |
| MERK-01 | Phase 2 | Pending |
| MERK-02 | Phase 2 | Pending |
| MERK-03 | Phase 2 | Pending |
| MERK-04 | Phase 2 | Pending |
| CALB-01 | Phase 3 | Pending |
| CALB-02 | Phase 3 | Pending |
| NOVA-01 | Phase 4 | Pending |
| NOVA-02 | Phase 4 | Pending |
| NOVA-03 | Phase 4 | Pending |
| MARG-01 | Phase 5 | Pending |
| MARG-02 | Phase 5 | Pending |
| MARG-03 | Phase 5 | Pending |
| MARG-04 | Phase 5 | Pending |
| MARG-05 | Phase 5 | Pending |
| WATR-01 | Phase 6 | Pending |
| WATR-02 | Phase 6 | Pending |
| WATR-03 | Phase 6 | Pending |
| MEMB-01 | Phase 7 | Pending |
| MEMB-02 | Phase 7 | Pending |
| PVP-01 | Phase 8 | Pending |
| PVP-02 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0 ✓

---
*Requirements defined: 2026-07-22*
*Last updated: 2026-07-22 after roadmap creation (traceability mapped)*
