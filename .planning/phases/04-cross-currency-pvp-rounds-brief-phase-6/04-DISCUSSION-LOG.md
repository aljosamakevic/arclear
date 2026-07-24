# Phase 4: Cross-Currency PvP Rounds - Discussion Log

> **Audit trail only.** Auto mode — user pre-authorized ("Complete phase 8", renumbered to 4, 2026-07-24). No interactive questions.

**Date:** 2026-07-24
**Areas (auto):** Atomicity mechanism, FX rate binding, Leg construction, Deployment & demo

| Area | Auto-selected (recommended) | Alternatives considered |
|------|-----------------------------|-------------------------|
| Atomicity | Stateless PvPRouter calling both hubs' executeRound in one tx (tx atomicity = both-or-neither); hubs untouched | Hub modifications for cross-hub awareness (interface churn, redeploy); stateful escrow (needless custody) |
| FX binding | New EIP-712 PvPRound struct (both leg digests + fx num/den) signed by union set, router-verified; fixture obligation honored | Rate folded into leg manifests (pollutes Round struct); off-chain-only rate (fails PVP-02's "signed into consent digest") |
| Legs | Ordinary rounds per hub via existing machinery; PvP layer wraps two proposals + rate; leg abort aborts the bundle | Custom PvP-specific netting (needless divergence) |
| Deploy/demo | Router to Arc testnet, V2 hubs reused; e2e proves both-or-neither incl. sabotaged-leg negative case; minimal dashboard | Full FX UI (out of scope per PROJECT.md) |

Research runs for this phase (new signed struct + cross-contract atomicity + arc-stablecoin-fx tie-in are genuine unknowns).
