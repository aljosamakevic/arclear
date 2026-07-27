---
phase: audit-scope-D-tests
reviewed: 2026-07-27T14:55:00Z
depth: deep
files_reviewed: 21
files_reviewed_list:
  - test/netting.test.ts
  - test/eip712.test.ts
  - test/rebuild.test.ts
  - test/merkle.test.ts
  - test/pvp.test.ts
  - test/pvpRound.test.ts
  - test/thresholdModel.test.ts
  - test/thresholdCrossValidation.test.ts
  - test/genFixture.ts
  - contracts/test/ClearingHubV2.t.sol
  - contracts/test/PvPRouter.t.sol
  - contracts/test/ManifestMerkle.t.sol
  - contracts/test/MerkleParity.t.sol
  - contracts/test/PvPParity.t.sol
  - contracts/test/ClearingHubFuzz.t.sol
  - contracts/test/utils/RoundBuilderV2.sol
  - demo/thresholdModel.ts
  - demo/thresholdSweep.ts
  - demo/marginSweep.ts
  - demo/flowModel.ts
  - demo/sweep.ts
findings:
  critical: 5
  warning: 15
  info: 5
  total: 25
status: issues_found
---

# Audit Scope D — Test Quality & Statistical Honesty

**Reviewed:** 2026-07-27
**Depth:** deep (read + mutation testing in an out-of-tree scratch copy)
**Status:** issues_found

## Summary

Both suites run green and the headline counts are true: `npx vitest run` → **120 passed / 8 files**; `forge test` → **101 passed / 9 suites**. The published CSV numbers are **exactly reproducible** — I re-derived four `threshold-sweep.csv` cells from `demo/thresholdModel.ts` and got byte-identical values, and every README sweep number I spot-checked against `docs/sweep/sweep.csv` matched. The threshold cross-validation is **genuinely non-vacuous** (20 two-pass settles, 24 aborts, 72 excluded-member events across 200 simulated rounds) and it **does** catch model drift (a one-line change to the exclusion batching fails it immediately).

That is the good news, and it is where the good news stops.

I mutated 19 source locations in a scratch copy of the repo (`/private/tmp/.../scratchpad/mut`, never the repo) and re-ran the full suites. **12 mutations survived** — including the deletion of `ClearingHubV2`'s zero-sum enforcement, which is the *only* defense against collateral minting because `verifyProposal` deliberately checks only the caller's own delta. Seven separate guard clauses can be stripped from the deployed V2 contract with 101/101 still green: the entire "revert matrix" the README advertises belongs to the **v1** `ClearingHub`, a different source file. Symmetrically, all four soundness guards in `src/merkle.ts`'s non-inclusion verifier can be deleted with 120/120 green, and the TS half of the "TS↔Solidity merkle byte-parity" claim does not exist at all: `test/fixtures/merkle.json` is read by exactly one file in the repo, `contracts/test/MerkleParity.t.sol`. Changing `NODE_PREFIX` from `0x01` to `0x02` in `src/merkle.ts` — which breaks every multi-leaf manifest root — passes the whole TypeScript suite.

On the statistical side the model is honest but the *presentation* has two defects: `demo/marginSweep.ts` never received the empty-sample `NaN` fix its sibling `demo/thresholdSweep.ts` did, so **36 of 144 rows** in `margin-sweep.csv` are no-data rows imputed to `0.0000` — and `docs/CALIBRATION.md` §5 leans on exactly that conflation ("`p99_tail_coverage` is 0.0000 in all 144 rows"). And `threshold-sweep.csv` is labeled "reproducible" while re-running `npm run sweep:threshold` today would rewrite **117 rows** (every cell whose latency sample is empty now emits `NaN`).

Everything below is marked **PROVEN** (mutation run to completion, output quoted) or **REASONED** (argued from code, not executed).

---

## Critical Issues

### CR-01: `ClearingHubV2` — the contract actually deployed on Arc Testnet — has no revert-matrix coverage; 7 guard clauses are deletable with 101/101 green

**File:** `contracts/test/ClearingHubV2.t.sol` (whole file) vs `contracts/src/ClearingHubV2.sol:213-239,163,172,185`
**Severity:** BLOCKER — **PROVEN**

`grep` for the V2 round-path errors shows they are asserted **only** against the v1 contract:

```
contracts/test/ClearingHub.t.sol:125  ClearingHub.ParticipantsNotStrictlyAscending
contracts/test/ClearingHub.t.sol:140  ClearingHub.LengthMismatch
contracts/test/ClearingHub.t.sol:149  ClearingHub.TooFewParticipants
contracts/test/ClearingHub.t.sol:157  ClearingHub.DeltasDoNotSumToZero
contracts/test/ClearingHub.t.sol:30   ClearingHub.InsufficientWithdrawBalance
```

`ClearingHubV2.t.sol` asserts exactly one v1-inherited error (`ZeroAmount` at line 266, and only on the `redeemIOU` path). Mutation results, full `forge test` after each single-line deletion:

| Mutation in `ClearingHubV2.sol` | Result |
|---|---|
| `if (sum != 0) revert DeltasDoNotSumToZero(sum);` deleted (`:239`) | **101 passed / 0 failed** |
| `if (n < 2) revert TooFewParticipants();` deleted (`:215`) | **101 passed / 0 failed** |
| `if (p <= prev) revert ParticipantsNotStrictlyAscending();` deleted (`:234`) | **101 passed / 0 failed** |
| `if (deltas.length != n \|\| signatures.length != n) revert LengthMismatch();` deleted (`:216`) | **101 passed / 0 failed** |
| `if (amount > balance) revert InsufficientWithdrawBalance();` deleted (`:185`) | **101 passed / 0 failed** |
| `if (k_ == 0 \|\| ring_ == 0 \|\| ...) revert BadConfig();` deleted (`:163`) | **101 passed / 0 failed** |
| `if (amount == 0) revert ZeroAmount();` deleted from `deposit` (`:172`) | **101 passed / 0 failed** |

**The zero-sum one is the load-bearing failure.** `src/round.ts:176-181` checks only `proposal.deltas[idx] !== myDelta` — the caller's *own* delta — and `src/round.ts:183-185` explicitly documents that no cross-participant check is performed. So an attacker who is a legitimate participant can inflate **their own** delta by `N`, leave every other delta correct, and every honest member's `verifyProposal` passes and signs. `DeltasDoNotSumToZero` on-chain is the single point of defense, and no test exercises it on V2.

I built the exploit against the mutant to make this concrete (`test/AuditProbe.t.sol` in the scratch copy, since removed):

