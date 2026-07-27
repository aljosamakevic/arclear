---
phase: audit-scope-a-contracts
reviewed: 2026-07-27T00:00:00Z
depth: deep
files_reviewed: 8
files_reviewed_list:
  - contracts/src/ClearingHubV2.sol
  - contracts/src/PvPRouter.sol
  - contracts/src/lib/ManifestMerkle.sol
  - contracts/src/ClearingHub.sol
  - contracts/script/Deploy.s.sol
  - contracts/script/DeployV2.s.sol
  - contracts/script/DeployPvPRouter.s.sol
  - contracts/foundry.toml
findings:
  critical: 2
  warning: 11
  info: 8
  total: 21
status: issues_found
---

# Audit Scope A — Solidity contracts (security-first, whole-contract)

**Reviewed:** 2026-07-27
**Depth:** deep (cross-file, with executable PoCs)
**Build:** `forge build` clean (lint notes only). `forge test` baseline: **101/101 pass**.
**PoC harness:** 13 adversarial tests written against the shipped contracts, **all 13 pass**.
Harness preserved at
`/private/tmp/claude-501/-Users-aljosamakevic-Documents-Buildground-Playground-arclear/75ebecc2-35f5-464a-a6a6-1090d0c9b9db/scratchpad/ZZAuditPoC.t.sol`
(drop into `contracts/test/` to reproduce; it was removed from the repo after
the run — no source file was modified).

---

## 0. Deployment-impact triage (read this first)

The three live, immutable deployments are:

| Contract | Address |
|---|---|
| ClearingHubV2 (USDC) | `0x3b9a9617b91589a15A14122183e6305D9F0a5a16` |
| ClearingHubV2 (EURC) | `0xECcCD7E43B0Caf4D81420483dEE20E5e258FB85E` |
| PvPRouter | `0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c` |

### Requires a REDEPLOY — cannot be fixed off-chain

| ID | Finding | Sev |
|---|---|---|
| CR-01 | `consumedIds` is unconstrained → anyone permanently kills `redeemIOU` for any IOU | BLOCKER |
| CR-02 | Free rounds flush the root ring → coverage window permanently closes for all outstanding IOUs | BLOCKER |
| WR-01 | `ManifestMerkle.verifyInclusion` can panic despite "never reverts" NatSpec | WARNING |
| WR-03 | Coverage keys off `expiry − L`, penalising short-lived (safer) IOUs | WARNING |
| WR-04 | No partial redemption — `amount − 1` collateral yields the creditor **zero** | WARNING |
| WR-06 | `renounceOwnership()` while paused permanently bricks deposits/rounds/redemption | WARNING |
| WR-09 | No EIP-1271 — contract/AA agent wallets cannot participate at all | WARNING |

### Fixable OFF-CHAIN (SDK, docs, ops) — no redeploy needed

| ID | Finding | Sev |
|---|---|---|
| CR-01/CR-02 (docs half) | `docs/THREAT-MODEL.md` rows 15/16 and `docs/PROTOCOL.md` "net → cannot-redeem holds unconditionally" are **false as written** and must be corrected now | BLOCKER-adjacent |
| WR-02 | NatSpec + THREAT-MODEL row 17 give the *wrong reason* why non-inclusion is sound | WARNING |
| WR-05 | Owner can pause `redeemIOU` but not `withdraw` → move ownership to a multisig/timelock (`Ownable2Step` allows this today) | WARNING |
| WR-07 | `PvPRouter` constructor has no validation → future deploys only; add a script assertion | WARNING |
| WR-08 | OZ `ECDSA` errors mask `BadSignature(index)`; SDK must decode both error families | WARNING |
| WR-10 | `DeployV2.s.sol` silently truncates env params to `uint64` | WARNING |
| WR-11 | `redeemIOU` staleness clock is resettable — documented, but the documented *cost model* is wrong | WARNING |

### Confirmed sound (attacked and held)

These were probed adversarially and **survived**; stating them so the two
BLOCKERs are not misread as a safety break:

- **Zero-sum + signed-consent invariant holds.** No path moves a balance
  without that address's EIP-712 signature over the exact executed
  `(nonce, participants, deltas, root)` tuple. `sum += deltas[i]` and
  `uint256(-delta)` are checked arithmetic in 0.8.26 — `type(int256).min` and
  int256 overflow revert, they do not wrap.
- **Merkle non-inclusion is sound.** Exhaustive schedule analysis over all
  `(index, leafCount)` pairs for `n ≤ 64` finds **zero** false-`BelowFirst`,
  false-`AboveLast`, or false-`Bracket` candidates. Prefix domain separation
  (`0x00` leaf / `0x01` node) blocks the internal-node-as-leaf substitution;
  the last-leaf path is provably a mix of "odd" and "promote" steps only, so
  `AboveLast` can only ever prove a genuinely rightmost leaf. (The *stated*
  reason is wrong — see WR-02 — but the property holds.)
