# Phase 1: Threshold Consent (brief Phase 0) - Research

**Researched:** 2026-07-22
**Domain:** Two-pass consent protocol (exclude-and-recompute) over an existing EIP-712 netting stack — TypeScript state machine + near-verbatim Solidity copy
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Threshold & rebuild policy**
- **D-01 Quorum:** A rebuilt round proceeds whenever the recomputed netting still has **≥2 participants with nonzero deltas** — same floor as the contract's `TooFewParticipants`. No new threshold parameter.
- **D-02 Multiple stallers:** All members who miss the pass-1 window are excluded **together in one rebuild pass**, deterministic from the timeout snapshot. Preserves the two-pass worst case.
- **D-03 Pass-2 stall:** If anyone stalls during pass 2, the round attempt **aborts cleanly** (nothing settles); the next round starts a fresh pass 1. Hard cap: **2 signature-collection passes per attempt**.
- **D-04 Re-inclusion:** Excluded members are **always back in the candidate set** for the next round (candidate set = everyone with open IOUs). No backoff, no coordinator discretion. Griefing cost stays pure latency.

**Consent window mechanics**
- **D-05 Timeout config:** One wall-clock consent-window duration as a **coordinator-level default with per-round override** (demo-scale default like 30s; ms-scale in tests).
- **D-06 Miss tracking:** Coordinator tracks a **per-member consecutive missed-window counter now** (reset on any successful consent) — Phase 2's `redeemIOU` flagging ("missed K consecutive windows") reads this directly.
- **D-07 Miss semantics:** **Only timeouts count as misses.** An explicit reasoned refusal (`verifyProposal` fails on the member's local view) excludes them from the round but does NOT advance the miss counter — refusal is the safety mechanism working, not unresponsiveness.
- **D-08 Deadline placement:** The consent deadline is **out-of-band coordinator metadata**, NOT part of the EIP-712 Round struct. Digest, contract interface, and fixtures stay unchanged (CONS-06). *(Auto-selected recommended option at user's request.)*

**ClearingHubV2 contract scope** *(All auto-selected recommended options at user's request.)*
- **D-09 Contract diff:** `ClearingHubV2.sol` is a **near-verbatim copy** of `ClearingHub.sol` — new contract name, updated NatSpec/version marker, execution path unchanged. No new external functions.
- **D-10 No exclusion events:** No new on-chain events. Exclusions are off-chain rebuilds by design; the submitted round looks like any unanimous round to the contract.
- **D-11 EIP-712 domain:** Domain name/version **unchanged from v1** — domain separation already comes from `verifyingContract`. No new signed structs → no new fixture obligation (existing digest-parity fixtures must still pass against V2).
- **D-12 Deployment:** Deploy **fresh V2 hubs (USDC + EURC) on Arc Testnet at the end of this phase**; v1 hubs stay live as Arclear Net v1. Explicit gas limits on all writes (Arc gas-token gotcha).

**Failure simulation & demo visibility** *(All auto-selected recommended options at user's request.)*
- **D-13 Injection:** Unresponsiveness is injected via a **per-agent stall toggle** (dashboard/API-settable), also scripted in e2e. Refusal-for-cause remains a separate, distinguishable behavior.
- **D-14 Visibility:** Coordinator round state machine gains explicit rebuild phases (e.g. `collecting-consents` → `rebuilding` → `collecting-consents-pass-2`); `ExecutedRound` records excluded members and pass count; dashboard surfaces exclusion rounds in round history.
- **D-15 E2E scenario:** Extend the existing e2e with the canonical liveness scenario: agent stalls → round rebuilds and settles without them → their IOUs settle cleanly next round (CONS-04) → same IOU can never settle twice.
- **D-16 Griefing doc:** The griefing analysis (repeated refusal = repeated rebuild latency, worst case two passes, never a safety cost) lands as a **threshold-consent section in `docs/PROTOCOL.md`** (CONS-05).

### Claude's Discretion
- Exact TS shape of the rebuild API in `src/round.ts` (pure function over {proposal, consenting subset, open IOUs} — keep the pure-core pattern)
- Exact default timeout values for demo vs tests
- Naming of new coordinator phases and state fields
- Whether stall toggle is exposed as an HTTP endpoint, dashboard button, or both

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope. (Miss-counter tracking (D-06) is deliberately forward-compatible groundwork for Phase 2's flagging, not scope creep — it's coordinator state only.)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CONS-01 | Coordinator proposes over a candidate set and collects consents within a timeout window | Pattern 2 (consent-collection seam with `Promise.race` deadline + per-agent stall toggle); coordinator state machine (Pattern 3) |
| CONS-02 | On timeout, rebuild from consenting subset: excluded IOUs drop, deltas recompute, final set signs final digest | Pattern 1 (`rebuildProposal` = filter-then-`net()` pure function); `verifyProposal` extension for excluded-set-aware recomputation |
| CONS-03 | Invariant tested: every settled movement signed by its owner over the exact executed position set | Test design §"Invariant test design" — fast-check property over arbitrary stall subsets using `fc.subarray`; on-chain half already enforced by `BadSignature`/strict-ascending checks in the (unchanged) execution path |
| CONS-04 | IOU excluded in round n settles in round n+1; same IOU never settles twice | Falls out of existing `settledIds`/`openIous` mechanics (`demo/coordinator.ts:56`); sequence property test + e2e scenario; expiry pitfall documented (Pitfall 5) |
| CONS-05 | Zero-sum after redistribution; griefing analysis documented | Zero-sum is inherited from `net()` (deltas always sum to 0 for *any* input subset — existing property test generalizes); griefing analysis outline for `docs/PROTOCOL.md` in §"Griefing analysis content" |
| CONS-06 | `ClearingHubV2.sol` execution path mostly unchanged; change lives in SDK/coordinator | Pattern 4 (near-verbatim copy checklist); DigestParity-vs-V2 test via `deployCodeTo("ClearingHubV2.sol:ClearingHubV2", …)` against the *same* fixture (Pitfall 1) |
</phase_requirements>

## Summary

This phase is **pure internal architecture on a frozen stack** — no new dependencies, no new signed structs, no contract-interface change. The research question is therefore not "which library" but "where each responsibility lives and which invariants the tests must pin." All findings below are grounded in direct codebase reads; the only external verification needed was the fast-check API for subset generation (`fc.subarray`, confirmed via Context7 against official docs).

Three insights shape the plan. First, **the rebuild is not new math**: `net()` (`src/netting.ts`) is already a pure deterministic function, so "rebuild from the consenting subset" is literally `net(openIous filtered to drop every IOU touching an excluded member)` — the SDK change is a thin pure function plus an excluded-set-aware extension of `verifyProposal` (participants must apply the same filter locally or their recomputed delta won't match, which is the zero-trust property working as designed). The excluded set travels as out-of-band metadata next to the proposal, exactly like the deadline (D-08). Second, **the timeout needs a simulation seam**: today `Coordinator.runRound` signs for all personas synchronously in-process (`demo/coordinator.ts:73-89`), so "a member stalls" must be modeled as a per-member consent provider that can return consent, reasoned refusal, or never resolve — the coordinator races providers against a wall-clock deadline and snapshots responders deterministically (D-02). Third, **the V2 contract's only real risk is fixture drift**: because the EIP-712 domain string, `ROUND_TYPEHASH`, and execution path are all byte-identical and `verifyingContract` is the fixture's pinned address, deploying `ClearingHubV2` at the fixture address via `deployCodeTo` must reproduce the existing `digest.json` digest exactly — that single Foundry test proves D-11 with zero fixture regeneration.

**Primary recommendation:** Build in four seams — (1) pure `rebuildProposal`/extended `verifyProposal` in `src/round.ts`, (2) consent-provider abstraction + two-pass state machine in `demo/coordinator.ts`, (3) `ClearingHubV2.sol` copy with a same-fixture parity test, (4) deploy + docs — and write the fast-check invariants (arbitrary stall subsets) before wiring the demo.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Round rebuild (exclude & recompute) | SDK pure core (`src/round.ts` + `src/netting.ts`) | — | Must be independently recomputable by every participant; zero-trust requires a pure function, not coordinator state |
| Participant re-verification of a rebuilt proposal | SDK pure core (`src/round.ts:verifyProposal`) | — | Same function, new `excluded` opt; refusal-with-reason stays `{ok, reason}` |
| Consent window / timeout / two-pass state machine | Demo coordinator (`demo/coordinator.ts`) | — | Wall-clock and liveness policy are coordinator concerns; coordinator holds no keys, so this is safe to keep impure |
| Miss-counter tracking (D-06) | Demo coordinator | — | Coordinator-local state only; Phase 2 reads it — not protocol, not on-chain |
| Stall injection & toggle | Demo server/agents (`demo/server.ts`, `demo/agents.ts`) | Dashboard (`public/dashboard.html`) | Failure simulation is a demo concern, distinguishable from refusal-for-cause (D-13) |
| Settlement enforcement (sigs, zero-sum, coverage) | Contract (`contracts/src/ClearingHubV2.sol`) | — | Unchanged execution path (D-09); the submitted round looks unanimous to the chain (D-10) |
| Digest parity TS↔Solidity | Contracts test + fixture chain (`contracts/test/`, `test/genFixture.ts`) | — | Existing fixture must pass against V2 (D-11); no regeneration |
| V2 deployment (USDC + EURC) | Foundry script (`contracts/script/`) + README/.env.example | — | End-of-phase Arc testnet deploys (D-12), Blockscout verification |
| Griefing analysis | Docs (`docs/PROTOCOL.md`) | `docs/THREAT-MODEL.md` consistency | D-16; must stay consistent with existing threat rows 7 (grief by refusing) |

## Standard Stack

### Core (unchanged — no installs this phase)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| viem | 2.55.5 installed (`^2.21.0` declared) | EIP-712 signing, clients | Sole runtime dep, fixed by project constraints [VERIFIED: package.json + CLAUDE.md] |
| fast-check | ^3.22.0 | Property/invariant tests | Already used for netting invariants; `fc.subarray` covers stall-subset generation [CITED: fast-check docs via Context7, core-blocks/arbitraries/combiners/constant] |
| vitest | ^2.1.0 | TS test runner | Existing (`vitest.config.ts`) [VERIFIED: package.json] |
| Foundry (forge/anvil/cast) | forge 1.3.5-stable local | Solidity build/test/deploy; `deployCodeTo` cheatcode already used in `DigestParity.t.sol` | Fixed toolchain [VERIFIED: `forge --version` this session] |
| OpenZeppelin Contracts | 5.6.1 vendored | EIP712, ECDSA, Ownable2Step, Pausable, ReentrancyGuard | Vendored at `contracts/lib/` [VERIFIED: codebase] |
| tsx | ^4.19.0 | Script execution | Existing [VERIFIED: package.json] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `Promise.race` + `setTimeout` for the consent deadline | A timer/scheduler library | Rejected — zero-dependency constraint; Node built-ins suffice. Clear/`unref()` the deadline timer so pending stalled promises never hold the process open |
| Per-member consent-provider seam | fast-check `fc.scheduler`/`fc.commands` model-based async testing | `fc.commands` exists [CITED: fast-check docs via Context7] but is overkill: the state machine has a hard 2-pass cap and deterministic snapshot; plain `fc.property` over (IOUs × stalled subset × refusal subset) covers the space with better shrinking |

**Installation:** none — `npm install` of existing lockfile only.

## Package Legitimacy Audit

**No new packages are installed in this phase.** All work uses dependencies already present in `package.json` / `contracts/lib/` (vendored git submodules). slopcheck was not run because there is nothing to check.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram (two-pass round attempt)

```
IOUs (signed, off-chain)
        │
        ▼
Coordinator: net(openIous) ──► buildProposal (pass-1, candidate set)
        │
        ▼
collectConsents(proposal, members, providers, windowMs)   ◄── per-agent stall toggle (demo seam)
        │ race each provider vs. deadline; snapshot at timeout
        ├── all consented ──────────────────────────────► submit executeRound (1 pass)
        │
        ├── some timed out (miss++) / refused (no miss) 
        ▼
excluded = timeouts ∪ refusals  (D-02: one batch, deterministic snapshot)
        │
        ▼
rebuildProposal: filter openIous (drop every IOU touching excluded) ──► net() ──► buildProposal (pass-2, SAME roundNonce)
        │  quorum check: <2 participants ⇒ abort attempt
        ▼
collectConsents (pass-2; every final-set member re-verifies w/ excluded list + re-signs new digest)
        │
        ├── any stall/refusal ──► abort attempt cleanly (D-03); next round = fresh pass 1
        ▼
executeRound(nonce, participants, deltas, manifestHash, sigs)  ── ClearingHubV2 (unchanged checks:
        │                                                          nonce, ascending, N sigs over digest,
        ▼                                                          zero-sum, coverage — atomic)
settledIds += consumedIds; excluded members' IOUs stay open ──► candidate set next round (D-04)
```

### Recommended Project Structure (files touched/added)

```
src/
├── round.ts              # + rebuildProposal(); verifyProposal gains `excluded` opt
├── types.ts              # + RebuildInput/ConsentOutcome types if exported; ExecutedRound stays in demo
├── abi/ClearingHubV2.ts  # NEW: abi + bytecode module (anvil deploys V2)
contracts/
├── src/ClearingHubV2.sol         # NEW: near-verbatim copy (D-09)
├── test/ClearingHubV2.t.sol      # NEW: smoke + digest-parity-vs-V2 (reuses fixture)
├── script/DeployV2.s.sol         # NEW (or extend Deploy.s.sol): deploys ClearingHubV2
demo/
├── coordinator.ts        # two-pass state machine, miss counters, consent providers
├── agents.ts             # + stalled flag on persona (or a parallel stall registry)
├── server.ts             # + stall-toggle endpoint; /state exposes stall + exclusion info
├── e2e.ts                # + liveness scenario (D-15)
public/dashboard.html     # stall toggle + exclusion-round display
test/
├── rebuild.test.ts       # NEW: CONS-02/03/04/05 property tests
docs/PROTOCOL.md          # + threshold-consent section incl. griefing analysis (D-16)
docs/THREAT-MODEL.md      # update rows 7 / limitations table (v2 answer now shipped)
```

### Pattern 1: Pure rebuild in `src/round.ts` (CONS-02)

**What:** Rebuild = filter + existing `net()` + existing `buildProposal`. No new netting math.
**When to use:** After the pass-1 timeout snapshot fixes the excluded set.

```typescript
// Shape (Claude's discretion per CONTEXT, but keep the pure-core pattern):
/** Drop every IOU touching an excluded member, re-net, re-propose. Pure. */
export function rebuildProposal(
  hub: Address,
  roundNonce: bigint,          // SAME nonce as pass 1 — nothing executed
  openIous: SignedIou[],
  excluded: Address[],         // timeout ∪ refusal snapshot, out-of-band metadata
  opts: { now: bigint; safetyWindowSeconds?: bigint; settledIds?: ReadonlySet<Hex>; chainId?: number },
): { proposal: RoundProposal; result: NetResult } {
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  const kept = openIous.filter(
    (s) => !ex.has(s.iou.debtor.toLowerCase()) && !ex.has(s.iou.creditor.toLowerCase()),
  );
  const result = net(kept, opts);
  return { proposal: buildProposal(hub, roundNonce, result, opts.chainId), result };
}
```

**Critical detail — `verifyProposal` must apply the same filter.** A pass-2 verifier recomputes `net(myIous)`; without the exclusion filter their local delta differs from the proposal and they'd (correctly) refuse. Extend the opts: `excluded?: Address[]`, filter `myIous` before `net()`, and additionally check (a) self is not in `excluded`, (b) no excluded address appears in `proposal.participants`. The digest/struct is untouched — the excluded list is metadata the participant folds into their *local* recomputation, preserving zero-trust (any coordinator lie about the excluded set produces a delta mismatch or a bad digest).

**Cascade note:** filtering can remove *more* than the excluded members — a pass-1 consenter whose only IOUs touched an excluded member drops out of the pass-2 set entirely (rule 6: no consumed IOUs → not in round). That is correct behavior: their paper stays open, they are not "excluded" for miss-counter purposes, and they simply aren't asked to sign pass 2.

### Pattern 2: Consent-provider seam (CONS-01, D-13)

**What:** Abstract "ask member X to consent" behind a per-member async provider so a stall is a promise that never resolves and a refusal is a value, not an exception.

```typescript
type ConsentOutcome =
  | { kind: "consent"; signature: Hex }
  | { kind: "refusal"; reason: string };   // verifyProposal said no — safety working (D-07)
// timeout is NOT an outcome the provider returns; it's the coordinator's deadline firing

type ConsentProvider = (proposal: RoundProposal, excluded: Address[]) => Promise<ConsentOutcome>;

async function collectConsents(
  proposal: RoundProposal,
  members: Address[],                       // proposal.participants
  providers: Map<string, ConsentProvider>,  // lowercase addr -> provider
  windowMs: number,
): Promise<{
  consents: Map<string, Hex>;
  refused: { address: Address; reason: string }[];
  timedOut: Address[];                      // deterministic deadline snapshot (D-02)
}> { /* Promise.race each provider vs. one shared deadline; clearTimeout on completion */ }
```

Demo wiring: the default provider runs `verifyProposal` + `signConsent` in-process (today's behavior); a **stalled** persona's provider returns `new Promise(() => {})`. In tests, providers are injected directly — ms-scale windows (e.g. 20–50ms) or, for the pure state-machine properties, resolve/never-resolve promises with a ~10ms window. Clear (or `unref()`) the deadline timer so e2e exits cleanly.

**Miss-counter rules (D-06/D-07), stated precisely:** timeout → `missed[addr]++`; successful consent → `missed[addr] = 0`; refusal → counter *unchanged* (neither increment nor reset).

### Pattern 3: Coordinator two-pass state machine (D-14)

**What:** `runRound` becomes: net → propose → collect (pass 1) → [all consented → submit] | [rebuild → collect (pass 2) → all consented → submit | abort]. New `RoundPhase` values, e.g. `"collecting-consents" | "rebuilding" | "collecting-consents-pass-2" | "aborted"` (naming is discretion). `ExecutedRound` gains `excluded: string[]` and `passCount: 1 | 2`. Abort (pass-2 stall, or post-rebuild quorum < 2 per D-01) sets a distinct terminal state with no throw-into-500 semantics change for `/round` — return a structured "aborted" result rather than an error, so the dashboard can display it. Pass-1 signatures are **never reusable** for pass 2 (different digest — deltas and manifest changed); every final-set member re-verifies and re-signs.

### Pattern 4: ClearingHubV2 copy checklist (D-09/D-10/D-11, CONS-06)

Byte-level discipline for the copy:
1. New file `contracts/src/ClearingHubV2.sol`, `contract ClearingHubV2` — same pragma `0.8.26`, same imports.
2. **Keep identical:** `EIP712("ArcClearingHub", "1")` constructor args, `ROUND_TYPEHASH` string, every custom error, every event, function signatures, `withdraw` never-pausable, all checks in `executeRound`/`hashRound`.
3. **Change only:** contract name, NatSpec `@title`/version marker noting "Arclear Net v2 — threshold-consent protocol lives off-chain; execution path identical to v1".
4. Parity proof: a new Foundry test that reads the **same** `test/fixtures/digest.json` and does `deployCodeTo("ClearingHubV2.sol:ClearingHubV2", abi.encode(address(usdc)), hubAddr)` then asserts `hashRound(...) == expectedDigest` and `ECDSA.recover(digest, consent0) == signer0` — mirroring `DigestParity.t.sol:29-38`. This passes because the domain separator depends only on name/version/chainId/verifyingContract, all pinned by the fixture. **No fixture regeneration** (no new signed structs).
5. Optional: light V2 unit smoke (deposit/round/replay) — `RoundBuilder._digest` already hardcodes the domain strings and uses `address(hub)`, so a V2 variant only needs the hub instance swapped; consider parameterizing `RoundBuilder` by address rather than duplicating.

### Anti-Patterns to Avoid

- **Reusing pass-1 signatures on the pass-2 digest:** impossible on-chain (`BadSignature`) but a coordinator bug would waste a round attempt; always re-collect.
- **Putting the deadline or excluded set into the signed struct:** violates D-08/D-11 and breaks fixtures; both are out-of-band metadata folded into local recomputation.
- **Treating refusal as an exception:** current `runRound` throws on first refusal (`demo/coordinator.ts:85`); v2 must treat refusal as data (exclude, don't count a miss, continue).
- **Outvote semantics leaking in:** never submit with fewer signatures than `participants.length`; the contract enforces this, but the coordinator must never *try*.
- **New threshold parameter:** D-01 fixes quorum = the existing ≥2-participant floor; don't invent a configurable k.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Rebuild netting math | A "subtract excluded deltas" adjuster | Filter IOUs + existing `net()` | Redistribution is not linear (rule 6 membership changes, cycles re-form); re-running the pure engine is the only correct + independently verifiable path |
| Pass-2 digest | Manual keccak assembly | Existing `buildProposal`/`roundDigest` | Digest parity with Solidity is already locked by fixtures |
| Signature verify | Custom ecrecover paths | viem `verifyTypedData` (TS), OZ `ECDSA` (Sol) — both already in use | Malleability and EIP-712 encoding edge cases |
| Stall-subset test generation | Hand-written subset loops | `fc.subarray(members, { maxLength: n - 2 })` | Shrinking + coverage for free [CITED: fast-check docs via Context7] |
| Timeout plumbing | An async scheduler lib | `Promise.race` + `setTimeout` (cleared/unref'd) | Zero-dependency constraint; two-pass cap keeps the state machine trivially small |

**Key insight:** every "new" computation in this phase is a composition of already-fixture-locked primitives. The moment something can't be expressed as filter → `net()` → `buildProposal`, it's probably violating a locked decision.

## Common Pitfalls

### Pitfall 1: V2 parity test deploys the wrong artifact string
**What goes wrong:** `deployCodeTo` takes the artifact path string; `"ClearingHubV2.sol:ClearingHubV2"` must match the forge `out/` layout or the test reverts confusingly.
**Why it happens:** artifact naming is by source file + contract name.
**How to avoid:** mirror `DigestParity.t.sol:31` exactly with the new names; run `forge build` first.
**Warning signs:** `deployCodeTo` revert / empty code at target address.

### Pitfall 2: Anvil demo still deploys v1 bytecode
**What goes wrong:** `demo/setup.ts:97-99` deploys from `clearingHubBytecode` in `src/abi/ClearingHub.ts` — a hand-assembled TS module (abi + bytecode from forge out). If a `ClearingHubV2` module isn't generated, the demo/e2e "V2" run silently exercises v1 bytecode.
**Why it happens:** the npm `abi` script only copies JSON; the `.ts` module is maintained manually.
**How to avoid:** add `src/abi/ClearingHubV2.ts` (abi is identical to v1 since no interface change; bytecode differs by name/metadata) and point `setupAnvil` at it. The ABI-identical fact also means `HubClient` needs no changes — only the address/bytecode source.
**Warning signs:** e2e passes but arcscan/anvil code hash matches v1.

### Pitfall 3: Stalled-provider promises keep the process alive or leak across rounds
**What goes wrong:** a never-resolving promise plus an uncleared `setTimeout` deadline keeps Node's event loop alive; e2e hangs at exit. Worse, a *late* consent arriving after the snapshot could mutate pass-2 state if the collector isn't snapshot-then-ignore.
**Why it happens:** `Promise.race` doesn't cancel losers.
**How to avoid:** one shared deadline timer per pass, `clearTimeout` when all resolve early, `timer.unref()` as belt-and-braces; after the deadline fires, take an immutable snapshot (D-02) and ignore any later resolutions (guard with a `settled` flag). e2e already calls `process.exit(0)` (`demo/e2e.ts:74`) which masks this today — don't rely on it in tests.
**Warning signs:** vitest "hanging process" warnings; flaky pass-2 membership under load.

### Pitfall 4: Pass 2 must reuse the SAME `roundNonce`
**What goes wrong:** re-reading `hubClient.roundNonce()` between passes is fine (nothing executed), but *caching assumptions* or incrementing locally produces `WrongRoundNonce` reverts; conversely, if a concurrent round executed in between (permissionless `executeRound`), the pass-2 digest is stale and the round must abort/restart.
**How to avoid:** build pass-2 proposal with the pass-1 nonce; treat a `WrongRoundNonce` revert as a clean abort → fresh pass 1 next round.
**Warning signs:** `WrongRoundNonce(expected, provided)` in e2e logs.

### Pitfall 5: Excluded IOUs expire before round n+1
**What goes wrong:** CONS-04's "settles cleanly next round" fails if the excluded IOU's `expiry <= now + 60s safetyWindow` by the time round n+1 runs (rule 2 drops it silently).
**How to avoid:** demo/e2e IOUs already use far-future expiries; in the CONS-04 sequence test, pin `expiry` comfortably beyond both rounds; document in PROTOCOL.md that exclusion consumes wall-clock against expiry.
**Warning signs:** round n+1 manifest missing the previously excluded id with no error anywhere.

### Pitfall 6: `/round` HTTP semantics for aborts
**What goes wrong:** today any `runRound` failure becomes a thrown error → HTTP 500 (`demo/server.ts:107-111`). A pass-2 abort is *expected protocol behavior*, not an error; surfacing it as 500 breaks the dashboard exclusion-round display (D-14).
**How to avoid:** return a structured result (e.g. `{ outcome: "settled" | "aborted", ... }`) from `runRound`; keep 500 for genuine faults.

### Pitfall 7: Arc gas-token gotcha on fresh V2 deploys and demo writes
**What goes wrong:** letting gas estimation run unbounded on Arc reserves the whole USDC balance (native token == ERC-20 at `0x3600…0000`) and token transfers revert in simulation.
**How to avoid:** carry the existing discipline: `--with-gas-price 25gwei` on `forge script`, `maxFeePerGas: MIN_MAX_FEE_PER_GAS` + explicit `gas` on every viem write (`src/client.ts` already does this: 200k deposit/withdraw, 1.5M executeRound). [VERIFIED: codebase — README, `demo/setup.ts:49-55`, `.planning/PROJECT.md`]
**Warning signs:** "transfer amount exceeds balance" in simulation with plenty of balance.

### Pitfall 8: Griefing analysis contradicting THREAT-MODEL.md
**What goes wrong:** `docs/THREAT-MODEL.md` row 7 and the limitations table already frame refusal-griefing and the v2 answer; a PROTOCOL.md section that redefines terms (e.g. calling refusal a "miss") creates spec drift — especially against D-07's refusal≠miss distinction.
**How to avoid:** write the PROTOCOL.md section to *supersede* the "No threshold consent" non-goal bullet (`docs/PROTOCOL.md:127-128`) and update THREAT-MODEL.md's limitations row from "v2 answer" to "shipped"; keep the exact brief phrasing: "worst case is two signature-collection passes: a latency cost, never a safety cost."

## Invariant Test Design (CONS-03 / CONS-05)

All in a new `test/rebuild.test.ts` (vitest + fast-check), reusing `fakeIou`/`arbIous` patterns from `test/netting.test.ts`:

1. **Zero-sum after redistribution (CONS-05):** for arbitrary `ious` and arbitrary `excluded = fc.subarray(ADDRS)`, `rebuildProposal(...).result.deltas` sums to `0n`. (Strictly implied by the existing `net()` zero-sum property — any filtered input is still an input — but assert it against the *rebuild path* explicitly.)
2. **Exclusion completeness:** no excluded address appears in rebuilt `participants`; no consumed id in the rebuilt manifest corresponds to an IOU touching an excluded member (test IOUs are locally constructed, so ids are mappable back to parties).
3. **CONS-03 end-to-end invariant:** drive the two-pass collector with arbitrary IOUs, arbitrary stalled subset (`fc.subarray`), and arbitrary refusal subset; whatever the state machine would submit must satisfy: `signatures.length === participants.length`, every signature verifies (`verifyConsent`) against the *final* digest at the matching index, and every address whose delta ≠ 0 is in the signer set. If it aborts, assert nothing was added to `settledIds`. (On-chain, the same invariant is enforced by the unchanged `executeRound` — strict ascending + per-index `ECDSA.recover` + zero-sum — so the Foundry side needs no new invariant test beyond the V2 parity/smoke tests.)
4. **CONS-04 sequence:** round n with one member stalled → assert their IOU ids ∉ manifest n and still in `openIous`; round n+1 all responsive → ids ∈ manifest n+1; assert `manifest_n ∩ manifest_n+1 = ∅` and `settledIds` growth is disjoint. Also property-test "same IOU never settles twice": across any two executed manifests produced by the machine, consumed-id sets are disjoint (follows from `settledIds` filtering — rule 3).
5. **Determinism of the rebuild:** `rebuildProposal` under input shuffling equals unshuffled (mirrors the existing shuffle-determinism property).
6. **Quorum floor (D-01):** if post-filter `net()` yields <2 participants, the machine aborts; assert no submission attempted.

Griefing analysis content (for `docs/PROTOCOL.md`, D-16 — the tests above are its evidence):
- Cost of a stall: one extra collection pass (bounded latency = 2 × window + rebuild compute); repeated stalling across rounds costs only repeated latency because re-inclusion is unconditional (D-04) and miss counters carry no in-protocol penalty until Phase 2.
- Safety argument: an excluded member's balance cannot move (they're absent from `participants`; the contract requires their signature to move it); a coordinator that lies about exclusions produces delta mismatches that pass-2 verifiers refuse; both a fully-signed pass-1 and pass-2 set are individually unanimous, and the shared `roundNonce` guarantees at most one executes.
- Coordinator-censorship note: a coordinator can *pretend* a member timed out (exclude anyone) — cost to the victim is latency/lost compression only, never funds; mitigation unchanged from v1: anyone can run a coordinator.
- Keep the domain insight line: "in a payments CCP the defaulter's position is a scalar debit in a stable unit."

## Code Examples

### V2 parity test skeleton (mirrors existing, verified pattern)
```solidity
// Source: contracts/test/DigestParity.t.sol (existing, passing) — adapted names only
string memory json = vm.readFile("../test/fixtures/digest.json");
// ... parse identically ...
vm.chainId(chainId);
MockUSDC usdc = new MockUSDC();
deployCodeTo("ClearingHubV2.sol:ClearingHubV2", abi.encode(address(usdc)), hubAddr);
ClearingHubV2 hub = ClearingHubV2(hubAddr);
assertEq(hub.hashRound(nonce_, participants, deltas, manifestHash), expectedDigest,
    "V2 digest diverges from v1 fixture — D-11 violated");
assertEq(ECDSA.recover(expectedDigest, consent0), signer0);
```

### Stall-subset arbitrary
```typescript
// Source: fast-check official docs (fc.subarray), via Context7 /dubzzz/fast-check
const arbStalled = fc.subarray(ADDRS, { maxLength: ADDRS.length - 2 }); // leave quorum possible
fc.assert(
  fc.property(arbIous, arbStalled, (ious, stalled) => {
    const { result } = rebuildProposal(HUB, 0n, ious, stalled, { now: NOW });
    expect(result.deltas.reduce((a, b) => a + b, 0n)).toBe(0n);
    for (const p of result.participants)
      expect(stalled.map((s) => s.toLowerCase())).not.toContain(p.toLowerCase());
  }),
);
```

### Deploy + verify (V2, per token)
```bash
# Source: README.md Quickstart + docs/PLAN.md (worked for v1 deploys) [VERIFIED: repo docs]
TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
forge script contracts/script/DeployV2.s.sol --root contracts \
  --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PK" \
  --broadcast --with-gas-price 25gwei
# then repeat with TOKEN_ADDRESS=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a (EURC)
# verification (Blockscout): [ASSUMED — worked at v1 deploy time, not re-verified this session]
forge verify-contract --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api <address> ClearingHubV2
```
New `.env.example` keys recommended: `HUB_V2_USDC`, `HUB_V2_EURC` (v1 `HUB_USDC`/`HUB_EURC` stay — v1 remains live per D-12); update the README deployed-hubs table.

## State of the Art

| Old Approach (v1) | Current Approach (this phase) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Unanimous consent over candidate set; one refusal/stall throws and aborts | Threshold over candidate set, unanimity over final executed set; two-pass exclude-and-recompute | This phase | Liveness through member failure; safety invariant unchanged |
| `runRound` throws on refusal | Refusal is data (`{ok, reason}` propagated); timeout is a deadline event | This phase | Enables miss-counter semantics (D-06/D-07) |
| PROTOCOL.md non-goal: "No threshold consent" | Threshold-consent section + griefing analysis | This phase | Doc supersession — update non-goals list |

**Deprecated/outdated:** nothing external; v1 hubs explicitly NOT deprecated (stay live as Arclear Net v1).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Blockscout verification via `forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api` still works on arcscan (documented in `docs/PLAN.md`, used for v1; not re-exercised this session) | Code Examples / deployment | Low — deploy still succeeds; verification done manually via explorer UI as fallback |
| A2 | `gas: 1_500_000n` in `src/client.ts:116` remains sufficient for demo-scale V2 rounds (execution path unchanged, same round sizes) | Pitfall 7 | Low at demo scale; STATE.md already flags this as a growing-round-size concern — planner may add a headroom note, not a fix |
| A3 | Deterministic snapshot-then-ignore of late consents is sufficient for D-02 determinism under Node's single-threaded event loop | Pattern 2 / Pitfall 3 | Low — property tests with injected providers will catch ordering bugs |

## Open Questions

1. **Where exactly does the excluded-list metadata live in the pass-2 message?**
   - What we know: D-08 fixes deadline (and by extension exclusion info) as out-of-band; `verifyProposal` needs it to recompute.
   - What's unclear: whether to widen `RoundProposal` (TS-only, digest unchanged) with optional `excluded?: Address[]` or pass it as a separate argument.
   - Recommendation: separate argument / opts field — keep `RoundProposal` exactly mirroring the signed struct + digest + consumedIds to avoid any confusion about what is signed. (Claude's discretion per CONTEXT.)
2. **`RoundBuilder.sol` reuse for V2 contract tests**
   - What we know: `_digest` hardcodes domain strings and `address(hub)`; the harness type-binds `ClearingHub`.
   - Recommendation: parameterize by `address` (or add a tiny V2 harness) rather than duplicating 125 lines; planner picks based on how many V2 unit tests are wanted (parity test alone needs neither).
3. **Whether `collectConsents` lives in `src/` or `demo/`**
   - What we know: it's impure (timers) but protocol-shaped; SDK is currently pure-plus-client.
   - Recommendation: keep it in `demo/coordinator.ts` for this phase (it's coordinator policy); promote to `src/` only if Phase 2/calibration needs it — avoids expanding the public SDK surface with timer semantics.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| forge | contract build/test/deploy | ✓ | 1.3.5-stable | — |
| anvil | local e2e | ✓ | bundled | — |
| cast | ad-hoc chain queries | ✓ | bundled | — |
| node | SDK/tests/demo | ✓ | v24.11.1 | — |
| npm | scripts | ✓ | 11.12.0 | — |
| Arc Testnet RPC + funded `DEPLOYER_PK` | end-of-phase V2 deploys (D-12) | untested this session (`.env` gitignored) | — | anvil for all dev/test; testnet deploy is a final gated step with faucet.circle.com funding |
| `test/fixtures/digest.json` | V2 parity test | ✓ | present | regenerate via `npm run fixture` (deterministic) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** Arc testnet credentials — only needed for the final deploy task; all other work runs locally.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2.1 + fast-check ^3.22 (TS); Foundry forge 1.3.5 (Solidity, 512 fuzz runs) |
| Config file | `vitest.config.ts`; `contracts/foundry.toml` |
| Quick run command | `npx vitest run test/rebuild.test.ts` / `cd contracts && forge test --match-contract ClearingHubV2 -vvv` |
| Full suite command | `npm test && npm run test:contracts` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONS-01 | Timeout window collection, stall → snapshot | unit (fake providers, ms windows) | `npx vitest run test/rebuild.test.ts` | ❌ Wave 0 |
| CONS-02 | Rebuild drops excluded IOUs, recomputes, final set signs final digest | property (fast-check) | `npx vitest run test/rebuild.test.ts` | ❌ Wave 0 |
| CONS-03 | Every settled movement signed over exact executed set | property + existing Foundry revert matrix (unchanged path) | `npx vitest run test/rebuild.test.ts` && `npm run test:contracts` | ❌ Wave 0 (TS) / ✅ (Sol side: `ClearingHub.t.sol` revert matrix carries over) |
| CONS-04 | Excluded IOU settles next round; never twice | sequence unit + e2e | `npx vitest run test/rebuild.test.ts`; `npm run e2e:anvil` (extended scenario) | ❌ Wave 0 / e2e file exists, scenario ❌ |
| CONS-05 | Zero-sum after redistribution; griefing doc | property + manual doc review | `npx vitest run test/rebuild.test.ts`; manual: `docs/PROTOCOL.md` section present | ❌ Wave 0 |
| CONS-06 | V2 execution path unchanged; digest parity holds | Foundry parity test vs existing fixture | `cd contracts && forge test --match-contract DigestParityV2 -vvv` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run test/rebuild.test.ts` (or the touched test file) — < 10s
- **Per wave merge:** `npm test && npm run test:contracts`
- **Phase gate:** full suite green + `npm run e2e:anvil` liveness scenario passing before `/gsd:verify-work`; testnet deploy (D-12) after gate

### Wave 0 Gaps
- [ ] `test/rebuild.test.ts` — covers CONS-01..05 TS-side (framework already installed; reuse `fakeIou` helper pattern from `test/netting.test.ts`)
- [ ] `contracts/test/ClearingHubV2Parity.t.sol` (name flexible) — covers CONS-06 / D-11
- [ ] `src/abi/ClearingHubV2.ts` — required before e2e:anvil can exercise V2 bytecode (Pitfall 2)
- No framework installs needed.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (signature = authentication) | EIP-712 typed-data signatures — viem `signTypedData`/`verifyTypedData`, OZ `ECDSA.recover` (unchanged; never hand-roll) |
| V3 Session Management | no | Stateless protocol; roundNonce is the replay boundary |
| V4 Access Control | yes | Contract: `Ownable2Step` pause only, `withdraw` never pausable (must survive the copy verbatim); coordinator holds no authority |
| V5 Input Validation | yes | Contract validates everything on-chain (lengths, ascending, zero-sum, coverage); SDK `verifyProposal` `{ok, reason}` pattern; no new external input surface except the demo stall endpoint (demo-only, non-custodial) |
| V6 Cryptography | yes | OZ ECDSA (malleability-safe), OZ EIP712 domain separator — vendored 5.6.1, unchanged |

### Known Threat Patterns for this phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Stall to block settlement | DoS | Exclude-and-recompute; bounded to 2 passes; re-inclusion unconditional (D-04) — latency only |
| Coordinator fakes a timeout to censor a member | DoS/Repudiation | Victim's funds can't move without their sig; anyone can run a coordinator; document in griefing analysis |
| Replay pass-1 sigs on pass-2 round | Spoofing/Tampering | Different digest (deltas/manifest changed); `BadSignature` on-chain; coordinator never mixes passes |
| Both passes fully signed, relayer picks one | Tampering | Both are individually unanimous → either is safe; shared `roundNonce` ensures at most one executes — state this explicitly in PROTOCOL.md |
| Double-settle an excluded IOU | Tampering | `settledIds` filter (rule 3) + manifest provability; CONS-04 tests |
| Miss-counter inflation by malicious coordinator | Elevation (future) | Counter is coordinator-local with no protocol effect until Phase 2 — flag as a Phase 2 design input, not a current risk |
| Copy drift in ClearingHubV2 (e.g. accidentally pausable withdraw) | Tampering | Pattern 4 checklist + parity test + diff review of V2 vs v1 in code review |

## Project Constraints (from CLAUDE.md)

- Foundry (`via_ir = true`) + viem-only SDK + npm/tsx/vitest/fast-check; zero-framework dashboard — fixed
- **No division anywhere in protocol math** — bigint/int256 base units only (rebuild = filter + re-net satisfies this trivially)
- `ClearingHub.sol` interface unchanged where touched; v1 stays live
- Withdrawal never pausable; coordinator holds no keys/authority
- Shared TS↔Solidity digest fixtures for every new signed struct (none added this phase → obligation is *re-proving* existing fixtures against V2)
- Explicit gas limits on all Arc writes (`maxFeePerGas: MIN_MAX_FEE_PER_GAS` + `gas` on every write)
- Conventions: `{ok, reason}` validation returns (never throw from verify fns); custom Solidity errors only; NatSpec density on every external function; named exports only; `camelCase.ts` modules; test files `<subject>.test.ts` under `test/`, `<Contract>.t.sol` under `contracts/test/`; `src/index.ts` flat barrel in dependency order
- No linter — `tsc --noEmit` strict mode is the correctness gate

## Sources

### Primary (HIGH confidence)
- Codebase reads this session: `src/round.ts`, `src/netting.ts`, `src/types.ts`, `src/domain.ts`, `src/client.ts`, `src/abi/ClearingHub.ts`, `demo/coordinator.ts`, `demo/server.ts`, `demo/setup.ts`, `demo/agents.ts`, `demo/e2e.ts`, `contracts/src/ClearingHub.sol`, `contracts/test/DigestParity.t.sol`, `contracts/test/utils/RoundBuilder.sol`, `contracts/script/Deploy.s.sol`, `contracts/foundry.toml`, `test/genFixture.ts`, `test/netting.test.ts`, `package.json`, `README.md`
- Repo design docs: `docs/V2-BRIEF.md` §3 Phase 0, `docs/PROTOCOL.md`, `docs/THREAT-MODEL.md`, `.planning/PROJECT.md`
- Context7 `/dubzzz/fast-check` — `fc.subarray` (options, ordering semantics), `fc.property`/`fc.pre`, `fc.commands` (considered, not used)
- Toolchain probes: `forge --version` (1.3.5-stable), `node --version` (v24.11.1), anvil/cast present

### Secondary (MEDIUM confidence)
- `docs/PLAN.md` — Blockscout verify command (`--verifier blockscout --verifier-url https://testnet.arcscan.app/api`); repo-documented and used for v1, not re-exercised this session

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; versions read from lockfile/binaries this session
- Architecture: HIGH — every pattern composes existing, fixture-locked primitives; the one genuinely new mechanism (consent-provider seam) uses only Node built-ins
- Pitfalls: HIGH for codebase-derived (1–6, 8); MEDIUM for A1/A2 deployment-adjacent items (flagged in Assumptions Log)

**Research date:** 2026-07-22
**Valid until:** ~2026-08-21 (stable domain; only external moving part is Arc testnet infra/verifier)