```
[PASS] test_probe_collateralMinting()          // mutant: guard deleted
[FAIL: DeltasDoNotSumToZero(8000000)]          // real contract
```

The probe funds `actors[0]` with 10e6, executes a signed round with `deltas = [-1e6, +9e6]`, and asserts `collateral[a0] + collateral[a1] > usdc.balanceOf(hub)` — hub insolvency, tokens unchanged, claims inflated by 8e6.

`TooFewParticipants` is the second-most severe: with it gone, `participants.length == 0` skips the signature loop entirely, so **anyone** can advance `roundNonce` with an unsigned empty round, flushing the 16-slot `rootRing` and permanently breaking `redeemIOU`'s coverage window for every outstanding IOU (REASONED — the mutation is proven, the exploit path is argued from `ClearingHubV2.sol:338-344`). `BadConfig` matters because `RING == 0` makes `rootRing[nonce_ % RING]` a division-by-zero panic on the first round, and `K == 0` makes every debtor instantly stale. `LengthMismatch` and `InsufficientWithdrawBalance` are lower — 0.8.x checked arithmetic/bounds already revert, so removing them only degrades the error, not the safety.

**Fix — tests that should exist in `contracts/test/ClearingHubV2.t.sol`:**

```solidity
function test_revert_executeRound_deltasDoNotSumToZero_V2() public {
    _fundAndDeposit(actors[0], 10e6);
    address[] memory p = new address[](2);
    (p[0], p[1]) = (actors[0], actors[1]);
    int256[] memory d = new int256[](2);
    (d[0], d[1]) = (int256(-1e6), int256(9e6)); // sum = +8e6
    bytes32[] memory ids = _manifest(2, "nonzero-sum");
    vm.expectRevert(abi.encodeWithSelector(
        ClearingHubV2.DeltasDoNotSumToZero.selector, int256(8e6)));
    hub.executeRound(0, p, d, ids, _buildSignatures(0, p, d, ids));
}

function test_revert_executeRound_emptyParticipants_V2() public {
    vm.expectRevert(ClearingHubV2.TooFewParticipants.selector);
    hub.executeRound(0, new address[](0), new int256[](0),
                     new bytes32[](0), new bytes[](0));
    assertEq(hub.roundNonce(), 0, "unsigned empty round must not advance the nonce");
}
```

plus `test_revert_executeRound_duplicateParticipant_V2` (`ParticipantsNotStrictlyAscending`), `test_revert_executeRound_lengthMismatch_V2`, `test_revert_withdraw_overBalance_V2`, `test_revert_constructor_badConfig` (all three of `K=0`, `RING=0`, `L=0`), and `test_revert_deposit_zeroAmount_V2`. Better still: promote `ClearingHub.t.sol`'s revert matrix into a shared abstract base parameterized over the hub interface so v1 and v2 can never diverge in coverage again.

---

### CR-02: The TypeScript half of "TS↔Solidity merkle byte-parity" does not exist — `merkle.json` has no TS-side reader

**File:** `test/merkle.test.ts` (whole file), `test/genFixture.ts:235`, `contracts/test/MerkleParity.t.sol:16`
**Severity:** BLOCKER — **PROVEN**

`grep -rn "merkle\.json"` across the repo returns exactly three code hits: the generator (`test/genFixture.ts`), the Solidity reader (`MerkleParity.t.sol`), and a doc comment. **No `.test.ts` file reads it.** `test/merkle.test.ts` is entirely self-referential — every "expected root" is either computed by `merkleRoot` itself or hand-derived only for the single-leaf case (`:34`).

Consequence: `MerkleParity.t.sol` compares Solidity against a *committed* fixture, and nothing compares TypeScript against that fixture. If `src/merkle.ts` drifts, `forge test` still passes (fixture unchanged) and `npm test` still passes (self-consistent). Proven:

```
# src/merkle.ts:6  const NODE_PREFIX: Hex = "0x01";  ->  "0x02"
$ npx vitest run test/merkle.test.ts test/eip712.test.ts test/netting.test.ts \
                test/rebuild.test.ts test/pvp.test.ts
 Test Files  5 passed (5)
      Tests  84 passed (84)
```

`NODE_PREFIX` is the RFC-6962 node-domain separator that `docs/THREAT-MODEL.md` row 14 names as the defense against merkle second-preimage attacks, and `contracts/src/lib/ManifestMerkle.sol:85` hardcodes `0x01`. Changing it silently breaks every multi-leaf `manifestHash`, every round digest over a >1-id manifest, and every redemption proof — with both suites green.

Control mutations that *are* caught, for calibration: `LEAF_PREFIX 0x00 -> 0x03` fails 2 tests (pinned by `merkle.test.ts:34` and the `digest.json` single-leaf `manifestHash` assertion), and a sorted-pair `nodeHash` refactor fails the index-lie property. So the leaf domain and the ordering are pinned; the **node domain and every internal-node byte layout are not**.

`README.md:161-163` advertises "**120 TypeScript tests … merkle byte-parity**". That claim is not supported.

**Fix — test that should exist in `test/merkle.test.ts`:**

```ts
it("matches the shared merkle fixture consumed by MerkleParity.t.sol", () => {
  const f = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "merkle.json"), "utf8"));
  for (const n of [0, 1, 2, 3, 5, 8]) {
    expect(merkleRoot(f[`case${n}_ids`])).toBe(f[`case${n}_root`]);
  }
  const root8 = f.case8_root;
  for (let i = 0; i < 8; i++) {
    expect(verifyInclusion({
      leaf: f[`case8_inc${i}_leaf`], index: f[`case8_inc${i}_index`],
      leafCount: f[`case8_inc${i}_leafCount`], siblings: f[`case8_inc${i}_siblings`],
    }, root8)).toEqual({ ok: true });
  }
  expect(merkleRoot(f.caseUpper_inputIds)).toBe(f.caseUpper_root);
  // negative vector: the member id must never prove non-inclusion
  // (mirror MerkleParity.t.sol:test_negativeVector exactly)
});
```

Additionally, add a CI step that runs `npm run fixture` and fails on a dirty `test/fixtures/` — the fixture is only parity-locking if regeneration is checked.

---

### CR-03: All four soundness guards in `src/merkle.ts`'s non-inclusion verifier are deletable with 120/120 green

**File:** `src/merkle.ts:248-250, 259-264, 279-284, 223-225`; gap in `test/merkle.test.ts:199-240` ("property 4: exclusion soundness")
**Severity:** BLOCKER — **PROVEN**

Mutation results, full `npx vitest run` after each single deletion:

