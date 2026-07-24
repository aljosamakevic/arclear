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
- [x] **CONS-05**: Exclusion rounds are zero-sum after redistribution; griefing cost (repeated refusal = repeated rebuild latency, never a safety cost) is analyzed and documented
- [x] **CONS-06**: `ClearingHubV2.sol` ships with the execution path mostly unchanged — the change lives in coordinator/SDK protocol and round-rebuild logic in `round.ts`

### Merkle Manifests & IOU Redemption (brief Phase 1)

- [x] **MERK-01**: `manifestHash` preimage is a sorted-leaf merkle root — same `bytes32` field, no ClearingHub interface change
- [x] **MERK-02**: `src/merkle.ts` + `contracts/src/lib/ManifestMerkle.sol` build roots and prove inclusion and non-inclusion (adjacent-leaf bracketing), with TS↔Solidity proof parity fixtures
- [x] **MERK-03**: A creditor can call `redeemIOU(iou, sig, proofs[])` with non-inclusion proofs against the last k round roots to debit an unresponsive debtor's collateral directly (debtor flagged after missing K consecutive consent windows)
- [x] **MERK-04**: A nullifier mapping prevents re-redemption; redeem→cannot-net and net→cannot-redeem exclusivity is tested

### Calibration Checkpoint (brief checkpoint, between Phases 1 and 2)

- [x] **CALB-01**: `demo/sweep.ts` extended to simulate threshold-consent rounds with unresponsive members — answers what member count threshold consent actually unlocks in practice
- [x] **CALB-02**: Sweep simulates margin/undercollateralization scenarios — answers what q/N margin parameters survive the p10 rounds; if answers are ugly, CCP scope is revisited with data

### Cross-Currency PvP (brief Phase 6)

- [x] **PVP-01**: USDC + EURC legs settle atomically in a payment-vs-payment round (miniature CLS)
- [x] **PVP-02**: An agreed per-round FX rate is signed into the consent digest; ties to the official `arc-stablecoin-fx` sample

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
| CCP arc (NOVA-01..03, MARG-01..05, WATR-01..03, MEMB-01..02) | Removed 2026-07-24 by user decision — the CCP is a reference implementation, not a primitive; decoupled from the submission. Specs preserved in docs/V2-BRIEF.md and git history |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONS-01 | Phase 1 | Complete |
| CONS-02 | Phase 1 | Complete |
| CONS-03 | Phase 1 | Complete |
| CONS-04 | Phase 1 | Complete |
| CONS-05 | Phase 1 | Complete |
| CONS-06 | Phase 1 | Complete |
| MERK-01 | Phase 2 | Complete |
| MERK-02 | Phase 2 | Complete |
| MERK-03 | Phase 2 | Complete |
| MERK-04 | Phase 2 | Complete |
| CALB-01 | Phase 3 | Complete |
| CALB-02 | Phase 3 | Complete |
| NOVA-01 | — | Removed (2026-07-24) |
| NOVA-02 | — | Removed (2026-07-24) |
| NOVA-03 | — | Removed (2026-07-24) |
| MARG-01 | — | Removed (2026-07-24) |
| MARG-02 | — | Removed (2026-07-24) |
| MARG-03 | — | Removed (2026-07-24) |
| MARG-04 | — | Removed (2026-07-24) |
| MARG-05 | — | Removed (2026-07-24) |
| WATR-01 | — | Removed (2026-07-24) |
| WATR-02 | — | Removed (2026-07-24) |
| WATR-03 | — | Removed (2026-07-24) |
| MEMB-01 | — | Removed (2026-07-24) |
| MEMB-02 | — | Removed (2026-07-24) |
| PVP-01 | Phase 4 | Complete |
| PVP-02 | Phase 4 | Complete |

**Coverage:**

- v1 requirements: 27 total (13 removed with the CCP arc 2026-07-24)
- Mapped to phases: 14 active
- Unmapped: 0 ✓

---
*Requirements defined: 2026-07-22*
*Last updated: 2026-07-22 after roadmap creation (traceability mapped)*
