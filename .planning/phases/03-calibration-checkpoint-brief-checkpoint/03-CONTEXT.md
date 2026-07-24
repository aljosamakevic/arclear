# Phase 3: Calibration Checkpoint (brief checkpoint) - Context

**Gathered:** 2026-07-24 (auto mode — recommended options; user pre-authorized)
**Status:** Ready for planning

<domain>
## Phase Boundary

Empirical calibration data from the sweep harness. Two questions answered with numbers: (CALB-01) what member count threshold consent actually unlocks under realistic per-round uptime — realized compression after exclude-and-recompute, not idealized netting; (CALB-02) what q/N margin parameters would survive the p10 rounds, recorded for the reference brief. The original CCP go/revise gate was **resolved by user decision 2026-07-24 (CCP arc skipped)** — the sweep now documents the empirical basis and produces the showcase submission's headline table.

Requirements: CALB-01, CALB-02.

</domain>

<decisions>
## Implementation Decisions

### Simulation fidelity
- **D-01 Hybrid model:** the sweep runs a pure netting-level model of exclude-and-recompute (no timers, no async — deterministic and fast enough for 200 seeds/cell). Model rules MUST mirror `demo/coordinator.ts` `attemptRound` exactly: at each round, each member is online with probability p (seeded RNG); offline members' IOUs (as debtor OR creditor) drop; re-net over the survivors; if any pass-2 member would stall, the attempt aborts (model this as: sampled offline set is drawn once per round — pass-2 stalls approximated by an independent second draw only if measuring abort rate); fewer than 2 participants with nonzero deltas → no round; excluded/unsettled IOUs carry into the next round (never settle twice — consumed ids tracked).
- **D-02 Cross-validation:** one harness run drives the REAL `Coordinator.attemptRound` (injected providers, ms windows, in-memory chain stub or anvil) on a small subset of cells (e.g., n ∈ {5,15}, p ∈ {1.0, 0.9}, 10 seeds) and asserts the model's settled-volume/compression numbers match within tolerance. This is the faithfulness proof — without it the headline number is a model artifact.

### Parameter grid & metrics (CALB-01)
- **D-03 Grid:** n ∈ {5, 10, 15, 30, 50} × per-round uptime p ∈ {1.0, 0.97, 0.95, 0.9, 0.8} × reciprocity/density values reused from the existing v1 sweep (`demo/sweep.ts` / `demo/flowModel.ts`); 200 seeds per cell (matching v1 methodology so results are comparable).
- **D-04 Metrics per cell:** realized volume compression (settled net / gross, after exclusions); p10 worst-participant collateral saving; mean/95p excluded-paper settlement latency in rounds (CONS-04 carry-over cost); round abort rate; fraction of rounds settling with exclusions.
- **D-05 Headline output:** the "submission slide" table — realized compression and p10 saving at n=15/30/50 for p=0.95 and p=0.9, contrasted with the idealized (p=1.0) numbers from the v1 sweep.

### Margin analysis (CALB-02)
- **D-06 Method:** over the same simulated flow histories, compute each member's rolling peak intra-cycle net debit; apply `IM = q × EWMA(peak, lookback N)`; report coverage of the p99 realized debit for a grid of q ∈ {1.0, 1.25, 1.5, 2.0} × N ∈ {8, 16, 32}; note where a per-round IM rise cap (procyclicality) would bind under the stress ramp cells.
- **D-07 Status framing:** all outputs labeled UNCALIBRATED-INPUT-DATA — this is reference-brief material, not production calibration (CCP skipped; honesty convention carries over).

### Outputs
- **D-08 Artifacts:** `docs/sweep/threshold-sweep.csv` (full grid), `docs/sweep/margin-sweep.csv` (CALB-02 grid), and `docs/CALIBRATION.md` — headline table, methodology (model rules + cross-validation tolerance + seeds), the margin coverage table, and the recorded gate decision ("2026-07-24: CCP arc skipped by user decision; sweep documents the empirical basis").
- **D-09 No new deps, no protocol changes:** pure TS in `demo/`; existing `npm run sweep` entry point extended (new flags or a second script — Claude's discretion); protocol math conventions apply (bigint base units, no division in protocol paths — statistical division in reporting code is fine, matching the existing sweep's style).
- **D-10 Research step skipped:** pure in-repo simulation over existing modules; no unknowns warranting a researcher pass.

### Claude's Discretion
- Script layout (extend `demo/sweep.ts` vs sibling `demo/thresholdSweep.ts`), flag names, CSV schema details
- RNG (reuse existing seeded generator from flowModel)
- Cross-validation tolerance threshold and cell subset
- Whether the real-coordinator cross-check uses an in-memory settlement stub or anvil (stub preferred for speed if it can reuse `attemptRound` unmodified)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source
- `.planning/ROADMAP.md` Phase 3 section — success criteria (note: criterion 3's gate is pre-resolved, record the decision)
- `docs/V2-BRIEF.md` — calibration checkpoint intent; §2 domain insight (defaulter's position is a scalar debit)
- `.planning/PROJECT.md` — Context: the key empirical finding this sweep extends (compression saturates ~n=15–20 aggregate, p10 saving keeps climbing to 53% at n=50 — all at p=1.0)

### Code that changes / is modeled
- `demo/sweep.ts`, `demo/flowModel.ts` — existing sweep harness and synthetic flow generator (methodology to match: 200 seeds/cell)
- `demo/coordinator.ts` — `attemptRound` two-pass semantics the model must mirror (and cross-validate against)
- `src/netting.ts` — `net()` with `settledIds`/`redeemedIds` opts
- `docs/sweep/` — existing v1 sweep outputs (baseline for the p=1.0 comparison)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `demo/flowModel.ts` — parameterized synthetic flow generator (reciprocity × density × n) with seeded determinism
- `demo/sweep.ts` — statistical sweep loop + CSV emission pattern
- `net()` — the pure engine; exclusion model = filter + re-net (same composition Phase 1 used)
- `Coordinator.attemptRound` — injectable consent providers make the cross-validation harness cheap

### Established Patterns
- 200 seeds/cell methodology; CSV to `docs/sweep/`
- Honesty labeling (UNCALIBRATED) on every risk number

### Integration Points
- `package.json` `sweep` script; `docs/CALIBRATION.md` is new
</code_context>

<specifics>
## Specific Ideas

- The headline table is the point (strategy discussion 2026-07-23/24): "under realistic agent uptime, threshold consent still delivers N% at n=50" — or honestly reports that it doesn't. Either result is the deliverable; do not massage parameters to flatter the number.
- Frame in CALIBRATION.md: this sweep exists because unanimity's idealized numbers were never the real numbers — exclude-and-recompute's realized compression is.

</specifics>

<deferred>
## Deferred Ideas

None — CCP calibration consumers were removed from the roadmap; margin data is recorded for the brief only.

</deferred>

---

*Phase: 3-Calibration Checkpoint (brief checkpoint)*
*Context gathered: 2026-07-24 via --auto (single pass)*