| Guard deleted from `src/merkle.ts` | Result |
|---|---|
| `belowFirst`: `if (a.index !== 0)` (`:248`) | **120 passed / 0 failed** |
| `aboveLast`: `if (a.index !== a.leafCount - 1)` (`:259`) | **120 passed / 0 failed** |
| `bracket`: `if (b.index !== a.index + 1)` (`:279`) | **120 passed / 0 failed** |
| `verifyInclusion`: `if (s !== siblings.length)` (`:223`) | **120 passed / 0 failed** |

The first three are soundness breaks, not cosmetics. With all three removed:

```
belowFirst anchored on leaf3, target = member ids[1]: { ok: true }
aboveLast  anchored on leaf4, target = member ids[6]: { ok: true }
bracket non-adjacent (3,5),  target = member ids[4]: { ok: true }
```

(unmutated, the same three calls return `ok: false` with the correct reasons). Each of those is "a manifest **member** proved its own non-inclusion" — the exact claim `redeemIOU` consumes to decide an IOU was never netted. `src/client.ts` marshals these TS-built proofs straight into the on-chain call, so a broken TS verifier means the SDK happily builds and submits forged redemption proof sets.

Why the existing properties miss it: `test/merkle.test.ts:199-240` only ever constructs `belowFirst`/`aboveLast` from `inclusionProof(ids, 0)` / `inclusionProof(ids, n-1)` and brackets from strictly adjacent `(m-1, m)` / `(m, m+1)` pairs. It never offers a **non-anchor** leaf as the anchor. The Solidity twin *does* test one direction (`ManifestMerkle.t.sol:381-389`, "AboveLast with a non-last leaf must fail") and *does* fuzz bracket non-adjacency (`:482-501`) — which is why the equivalent Solidity mutations are caught. The TS suite has neither.

The unconsumed-siblings guard (4th row) is a lower-severity but real **TS↔Solidity divergence**: Solidity enforces it (`ManifestMerkle.sol:119`, and deleting it fails `ManifestMerkle.t.sol`), TS's is untested. A divergence here means the SDK tells a creditor their proof is valid and the on-chain call reverts `NonInclusionProofInvalid`.

**Fix — properties that should exist in `test/merkle.test.ts`:**

```ts
describe("property 8: anchor binding (non-inclusion soundness)", () => {
  it("rejects a belowFirst/aboveLast claim anchored on a non-boundary leaf", () => {
    fc.assert(fc.property(
      fc.record({ n: fc.integer({ min: 3, max: 64 }), salt: fc.nat(), pick: fc.nat() }),
      ({ n, salt, pick }) => {
        const ids = makeIds(n, salt);
        const root = merkleRoot(ids);
        const m = 1 + (pick % (n - 2));                     // strictly interior
        const anchor = inclusionProof(ids, m);
        // every member strictly below the anchor must fail belowFirst
        expect(verifyNonInclusion(ids[m - 1],
          { kind: "belowFirst", a: anchor, b: { ...anchor } }, root).ok).toBe(false);
        // every member strictly above the anchor must fail aboveLast
        expect(verifyNonInclusion(ids[m + 1],
          { kind: "aboveLast", a: anchor, b: { ...anchor } }, root).ok).toBe(false);
      }));
  });

  it("rejects a non-adjacent bracket that straddles a member", () => {
    fc.assert(fc.property(
      fc.record({ n: fc.integer({ min: 3, max: 64 }), salt: fc.nat(), pick: fc.nat() }),
      ({ n, salt, pick }) => {
        const ids = makeIds(n, salt);
        const root = merkleRoot(ids);
        const i = pick % (n - 2);
        expect(verifyNonInclusion(ids[i + 1],
          { kind: "bracket", a: inclusionProof(ids, i), b: inclusionProof(ids, i + 2) },
          root).ok).toBe(false);
      }));
  });

  it("rejects a proof carrying an extra unconsumed sibling (Solidity parity)", () => {
    const ids = makeIds(8, 1);
    const p = inclusionProof(ids, 0);
    expect(verifyInclusion(
      { ...p, siblings: [...p.siblings, keccak256(toHex("junk"))] },
      merkleRoot(ids)).ok).toBe(false);
  });
});
```

---

### CR-04: Solidity `verifyNonInclusion` BelowFirst anchor check is untested — deletable with 101/101 green, and its absence forges non-inclusion for a member

**File:** `contracts/src/lib/ManifestMerkle.sol:137`; gap in `contracts/test/ManifestMerkle.t.sol:340-365`
**Severity:** BLOCKER — **PROVEN**

```
# ManifestMerkle.sol:137  `&& p.a.index == 0` removed
$ forge test
Ran 9 test suites: 101 tests passed, 0 failed, 0 skipped (101 total tests)
```

The symmetric `AboveLast` guard **is** covered (`ManifestMerkle.t.sol:381-389`), so removing *that* fails 1 test. `BelowFirst` has only the positive path (`:340-365`) and the "id equals the first leaf" case (`:233-241`). Nothing offers a higher leaf as the "first" anchor.

Exploit probe against the mutant (scratch copy, since removed):

```solidity
bytes32[] memory ids = _manifest(5, "probe");
p.kind = BelowFirst;
p.a    = _inclusionProof(ids, 3);            // anchor leaf 3, not leaf 0
ManifestMerkle.verifyNonInclusion(ids[1], p, root)   // ids[1] IS a member
```
→ `[PASS]` under the mutant (returns `true`), `[FAIL: member id did NOT prove non-inclusion]` against the real library. In `redeemIOU`, the prover chooses `kind` and the anchor freely (`ClearingHubV2.sol:358-365`), so this is a direct path to redeeming already-netted paper.

**Fix — mirror the existing `AboveLast` negative into `test_verifyNonInclusion_belowFirst`:**

```solidity
// a non-first leaf offered as "first" must fail the index gate
ManifestMerkle.NonInclusionProof memory q = ManifestMerkle.NonInclusionProof({
    kind: ManifestMerkle.NonInclusionKind.BelowFirst,
    a: _inclusionProof(ids, 2),
    b: _emptyProof()
});
assertFalse(
    ManifestMerkle.verifyNonInclusion(ids[1], q, root),
    "BelowFirst with a non-first leaf must fail"
);
```

and extend `testFuzz_bracketAdjacencyLie_rejected` with a `testFuzz_boundaryAnchorLie_rejected` covering both `BelowFirst` and `AboveLast` over fuzz-chosen interior anchors.

---

### CR-05: `verifyProposal`'s manifest binding is untested — the check that ties the shown `consumedIds` to the signed root can be deleted with 120/120 green

**File:** `src/round.ts:187-189`; gap across `test/eip712.test.ts`, `test/rebuild.test.ts`
**Severity:** BLOCKER — **PROVEN**

