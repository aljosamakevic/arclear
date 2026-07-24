---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
plan: 02
subsystem: contracts-pvp-router
tags: [solidity, foundry, eip712, atomic-settlement, router, pvp-01, pvp-02]
requires: []
provides:
  - "contracts/src/PvPRouter.sol: stateless atomic PvP router — hashPvPRound view + executePvP"
  - "Canonical PvPRound EIP-712 typehash (byte-exact contract-side anchor for 04-01's src/domain.ts and 04-03's fixture)"
  - "Full router error surface: ZeroRate, LegDigestMismatch(uint8), BadPvPSignature(uint256), PvPSignatureCountMismatch(uint256,uint256), UnionNotStrictlyAscending"
affects:
  - "04-03 fixture/parity (PvPParity.t.sol deployCodeTo against this contract's hashPvPRound)"
  - "04-04 full revert matrix + both-or-neither tests (extends contracts/test/PvPRouter.t.sol, migrates setUp into a PvPRoundBuilder harness)"
  - "04-05 SDK/coordinator (executePvP calldata shape: Leg struct-of-arrays + signed digests + rate + union sigs)"
  - "04-06 deploy script (constructor: hubUSDC_, hubEURC_ immutables)"
tech-stack:
  added: []
  patterns:
    - "Revert bubbling as atomicity mechanism: plain high-level external calls to both hubs' executeRound, no try/catch, no low-level call (PVP-01)"
    - "Leg digest binding via the hubs' public parity-locked hashRound + ManifestMerkle.rootOf — never router-local EIP-712 Round hashing (Pitfall 2)"
    - "Single-pass sorted union merge whose strict-ascent check on the merged stream implies strict ascent of both inputs"
key-files:
  created:
    - contracts/src/PvPRouter.sol
    - contracts/test/PvPRouter.t.sol
  modified: []
decisions:
  - "Union merge validates the MERGED stream is strictly ascending (single check covers disorder in either input and duplicates), and rejects address(0) via the same prev-initialized comparison the hubs use"
  - "Union buffer over-allocated to n1+n2 and returned with an explicit count (no trim copy) — signature loop iterates count, keeping the hot path allocation-minimal"
  - "No hub-pair validation (zero/distinct) in the constructor — plan defines no BadConfig error for the router; a mis-deployed router is inert (no funds, no authority) and simply redeployed"
metrics:
  duration: "~6 minutes"
  completed: "2026-07-24"
  tasks: 2
  commits: 2
  tests: "85 passing Solidity tests (4 new in PvPRouterTest); zero regressions"
---

# Phase 4 Plan 02: PvPRouter — Stateless Atomic PvP Settlement Contract Summary

Stateless EIP-712 router (`"ArclearPvPRouter","1"`) with an immutable hub pair that binds calldata legs to signed digests via the hubs' own `hashRound`, verifies one PvPRound signature per sorted-union member on-chain, and settles both legs through plain external `executeRound` calls where revert bubbling is the both-or-neither mechanism (PVP-01/PVP-02).

## What Was Built

**`contracts/src/PvPRouter.sol` (247 lines):**
- Inherits **only** `EIP712` — deliberately no ReentrancyGuard (stateless, holds no funds; each hub carries its own guard), no Pausable, no Ownable2Step. Contract NatSpec states the rationale, the atomicity argument, and points to docs/THREAT-MODEL.md for the single-leg-extraction limitation (D-01/D-02, RESEARCH Q1.6/Q2c).
- `ClearingHubV2 public immutable hubUSDC / hubEURC` set in the constructor — hub addresses never come from calldata, structurally closing evil-hub substitution (RESEARCH Q3, T-04-05).
- Canonical typehash, byte-exact and appearing exactly once: `PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)`.
- `Leg` calldata struct-of-arrays `{nonce, participants, deltas, consumedIds, signatures}` mirroring `executeRound`'s parameter list (via_ir handles stack depth).
- `hashPvPRound(...)` public view via `_hashTypedDataV4` with the hubs' "so off-chain implementations can assert encoding parity" NatSpec convention.
- `executePvP` ordered exactly per plan: (1) `ZeroRate` gate, (2) per-leg digest recomputation via `hub.hashRound(nonce, participants, deltas, ManifestMerkle.rootOf(consumedIds))` with `LegDigestMismatch(0|1)` before any execution (T-04-06), (3) pvpDigest over the *recomputed* digests + rate, (4) sorted-union merge + exactly-one-signature-per-member index-aligned verification (`UnionNotStrictlyAscending`, `PvPSignatureCountMismatch`, `BadPvPSignature(k)` — T-04-07/T-04-08), (5) plain external `hubUSDC.executeRound` then `hubEURC.executeRound` — no try/catch anywhere (T-04-09), (6) `PvPExecuted` event.

