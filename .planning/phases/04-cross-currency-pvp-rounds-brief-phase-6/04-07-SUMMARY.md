---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 07
subsystem: docs-and-deploy
tags: [protocol-docs, threat-model, arc-testnet, deploy, pvp]

# Dependency graph
requires:
  - phase: 04-cross-currency-pvp-rounds-brief-phase-6 (plans 04-01..04-06)
    provides: "full PvP stack green (116 vitest / 101 forge / e2e both-or-neither) before broadcast"
provides:
  - "docs/PROTOCOL.md 'Cross-currency PvP rounds' section (verbatim typehash, atomicity argument, executePvP gas rows, third superseded non-goal note)"
  - "docs/THREAT-MODEL.md rows 21-26 + mempool-extraction/single-leg known-limitation row citing test_singleLegDirectSubmissionSettles"
  - "PvPRouter live on Arc Testnet: 0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c (Blockscout source verified; immutables cast-verified against README hub table)"
  - "contracts/script/DeployPvPRouter.s.sol; README router table row; miniature-CLS notes in README + CONCEPTS.md"
affects: [showcase-submission, milestone-close]

# Tech tracking
tech-stack:
  added: []
  patterns: ["full local gate green before broadcast (third application)"]

key-files:
  created: [contracts/script/DeployPvPRouter.s.sol, contracts/broadcast/DeployPvPRouter.s.sol/5042002/run-latest.json]
  modified: [docs/PROTOCOL.md, docs/THREAT-MODEL.md, docs/CONCEPTS.md, README.md]

key-decisions:
  - "FX rate documented as agreed-not-oracle-derived; unanimous consent bounds manipulation"
  - "Single-leg limitation stated plainly: degrades to ordinary collateralized credit risk, never unsigned movement — machine-cited"

requirements-completed: [PVP-01, PVP-02]

# Human verification
checkpoint:
  type: human-verify
  verified-by: user
  verified-on: 2026-07-24
  evidence: "User replied 'approved' to the final checkpoint (arcscan verification, suites, e2e walkthrough, docs honesty review)"
---

# Plan 04-07 Summary — PvP Docs + Arc Testnet Router Deploy

Executed as commits `c75cba4` (docs) and `6894952` (deploy) with the checkpoint approved by the user 2026-07-24. Full local gate (116 vitest / 101 forge / e2e:anvil incl. both negative variants) was green before broadcast; router deployed with `--with-gas-price 25gwei`, tx `0x6e304c0d…9593a`; `hubUSDC()`/`hubEURC()` cast-reads match the README V2 hub table exactly; Blockscout source verification passed. Written post-hoc by the orchestrator from verified commit evidence (checkpoint return preceded SUMMARY per plan design).
