# Phase 2: Merkle Manifests & IOU Redemption (brief Phase 1) - Context

**Gathered:** 2026-07-22 (auto mode — recommended options selected, decisions logged in DISCUSSION-LOG)
**Status:** Ready for planning

<domain>
## Phase Boundary

Claims become provable and recoverable on-chain. The `manifestHash` preimage becomes a **sorted-leaf merkle root** (same `bytes32` field — no ClearingHub interface change, MERK-01), with inclusion and non-inclusion proofs (adjacent-leaf bracketing) implemented twice and proven byte-identical: `src/merkle.ts` ↔ `contracts/src/lib/ManifestMerkle.sol` (MERK-02). A creditor can call `redeemIOU(iou, sig, proofs[])` with non-inclusion proofs against the last k round roots to debit an unresponsive debtor's collateral directly, gated to debtors flagged after missing K consecutive consent windows (MERK-03). A nullifier mapping prevents re-redemption; redeem→cannot-net and net→cannot-redeem exclusivity is tested (MERK-04).

Requirements: MERK-01 … MERK-04. Phases 1+2 together = shippable "Arclear Net v2" release.

</domain>

<decisions>
## Implementation Decisions

### Merkle construction rules
- **D-01 Leaves:** sorted unique bytes32 IOU ids, ascending. Leaf domain-separated from internal nodes (e.g. prefix byte or double-hash) to prevent second-preimage attacks.
- **D-02 Pair hash:** ordered concatenation `keccak256(left ‖ right)` — NOT commutative sorted-pair hashing, because adjacent-leaf bracketing non-inclusion proofs require positional order to be provable.
- **D-03 Odd node:** promote the lone node upward unchanged (no Bitcoin-style duplication — duplication creates ambiguous trees).
- **D-04 Empty manifest:** keep the v1 sentinel `keccak256("0x")` so empty-round behavior is unchanged.
- **D-05 Non-inclusion:** prove the two adjacent leaves bracketing the missing id (or single-edge proof when the id falls before the first / after the last leaf). Both sides implement identical bracketing rules.

### Unresponsiveness flagging (zero-authority constraint)
- **D-06 On-chain criterion, not coordinator attestation:** the hub records `lastParticipation[address] = roundNonce` inside `executeRound` (it already iterates participants — small, measured gas add). The coordinator gains NO new authority (Net-product security constraint from PROJECT.md).
- **D-07 Redemption gate:** `redeemIOU` requires (a) debtor's `lastParticipation` at least K rounds stale, (b) valid debtor signature on the IOU, (c) non-inclusion proofs against the stored recent round roots covering the IOU's live window, (d) unexpired... expiry semantics per research. K=3 default.
- **D-08 Root history:** hub stores a ring buffer of the last k round roots (k=16 default) written in `executeRound`. Both K and k are constructor/config parameters **labeled uncalibrated** (project convention).
- **D-09 Off-chain counters stay:** Phase 1's coordinator miss counters remain the off-chain early-warning signal; they are NOT consulted on-chain.

### Contract versioning
- **D-10 Extend `ClearingHubV2.sol` in place** — v1 (`ClearingHub.sol`) stays frozen as Arclear Net v1; V2 is the active v2 product. Phase 1's "near-verbatim copy" constraint (its D-09) applied to Phase 1 only; Phase 2 is exactly the phase where V2 grows `redeemIOU` + root history + participation tracking.
- **D-11 Redeploy at phase end:** fresh USDC + EURC hubs to Arc Testnet with explicit gas settings; README hub table updated; v1 hubs and Phase-1 V2 hub addresses remain listed/live. Digest struct (Round) unchanged → existing digest fixtures must still pass.
- **D-12 Withdraw never pausable; no division in protocol math; custom errors; NatSpec density** — all carried forward unconditionally.

