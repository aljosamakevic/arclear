---
phase: 01-threshold-consent-brief-phase-0
reviewed: 2026-07-22T23:24:09Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - src/round.ts
  - test/rebuild.test.ts
  - contracts/src/ClearingHubV2.sol
  - contracts/test/ClearingHubV2Parity.t.sol
  - contracts/script/DeployV2.s.sol
  - src/abi/ClearingHubV2.ts
  - demo/coordinator.ts
  - demo/agents.ts
  - demo/e2e.ts
  - demo/server.ts
  - demo/setup.ts
  - public/dashboard.html
  - docs/PROTOCOL.md
  - docs/THREAT-MODEL.md
findings:
  critical: 1
  warning: 7
  info: 7
  total: 15
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-07-22T23:24:09Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

Reviewed the Phase 1 (Threshold Consent) implementation: the exclude-and-recompute
SDK seam (`rebuildProposal`, excluded-aware `verifyProposal`), the two-pass
coordinator state machine (`collectConsents`/`attemptRound`), the ClearingHubV2
contract + parity test + deploy script + ABI, the demo wiring (server, setup, e2e,
dashboard), and the protocol/threat-model docs.

Verified good:

- `ClearingHubV2.sol` is code-identical to `ClearingHub.sol` (diffed modulo
  NatSpec and contract name; both use the `"ArcClearingHub"/"1"` domain). The
  `withdraw`-never-pausable invariant is preserved, digest parity is
  machine-checked against the unchanged v1 fixture, and the recovery of a
  viem-produced signature is asserted on-chain.
- No division anywhere in protocol math (`net()`, `rebuildProposal`,
  `verifyProposal` are bigint-only; the only divisions are display-layer
  percentages and demo amount scaling, which the constraint permits).
- Verify paths return `{ ok, reason }` as data; refusals and aborts flow as
  structured outcomes, not throws.
- `settledIds` are only mutated on confirmed settlement; property tests cover
  zero-sum, exclusion, cascade, shuffle-determinism, and disjoint manifests.

However, the review found one Critical defect that defeats the phase's stated
purpose: the coordinator never verifies collected consent signatures before
submitting, so a member who returns a *malformed* consent bypasses the entire
exclude-and-recompute mechanism and can DoS settlement indefinitely at zero
cost — directly contradicting the griefing bound claimed in PROTOCOL.md.
Several warnings concern the coordinator's failure-handling seams (unreachable
nonce-race handler, double-settle window on receipt failure, concurrency races
in the demo server) and a factually wrong NatSpec claim in ClearingHubV2.

## Critical Issues

### CR-01: Invalid consent signature bypasses exclude-and-recompute and permanently DoSes settlement

