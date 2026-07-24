# Arclear — Permissionless Netting Primitive on Arc

## What This Is

Arclear is a **permissionless multilateral obligation-netting clearinghouse primitive for any ERC-20 on Arc**: parties accumulate signed EIP-712 IOUs off-chain (a tab, with a limit), then settle only the net residual from pre-posted collateral — atomically, under consent, in one transaction, even when members stall or vanish. v2.0 shipped the complete primitive: threshold consent (liveness through member failure), merkle manifests + on-chain IOU redemption (provable, recoverable claims), honest calibration data, and atomic cross-currency PvP. It serves Arc builders running agent swarms that transact bidirectionally at high frequency, showcase reviewers, and integrators who want netting as an `npm install`-able building block.

## Core Value

The system keeps settling when members stall or go dark — with every risk mechanism (threshold consent, collateralized redemption, credit caps) legible, invariant-tested, and honest about its calibration status. Working capital moves from turnover-sized to exposure-sized without a trusted operator.

## Current State (v2.0 shipped 2026-07-24)

- **Live on Arc Testnet (chain 5042002, all Blockscout source-verified):** ClearingHubV2 USDC `0x3b9a9617b91589a15a14122183e6305d9f0a5a16`, EURC `0xECccD7e43b0CaF4D81420483dEe20E5E258fB85E`, PvPRouter `0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c`; v1 hubs remain live as Arclear Net v1.
- **Codebase:** viem-only TS SDK (`src/`) + Foundry contracts; 120 vitest + 101 forge tests, 3 e2e scenarios; TS↔Solidity digest fixtures for every signed struct (Round, IOU, PvPRound); measured-gas formulas on every Arc write.
- **Calibration record (`docs/CALIBRATION.md`):** practical unlock under the 2-pass abort cap is n≈15 at 90% / n≈30 at 95% per-round uptime; no q×N EWMA margin combo covers the p99 debit — both labeled UNCALIBRATED-INPUT-DATA.
- **Positioning (README/CONCEPTS):** differentiates on bilateral credit + float vs Gateway's unidirectional prepay; two-layer capital model; honest-calibration voice throughout.

## Requirements

### Validated

<!-- Arclear v1 — shipped, deployed, source-verified. -->
- ✓ Collateral vault + atomic netting rounds under unanimous EIP-712 consent (`contracts/src/ClearingHub.sol`) — v1
- ✓ viem SDK: IOU + consent signing, deterministic netting engine, bilateral credit caps, typed client — v1
- ✓ 5-agent demo swarm + coordinator + zero-framework dashboard — v1
- ✓ Deployed v1 USDC/EURC hubs with real settlement: 105 IOUs → 1 tx, 92.3% compression — v1
- ✓ Empirical sweep harness (200 seeds/cell) — v1

<!-- Arclear v2.0 — shipped 2026-07-24. -->
- ✓ Threshold consent: exclude-and-recompute rounds settle through unresponsive members; 2-pass cap; griefing bound documented (CONS-01..06) — v2.0
- ✓ Merkle manifests + `redeemIOU` collateralized recovery path with nullifiers and redeem↔net exclusivity (MERK-01..04) — v2.0
- ✓ Calibration: threshold-consent-under-uptime + margin-parameter sweeps, cross-validated exactly against the real coordinator (CALB-01..02) — v2.0
- ✓ Cross-currency PvP: atomic USDC+EURC legs via stateless router; FX rate signed into the parity-locked consent digest (PVP-01..02) — v2.0

### Active

<!-- Next milestone not yet defined — run /gsd:new-milestone. Candidates: -->
- [ ] npm packaging of the SDK + integrator quickstart (started post-v2.0 as ad-hoc work)
- [ ] CI pipeline — digest-parity fixtures currently regress only via manual runs
- [ ] Showcase submission assembly (Net v2 + calibration slide + V2-BRIEF as vision artifact)

### Out of Scope

