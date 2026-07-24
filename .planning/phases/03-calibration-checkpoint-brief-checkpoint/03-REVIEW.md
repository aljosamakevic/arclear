---
phase: 03-calibration-checkpoint-brief-checkpoint
reviewed: 2026-07-24T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - demo/thresholdModel.ts
  - demo/thresholdSweep.ts
  - demo/marginSweep.ts
  - test/thresholdModel.test.ts
  - test/thresholdCrossValidation.test.ts
  - docs/CALIBRATION.md
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: fixes_applied
fixes_applied_at: 2026-07-24
fixes:
  fixed: 5
  deferred_info: 4
---

# Phase 3: Code Review Report

**Reviewed:** 2026-07-24
**Depth:** standard
**Files Reviewed:** 6 (plus read-only cross-checks of `demo/coordinator.ts`, `src/netting.ts`, `demo/flowModel.ts`, `demo/sweep.ts`, and both committed CSVs)
**Status:** fixes_applied (2026-07-24 — WR-01..WR-05 fixed, one atomic commit each; IN-01..IN-04 deferred; committed CSVs byte-identical; `npx tsc --noEmit` and all 83 vitest tests green after each fix)

## Narrative Findings (AI reviewer)

## Summary

Adversarial review of the Phase 3 calibration deliverables, focused on the stated risk class: misleading numbers. The core artifacts hold up under scrutiny:

**Verified clean (evidence-backed, not assumed):**

- **Doc ↔ CSV agreement.** Every number cited in `docs/CALIBRATION.md` was checked against the committed CSVs and matched exactly: the §2 headline table (all 9 cells incl. 0.8519/0.1280, 0.9342/0.4205, 0.9574/0.5256), the §2 companion table (all 6 rows of abort_rate / unsettled_fraction / latency), §5's two n=30 coverage tables (all 24 cells), the p99 debits (18888673/18488244/15538573; 25220511/32089425), the cap_binding values (0.2203/0.1456/0.0683; 0.2605/0.2217), and the v1 baseline numbers (0.8522/0.3248, 0.8962/0.4413, 0.9206/0.5309 from `docs/sweep/sweep.csv`).
- **Grid-wide claims.** "p99_tail_coverage is 0.0000 in all 144 rows" — confirmed (0 nonzero rows). "Best cell in the whole grid: 0.5519 at n=15, p=1.0, q=2.0, N=16" — confirmed as the global max. "n=50 at p=0.9 across the board reports 0.0000" — confirmed (all 12 rows, with p99_debit=0 confirming zero scored observations, i.e. genuinely data-sparse rather than genuinely uncovered). "cap_binding depends on N but not q" — mathematically correct (q>0 multiplies both sides of `im > 1.25*imPrev`) and empirically confirmed: identical values across q for each N in the CSV.
- **Model faithfulness to `attemptRound`.** Line-by-line comparison of `demo/thresholdModel.ts` against `demo/coordinator.ts:attemptRound` confirms the five branches mirror exactly: participant-count < 2 → empty (coordinator.ts:227), no pass-1 timeouts → 1-pass settle (244), single-batch exclusion of all timed-out/refused (252), rebuilt quorum < 2 → abort (258), any pass-2 shortfall → abort with no third pass (281). The rebuild drop rule (debtor OR creditor excluded) and settledIds-fold-only-on-settlement both match. Rebuilt participants are necessarily a subset of pass-1 candidates, so the model's independent pass-2 draws for rebuilt members map 1:1 onto the harness's provider invocations.
- **Round-unique IOU ids.** `roundFlowBatch` replaces the top 8 nibbles of the 64-nibble id with the round tag; `generateFlows`' counter never approaches 16^56, so the discarded high nibbles are always zero and (round, counter) uniqueness is exact. Both a unit test and a property test cover it.
- **Seeded determinism.** All randomness flows through `rng(seed ^ 0x5eed)` and `deriveRoundSeed`. `Date.now()` appears only in timing log lines, never in a data path; no `Math.random` anywhere in scope.
- **No division in protocol math.** All money math in the model is bigint; `Number()` conversion and division occur only in the reporting layer, as the file headers claim (sums bounded well under 2^53).
- **Cross-validation is genuinely non-vacuous.** Offline members manifest only as never-resolving promises (timeouts), `pass1.refused` is asserted empty, settled rounds are compared on exact bigint `settledVolume`/`grossVolume`, cumulative volume is compared at history end, and a guard test requires ≥1 exclusion and ≥1 two-pass settle across the p=0.9 cells. (Gaps in assertion strength are WR-04 below.)
- **Grid completeness.** threshold-sweep.csv: 500 data rows, 100 per n, exactly the documented p-grid. margin-sweep.csv: 144 data rows, all at seeds=200 / rounds=64 (threshold at 10), matching §3's stated scale.

