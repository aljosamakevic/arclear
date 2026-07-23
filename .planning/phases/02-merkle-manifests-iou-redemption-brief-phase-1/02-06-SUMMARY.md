---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
plan: 06
subsystem: sdk
tags: [typescript, viem, abi, gas, merkle, redemption, eip712, netting]

# Dependency graph
requires:
  - phase: 02 plan 04
    provides: "ClearingHubV2 contract surface: consumedIds executeRound, redeemIOU, hashIou, rootRing/lastRound/redeemed, K/RING/MAX_IOU_LIFETIME"
  - phase: 02 plan 05
    provides: "Measured gas coefficients (executeRound BASE/PER_PARTICIPANT/PER_ID, redeemIOU flat) consumed verbatim"
  - phase: 02 plan 02
    provides: "src/merkle.ts nonInclusionProof/NonInclusionProof + EMPTY_MANIFEST_ROOT for proof assembly"
provides:
  - "src/abi/ClearingHubV2.ts regenerated from the compiled artifact: consumedIds executeRound, redeemIOU, hashIou, rootRing, lastRound, redeemed, K/RING/MAX_IOU_LIFETIME, 4-arg constructor + bytecode"
  - "src/client.ts: V2-bound HubClient — size-parameterized executeRound gas formula, redeemIOU write (flat measured gas), lastRound/redeemed/rootRing/hashIou/ringSize reads, fetchManifest (calldata reconstruction), prepareRedemptionProofs (contract-derived range)"
  - "src/iou.ts: checkIouLifetime {ok,reason} helper + signIou L-convention enforcement (D-15 SDK half)"
  - "src/netting.ts: redeemedIds opt in net(), filtered exactly like settledIds (D-14 SDK half)"
  - "src/domain.ts: DEFAULT_MAX_IOU_LIFETIME_SECONDS = 86_400n (UNCALIBRATED)"
affects:
  - "02-07 (demo layer orchestrates redemption using this client surface; no SDK work remains)"
  - "02-08 (PROTOCOL.md documents the L-convention and calldata-reconstruction regime)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Size-parameterized explicit gas: BASE + PER_PARTICIPANT*n + PER_ID*m from forge-measured coefficients — never estimation on Arc (USDC gas-token gotcha)"
    - "Calldata-as-data-availability: fetchManifest decodes executeRound calldata via decodeFunctionData; leaf sets are signature-bound, never coordinator-served"
    - "Contract-derived proof range: prepareRedemptionProofs mirrors min(roundNonce, RING) ascending exactly as redeemIOU checks it"

key-files:
  created: []
  modified:
    - src/abi/ClearingHubV2.ts
    - src/client.ts
    - src/iou.ts
    - src/netting.ts
    - src/domain.ts
    - demo/setup.ts
    - test/genFixture.ts
    - test/eip712.test.ts
    - test/rebuild.test.ts

decisions:
  - "Gas constants exported (EXECUTE_ROUND_GAS_BASE 300k, PER_PARTICIPANT 40k, PER_ID 6k, REDEEM_IOU_GAS 500k) with doc comments citing the 02-05 forge measurements and date — >=1.5x margin at every measured executeRound point, 2.51x for redeemIOU"
  - "prepareRedemptionProofs delegates empty manifests to nonInclusionProof([], id), whose empty-list branch already returns the plan's structurally-valid belowFirst placeholder — one code path instead of a duplicated placeholder construction"
  - "signIou opts (now/maxIouLifetimeSeconds) come AFTER the existing chainId param so every v1 call-site signature survives; default now = wall clock in seconds"
  - "checkIouLifetime is the throw-free verification half; signIou throws with interpolated expiry/now/L per the precondition style"

requirements-completed: [MERK-03, MERK-04]

# Metrics
metrics:
  duration: "9m"
  tasks: 3
  completed: "2026-07-23T01:32:30Z"
---

# Phase 2 Plan 06: SDK Wiring — V2 ABI, Redemption Client Surface, L-Convention Summary