- **Ring-index arithmetic is correct.** `(nonce_ − RING) % RING`,
  `expected = min(nonce_, RING)`, `start = nonce_ > RING ? nonce_ − RING : 0`
  were checked at the `nonce_ ∈ {0, RING−1, RING, RING+1}` boundaries: the
  proof window and the coverage slot always agree, and no uninitialised ring
  slot (`root == 0`, which is *not* `EMPTY_ROOT`) is ever read.
- **Coverage rule is fail-closed for honest debtors.** If the consuming round
  was evicted, the oldest buffered `executedAt` is necessarily newer than the
  consuming round, hence newer than `signTime ≥ expiry − L` → revert. The
  L-convention is enforced in `src/iou.ts:signIou`. The "violation only harms
  the debtor" claim is correct (only the debtor signs; redemption only debits
  the debtor).
- **PvP atomicity holds.** Both legs are plain high-level calls; no
  `try/catch`, no low-level call, no `returndata` swallowing anywhere in
  `PvPRouter.sol`. `executeRound` performs **no external calls at all** (netting
  moves internal `collateral` only), so the router→hub→token reentrancy graph
  a malicious ERC-20 hook would need does not exist on the round path;
  `deposit`/`withdraw` are `nonReentrant` + `SafeERC20`.
- **`_unionOf` is a correct sorted merge** (PvPRouter.sol:214–246). Every
  branch was checked for out-of-bounds: when the first branch is taken
  `i < na` is guaranteed, when the second is taken `j < nb` is guaranteed, and
  the third is only reachable with both in range. It rejects `address(0)`
  (`prev` starts at 0) and reverts iff either input is not strictly ascending.
- **Replay binding is complete.** EIP-712 `chainId` + `verifyingContract` kill
  cross-chain and cross-hub replay; `ROUND_TYPEHASH ≠ IOU_TYPEHASH` kills
  struct confusion inside the shared `("ArcClearingHub","1")` domain;
  `PVP_ROUND_TYPEHASH` lives in a separate router domain. OZ `ECDSA.recover`
  rejects high-`s` malleability and `ecrecover → address(0)`.
- **Gas figures in `docs/PROTOCOL.md` are accurate.** Re-measured:
  `executeRound` m=10 → 329,108; m=105 → 691,708; m=250 → 1,254,993;
  `redeemIOU` RING=16 → 199,604; `executePvP` demo scale → 1,734,897. All
  match the published table exactly.

---

## Critical Issues (BLOCKER)

### CR-01: `consumedIds` is unconstrained — anyone can permanently disable `redeemIOU` for any IOU (manifest poisoning)

**File:** `contracts/src/ClearingHubV2.sol:206-267` (write side), `contracts/src/ClearingHubV2.sol:355-365` (read side)
**Fix location:** **ON-CHAIN — requires redeploy.** No SDK change restores redemption.
**PoC:** `test_poc1_manifestPoisoningBlocksRedemption`, `test_poc1b_debtorSelfPoisons` (both pass)

**Issue.** `executeRound` accepts `bytes32[] calldata consumedIds` and commits
its merkle root, but **never checks that a consumed id has anything to do with
the round's participants** — no debtor/creditor recovery, no `redeemed`-style
consumption ledger, no ownership binding of any kind. The only constraints are
"strictly ascending" (`ManifestMerkle.rootOf`, line 226) and "not already
redeemed" (lines 220-223).

Separately, a round is **free**: `n = 2`, `deltas = [0, 0]` sums to zero,
neither participant needs a single base unit of collateral (line 251-254 takes
the `delta >= 0` branch), and no IOU has to exist. Measured cost: **186,505
gas** for a 2-participant empty-manifest round; **1,543,541 gas** for a
2-participant round carrying 50 poisoned ids (`test_poc8_junkRoundGas`).

`redeemIOU` (line 358-365) demands a non-inclusion proof against **every**
buffered root. A non-inclusion proof for an id that is genuinely a leaf cannot
exist. Therefore:

> **Writing a victim's IOU id into any round manifest permanently destroys that
> IOU's redeemability.**

**Concrete failing scenario (all values from the passing PoC):**

1. Alice (`actors[0]`) deposits 10 USDC, signs an IOU to Bob (`actors[1]`) for
   5 USDC, `expiry = now + 86400` (L-convention honoured), id `= hashIou(iou)`.
2. Three rounds execute without Alice → `roundNonce = 3`,
   `lastRound[Alice] = 0`, so `3 ≥ 0 + K(3)`: Alice is stale.
   *Baseline `test_baseline_redeemSucceeds` confirms Bob redeems 5 USDC here.*
3. Two throwaway addresses (`actors[3]`, `actors[4]`) — **zero collateral,
   zero deltas, never party to the IOU, no signature from Alice or Bob over
   that id** — submit `executeRound(3, [a3, a4], [0, 0], [id], [sigA3, sigA4])`.
   Cost: one transaction.
4. `hub.redeemIOU(iou, sig, proofs)` now reverts
   `NonInclusionProofInvalid(3)`. Alice's collateral is still 10 USDC; Bob
   recovers **nothing**.
