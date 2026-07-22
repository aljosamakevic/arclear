---
phase: 01-threshold-consent-brief-phase-0
plan: 02
subsystem: contracts
tags: [solidity, foundry, eip712, digest-parity, deploy-tooling]
requires: []
provides:
  - "ClearingHubV2.sol — near-verbatim v2 settlement contract (execution path byte-identical to v1)"
  - "DigestParityV2Test — machine-checked D-11 proof against the unchanged v1 fixture"
  - "src/abi/ClearingHubV2.ts — clearingHubV2Abi + clearingHubV2Bytecode for anvil deploys"
  - "DeployV2.s.sol — TOKEN_ADDRESS-parameterized V2 deploy with Arc gas discipline"
affects: [01-04, 01-05]
tech-stack:
  added: []
  patterns:
    - "deployCodeTo parity test against a shared TS/Solidity JSON fixture"
    - "abi/bytecode TS module generated programmatically from forge out JSON"
key-files:
  created:
    - contracts/src/ClearingHubV2.sol
    - contracts/test/ClearingHubV2Parity.t.sol
    - contracts/script/DeployV2.s.sol
    - src/abi/ClearingHubV2.ts
  modified:
    - .env.example
key-decisions:
  - "V2 header NatSpec documents that threshold consent (exclude-and-recompute, two-pass) lives entirely off-chain; on-chain path unchanged (D-09)"
  - "Parity test reads the SAME test/fixtures/digest.json — no regeneration (D-11)"
  - "V2 env keys appended alongside v1 keys; v1 hubs stay live as Arclear Net v1 (D-12)"
duration: 4min
completed: 2026-07-22
---

# Phase 1 Plan 02: ClearingHubV2 + Parity + Deploy Artifacts Summary

ClearingHubV2 ships as a byte-identical-execution-path copy of ClearingHub (name + header NatSpec only diffs), proven by a digest-parity test against the unchanged v1 fixture, with forge deploy script and TS abi/bytecode module ready for Plans 04/05.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | ClearingHubV2.sol near-verbatim copy | fffdb00 | contracts/src/ClearingHubV2.sol |
| 2 | V2 digest-parity test vs existing fixture | 54c52f5 | contracts/test/ClearingHubV2Parity.t.sol |
| 3 | Deploy script, TS abi module, env keys | 9c7adb2 | contracts/script/DeployV2.s.sol, src/abi/ClearingHubV2.ts, .env.example |

## What Was Built

- **contracts/src/ClearingHubV2.sol** (182 lines): full copy of ClearingHub.sol with exactly two diffs — `contract ClearingHubV2` rename and a rewritten @title/@notice/@dev header stating the threshold-consent protocol lives off-chain and the execution path is identical to v1. `diff` confirms no hunks inside executeRound/hashRound/withdraw/deposit/errors/events/constructor. `withdraw` remains `external nonReentrant` with no `whenNotPaused` and its "Deliberately NOT pausable" why-comment intact. Same `EIP712("ArcClearingHub", "1")` domain and `ROUND_TYPEHASH`.
- **contracts/test/ClearingHubV2Parity.t.sol**: `DigestParityV2Test.test_v2DigestMatchesV1SdkFixture` mirrors DigestParity.t.sol with three substitutions (import, `"ClearingHubV2.sol:ClearingHubV2"` artifact string, hub type). Reads the SAME `../test/fixtures/digest.json`; asserts digest equality (message: "V2 digest diverges from v1 fixture - D-11 violated") and ECDSA consent recovery. Passes; original v1 DigestParityTest also still passes; `git status --porcelain test/fixtures/` empty.
- **contracts/script/DeployV2.s.sol**: mirrors Deploy.s.sol; reads `TOKEN_ADDRESS` via `vm.envAddress`, deploys inside broadcast, logs the address; usage doc-comment carries `--with-gas-price 25gwei` (Arc gas-token gotcha).
- **src/abi/ClearingHubV2.ts**: generated programmatically (one-off node script reading `contracts/out/ClearingHubV2.sol/ClearingHubV2.json`) — exactly two exports, `clearingHubV2Abi` and `clearingHubV2Bytecode` (`as const`). Automated check confirmed V2 bytecode differs from v1 (metadata/name hash) while the ABI entry-name surface matches v1 exactly. Not barreled in src/index.ts (matches v1 ClearingHub.ts).
- **.env.example**: appended `HUB_V2_USDC=` / `HUB_V2_EURC=` with a D-12 comment; v1 `HUB_USDC=`/`HUB_EURC=` untouched.

## Verification Evidence

- `forge build` clean; `forge test`: 27/27 pass (4 suites, incl. new DigestParityV2Test and all v1 suites, 512-run fuzz)
- `npx tsc --noEmit` exit 0
- V2/v1 abi comparison script: "abi ok" (bytecode differs, ABI names identical)
- `git status --porcelain test/fixtures/` empty — no fixture regeneration

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan's inline `npx tsx -e` verification snippet fails under tsx eval (top-level await in CJS eval mode)**
- **Found during:** Task 3 verification
- **Issue:** `tsx -e "await import(...)"` transforms eval input as CJS, rejecting top-level await on Node v24/tsx 4.x
- **Fix:** Ran the identical assertions from a `.mts` script file in the scratchpad (absolute-path imports); logic unchanged, printed "abi ok"
- **Files modified:** none (scratchpad only)
- **Commit:** n/a

**Note:** The plan's `read_first` referenced `.planning/phases/01-threshold-consent-brief-phase-0/01-PATTERNS.md`, which does not exist on disk. Not a blocker — the copy-verbatim checklist is fully embedded in the task action text; executed from that.

## Known Stubs

None — no placeholder values or unwired components introduced.

## Threat Flags

None — no new external surface beyond what the plan's threat model registers. T-01-05/06/07 mitigations verified by diff-scoped copy + parity test; T-01-08 mitigated by the automated v1-vs-v2 bytecode/ABI check. No package installs (T-01-SC: accepted, none occurred).

## Self-Check: PASSED
