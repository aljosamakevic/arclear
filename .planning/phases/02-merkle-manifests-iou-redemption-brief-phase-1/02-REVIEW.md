---
phase: 02-merkle-manifests-iou-redemption-brief-phase-1
reviewed: 2026-07-24T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - src/merkle.ts
  - contracts/src/lib/ManifestMerkle.sol
  - contracts/src/ClearingHubV2.sol
  - contracts/test/ClearingHubV2.t.sol
  - contracts/test/utils/RoundBuilderV2.sol
  - contracts/test/MerkleParity.t.sol
  - contracts/script/DeployV2.s.sol
  - src/round.ts
  - src/client.ts
  - src/iou.ts
  - src/netting.ts
  - src/abi/ClearingHubV2.ts
  - demo/coordinator.ts
  - demo/setup.ts
  - demo/e2e.ts
  - test/genFixture.ts
  - docs/PROTOCOL.md
  - docs/THREAT-MODEL.md
findings:
  critical: 0
  warning: 2
  info: 4
  total: 6
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-07-24
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Reviewed the merkle-manifest + on-chain IOU-redemption slice of Arclear v2:
the dual TS/Solidity sorted-leaf merkle implementation, the `ClearingHubV2`
redemption gate, the SDK client/round/netting changes, and the demo
coordinator/e2e wiring.

The core cryptographic and settlement logic is strong. I traced every
load-bearing invariant against its spec and could not break any of them:

- **TS↔Solidity merkle byte-parity** — leaf `keccak256(0x00‖id)`, node
  `keccak256(0x01‖left‖right)`, lone-node promotion, ceil-halving width
  schedule, and the `keccak256("")`/`keccak256("0x")` empty sentinel all agree
  between `src/merkle.ts` and `ManifestMerkle.sol`, and the in-place Solidity
  build writes index `j` only after reading `2j/2j+1`, so no early overwrite.
- **redeemIOU gate order** matches the spec exactly (trivia → staleness →
  L-bounded coverage → sig → nullifier → contract-derived positional
  non-inclusion proofs → effects), with the nullifier check preceding proof
  work so idempotent replays revert `AlreadyRedeemed` without touching balances.
- **Ring-buffer coverage math** is sound: with monotonic single-writer-per-slot
  semantics, `rootRing[(nonce_-RING)%RING]` always holds the oldest buffered
  round, and the strict `oldestExecutedAt < expiry−L` window (with the
  `expiry ≤ L` fail-closed underflow branch) correctly guarantees every
  possibly-consuming round is still buffered for honest signers.
- **Exclusivity both directions** — `NullifiedIdInManifest` in `executeRound`
  and structural non-inclusion impossibility for consumed leaves — holds.
- **withdraw never pausable**, **no division in protocol math**, **`{ok,reason}`
  verify returns**, and **explicit measured gas on all writes** are all honored.

`npx tsc --noEmit` passes clean. No blockers were found: nothing here requires
a change to the already-deployed contract. The findings below are integration-
and reference-implementation robustness concerns in the off-chain SDK/demo
layer, plus documentation-grade hardening notes.

## Warnings

### WR-01: Reference coordinator omits `pendingConsumedIds`, leaving the WR-06 double-settle guard half-wired

**File:** `demo/coordinator.ts:496-512` (provider), consuming `src/round.ts:119-156`
**Issue:** `verifyProposal` documents a two-part double-consent defense: callers
MUST pass both `expectedRoundNonce` AND `pendingConsumedIds` (the union of
consumed ids across their outstanding, unconfirmed consents) to refuse a
proposal that overlaps paper they have already signed for at a different nonce.
The demo coordinator — which `CLAUDE.md` designates the *reference*
implementation of a coordinator — passes only `expectedRoundNonce`. It never
supplies `pendingConsumedIds`, so the overlapping-paper branch
(`src/round.ts:145-156`) is dead in practice. The demo itself is safe because
it is single-threaded and `reconcilePendingSubmission` blocks a new round while
one is in flight, but an integrator who copies this reference for a concurrent
coordinator inherits a real double-settle hazard the SDK explicitly warns
about.
**Fix:** Track outstanding signed-but-unconfirmed consents and thread their
consumed-id union into each provider's `verifyProposal` call, e.g.:
```ts
const pendingConsumedIds = new Set<Hex>(
  this.pendingSubmission?.consumedIds.map((id) => id.toLowerCase() as Hex),
);
// ...inside the provider:
verifyProposal(this.hub, proposal, openIous, persona.account.address, {
  now, settledIds: this.settledIds, redeemedIds: this.redeemedIds,
  excluded, chainId: this.chainId,
  expectedRoundNonce: roundNonce,
  pendingConsumedIds,
});
```
Alternatively, document in-code that the demo relies on its sequential
single-round invariant and that production integrators must supply
`pendingConsumedIds`.

### WR-02: `reconcilePendingSubmission` decodes V2 `RoundExecuted` events through the v1 `clearingHubAbi`