5. Once round 3 is evicted from the ring, CR-02's coverage rule takes over and
   the revert becomes `CoverageWindowNotBuffered` — **permanent**, because
   `oldestExecutedAt` is monotonically non-decreasing while `windowStart` is
   fixed by `expiry`.

**Worse: the debtor is the natural attacker.** The debtor knows the id of every
IOU they have ever signed (`test_poc1b`). One transaction with all of those ids
in `consumedIds` immunises them against `redeemIOU` forever, at ~3,900 gas per
id. A defaulting debtor pays a few million gas to keep 100% of their posted
collateral. This is not the documented "keep-alive ping-pong every round" — it
is a **one-shot, permanent, capital-free** defeat of the entire recovery
product.

**NatSpec / docs divergence this falsifies (must be corrected regardless of
the on-chain fix):**

- `contracts/src/ClearingHubV2.sol:34-36` — "a redemption nullifier set
  (`redeemed`) enabling `redeemIOU` recovery against unresponsive debtors".
- `docs/PROTOCOL.md:488-489` — "**Net → cannot-redeem:** a consumed id is a
  leaf of some buffered root … the coverage rule guarantees the containing
  round is still buffered for honest debtors." The converse — *a leaf implies
  the id was actually consumed* — is assumed everywhere and is false.
- `docs/THREAT-MODEL.md` row 15 and the "No on-chain IOU redemption →
  **shipped in v2**" limitation row both overstate what ships.

**Fix (on-chain, next deploy). Any one of:**

```solidity
// Option A — bind each consumed id to the round's participants.
// Requires the debtor/creditor pair alongside each id, and that BOTH are
// listed participants (they signed the digest, which binds the id list).
struct ConsumedRef { bytes32 id; uint32 debtorIdx; uint32 creditorIdx; }
// ...for each ref: require(debtorIdx < n && creditorIdx < n) and derive the
// leaf from (id, participants[debtorIdx], participants[creditorIdx]).

// Option B — make consumption a real on-chain ledger, not a commitment.
mapping(bytes32 => bool) public consumed;
for (uint256 i; i < m; ++i) {
    bytes32 id = consumedIds[i];
    if (redeemed[id]) revert NullifiedIdInManifest(id);
    if (consumed[id]) revert AlreadyConsumed(id);   // also fixes the
    consumed[id] = true;                            // "same id in two rounds"
}                                                   // gap below
// redeemIOU then checks `!consumed[id]` directly and needs NO proofs,
// NO ring buffer, and NO coverage rule — which also removes CR-02, WR-01,
// WR-03 and the whole ManifestMerkle non-inclusion surface.
```

Option B is strictly simpler and removes four other findings; the trade-off is
one `SSTORE` (~20k gas) per consumed id versus ~3,900 gas today, and it makes
the "one IOU, one settlement" invariant on-chain rather than a coordinator
convention (see IN-05).

**Off-chain (do now, before any redeploy):** correct `docs/THREAT-MODEL.md`,
`docs/PROTOCOL.md` and the README to state that `redeemIOU` on the *live*
deployment is defeatable by any party for one transaction's gas, and that the
credit model must be sized on credit caps + collateral alone.

---

### CR-02: Free rounds flush the root ring, permanently closing the coverage window for every outstanding IOU

**File:** `contracts/src/ClearingHubV2.sol:262-265` (ring write + unconditional nonce increment), `contracts/src/ClearingHubV2.sol:338-344` (coverage gate)
**Fix location:** **ON-CHAIN — requires redeploy.**
**PoC:** `test_poc2_ringFlushPermanentlyBlocksRedemption` (passes)

**Issue.** Every `executeRound` unconditionally does
`rootRing[nonce_ % RING] = StoredRoot(root, nonce_, uint64(block.timestamp))`
and `roundNonce = nonce_ + 1`. Combined with the free-round property from
CR-01, **any address pair can advance `roundNonce` at will and overwrite every
buffered `executedAt` with the current timestamp for ~186k gas per round.**

The coverage gate is:

```solidity
if (nonce_ > RING) {
    uint64 oldestExecutedAt = rootRing[(nonce_ - RING) % RING].executedAt;
    uint64 windowStart = iou.expiry > MAX_IOU_LIFETIME ? iou.expiry - MAX_IOU_LIFETIME : 0;
    if (iou.expiry <= MAX_IOU_LIFETIME || oldestExecutedAt >= windowStart) revert CoverageWindowNotBuffered(...);
}
```

`windowStart` is fixed by the IOU. `oldestExecutedAt` only ever increases. So
once an attacker forces `oldestExecutedAt ≥ windowStart`, **that IOU can never
be redeemed again — not later, not ever.**

**Concrete failing scenario (from the passing PoC):**

1. Alice deposits 10 USDC at `t = 1`, signs an IOU to Bob for 5 USDC,
   `expiry = 1 + 86400`, so `windowStart = 1`.
2. Three rounds without Alice → Alice stale, `roundNonce = 3 ≤ RING = 16`, so
   the coverage branch is skipped entirely and Bob can redeem.
3. `vm.warp(+100)`. An **unrelated** pair (`actors[3]`, `actors[4]`) — again
   zero collateral, zero deltas, empty manifests — executes 16 rounds. Total
   cost ≈ **3.0M gas** (16 × 186,505).
