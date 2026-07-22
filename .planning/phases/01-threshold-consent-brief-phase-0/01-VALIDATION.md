---
phase: 1
slug: threshold-consent-brief-phase-0
status: draft
nyquist_compliant: false
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
| **Quick run command** | `npx vitest run test/rebuild.test.ts` / `cd contracts && forge test --match-contract ClearingHubV2 -vvv` |
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
| TBD | TBD | — | CONS-01 | — | stall → snapshot at deadline, no partial settle | unit (fake providers, ms windows) | `npx vitest run test/rebuild.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | CONS-02 | — | rebuild drops excluded IOUs, recomputes, final set signs final digest | property (fast-check) | `npx vitest run test/rebuild.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | CONS-03 | — | every settled movement signed over exact executed set | property + Foundry revert matrix | `npx vitest run test/rebuild.test.ts` && `npm run test:contracts` | ❌ W0 (TS) / ✅ (Sol) | ⬜ pending |
| TBD | TBD | — | CONS-04 | — | excluded IOU settles next round; never twice | sequence unit + e2e | `npx vitest run test/rebuild.test.ts`; `npm run e2e:anvil` | ❌ W0 / scenario ❌ | ⬜ pending |
| TBD | TBD | — | CONS-05 | — | zero-sum after redistribution | property | `npx vitest run test/rebuild.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | CONS-06 | — | V2 digest parity vs existing fixture | Foundry parity test | `cd contracts && forge test --match-contract DigestParityV2 -vvv` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/rebuild.test.ts` — stubs for CONS-01..CONS-05 TS-side (reuse `fakeIou` helper pattern from `test/netting.test.ts`)
- [ ] `contracts/test/ClearingHubV2Parity.t.sol` — CONS-06 / D-11 digest parity vs existing `test/fixtures/digest.json`
- [ ] `src/abi/ClearingHubV2.ts` — required before `e2e:anvil` can exercise V2 bytecode
- No framework installs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Griefing analysis documented | CONS-05 | Prose quality judgment | Confirm `docs/PROTOCOL.md` threshold-consent section states the two-pass latency bound and roundNonce single-execution argument |
| Arc testnet V2 deployment live | D-12 | External network side effect | Deploy USDC+EURC V2 hubs, verify on arcscan, record addresses |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
