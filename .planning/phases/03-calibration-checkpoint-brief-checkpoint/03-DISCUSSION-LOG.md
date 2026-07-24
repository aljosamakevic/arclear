# Phase 3: Calibration Checkpoint - Discussion Log

> **Audit trail only.** Auto mode — user pre-authorized recommended options ("Complete phase 3 / Skip phases 4-7 / Complete phase 8", 2026-07-24). No interactive questions asked.

**Date:** 2026-07-24
**Areas (auto):** Simulation fidelity, Parameter grid & metrics, Margin analysis scope, Output artifacts

| Area | Auto-selected (recommended) | Alternatives considered |
|------|-----------------------------|-------------------------|
| Fidelity | Pure netting-level model mirroring attemptRound rules + cross-validation against the real coordinator on a cell subset | Full real-coordinator sweep (too slow for 200 seeds/cell); model-only (headline number would be unvalidated) |
| Grid | n∈{5,10,15,30,50} × p∈{1.0,0.97,0.95,0.9,0.8} × existing reciprocity/density, 200 seeds/cell | Smaller grid (loses the submission table); adaptive sampling (overkill) |
| Margin | EWMA q×N coverage of p99 debit over sweep histories, labeled uncalibrated-input-data | Skip CALB-02 entirely (user said complete phase 3 as scoped; data still feeds the reference brief) |
| Outputs | threshold-sweep.csv + margin-sweep.csv + docs/CALIBRATION.md with recorded gate decision | Dashboard visualization (out of scope) |

**Gate note:** the phase's original go/revise decision was made by the user before execution (CCP skipped); the sweep documents the basis. Research step skipped (D-10): pure in-repo simulation.
