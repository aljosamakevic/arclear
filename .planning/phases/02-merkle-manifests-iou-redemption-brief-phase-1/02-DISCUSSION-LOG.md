# Phase 2: Merkle Manifests & IOU Redemption - Discussion Log

> **Audit trail only.** Auto mode (`--auto --chain`) — user pre-authorized recommended options ("keep building while I'm asleep", 2026-07-23). No interactive questions asked.

**Date:** 2026-07-22
**Phase:** 2-Merkle Manifests & IOU Redemption (brief Phase 1)
**Areas discussed (auto):** Merkle construction rules, Unresponsiveness flagging, Contract versioning, Fixtures & tests

---

## Auto-selected decisions

| Area | Question | Auto-selected (recommended) | Alternatives considered |
|------|----------|-----------------------------|-------------------------|
| Merkle rules | Pair hashing scheme | Ordered concat keccak256 (bracketing needs positions) | Commutative sorted-pair (OZ-style — breaks non-inclusion) |
| Merkle rules | Odd-node handling | Promote lone node | Duplicate (ambiguous trees) |
| Merkle rules | Empty manifest | Keep v1 `keccak256("0x")` sentinel | New sentinel (breaks compat) |
| Flagging | How does the chain know a debtor missed K windows? | On-chain `lastParticipation` written in executeRound; no coordinator authority | Coordinator attestation (violates zero-authority constraint); oracle |
| Flagging | Root history | Ring buffer of last k=16 roots, K=3 windows, both uncalibrated params | Unbounded mapping (state growth); events-only (not provable on-chain) |
| Versioning | Where does redeemIOU live? | Extend ClearingHubV2.sol in place; redeploy at phase end | New ClearingHubV3 file (needless lineage churn); v1 (frozen) |
| Fixtures | Parity strategy | Shared merkle fixture file + Foundry parity test (digest-parity pattern) | Independent test vectors per side (drift risk) |

## Claude's Discretion

Domain-separation scheme, proof encoding, ring buffer layout, gas measurement, IOU-expiry/redemption-window interaction (flagged as a research question).

## Deferred Ideas

K/k calibration → Phase 3 sweep.
