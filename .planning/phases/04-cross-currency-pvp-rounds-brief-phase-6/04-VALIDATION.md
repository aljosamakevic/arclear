---
phase: 4
slug: cross-currency-pvp-rounds-brief-phase-6
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-24
updated: 2026-07-24
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
| 04-01-T1 | 04-01 | 1 | PVP-02 | T-04-01 | pvpDigest determinism/sensitivity; consent roundtrip; wrong-signer rejected | unit (vitest) | `npx vitest run test/pvp.test.ts` | created in-task (Wave 0) | ⬜ pending |
| 04-01-T2 | 04-01 | 1 | PVP-02 | T-04-02/03 | verifyPvPProposal accept/reject (leg tamper, digest, rate, direction); union merge; rateConsistent | unit + property | `npx vitest run test/pvp.test.ts` | created in-task | ⬜ pending |
| 04-02-T1 | 04-02 | 1 | PVP-01, PVP-02 | T-04-05..10 | router compiles: immutables, canonical typehash, no try/catch, stateless (grep gates) | build + grep | `cd contracts && forge build && forge inspect PvPRouter abi` | n/a | ⬜ pending |
| 04-02-T2 | 04-02 | 1 | PVP-01 | T-04-05 | immutables bound; digest field sensitivity; ZeroRate reverts | unit (forge) | `cd contracts && forge test --match-contract PvPRouterTest -vvv` | created in-task (Wave 0) | ⬜ pending |
| 04-03-T1 | 04-03 | 2 | PVP-02 (D-05) | T-04-12/13 | pvp_* fixture keys generated, pre-existing keys untouched, TS fixture lock | fixture + unit | `npm run fixture && npx vitest run test/pvp.test.ts` | extends Wave-0 file | ⬜ pending |
| 04-03-T2 | 04-03 | 2 | PVP-02 (D-05) | T-04-12/14 | TS↔Solidity PvPRound digest + ECDSA recovery parity | parity (forge) | `cd contracts && forge test --match-contract PvPParityTest -vvv` | created in-task (Wave 0) | ⬜ pending |
| 04-04-T1 | 04-04 | 2 | PVP-01 | T-04-15 | both legs settle in one tx; nonces + collateral deltas exact on both hubs; identical/overlapping/disjoint sets | unit (forge) | `cd contracts && forge test --match-contract PvPRouterTest -vvv` | extends Wave-0 file | ⬜ pending |
| 04-04-T2 | 04-04 | 2 | PVP-01 | T-04-15/16/17 | full revert matrix (bad leg sig, nonce, collateral, pause, PvP sig, union, digest mismatch, replay) + single-leg direct submission settles (documented limitation) | unit (forge) | `cd contracts && forge test --match-test test_singleLegDirectSubmissionSettles -vvv` and matrix | extends Wave-0 file | ⬜ pending |
| 04-04-T3 | 04-04 | 2 | PVP-01 | T-04-18 | measured executePvP gas + snapshot + formula constants + PvPRouterClient explicit gas | gas (forge) + tsc | `cd contracts && forge test --match-test test_gas_executePvP -vvv && npx tsc --noEmit` | extends files | ⬜ pending |
| 04-05-T1 | 04-05 | 3 | PVP-01 | T-04-23 | dual-hub + router anvil bootstrap; HUB_V2_EURC/PVP_ROUTER testnet env; per-hub state | smoke (tsx) | dual-hub bootstrap smoke script (see plan) | n/a | ⬜ pending |
| 04-05-T2 | 04-05 | 3 | PVP-01, PVP-02 (D-07/08/09) | T-04-19/22 | attemptPvPRound: settle/exclude-both-legs/abort/empty outcomes; fx quote mirror (D-06) | unit (vitest) | `npx vitest run test/pvpRound.test.ts` | created in-task (Wave 0) | ⬜ pending |
| 04-05-T3 | 04-05 | 3 | PVP-01 | T-04-20/21 | pending-before-broadcast; nonce-based classification; in-flight hold on both hubs; PvP tag | unit (vitest) | `npx vitest run test/pvpRound.test.ts` | extends file | ⬜ pending |
| 04-06-T1 | 04-06 | 4 | PVP-01 (D-11) | T-04-25 | e2e positive: atomic settle, FX-exact balances both hubs, gasUsed printed (A3) | e2e | `npm run e2e:anvil` | extends demo/e2e.ts | ⬜ pending |
| 04-06-T2 | 04-06 | 4 | PVP-01 (D-11, D-12) | T-04-24/26 | e2e negatives: aborted bundle + forced status:reverted, chain-state asserted; dashboard badge only | e2e + grep | `npm run e2e:anvil` | extends files | ⬜ pending |
| 04-07-T1 | 04-07 | 5 | PVP-01, PVP-02 (D-13) | T-04-29 | docs: typehash literal, "agreed, not oracle-derived", single-leg test cited, gas rows, superseded note | grep | grep gates (see plan) | n/a | ⬜ pending |
| 04-07-T2 | 04-07 | 5 | PVP-01 (D-10) | T-04-27/28/30 | live testnet router, immutables match README hubs, source verified | cast (testnet) | `cast call <router> "hubUSDC()(address)" --rpc-url $ARC_RPC_URL` | n/a | ⬜ pending |
| 04-07-T3 | 04-07 | 5 | D-10/D-13 | T-04-29 | human walkthrough approval | manual (checkpoint) | — (justified below) | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Wave-0 test files are created inside the wave-1/2 plans that introduce their subjects (no separate scaffold wave needed):

- [ ] `test/pvp.test.ts` — created by 04-01-T1 (PVP-02 SDK side), extended by 04-01-T2 and 04-03-T1
- [ ] `contracts/test/PvPRouter.t.sol` — created by 04-02-T2 (smoke), extended by 04-04 (harness-based matrix + gas)
- [ ] `contracts/test/utils/PvPRoundBuilder.sol` — created by 04-04-T1 (dual-hub harness)
- [ ] `contracts/test/PvPParity.t.sol` + genFixture pvp_* keys — created by 04-03 (D-05, mandatory)
- [ ] `test/pvpRound.test.ts` — created by 04-05-T2 (orchestration outcomes)
- No framework installs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live router on Arc testnet + walkthrough | D-10 | Real testnet deploy + explorer verification | 04-07-T3 checkpoint: arcscan source-verified router, cast immutable reads, full suite + e2e run, docs honesty review |
| PROTOCOL/THREAT-MODEL PvP sections read honestly | D-13 | Prose judgment | Single-leg limitation stated plainly; FX rate "agreed, not oracle-derived" framing present (04-07-T3 step 5) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (04-07-T3 is the sole manual checkpoint, justified above)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (created in the plans that need them)
- [x] No watch-mode flags
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned 2026-07-24 (7 plans, 5 waves)