**File:** `demo/coordinator.ts:88-94, 190-194, 220-232` (root cause), `src/round.ts:171-186` (unused defense)
**Issue:** `collectConsents` accepts any `{ kind: "consent", signature }` outcome
at face value, and `attemptRound` submits whenever `consents.size ===
participants.length`. Nothing ever calls `verifyConsent` (which exists in
`src/round.ts` precisely for this) on the collected signatures. A malicious or
buggy participant that promptly answers with a garbage signature (or someone
else's valid signature, breaking the index alignment the contract requires) is
counted as a consenter, so:

1. Pass 1 appears unanimous → `submit` is called → `executeRound` reverts with
   `BadSignature(i)` on-chain → the relayer burns gas on a reverted tx →
   `runRound` throws (`tx reverted: …`) → phase `failed`, HTTP 500.
2. The attacker is never in `timedOut` or `refused`, so the exclusion batch
   never includes them. The rebuild path never triggers. Repeating this every
   round stalls settlement **forever** at zero cost to the attacker.

This directly falsifies PROTOCOL.md's griefing analysis ("worst case is two
signature-collection passes: a latency cost") and defeats the phase's core
value ("the system must keep settling when members stall or default"). The
test harness (`test/rebuild.test.ts` `mkProviders`) only models stall/refusal/
honest behaviors, so this path is entirely untested.
**Fix:** Verify every consent as it arrives (or at snapshot time) and demote
invalid ones to refusals so the existing exclusion machinery handles them:

```ts
// in collectConsents' fulfilled handler, before accepting:
if (outcome.kind === "consent") {
  const ok = await verifyConsent(hub, proposal, participant, outcome.signature, chainId);
  if (!ok) {
    refused.push({ address: participant, reason: "invalid consent signature" });
  } else {
    consents.set(key, outcome.signature);
  }
}
```
(`collectConsents` will need `hub`/`chainId` params, or the check can live in
`attemptRound` between collection and submit — either way, an invalid signature
must land in the excluded batch, and `submit` must never be called with a
signature set the coordinator has not locally verified.) Add a
`mkProviders` behavior (`badSignature`) to `test/rebuild.test.ts` covering it.

## Warnings

### WR-01: Receipt failure after submission opens a double-settle window (CONS-04)

**File:** `demo/coordinator.ts:337-344, 384-386`
**Issue:** `settledIds` is updated only after `submit` resolves, and `submit`
resolves only after `waitForTransactionReceipt` succeeds. If the receipt wait
throws (RPC transport error, timeout) while the transaction ultimately mines,
the round *did* execute on-chain but the coordinator never marks its
`consumedIds` as settled. The next `/round` reads the (now advanced) nonce
fresh from chain, re-nets the same IOUs, every participant re-verifies against
their equally-unaware local view, signs, and the contract happily executes —
the same paper settles twice, violating the phase's "never twice" invariant.
The threat model (row 4) only covers a coordinator that knowingly excludes
executed manifests; this is the unknowing case.
**Fix:** Before starting a round (or on submit failure), reconcile against
chain state: if `hubClient.roundNonce()` has advanced past the nonce the
coordinator last submitted, fetch the `RoundExecuted` log for that nonce,
compare `roundHash` to the submitted proposal digest, and if it matches, fold
the submitted proposal's `consumedIds` into `settledIds` before re-netting.
At minimum, persist the pending proposal and refuse to run a new round while a
submitted-but-unconfirmed one exists.

### WR-02: WrongRoundNonce graceful-abort branch is unreachable — nonce races surface as failures

**File:** `demo/coordinator.ts:412-416`, `src/client.ts:97-118`
**Issue:** `runRound` catches errors and checks
`msg.includes("WrongRoundNonce")` to classify a concurrent-round nonce race as
an expected abort. But `HubClient.executeRound` passes an explicit `gas:
1_500_000n`, so viem skips gas estimation/simulation — there is no pre-flight
`eth_call` that could surface the decoded custom error. A nonce race instead
lands on-chain, reverts, and `submit` throws the literal string
`` `tx reverted: ${txHash}` `` (coordinator.ts:342), which never contains
"WrongRoundNonce". Result: the intended graceful-abort path is dead code; a
nonce race sets phase `failed`, rethrows (HTTP 500 from `/round`), and burns
relayer gas — misclassifying "expected protocol behavior" (per the inline
comment) as a fault.
**Fix:** Either simulate before sending (`pub.simulateContract` with the same
args inside `submit`, which decodes `WrongRoundNonce` properly) or, on receipt
revert, re-read `hubClient.roundNonce()` and branch on
`onChainNonce !== proposal.roundNonce` instead of string-matching the message.

### WR-03: Coordinator state races: no round mutex, and consent providers read the live IOU list mid-round

**File:** `demo/coordinator.ts:318-335, 346-360`, `demo/server.ts:76-125`
**Issue:** Two related races in the demo wiring:

1. `attemptRound` snapshots `openIous: this.openIous` once, but each persona's
   provider closure calls `verifyProposal(..., this.openIous, ...)` — the live
   getter — at consent time. `POST /simulate` is fire-and-forget and streams
   IOUs into `coordinator.addIous` one every 120ms (~4.2s total), while the
   default consent window is 30s. Pressing "Run netting round" during (or just
   before) a simulate burst makes honest agents' recomputation include IOUs the
   proposal was not built from → delta-mismatch refusals → honest members
   spuriously excluded → pass-2 recomputation mismatches again (rebuild uses
   the stale snapshot, providers use the live list) → spurious abort. This is
   the normal dashboard interaction sequence, not an edge case.
2. `POST /round` has no in-flight guard (unlike `/simulate`'s `simulating`
   flag). Two concurrent `/round` requests interleave `phase`/`phaseDetail`
   writes and both submit; the loser burns relayer gas on an on-chain revert
   and (via WR-02) returns a 500.

**Fix:** (1) Capture the IOU snapshot once in `runRound` and close the
providers over that array instead of `this.openIous`. (2) Add a `roundInFlight`
boolean in `server.ts` (or in `Coordinator.runRound`) that rejects/queues a
second concurrent round with a 409.

### WR-04: ClearingHubV2 NatSpec falsely claims manifestHash is a merkle root

**File:** `contracts/src/ClearingHubV2.sol:25-27` (vs `:103`, `src/round.ts:19-22`, `docs/PROTOCOL.md:210-216`)
**Issue:** The contract-level `@dev` states "`manifestHash` now carries the
sorted-leaf merkle root of consumed IOU ids". This is false: the SDK still
computes `keccak256(concat(sortedIds))` (`src/round.ts:19`), the same file's
own `@param manifestHash` on line 103 says "keccak256 of the sorted
consumed-IOU-id list", and PROTOCOL.md/THREAT-MODEL.md both document the merkle
root as a *future* phase ("v2 swaps in…", "planned"). A third-party integrator
reading the deployed contract's NatSpec would build an incompatible manifest
commitment. It also breaches the phase rule that V2 may differ from V1 only
where name/NatSpec *accurately* describe it.
**Fix:** Reword lines 25-27 to match reality, e.g. "`manifestHash` carries the
keccak256 of the sorted consumed-IOU-id list (same bytes32 slot; a later phase
swaps in a sorted-leaf merkle root without touching the contract)."

### WR-05: A synchronously-throwing consent provider crashes the whole collection

**File:** `demo/coordinator.ts:85-107`
**Issue:** The doc comment and the rejection handler promise "a throwing
provider is treated as a reasoned refusal, never a crash" — but that only holds
for async rejections. `provider(proposal, excluded)` is invoked bare inside the
`new Promise` executor loop; a provider that throws *synchronously* (before
returning its promise) throws out of the executor, rejecting the
`collectConsents` promise itself. That aborts the entire collection for all
members, propagates through `attemptRound` into `runRound`'s catch → phase
`failed` + HTTP 500, instead of excluding the one faulty member.
**Fix:** Route the call through the microtask queue so sync throws become
rejections handled by the existing refusal path:

```ts
Promise.resolve().then(() => provider(proposal, excluded)).then(
  (outcome) => { /* existing fulfilled handler */ },
  (e) => { /* existing rejection handler */ },
);
```

### WR-06: verifyProposal never checks roundNonce — a participant can be induced to consent twice over the same paper

**File:** `src/round.ts:106-153`
**Issue:** `verifyProposal` validates self-membership, own delta, manifest
hash, and digest — but never inspects `proposal.roundNonce` and keeps no notion
of outstanding consents. A malicious coordinator can concurrently collect
consents for two proposals at nonces N and N+1 whose manifests overlap: each
verifies cleanly against the participant's local open-IOU view (neither is
settled yet), the participant signs both, and the coordinator executes them
back-to-back — the overlapping IOUs settle twice, debiting the debtor twice.
On-chain safety ("signed the exact executed set") technically holds for each
round individually, but the CONS-04 "never twice" property is enforceable only
by the participant, and the SDK's participant-side check gives them no tool or
warning for it. The demo providers happen to be safe (driven inside one
`attemptRound`), but `verifyProposal` is the exported zero-trust primitive for
third-party members.
**Fix:** At minimum document the requirement (participants must track
outstanding consents and refuse a proposal whose `consumedIds` intersect an
unconfirmed prior consent, and should check `proposal.roundNonce` against the
hub's live `roundNonce`). Better: accept an optional
`opts.expectedRoundNonce?: bigint` and/or `opts.pendingConsumedIds?:
ReadonlySet<Hex>` and refuse on mismatch/overlap with a diagnostic reason.

### WR-07: Wall-clock timing assertions in rebuild.test.ts are flake-prone

**File:** `test/rebuild.test.ts:309-315, 343-356`
**Issue:** `expect(Date.now() - started).toBeLessThan(45)` with 5ms providers
and a 50ms window, and the 25ms-window/`delay(40)` late-consent test, assert
hard real-time bounds. Under CI load or a slow event loop, a 5ms `setTimeout`
can easily settle after 45ms, failing the test with no code defect. The async
property tests (15ms windows with real EIP-712 signing) tolerate both branches
by design, but these direct assertions do not.
**Fix:** Widen the margin substantially (e.g. window 200ms, assert `< 150`), or
assert the ordering property instead of elapsed time — `timedOut` empty and
`consents.size === 3` already prove early completion; if elapsed time must be
checked, assert it is less than the window itself with generous slack.

### WR-08: e2e baseline-failure path leaks the spawned anvil process

**File:** `demo/e2e.ts:99-102` (contrast with `:179`, `:207`, `:229`)
**Issue:** Every later failure path calls `env.anvil?.kill()` before
`process.exit(1)`, but the earliest one (baseline round not settled) exits
without killing anvil. A child spawned with `stdio: "ignore"` outlives the
parent, leaving an orphan anvil bound to 8545 — the next `npm run e2e:anvil`
then silently attaches its personas/deployments to the stale chain state
(`setup.ts` never checks whether its spawn actually won the port), producing
confusing cascading failures.
**Fix:** Add `env.anvil?.kill();` before the `process.exit(1)` at line 101, or
consolidate into a single `fail(msg)` helper used by all four exit paths.

## Info

### IN-01: Dead `strangers` computation in verifyProposal

**File:** `src/round.ts:138-143`
**Issue:** `myIds` and `strangers` are computed, then discarded with `void
strangers;`. The comment explains why the check is inconclusive, but building a
Set and filtering the full manifest on every verification is pure dead work
that suggests an unfinished check.
**Fix:** Delete the computation and keep only the explanatory comment, or
finish the check (e.g. flag strangers whose ids collide with locally-known
IOUs).

### IN-02: verifyProposal does not enforce canonical (sorted, deduped) consumedIds

**File:** `src/round.ts:145-147`
**Issue:** `manifestHash(proposal.consumedIds)` hashes the list in the given
order, so a proposal with unsorted or duplicated `consumedIds` and a matching
hash over that non-canonical order passes verification. Deltas are unaffected,
but the on-chain commitment then diverges from the spec's canonical sorted
preimage (PROTOCOL.md rule 7), breaking third-party after-the-fact
reproducibility of the manifest.
**Fix:** Check sortedness/uniqueness before hashing and refuse with reason
"consumedIds not in canonical order".

### IN-03: No behavioral test suite runs against ClearingHubV2

**File:** `contracts/test/ClearingHubV2Parity.t.sol` (only V2 coverage)
**Issue:** The unit/revert-matrix/fuzz suites (`ClearingHub.t.sol`,
`ClearingHubFuzz.t.sol`) target v1 only; V2 is guarded solely by digest parity
plus the e2e happy path. Today the sources are verified identical, but any
future drift in V2's `executeRound` checks (ascending order, zero-sum,
collateral coverage, pause gating of deposit-but-not-withdraw) would be
invisible to `forge test`.
**Fix:** Parameterize `RoundBuilder`/the existing suites over the hub
implementation, or add a thin `ClearingHubV2.t.sol` that inherits the v1 test
contract with the V2 deployment.

