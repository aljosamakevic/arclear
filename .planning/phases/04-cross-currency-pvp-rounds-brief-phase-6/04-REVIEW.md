---
phase: 04-cross-currency-pvp-rounds-brief-phase-6
reviewed: 2026-07-24T17:20:53Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - src/pvp.ts
  - contracts/src/PvPRouter.sol
  - contracts/test/PvPRouter.t.sol
  - contracts/test/utils/PvPRoundBuilder.sol
  - contracts/test/PvPParity.t.sol
  - contracts/script/DeployPvPRouter.s.sol
  - src/abi/PvPRouter.ts
  - src/client.ts
  - demo/pvp.ts
  - demo/fx.ts
  - demo/setup.ts
  - demo/e2e.ts
  - docs/PROTOCOL.md
  - docs/THREAT-MODEL.md
findings:
  critical: 1
  warning: 3
  info: 3
  total: 7
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-07-24T17:20:53Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

Reviewed the cross-currency PvP layer: the stateless `PvPRouter` contract, its
SDK mirror (`src/pvp.ts`, `src/abi/PvPRouter.ts`, `src/client.ts`), the demo
orchestration (`demo/pvp.ts`, `demo/fx.ts`, `demo/setup.ts`, `demo/e2e.ts`),
the Foundry suites, and the two docs.

The on-chain half is solid and matches its stated invariants. I verified the
`PvPRound` typehash byte-parity across stacks (viem `keccak256` of the type
string ==
`0x3a749978dd041110e5de2b185c7c5f9bbd6edee919eaa6d5f97aa8b3a078c7ef`, present
in both `src/abi/PvPRouter.ts` and the forge artifact), confirmed the shipped
TS bytecode equals `contracts/out/PvPRouter.sol/PvPRouter.json`, and confirmed
the both-or-neither mechanism is plain external calls with revert bubbling (no
try/catch, no low-level calls). Statelessness, immutable hub binding, and the
union-set signature verification are all as documented. The PvP vitest and
parity suites pass (33 tests).

