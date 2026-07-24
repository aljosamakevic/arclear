---
phase: 03-calibration-checkpoint-brief-checkpoint
verified: 2026-07-24T16:50:00Z
status: passed
score: 16/16 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 3: Calibration Checkpoint Verification Report

**Phase Goal:** Empirical calibration data — the sweep answers what member count threshold consent actually unlocks under realistic uptime (the submission slide) and what q/N margin parameters would survive p10 rounds (recorded for the reference brief). The CCP go/revise gate was pre-resolved (2026-07-24: CCP arc skipped); the decision must be RECORDED with supporting data.
**Verified:** 2026-07-24
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Merged from ROADMAP Success Criteria (SC1–SC3) and PLAN frontmatter must_haves (03-01 t1–t5, 03-02 t1–t4, 03-03 t1/t2/t4/t5; 03-03 t3 dedupes into SC3).

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1 | SC1: sweep simulates threshold-consent rounds with unresponsive members and answers what member count is actually unlocked | ✓ VERIFIED | `demo/thresholdSweep.ts` (288 lines) + committed `docs/sweep/threshold-sweep.csv` (501 lines, 5n × 5p × 20 combos, seeds=200 all rows); CALIBRATION.md §2 gives the explicit answer: n≈15 at p=0.9, n≈30 at p=0.95; n=50 at p≤0.9 stalls (abort_rate 0.9860, unsettled 0.9491 — verified in CSV row). D-09 sanctioned sibling script satisfies the `demo/sweep.ts` wording; v1 sweep untouched |
| 2 | SC2: sweep simulates margin/undercollateralization and answers what q/N parameters survive p10/p99 rounds | ✓ VERIFIED | `demo/marginSweep.ts` (271 lines) + `docs/sweep/margin-sweep.csv` (145 lines, 12 flow cells × 12 q/N combos, seeds=200/rounds=64 all rows, 36 ramp rows); CALIBRATION.md §5 answer: no q≤2 debit-EWMA covers the p99 tail (p99_tail_coverage = 0.0000 in all 144 rows — independently confirmed) |
| 3 | SC3: CCP gate decision recorded verbatim with supporting data | ✓ VERIFIED | `docs/CALIBRATION.md` §6 "Decision record (D-08)" contains verbatim "2026-07-24: CCP arc skipped by user decision; sweep documents the empirical basis" — grep count exactly 1; supporting data = both committed CSVs referenced throughout |
| 4 | 03-01: model simulates exclude-and-recompute histories (exclusion, drop, re-net, carry-over, never-settle-twice) | ✓ VERIFIED | `demo/thresholdModel.ts` 262 lines, mirrors attemptRound's 5 branches; 7 behavior tests + never-twice property green; REVIEW.md line-by-line faithfulness check confirmed |
| 5 | 03-01: p=1.0 degenerates to plain net() | ✓ VERIFIED | Behavior test + fc property 4; cross-validation p=1.0 cells settle 1-pass with exact volume equality (ran green) |
| 6 | 03-01: seeded determinism (byte-identical histories) | ✓ VERIFIED | fc determinism property green; all randomness via `rng(seed ^ 0x5eed)` / `deriveRoundSeed`; no Math.random, Date.now only in log lines |
| 7 | 03-01: zero-sum settled deltas | ✓ VERIFIED | fc property 1 green (exact 0n sum) |
| 8 | 03-01: round-unique IOU ids across a history | ✓ VERIFIED | `roundFlowBatch` rewrites high 8 nibbles with round index; unit + fc property green |
| 9 | 03-02: real attemptRound cross-validation matches model EXACTLY (bigint equality) | ✓ VERIFIED | Ran `npm test`: `test/thresholdCrossValidation.test.ts` 5/5 green in 39s; imports `attemptRound` from ../demo/coordinator.js and `signConsent` from ../src/round.js; 0 `toBeCloseTo`; WR-04 fix added excluded-set membership + per-member delta Map assertions (test:155-176) |
| 10 | 03-02: sweep:threshold writes full D-03 grid CSV | ✓ VERIFIED | `package.json` has `sweep:threshold`; CSV structurally verified: 501 lines, header 15 columns verbatim, 100 rows per n and per p, 20 unique (density,reciprocity) combos, seeds=200 and rounds_per_seed=10 in all 500 data rows |
| 11 | 03-02: every D-04 metric is a CSV column | ✓ VERIFIED | Header contains median/p10 compression, median/p10 worst saving, mean/p95 latency, abort_rate, exclusion_round_fraction, unsettled_fraction — verbatim match to plan |
| 12 | 03-02: console prints D-05 headline table | ✓ VERIFIED | `demo/thresholdSweep.ts:246-264` unconditional end-of-run headline block (n 15/30/50 × p 1.0/0.95/0.9 + v1 baseline); full sweep not re-run per verification constraints (~50 min) — committed full-run CSV is the execution evidence |
| 13 | 03-03: margin sweep answers CALB-02 with q/N coverage incl. p99 tail and stress-ramp cap binding | ✓ VERIFIED | 144 data rows; 12 q/N combos present; 3 ramp cell-groups (36 rows) with p_or_ramp="ramp-1.0-0.8" reporting cap_binding_fraction; sanity ordering q=2.0/N=8 > q=1.0/N=32 strict in 11/12 cells (acceptance floor 10) — recomputed from CSV, matches SUMMARY claim |
| 14 | 03-03: CALIBRATION.md contains the D-05 headline table | ✓ VERIFIED | §2 table present; all 9 headline cells + all 6 companion rows spot-checked cell-by-cell against threshold-sweep.csv — exact match (e.g. n=30/p=0.95: 0.9342/0.4205; n=50/p=0.9: 0.9574/0.5256); v1 baseline numbers match docs/sweep/sweep.csv (0.8522/0.3248, 0.8962/0.4413, 0.9206/0.5309) |
| 15 | 03-03: every risk number carries UNCALIBRATED label | ✓ VERIFIED | "UNCALIBRATED" appears 7 times: banner + captions on §2 (×2), §4, §5 (×2), procyclicality paragraph |
| 16 | 03-03: full suite green and both sweep scripts complete end-to-end | ✓ VERIFIED | Ran `npm test`: 83/83 green; `npx tsc --noEmit` clean; both scripts fully wired (marginSweep consumes `ThresholdRoundRecord.deltas`, thresholdSweep consumes `outflows`); committed full-run CSVs are the end-to-end completion evidence; --quick runs deliberately not re-executed (they overwrite committed CSVs by design) |

