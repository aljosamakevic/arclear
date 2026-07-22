# Arclear v2 — From Netting Primitive to Actual Clearinghouse

## What This Is

Arclear is evolving from a collateralized multilateral netting primitive into a two-product clearing stack on Arc Testnet: **Arclear Net** (permissionless collateralized netting — exists, stays live) and **Arclear CCP** (novation + margin + default waterfall — new). It serves Arc builders running agent swarms that transact bidirectionally at high frequency, showcase reviewers, and anyone wanting a reference implementation of clearing mechanics on-chain.

## Core Value

A CCP is defined by operating *through* a member failure: the system must keep settling when members stall or default, with every risk mechanism (threshold consent, margin, waterfall) legible, invariant-tested, and honest about its calibration status.

## Requirements

### Validated

<!-- Arclear v1 — shipped, deployed, source-verified on Arc Testnet (chain 5042002). -->

- ✓ Collateral vault + atomic netting rounds under unanimous EIP-712 consent over one shared digest of the full position set (`contracts/src/ClearingHub.sol`, 26 Foundry tests) — v1
- ✓ viem SDK: IOU + consent signing, deterministic netting engine (spec in `docs/PROTOCOL.md`), bilateral credit caps, typed client; 16 fast-check property tests — v1
- ✓ 5-agent demo swarm + coordinator + zero-framework dashboard — v1
- ✓ Deployed USDC hub (`0xd5A9ef69b47b0a3C8d326fDABd57aCaFA7D3d6e2`) and EURC hub (`0x867AD43f216B03c2a79eE02eC56F4bbEf90502c0`) with real settlement: 105 IOUs → 1 tx, 92.3% compression — v1
- ✓ Empirical sweep harness (`demo/sweep.ts` → `docs/sweep/`): 200 seeds/cell over (reciprocity, density, n) — v1

### Active

<!-- v2 scope. Phases below map 1:1 onto the roadmap (Phase 0–6 + calibration checkpoint). -->

- [x] **Phase 0 — Threshold consent (liveness):** exclude-and-recompute rounds — threshold over the candidate set, unanimity over the final executed set; `ClearingHubV2.sol` + round-rebuild logic in `round.ts`
- [ ] **Phase 1 — Merkle manifests + on-chain IOU redemption:** sorted-leaf merkle manifest roots, inclusion/non-inclusion proofs, `redeemIOU` recovery path against unresponsive debtors with nullifier protection
- [ ] **Calibration checkpoint (between Phases 1 and 2):** extend `demo/sweep.ts` to simulate threshold-consent rounds with unresponsive members and margin scenarios; answers gate CCP scope
- [ ] **Phase 2 — Novation (`ArclearCCP.sol`):** members face the hub; matched-book invariant `Σ openPosition == 0 && hubPosition == 0` under any novation/settlement sequence
- [ ] **Phase 3 — Margin:** EWMA-based initial margin (governance params q, N), variation margin calls, permissionless `declareDefault`, procyclicality cap on IM, all parameters labeled uncalibrated
- [ ] **Phase 4 — Default waterfall (`DefaultWaterfall.sol`):** standard 7-tranche order incl. operator skin-in-the-game; tranche-by-tranche legibility; conservation invariant after any waterfall execution
- [ ] **Phase 5 — Membership & governance:** admission registry, minimum guaranty contribution, suspension path; README states plainly where the design stops being permissionless
- [ ] **Phase 6 — Cross-currency PvP rounds:** USDC + EURC legs settling atomically with per-round signed FX rate (miniature CLS); independent, parallelizable

### Out of Scope

- Mainnet deployment — testnet reference implementation only
- Real-money custody — same
- Calibrated production risk parameters — production needs backtesting; parameters are documented as uncalibrated by design
- UI beyond the existing dashboard pattern — not the point of the project
- Fee-on-transfer tokens — out of protocol scope
- Extending `ClearingHub.sol` into the CCP — novation/margin/waterfall break v1 invariants on purpose; CCP is a separate contract sharing the settlement layer