The findings below do not invalidate any committed number. None requires re-running the ~50-minute sweeps unless explicitly flagged.

## Warnings

### WR-01: Empty-sample statistics imputed as 0.0000 in the committed threshold CSV; no per-cell contributing-sample size

**File:** `demo/thresholdSweep.ts:77-81, 157-158, 167-171`; data: `docs/sweep/threshold-sweep.csv`
**Issue:** `percentile([], p)` and `mean([])` return `0`, so cells where no round ever settled report `median_realized_compression`, `median_worst_saving`, and both latency stats as `0.0000` — indistinguishable in-format from a genuine measured zero. This is not hypothetical: **16 committed rows at n=50, p=0.8 are fully imputed** (all stats 0.0000, abort_rate 1.0000, unsettled_fraction 1.0000). Adjacent p=0.8 / p=0.9 cells with abort_rate > 0.95 report medians computed over a small, survivorship-conditioned subset of seeds (only seeds with ≥1 settled round contribute to `compressions`/`worstSavings`) while the `seeds` column says 200. The doc's §2 "never read compression alone" warning and the paired abort/unsettled columns mitigate this for the cells CALIBRATION.md actually cites (none are imputed), but the CSV as a standalone artifact conflates "no data" with "zero". The margin CSV has the same conflation for `coverage_rate=0.0000`, though there `p99_debit=0` disambiguates, and §5 explicitly calls out the sparse cells — good.
**Fix (no re-run needed):** (a) Add a sentence to CALIBRATION.md (§2 or a data-notes paragraph) stating that threshold rows with `abort_rate=1.0000` carry imputed 0.0000 statistics and that medians in high-abort cells are conditioned on seeds with ≥1 settled round; (b) optionally blank the stat fields of the 16 fully-empty rows (identifiable deterministically from abort_rate=1.0000 ∧ unsettled_fraction=1.0000 — a text edit, values unchanged elsewhere). **Adding a `settled_seeds` count column — the structurally better fix — would require re-running the ~50-min threshold sweep**; recommend the doc-side fix for this phase and the column on the next regeneration.

**Outcome:** Fixed (commit `cd739ca`). Doc-side: CALIBRATION.md gained a "Data notes" paragraph naming the 16 fully imputed n=50/p=0.8 rows and the survivorship-conditioning of high-abort-cell medians. Code-side: `percentile([])`/`mean([])` in `demo/thresholdSweep.ts` now return `NaN` (rendered "NaN" by `toFixed`) so future regenerations mark empty samples instead of imputing 0.0000; the note records that the committed CSV predates the marker and stays byte-identical. Optional blanking of the 16 rows and the `settled_seeds` column deferred to the next regeneration (no-rerun constraint).

### WR-02: `--rounds` parsing accepts NaN and silently produces an all-zero CSV overwriting the committed artifact

**File:** `demo/thresholdSweep.ts:42-44`; `demo/marginSweep.ts:54-62`
**Issue:** `Number(argv[roundsIdx + 1])` is never validated. `npm run sweep:threshold -- --rounds` (value omitted) or `--rounds ten` yields `ROUNDS_PER_SEED = NaN`; every history loop `r < NaN` runs zero rounds, and the script **completes successfully, overwriting `docs/sweep/threshold-sweep.csv` with 500 all-zero rows** (only `rounds_per_seed=NaN` betrays it). In marginSweep the floor guard does not save you: `Math.max(64, NaN)` is `NaN`, and the `requestedRounds < 64` warning is false for NaN, so it fails the same way with no warning. thresholdSweep additionally accepts `--rounds 0` and negatives. For a phase whose whole deliverable is committed CSVs, a silent garbage-regeneration path is a real defect.
**Fix (code-only, no re-run):** in both files:
```ts
const requestedRounds = roundsIdx !== -1 ? Number(argv[roundsIdx + 1]) : 10; // or 64
if (roundsIdx !== -1 && (!Number.isInteger(requestedRounds) || requestedRounds < 1)) {
  throw new Error(`--rounds requires a positive integer, got ${argv[roundsIdx + 1]}`);
}
```