However, the **participant-side consent guard has a real safety gap** (CR-01):
`verifyPvPProposal` is documented (PROTOCOL.md, THREAT-MODEL #5/#25) as the
mechanism by which a lying coordinator "dies by construction," but it does not
verify that a member's FX counter-leg is actually *included* in the opposite
leg. I proved by execution that a malicious coordinator can settle the USDC
side of a participant's cross-currency trade while omitting the EURC side, and
the victim's own `verifyPvPProposal` returns `{ ok: true }`. This is an
off-chain SDK fix — it does **not** require touching the deployed router at
`0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c`.

Additionally, the chain-aware PvP wrapper (`runPvPRound`) does not reproduce
the single-hub coordinator's double-settle protection on the receipt-transport
failure path (WR-01), and can mislabel its own successful settlement as
`blocked` (WR-02), both leaving consumed IOUs eligible for re-netting.

## Critical Issues

### CR-01: `verifyPvPProposal` never checks FX-pair *inclusion*, so a coordinator can settle one side of a participant's cross-currency trade

**File:** `src/pvp.ts:213-247`
**Issue:**
The FX-pair check groups the *member's own* IOUs by `ref`
(`byRef(myIousUsdc)` / `byRef(myIousEurc)`) and, for each shared ref, checks
one-IOU-per-side, direction-swap, and cross-multiplication. It never inspects
`proposal.usdcLeg.consumedIds` or `proposal.eurcLeg.consumedIds` to confirm
that *both* sides of the pair are actually consumed by the two legs. The
per-leg `verifyProposal` calls (lines 196-211) only run for legs the member
is a participant of, and a member who has been stripped from the counter-leg
is simply not in it, so that leg's `verifyProposal` is skipped entirely.

Consequently a coordinator can build a bundle that consumes the member's
paying IOU on the USDC leg but omits their receiving IOU from the EURC leg
(padding the EURC leg with unrelated paper to keep quorum). The member's
`verifyPvPProposal` passes, they sign both the USDC leg consent and the
PvPRound consent, and the router settles both legs atomically — moving the
member's USDC out with no matching EURC in. The "both-or-neither" guarantee
holds for the two *legs*, but not for the member's *trade*, which is the
property PvP is sold on.

I reproduced this end-to-end against the real SDK (alice pays 1,000,000 USDC
units to bob for 989,589 EURC units, shared `ref`; coordinator strips bob's
EURC IOU and pads the EURC leg with a `dave→carol` flow):

```
alice in usdcLeg: true
alice in eurcLeg: false
fxE consumed by eurcLeg: false
verifyPvPProposal verdict for alice: {"ok":true}
```

This contradicts PROTOCOL.md ("verifiers pair by `ref` and check
cross-multiplication per pair" as the coordinator-honesty guarantee) and
THREAT-MODEL rows #5/#25 ("a bad rate dies at local verification";
"a malicious coordinator dies by construction"). The residual loss is bounded
to ordinary collateralized credit risk on the open leg (the victim still holds
bob's signed EURC IOU, nettable/redeemable later) — the same bound as the
documented single-leg-extraction residual (row #21) — **but this coordinator-
constructed variant is neither caught by the code nor documented as accepted.**

**Fix:** In the FX-pair loop, after confirming a shared-`ref` pair is
direction-swapped and rate-consistent, assert that both sides are *jointly*
included or excluded in the proposed legs. Build lowercase id sets from the
leg manifests once, then require symmetry:

```ts
const usdcConsumed = new Set(proposal.usdcLeg.consumedIds.map((i) => i.toLowerCase()));
const eurcConsumed = new Set(proposal.eurcLeg.consumedIds.map((i) => i.toLowerCase()));
// ... inside the `for (const [ref, uList] of usdcByRef)` loop, after the
// direction + rate checks pass:
const uIn = usdcConsumed.has(uList[0].id.toLowerCase());
const eIn = eurcConsumed.has(eList[0].id.toLowerCase());
if (uIn !== eIn) {
  return {
    ok: false,
    reason: `FX ref ${ref} inclusion asymmetry: USDC side ${uIn ? "in" : "out"}, ` +
      `EURC side ${eIn ? "in" : "out"} — one leg of the trade would settle without its twin`,
  };
}
```

If the team instead deems this an accepted residual (as single-leg extraction
is), it must be documented in THREAT-MODEL.md with its harm bound, and the
PROTOCOL.md claim that local verification catches coordinator lies must be
narrowed accordingly.

## Warnings

### WR-01: `runPvPRound` does not persist pending state on the coordinators, weakening double-settle protection on the receipt-transport path

**File:** `demo/pvp.ts:595-627`, `demo/pvp.ts:651-684`
**Issue:**
The single-hub `Coordinator` sets a private `pendingSubmission` record before
broadcast and reconciles it against chain state on the next round
(`demo/coordinator.ts:440-483`), guaranteeing CONS-04 "never settle twice"
even if `waitForTransactionReceipt` fails after the tx actually mined. The PvP
wrapper only fires the *optional* `onPending` callback and never populates the
coordinators' `pendingSubmission`. If `waitForTransactionReceipt` throws
(transport error) while the PvP tx is in fact mined-and-successful,
`attemptPvPRound` returns `aborted`/`submit`, `runPvPRound` returns
`aborted`/`blocked`, and the consumed ids are **never folded into
`settledIds`**. Because `executeRound` has no on-chain "already-settled"
nullifier (only the redemption nullifier), the next ordinary `runRound` re-nets
those IOUs and moves the same collateral a second time. The reference caller
(`demo/e2e.ts`) never wires `onPending` to persist/reconcile, so the demo's
"never twice" claim is unbacked on the PvP path.
**Fix:** Have `runPvPRound`'s `submit` set each coordinator's
`pendingSubmission` (or an equivalent externally-reconcilable record) before
broadcast, and reconcile both hubs by matching the logged `RoundExecuted`
`roundHash` against `proposal.<leg>.digest` before the next round — i.e. port
`reconcilePendingSubmission` to the two-hub case rather than delegating to an
optional callback.

### WR-02: `runPvPRound` mislabels its own mined-successful settlement as `blocked` when the receipt wait fails

**File:** `demo/pvp.ts:632-648`
**Issue:**
Submission-failure classification compares only nonce *values*: if either hub
nonce advanced it returns `blocked: concurrent round`. But if the failure was a
receipt-transport error and our *own* PvP tx mined successfully, both nonces
advance by our own tx — so a genuine settlement is reported as "blocked by a
concurrent round," and (per WR-01) its ids are never folded. Unlike the
single-hub reconciler, this path never matches the on-chain `RoundExecuted`
digest to distinguish "our round executed" from "someone else's did."
**Fix:** Before classifying, fetch `RoundExecuted` for the submitted
`roundNonce` on each hub and compare its `roundHash` to the leg digests; if
they match, treat it as `settled` and fold ids, not `blocked`.

### WR-03: SDK `unionParticipants` omits the strict-ascending / zero-address guards the on-chain `_unionOf` enforces

**File:** `src/pvp.ts:90-108` (vs `contracts/src/PvPRouter.sol:214-246`)
**Issue:**
The contract's `_unionOf` reverts `UnionNotStrictlyAscending` (which also
rejects the zero address) if the merged stream is not strictly ascending. The
SDK's `unionParticipants` assumes sorted inputs and silently produces a
merged list for unsorted/duplicate/zero input, with no validation. It is used
to size gas (`src/client.ts:374-385`) and to order `pvpSignatures` in
`finalize` (`demo/pvp.ts:379`). Divergence today is benign because
`net()` guarantees sorted participants and the on-chain check is the backstop
(a mismatch reverts `BadPvPSignature`/`UnionNotStrictlyAscending` rather than
settling wrongly), but the SDK helper is documented as implementing "the same
spec the router's on-chain sorted merge implements" (line 88) while it does
not enforce the spec's precondition.
**Fix:** Either assert strictly-ascending inputs and reject the zero address in
`unionParticipants` (matching the contract), or soften the doc comment to state
it assumes pre-sorted, non-zero inputs and is not a validator.

## Info

### IN-01: Division used in `demo/fx.ts` amount construction

**File:** `demo/fx.ts:41`
**Issue:** `const eurcAmount = (usdcAmount * fxNumerator) / fxDenominator;`
uses `/` — the project constraint is "no division anywhere in protocol math."
This is demo trade-construction, not protocol math, and is immediately guarded
by an exact `rateConsistent` cross-multiplication check that throws on any
inexact result (lines 42-47), so no unchecked rounded amount can flow onward.
**Fix:** None required; the carve-out is explicit and guarded. Consider a
one-line note that this is the only sanctioned `/` and only as an unverified
candidate constructor, to keep the invariant grep-clean.

### IN-02: `attemptPvPRound.finalize` relies on non-null assertions gated by prior screening

**File:** `demo/pvp.ts:375-379`
**Issue:** `pass.consents.get(m.toLowerCase())!.usdcConsent!` uses double
non-null assertions. These are safe only because `screenPvPConsents` refuses
any member missing a required leg consent and `finalize` runs only when
`pass.consents.size === union.length`. The safety is real but implicit; a
future change to the screening order would turn this into an `undefined`
pushed into a signature array.
**Fix:** Add a defensive guard (or narrow the type) so a screening regression
fails loudly at assembly rather than producing a malformed signature set.

### IN-03: Duplicated union-merge logic between SDK, contract, and test harness

**File:** `src/pvp.ts:90-108`, `contracts/src/PvPRouter.sol:214-246`, `contracts/test/utils/PvPRoundBuilder.sol:176-200`
**Issue:** Three hand-written implementations of the sorted-union merge exist.
They agree today (verified by the passing suites), but three copies of an
ordering-sensitive algorithm is a drift risk, especially given WR-03's
divergence in validation strictness.
**Fix:** Keep, but ensure a shared property/parity test exercises all three
against the same random sorted inputs (the vitest `unionParticipants` property
covers the SDK copy only).

---

_Reviewed: 2026-07-24T17:20:53Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