4. `roundNonce = 19 > RING`. `rootRing[3].executedAt = 101 ≥ windowStart = 1`.
5. `redeemIOU` reverts `CoverageWindowNotBuffered(101, 1)`. Warping forward 7
   days and regenerating proofs: still reverts. Permanent.

This is a **global** DoS, not a per-debtor one: a single attacker
simultaneously and permanently kills redemption for *every* IOU outstanding at
that moment, against *every* debtor, on that hub. The attacker needs no
relationship to any victim.

Note this attack also survives the CR-01 fix if the ring/coverage design is
kept: it attacks the ring, not the manifest.

**Fix (on-chain).** Removing the ring entirely via CR-01 Option B is the clean
answer. If the ring is kept:

```solidity
// (a) Make rounds non-free so `roundNonce` cannot be advanced at zero economic
//     cost — e.g. require at least one non-zero delta, or require every
//     participant to have non-zero collateral:
bool anyNonZero;
for (uint256 i; i < n; ++i) { if (deltas[i] != 0) { anyNonZero = true; break; } }
if (!anyNonZero) revert EmptyRound();

// (b) AND make the ring time-indexed rather than nonce-indexed, or store a
//     high-water mark of the oldest *evicted* executedAt so the window cannot
//     be compressed faster than wall-clock:
//     require(block.timestamp - rootRing[(nonce_ - RING) % RING].executedAt >= MIN_RING_SPAN);
```

(a) alone is insufficient — a colluding pair can settle `[-1, +1]` base units
for the same gas. (b), or eliminating the coverage rule, is the real fix.

---

## Warnings

### WR-01: `ManifestMerkle.verifyInclusion` panics on a large `leafCount`, contradicting its "never reverts" contract

**File:** `contracts/src/lib/ManifestMerkle.sol:117` (`w = (w + 1) >> 1;`), NatSpec claim at `:95-98`
**Fix location:** ON-CHAIN (redeploy) for the guard; off-chain for the doc.
**PoC:** `test_poc3_verifyInclusionReverts`, `test_poc3b_redeemIOUPanicsOnHugeLeafCount` (both pass)

**Issue.** NatSpec states: *"Never reverts: out-of-range index, wrong sibling
count, tampered siblings, or a wrong root all return false."* With
`p.leafCount = type(uint256).max` and `p.index = 0`, the `p.index >= p.leafCount`
guard at line 100 passes, and the first loop iteration evaluates
`w = (w + 1) >> 1` with `w = 2²⁵⁶−1` → **checked-arithmetic panic 0x11**.

Through the real caller this means `redeemIOU` reverts with `Panic(0x11)`
instead of `NonInclusionProofInvalid(nonce)`, hiding which proof was bad. The
same shape is what a future batch/aggregate verifier would rely on to skip a
bad proof rather than abort — the documented contract is load-bearing for code
that does not exist yet.

**Impact today:** self-inflicted only (the prover supplies the proof), so this
is a WARNING, not a BLOCKER. But it is a documented invariant that is simply
false.

**Fix:**

```solidity
function verifyInclusion(InclusionProof memory p, bytes32 root) internal pure returns (bool) {
    if (p.index >= p.leafCount) return false;
    if (p.leafCount > type(uint64).max) return false; // no manifest can be this large
    ...
```

Off-chain: the SDK's `src/merkle.ts` must never emit a `leafCount` above the
real manifest size, and `docs/PROTOCOL.md` should stop claiming the verifier
never reverts.

---

### WR-02: `leafCount` is NOT bound by the root — the documented reason non-inclusion is sound is wrong

**File:** `contracts/src/lib/ManifestMerkle.sol:22-24`, `:99-120`; `docs/THREAT-MODEL.md` row 17
**Fix location:** OFF-CHAIN (docs). Optional on-chain hardening in a future deploy.
**PoC:** `test_poc7_leafCountNotBound` (passes)

**Issue.** NatSpec claims *"Tree shape is uniquely determined by leaf count, so
verification binds (leaf, index, leafCount) to the committed root."*
THREAT-MODEL row 17 repeats it: *"a lie changes the sibling-consumption
schedule."*

Both are false. The schedule depends only on the per-level parity of `index`
and whether `index == w−1`; many distinct `leafCount` values produce the
*identical* filtered schedule. Demonstrated: a genuine 4-leaf root verifies an
inclusion proof that claims `leafCount = 3` for index 0 **and** for index 1.
Exhaustive enumeration for `n ≤ 64` shows **123 of 127** distinct schedules are
shared across two or more different leaf counts.

**Why it is not exploitable today** (verified exhaustively for `n ≤ 64`,
analysis script rerunnable):

- false `AboveLast` candidates: **0** — the last leaf's path is a mix of "odd"
  and "promote" steps only, never "even-not-last", so no non-last real leaf can
  masquerade as a last leaf.
- false `BelowFirst` candidates: **0**.
- false `Bracket` candidates (two non-adjacent real leaves presented as
  adjacent under a common fake `leafCount`): **0**.