HubClient rebound to the regenerated ClearingHubV2 ABI with measured size-aware explicit gas (retiring the hardcoded 1.5M limit), full creditor tooling (reads, calldata manifest reconstruction, contract-derived proof assembly, redeemIOU write), and both SDK-side protocol halves live: signIou refuses expiry > now + L (D-15) and net() excludes redeemedIds like settledIds (D-14) — with zero digest-fixture drift.

## What Was Built

- **src/abi/ClearingHubV2.ts (regenerated):** ABI + creation bytecode from `contracts/out/ClearingHubV2.sol/ClearingHubV2.json` after `forge build`, same module shape (`clearingHubV2Abi` const assertion + `clearingHubV2Bytecode`). Now carries the consumedIds `executeRound`, `redeemIOU` (Iou tuple + NonInclusionProof[] tuples), `hashIou`, `rootRing`, `lastRound`, `redeemed`, `K`/`RING`/`MAX_IOU_LIFETIME` getters, and the 4-arg constructor.
- **src/client.ts:**
  - All HubClient methods rebound to `clearingHubV2Abi`; `export { clearingHubAbi }` re-export untouched for v1 integrators.
  - `executeRound(wallet, proposal, signatures)` (signature unchanged — coordinator call sites survive) submits `[nonce, participants, deltas, consumedIds, signatures]` with `gas = EXECUTE_ROUND_GAS_BASE + PER_PARTICIPANT*n + PER_ID*m` — exported constants 300_000n / 40_000n / 6_000n from 02-05's measured coefficients (measurement-citing doc comment: m=10 → 329,108; m=105 → 691,708; m=250 → 1,254,993; ≥1.5x margin at each point).
  - `redeemIOU(wallet, iou, sig, proofs)` with flat `REDEEM_IOU_GAS = 500_000n` (2.51x the measured RING=16 199,604) + `maxFeePerGas: MIN_MAX_FEE_PER_GAS`; module-private `toAbiProof` mapper widens index/leafCount to bigint and maps kind → 0|1|2 in Solidity enum order.
  - Reads copying the collateral pattern with uint64 BigInt coercion: `lastRound(addr)`, `redeemed(id)`, `rootRing(slot)` → `{root, nonce, executedAt}`, `hashIou(iou)`, `ringSize()` (RING immutable).
  - `fetchManifest(nonce)`: `getContractEvents` (RoundExecuted, indexed nonce) → `getTransaction` → `decodeFunctionData` against `clearingHubV2Abi` → `args[3]` (consumedIds). Doc comment states the zero-trust rationale: the id list is signature-bound via the digest; never a coordinator endpoint.
  - `prepareRedemptionProofs(id)`: derives the buffered range from on-chain `roundNonce`/`RING` exactly as the contract does (ascending, count = min(roundNonce, RING)), builds one `nonInclusionProof` per buffered round; empty manifests yield the structurally-valid placeholder; TOCTOU regeneration note in the doc comment.