```
# src/round.ts:187-189  manifestHash(proposal.consumedIds) !== proposal.manifestHash  -> removed
$ npx vitest run   → Test Files 8 passed (8) / Tests 120 passed (120)
```

`grep -rn "manifestHash does not match" test/` returns nothing. Three of `verifyProposal`'s five refusal branches have **no** test at all: `"self not in participant set"` (`:171`), `"manifestHash does not match consumedIds"` (`:188`), `"digest does not match proposal contents"` (`:192`).

Why it matters: `signConsent` (`src/round.ts:198-211`) signs `roundMessage(proposal)`, which takes `manifestHash` **verbatim** from the proposal object. `ClearingHubV2.executeRound` then derives the root from the *submitted* `consumedIds` (`ClearingHubV2.sol:226`). So a coordinator can display list `L1` to a participant while setting `proposal.manifestHash = root(L2)`, collect the signature, and submit `L2` on-chain — the digest matches, the round executes, and `L2`'s ids are nullified against a signature the participant gave for `L1`. `src/round.ts:187-189` is the only thing that stops that, and it is untested. `verifyPvPProposal` inherits the same gap via its per-leg delegation (`src/pvp.ts:219,227`).

The near-miss is `test/eip712.test.ts:101`:

```ts
expect(check.reason).toMatch(/delta mismatch|digest/);
```

The `|` makes it impossible to tell which branch fired — this assertion passes purely on the delta path and can never fail on the digest path.

**Fix — tests that should exist in `test/eip712.test.ts`:**

```ts
it("refuses a proposal whose manifestHash does not commit to the shown consumedIds", async () => {
  const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, { now: NOW });
  const b = await signIou(HUB, iou(bob.address, alice.address, 30n, 1n), bob, undefined, { now: NOW });
  const proposal = buildProposal(HUB, 0n, net([a, b], { now: NOW }));
  // coordinator shows THESE ids but commits to a different manifest, and
  // recomputes the digest so ONLY the manifest check can fire.
  const p = { ...proposal, manifestHash: manifestHash([("0x" + "cd".repeat(32)) as Hex]) };
  const swapped = { ...p, digest: roundDigest(HUB, p) };
  const check = verifyProposal(HUB, swapped, [a, b], alice.address, { now: NOW });
  expect(check.ok).toBe(false);
  expect(check.reason).toBe("manifestHash does not match consumedIds");
});

it("refuses a proposal whose digest field does not match its contents", async () => {
  const a = await signIou(HUB, iou(alice.address, bob.address, 100n), alice, undefined, { now: NOW });
  const proposal = buildProposal(HUB, 0n, net([a], { now: NOW }));
  const check = verifyProposal(HUB, { ...proposal, digest: ("0x" + "ff".repeat(32)) as Hex },
                               [a], alice.address, { now: NOW });
  expect(check.ok).toBe(false);
  expect(check.reason).toBe("digest does not match proposal contents");
});

it("refuses a proposal that omits self from the participant set", async () => {
  // ... expect(check.reason).toBe("self not in participant set")
});
```

Also change `test/eip712.test.ts:101` from the `|`-regex to `expect(check.reason).toMatch(/^delta mismatch/)`.

---

## Warnings

### WR-01: `docs/CALIBRATION.md` §5 uses 36 no-data rows as if they were measurements, and `marginSweep.ts` never got the `NaN` fix its sibling did

**File:** `demo/marginSweep.ts:210,212,213`, `docs/CALIBRATION.md:181-189,177-179`
**Severity:** WARNING — **PROVEN**

`demo/thresholdSweep.ts:93-97` was fixed to return `NaN` for empty samples, with a comment explaining exactly why ("so a cell with zero contributing observations is never conflated with a measured 0.0000"). `demo/marginSweep.ts` still does the opposite:

```ts
coverageRate:      positives.length === 0 ? 0 : coveredCount / positives.length,   // :210
p99TailCoverage:   tail.length === 0      ? 0 : tailCovered / tail.length,          // :212
capBindingFraction: scoredAll === 0       ? 0 : capBinding / scoredAll,             // :213
```

Scanning the committed `docs/sweep/margin-sweep.csv`: **36 of 144 rows have `p99_debit == 0`**, i.e. `positives.length === 0` — zero scored observations. Every one of them reports `coverage_rate 0.0000`, `p99_tail_coverage 0.0000`, `cap_binding_fraction 0.0000`. The affected cells are `n=30 p=0.9 (N=16,32)`, `n=50 p=0.95 (N=32)`, `n=50 p=0.9 (all N)`, `n=30 ramp (N=32)`, `n=50 ramp (N=16,32)`.

`docs/CALIBRATION.md:181-183` then states:

> **Which (q,N) pairs cover the p99 tail: none.** `p99_tail_coverage` is 0.0000 in all 144 rows of the grid

25% of that support is no-data. The honest claim is "0.0000 in all **108** rows that have data; the remaining 36 rows have no scored positive-debit observation at all." Separately, `docs/CALIBRATION.md:179` says the N=32 ramp column is "**reported as 0.0000, not imputed**" — that is factually inverted; `marginSweep.ts:210` *is* the imputation.

**Fix:** apply the `NaN` convention to `marginSweep.ts` for all three ratios plus `p99Debit` (emit an explicit `NaN`/empty rather than `0`), add a `scored_observations` column so a reader can see the sample size per row, regenerate `margin-sweep.csv`, and rewrite §5's headline to quantify the data-bearing subset. Add a "Data notes" paragraph for the margin CSV mirroring the one that already exists for the threshold CSV (`CALIBRATION.md:19-29`).

### WR-02: `threshold-sweep.csv` is labeled "committed, reproducible" but 117 rows would change if regenerated today

**File:** `docs/CALIBRATION.md:10-14`, `demo/thresholdSweep.ts:93-104`
**Severity:** WARNING — **PROVEN**

`demo/thresholdModel.ts:181` pushes a latency only when `latency >= 1`, so `mean_excluded_latency_rounds == 0.0000` can only mean an **empty** sample. The committed CSV has **117 such rows** (all p=1.0 cells plus the 16 `n=50, p=0.8` cells). With today's `mean()`/`percentile()` those cells emit `NaN`, so `npm run sweep:threshold` rewrites the latency columns of 117 rows and the compression/worst-saving columns of the 16 fully-empty rows.

Verified by re-deriving cells: `n=15, p=1.0, d=0.5, r=0.8` reproduces `0.8519,0.8391,0.2755,0.1280` exactly but yields `NaN,NaN` where the CSV says `0.0000,0.0000`; the three settled-bearing cells (`15/0.9`, `30/0.95`, `50/0.9`) reproduce **byte-identically across all eleven columns**.