So the property holds — but it holds because of the kind-specific position
constraints in `verifyNonInclusion` (lines 136-145) interacting with the
promotion schedule, **not** because `leafCount` is bound. Any new
`NonInclusionKind`, or any external use of `verifyInclusion` that treats
`leafCount` as trustworthy ("this manifest has exactly N leaves"), would be
unsound with no test catching it.

**Fix:** correct the NatSpec and THREAT-MODEL row 17 to state the real
argument. If `leafCount` is ever needed as a trusted value, commit it into the
root (e.g. `root' = keccak256(0x02 ‖ root ‖ leafCount)`).

---

### WR-03: The coverage rule keys off `expiry − L`, so the *safer* short-lived IOU is strictly harder to redeem

**File:** `contracts/src/ClearingHubV2.sol:340`
**Fix location:** ON-CHAIN (redeploy).
**PoC:** `test_poc9_shortExpiryIsUnredeemable` (passes)

**Issue.** The rule needs "the ring reaches back before this IOU could have
been consumed", i.e. before its signing time. Signing time is not in the signed
struct, so `expiry − MAX_IOU_LIFETIME` is used as a proxy. For an IOU with a
real lifetime `ℓ < L`, that proxy is `L − ℓ` seconds *too conservative*, and
demands `L − ℓ` more buffered history than the safety argument actually needs.

**Concrete failing scenario (from the passing PoC):** ring holds 17 rounds all
executed at `t = 150,000`; `now = 200,000`; same debtor, same instant:

| IOU | expiry | windowStart | oldest = 150,000 | Result |
|---|---|---|---|---|
| max-lifetime | 286,400 | 200,000 | 150,000 < 200,000 | **redeems** |
| 5-minute | 200,300 | 113,900 | 150,000 ≥ 113,900 | **reverts** `CoverageWindowNotBuffered(150000, 113900)` |

The incentive is inverted: a participant issuing short-dated (lower-risk) paper
gets a narrower or empty recovery window than one issuing maximum-dated paper.
This is **not** fixable by calibrating K/RING/L — a single global `L` cannot fit
a mixed population of lifetimes.

**Fix:** add `issuedAt` to the signed `IOU` struct (a typehash change, so it
belongs to the same redeploy as CR-01) and compare `oldestExecutedAt < iou.issuedAt`.
Or adopt CR-01 Option B, which removes the coverage rule entirely.

---

### WR-04: No partial redemption — a debtor holding `amount − 1` collateral leaves the creditor with zero

**File:** `contracts/src/ClearingHubV2.sol:370-376`
**Fix location:** ON-CHAIN (redeploy).
**PoC:** `test_poc6_noPartialRedemption` (passes)

**Issue.** `redeemIOU` debits the **full** `iou.amount` or reverts. Combined
with the never-pausable `withdraw`, a debtor who withdraws down to
`amount − 1` base units blocks recovery **entirely** — the creditor recovers
`0`, not `amount − 1`. Verified: debtor deposits 10 USDC, IOU is 5 USDC,
debtor withdraws to 4.999999 USDC; `redeemIOU` reverts
`InsufficientCollateral(debtor, 4999999, 5000000)` and `collateral[creditor]`
stays `0`.

This is materially worse than the accepted "redemption races withdraw" item:
the race is documented as recovering *what is still there*, and it recovers
nothing. It also makes the "collateral backs the credit" claim in
`docs/PROTOCOL.md:236-252` quantitatively wrong for any shortfall.

There is a related fairness gap with no on-chain answer: multiple creditors of
the same debtor are served strictly first-come-first-served with no pro-rata,
so mempool position decides who recovers.

**Fix:**

```solidity
uint256 balance = collateral[iou.debtor];
uint256 paid = balance < iou.amount ? balance : iou.amount;
if (paid == 0) revert InsufficientCollateral(iou.debtor, 0, iou.amount);
redeemedAmount[id] += paid;                     // replaces the boolean nullifier
if (redeemedAmount[id] >= iou.amount) redeemed[id] = true;
collateral[iou.debtor] = balance - paid;
collateral[iou.creditor] += paid;
```

Note the nullifier must become an *amount* for `executeRound`'s
`NullifiedIdInManifest` check to stay correct under partial redemption.

---

### WR-05: The owner can pause `redeemIOU` but never `withdraw` — pause converts the exit race into a guaranteed debtor win

**File:** `contracts/src/ClearingHubV2.sol:322` (`whenNotPaused` on `redeemIOU`), `:423-429`
**Fix location:** OFF-CHAIN today (transfer ownership); on-chain for a clean fix.

**Issue.** This is **distinct** from the accepted "`redeemIOU` is best-effort
and races the never-pausable `withdraw`" item. That item is about a *race*.
Here, a single EOA owner can *deterministically decide the race*: `pause()`
freezes `redeemIOU` and `executeRound`, while `withdraw` (line 182, no
`whenNotPaused`) stays open. A compromised or colluding owner + a defaulting
debtor is a guaranteed 100% exit with zero creditor recovery.