### IN-04: Dashboard renders server/participant-derived strings via innerHTML

**File:** `public/dashboard.html:124-175` (notably `:173` `"❌ " + s.lastError`)
**Issue:** `$("phase").innerHTML` and the table renders interpolate unescaped
strings. `lastError` carries raw error messages (RPC responses; in a
multi-party deployment, provider refusal text is participant-controlled),
making this a stored-XSS foothold on the coordinator's dashboard. Low risk for
the local demo, but the pattern will be copied forward.
**Fix:** Use `textContent` for `phase`/error strings, or HTML-escape all
interpolated values.

### IN-05: Convoluted no-op expression in the net-delta cell

**File:** `public/dashboard.html:133`
**Issue:** `usd(net < 0n ? -net : net).slice(net < 0n ? 0 : 0)` — the `.slice`
argument is `0` in both branches (no-op), and the surrounding ternary
(`usd(...) === "$0.00" && net === 0n ? "$0.00" : …`) collapses to the else
branch's value in every case. Dead code obscuring a simple format call.
**Fix:** `` `${net > 0n ? "+" : net < 0n ? "−" : ""}${usd(net < 0n ? -net : net)}` ``.

### IN-06: Parity test file name does not match its contract name

**File:** `contracts/test/ClearingHubV2Parity.t.sol:13`
**Issue:** The file `ClearingHubV2Parity.t.sol` contains contract
`DigestParityV2Test`, breaking the project's `<Contract>.t.sol` naming
convention (compare `DigestParity.t.sol` → `DigestParityTest`).
**Fix:** Rename the file to `DigestParityV2.t.sol` (or the contract to
`ClearingHubV2ParityTest`).

### IN-07: Anvil startup race and stale-instance attach in setup

**File:** `demo/setup.ts:81-82`
**Issue:** `spawn("anvil", ["--silent"]) `+ fixed 1200ms sleep: on a slow
machine the first RPC call races startup; if 8545 is already bound (e.g. an
orphan from WR-08), the new anvil exits but setup silently attaches to the old
instance with stale state, since neither the spawn result nor the chain state
is checked.
**Fix:** Poll `eth_chainId`/`getBlockNumber` until ready with a bounded retry,
and fail fast if `anvil.exitCode !== null` after spawn (port collision).

---

_Reviewed: 2026-07-22T23:24:09Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