- Mainnet deployment — testnet reference implementation only
- Real-money custody — same
- Calibrated production risk parameters — production needs backtesting; parameters deliberately labeled uncalibrated (v2.0 sweep data confirms the proposed EWMA margin estimator fails tail coverage — see docs/CALIBRATION.md)
- UI beyond the existing dashboard pattern — not the point of the project
- Fee-on-transfer tokens — out of protocol scope
- The CCP arc (novation, margin, default waterfall, membership) — removed 2026-07-24: a reference implementation, not a primitive; docs/V2-BRIEF.md remains the vision artifact, and the calibration data doubly vindicated the skip (large-n liveness + margin-estimator findings)

## Context

- **Branches:** `v1` frozen showcase snapshot; `main` carries v2.0 (tagged).
- **Key empirical findings:** compression needs no bilateral reciprocity at n≥5; p10 collateral saving climbs with n (33% at n=15, 53% at n=50 idealized) — but under realistic uptime the 2-pass abort cap binds first: n≈15 at p=0.9, n≈30 at p=0.95 (docs/CALIBRATION.md). Relaxing the cap is the documented lever for larger n.
- **Domain insight:** in a payments context the defaulter's position is a scalar debit in a stable unit — no volatile mark, no auction, no hedging. Loss = uncovered debit.
- **Arc environment:** chain 5042002, RPC via `ARC_RPC_URL`, explorer `https://testnet.arcscan.app` (Blockscout, `--with-gas-price 25gwei`). **Gas-token gotcha:** USDC is both native gas token and ERC-20 at `0x3600…0000` — always set explicit `gas` limits on writes.
- **Docs:** `README.md` (landing), `docs/CONCEPTS.md` (conceptual companion), `docs/PROTOCOL.md` (normative spec), `docs/THREAT-MODEL.md`, `docs/CALIBRATION.md` (empirical record), `docs/V2-BRIEF.md` (CCP vision artifact).

## Constraints

- **Tech stack**: Foundry (`via_ir = true`) + viem-only SDK + npm/tsx/vitest/fast-check, zero-framework dashboard — fixed
- **Compatibility**: v1 stays live as Arclear Net v1; deployed v2 contracts (hubs, router) are final — SDK-side fixes only
- **Protocol math**: No division anywhere in protocol math — bigint / int256 base units only
- **Security**: Withdrawal never pausable; coordinator holds no keys/authority
- **Testing discipline**: Shared TS↔Solidity digest fixtures for every signed struct; explicit measured gas on all Arc writes
- **Voice**: honest-calibration tone in all public docs — measured numbers, named caveats, no overclaim

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Exclude-and-recompute, never outvote | A non-signer must never have their balance moved without consent | ✓ Good — shipped v2.0; griefing bound held in e2e + calibration |
| Sorted-leaf merkle for manifests | Cheap non-inclusion proofs for redemption | ✓ Good — byte-parity locked, redemption e2e-proven |
| Calibration checkpoint gates CCP scope | Data before code | ✓ Good — data confirmed the skip (abort cap + margin estimator findings) |
| Uncalibrated risk parameters labeled as such | Honesty over pretending | ✓ Good — became the docs' brand voice |
| CCP arc skipped (2026-07-24) | Reference implementation ≠ primitive; positioning review + sweep data | ✓ Good — v2.0 shipped focused; V2-BRIEF is the vision artifact |
| Stateless PvP router, hubs untouched | Tx atomicity gives both-or-neither free; immutables kill hub substitution | ✓ Good — deployed; single-leg limitation honestly documented |
| CCP-specific decisions (waterfall order, permissionless declareDefault, procyclicality cap) | From V2-BRIEF §4 | — Not exercised (CCP skipped); preserved in the brief |

## Evolution

This document evolves at phase transitions and milestone boundaries (see prior version in `.planning/milestones/` context via git history).

---
*Last updated: 2026-07-24 after v2.0 milestone*
