# Phase 4: Cross-Currency PvP Rounds (brief Phase 6) - Context

**Gathered:** 2026-07-24 (auto mode — recommended options; user pre-authorized "Complete phase 8" → renumbered Phase 4)
**Status:** Ready for planning

<domain>
## Phase Boundary

USDC and EURC legs settle atomically in a payment-vs-payment round — a miniature CLS on Arc. Both legs settle or neither does (PVP-01). The agreed per-round FX rate is signed into the consent digest, tied to the official `arc-stablecoin-fx` sample (PVP-02).

Requirements: PVP-01, PVP-02. This is the final roadmap phase.

</domain>

<decisions>
## Implementation Decisions

### Atomicity mechanism
- **D-01 Thin router, hubs unchanged:** a stateless `contracts/src/PvPRouter.sol` executes both legs in ONE transaction: verify the PvP consent layer, then call `hubUSDC.executeRound(...)` and `hubEURC.executeRound(...)` sequentially. Transaction atomicity gives both-or-neither for free — if either leg reverts (bad sig, insufficient collateral, wrong nonce), the whole tx reverts and NO leg settles. The deployed V2 hubs are NOT modified and NOT redeployed.
- **D-02 Router holds no funds, no state that isn't strictly needed:** target stateless (or minimal replay guard only if research shows the hub nonces don't already prevent replay — they should: each leg's roundNonce makes re-execution revert WrongRoundNonce).

### FX rate binding (PVP-02)
- **D-03 New EIP-712 signed struct `PvPRound`:** binds { usdcLegDigest (bytes32), eurcLegDigest (bytes32), fxNumerator (uint256), fxDenominator (uint256), and any research-determined fields (e.g., pvpNonce/hub addresses if needed for domain separation) }. Every member of the UNION of the two legs' participant sets signs it. The router verifies these signatures on-chain before executing the legs.
- **D-04 Rate as num/den bigint pair** — no division in protocol math; participant-side verification checks the two legs' deltas are consistent with the rate by cross-multiplication.
- **D-05 Fixture obligation honored:** new signed struct → shared TS↔Solidity digest fixture (extend genFixture + a Foundry parity test, same pattern as Round/IOU digests). MANDATORY per project constraint.
- **D-06 `arc-stablecoin-fx` tie-in:** the demo sources its per-round rate the way the official Arc sample does (research resolves the exact mechanism: sample contract read, or signed rate attestation mirroring the sample's shape). If the sample is unreachable from the SDK, mirror its data shape and document the tie-in.

### Leg construction (SDK/coordinator)
- **D-07 Legs are ordinary rounds:** each leg is built with the existing `net()`/`buildProposal` machinery per hub (threshold consent per leg still applies — exclusion in one leg forces a rebuild of the PvP bundle since the leg digest changes). The PvP layer wraps two leg proposals + the rate; participants verify BOTH legs plus the rate before signing the PvPRound.
- **D-08 Coordinator flow:** collect leg consents AND PvPRound consents (research/planner may fold these into one signing step per member — one PvPRound signature per member may suffice for the PvP layer while leg consents remain per-hub unanimity as the hubs require).
- **D-09 Abort semantics carry over:** the Phase 1 two-pass cap and abort rules apply per leg; any leg abort aborts the PvP round cleanly (nothing settles).

### Deployment & demo
- **D-10 Deploy `PvPRouter` to Arc testnet** at phase end (explicit gas, Blockscout verify); README records the address. Existing V2 hubs reused.
- **D-11 e2e scenario (anvil):** both-or-neither proven positively (both legs settle atomically, balances exact per the FX rate) and negatively (sabotage one leg — e.g., withhold one consent — and assert NEITHER settles).
- **D-12 Demo surface minimal:** dashboard gains at most a PvP-round row/badge; no new UI beyond the existing pattern (PROJECT.md out-of-scope guard).
- **D-13 Docs:** PROTOCOL.md gains a short PvP section (atomicity argument, PvPRound struct, rate semantics); THREAT-MODEL row for cross-leg risks (partial-settle impossibility argument, FX-rate manipulation bounded by unanimous consent); README use-case note. Final human-verify checkpoint: live router + e2e walkthrough.

### Carried constraints (unconditional)
- No division in protocol math; bigint base units; {ok,reason} validation returns; custom errors; NatSpec density; explicit measured gas on all writes; withdraw never pausable (hubs untouched anyway); coordinator gains no authority; strict TS.

### Claude's Discretion
- PvPRound field layout details (subject to fixture + research); whether legs' participant sets must be identical or merely overlapping (research the safety implications; simplest safe rule wins)
- Router error surface; gas measurement approach
- Demo persona FX flows (who trades EURC↔USDC and why)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source
- `.planning/ROADMAP.md` Phase 4 section — success criteria
- `docs/V2-BRIEF.md` §3 "Phase 6 — Cross-currency PvP rounds" — fixed design intent (miniature CLS)
- `.planning/PROJECT.md` — constraints; Arc environment (gas token gotcha, explicit gas)

### Code this builds on (all shipped, do not regress)
- `contracts/src/ClearingHubV2.sol` — executeRound(consumedIds) ABI the router calls; roundNonce replay protection
- `src/round.ts`, `src/domain.ts` — EIP-712 domain/type patterns for the new PvPRound struct
- `demo/coordinator.ts` — two-pass consent machinery to wrap
- `test/genFixture.ts` + `contracts/test/DigestParity.t.sol` lineage — fixture-parity pattern for the new struct
- `src/client.ts` — measured-gas write pattern for the router call
- README hub table — current V2 hub addresses (USDC 0x3b9a…5a16, EURC 0xECcC…B85E)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Everything: legs are plain rounds; the PvP layer is a wrapper. The router is the only new contract; PvPRound the only new signed struct.
- `screenConsents`/`collectConsents` generalize to the PvPRound signature collection.

### Established Patterns
- New signed struct → fixture → parity test (twice-proven pattern)
- Deploy script + explicit gas + Blockscout verify + README lineage

### Integration Points
- `demo/setup.ts` already deploys both USDC and EURC hubs on anvil (v1 did dual-token); confirm and extend for the router
- `demo/e2e.ts` scenario pattern with `check(cond, label)`

</code_context>

<specifics>
## Specific Ideas

- Positioning tie-in (docs): PvP completes the "primitive" story — netting compresses within a token; PvP composes two hubs atomically across tokens. One sentence in README/CONCEPTS connecting it to the CLS analogy already in the docs.
- Honesty: the FX rate is *agreed*, not oracle-derived — unanimous consent bounds manipulation (everyone signed the rate); say this plainly in the threat model.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>

---

*Phase: 4-Cross-Currency PvP Rounds (brief Phase 6)*
*Context gathered: 2026-07-24 via --auto (single pass)*
