---
phase: 2
slug: merkle-manifests-iou-redemption-brief-phase-1
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-22
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
| TBD | TBD | — | MERK-01 | — | root fills same bytes32 field; Round digest encoding unchanged | parity | `cd contracts && forge test --match-contract 'DigestParity\|ClearingHubV2Parity'` | ✅ (values regenerate) | ⬜ pending |
| TBD | TBD | — | MERK-02 | — | TS↔Sol byte-identical roots + inclusion + non-inclusion; shuffle determinism; adversarial lies rejected | unit/property/parity | `npx vitest run test/merkle.test.ts`; `forge test --match-contract 'ManifestMerkle\|MerkleParity'` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | MERK-03 | — | redeemIOU happy path + full revert matrix | unit (forge harness) | `forge test --match-contract ClearingHubV2` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | MERK-04 | — | nullifier idempotence; redeem→cannot-net; net→cannot-redeem; L-coverage fail-closed | unit + fuzz | `forge test --match-test 'test_.*redeem\|testFuzz_.*redeem'` | ❌ W0 | ⬜ pending |
| TBD | TBD | — | D-17 | — | e2e: stall past K rounds → redeem → debited → id never settles later | e2e (anvil) | `npm run e2e:anvil` | ✅ extend | ⬜ pending |
| TBD | TBD | — | gas | — | executeRound m∈{10,105,250}; redeemIOU k=16 measured | gas snapshot | `cd contracts && forge snapshot --match-test 'test_gas'` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/merkle.test.ts` — MERK-02 properties (shuffle determinism, verify/reject, bracketing edges, case-normalization)
- [ ] `contracts/test/ManifestMerkle.t.sol` — unit + adversarial fuzz (index/count lies, node-as-leaf, duplicate promotion)
- [ ] `contracts/test/MerkleParity.t.sol` — reads `test/fixtures/merkle.json`
- [ ] `test/genFixture.ts` extension — `merkle.json` vectors + `iouSig` field in `digest.json`
- [ ] `contracts/test/ClearingHubV2.t.sol` — redeemIOU revert matrix + exclusivity + gas tests (V2 harness variant; RoundBuilder pins v1)
- No framework installs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Arc testnet V2 redeploy live | D-11 | External network side effect | Deploy USDC+EURC hubs, verify on arcscan, record addresses |
| PROTOCOL.md manifest/redemption spec quality | D-16/D-17 | Prose judgment | Confirm spec matches implemented bracketing + coverage rules |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
