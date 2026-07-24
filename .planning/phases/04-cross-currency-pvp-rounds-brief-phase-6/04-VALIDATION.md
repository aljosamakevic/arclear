---
phase: 4
slug: cross-currency-pvp-rounds-brief-phase-6
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-24
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 (TS) + forge 1.3.5 (Solidity, via_ir, fuzz runs 512) |
| **Config file** | `vitest.config.ts`; `contracts/foundry.toml` |
| **Quick run command** | `npm test` / `cd contracts && forge test --match-contract 'PvP'` |
| **Full suite command** | `npm test && npm run test:contracts && npm run e2e:anvil` |
| **Estimated runtime** | ~10 s quick; ~3 min full incl. e2e |

---

## Sampling Rate

- **After every task commit:** `npm test` (+ `forge test --match-contract PvP*` when contracts changed)
- **After every plan wave:** `npm test && npm run test:contracts`
- **Before `/gsd:verify-work`:** full suite incl. `npm run e2e:anvil` green; regenerate fixtures before parity runs whenever genFixture changed; testnet router deploy (D-10) at phase end
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | — | PVP-01 | — | both legs settle in one tx, balances exact per fx pair | unit (forge) | `cd contracts && forge test --match-contract PvPRouterTest -vvv` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | PVP-01 | — | either-leg failure reverts everything (full revert matrix incl. evil-hub-immutables, paused hub, union mismatch) | unit (forge) | same | ❌ W0 | ⬜ pending |
| TBD | TBD | — | PVP-01 | — | single-leg direct submission settles — documented limitation, machine-recorded | unit (forge) | `forge test --match-test test_singleLegDirectSubmission` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | PVP-01 (D-11) | — | e2e both-or-neither positive + sabotaged-leg negative on anvil | e2e | `npm run e2e:anvil` | ❌ extend | ⬜ pending |
| TBD | TBD | — | PVP-02 (D-05) | — | PvPRound TS↔Solidity digest + recovery parity via shared fixture | parity (forge) | `forge test --match-contract PvPParityTest` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | PVP-02 | — | pvpDigest/sign/verify roundtrip; verifyPvPProposal accept/reject | unit + property | `npx vitest run test/pvp.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | PVP-02 | — | union merge correctness (differing/identical/disjoint sets) | property + forge fuzz | `npx vitest run test/pvp.test.ts`; forge fuzz | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/pvp.test.ts` — PVP-02 SDK side
- [ ] `contracts/test/PvPRouter.t.sol` — PVP-01 (dual-hub RoundBuilder-style harness under `contracts/test/utils/`)
- [ ] `contracts/test/PvPParity.t.sol` + `test/genFixture.ts` pvp_* extension — PVP-02 parity (D-05, mandatory)
- No framework installs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live router on Arc testnet + walkthrough | D-10 | Real testnet deploy + explorer verification | Deploy PvPRouter (hub pair as constructor immutables), verify on arcscan, record address, run demo walkthrough |
| PROTOCOL/THREAT-MODEL PvP sections read honestly | D-13 | Prose judgment | Single-leg limitation stated plainly; FX rate "agreed, not oracle-derived" framing present |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