**`contracts/test/PvPRouter.t.sol` (81 lines, 4 tests):**
- `test_constructor_immutables` — router returns the exact constructor hub pair.
- `test_hashPvPRound_fieldSensitivity` — determinism plus 4 single-field perturbation inequalities (both digests, numerator, denominator).
- `test_revert_executePvP_zeroNumerator` / `test_revert_executePvP_zeroDenominator` — typed `PvPRouter.ZeroRate.selector` expectRevert with empty legs (rate gate fires first).
- setUp deploys two `ClearingHubV2` (UNCALIBRATED K=3/RING=16/L=86400, two MockUSDC instances) + one router — kept minimal for plan 04-04's harness migration.

## Verification Evidence

- `cd contracts && forge build` — exit 0 (via_ir, solc 0.8.26)
- `forge inspect PvPRouter abi` — lists `executePvP`, `hashPvPRound`, `hubUSDC`, `hubEURC` and all five errors
- `forge test --match-contract PvPRouterTest -vvv` — 4/4 green
- `npm run test:contracts` — 85/85 green across 8 suites (no regression)
- Grep gates: `try` outside comments = 0; `ReentrancyGuard|Pausable|Ownable` outside comments = 0; canonical typehash line count = 1
- `forge inspect PvPRouter storage-layout` — no router-declared storage; only OZ EIP712 base entries (see deviation below)

## Deviations from Plan

### Acceptance-gate deviation (documented, not a code change)

**1. [Rule 1 - Plan-gate assumption bug] Storage-layout gate cannot be literally zero for any OZ EIP712 inheritor**
- **Found during:** Task 1 acceptance criteria
- **Issue:** The gate "`forge inspect PvPRouter storage-layout` yields ZERO storage entries" is unsatisfiable: OpenZeppelin 5.6.1's `EIP712` base declares `string private _nameFallback; string private _versionFallback;` (slots 0–1), which appear in every inheritor's layout — `ClearingHubV2`'s own layout shows the identical two entries. They are written **only** when the domain name/version exceed 31 bytes; `"ArclearPvPRouter"` (16 bytes) and `"1"` take the ShortString path, so the slots are never touched at runtime.
- **Resolution:** The gate's *intent* — the router itself declares zero mutable storage beyond the two immutables — is fully satisfied: every entry in the layout originates from the OZ base, none from `PvPRouter`. Hand-rolling EIP-712 to satisfy the literal gate would violate the research's explicit "Don't Hand-Roll" rule and break the parity regime. Plan 04-04's verifier should check "no PvPRouter-declared storage" rather than "zero entries".
- **Files modified:** none
- **Commit:** e2a0ad4 (contract as designed)

No other deviations — both tasks executed as written.

## TDD Gate Compliance

Task 2 carried `tdd="true"`, but the plan ordered the implementation (Task 1, `feat` e2a0ad4) before the test task, so a failing RED phase was structurally impossible — the behaviors under test already existed when the test file was written. The tests were written strictly against the plan's `<behavior>` block and passed first run (4/4); committed as `test(04-02)` de4bc4c. Gate sequence in git log is `feat` → `test` rather than `test` → `feat` by plan construction, not by skipping discipline.

## Known Stubs

None — the router is fully wired: every code path (rate gate, digest binding, union verification, leg execution) is implemented and exercised or scheduled for 04-04's matrix.

## Commits

| Commit | Type | Description |
| ------ | ---- | ----------- |
| e2a0ad4 | feat | PvPRouter.sol — stateless atomic router, immutable hub pair, canonical typehash, plain-call execution |
| de4bc4c | test | PvPRouter smoke tests — immutables, digest sensitivity, zero-rate reverts |

## Next Steps

- 04-03: shared TS↔Solidity PvPRound digest fixture + `PvPParity.t.sol` (D-05 obligation for the new signed struct)
- 04-04: full revert matrix, both-or-neither assertions, single-leg-direct-submission documentation test, gas measurement — extends `PvPRouter.t.sol`
- Parallel 04-01 (src/pvp.ts) must byte-match this contract's typehash string and domain `("ArclearPvPRouter","1")`

## Self-Check: PASSED

- contracts/src/PvPRouter.sol — FOUND
- contracts/test/PvPRouter.t.sol — FOUND
- Commits e2a0ad4, de4bc4c — FOUND on worktree branch
