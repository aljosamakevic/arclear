---
phase: 1
slug: threshold-consent-brief-phase-0
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-22
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.1 + fast-check ^3.22 (TS); Foundry forge 1.3.5 (Solidity, 512 fuzz runs) |
| **Config file** | `vitest.config.ts`; `contracts/foundry.toml` |
| **Quick run command** | `npx vitest run test/rebuild.test.ts` / `cd contracts && forge test --match-contract DigestParityV2 -vvv` |
| **Full suite command** | `npm test && npm run test:contracts` |
| **Estimated runtime** | ~10 s quick; ~60 s full |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run test/rebuild.test.ts` (or the touched test file)
- **After every plan wave:** Run `npm test && npm run test:contracts`
- **Before `/gsd:verify-work`:** Full suite green + `npm run e2e:anvil` liveness scenario passing; testnet deploy (D-12) after gate
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-03/T1 | 01-03 | 2 | CONS-01 | T-01-09 | stall → snapshot at deadline, no partial settle | unit (fake providers, ms windows) | `npx vitest run test/rebuild.test.ts` | Wave 0: created by 01-01/T1 | ⬜ pending |
| 01-01/T1 | 01-01 | 1 | CONS-02 | T-01-01 | rebuild drops excluded IOUs, recomputes, terminates in fixture-locked buildProposal | property (fast-check) | `npx vitest run test/rebuild.test.ts` | Wave 0: created here | ⬜ pending |
| 01-01/T2 + 01-03/T3 | 01-01, 01-03 | 1, 2 | CONS-03 | T-01-01, T-01-10 | every settled movement signed over exact executed set; lying coordinator refused | property + Foundry revert matrix | `npx vitest run test/rebuild.test.ts && npm run test:contracts` | Wave 0 (TS) / ✅ (Sol: ClearingHub.t.sol carries over) | ⬜ pending |
| 01-03/T3 + 01-04/T3 | 01-03, 01-04 | 2, 3 | CONS-04 | T-01-12 | excluded IOU settles next round; consumed-id sets disjoint | sequence unit + e2e | `npx vitest run test/rebuild.test.ts`; `npm run e2e:anvil` | Wave 0 / e2e scenario added in 01-04/T3 | ⬜ pending |
| 01-01/T1 + 01-05/T1 | 01-01, 01-05 | 1, 4 | CONS-05 | T-01-13 | zero-sum after redistribution; griefing analysis documented | property + doc grep + manual review | `npx vitest run test/rebuild.test.ts`; `grep -q 'a latency cost, never a safety cost' docs/PROTOCOL.md` | Wave 0 | ⬜ pending |
| 01-02/T2 | 01-02 | 1 | CONS-06 | T-01-05 | V2 digest parity vs existing fixture, no regeneration | Foundry parity test | `cd contracts && forge test --match-contract DigestParityV2 -vvv` | Wave 0: created here | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All Wave 0 gaps are scheduled in Wave 1 plans:

- [ ] `test/rebuild.test.ts` — created by Plan 01-01 Task 1 (CONS-01..05 TS-side; reuses `fakeIou` pattern from `test/netting.test.ts`); extended by 01-01/T2, 01-03/T1, 01-03/T3
- [ ] `contracts/test/ClearingHubV2Parity.t.sol` — created by Plan 01-02 Task 2 (CONS-06 / D-11 digest parity vs existing `test/fixtures/digest.json`, contract `DigestParityV2Test`)
- [ ] `src/abi/ClearingHubV2.ts` — created by Plan 01-02 Task 3 (required before `e2e:anvil` can exercise V2 bytecode)
- No framework installs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Griefing analysis documented | CONS-05 | Prose quality judgment | Plan 01-05 Task 1 automated greps assert presence; human confirms the two-pass latency bound and roundNonce single-execution argument read correctly (01-05 Task 3 checkpoint, step 5) |
| Arc testnet V2 deployment live | D-12 | External network side effect | Plan 01-05 Task 2 deploys USDC+EURC V2 hubs; Task 3 checkpoint verifies on arcscan and records addresses |
| Dashboard exclusion-round display | D-14 | Visual verification | Plan 01-05 Task 3 checkpoint: stall → rebuild phases → exclusion row in round history |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (all three gaps scheduled in Wave 1)
- [x] No watch-mode flags (all commands use `vitest run` / `forge test`)
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned 2026-07-22 (planner) — `wave_0_complete` flips during Wave 1 execution
