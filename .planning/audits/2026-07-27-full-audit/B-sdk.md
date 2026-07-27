---
phase: audit-scope-B-sdk
reviewed: 2026-07-27T00:00:00Z
depth: deep
files_reviewed: 10
files_reviewed_list:
  - src/index.ts
  - src/types.ts
  - src/domain.ts
  - src/iou.ts
  - src/netting.ts
  - src/round.ts
  - src/merkle.ts
  - src/pvp.ts
  - src/creditCap.ts
  - src/client.ts
findings:
  critical: 4
  warning: 15
  info: 0
  total: 19
status: issues_found
---

# Audit Scope B — TypeScript SDK (`src/`)

**Reviewed:** 2026-07-27
**Depth:** deep (whole-module, cross-file, with executable proofs)
**Files Reviewed:** 10
**Status:** issues_found

## Summary

The SDK's hash layer is genuinely solid: `merkle.ts` is byte-parity-correct with
`ManifestMerkle.sol` across every edge case I could construct (0–9 leaves, odd
counts, uppercase/checksum ids, malformed leaves, unknown proof kinds, empty
manifest sentinel, exhaustive non-inclusion round-trips at n=1..8), and the prior
fixes named in the brief (consent screening, pending-consent overlap, nonce
pinning, FX inclusion symmetry, union strict-ascent, scan floors/windowing) all
verify correct as implemented. `scanWindows` produces exactly contiguous,
non-overlapping, inclusive windows — I exhaustively checked 5×40×7 (from, to,
span) combinations with zero violations.

What is *not* solid is everything that connects the hash layer to money.

Four findings are BLOCKERs, all proven by executing the real modules:

1. **`SignedIou.id` is unauthenticated.** Nothing in the SDK ever binds the `id`
   field to `iouId(hub, iou)`. A creditor can present a validly-signed IOU with a
   fabricated id; `verifyIou` returns `true`, `net()` puts the fake id in the
   manifest, and the debtor's own `verifyProposal` returns `{ok: true}`. The real
   id then never appears in any manifest root, so `redeemIOU` non-inclusion still
   passes and the debtor pays the same obligation twice.
2. **`fetchManifest` cannot decode PvP-settled rounds**, so `prepareRedemptionProofs`
   throws and `redeemIOU` is unusable for the entire RING window after any round
   settled through the deployed `PvPRouter`.
3. **The `executeRound` gas formula under-provisions from n≥16 participants** —
   measured with forge, not estimated. The project's own `docs/CALIBRATION.md`
   analyzes n=15/30/50; at n=30 the formula supplies 1,500,000 gas against
   1,731,643 required.
4. **`verifyProposal` is not a total function.** It throws on four classes of
   attacker-supplied `consumedIds`, contradicting its documented `{ok, reason}`
   contract and crashing the participant process. `verifyPvPProposal` inherits it.

Everything marked "proven" below was demonstrated by running the actual module
against a real input; scratch scripts live in the session scratchpad (not the
repo). Anything I could not execute is explicitly marked "derived".

---

## Critical Issues

### CR-01: `SignedIou.id` is never bound to the IOU digest — forged-id double payment

**Files:** `src/netting.ts:43-56`, `src/iou.ts:87-100`, `src/round.ts:170-189`
**Status:** PROVEN

`signIou` derives `id` correctly, but *nothing on the receiving side ever
re-derives it*. `verifyIou` checks only the signature over `signed.iou`; it
never touches `signed.id`. `net()` then treats the caller-supplied `s.id` as
authoritative for dedup, for `settledIds`/`redeemedIds` lookups, and as the
manifest leaf. `verifyProposal` deliberately does not compare `consumedIds`
against the recomputed set (the "No stranger-id check (IN-01)" comment at
`round.ts:183-185`).

Executed against the real modules:

```
real id of alice's IOU: 0x42209f1bfa0663057541c14ece446f75368d9f1a03696eedfc5e0c89e67cbc61
verifyIou on the forged-id object: true          <-- signature still valid
forged.id === iouId(...)? false
net() consumedIds: [0x00...01, 0x0733...c8c7]    <-- real id absent
debtor Alice's verifyProposal: { ok: true }      <-- CONSENTS
```

Failing input: take any `SignedIou` produced by `signIou` and replace `.id`
with `0x0000…0001`. The signature is untouched and still verifies.