**Outcome:** Fixed (commit `abf0678`). Both sweep scripts now throw on NaN / non-integer / non-positive `--rounds` at parse time, before any compute or CSV write, exactly as suggested. Note: no `--seeds` flag exists in either script (seeds are fixed 200, `--quick` 20), so `--rounds` was the only numeric CLI arg to harden.

### WR-03: "excluded-paper latency" metric includes paper delayed by aborts and empty rounds, not just exclusion

**File:** `demo/thresholdModel.ts:171-175`; `demo/thresholdSweep.ts:197-201` (header); `docs/CALIBRATION.md` §2 table + §4 first sentence
**Issue:** `excludedLatencies` records latency for **every** IOU that settled ≥1 round after generation. When a round aborts, the entire pool carries — including paper of members who were online and never excluded; paper generated during an "empty" round also accrues latency with no exclusion involved. The model's own doc comment (thresholdModel.ts:69-71, "excluded/carried paper only") is honest, but the CSV column name `mean_excluded_latency_rounds` and CALIBRATION.md §4's "latency for the **excluded member's** paper" attribute the number specifically to exclusion. In the cells the doc cites, abort_rate runs 0.27–0.99, so abort carry-over — not exclusion of the measured IOU's parties — dominates the observation population. The number is computed correctly; its label overstates causal specificity.
**Fix (doc/text-only, no re-run):** in CALIBRATION.md §4, change the attribution to "paper delayed by exclusion or an aborted/empty round (carry-over latency)" and rename the §2 column header accordingly. Optionally rename the CSV header field to `mean_carryover_latency_rounds` — a header-only text edit; the data rows are unchanged, so no re-run is required (keep the sweep script's HEADER constant in sync).

**Outcome:** Fixed, text-only (commit `ccfd99e`). CALIBRATION.md §2 companion-table header and §4 attribution relabeled to carry-over latency (paper delayed by exclusion or an aborted/empty round), and the sweep's header comment updated to match. The CSV column names were deliberately NOT renamed (per the no-CSV-change constraint — committed data byte-identical); both the doc and the code comment now carry an explicit caveat that the historical `*_excluded_latency_rounds` names mean carry-over latency.

### WR-04: Cross-validation compares excluded-set size and consumed-id count, never membership or per-member deltas

**File:** `test/thresholdCrossValidation.test.ts:152, 160`
**Issue:** The "exact-match" proof asserts `attempt.excluded.length === record.excluded.length` and `consumedIds.length === consumedCount` — counts, not contents — and never compares per-member deltas at all. For **settled** rounds, the exact bigint `settledVolume`/`grossVolume` equality plus pool synchronization makes a same-size-wrong-membership divergence vanishingly unlikely to survive undetected. For **aborted** rounds, however, it is genuinely undetectable: an abort consumes nothing, so both pools remain identical for subsequent rounds regardless of *which* same-size member set each side excluded — a model that excluded the wrong members and aborted would pass all 40 histories. CALIBRATION.md §3 words its claim carefully ("excluded set size"), so the doc is not overclaiming, but the proof is weaker than the test's own "outcomes match the model EXACTLY" framing, and the fix is cheap: the `remap` needed to compare membership already exists in the harness.
**Fix (test-only, no re-run):**
```ts
const expectedExcluded = record.excluded.map((a) => remap.get(a)!.toLowerCase()).sort();
expect(attempt.excluded.map((a) => a.toLowerCase()).sort()).toEqual(expectedExcluded);
```
and, for settled rounds, compare `attempt.result.deltas` against `record.deltas` through the same remap (and consumed-id sets directly — ids are untouched by the remap).

**Outcome:** Fixed (commit `421a868`). Excluded-set membership is now asserted through the remap (sorted lowercase equality) on every non-empty round — closing the aborted-round blind spot — and settled rounds assert full per-member delta `Map` equality with exact bigints. Consumed-id sets remain compared by count only: `ThresholdRoundRecord` does not expose the ids, and they are pinned indirectly by the exact delta maps, pool synchronization, and cumulative-volume equality; a direct set comparison would need a model-record extension, deferred. `npx vitest run test/thresholdCrossValidation.test.ts`: 5/5 green in ~40s with exact matching intact.

### WR-05: `simulateThresholdHistory` does not validate uptime schedule length — a short array silently yields an all-abort garbage history

**File:** `demo/thresholdModel.ts:192`
**Issue:** With `uptime` as an array shorter than `rounds`, `uptime[r]` is `undefined`; every `uniform < undefined` comparison is `false`, so every candidate is "offline", the filtered pool empties, and each affected round records a plausible-looking "aborted" — no throw, no NaN, just wrong data. The current callers construct matching lengths (`rampSchedule(ROUNDS_PER_SEED)`), so committed data is unaffected, but combined with WR-02 (a NaN `ROUNDS_PER_SEED` feeding `rampSchedule`) the failure modes compound silently in the exact artifact this phase commits.
**Fix (code-only, no re-run):**
```ts
if (Array.isArray(uptime) && uptime.length < rounds) {
  throw new Error(`uptime schedule has ${uptime.length} entries for ${rounds} rounds`);
}
```

**Outcome:** Fixed (commit `2eff0a8`). `simulateThresholdHistory` throws when an array uptime schedule is shorter than `rounds`, exactly as suggested. Model behavior for valid inputs unchanged; full 83-test suite green.

## Info

### IN-01: Percentile convention is upper-index nearest-rank (inherited verbatim from v1)

**File:** `demo/thresholdSweep.ts:77-81`; `demo/marginSweep.ts:194-196`
**Issue:** `s[Math.floor((p/100) * s.length)]` returns the upper of the two middle elements for an even-length "median" and sits one rank above standard nearest-rank for p10 (slightly anti-conservative for a lower-tail statistic). The formula is byte-identical to v1's `demo/sweep.ts:68-71`, so cross-sweep comparisons (the §2 v1-baseline column) are internally consistent — which matters more here than the convention itself. No action needed; worth a one-line methodology note if CALIBRATION.md ever gains an appendix.

**Outcome:** Deferred (accepted as-is per the reviewer's own "no action needed" — v1 cross-sweep consistency is the priority).

### IN-02: Vacuous-run guard test depends on execution order via module-level mutable state

**File:** `test/thresholdCrossValidation.test.ts:53, 210-215`
**Issue:** The guard `it` reads `p09Stats` mutated by the two preceding `it`s. Under default vitest in-file ordering this works, and if the guard runs in isolation (`-t` filter) it fails loudly rather than passing vacuously — the safe failure direction — but order-coupled tests are fragile under future shuffling/sharding config.
**Fix:** compute the stats inside the same `it` as the p=0.9 runs, or assert them at the end of each p=0.9 test.

**Outcome:** Deferred — restructuring test ordering is beyond the WR fix scope and the failure direction is already safe (isolated run fails loudly, never passes vacuously).

### IN-03: 500 ms wall-clock consent window makes the cross-validation timing-sensitive on loaded machines

**File:** `test/thresholdCrossValidation.test.ts:45, 101-111`
**Issue:** Online members must produce a real EIP-712 signature within `WINDOW_MS = 500` of the shared deadline; on a heavily loaded CI box a slow signer would be misclassified as timed out. The failure is loud (excluded-count mismatch), never a silent pass, so this is a flake risk only. The offline-member rounds also add real waiting (~0.5–1 s per affected pass) to every `npm test` run — acceptable, but worth knowing it is wall-clock-bound.

**Outcome:** Deferred — flake risk only, failure is loud; no code change made.

### IN-04: `memberAddr` in the model test duplicates `flowModel.addr`

**File:** `test/thresholdModel.test.ts:15-18`
**Issue:** Re-implements the synthetic address formula instead of importing `addr` (which `thresholdCrossValidation.test.ts` does import). Divergence would fail loudly, so it's duplication, not a correctness risk.
**Fix:** `import { addr } from "../demo/flowModel.js";` and use `addr(i).toLowerCase()`.

**Outcome:** Deferred — duplication only (divergence fails loudly); `test/thresholdModel.test.ts` was not touched by any WR fix, so left out of scope.

---

_Reviewed: 2026-07-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
