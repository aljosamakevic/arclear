# Phase 1: Threshold Consent (brief Phase 0) - Context

**Gathered:** 2026-07-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Rounds keep settling when members stall. The coordinator proposes over a *candidate* set, collects consents within a timeout window, and on timeout rebuilds the round from the consenting subset — excluded members' IOUs drop from the manifest, counterparties' deltas are recomputed, and **everyone in the final executed set signs the final digest**. Threshold over the candidate set, unanimity over the final set. No one's balance ever moves without their signature (CONS-03 invariant). Deliverables: `ClearingHubV2.sol` (execution path mostly unchanged), round-rebuild logic in `src/round.ts`, coordinator protocol changes in `demo/coordinator.ts`, invariant tests, and a documented griefing analysis.

Requirements: CONS-01 … CONS-06 (see `.planning/REQUIREMENTS.md`).

</domain>

<decisions>
## Implementation Decisions

### Threshold & rebuild policy
- **D-01 Quorum:** A rebuilt round proceeds whenever the recomputed netting still has **≥2 participants with nonzero deltas** — same floor as the contract's `TooFewParticipants`. No new threshold parameter.
- **D-02 Multiple stallers:** All members who miss the pass-1 window are excluded **together in one rebuild pass**, deterministic from the timeout snapshot. Preserves the two-pass worst case.
- **D-03 Pass-2 stall:** If anyone stalls during pass 2, the round attempt **aborts cleanly** (nothing settles); the next round starts a fresh pass 1. Hard cap: **2 signature-collection passes per attempt**.
- **D-04 Re-inclusion:** Excluded members are **always back in the candidate set** for the next round (candidate set = everyone with open IOUs). No backoff, no coordinator discretion. Griefing cost stays pure latency.

