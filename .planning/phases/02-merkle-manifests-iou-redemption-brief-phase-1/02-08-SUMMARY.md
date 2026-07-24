---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 08
subsystem: docs-and-deploy
tags: [protocol-docs, threat-model, arc-testnet, deploy, redemption]

# Dependency graph
requires:
  - phase: 02-merkle-manifests-iou-redemption-brief-phase-1 (plans 02-01..02-07)
    provides: "full merkle + redemption stack, green local gate before broadcast"
provides:
  - "docs/PROTOCOL.md merkle-manifest spec (not-RFC-6962 warning, position-binding soundness) + IOU-redemption section ('collateralized recovery path')"
  - "docs/THREAT-MODEL.md rows 14-20 (second-preimage, double-claim both directions, keep-alive griefing, withdraw race, proof TOCTOU)"
  - "Current V2 hubs on Arc Testnet: USDC 0x3b9a9617b91589a15a14122183e6305d9f0a5a16, EURC 0xECccD7e43b0CaF4D81420483dEe20E5E258fB85E (K=3, RING=16, L=86400 — UNCALIBRATED)"
  - "README three-generation hub lineage (v1 live, Phase-1 V2 superseded, current v2)"
affects: [03-calibration, showcase-submission]

# Tech tracking
tech-stack:
  added: []
  patterns: ["full local gate (vitest + forge + e2e:anvil) green before any testnet broadcast"]

key-files:
  created: [contracts/broadcast/DeployV2.s.sol/5042002/run-1784888301724.json, contracts/broadcast/DeployV2.s.sol/5042002/run-1784888317489.json]
  modified: [docs/PROTOCOL.md, docs/THREAT-MODEL.md, README.md]

key-decisions:
  - "Redemption framed as what makes 'a tab with a limit' honest — participant #2's day-one story"
  - "Measured gas table published in PROTOCOL.md (executeRound m∈{10,105,250}, redeemIOU RING=16)"

requirements-completed: [MERK-01, MERK-02, MERK-03, MERK-04]

# Human verification
checkpoint:
  type: human-verify
  verified-by: user
  verified-on: 2026-07-24
  evidence: "User reviewed checkpoint presentation (addresses, docs, e2e instructions) and directed work to proceed past it (complete phase 3 / skip 4-7 / complete phase 8)"
---

# Plan 02-08 Summary — Docs + Arc Testnet Redeploy

Executed as commits `04e0063` (docs) and `ffa3be2` (deploys) before a session restart interrupted the agent's checkpoint return; the orchestrator recovered the committed work from the worktree, verified deployments via `cast code` + arcscan API, and presented the checkpoint. Both hubs live and source-verified; local gate (64 vitest / 81 forge / e2e:anvil incl. redemption scenario) was green before broadcast. Written post-hoc by the orchestrator from verified commit evidence.