`docs/CALIBRATION.md:19-29` acknowledges the marker change but enumerates only "the 16 rows at n=50, p=0.8" as imputed. The other 101 rows are not mentioned.

**Fix:** regenerate `threshold-sweep.csv` with the current script (the numbers that matter are unchanged; only the empty-sample markers move), or state explicitly in §"Data notes" that the committed CSV was produced by a superseded script version and cannot be reproduced byte-for-byte. Add a `docs/sweep/README.md` recording the commit that generated each CSV.

### WR-03: The `seeds` column claims 200 for statistics resting on 28 seeds

**File:** `demo/thresholdSweep.ts:225` (writes the constant `SEEDS`), `docs/CALIBRATION.md:52-56`
**Severity:** WARNING — **PROVEN**

`cell()` only pushes a compression sample when `sumGross > 0n` (`:173`) and a worst-saving sample when at least one round settled (`:174`). Measured contributing-sample counts at density 0.5 / reciprocity 0.8:

| cell | compression samples | worst-saving samples |
|---|---|---|
| n=15, p=0.9 | 199 / 200 | 199 / 200 |
| n=30, p=0.95 | 196 / 200 | 196 / 200 |
| **n=50, p=0.9** | **28 / 200** | **28 / 200** |

Every row still writes `seeds = 200`. The §2 headline table publishes `50 | … | 0.9574 / 0.5256` for p=0.9 side by side with 200-seed cells, and §2's prose leans on it ("even though the rounds that do settle compress at 0.95+"). `CALIBRATION.md:24-26` does disclose survivorship conditioning in prose, but the artifact itself is misleading and the magnitude (14% of seeds) is nowhere stated.

**Fix:** emit `contributing_seeds` alongside `seeds` in the CSV header and populate it per statistic; annotate the §2 table cells whose contributing-seed count is below, say, 50% of `seeds`.

### WR-04: Cross-validation never exercises the quorum-abort or empty branches

**File:** `test/thresholdCrossValidation.test.ts:193-231`, `demo/thresholdModel.ts:238-241,212-215`
**Severity:** WARNING — **PROVEN**

Instrumenting the model over the four cross-validation cells (n∈{5,15}, p∈{1.0,0.9}, 10 seeds × 5 rounds):

```
n=5  p=0.9  quorumAborts=0  pass2Aborts=1
n=15 p=0.9  quorumAborts=0  pass2Aborts=23
n=5/15 p=1.0: 100 rounds, all settled-1pass, 0 empty
```

So of the model's five documented branches (`demo/thresholdModel.ts:20-25`), the cross-validation proves fidelity for **three**: 1-pass settle, 2-pass settle, and pass-2 abort. The quorum floor (`rebuilt.participants.length < 2 -> aborted`) and the empty branch (`participants.length < 2 -> empty`) are validated only against the model itself (`test/thresholdModel.test.ts:150-194`), never against the real `attemptRound`. `docs/CALIBRATION.md:118-126` presents the cross-validation as the faithfulness proof for the full rule set.

The non-vacuity guard at `:226-231` correctly asserts ≥1 two-pass settle and ≥1 exclusion, but has no assertion for the abort branches.

**Fix:** add a hand-constructed cross-validation case that forces the quorum branch — e.g. n=3 with a uniform schedule chosen by the existing `findSeed` idiom so that excluding the pass-1 offline member leaves <2 rebuilt participants — and assert `attempt.outcome === "aborted"` with `/quorum/` against `record.kind === "aborted"`. Then extend `p09Stats` to also track `quorumAborts` and `emptyRounds` and assert both ≥1.

### WR-05: The quorum floor's `< 2` boundary is never tested at exactly 1 participant

**File:** `demo/coordinator.ts:258`, `test/rebuild.test.ts:693-720`, `test/thresholdModel.test.ts:171-194`
**Severity:** WARNING — **PROVEN**

```
# demo/coordinator.ts:258  `if (rebuilt.result.participants.length < 2)` -> `< 1`
$ npx vitest run   → 120 passed (120)
```

Both quorum tests construct scenarios that leave **zero** rebuilt participants (`rebuild.test.ts:695` — "c is on every IOU"; `thresholdModel.test.ts:173` — n=2), so `< 1` still catches them. The documented floor is "≥2 (D-01)". A 1-participant round is reachable via a self-IOU (`net()` does not reject `debtor === creditor`), and on-chain it would revert `TooFewParticipants` — which, per CR-01, is itself untested on V2.

**Fix:** add a case where exclusion leaves exactly one participant, e.g. `a→b`, `a→c`, `b→c` with `a` excluded leaves `{b, c}`; instead build `a→b`, `b→b`-style or use a three-party chain where excluding two members leaves one, and assert `outcome.reason` matches `/1 participant\(s\)/`.

### WR-06: `net()`'s expiry boundary and the `safetyWindowSeconds` option are untested

**File:** `src/netting.ts:46`, `test/netting.test.ts:78-90`
**Severity:** WARNING — **PROVEN**

```
# src/netting.ts:46  `expiry <= opts.now + safety` -> `expiry < opts.now + safety`
$ npx vitest run   → 120 passed (120)
```

`test/netting.test.ts:78-90` only tests `expiry = NOW - 1n`, an hour inside the window; the boundary `expiry === now + safety` is never hit, and `safetyWindowSeconds` is never passed by any test in the repo. Rule 2 of the published spec (`src/netting.ts:10`, `docs/PROTOCOL.md`) is "`expiry <= now + safetyWindow`" — third parties are told to implement it identically, and the boundary is unpinned.

**Fix:**

```ts
it("rule 2 boundary: expiry == now + safetyWindow is dropped, +1 is kept", () => {
  const at = { now: NOW };                       // default safety 60n
  const onBoundary = fakeIou(ADDRS[0], ADDRS[1], 5n, 1n, NOW + 60n);
  const justAbove  = fakeIou(ADDRS[0], ADDRS[1], 5n, 2n, NOW + 61n);
  expect(net([onBoundary], at).consumedIds).toEqual([]);
  expect(net([justAbove], at).consumedIds).toEqual([justAbove.id.toLowerCase()]);
  // custom window moves the boundary
  expect(net([justAbove], { ...at, safetyWindowSeconds: 61n }).consumedIds).toEqual([]);
});
```

### WR-07: On-chain, the same manifest can be executed twice — proven, and no test documents the boundary

**File:** `contracts/src/ClearingHubV2.sol:206-267`; gap in `contracts/test/ClearingHubV2.t.sol`
**Severity:** WARNING — **PROVEN**

