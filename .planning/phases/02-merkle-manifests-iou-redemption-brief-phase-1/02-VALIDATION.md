---
phase: 2
slug: merkle-manifests-iou-redemption-brief-phase-1
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-22
updated: 2026-07-23
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1 + fast-check 3.22 (TS); forge 1.3.5 (Solidity, 512-run fuzz) |
| **Config file** | `vitest.config.ts`; `contracts/foundry.toml` |
| **Quick run command** | `npx vitest run test/merkle.test.ts` / `cd contracts && forge test --match-contract ManifestMerkle -vvv` |
| **Full suite command** | `npm test && npm run test:contracts` |
| **Estimated runtime** | ~10 s quick; ~90 s full |

---

## Sampling Rate

- **After every task commit:** targeted vitest file + `forge test --match-contract <touched>`
- **After every plan wave:** `npm test && npm run test:contracts`
- **Before `/gsd:verify-work`:** full suite + `npm run e2e:anvil` green; testnet redeploy (D-11) at phase end
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-T1 | 02-01 | 1 | MERK-02 | T-02-01, T-02-04 | TS merkle construction per locked spec; sentinel preserved; lowercase normalization | unit/type | `npx tsc --noEmit && npx vitest run test/merkle.test.ts` | created in-plan (W0 item) | ⬜ pending |
| 02-01-T2 | 02-01 | 1 | MERK-02 | T-02-02, T-02-03 | shuffle determinism; adversarial index/count/sibling/node-as-leaf lies rejected; duplicate throws | property (fast-check) | `npx vitest run test/merkle.test.ts` | ✅ created by 02-01-T2 | ⬜ pending |
| 02-02-T1 | 02-02 | 1 | MERK-02 | T-02-05, T-02-08 | Solidity rootOf/verifyInclusion/verifyNonInclusion; UnsortedLeaves; sentinel | build | `cd contracts && forge build` | — | ⬜ pending |
| 02-02-T2 | 02-02 | 1 | MERK-02 | T-02-05..T-02-08 | unit + adversarial fuzz (lies, tamper, duplication ambiguity) | unit+fuzz (forge 512) | `cd contracts && forge test --match-contract ManifestMerkle -vvv` | ✅ created by 02-02-T2 | ⬜ pending |
| 02-03-T1 | 02-03 | 2 | MERK-01 | T-02-11 | manifestHash body swap only; Round digest encoding unchanged | unit | `npx tsc --noEmit && npm test` | ✅ existing suites | ⬜ pending |
| 02-03-T2 | 02-03 | 2 | MERK-01, MERK-02 | T-02-09 | merkle.json vectors + iou/iouSig emitted; digest.json regenerated deterministically | parity regen | `npm run fixture && npm test && cd contracts && forge test --match-contract 'DigestParity\|ClearingHubV2Parity'` | ✅ regenerated | ⬜ pending |
| 02-03-T3 | 02-03 | 2 | MERK-02 | T-02-10 | TS↔Sol byte-parity: roots, inclusion, non-inclusion, negative + uppercase vectors | parity (forge) | `cd contracts && forge test --match-contract MerkleParity -vvv` | ✅ created by 02-03-T3 | ⬜ pending |
| 02-04-T1 | 02-04 | 3 | MERK-01, MERK-04 | T-02-13, T-02-19, T-02-20 | consumedIds ABI + on-chain root derivation + nullifier check + rootRing + lastRound (all participants) | build+regression | `cd contracts && forge build && forge test --match-contract 'ClearingHub\b\|ClearingHubFuzz\|DigestParity\|ManifestMerkle\|MerkleParity'` | ✅ existing suites | ⬜ pending |
| 02-04-T2 | 02-04 | 3 | MERK-03, MERK-04 | T-02-12, T-02-14..T-02-18 | redeemIOU full gate order, custom errors, fail-closed coverage, pausable-but-withdraw-never | build | `cd contracts && forge build` | matrix follows in 02-05 (next wave) | ⬜ pending |
| 02-04-T3 | 02-04 | 3 | MERK-01, MERK-03 | T-02-14 | constructor encoding fixed; hashIou == iouId; iouSig recovers debtor | parity (forge) | `cd contracts && forge test` | ✅ updated by 02-04-T3 | ⬜ pending |
| 02-05-T1 | 02-05 | 4 | MERK-03 | — | V2 harness: consumedIds rounds, _signIou mirror, on-chain staleness advancement | build | `cd contracts && forge build` | ✅ created by 02-05-T1 | ⬜ pending |
| 02-05-T2 | 02-05 | 4 | MERK-03, MERK-04 | T-02-12..T-02-19, T-02-24 | full revert matrix + exclusivity BOTH directions + conservation + pause boundary + never-participated edges | unit (forge) | `cd contracts && forge test --match-contract ClearingHubV2 -vvv` | ✅ created by 02-05-T2 | ⬜ pending |
| 02-05-T3 | 02-05 | 4 | MERK-03, MERK-04, gas | T-02-21..T-02-23 | fuzz: proof-skip/nullifier-idempotence/perturbation; gas measured m∈{10,105,250} + RING=16 | fuzz + gas snapshot | `cd contracts && forge test --match-contract ClearingHubV2 && forge snapshot --match-test test_gas` | ✅ created by 02-05-T3 | ⬜ pending |
| 02-06-T1 | 02-06 | 5 | MERK-03 | T-02-25 | V2 ABI rebind; consumedIds submit; measured gas formula; no estimation anywhere | type | `npx tsc --noEmit` | ✅ tsc | ⬜ pending |
| 02-06-T2 | 02-06 | 5 | MERK-03 | T-02-26, T-02-28 | fetchManifest from calldata only; prepareRedemptionProofs contract-derived range | type+unit | `npx tsc --noEmit && npm test` | ✅ tsc + suites | ⬜ pending |
| 02-06-T3 | 02-06 | 5 | MERK-04 (D-14/D-15) | T-02-27 | signIou L-enforcement + checkIouLifetime; net() redeemedIds; zero fixture drift | unit + determinism | `npx tsc --noEmit && npm run fixture && git diff --exit-code test/fixtures/digest.json && npm test` | ✅ existing suites | ⬜ pending |
| 02-07-T1 | 02-07 | 6 | MERK-04 (D-14) | T-02-29, T-02-31 | log-driven redeemedIds fold; miss counters untouched; hardening non-regression | type+unit | `npx tsc --noEmit && npm test` | ✅ tsc + suites | ⬜ pending |
| 02-07-T2 | 02-07 | 6 | MERK-03, MERK-04 (D-17) | T-02-30 | e2e: on-chain staleness → redeem → exact debit/credit → id never settles later | e2e (anvil) | `npm run e2e:anvil` | ✅ extended by 02-07-T2 | ⬜ pending |
| 02-08-T1 | 02-08 | 7 | MERK-01..04 (docs) | T-02-34, T-02-36 | spec matches shipped gate order; honesty notes; not-RFC-6962 warning; gas reported | grep gate | `grep -q 'collateralized recovery path' docs/PROTOCOL.md` (+ full gate in plan) | ✅ grep | ⬜ pending |
| 02-08-T2 | 02-08 | 7 | D-11 | T-02-32, T-02-33, T-02-35 | local gate green → explicit-gas redeploy → cast code non-empty → README lineage | deploy + cast | `cast code <addr> --rpc-url $ARC_RPC_URL` | ✅ cast | ⬜ pending |
| 02-08-T3 | 02-08 | 7 | MERK-01..04 | — | human verify: arcscan, e2e redemption walkthrough, spec skim | manual checkpoint | — | manual | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All former Wave-0 gaps are now scheduled as in-plan creations (each test file lands in the same plan as, or the wave immediately after, the code it verifies):

