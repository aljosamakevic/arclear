# Phase 1: Threshold Consent (brief Phase 0) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-22
**Phase:** 1-Threshold Consent (brief Phase 0)
**Areas discussed:** Threshold & rebuild policy, Consent window mechanics, ClearingHubV2 contract scope, Failure simulation & demo visibility

---

## Threshold & rebuild policy

| Option | Description | Selected |
|--------|-------------|----------|
| ≥2 participants | Proceed whenever rebuilt netting has ≥2 participants with nonzero deltas (matches contract floor) | ✓ |
| Configurable fraction | Proceed only if ≥ fraction of candidate set consented | |
| Configurable absolute count | Proceed only if ≥m members consented | |

| Option | Description | Selected |
|--------|-------------|----------|
| All at once | One rebuild pass drops every timed-out member together | ✓ |
| One at a time | Iterative single-member exclusion, more passes | |

| Option | Description | Selected |
|--------|-------------|----------|
| Abort round, retry fresh | Pass-2 stall fails the attempt cleanly; next round is a fresh pass 1 | ✓ |
| Rebuild again within round | Unbounded passes until convergence | |
| Configurable max passes | Knob, default 2 | |

| Option | Description | Selected |
|--------|-------------|----------|
| Always re-include | Candidate set is always everyone with open IOUs | ✓ |
| Backoff for repeat stallers | Skip persistent stallers' IOUs at proposal time | |

**User's choice:** All recommended options, selected interactively.
**Notes:** User dismissed the deadline question mid-area-2, then instructed: pick recommended options for everything remaining and start building.

---

## Consent window mechanics

| Option | Description | Selected |
|--------|-------------|----------|
| Coordinator default + per-round override | One wall-clock duration, overridable per runRound | ✓ |
| Fixed constant | Hardcoded window | |
| Adaptive window | Scales with participants/latency | |

| Option | Description | Selected |
|--------|-------------|----------|
| Track misses now | Per-member consecutive-miss counter in coordinator state, reset on consent | ✓ |
| Defer to Phase 2 | Phase 2 introduces the counter with flagging | |

| Option | Description | Selected |
|--------|-------------|----------|
| Only timeouts count | Reasoned refusal excludes from round but never advances miss counter | ✓ |
| Both count | Any non-consent advances counter | |

| Option | Description | Selected |
|--------|-------------|----------|
| Out-of-band metadata | Deadline travels beside proposal, not in EIP-712 struct | ✓ (auto) |
| Signed into digest | Deadline field in Round struct, new fixtures + contract change | |

**User's choice:** First three interactive; deadline auto-selected (recommended) per user instruction.

---

## ClearingHubV2 contract scope

| Option | Description | Selected |
|--------|-------------|----------|
| Near-verbatim copy | New name + NatSpec/version marker, execution path unchanged | ✓ (auto) |
| No new events | Exclusions invisible on-chain by design | ✓ (auto) |
| Domain unchanged | Separation via verifyingContract; existing fixtures must pass against V2 | ✓ (auto) |
| Deploy at phase end | Fresh USDC+EURC V2 hubs on Arc; v1 hubs stay live | ✓ (auto) |

**User's choice:** Area not reached interactively — all recommended options auto-selected per user instruction.

---

## Failure simulation & demo visibility

| Option | Description | Selected |
|--------|-------------|----------|
| Per-agent stall toggle | Dashboard/API-settable; also scripted in e2e | ✓ (auto) |
| Explicit rebuild phases + exclusion info | New coordinator phases; ExecutedRound records exclusions/passes | ✓ (auto) |
| Extend existing e2e | stall → exclude → settle → next-round recovery scenario | ✓ (auto) |
| Griefing analysis in docs/PROTOCOL.md | Threshold-consent section incl. two-pass latency bound | ✓ (auto) |

**User's choice:** Area not reached interactively — all recommended options auto-selected per user instruction.

## Claude's Discretion

- Exact rebuild API shape in `src/round.ts` (pure-function pattern)
- Default timeout values (demo vs tests)
- Coordinator phase/state naming
- Stall toggle exposure (endpoint, dashboard button, or both)

## Deferred Ideas

None.