`executeRound` nullifies nothing: `redeemed[id]` is only ever set by `redeemIOU` (`:370`). A probe executing the identical `consumedIds` in two consecutive rounds passes:

```
[PASS] test_probe_sameManifestTwice()   // roundNonce advances to 2, same ids both times
```

"Never settle twice" (CONS-04, `docs/CALIBRATION.md:95-97`) is therefore an off-chain coordinator invariant plus each participant's own `verifyProposal` delta check — the contract does not enforce it. That may well be the intended design (nullifying every consumed id costs a 20k SSTORE per leaf), but the boundary is undocumented in the test suite and a reader of the README's "per-round manifest commitment" bullet (`README.md:141`) could reasonably conclude otherwise.

**Fix:** add an explicitly-named documenting test, in the style of the existing `test_singleLegDirectSubmissionSettles`:

```solidity
/// MACHINE-DOCUMENTED SCOPE: `executeRound` does NOT nullify consumed ids.
/// "Never settle twice" is enforced off-chain (Coordinator.settledIds) and by
/// each participant's own verifyProposal delta check. Only `redeemIOU` writes
/// the nullifier set.
function test_sameManifestExecutesTwice_offChainInvariantOnly() public { ... }
```

### WR-08: `src/client.ts` has no behavioral test at all — including the merkle-proof ABI enum mapping, which is duplicated

**File:** `src/client.ts:73-80,86-93,425-450`, `test/genFixture.ts:155-158`
**Severity:** WARNING — **PROVEN**

The only reference to `src/client.ts` from `test/` is `import type { HubClient }` (`test/pvpRound.test.ts:9`). Nothing exercises:

- `scanWindows(from, to, span)` (`:80-86`) — pure, trivially testable, has a `to < from` empty case and would loop forever on `span <= 0n`.
- `KIND_TO_UINT` (`:90`) and `toAbiProof` (`:98-100`) — the TS→Solidity enum mapping for non-inclusion proofs. **This mapping is duplicated**: `test/genFixture.ts:156-158` has its own `kindToUint`, and only *that* copy is parity-checked (via `MerkleParity.t.sol`). If `src/client.ts`'s copy drifts, every redemption the SDK submits carries the wrong `kind` and reverts — with both suites green.
- `HubClient.executeRound` / `RouterClient.executePvP` argument marshalling (`:425-450`) — `test/pvpRound.test.ts:372,411,442` stub `routerClient.executePvP` entirely, so `runPvPRound`'s tests prove the *orchestration* but never the encoding.

**Fix:** add `test/client.test.ts` with (a) `scanWindows` unit cases (`to < from` → `[]`; exact-multiple range; single-window fast path; `span` larger than range), and (b) an enum-parity assertion that imports `KIND_TO_UINT` and compares it against `test/fixtures/merkle.json`'s `case8_ni*_kind` values, deleting the duplicate helper in `genFixture.ts` in favor of the exported one.

### WR-09: The gas "tests" assert nothing about gas, while `src/client.ts` hardcodes limits derived from them

**File:** `contracts/test/ClearingHubV2.t.sol:429-458`, `contracts/test/PvPRouter.t.sol:537-606`, `src/client.ts:28-56`
**Severity:** WARNING — **REASONED**

`test_gas_executeRound_m10/m105/m250`, `test_gas_redeemIOU_ring16`, `test_gas_executePvP_small/demoScale` all measure a `gasleft()` delta, `console2.log` it, and then assert only that the round executed. A 3x gas regression fails nothing. Meanwhile `src/client.ts:24-56` hardcodes `EXECUTE_ROUND_GAS_BASE`/`_PER_PARTICIPANT`/`_PER_ID`, `REDEEM_IOU_GAS = 500_000n`, `PVP_ROUTER_GAS_BASE`, `PVP_GAS_PER_UNION_SIG` with comments citing those exact measurements — and `CLAUDE.md` makes explicit gas limits on Arc writes a hard constraint (estimation reserves the whole USDC balance). A gas regression therefore turns into out-of-gas reverts on live testnet with zero test signal.

**Fix:** convert each measurement into a bounded assertion, e.g.
```solidity
assertLt(used, 700_000, "executeRound n=5 m=10 gas regressed past the client's limit");
```
with the bound derived from the same formula `src/client.ts` uses, so the constants and the contract can never drift apart silently.

### WR-10: `src/creditCap.ts` has zero tests

**File:** `src/creditCap.ts` (whole file)
**Severity:** WARNING — **PROVEN** (no `test/` file imports it)

`CreditCapTracker` is exported from the public SDK barrel and cited in the README trust model ("credit caps still bound a staller's paper", `README.md:~365`). Untested behaviors with real boundaries: `wouldExceedCap` uses strict `>` so exposure exactly equal to the cap is allowed (`:33`); `settle()` clamps to `0n` rather than going negative (`:47`), which silently absorbs a double-`settle` of the same IOU; `capFor` falls back to `defaultCap` on a missing per-debtor override (`:24`).

**Fix:** `test/creditCap.test.ts` covering the `==cap` boundary in both directions, `record` → `wouldExceedCap` → `settle` → `wouldExceedCap` round-trip, double-settle clamping, and case-insensitivity of the `debtor->creditor` key.

### WR-11: Six bare `vm.expectRevert()` calls accept any revert reason

**File:** `contracts/test/ClearingHubV2.t.sol:282,339`, `contracts/test/ClearingHubFuzz.t.sol:89`, `contracts/test/ClearingHub.t.sol:235,237,243`
**Severity:** WARNING — **PROVEN** (grep)

`ClearingHubV2.t.sol:282` (`test_redeemIOU_revertsWhilePaused`) would pass if `redeemIOU` reverted for *any* reason — a stale proof set, an arithmetic panic, an out-of-gas. Same for `:339` (the proof-swap fuzz branch) and `ClearingHubFuzz.t.sol:89` (`testFuzz_perturbationAlwaysReverts`, the flagship "any tampering reverts" test the README cites at `:353`).

**Fix:** `vm.expectRevert(Pausable.EnforcedPause.selector)` at `:282` (the import already exists in `PvPRouter.t.sol`); `vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.NonInclusionProofInvalid.selector, <expected nonce>))` at `:339` — the comment already names the expected error; and in `ClearingHubFuzz.t.sol` branch on `tamperSig` to expect `BadSignature(sigIdx)` vs `BadSignature(...)` for the delta nudge.

### WR-12: `ClearingHubV2`'s `testFuzz_*` tests fuzz a mode selector, not the failure space