Attack: Bob (creditor) holds Alice's signed IOU. He submits it to the
coordinator with a forged id. The round nets normally — Alice's delta is
identical, so her `verifyProposal` passes — and Alice pays. The round's manifest
commits to `0x00…01`, not to the real id, and `redeemed[realId]` is never set
(the hub only writes that mapping inside `redeemIOU`). Once Alice is stale
(`roundNonce - lastRound[alice] >= K`, K=3 on the deployed hubs), Bob calls
`redeemIOU` with the *real* IOU: `hashIou` recomputes the real id on-chain,
non-inclusion holds against every buffered root, and Alice is debited a second
time. Contracts are immutable, so this must be fixed SDK-side.

**Fix** (two independent layers; do both):

```ts
// src/iou.ts — make the id part of what verification means
export async function verifyIou(hub: Address, signed: SignedIou, chainId?: number) {
  if (signed.id.toLowerCase() !== iouId(hub, signed.iou, chainId).toLowerCase()) return false;
  return verifyTypedData({ /* unchanged */ });
}

// src/netting.ts — bind ids at the point they enter the manifest
export function net(ious: SignedIou[], opts: { hub: Address; chainId?: number; now: bigint; ... }) {
  ...
  for (const s of ious) {
    const id = iouId(opts.hub, s.iou, opts.chainId).toLowerCase() as Hex; // derive, never trust
    if (id !== s.id.toLowerCase()) continue; // or throw — do not silently net foreign ids
    ...
```

Additionally, `verifyProposal` must assert that every locally-known IOU that
contributed to the caller's recomputed delta has its id present in
`proposal.consumedIds` — that closes the omission variant even for a caller who
skipped the id re-derivation:

```ts
const proposed = new Set(proposal.consumedIds.map((i) => i.toLowerCase()));
for (const id of recomputed.consumedIds) {
  if (!proposed.has(id)) {
    return { ok: false, reason: `my consumed id ${id} is missing from the proposal manifest` };
  }
}
```

### CR-02: `fetchManifest` cannot decode PvP-settled rounds — `redeemIOU` is bricked for RING rounds

**File:** `src/client.ts:221-248` (decode at `:243-247`), consumed by `:259-269`
**Status:** PROVEN

`fetchManifest` locates the `RoundExecuted` log for a nonce, fetches the
transaction, and calls `decodeFunctionData({ abi: clearingHubV2Abi, data: tx.input })`.
`PvPRouter.executePvP` calls `hubUSDC.executeRound(...)` / `hubEURC.executeRound(...)`
internally (`contracts/src/PvPRouter.sol:196-201`), so for any PvP round the
transaction input is `executePvP` calldata on the router — a selector the hub ABI
does not contain:

```
router tx selector: 0x1506d07e
decodeFunctionData THREW: AbiFunctionSignatureNotFoundError -
  Encoded function signature "0x1506d07e" not found on ABI.
```

This is an unhandled viem rejection, not the code's own
`"is not an executeRound call"` error. `prepareRedemptionProofs` loops over
**every** buffered nonce (`:264`), so a single PvP settlement makes redemption
proof assembly fail for the next RING=16 rounds — i.e. the entire creditor
recovery path documented in QUICKSTART §4 stops working on any hub that has ever
been used with the deployed router (`0x8287…fE8c`), which the demo does routinely.

**Fix:** try the router shape when the hub decode fails, and pick the leg whose
nonce and hub match:

```ts
let ids: readonly Hex[];
try {
  const { functionName, args } = decodeFunctionData({ abi: clearingHubV2Abi, data: tx.input });
  if (functionName !== "executeRound") throw new Error("not executeRound");
  ids = args[3];
} catch {
  const { functionName, args } = decodeFunctionData({ abi: pvpRouterAbi, data: tx.input });
  if (functionName !== "executePvP") {
    throw new Error(`round ${nonce} tx ${tx.hash} settled by an unrecognised caller`);
  }
  const legs = [args[0], args[1]];
  const leg = legs.find((l) => l.nonce === nonce);   // disambiguate by nonce…
  if (!leg) throw new Error(`no leg at nonce ${nonce} in PvP tx ${tx.hash}`);
  ids = leg.consumedIds;
}
return [...ids];
```

Both legs can share a nonce across two different hubs, so also verify the
selected leg by recomputing `merkleRoot(ids)` against the `manifestHash` carried
in the `RoundExecuted` log (it is a non-indexed event field and is already
available on the log you fetched) — that disambiguates unconditionally and is
worth doing regardless.

### CR-03: `executeRound` gas formula under-provisions from n≥16 participants