### Nullifiers & exclusivity
- **D-13 Nullifier key:** the IOU id (EIP-712 digest) — already canonical and unique. `mapping(bytes32 => bool) redeemed`.
- **D-14 Redeem→cannot-net:** a redeemed IOU id can never appear in a later executed manifest — enforced on-chain (executeRound reverts if any consumed id is nullified) AND filtered off-chain (coordinator excludes redeemed ids; SDK `net()` opts accept a redeemed-ids set).
- **D-15 Net→cannot-redeem:** inclusion in any stored round root defeats redemption structurally (non-inclusion proofs fail). For roots older than the ring buffer, research must define the safe rule (e.g., IOU expiry bounds the redemption window so old settlements can't be double-claimed).

### Fixtures & tests
- **D-16 Shared merkle fixture:** extend the fixture generator to emit roots + inclusion + non-inclusion proof vectors consumed by both vitest and a Foundry parity test (same pattern as digest parity). Property tests: root determinism under shuffle, proof verify/reject, bracketing correctness, nullifier idempotence, exclusivity both directions.
- **D-17 e2e:** extend the liveness scenario — debtor goes unresponsive past K windows → creditor redeems directly → debtor's collateral debited → the redeemed IOU can never settle in a later round.

### Claude's Discretion
- Exact leaf/node domain-separation scheme; proof array encoding; struct layout of `redeemIOU` params
- Whether root history is `bytes32[16]` ring or mapping by nonce with pruning window
- Gas measurement approach for the `executeRound` additions
- IOU expiry interaction details (research question — must be answered before planning locks D-15)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design source
- `docs/V2-BRIEF.md` §3 "Phase 1 — Merkle manifests + on-chain IOU redemption" — fixed design
- `.planning/PROJECT.md` — Key Decisions (sorted-leaf merkle rationale), constraints, Arc environment
- `.planning/REQUIREMENTS.md` — MERK-01..MERK-04

### Phase 1 outputs this builds on
- `.planning/phases/01-threshold-consent-brief-phase-0/01-CONTEXT.md` — Phase 1 locked decisions (miss counters D-06/D-07, refusal ≠ miss)
- `.planning/phases/01-threshold-consent-brief-phase-0/01-05-SUMMARY.md` — deployed V2 hub addresses (superseded by this phase's redeploy)
- `src/round.ts` — `manifestHash()` is the function being replaced; `rebuildProposal`/`verifyProposal` consume the new root transparently (bytes32 unchanged)
- `demo/coordinator.ts` — miss counters, `screenConsents`, `pendingSubmission` reconciliation (post-review hardened; do not regress)
- `contracts/src/ClearingHubV2.sol` — the contract being extended
- `docs/PROTOCOL.md` — threshold-consent section; this phase adds the manifest/redemption spec
- `test/genFixture.ts`, `contracts/test/DigestParity.t.sol`, `contracts/test/ClearingHubV2Parity.t.sol` — fixture-parity pattern to replicate for merkle

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `manifestHash()` (`src/round.ts:19`) — single call site chain (buildProposal/verifyProposal); swapping the preimage to a merkle root is localized
- Fixture pipeline (`npm run fixture` → `test/fixtures/digest.json` → Foundry `fs_permissions` read) — extend, don't fork
- `RoundBuilder.sol` test harness + revert-matrix tests — model for redeemIOU revert matrix
- e2e `check(cond, label)` pattern and stall injection from Phase 1

### Established Patterns
- No division in protocol math; bigint/int256 only
- `{ ok, reason }` validation returns; custom Solidity errors with diagnostic params
- Every new signed struct → shared TS↔Solidity fixture (redeemIOU reuses the existing IOU struct signature — verify no new signed struct is needed; if one is, fixture it)
- Explicit gas limits on all Arc writes; `--with-gas-price 25gwei` deploys

### Integration Points
- `contracts/src/ClearingHubV2.sol` `executeRound` — root-history write, participation tracking, nullifier check
- `src/client.ts` — new `redeemIOU` write method + reads for roots/participation/nullifiers
- `demo/coordinator.ts` — redeemed-ids filtering into `net()` opts
- `contracts/script/DeployV2.s.sol` — redeploy path

</code_context>

<specifics>
## Specific Ideas

- The showcase framing (from strategy discussion 2026-07-23): redemption is what makes "a tab with a limit" honest — participant #2's day-one story is "bilateral credit with a collateralized recovery path". PROTOCOL.md's new section should say this plainly.
- Gas delta of the `executeRound` additions must be measured and reported (Arc explicit-gas discipline; STATE.md already flags the hardcoded 1_500_000 limit).

</specifics>

<deferred>
## Deferred Ideas

- Cross-phase: sweep-driven calibration of K and k values — Phase 3 (calibration checkpoint) territory.

</deferred>

---

*Phase: 2-Merkle Manifests & IOU Redemption (brief Phase 1)*
*Context gathered: 2026-07-22 via --auto (single pass)*