**File:** `contracts/test/ClearingHubV2.t.sol:314-404`
**Severity:** WARNING — **REASONED**

All three V2 fuzz tests consume `seed` only as `seed % 2`/`% 3`, `(seed >> 8) % 3`, `(seed >> 16) % sc`, `(seed >> 24) % 256` — roughly a few dozen distinct behaviors across 512 runs. The IOU amount, expiry, nonce, ref, the debtor/creditor pair, the manifest size (always `_manifest(3, …)`), and the leafCount-lie magnitude (always `+= 5`, `:388`) are all fixed constants. `testFuzz_redeemProofPerturbation_reverts`'s `leafCount` mode is effectively a single hand-picked case dressed as a fuzz.

Notably absent from the whole V2 suite: any fuzz over `executeRound` itself. `testFuzz_roundExecution` and `testFuzz_perturbationAlwaysReverts` target the **v1** contract only, so the v2-specific binding claim ("signatures transitively bind the exact id list", `ClearingHubV2.sol:30-32`) is covered by exactly one hand-written case.

**Fix:** add `testFuzz_v2ConsumedIdTamper_reverts(uint256 seed)` — build a fuzz-sized sorted manifest, sign it, then replace one fuzz-chosen id with another value that preserves strict ascent, and assert `BadSignature`. Fuzz the manifest size (`bound(seed, 1, 32)`) and the leafCount-lie delta in `testFuzz_redeemProofPerturbation_reverts`.

### WR-13: `runPvPRound`'s chain path is fully stubbed — the router call encoding is untested

**File:** `test/pvpRound.test.ts:320-357,372,411,442,483,527`
**Severity:** WARNING — **REASONED**

`fakeLegState`, `fakeReader`, and `routerClient: { executePvP: async () => TX }` replace every boundary. The tests genuinely prove the reconciliation state machine (WR-01/WR-02 pending-record semantics, both-hub holds, digest-match reclassification) — that part is good and would catch real regressions. But nothing in the 120-test suite ever calls the real `RouterClient.executePvP`, so leg-tuple construction, signature array ordering, and gas-limit computation are exercised only by `npm run e2e:anvil`, which is not part of `npm test` and not in any CI config (no `.github/workflows` exists).

**Fix:** at minimum add an encoding test that calls `encodeFunctionData` with the same arguments `executePvP` builds and asserts the resulting calldata decodes back to the expected leg structs; ideally wire `npm run e2e:anvil` into CI so the round trip is exercised at least once per change.

### WR-14: `AboveLast` soundness depends on an emergent property the fuzz test explicitly assumes away

**File:** `contracts/test/ManifestMerkle.t.sol:443-463`, `test/merkle.test.ts:294-309`
**Severity:** WARNING — **REASONED** (with supporting brute force)

`testFuzz_leafCountLie_rejected` `vm.assume`s that the lie changes the consume trace (`:458-460`), and `test/merkle.test.ts:294-309` documents the same carve-out as "a known boundary of the locked construction". A `leafCount` lie that preserves the trace **does** verify in both implementations. The security of `AboveLast` therefore rests on: *there is no `(m, n)` with `m < n-1` such that `consumeTrace(m, m+1) == consumeTrace(m, n)`* — because such a pair would let a non-last member be re-anchored as "last" and forge non-inclusion for every member above it.

I brute-forced this for all `n ≤ 8192`: **zero collisions**. The construction is sound. But that is an emergent numeric property of the promotion schedule that no test states, so a future change to the promotion rule (or to `(w+1) >> 1`) could introduce collisions with both suites green — the existing tests would keep `vm.assume`-ing the new failures away.

**Fix:** add a property that *asserts* the non-collision directly rather than assuming it:
```solidity
function testFuzz_lastLeafAnchorCannotBeForged(uint256 seed, uint256 pick) public pure {
    uint256 n = bound(seed, 2, 64);
    bytes32[] memory ids = _sortedIds(n, seed);
    uint256 m = bound(pick, 0, n - 2);          // strictly non-last
    assertTrue(
        keccak256(_consumeTrace(m, m + 1)) != keccak256(_consumeTrace(m, n)),
        "a non-last leaf must never be trace-equivalent to a last leaf"
    );
}
```
and the TS mirror in `test/merkle.test.ts` using a `consumeTrace` helper (the existing `schedule()` at `:128-140` includes promotions, so it is the *wrong* equivalence to reason with — it is finer than what the verifier can observe).

### WR-15: `p09Stats` is cross-test mutable state, making the non-vacuity guard order-dependent

**File:** `test/thresholdCrossValidation.test.ts:53,214,222,226-231`
**Severity:** WARNING — **PROVEN** (by inspection)

`const p09Stats = { settled2pass: 0, exclusions: 0 }` is module-level and mutated by two `it` blocks; a third `it` asserts on it. Running `vitest -t "not vacuous"` in isolation, or any future `it.concurrent`/`--shard` split, fails the guard for reasons unrelated to the code under test. It fails loudly rather than silently, so this is a robustness issue rather than a false-pass — but the guard is precisely the thing protecting against an all-online vacuous run, so it should not be the flakiest assertion in the file.

**Fix:** have `runSeed` return its stats and accumulate them inside a single `it` that runs all four cells, or move the guard into an `afterAll` hook on the describe block.

### WR-16: `percentile` uses `floor(p/100 * n)`, one rank above nearest-rank at exact multiples

**File:** `demo/thresholdSweep.ts:96`, `demo/sweep.ts:70`, `demo/marginSweep.ts:202`
**Severity:** WARNING — **PROVEN** (arithmetic)

`s[Math.min(len-1, Math.floor((p/100)*len))]`. At `p=10, len=200` this returns index 20 (the 21st smallest); nearest-rank is index 19. At `p=50, len=200` it returns index 100 rather than 99. The reported "p10" is therefore the smallest value with at least 10% of the sample strictly below it — a defensible definition, but it is not the convention the docs imply ("tenth-percentile … the round an operator budgets for") and it is biased *optimistic* by one rank at every exact multiple. Magnitude at n=200 is small; at the n=50/p=0.9 cell's 28 samples it happens to coincide.

The same helper is copy-pasted into three files with three slightly different empty-sample behaviors (`NaN` in `thresholdSweep`, an undefined-index crash in `sweep.ts`, an inline variant in `marginSweep`).

**Fix:** extract one `percentile` into a shared module (`demo/stats.ts`), document the convention explicitly in `docs/CALIBRATION.md` §3, and use it in all three sweeps.

### WR-17: `demo/sweep.ts`'s `percentile` crashes on an empty sample instead of returning `NaN`