- [x] `test/merkle.test.ts` — created by plan 02-01 Task 2 (wave 1, alongside the module)
- [x] `contracts/test/ManifestMerkle.t.sol` — created by plan 02-02 Task 2 (wave 1, alongside the library)
- [x] `contracts/test/MerkleParity.t.sol` — created by plan 02-03 Task 3 (wave 2, with the fixtures it reads)
- [x] `test/genFixture.ts` extension (merkle.json + iou/iouSig) — plan 02-03 Task 2
- [x] `contracts/test/ClearingHubV2.t.sol` + `RoundBuilderV2.sol` — plan 02-05 (wave 4, immediately after the contract wave; 02-04's interim gate is forge build + parity suites)
- No framework installs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Arc testnet V2 redeploy live | D-11 | External network side effect | Plan 02-08 Task 2/3: deploy USDC+EURC hubs, cast code, verify on arcscan, record addresses |
| PROTOCOL.md manifest/redemption spec quality | D-16/D-17 | Prose judgment | Plan 02-08 Task 3 checkpoint: confirm spec matches implemented bracketing + coverage rules |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (02-08-T3 is the sole human checkpoint, by design)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (scheduled in-plan, see above)
- [x] No watch-mode flags
- [x] Feedback latency < 90s (e2e ~2min runs only at wave 6/7 gates)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved by planner 2026-07-23 (plan set 02-01..02-08)