### Consent window mechanics
- **D-05 Timeout config:** One wall-clock consent-window duration as a **coordinator-level default with per-round override** (demo-scale default like 30s; ms-scale in tests).
- **D-06 Miss tracking:** Coordinator tracks a **per-member consecutive missed-window counter now** (reset on any successful consent) — Phase 2's `redeemIOU` flagging ("missed K consecutive windows") reads this directly.
- **D-07 Miss semantics:** **Only timeouts count as misses.** An explicit reasoned refusal (`verifyProposal` fails on the member's local view) excludes them from the round but does NOT advance the miss counter — refusal is the safety mechanism working, not unresponsiveness.
- **D-08 Deadline placement:** The consent deadline is **out-of-band coordinator metadata**, NOT part of the EIP-712 Round struct. Digest, contract interface, and fixtures stay unchanged (CONS-06). *(Auto-selected recommended option at user's request.)*

### ClearingHubV2 contract scope
*(All auto-selected recommended options at user's request.)*
- **D-09 Contract diff:** `ClearingHubV2.sol` is a **near-verbatim copy** of `ClearingHub.sol` — new contract name, updated NatSpec/version marker, execution path unchanged. No new external functions.
- **D-10 No exclusion events:** No new on-chain events. Exclusions are off-chain rebuilds by design; the submitted round looks like any unanimous round to the contract.
- **D-11 EIP-712 domain:** Domain name/version **unchanged from v1** — domain separation already comes from `verifyingContract`. No new signed structs → no new fixture obligation (existing digest-parity fixtures must still pass against V2).
- **D-12 Deployment:** Deploy **fresh V2 hubs (USDC + EURC) on Arc Testnet at the end of this phase**; v1 hubs stay live as Arclear Net v1. Explicit gas limits on all writes (Arc gas-token gotcha).

### Failure simulation & demo visibility
*(All auto-selected recommended options at user's request.)*
- **D-13 Injection:** Unresponsiveness is injected via a **per-agent stall toggle** (dashboard/API-settable), also scripted in e2e. Refusal-for-cause remains a separate, distinguishable behavior.
- **D-14 Visibility:** Coordinator round state machine gains explicit rebuild phases (e.g. `collecting-consents` → `rebuilding` → `collecting-consents-pass-2`); `ExecutedRound` records excluded members and pass count; dashboard surfaces exclusion rounds in round history.
- **D-15 E2E scenario:** Extend the existing e2e with the canonical liveness scenario: agent stalls → round rebuilds and settles without them → their IOUs settle cleanly next round (CONS-04) → same IOU can never settle twice.
- **D-16 Griefing doc:** The griefing analysis (repeated refusal = repeated rebuild latency, worst case two passes, never a safety cost) lands as a **threshold-consent section in `docs/PROTOCOL.md`** (CONS-05).

### Claude's Discretion
- Exact TS shape of the rebuild API in `src/round.ts` (pure function over {proposal, consenting subset, open IOUs} — keep the pure-core pattern)
- Exact default timeout values for demo vs tests
- Naming of new coordinator phases and state fields
- Whether stall toggle is exposed as an HTTP endpoint, dashboard button, or both

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source
- `docs/V2-BRIEF.md` §3 "Phase 0 — Threshold consent" — the fixed design: exclude-and-recompute, threshold over candidate set, unanimity over final set, two-pass worst case
- `.planning/PROJECT.md` — Key Decisions table (fixed by brief §4, do not relitigate), constraints (no division, fixtures, gas limits), Arc environment notes
- `.planning/REQUIREMENTS.md` — CONS-01…CONS-06 acceptance criteria

### Protocol & threat model
- `docs/PROTOCOL.md` — v1 netting rules and round lifecycle; this phase extends it with the threshold-consent protocol + griefing analysis
- `docs/THREAT-MODEL.md` — existing threat framing that the griefing analysis must stay consistent with

### Code that changes
- `src/round.ts` — `buildProposal`/`verifyProposal`/`signConsent`; rebuild logic lands here as pure functions
- `demo/coordinator.ts` — round lifecycle state machine; gains timeout, rebuild pass, miss counters, stall handling
- `contracts/src/ClearingHub.sol` — v1 source that `ClearingHubV2.sol` copies; execution path stays unchanged
- `src/client.ts` — hardcoded `gas: 1_500_000n` noted in STATE.md as a growing-round-size concern
- `contracts/test/utils/RoundBuilder.sol`, `contracts/test/DigestParity.t.sol`, `test/genFixture.ts` — digest-parity fixture chain that must keep passing against V2

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `net()` (`src/netting.ts`): pure, deterministic — the rebuild is just `net()` over the open IOUs minus those touching excluded members; no new netting math needed
- `verifyProposal()` (`src/round.ts:73`): participant-side recomputation already returns `{ ok, reason }` — reasoned refusal vs timeout distinction builds on this
- `Coordinator.settledIds` / `openIous` (`demo/coordinator.ts:36,56`): excluded IOUs simply stay open → CONS-04 re-settlement falls out naturally
- Existing digest fixtures + `DigestParity.t.sol`: rerun against `ClearingHubV2` to prove D-11

### Established Patterns
- Pure-function core / zero-trust coordinator: rebuild must be independently recomputable by every participant — a rebuilt proposal is untrusted until re-verified, same as pass 1
- Validation functions return `{ ok: boolean; reason?: string }`, never throw
- Custom Solidity errors; `withdraw` never pausable; NatSpec density on every external function

### Integration Points
- `Coordinator.runRound()` (`demo/coordinator.ts:60`) — currently synchronous single-pass, throws on first refusal; becomes the two-pass state machine
- `demo/server.ts` endpoints + `public/dashboard.html` — stall toggle and exclusion-round display
- `contracts/script/Deploy.s.sol` — V2 deployment path
- `demo/e2e.ts` — liveness scenario extension

</code_context>

<specifics>
## Specific Ideas

- The brief's framing is the acceptance bar: "worst case is two signature-collection passes: a latency cost, never a safety cost" — the griefing section in PROTOCOL.md should say exactly this and prove it
- Keep the domain insight visible in docs: in a payments CCP the defaulter's position is a scalar debit in a stable unit

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Miss-counter tracking (D-06) is deliberately forward-compatible groundwork for Phase 2's flagging, not scope creep — it's coordinator state only.)

</deferred>

---

*Phase: 1-Threshold Consent (brief Phase 0)*
*Context gathered: 2026-07-22*