**File:** `demo/sweep.ts:68-71`, called at `:101-105`
**Severity:** WARNING — **REASONED**

```ts
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];   // s[-1] === undefined
}
```
With `xs = []` this returns `undefined`, and `cell()`'s caller does `.toFixed(4)` on it (`:132-133`) → `TypeError`. Reachable whenever every seed in a cell produces zero IOUs (`run()` returns `null` at `:42`) — e.g. a hypothetical `n=2, density=0.05` cell. The committed grid's smallest cell (`n=2, density=0.5`) has `runs=109`, so it does not currently fire, but the guard that `thresholdSweep.ts:94` already has is absent here.

**Fix:** add `if (xs.length === 0) return NaN;` to match the sibling.

---

## Info

### IN-01: `expect(...).resolves.toBeDefined()` proves nothing about the signed IOU

**File:** `test/eip712.test.ts:115`
`signIou` always resolves to a `SignedIou` object, so `toBeDefined()` is a tautology on the success path. It does prove "did not reject", which is the intent — but `await expect(signIou(...)).resolves.toMatchObject({ iou: { expiry: NOW + 86_400n } })` says the same thing without the tautology.

### IN-02: `expect(s).toBeDefined()` on a `Map.get` inside a property

**File:** `test/rebuild.test.ts:96`
The very next line uses `s!`, so a `undefined` would throw anyway. Replace with `expect(byId.has(id.toLowerCase())).toBe(true)` to make the intent (every consumed id came from the input set) an actual assertion.

### IN-03: `unionParticipants(a, a)` idempotence is redundant inside the set-union property

**File:** `test/pvp.test.ts:144`
The enclosing property already asserts the output equals the set union and is strictly ascending, which implies `union(a,a) === a` for ascending `a`. Harmless; consider moving it to the concrete-cases block where it reads as documentation.

### IN-04: `rateConsistent` property is near-tautological w.r.t. the multiplication

**File:** `test/pvp.test.ts:165-177`
`rateConsistent(k*den, k*num, num, den)` is true by associativity for any correct cross-multiplication, so the property mainly guards the `+1` negative case. It *does* incidentally pin the numerator/denominator convention (a swapped-operand mutation fails it, since `num` and `den` are independently generated) — worth a comment saying so, since that is the non-obvious value.

### IN-05: `test/thresholdModel.test.ts:209-211` asserts the PRNG range

**File:** `test/thresholdModel.test.ts:203-212`
`expect(u).toBeGreaterThanOrEqual(0); expect(u).toBeLessThan(1);` on mulberry32 output can only fail if the PRNG is replaced wholesale. The reproducibility assertion two lines up (`:207`) is the one carrying weight.

---

## What I verified as sound

Recorded so the reader can distinguish "not tested" from "not working":

- **Suite counts are accurate.** `120 passed (120)` TypeScript across 8 files; `101 total tests` Foundry across 9 suites (23+2+26+2+1+22+5+1+19).
- **Cross-validation has teeth.** Changing `demo/thresholdModel.ts:222` to exclude only the first offline candidate (instead of the D-02 single batch) fails `test/thresholdCrossValidation.test.ts` at the excluded-set membership assertion on both p=0.9 cells.
- **Cross-validation is non-vacuous.** Across the four cells: 40 `settled-1pass` + 9 `settled-2pass` + 1 `aborted` (n=5, p=0.9) and 16 + 11 + 23 (n=15, p=0.9); 44 rounds with a non-empty excluded set, 72 excluded-member events.
- **CSV numbers reproduce exactly.** Independently re-deriving `n=15/p=1.0`, `n=15/p=0.9`, `n=30/p=0.95`, `n=50/p=0.9` from `simulateThresholdHistory` reproduced all eleven CSV columns byte-for-byte (except the empty-latency cells discussed in WR-02). `mixSeed`'s `(density, reciprocity)` term has no collisions across the 20-combo grid.
- **README sweep numbers check out** against `docs/sweep/sweep.csv`: median worst-saving 0.3743 (n=5) → 0.6301 (n=50); p10 0.0000 (n≤5), 0.3248 (n=15), 0.5309 (n=50); density 0.6634 → 0.8718 at n=10; n=5 reciprocity-0 compression 0.3482 (>30% ✓); n=3 needs r≥0.4 (0.0000 → 0.4444 ✓). The `runs` column honestly reports 171/200 at n=3 and 109/200 at n=2.
- **`cap_binding_fraction` really is q-independent**, as `CALIBRATION.md:193-194` claims: `q·e_{t-1} > 1.25·q·e_{t-2}` cancels exactly for `q > 0`.
- **No `Math.random`/`Date.now` in any data path.** The only occurrences are timing logs in the sweeps, `demo/e2e.ts`'s live clock, and `src/iou.ts:68`'s `now` default — all overridable, and every test passes an explicit `now`.
- **`marginSweep`'s causality is correct**: `im = q * ewma` is computed and scored *before* `ewma` absorbs round `t`'s debit (`:177-191`), and warmup `t >= lookback` is applied to the per-member settled-round series as documented.
- **The Solidity merkle suite is materially stronger than its TS twin.** `ManifestMerkle.t.sol` catches the unconsumed-siblings deletion, the `AboveLast` anchor deletion, and the bracket-`leafCount` deletion; `test/merkle.test.ts` catches none of the corresponding TS mutations. `MerkleParity.t.sol:97-132`'s negative vector (member id via own-anchor bracket, and via non-adjacent bracket) is exactly the test `test/merkle.test.ts` needs.
- **`PvPRouter.t.sol` is the best-built file in the repo.** Every revert case asserts both hubs' nonces *and* four representative collateral balances after the revert, `test_revert_executePvP_badLegSignature` is a genuine atomicity proof (second leg fails after the first already executed), and `test_singleLegDirectSubmissionSettles` documents a real limitation rather than hiding it. Dropping the union signature-count check fails a test.
- **`src/pvp.ts`'s CR-01 inclusion-symmetry guard is properly regression-tested** — deleting `if (uIn !== eIn)` fails `test/pvp.test.ts:315`, and skipping the per-leg `verifyProposal` for the EURC leg fails too.
- **`screenConsents`' CR-01 signature screen is properly tested** — deleting the verification fails `test/rebuild.test.ts:759`.
- **`net()`'s ordering and manifest rules are well covered** — descending participants fails 13 tests, dropping `consumedIds.sort()` fails 25, and dropping the `redeemedIds` filter fails `test/eip712.test.ts:121`.

---

_Reviewed: 2026-07-27T14:55:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep — 19 source mutations executed in an out-of-tree scratch copy; repo never modified (`git status` clean apart from this artifact)_
