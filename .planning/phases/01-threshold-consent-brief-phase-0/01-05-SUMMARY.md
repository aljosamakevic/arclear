---
phase: 01-threshold-consent-brief-phase-0
plan: 05
subsystem: docs-and-deploy
tags: [protocol-docs, threat-model, arc-testnet, deploy, threshold-consent]

# Dependency graph
requires:
  - phase: 01-threshold-consent-brief-phase-0 (plan 01-02)
    provides: "contracts/script/DeployV2.s.sol + ClearingHubV2.sol (deploy artifacts)"
  - phase: 01-threshold-consent-brief-phase-0 (plan 01-04)
    provides: "e2e liveness scenario green before any broadcast (phase gate)"
provides:
  - "docs/PROTOCOL.md 8-rule threshold-consent section + griefing analysis (CONS-05, D-16)"
  - "docs/THREAT-MODEL.md reconciled: unresponsive-member row shipped-in-v2, refusal ≠ miss terminology"
  - "ClearingHubV2 USDC hub live on Arc Testnet: 0xa984c64e1eA12B5aF5F573d58C3483fB8aB47f3c (Blockscout-verified)"
  - "ClearingHubV2 EURC hub live on Arc Testnet: 0x57A047599EaCDbe77Cc8C1A7978f88D700332Cb3 (Blockscout-verified)"
  - "README hub table lists v2 hubs alongside live v1 hubs (D-12: v1 stays live)"
affects: [02-merkle-manifests, calibration-checkpoint, showcase-resubmission]

# Tech tracking
tech-stack:
  added: []
  patterns: ["forge script --broadcast with explicit --with-gas-price 25gwei on Arc (min base fee 20 gwei)"]

key-files:
  created: [contracts/broadcast/DeployV2.s.sol/5042002/run-latest.json]
  modified: [docs/PROTOCOL.md, docs/THREAT-MODEL.md, README.md]

key-decisions:
  - "Griefing analysis states the acceptance bar verbatim: repeated refusal is 'a latency cost, never a safety cost' — worst case two signature-collection passes per attempt"
  - "PROTOCOL.md documents the shared-roundNonce argument: at most one of the two fully-signed passes can execute on-chain"
  - "Only two testnet transactions broadcast (the two contract creations); v1 hubs untouched"

patterns-established:
  - "Deploy gate ordering: full local suite + e2e liveness green BEFORE any testnet broadcast"

requirements-completed: [CONS-05, CONS-06]

# Human verification
checkpoint:
  type: human-verify
  verified-by: user
  verified-on: 2026-07-23
  evidence: "User confirmed arcscan verification, dashboard exclusion-round demo (stall → rebuild → pass-2 → re-settle), and PROTOCOL.md griefing analysis"
---

# Plan 01-05 Summary — Docs, Griefing Analysis, and Arc Testnet V2 Deploy

Documented the threshold-consent protocol and closed the phase with live testnet deployments.

## What was done

1. **docs/PROTOCOL.md** (`dd184ca`) — new 8-rule "Threshold consent" section: candidate set vs final executed set, one-batch exclusion at the deadline snapshot, ≥2 quorum floor, hard two-pass cap, out-of-band deadline metadata, refusal ≠ miss, unconditional re-inclusion. Griefing analysis proves the two-pass latency bound and the shared-roundNonce single-execution property. The v1 "No threshold consent" non-goal is superseded.
2. **docs/THREAT-MODEL.md** (`dd184ca`) — unresponsive-member threat row updated to shipped-in-v2; limitations table reconciled with refusal-for-cause vs timeout-miss terminology.
3. **Arc Testnet deploys** (`8c43839`) — `DeployV2.s.sol` broadcast twice with `--with-gas-price 25gwei`:
   - USDC hub `0xa984c64e1eA12B5aF5F573d58C3483fB8aB47f3c` — `cast code` confirmed, Blockscout source verified
   - EURC hub `0x57A047599EaCDbe77Cc8C1A7978f88D700332Cb3` — `cast code` confirmed, Blockscout source verified
   - README hub table updated; broadcast records committed.
4. **Human verification (task 3)** — user confirmed the live deployment, the dashboard exclusion-round demo, and the griefing-analysis prose (2026-07-23).

## Verification evidence

- Full local gate before broadcast: 38 vitest + 27 forge tests + `npm run e2e:anvil` liveness scenario, all green
- `grep 'a latency cost, never a safety cost' docs/PROTOCOL.md` — present
- Both hub addresses live and source-verified on https://testnet.arcscan.app

## Deviations

None.