- **src/iou.ts:** `checkIouLifetime(iou, {now, maxIouLifetimeSeconds?})` → `{ok, reason?}` (never throws); `signIou` gains trailing `opts?: {now?, maxIouLifetimeSeconds?}` after `chainId`, defaults `now` to wall clock, and throws with interpolated expiry/now/L on violation. Doc comment carries the safety story: honest signing pins every consuming round inside [expiry − L, expiry); a violator weakens only their own double-claim protection.
- **src/netting.ts:** `redeemedIds?: ReadonlySet<Hex>` opt, filtered at the rule-3 site identically to settledIds (lowercase + raw key check); numbered-rules doc comment updated for redeemed exclusion (D-14).
- **src/domain.ts:** `DEFAULT_MAX_IOU_LIFETIME_SECONDS = 86_400n`, UNCALIBRATED-labeled, mirrors the hub deploy default.
- **demo/setup.ts:** anvil `deployContract` args extended to `[token, 3n, 16n, 86_400n]` (DeployV2.s.sol's uncalibrated defaults) — the one demo-side compile fix in scope.
- **Call-site audit:** `test/genFixture.ts` passes fixed `now = 4_102_444_800n − 86_400n` (boundary-safe under `<=`) — regenerated `digest.json` is byte-identical; `test/eip712.test.ts` / `test/rebuild.test.ts` pass explicit `{now: NOW}` (their fixed NOW = 1.8e9 is ahead of wall clock, so defaults would have refused); `demo/simulate.ts` (1h expiry) and `demo/e2e.ts` (farExpiry = now + L boundary) confirmed convention-safe with no change. Two new unit cases: L-convention refusal/boundary/override, and redeemedIds exclusion.

## Task Commits

| Task | Commit | Message |
| ---- | ------ | ------- |
| 1 | `6759783` | feat(02-06): rebind HubClient to regenerated V2 ABI with measured explicit gas |
| 2 | `e7ee9b4` | feat(02-06): creditor tooling — reads, fetchManifest, prepareRedemptionProofs |
| 3 | `62d0ba6` | feat(02-06): L-convention at signing and redeemed-id exclusion in net() |

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 64/64 green (62 pre-existing + 2 new)
- `npm run fixture` → `git diff --exit-code test/fixtures/digest.json` — byte-identical (deterministic ECDSA confirmed; merkle.json unchanged too)
- `cd contracts && forge test` — 81/81 green (contracts untouched; regenerated ABI matches the tested surface)
- Greps: zero `gas: 1_500_000n` anywhere; zero `estimateGas`/`estimateContractGas`; every write sets `maxFeePerGas: MIN_MAX_FEE_PER_GAS` + explicit `gas`; `decodeFunctionData` present in fetchManifest; no coordinator-endpoint fallback exists
- No file deletions in any commit; working tree clean before SUMMARY

## Deviations from Plan

### Simplification (no behavior change)

**prepareRedemptionProofs empty-manifest branch delegates to nonInclusionProof**
- The plan prescribed an explicit if-empty branch pushing a placeholder proof; `nonInclusionProof([], id)` (src/merkle.ts) already returns exactly that structurally-valid belowFirst placeholder for empty lists, so a single unconditional call covers both cases. Behavior is identical; the doc comment notes the sentinel path.

Otherwise: plan executed as written. The redeemedIds unit case the acceptance criteria requested landed in `test/eip712.test.ts` (which already imports `net`), alongside an L-convention case.

## Known Stubs

None — no placeholder values, no unwired data paths. `DEFAULT_MAX_IOU_LIFETIME_SECONDS` and the demo deploy defaults are deliberately UNCALIBRATED and labeled as such (honest-calibration requirement, not a stub).

## Threat Flags

None beyond the plan's register. All mitigate dispositions discharged: T-02-25 (exported measured-gas constants on every write; grep-verified no estimation path), T-02-26 (fetchManifest decodes executeRound calldata only, zero-trust doc comment), T-02-27 (signIou refuses expiry > now + L; checkIouLifetime for verifiers; incentive analysis in the doc comment), T-02-28 (prepareRedemptionProofs derives the range from on-chain roundNonce/RING, never caller input). T-02-SC: no package installs occurred.

## Next Phase Readiness

- 02-07 (demo layer) only orchestrates: coordinator wiring for redemption flows, redeemedIds feeding from `redeemed()` reads / IouRedeemed events, e2e redemption scenario — all client primitives exist
- 02-08 (PROTOCOL.md) documents: the L signing convention with its coverage argument, calldata-reconstruction as the canonical manifest source, and the gas formula's measurement anchors
- Post-Phase-1 hardening confirmed non-regressed: screenConsents / pendingSubmission reconciliation / verifyProposal nonce+overlap pinning all live in the still-green rebuild.test.ts suite

## Self-Check: PASSED

- src/abi/ClearingHubV2.ts (redeemIOU + consumedIds present), src/client.ts (clearingHubV2Abi binding + gas constants + fetchManifest + prepareRedemptionProofs), src/iou.ts (checkIouLifetime), src/netting.ts (redeemedIds), src/domain.ts (DEFAULT_MAX_IOU_LIFETIME_SECONDS) — all on disk
- Commits 6759783, e7ee9b4, 62d0ba6 all present in git log
- tsc clean; vitest 64/64; forge 81/81; digest.json byte-identical after regeneration

---
*Phase: 02-merkle-manifests-iou-redemption-brief-phase-1*
*Completed: 2026-07-23*
