# Retrospective — Arclear

## Milestone: v2.0 — Clearing Primitive

**Shipped:** 2026-07-24
**Phases:** 4 | **Plans:** 23 | **Commits:** 164 (+22,222 / −400 across 122 files) | **Timeline:** ~2 days wall-clock

### What Was Built
Threshold consent (liveness through member failure), merkle manifests + collateralized IOU redemption, exact-match-validated calibration sweeps, atomic cross-currency PvP, and a positioning revision — the complete permissionless netting primitive, live and source-verified on Arc Testnet.

### What Worked
- **Wave-based parallel execution in isolated worktrees** — zero merge conflicts across 15 executor runs; the byte-identical-typehash coordination between parallel SDK/contract agents held every time.
- **Fixture-parity discipline** — every new signed struct (Round, IOU, PvPRound) got a TS↔Solidity fixture; three independent implementations never drifted.
- **Adversarial review before phase close** — caught two genuine SDK vulnerabilities (consent-signature screening in Phase 1; FX-pair stripping in Phase 4), both fixed with attack-reproducing regression tests before ship.
- **Data before code** — the calibration checkpoint (pulled forward in spirit by an external positioning review) killed the CCP arc with evidence rather than opinion, saving ~15 focused days.

### What Was Inefficient
- Background sweep monitors failed to re-wake executors twice (Waves 2/3 of Phase 3) — required manual nudges; long-running background process handoff is a weak point.
- One session restart mid-deploy (Phase 2 Wave 7) — recovered cleanly from the worktree, but the SUMMARY had to be reconstructed post-hoc.
- The plan-checker's "(RESOLVED)" research-marker convention tripped three times — a mechanical marker worth automating.

### Patterns Established
- Full local gate (vitest + forge + e2e:anvil) green BEFORE any testnet broadcast — applied three times, zero bad deploys.
- Accept-and-document for unfixable-without-redeployment limitations (single-leg extraction), always with a machine-documenting test cited from the threat model.
- Honest-calibration voice as a product feature: unflattering numbers (99% abort at n=50/p=0.9; margin estimator fails everywhere) published prominently, not buried.

### Key Lessons
- A checker blocker on simulation code (IOU-id collisions invisible to cross-validation) proved plan review pays for itself even on "just a script" phases.
- Scope decisions land best as data + external review + user call in that order — the CCP skip was decided in minutes because the groundwork made it obvious.

### Cost Observations
- Executor/researcher/planner agents ran on sonnet; orchestration on the session model. ~35 subagent runs total.
- Notable: two ~50-min simulation sweeps dominated wall-clock; everything else pipelined.

## Cross-Milestone Trends

| Metric | v2.0 |
|---|---|
| Phases / plans | 4 / 23 |
| Test count at close (vitest + forge) | 120 + 101 |
| Review findings (critical/warning) fixed pre-close | 2 / 13 |
| Verification pass rate | 4/4 first-attempt |