`docs/THREAT-MODEL.md` row 13 ("Owner rug → owner can only pause
deposits+rounds+redemptions; **withdrawals are never pausable**") presents this
asymmetry as the *mitigation*. Against the redemption product it is the attack.

The owner is `msg.sender` at deploy (`ClearingHubV2.sol:161`), a plain EOA,
with `Ownable2Step` and **no timelock**.

**Fix (off-chain, do now):** transfer ownership of both live hubs to a
multisig, ideally behind a timelock — `Ownable2Step.transferOwnership` +
`acceptOwnership` works on the deployed contracts today, so this needs no
redeploy. **Fix (on-chain, next deploy):** drop `whenNotPaused` from
`redeemIOU`, or gate pause behind a timelock.

---

### WR-06: `renounceOwnership()` is inherited and callable; called while paused it permanently bricks settlement

**File:** `contracts/src/ClearingHubV2.sol:39` and `contracts/src/ClearingHub.sol:28` (inherited from OZ `Ownable`, verified present at `lib/openzeppelin-contracts/contracts/access/Ownable.sol:76`)
**Fix location:** ON-CHAIN (redeploy); ops discipline off-chain.

**Issue.** `Ownable2Step` overrides `transferOwnership` and `_transferOwnership`
but **not** `renounceOwnership`, which calls `_transferOwnership(address(0))`.
If the owner renounces while the hub is paused, `unpause()` can never be
called: `deposit`, `executeRound` and `redeemIOU` are dead forever. `withdraw`
survives, so funds are not trapped — but both live hubs and the router become
permanently non-functional and the PvP product dies with them.

The contract NatSpec (`:36-38`) says "no owner access to funds, no
upgradeability, no fees" and never mentions that the owner can irreversibly
disable the protocol.

**Fix:**

```solidity
/// @notice Renouncing would make `unpause` unreachable — disabled by design.
function renounceOwnership() public pure override {
    revert("renounce disabled");
}
```

Applies to both `ClearingHub` (v1, frozen) and `ClearingHubV2`.

---

### WR-07: `PvPRouter` constructor performs no validation whatsoever

**File:** `contracts/src/PvPRouter.sol:101-104`; `contracts/script/DeployPvPRouter.s.sol:33-36`
**Fix location:** ON-CHAIN for future router deploys; OFF-CHAIN (script assertion) now.

**Issue.** No zero-address check, no `hubUSDC_ != hubEURC_` check, no check
that either address has code or is actually a `ClearingHubV2`. The NatSpec at
`:94-98` calls the immutables "the mitigation, not an optimization" for
evil-hub substitution — but the mitigation is only as good as what is passed at
deploy, and the deploy script reads both from unvalidated env vars.

Failure mode if both were the same hub: `executePvP` would call
`executeRound(usdcLeg.nonce, ...)` then `executeRound(eurcLeg.nonce, ...)` on
the same contract; the second reverts `WrongRoundNonce` unless
`eurcLeg.nonce == usdcLeg.nonce + 1`, permanently bricking the router for the
normal case with no diagnostic.

*The live router at `0x8287dD...` is correctly configured (the two hub
addresses differ), so this is a future-deploy hazard, not a live one.*

**Fix:**

```solidity
constructor(ClearingHubV2 hubUSDC_, ClearingHubV2 hubEURC_) EIP712("ArclearPvPRouter", "1") {
    if (address(hubUSDC_) == address(0) || address(hubEURC_) == address(0)) revert BadConfig();
    if (address(hubUSDC_) == address(hubEURC_)) revert BadConfig();
    hubUSDC = hubUSDC_;
    hubEURC = hubEURC_;
}
```

Off-chain now: add `require(hubUsdc != hubEurc && hubUsdc.code.length > 0)`
assertions to `DeployPvPRouter.s.sol` before `startBroadcast`.

---

### WR-08: OZ `ECDSA` reverts mask `BadSignature(index)` / `BadPvPSignature(index)`

**File:** `contracts/src/ClearingHubV2.sol:236`, `:348`; `contracts/src/PvPRouter.sol:190`; `contracts/src/ClearingHub.sol:124`
**Fix location:** OFF-CHAIN (SDK error decoding); optional on-chain change.
**PoC:** `test_poc10_badSignatureErrorMasked` (passes)

**Issue.** `ECDSA.recover(bytes32, bytes)` *throws* — `ECDSAInvalidSignatureLength`,
`ECDSAInvalidSignatureS`, `ECDSAInvalidSignature` — rather than returning
`address(0)`. So the contract's own indexed diagnostics are unreachable for
exactly the failure classes a client is most likely to hit. Verified: a
2-byte `signatures[1]` reverts `ECDSAInvalidSignatureLength(2)`, never
`BadSignature(1)`.

`docs/THREAT-MODEL.md` row 10 credits "OpenZeppelin ECDSA rejects high-s
values" — correct on security, but the SDK-facing consequence (no index) is
undocumented.

**Fix (off-chain):** `src/client.ts` must decode the OZ `ECDSA*` error family
alongside the hub's own errors, or operators get an opaque revert with no
pointer to the offending signer. **Fix (on-chain, optional):** use
`ECDSA.tryRecover` and convert every failure into `BadSignature(i)`.

---

### WR-09: No EIP-1271 support — contract and account-abstraction wallets cannot use Arclear at all

**File:** `contracts/src/ClearingHubV2.sol:236`, `:348`; `contracts/src/PvPRouter.sol:190`
**Fix location:** ON-CHAIN (redeploy).

**Issue.** Every consent path uses raw `ECDSA.recover`. Only EOAs can be
participants, IOU debtors, or PvP union members. For a product whose stated
audience is "Arc builders running agent swarms", excluding every smart-contract
agent wallet, safe/multisig treasury, and 4337 account is a significant
functional limit that appears nowhere in the docs or NatSpec.

**Fix:** use OZ `SignatureChecker.isValidSignatureNow(signer, digest, sig)`
instead of `ECDSA.recover(...) == signer` on all three paths. Note this makes
signature verification an *external call*, which interacts with the reentrancy
posture — `executeRound` currently makes zero external calls, and that property
would be lost; the `nonReentrant` guard already covers it, and the router's
"no guard needed because stateless" argument (`PvPRouter.sol:29-33`) would need
re-checking.

---

### WR-10: `DeployV2.s.sol` silently truncates redemption parameters to `uint64`

**File:** `contracts/script/DeployV2.s.sol:24-26`
**Fix location:** OFF-CHAIN (script only; affects future deploys).

**Issue.**

```solidity
uint64 k = uint64(vm.envOr("HUB_K", uint256(3)));
uint64 ring = uint64(vm.envOr("HUB_RING", uint256(16)));
uint64 maxIouLifetime = uint64(vm.envOr("HUB_MAX_IOU_LIFETIME", uint256(86400)));
```

Unchecked downcasts. `HUB_RING=18446744073709551632` (2⁶⁴+16) silently deploys
with `RING = 16`; `HUB_K=18446744073709551619` (2⁶⁴+3) silently deploys with
`K = 3`. The contract's `BadConfig` guard (`ClearingHubV2.sol:163`) only catches
the exact-multiple-of-2⁶⁴ case that truncates to 0. There is also no upper-bound
sanity: a `RING` in the thousands would make `redeemIOU` exceed the block gas
limit and silently ship a hub with no working redemption path.

The `console.log` lines print the *truncated* value, so the operator sees the
wrong number confirmed back and has no signal.

**Fix:**

```solidity
uint256 kRaw = vm.envOr("HUB_K", uint256(3));
require(kRaw > 0 && kRaw <= type(uint64).max, "HUB_K out of range");
uint256 ringRaw = vm.envOr("HUB_RING", uint256(16));
require(ringRaw > 0 && ringRaw <= 64, "HUB_RING out of gas-safe range");
```

---

### WR-11: The staleness clock is resettable by a free 2-of-2 round — the documented cost model is wrong

**File:** `contracts/src/ClearingHubV2.sol:256-258`, gate at `:332-333`
**Fix location:** ON-CHAIN (redeploy); doc correction OFF-CHAIN.
**PoC:** `test_poc5_staleDebtorResetsClock` (passes)

`docs/THREAT-MODEL.md` row 18 accepts keep-alive censorship, so the *existence*
of this is known and out of scope. **The stated mitigation is factually wrong,
and that part is in scope:**

| Documented | Actual (measured) |
|---|---|
| "dust-cycles" / "ping-pong dust IOUs with an accomplice" | No IOUs required. `consumedIds = []`, `deltas = [0,0]`. |
| implies an accomplice with capital | Neither address needs one base unit of collateral. |
| "costs the debtor gas **every round**" | Once per `K−1` rounds (K = 3 → every other round), and the debtor controls the pace since they can mint rounds themselves. |
| "fully visible on-chain (the creditor's ids never appear in any manifest…)" | With CR-01, the debtor can make the ids appear in a manifest they wrote — the on-chain visibility signal is forgeable. |

Verified: an already-stale debtor executes one `[debtor, sybil]`, `[0, 0]`,
empty-manifest round for 186,505 gas; `redeemIOU` immediately reverts
`DebtorNotStale(lastRound, 3)`.

**Fix:** on-chain, participation should only refresh `lastRound` when the
participant actually had paper consumed (a non-zero delta, or an id in the
manifest attributable to them — which requires the CR-01 fix). Off-chain,
correct THREAT-MODEL row 18 and `docs/PROTOCOL.md:211-222`.

---

## Info

### IN-01: `StoredRoot.nonce` is written but never read on-chain

`contracts/src/ClearingHubV2.sol:263` writes `nonce`, but the redemption loop
at `:361` reads `rootRing[bufferedNonce % RING].root` without asserting
`.nonce == bufferedNonce`. The positional match is guaranteed by construction
(writes are contiguous) — but the field exists precisely to make that
checkable, and checking it is one `SLOAD`-free comparison on an already-loaded
struct. Free defense-in-depth left on the table.

### IN-02: The TOCTOU NatSpec claim is imprecise (benign)

`contracts/src/ClearingHubV2.sol:302-306` claims that if a round lands between
proof generation and mining, "the count/positional match fails and the call
reverts". When `roundNonce > RING`, `expected` stays `RING` (count matches) and
only `start` shifts; if the newly-added round has an empty manifest, the
sentinel short-circuit at `ManifestMerkle.sol:135` passes and the stale proof
set is **accepted**. Safety is preserved — the contract always evaluates the
*current* window and only accepts genuine non-inclusion or empty roots — but the
stated mechanism is not what happens.

### IN-03: `uint64(block.timestamp)` truncation

`contracts/src/ClearingHubV2.sol:263`. Unchecked downcast; benign until year
2554, noted for completeness.

### IN-04: No zero-address validation on `token_` or on IOU parties

`contracts/src/ClearingHubV2.sol:159-168` — `token_ == address(0)` deploys
fine and fails only at first `deposit` (SafeERC20 no-code revert).
`redeemIOU` (`:324-325`) checks `amount != 0` and `debtor != creditor` but not
`creditor != address(0)`; crediting the zero address is a permanent burn of the
debtor's collateral, and the debtor's own signature is required, so it is
self-harm only.

### IN-05: `executeRound` never records consumption, so one id may appear in unlimited round manifests

`contracts/src/ClearingHubV2.sol:220-226`. The "one IOU, one settlement"
invariant is enforced *only* by the coordinator's off-chain `settledIds` and by
participants re-verifying proposals. `docs/THREAT-MODEL.md` row 4 is honest
about this ("coordinator excludes ids in executed manifests"), but it is the
same missing binding that CR-01 exploits, and CR-01 Option B closes both.

### IN-06: `executePvP`'s `usdcLegDigest` / `eurcLegDigest` parameters are redundant

`contracts/src/PvPRouter.sol:167-178`. `digestU`/`digestE` are recomputed from
calldata and then *required to equal* the passed-in values, after which only
the recomputed values are used. The parameters cost calldata gas and add a
revert path (`LegDigestMismatch`) that can only fire on caller error. Not a
bug; the redundancy is defensible as an explicit assertion, but it should be
documented as such rather than as a security check.

### IN-07: `ManifestMerkle.rootOf` is computed twice per leg on the PvP path

`contracts/src/PvPRouter.sol:168,172` computes each leg's root, then
`ClearingHubV2.executeRound:226` computes it again. Pure duplicated work
(~2× the per-id merkle cost on the largest gas consumer in the system).
Correctness is unaffected. Flagged as duplication, not performance.

### IN-08: `foundry.toml` does not pin `evm_version` or `bytecode_hash`

`contracts/foundry.toml`. Resolved config is `evm_version = "cancun"`,
`bytecode_hash = "ipfs"`, `cbor_metadata = true` — all implicit. For contracts
that are **already deployed, immutable and explorer-verified**, byte-identical
rebuilds are the only way to re-verify; both values can drift with a Foundry
upgrade or a change in source paths. Pin them explicitly:

```toml
evm_version = "cancun"
bytecode_hash = "ipfs"
```

`PvPExecuted` (`PvPRouter.sol:80-86`) also has no `indexed` fields, making
per-bundle log filtering impossible for indexers.

---

## Reproduction

```bash
# 1. Restore the PoC harness
cp "/private/tmp/claude-501/-Users-aljosamakevic-Documents-Buildground-Playground-arclear/75ebecc2-35f5-464a-a6a6-1090d0c9b9db/scratchpad/ZZAuditPoC.t.sol" contracts/test/

# 2. Run it (expect 13/13 PASS against the shipped contracts)
cd contracts && forge test --match-contract ZZAuditPoC -vv

# 3. Baseline suite is unaffected (101/101 PASS)
forge test --no-match-contract ZZAuditPoC
```

| PoC | Proves |
|---|---|
| `test_baseline_redeemSucceeds` | control: redemption works absent an attacker |
| `test_poc1_manifestPoisoningBlocksRedemption` | CR-01, by an unrelated third party |
| `test_poc1b_debtorSelfPoisons` | CR-01, by the debtor against their own paper |
| `test_poc2_ringFlushPermanentlyBlocksRedemption` | CR-02, permanence verified 7 days later |
| `test_poc3_verifyInclusionReverts` / `_poc3b_` | WR-01, direct and via `redeemIOU` |
| `test_poc4_zeroCollateralRoundIsFree` | the free-round enabler for CR-01/CR-02/WR-11 |
| `test_poc5_staleDebtorResetsClock` | WR-11 |
| `test_poc6_noPartialRedemption` | WR-04 |
| `test_poc7_leafCountNotBound` | WR-02 |
| `test_poc8_junkRoundGas` | attack cost: 186,505 / 1,543,541 gas |
| `test_poc9_shortExpiryIsUnredeemable` | WR-03 |
| `test_poc10_badSignatureErrorMasked` | WR-08 |

---

_Reviewed: 2026-07-27_
_Reviewer: Claude (gsd-code-reviewer), Audit Scope A_
_Depth: deep_