## Context

- **v1 state:** branch `v1` (also current `main`) is the frozen showcase snapshot. All v2 work lands as PRs from feature branches onto `main`; `v1` stays frozen.
- **Key empirical finding driving v2:** compression needs no bilateral reciprocity at n≥5; aggregate volume compression saturates ~n=15–20, but worst-participant p10 collateral saving keeps climbing (≈0% at n≤5, 33% at n=15, 53% at n=50). **Netting's value concentrates in pools too large for unanimity → liveness (Phase 0) is the prerequisite for everything else.**
- **Domain insight to state in every risk-touching phase:** in a payments CCP the defaulter's position is a scalar debit in a stable unit. No volatile mark, no close-out auction, no hedging. Loss = uncovered debit.
- **Arc environment:** chain 5042002, RPC via `ARC_RPC_URL`, explorer `https://testnet.arcscan.app` (Blockscout verifier, `--with-gas-price 25gwei`, min base fee 20 gwei). **Gas-token gotcha:** USDC is both native gas token and the ERC-20 at `0x3600…0000` — one balance, two views (18-dec native / 6-dec ERC-20); always set explicit `gas` limits on writes.
- **Docs to ingest:** `docs/V2-BRIEF.md` (this project's source), `docs/PLAN.md` (v1 plan), `docs/PROTOCOL.md`, `docs/THREAT-MODEL.md`, `docs/sweep/sweep.csv`.
- **Effort map (focused days):** Phase 0 ≈3 · Phase 1 ≈3 · checkpoint ≈1 · Phase 2 ≈4 · Phase 3 ≈5 · Phase 4 ≈4 · Phase 5 ≈2 · Phase 6 ≈3 (parallelizable). Total ≈ 18–25. Phases 0+1 alone are a shippable "Arclear Net v2" release and showcase resubmission moment.

## Constraints

- **Tech stack**: Foundry (`via_ir = true`) + viem-only SDK + npm/tsx/vitest/fast-check, zero-framework dashboard — carried from v1, fixed
- **Timeline**: Part-time; phase boundaries are the natural pause points
- **Compatibility**: `ClearingHub.sol` interface unchanged where touched (merkle root reuses the `manifestHash` bytes32 field); v1 stays live as Arclear Net
- **Protocol math**: No division anywhere in protocol math — bigint / int256 base units only
- **Security**: Withdrawal never pausable in ClearingHub; coordinator holds no keys/authority in the Net product
- **Testing discipline**: Shared TS↔Solidity digest fixtures for every new signed struct; explicit gas limits on all Arc writes

## Key Decisions

<!-- Fixed decisions from docs/V2-BRIEF.md §4 — do not relitigate. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Exclude-and-recompute, never outvote | A non-signer must never have their balance moved without consent; threshold applies to the candidate set, unanimity to the final set | — Pending |
| Sorted-leaf merkle for manifests | Cheap non-inclusion proofs (adjacent-leaf bracketing) needed for IOU redemption and exclusion recovery | — Pending |
| CCP is a separate contract + package | Novation/margin/waterfall each break a v1 invariant on purpose; two products share a settlement layer | — Pending |
| Standard waterfall order incl. operator skin-in-the-game | Deviating from the standard order without reason is a domain red flag; a CCP without SIG profits from under-margining | — Pending |
| Permissionless `declareDefault` | Removes operator discretion to hide a failure | — Pending |
| Procyclicality cap on IM | Trades solvency for stability; documented explicitly as the trade every real CCP wrestles with | — Pending |
| Uncalibrated risk parameters labeled as such | Honesty about calibration status is worth more than pretending; sweep harness is the natural backtest generator | — Pending |
| Calibration checkpoint between Phases 1 and 2 | Data gates CCP scope: what member count threshold consent unlocks, what q/N margin params survive p10 rounds | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-22 after Phase 1 completion*