**File:** `demo/coordinator.ts:430` (v1 abi) vs `demo/coordinator.ts:399` (v2 abi)
**Issue:** `reconcileRedeemedIds` reads `IouRedeemed` via `clearingHubV2Abi`,
but `reconcilePendingSubmission` reads `RoundExecuted` via the v1
`clearingHubAbi`. This works today only because the v1 and v2 `RoundExecuted`
event signatures are byte-identical (`RoundExecuted(uint64,bytes32,bytes32,uint256,uint256)`),
so the topic0 filter and `args.roundHash` decode both match. It is a silent
coupling: any future divergence in the V2 event (added/reordered field) would
make this reconciliation silently match zero logs, and the "was our round
mined?" check would wrongly conclude the round did not execute — re-netting and
potentially re-submitting the same paper (the exact CONS-04 hazard WR-01 in the
codebase's own numbering is meant to prevent).
**Fix:** Use `clearingHubV2Abi` for the `RoundExecuted` query in
`reconcilePendingSubmission` so both reconcilers bind to the actual deployed
contract's ABI:
```ts
const logs = await this.pub.getContractEvents({
  address: this.hub,
  abi: clearingHubV2Abi, // was: clearingHubAbi
  eventName: "RoundExecuted",
  args: { roundNonce: pending.roundNonce },
  fromBlock: pending.sentAtBlock,
});
```

## Info

### IN-01: Coverage and proof-loop reads trust ring-slot occupancy without asserting the stored nonce

**File:** `contracts/src/ClearingHubV2.sol:339,361`
**Issue:** Both `rootRing[(nonce_-RING)%RING].executedAt` (coverage) and
`rootRing[bufferedNonce % RING].root` (proof loop) rely on the invariant that
each slot currently holds the round whose nonce maps to it. The invariant holds
(monotonic nonce, single writer per slot, round `nonce_` not yet written during
`redeemIOU`), so this is correct as written — but the stored `StoredRoot.nonce`
field is never checked against the expected buffered nonce, so the safety of
the read is implicit rather than defended. NOTE: this is on the already-deployed
contract; treat as a documentation/hardening note only, not a change request.
**Fix (future revision only):** In a later contract version, assert
`rootRing[slot].nonce == bufferedNonce` as belt-and-suspenders defense-in-depth,
matching the "defense in depth beyond signature binding" posture used elsewhere.

### IN-02: SDK `verifyNonInclusion` accepts any id under a caller-supplied empty-root sentinel

**File:** `src/merkle.ts:244`
**Issue:** `verifyNonInclusion` short-circuits to `{ ok: true }` whenever the
supplied `root` equals `EMPTY_MANIFEST_ROOT`. In-protocol this is safe because
`redeemIOU` sources the root from on-chain `rootRing`, never attacker input. But
as an exported SDK primitive, an external caller who passes the sentinel with a
non-empty real manifest would get a false "absent" for a member id — a footgun
for integrators building their own verification flows.
**Fix:** Document on the function that `root` MUST be an authenticated on-chain
root, or optionally accept the expected `leafCount`/manifest and refuse the
sentinel path when the manifest is known non-empty.

### IN-03: `fetchManifest` assumes a top-level EOA `executeRound` call

**File:** `src/client.ts:156-173`
**Issue:** `fetchManifest` fetches the emitting transaction and runs
`decodeFunctionData({ abi: clearingHubV2Abi, data: tx.input })`, assuming
`tx.input` is the hub's `executeRound` calldata. This holds for the demo's EOA
relayer. If a round were ever relayed via a smart-contract wallet or multicall,
`tx.input` would be the wrapper's calldata; `decodeFunctionData` would throw an
opaque `AbiFunctionSignatureNotFoundError` (uncaught, propagating out of
`prepareRedemptionProofs`) rather than the intended clear
`"is not an executeRound call"` error, and redemption proof assembly would fail.
**Fix:** Wrap the decode in a try/catch that rethrows the descriptive error, and
document that manifest reconstruction requires the round to have been submitted
as a direct top-level `executeRound` call to the hub.

### IN-04: Redemption proof assembly re-scans full log history (`fromBlock: 0n`) per buffered round

**File:** `src/client.ts:157-163`, `src/client.ts:184-194`
**Issue:** `prepareRedemptionProofs` calls `fetchManifest` up to `RING` (16)
times, and each call issues `getContractEvents({ ..., fromBlock: 0n })` — a
full-history scan from genesis. On a long-lived chain this is repeated
genesis-to-tip scanning per redemption. Flagged not as a perf-tuning item (out
of scope) but as an availability note: if the RPC log query begins timing out
as history grows, redemption proof generation — the creditor's only recovery
path — could become unsubmittable, while the never-pausable `withdraw` continues
to let the debtor exit.
**Fix:** Cache the RoundExecuted log→tx lookups, or narrow `fromBlock` using the
known round-nonce-to-block relationship (e.g., persist a nonce→block index), so
proof assembly does not degrade with chain length.

---

_Reviewed: 2026-07-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