**Score:** 16/16 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `demo/thresholdModel.ts` | min 120 lines, 7 exports | ✓ VERIFIED | 262 lines; exactly the 7 contracted exports (3 interfaces + 4 functions); imports confined to viem types / ../src / ./flowModel (D-09) |
| `test/thresholdModel.test.ts` | min 100 lines, 7 fc.assert | ✓ VERIFIED | 347 lines; fc.assert count = 7; 14 tests green |
| `test/thresholdCrossValidation.test.ts` | min 100 lines, real attemptRound | ✓ VERIFIED | 232 lines; 5/5 green in 39s (under 3-min budget); refused-empty assertion present |
| `demo/thresholdSweep.ts` | min 100 lines, grid driver | ✓ VERIFIED | 288 lines; WR-01 NaN empty-sample markers and WR-02 --rounds guard applied |
| `docs/sweep/threshold-sweep.csv` | 501 lines, contains "n,p,density,reciprocity" | ✓ VERIFIED | 501 lines; header verbatim; grid complete; only all-zero rows are the 16 documented n=50/p=0.8 imputed cells (confirmed no other corruption) |
| `demo/marginSweep.ts` | min 100 lines | ✓ VERIFIED | 271 lines; --rounds guard + 64-round floor |
| `docs/sweep/margin-sweep.csv` | 145 lines, contains "q,ewma_lookback" | ✓ VERIFIED | 145 lines; 12-column header verbatim; seeds=200/rounds=64 uniform |
| `docs/CALIBRATION.md` | all sections + gate string | ✓ VERIFIED | 209 lines; banner + §1–§6 all present; gate string ×1; UNCALIBRATED ×7; WR-01 data-notes and WR-03 carry-over relabel applied |
| `package.json` scripts | sweep:threshold, sweep:margin | ✓ VERIFIED | Both present (lines 18–19) |

### Key Link Verification