**File:** `src/client.ts:29-31` (constants), `:318-321` (application)
**Status:** PROVEN (forge, `ClearingHubV2` compiled with the repo's own profile)

Every recorded measurement backing `EXECUTE_ROUND_GAS_PER_PARTICIPANT = 40_000n`
was taken at **n=5** — `contracts/test/ClearingHubV2.t.sol:410-439` hard-codes
`new address[](5)` and only varies `m`. The per-participant coefficient was
therefore never measured. It is wrong: two fresh SSTOREs (`collateral[p]`,
`lastRound[p]`) alone cost 40,000, before `ecrecover`, the `PositionSettled`
event, and calldata.

Measured marginal cost across n: **~52,200 gas/participant** (execution only),
plus ~8,500 intrinsic calldata gas per participant. Because a participant only
appears if one of their IOUs was consumed, the realistic minimum manifest is
`m = n/2`; measured at that shape:

| n | m | measured (gasleft) | + intrinsic | formula | covered |
|---|---|---|---|---|---|
| 10 | 5 | 591,843 | 648,747 | 730,000 | yes |
| 14 | 7 | 804,303 | 874,519 | 902,000 | yes |
| **16** | **8** | **912,367** | **989,239** | **988,000** | **NO** |
| 20 | 10 | 1,129,859 | 1,220,043 | 1,160,000 | NO |
| 30 | 15 | 1,615,859* | 1,731,643* | 1,500,000* | NO |
| 50 | 25 | 2,661,670* | 2,838,894* | 2,300,000* | NO |

(*m=0 rows for n=30/50; the m=n/2 rows are strictly worse.)

`docs/CALIBRATION.md` analyzes pools at **n=15, 30, 50** — every one of those is
past the crossover. At n=30 the formula supplies 1,500,000 gas against 1,731,643
required: a guaranteed out-of-gas revert that burns the fee (paid in USDC on Arc)
and leaves the round unsettled with no way for the SDK to retry successfully,
since the formula is deterministic.

Note also that the "≥1.5x margin at every measured point" claim in the docblock
(`client.ts:22-28`) is false even at n=5, because `gasleft()` deltas exclude
intrinsic gas (21,000 + 16/non-zero calldata byte). Real margins at the three
recorded points are **1.42x / 1.41x / 1.39x**, not 1.70/1.63/1.59.

**Fix:** raise the coefficient above the measured worst case and re-derive the
base from an intrinsic-inclusive measurement:

```ts
export const EXECUTE_ROUND_GAS_BASE = 300_000n;
export const EXECUTE_ROUND_GAS_PER_PARTICIPANT = 90_000n; // measured 52.2k exec + ~8.5k calldata, 1.5x
export const EXECUTE_ROUND_GAS_PER_ID = 8_000n;           // measured ~3.9k exec + 0.5k calldata, 1.8x
```

and add an n-varying gas test (n ∈ {2, 5, 16, 30, 50}) to
`ClearingHubV2.t.sol` so the coefficient is pinned by a measurement rather than
by a single point.

### CR-04: `verifyProposal` throws on attacker-supplied `consumedIds` — validator is not total

**File:** `src/round.ts:187` (`manifestHash(proposal.consumedIds)`), inherited at `src/pvp.ts:219,227`
**Status:** PROVEN

`manifestHash` → `merkleRoot` → `normalize` (`src/merkle.ts:60-75`) throws on
non-bytes32, duplicate, or descending ids. `verifyProposal` calls it on
*coordinator-supplied* `proposal.consumedIds` with no guard, despite its
documented contract (`CLAUDE.md`: "Verification/validation functions return a
discriminated result object instead of throwing") and the sibling functions in
`merkle.ts` explicitly honoring that contract.

Four failing inputs, all executed:

```
duplicate ids:  THREW duplicate id at index 1: 0x14f8…77f9
descending ids: THREW ids not strictly ascending at index 1: 0xffff… >= 0x0000…
short hex:      THREW id at index 0 is not bytes32 hex: 0xdead
non-hex:        THREW id at index 0 is not bytes32 hex: nope
```

`verifyPvPProposal` propagates it too (proven: `THREW duplicate id at index 1`).
An integrator following QUICKSTART §3.5 writes
`const check = verifyProposal(...); if (!check.ok) throw ...` — a hostile or
merely buggy coordinator crashes their agent loop instead of getting a refusal.
Any participant-side auto-consent daemon is remotely killable by one malformed
proposal.

**Fix:**

```ts
let recomputedRoot: Hex;
try {
  recomputedRoot = manifestHash(proposal.consumedIds);
} catch (e) {
  return { ok: false, reason: `malformed consumedIds: ${(e as Error).message}` };
}
if (recomputedRoot !== proposal.manifestHash) {
  return { ok: false, reason: "manifestHash does not match consumedIds" };
}
```

Apply the same wrapping around `roundDigest`/`pvpDigest` (viem throws
`IntegerOutOfRangeError` on out-of-range deltas — see WR-07) and add a unit test
asserting `verifyProposal` never throws for arbitrary `RoundProposal` shapes.

---

## Warnings

### WR-01: `executePvP` gas formula under-provisions at n≥40 per leg; ~1.0x margin at n=30

**File:** `src/client.ts:435-442`
**Status:** PROVEN (forge)

Same root cause as CR-03 — the PvP formula reuses the broken per-participant
coefficient for both legs. The larger 950,000 fixed base defers the crossover
but does not remove it. Measured with both legs sharing n participants and
m=n/2 ids each:

| n/leg | measured | + intrinsic | formula | covered |
|---|---|---|---|---|
| 20 | 2,457,912 | 2,657,856 | 2,970,000 | yes (1.12x) |
| 30 | 3,631,542 | 3,918,526 | 3,980,000 | yes (1.016x) |
| **40** | **4,811,754** | **5,185,778** | **4,990,000** | **NO** |
| 50 | 5,996,574 | 6,457,638 | 6,000,000 | NO |

The docblock's "1.55x / 2.43x at the measured points" is likewise intrinsic-blind
(real: 1.39x at the demo point). **Fix:** inherit the corrected coefficients from
CR-03 and re-measure `PVP_ROUTER_GAS_BASE` at n≥30.

### WR-02: `REDEEM_IOU_GAS` margin claim overstates by ~2x

**File:** `src/client.ts:33-39`
**Status:** DERIVED (arithmetic on the recorded measurement; not executed)

`500_000` is described as "2.51x" the measured 199,604. That measurement is a
`gasleft()` delta and excludes intrinsic gas. At demo-scale 105-id manifests the
sixteen bracketing proofs carry ~7 siblings each instead of 3, adding roughly
4 KB of near-all-non-zero calldata (~65,000 gas intrinsic) on top of the base
~14 KB proof array; total lands near 370,000, i.e. **~1.35x**, not 2.51x. Still
covered on the deployed RING=16 hubs, but the stated headroom is wrong and the
comment's "+40k total" estimate accounts only for the extra hashing, not the
calldata. **Fix:** restate the margin honestly, or measure `redeemIOU` with a
105-id manifest and set the constant from that.

### WR-03: `roundExecutedHashes` is neither floored at `earliestBlock` nor windowed

**File:** `src/client.ts:160-169`
**Status:** PROVEN by inspection (contrast with `fetchManifest:225-238`)

The pruned-history/90k-window fix was applied to `fetchManifest` but not to the
sibling scan. `roundExecutedHashes` passes a caller-supplied `fromBlock`
straight through with no `toBlock`, ignoring `this.earliestBlock` and
`MAX_LOG_SCAN_SPAN`. A caller who passes `0n` (the natural default, and what
`earliestBlock`'s own default is) hits exactly the two live-Arc failures the
windowing was introduced to avoid — pruned-range rejection and
"query exceeds max block range 100000". This is the WR-01/WR-02 reconciliation
primitive, so it fails precisely when a submitter has lost their receipt and
most needs it.

**Fix:**

```ts
async roundExecutedHashes(roundNonce: bigint, fromBlock: bigint): Promise<Hex[]> {
  const from = fromBlock > this.earliestBlock ? fromBlock : this.earliestBlock;
  const latest = await this.pub.getBlockNumber();
  const out: Hex[] = [];
  for (const [f, t] of scanWindows(from, latest, MAX_LOG_SCAN_SPAN)) {
    const logs = await this.pub.getContractEvents({
      address: this.hub, abi: clearingHubV2Abi, eventName: "RoundExecuted",
      args: { roundNonce }, fromBlock: f, toBlock: t,
    });
    out.push(...logs.flatMap((l) => (l.args.roundHash === undefined ? [] : [l.args.roundHash])));
  }
  return out;
}
```

### WR-04: `scanWindows` spins forever for `span <= 0n`

**File:** `src/client.ts:72-79`
**Status:** PROVEN (loop confirmed non-terminating; aborted at 1e6 iterations)

`for (let start = from; start <= to; start += span)` never advances when
`span <= 0n`. The function is exported from `index.ts`, so `span` is
integrator-controlled. Window contiguity is otherwise exactly correct — I
exhaustively verified from ∈ [0,5), to ∈ [0,40), span ∈ [1,8): zero gaps, zero
overlaps, exact `[from, to]` coverage, no window wider than `span`.

**Fix:** `if (span <= 0n) throw new Error(\`scan span must be positive, got ${span}\`);`

### WR-05: `net()` only half-normalizes `settledIds` / `redeemedIds`

**File:** `src/netting.ts:47-48`
**Status:** PROVEN

The code checks both `settled.has(id)` (lowercased) and `settled.has(s.id)` (raw)
— clearly intending case robustness — but a set containing an *uppercase* id
matches neither:

```
settledIds lowercase set  -> 0 ids consumed (correct)
settledIds UPPERCASE set  -> 1 ids consumed (WRONG — settled IOU re-netted)
redeemedIds UPPERCASE set -> 1 ids consumed (WRONG)
```

If a coordinator and its participants both keep uppercase sets, an
already-settled IOU re-enters netting and the debtor pays twice; a redeemed id
re-entering the manifest makes the hub revert `NullifiedIdInManifest`, stalling
the round with no diagnosable cause.

**Fix:** normalize once at entry.

```ts
const settled = new Set([...(opts.settledIds ?? [])].map((i) => i.toLowerCase()));
const redeemed = new Set([...(opts.redeemedIds ?? [])].map((i) => i.toLowerCase()));
// …then a single `settled.has(id)` check suffices.
```

### WR-06: `net()`/`buildProposal` silently emit structurally unexecutable proposals

**Files:** `src/netting.ts:60-68`, `src/round.ts:51-65`
**Status:** PROVEN

Three inputs produce a proposal that `executeRound` can never accept, with no
signal from the SDK:

- Empty IOU set → `participants: []`, and `buildProposal` happily returns a
  signed-shaped digest `0xd57a98…5976`. Hub reverts `TooFewParticipants`.
- A single self-IOU (`debtor === creditor`) → `participants` has length 1,
  `deltas: [0n]`, `grossVolume: 5000000n`. Hub reverts `TooFewParticipants`.
  The hub explicitly rejects self-IOUs in `redeemIOU` (`SelfIou`); `net()` and
  `signIou` accept them, so self-dealing paper inflates `grossVolume` (a headline
  compression metric) and pads manifests for free.
- Consequently the reported compression ratio can be inflated by any participant
  signing IOUs to themselves.

**Fix:** drop `debtor === creditor` IOUs in `net()` (rule 0, matching the hub),
and have `buildProposal` refuse `result.participants.length < 2` with a clear
error rather than producing a proposal that costs every participant a signature
and then reverts.

### WR-07: no `int256` bound on IOU amounts — one signed IOU DoSes proposal construction

**Files:** `src/netting.ts:52-57`, `src/iou.ts:58-84`
**Status:** PROVEN

`amount` is `uint256` in the IOU typehash but deltas are `int256`. `signIou`
validates neither magnitude, nor `amount > 0`, nor self-dealing. A debtor can
sign an IOU with `amount = 2^255 - 1`; `net()` produces a creditor delta of
`2^255` and then:

```
buildProposal THREW: Number "578960…4819968" is not in safe 256-bit signed integer range
```

Any participant can therefore halt the coordinator's round construction with a
single validly-signed IOU, and (per CR-04) the same throw escapes through
`verifyProposal` on the participant side.

**Fix:** bound at signing and at netting.

```ts
const INT256_MAX = (1n << 255n) - 1n;
// src/iou.ts signIou:
if (iou.amount <= 0n || iou.amount > INT256_MAX) throw new Error(`amount ${iou.amount} out of range`);
if (iou.debtor.toLowerCase() === iou.creditor.toLowerCase()) throw new Error("self-IOU");
// src/netting.ts, inside the loop, before accumulating:
if (s.iou.amount <= 0n || s.iou.amount > INT256_MAX) continue;
```

### WR-08: `verifyProposal`'s "no stranger-id check" rationale is wrong for third parties

**File:** `src/round.ts:183-185`
**Status:** DERIVED (contract behavior read from `ClearingHubV2.sol:206-267`; not executed on-chain)

The comment justifies skipping the stranger-id check with "our delta already pins
the sum of everything that involves us". That is true *for the signer*, but the
hub never relates `consumedIds` to `participants` — nothing stops a round from
committing an id belonging to somebody who is not a participant and is not paid.
That id is then permanently inside a buffered manifest root, so the victim
creditor's `redeemIOU` non-inclusion proof for it fails for the next RING rounds:
their recovery path is griefed without them ever being asked to consent.

The consenting participants genuinely cannot detect this (ids are opaque hashes),
so the *check* can't be added where the comment sits — but the conclusion
"consumed ids we haven't seen locally are fine" is false and should not be left
as guidance. The SDK-side mitigation belongs on the creditor: it has
`fetchManifest` but no helper to answer "did my id get consumed in a round I
wasn't paid in?".

**Fix:** correct the comment to state the actual residual risk, and add a
creditor-side watcher, e.g.
`HubClient.manifestContains(nonce: bigint, id: Hex): Promise<boolean>` plus a
"scan the buffered ring for my open ids" convenience, so a creditor can detect
stuffing while the round is still fresh. Cross-reference this in
`docs/THREAT-MODEL.md`.

### WR-09: `verifyPvPProposal` accepts a 0/0 FX rate; `rateConsistent` is vacuously true

**Files:** `src/pvp.ts:138-145`, `src/pvp.ts:200-302`
**Status:** PROVEN

```
0/0 rate bundle: { ok: true }     <-- router reverts ZeroRate
rateConsistent(5n, 7n, 0n, 0n) -> true
```

`buildPvPProposal` guards zero (`:156-157`) but `verifyPvPProposal` does not, so
a bundle assembled by any other path passes participant verification and then
reverts `ZeroRate` on-chain — the union wastes a full consent round. Worse,
`rateConsistent` is exported public API: an integrator using it for their own
rate policy gets `true` for *every* `(u, e)` pair when both components are zero.

**Fix:**

```ts
// top of verifyPvPProposal
if (proposal.fxNumerator === 0n || proposal.fxDenominator === 0n) {
  return { ok: false, reason: "degenerate FX rate: numerator and denominator must be nonzero" };
}
// and in rateConsistent
if (fxNumerator === 0n || fxDenominator === 0n) return false;
```

### WR-10: `verifyPvPProposal` trusts caller-supplied hub addresses

**File:** `src/pvp.ts:200-213`
**Status:** DERIVED

`hubUsdc`/`hubEurc` are plain parameters, never cross-checked against the
router's `hubUSDC()`/`hubEURC()` immutables — even though `PvPRouterClient`
exposes exactly those reads (`client.ts:385-400`). A coordinator that supplies
consistent-but-wrong hub addresses gets a member to sign a bundle for a hub pair
they never verified. The on-chain outcome is safe (the router recomputes leg
digests against its real hubs and reverts `LegDigestMismatch`), so this is
wasted-consent rather than fund loss — but the SDK presents the function as the
member's full pre-consent check.

**Fix:** either accept a `PvPRouterClient` and assert
`hubUsdc === await router.hubUSDC()`, or document in the docblock that the caller
MUST source both hub addresses from the router's immutables and show it in
QUICKSTART §5.

### WR-11: `CreditCapTracker` is not idempotent, never releases expired paper, and aliases its caps map

**File:** `src/creditCap.ts:10-50`
**Status:** PROVEN

```
exposure after recording the SAME IOU twice: 800000n   (expect 400000n)
caller mutated the caps map after construction -> capFor(alice) = 1000000000000000000n
checksummed cap key -> capFor(alice) = 100n            (silently falls back to defaultCap)
prototype methods: constructor,key,capFor,exposureOf,wouldExceedCap,record,settle
```

Three defects in the SDK's only risk-policy primitive:

1. `record` keys by `(debtor, creditor)`, not by IOU id, so a duplicate delivery
   or a retry double-counts exposure. `settle` then clamps at `0n` (`:47`),
   silently masking the drift instead of surfacing it. A long-running agent
   progressively under-extends credit and eventually refuses everyone.
2. There is no release path for IOUs that **expire** un-netted. `net()` drops
   them at `netting.ts:46`; the tracker keeps them as live exposure forever. Any
   agent whose counterparty goes quiet permanently loses that cap.
3. The `caps` map is stored by reference (`:16`), so the constructing caller can
   mutate the tracker's risk policy afterwards; and a checksummed key is silently
   ignored (lookups lowercase at `:24`, insertions do not).

**Fix:** key exposure by `SignedIou.id` (`Map<string, Map<Hex, bigint>>` or a
flat `Map<Hex, {pair, amount}>`) so `record`/`settle`/`release` are all
idempotent; add `expire(now: bigint)` or `release(ids: Hex[])`; copy and
lowercase-normalize the caps map in the constructor:

```ts
constructor(readonly defaultCap: bigint, caps: Map<string, bigint> = new Map()) {
  this.caps = new Map([...caps].map(([k, v]) => [k.toLowerCase(), v]));
}
```

### WR-12: `publicClient`/`walletClient` hardcode `arcTestnet` — the documented anvil path is unreachable

**File:** `src/client.ts:57-59`, `:81-83`; `src/domain.ts:6-22`
**Status:** PROVEN by inspection + cross-file

Both factories bake `chain: arcTestnet` (chain id 5042002) with no override,
while the digest layer is fully chain-parameterized (`domain(hub, chainId)`).
QUICKSTART §2 tells integrators "you only pass a `chainId` when targeting
something else (e.g. a local anvil)" — but there is no way to point these
factories at anvil, and a write through `walletClient()` against a 31337 node is
rejected outright. The repo's own demo silently bypasses them
(`demo/setup.ts:130-133,230-234` build clients with `createPublicClient`/
`createWalletClient` directly), which is the clearest evidence they aren't fit
for the documented purpose.

Related, same file: `arcTestnet`'s RPC list reads `process.env.ARC_RPC_URL` at
**module load** (`domain.ts:12`) inside a package declaring `"sideEffects": false`
— an npm consumer's client silently changes behavior based on an env var they
never opted into, and bundlers are told the module is side-effect-free.

**Fix:**

```ts
export function publicClient(rpcUrl?: string, chain: Chain = arcTestnet): PublicClient {
  return createPublicClient({ chain, transport: http(rpcUrl) });
}
export function walletClient(account: Account, rpcUrl?: string, chain: Chain = arcTestnet): WalletClient {
  return createWalletClient({ account, chain, transport: http(rpcUrl) });
}
```

and make the RPC an explicit argument rather than an ambient env read.

### WR-13: `MIN_MAX_FEE_PER_GAS` contradicts the chain's own `baseFeeMultiplier`, with no priority-fee pin

**Files:** `src/domain.ts:18-28`; applied at `src/client.ts:294,307,335,354,458`
**Status:** DERIVED

`arcTestnet.fees.baseFeeMultiplier = 1.5` implies an expected `maxFeePerGas` of
~30 gwei over the documented 20 gwei floor, yet every write hardcodes 25 gwei —
so the multiplier is dead configuration for the entire SDK, and writes carry only
1.25x headroom over the protocol minimum base fee. Any sustained base-fee
increase above 25 gwei makes every SDK write unmineable; because these are
sequential nonce-consuming transactions, one stuck write blocks the account.

No `maxPriorityFeePerGas` is set either, so viem issues an extra
`eth_maxPriorityFeePerGas` per write and throws `MaxFeePerGasTooLowError` if the
node reports a tip at or above 25 gwei.

**Fix:** raise the cap to at least `baseFeeMultiplier × floor` (30 gwei), pin an
explicit small `maxPriorityFeePerGas`, and make both overridable per call so an
integrator can react to congestion without forking the SDK.

### WR-14: ABI export surface is inverted — v1 ABI re-exported, V2/PvP ABIs unreachable

**Files:** `src/client.ts:13,20`; `src/index.ts:9`
**Status:** PROVEN

Runtime export list from `src/index.ts` confirms:

```
clearingHubV2Abi exported? false
pvpRouterAbi     exported? false
clearingHubAbi   exported? true   (v1 — imported at client.ts:13, used nowhere)
```

`clearingHubAbi` is dead: `HubClient` uses `clearingHubV2Abi` exclusively, so the
only ABI an integrator can reach is for a contract the SDK never talks to.
Anyone wanting `decodeEventLog` on `RoundExecuted`/`IouRedeemed`, a raw
`readContract`, or a `watchContractEvent` has to vendor the ABI themselves.
`InclusionProof`/`NonInclusionProof` are type-only and erase at runtime, which is
fine, but means the proof shapes can't be validated by consumers either.

Separately, `src/abi/ClearingHubV2.ts` and `src/abi/PvPRouter.ts` embed creation
bytecode (per their own header comments) which ships in `dist/` for no consumer
benefit.

**Fix:** `export { clearingHubV2Abi, pvpRouterAbi }` from `client.ts` (or a
dedicated `src/abi/index.ts` re-exported by the barrel), drop the unused
`clearingHubAbi` import/re-export or move it behind an explicit `v1` sub-path,
and strip creation bytecode from the shipped ABI modules.

### WR-15: the double-consent guard is opt-in, so the unsafe configuration is the default

**File:** `src/round.ts:124-137`
**Status:** DERIVED

`expectedRoundNonce` and `pendingConsumedIds` are both optional. Omitting them
silently disables exactly the WR-06 protection the docblock spends twelve lines
explaining — no warning, no reason string, just `{ok: true}`. QUICKSTART §3.5
passes `expectedRoundNonce` but presents `pendingConsumedIds` as an "if you
also…" afterthought. An integrator who copies the minimal example gets the
unprotected path.

**Fix:** make `expectedRoundNonce` required in the `opts` type (it is a single
`hub.roundNonce()` read the caller already performs), and default
`pendingConsumedIds` to a required-but-possibly-empty set so the caller has to
make an explicit statement about their outstanding consents rather than
defaulting into "I have none".

---

## Verification of previously-fixed items (requested in scope)

| Prior fix | Verdict |
|---|---|
| Consent-signature screening | Correct — `verifyConsent`/`verifyPvPConsent` bind `verifyingContract` + primaryType; no cross-domain reuse found. |
| Pending-submission reconciliation | Logic correct, but the primitive it depends on is not windowed — see **WR-03**. |
| `verifyProposal` nonce/overlap pinning | Correct *when passed* — normalization of `pendingConsumedIds` is symmetric (both sides lowercased, `round.ts:147,149`), unlike `net()`'s sets (WR-05). Opt-in default is **WR-15**. |
| FX-pair inclusion symmetry (CR-01, prior) | Correct — verified honest bundle passes, wrong-rate bundle refuses, asymmetry branch reachable. Degenerate-rate hole remains: **WR-09**. |
| `unionParticipants` strict-ascending / zero-address | Correct and faithful to `PvPRouter._unionOf`. Verified: zero address, unsorted input, in-list duplicate all throw; mixed-case inputs merge correctly with checksummed output preserved. |
| Pruned-history scan floors + 90k windowing | Correct in `fetchManifest`; exhaustively verified contiguous/non-overlapping/inclusive. **Not applied** to `roundExecutedHashes` (WR-03); unguarded `span<=0` (WR-04). |

## Clean areas (adversarially probed, no defects found)

- `src/merkle.ts` — full parity with `ManifestMerkle.sol` including tree shape
  (level-wise pairing + lone-node promotion, not RFC 6962 split, not Bitcoin
  duplication), `0x00`/`0x01` domain separation, the `keccak256("")` sentinel,
  sibling-consumption schedule, and the `s !== siblings.length` unconsumed check.
  Inclusion verified for all indices at n=0..9; non-inclusion round-trips at
  n=1..8 across belowFirst/aboveLast/every interior bracket. Uppercase leaves and
  uppercase roots normalize correctly. Malformed leaves, missing sibling arrays,
  and unknown proof kinds all return `{ok:false}` rather than throwing — this is
  the one validator in the SDK that actually honors the project convention.
- `src/domain.ts` typehashes — byte-match `ROUND_TYPEHASH`, `IOU_TYPEHASH`
  (`ClearingHubV2.sol:52-54,116-118`) and `PVP_ROUND_TYPEHASH`
  (`PvPRouter.sol:75-77`), field order and widths included (`expiry` is `uint64`
  on both sides). Cross-chain replay closed by `chainId`; cross-hub replay closed
  by `verifyingContract`; the PvP domain correctly uses the router.
- `prepareRedemptionProofs` nonce-window derivation exactly reproduces
  `redeemIOU`'s `expected = min(roundNonce, RING)` / `start = max(0, nonce-RING)`
  including the `nonce == RING` boundary and the `nonce == 0` empty case.
- Netting zero-sum held for every input class probed: empty, single participant,
  self-dealing, duplicate ids, expired, settled/redeemed exclusions, and
  `int256`-max magnitudes. Canonical ordering (lowercase-hex ascending
  participants, ascending `consumedIds`) held throughout.

---

_Reviewed: 2026-07-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep — 4 executable probe scripts against the real modules + 2 forge gas-scaling harnesses_
