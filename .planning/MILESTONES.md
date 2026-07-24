# Milestones

## v2.0 Clearing Primitive (Shipped: 2026-07-24)

**Phases completed:** 4 phases, 23 plans (~80 tasks)
**Timeline:** 2026-07-22 → 2026-07-24 · 164 commits · 122 files changed, +22,222 / −400 lines
**Delivered:** The complete permissionless netting primitive on Arc Testnet — liveness through member failure, provable + recoverable claims, honest calibration data, and atomic cross-currency PvP — plus the positioning pivot that reframed the product around bilateral credit ("a tab with a limit").

**Key accomplishments:**

1. **Threshold consent (Phase 1):** exclude-and-recompute two-pass rounds settle through unresponsive members — unanimity over the final executed set, hard 2-pass cap, griefing bound ("a latency cost, never a safety cost") proven and documented; `ClearingHubV2` deployed with digest parity to v1.
2. **Merkle manifests + redemption (Phase 2):** sorted-leaf merkle roots in the same `bytes32` field with TS↔Solidity byte-parity; `redeemIOU` gives creditors a collateralized recovery path against dark debtors (nullifiers, bidirectional redeem↔net exclusivity, L-bounded coverage rule); redemption-capable hubs live and source-verified.
3. **Calibration (Phase 3):** exclusion-aware sweep model cross-validated against the real coordinator with exact bigint equality; honest findings — practical unlock n≈15 at 90% / n≈30 at 95% per-round uptime, and no q×N EWMA margin combo covers the p99 debit — both recorded in docs/CALIBRATION.md with the CCP-skip gate decision.
4. **Cross-currency PvP (Phase 4):** stateless `PvPRouter` composes both hubs atomically (both legs or neither, proven from chain state); per-round FX rate signed into the parity-locked `PvPRound` EIP-712 struct; single-leg limitation machine-documented; router live and source-verified.
5. **Strategic pivot (2026-07-24):** CCP arc (former Phases 4–7) removed by user decision after external review + sweep data — the CCP is a reference implementation, not a primitive; `docs/V2-BRIEF.md` remains its vision artifact.
6. **Positioning revision:** defensible Gateway framing (unidirectional+prepaid vs multilateral+on-credit), two-layer capital model, docs/CONCEPTS.md, use-case table — every risk number labeled UNCALIBRATED, every limitation stated plainly.

**Live contracts (Arc Testnet, chain 5042002, all Blockscout source-verified):**
- ClearingHubV2 USDC `0x3b9a9617b91589a15a14122183e6305d9f0a5a16` · EURC `0xECccD7e43b0CaF4D81420483dEe20E5E258fB85E` · PvPRouter `0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c` (v1 hubs remain live as Arclear Net v1)

**Quality gates:** 120 vitest + 101 forge tests, 3 e2e scenarios, 4 phase code reviews (all findings fixed, incl. 2 critical SDK vulnerabilities caught pre-close), 4 independent verifications (all passed).

Known deferred items at close: 0 (audit-open clear). Full details: `.planning/milestones/v2.0-ROADMAP.md`.

---