| From | To  | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| demo/thresholdModel.ts | src/netting.ts | net() per attempt/rebuild | ✓ WIRED | import line 2 |
| demo/thresholdModel.ts | demo/flowModel.ts | generateFlows/rng/addr | ✓ WIRED | import line 4 (addr exported in 03-01, documented deviation) |
| test/thresholdCrossValidation.test.ts | demo/coordinator.ts | drives real attemptRound | ✓ WIRED | import + call site test:132 |
| test/thresholdCrossValidation.test.ts | demo/thresholdModel.ts | replays availabilityUniforms/roundFlowBatch | ✓ WIRED | imports + test:81 |
| demo/thresholdSweep.ts | demo/thresholdModel.ts | simulateThresholdHistory per cell/seed | ✓ WIRED | import:41, call:133 |
| demo/marginSweep.ts | demo/thresholdModel.ts | deltas debit series | ✓ WIRED | import:50, call:143, deltas read:155 |
| package.json | both sweep scripts | npm scripts | ✓ WIRED | tsx entries present |
| docs/CALIBRATION.md | threshold-sweep.csv | transcribed numbers | ✓ WIRED | All 9 headline + 6 companion cells match CSV exactly |
| docs/CALIBRATION.md | margin-sweep.csv | transcribed numbers | ✓ WIRED | Both n=30 grids (24 cells), p99 debits, cap_binding values match CSV exactly |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| threshold-sweep.csv | 500 data rows | full 200-seed sweep run | Yes — non-trivial distributions; only documented n=50/p=0.8 rows imputed | ✓ FLOWING |
| margin-sweep.csv | 144 data rows | full 200-seed × 64-round run | Yes — coverage varies by q/N/cell as expected; sparse cells disambiguated by p99_debit=0 | ✓ FLOWING |
| CALIBRATION.md tables | every cited number | committed CSVs | Yes — verbatim transcription verified cell-by-cell | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Type check clean | `npx tsc --noEmit` | clean | ✓ PASS |
| Full suite incl. cross-validation | `npm test` | 83/83 green, 40.2s | ✓ PASS |
| WR-02 guard rejects bad --rounds before CSV write | `npm run sweep:threshold -- --rounds ten` | throws "--rounds requires a positive integer"; `git status docs/sweep/` clean afterward | ✓ PASS |
| Sanity ordering q=2.0/N=8 > q=1.0/N=32 | awk recompute over margin CSV | 11/12 strict (floor 10) | ✓ PASS |
| p99_tail_coverage = 0 everywhere claim | awk over margin CSV | 0 nonzero rows of 144 | ✓ PASS |
| Full sweeps (~50 min each) | — | not re-run per verification constraints; committed CSVs structurally verified instead | ? SKIP |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist in this repository and none are declared by the phase plans. SKIPPED (no probes).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| CALB-01 | 03-01, 03-02 | Sweep simulates threshold-consent rounds with unresponsive members — answers what member count is actually unlocked | ✓ SATISFIED | thresholdModel + exact-match cross-validation + threshold-sweep.csv + CALIBRATION.md §2 answer (n≈15 @ p=0.9, n≈30 @ p=0.95) |
| CALB-02 | 03-03 | Sweep simulates margin/undercollateralization — answers what q/N survives p10 rounds; ugly answers revisit CCP scope with data | ✓ SATISFIED | margin-sweep.csv + CALIBRATION.md §5 (honest ugly answer: no q≤2 EWMA covers the tail) + §6 decision record (CCP scope resolved: skipped, with data) |

No orphaned requirements: REQUIREMENTS.md maps only CALB-01/CALB-02 to Phase 3, both claimed by plans. Note: the REQUIREMENTS.md checkboxes/traceability rows still read "Pending" — a tracking-table staleness item for the orchestrator, not a code gap.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | none | — | Zero TBD/FIXME/XXX/TODO/HACK/placeholder markers across all 7 phase files |

All 5 review warnings (WR-01..WR-05) verified fixed in code/doc (commits cd739ca, abf0678, ccfd99e, 421a868, 2eff0a8 — all exist in git). All 12 documented commits verified present; working tree clean for all phase artifacts.

### Human Verification Required

None. All phase tasks are `auto` with automated verifies; no `<human-check>` blocks in any plan; deliverables are data files and tests, fully verifiable programmatically. (Orchestrator confirmed no human checkpoint expected this phase.)

### Gaps Summary

No gaps. The phase goal is achieved end-to-end in the codebase:

- The threshold-consent question has a committed, cross-validated empirical answer (the model is proven to be the real `attemptRound`'s numbers by exact bigint equality, re-executed green during this verification).
- The margin question has a committed, honest answer — including the ugly finding (no q≤2 debit-EWMA covers the p99 tail) reported without massaging, per the phase's honesty conventions.
- The pre-resolved CCP gate decision is recorded verbatim, exactly once, in `docs/CALIBRATION.md` §6 with both CSVs as its supporting data.
- Every doc number spot-checked traces exactly to a committed CSV row; the only all-zero CSV rows are the 16 documented n=50/p=0.8 imputed cells, explicitly flagged in the doc's data notes.

---

_Verified: 2026-07-24_
_Verifier: Claude (gsd-verifier)_
