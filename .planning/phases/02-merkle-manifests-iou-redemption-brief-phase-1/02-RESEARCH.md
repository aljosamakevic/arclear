# Phase 2: Merkle Manifests & IOU Redemption - Research

**Researched:** 2026-07-23
**Domain:** Sorted-leaf merkle trees (ordered-pair, non-inclusion proofs), on-chain claim redemption, Solidity/TS dual implementation parity
**Confidence:** HIGH (stack, merkle scheme) / MEDIUM (gas estimates, promotion-variant soundness — both mitigated by in-phase measurement and property tests)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Merkle construction rules**
- **D-01 Leaves:** sorted unique bytes32 IOU ids, ascending. Leaf domain-separated from internal nodes (e.g. prefix byte or double-hash) to prevent second-preimage attacks.
- **D-02 Pair hash:** ordered concatenation `keccak256(left ‖ right)` — NOT commutative sorted-pair hashing, because adjacent-leaf bracketing non-inclusion proofs require positional order to be provable.
- **D-03 Odd node:** promote the lone node upward unchanged (no Bitcoin-style duplication — duplication creates ambiguous trees).
- **D-04 Empty manifest:** keep the v1 sentinel `keccak256("0x")` so empty-round behavior is unchanged.
- **D-05 Non-inclusion:** prove the two adjacent leaves bracketing the missing id (or single-edge proof when the id falls before the first / after the last leaf). Both sides implement identical bracketing rules.

**Unresponsiveness flagging (zero-authority constraint)**
- **D-06 On-chain criterion, not coordinator attestation:** the hub records `lastParticipation[address] = roundNonce` inside `executeRound`. The coordinator gains NO new authority.
- **D-07 Redemption gate:** `redeemIOU` requires (a) debtor's `lastParticipation` at least K rounds stale, (b) valid debtor signature on the IOU, (c) non-inclusion proofs against the stored recent round roots covering the IOU's live window, (d) unexpired... expiry semantics per research. K=3 default.
- **D-08 Root history:** hub stores a ring buffer of the last k round roots (k=16 default) written in `executeRound`. Both K and k are constructor/config parameters **labeled uncalibrated**.
- **D-09 Off-chain counters stay:** Phase 1's coordinator miss counters remain the off-chain early-warning signal; they are NOT consulted on-chain.

**Contract versioning**
- **D-10 Extend `ClearingHubV2.sol` in place** — v1 stays frozen; Phase 2 is exactly the phase where V2 grows `redeemIOU` + root history + participation tracking.
- **D-11 Redeploy at phase end:** fresh USDC + EURC hubs to Arc Testnet with explicit gas settings; README hub table updated. Digest struct (Round) unchanged → existing digest fixtures must still pass.
- **D-12 Withdraw never pausable; no division in protocol math; custom errors; NatSpec density** — all carried forward unconditionally.

**Nullifiers & exclusivity**
- **D-13 Nullifier key:** the IOU id (EIP-712 digest). `mapping(bytes32 => bool) redeemed`.
- **D-14 Redeem→cannot-net:** enforced on-chain (executeRound reverts if any consumed id is nullified) AND filtered off-chain (coordinator excludes redeemed ids; SDK `net()` opts accept a redeemed-ids set).
- **D-15 Net→cannot-redeem:** inclusion in any stored round root defeats redemption structurally. For roots older than the ring buffer, research must define the safe rule (e.g., IOU expiry bounds the redemption window). **[RESOLVED — see Critical Question 1 below]**

**Fixtures & tests**
- **D-16 Shared merkle fixture:** extend the fixture generator to emit roots + inclusion + non-inclusion proof vectors consumed by both vitest and a Foundry parity test. Property tests: root determinism under shuffle, proof verify/reject, bracketing correctness, nullifier idempotence, exclusivity both directions.
- **D-17 e2e:** debtor goes unresponsive past K windows → creditor redeems directly → debtor's collateral debited → the redeemed IOU can never settle in a later round.

### Claude's Discretion
- Exact leaf/node domain-separation scheme; proof array encoding; struct layout of `redeemIOU` params
- Whether root history is `bytes32[16]` ring or mapping by nonce with pruning window
- Gas measurement approach for the `executeRound` additions
- IOU expiry interaction details (research question — answered below, must be surfaced to planner as the D-15 rule)

### Deferred Ideas (OUT OF SCOPE)
- Cross-phase: sweep-driven calibration of K and k values — Phase 3 (calibration checkpoint) territory.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MERK-01 | `manifestHash` preimage is a sorted-leaf merkle root — same `bytes32` field, no ClearingHub interface change | `manifestHash()` in `src/round.ts:19` is the single choke point; swapping its body to a merkle root propagates through buildProposal/verifyProposal/fixtures with zero digest-struct change (Architecture Pattern 1). Interface-tension with D-14 analyzed and resolved (Critical Question 5b). |
| MERK-02 | `src/merkle.ts` + `contracts/src/lib/ManifestMerkle.sol` build roots and prove inclusion and non-inclusion (adjacent-leaf bracketing), with TS↔Solidity proof parity fixtures | Full construction + proof-encoding spec (Architecture Patterns 2–3, Code Examples); OZ MerkleProof verified unusable for ordered trees so both sides are deliberate hand-rolls to one shared spec; fixture pipeline extension mapped (Pattern 5). |
| MERK-03 | `redeemIOU(iou, sig, proofs[])` with non-inclusion proofs against the last k round roots debits an unresponsive debtor's collateral (flagged after missing K consecutive windows) | Redemption gate design (Pattern 4): staleness predicate, ring-buffer layout with timestamps, coverage rule (Critical Question 1), IOU digest verification on-chain (Critical Question 5), gas envelope (Critical Question 4). |
| MERK-04 | Nullifier mapping prevents re-redemption; redeem↔net exclusivity tested both directions | Nullifier = IOU id (D-13); redeem→cannot-net requires consumed ids in `executeRound` calldata (Critical Question 5b); net→cannot-redeem = structural non-inclusion + the D-15 coverage rule; test matrix in Validation Architecture. |
</phase_requirements>

## Summary

This phase has no new dependencies and no framework choices to make — the entire technical risk lives in **specification precision**: a merkle construction implemented twice (TS + Solidity) that must be byte-identical, and a redemption rule that must be *provably* incapable of double-claiming an already-netted IOU. Research confirms the locked construction (ordered-pair keccak, lone-node promotion, sorted unique leaves) is sound and that **no existing library can be used**: OpenZeppelin's `MerkleProof` explicitly supports only *commutative* hashing and states that non-commutative trees "require additional logic that is not supported by this library" — and commutative hashing destroys the positional information that adjacent-leaf bracketing needs. Both `src/merkle.ts` and `ManifestMerkle.sol` are therefore justified hand-rolls against one shared spec, locked by fixtures and property tests, with RFC 6962-style `0x00`/`0x01` prefix domain separation (the industry-standard second-preimage defense for ordered trees).

The hard question — D-15's "net→cannot-redeem beyond the ring buffer" — resolves cleanly with one new uncalibrated parameter: a **maximum IOU lifetime `L`**. An IOU with expiry `E` signed under the SDK-enforced convention `expiry ≤ signTime + L` can only ever have been consumed in rounds executed inside `[E − L, E)`. Redemption is therefore allowed only when the ring buffer's coverage provably contains that whole window (`executedAt(oldestBufferedRound) < E − L`, or nothing has ever been evicted). This is fail-closed, needs no new signed struct, and has a clean incentive story: violating the L-convention only weakens the *violating debtor's own* double-claim protection, and only a debtor can sign an IOU.

One locked-decision tension must be surfaced to the planner: D-14's on-chain rule "executeRound reverts if any consumed id is nullified" **requires `executeRound` to receive the consumed-id list** — the contract cannot check nullifiers against a bare root. The recommended resolution (pass `bytes32[] consumedIds` in calldata, derive `manifestHash` on-chain from them) keeps the signed Round struct byte-identical (MERK-01's real constraint, proven by existing digest fixtures) while changing `executeRound`'s ABI on the redeployed V2 hub — and it solves manifest data-availability for free, because every round's leaf set becomes reconstructible from transaction calldata.

**Primary recommendation:** implement one written merkle spec (RFC 6962-prefixed, ordered-pair, promotion) consumed by both implementations; adopt the L-bounded redemption coverage rule; pass consumed ids through `executeRound` calldata; measure gas with `forge snapshot` before touching `src/client.ts` limits.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Merkle root construction over consumed ids | SDK (`src/merkle.ts`) | Contract (`ManifestMerkle.sol`) | Off-chain compute, on-chain enforce: coordinator builds, contract recomputes/verifies |
| Inclusion / non-inclusion proof generation | SDK (`src/merkle.ts`) | — | Proof generation needs the full leaf set; only off-chain has it cheaply |
| Proof verification for redemption | Contract (`ManifestMerkle.sol`) | SDK (mirror, for tests + pre-flight) | Funds move on-chain; verification must be on-chain |
| Root history (ring buffer) + `executedAt` | Contract (`ClearingHubV2.executeRound`) | — | Must be trustless; written atomically with settlement |
| Unresponsiveness flagging (`lastParticipation`) | Contract (`ClearingHubV2.executeRound`) | Coordinator miss counters (early warning only, D-09) | Zero-coordinator-authority constraint (D-06) |
| Nullifier mapping + redeem/net exclusivity | Contract | Coordinator/SDK filtering (D-14 off-chain half) | Both directions enforced on-chain; off-chain filtering avoids wasted reverts |
| `redeemIOU` orchestration (fetch roots, build proofs, submit) | SDK (`src/client.ts` + new helper) | Demo (e2e scenario) | Creditor-side tooling; permissionless submission |
| Historical manifest reconstruction (leaf sets of past rounds) | SDK (decode `executeRound` calldata via RPC) | — | Ids live in calldata once D-14 enforcement lands; no coordinator trust needed |
| Fixture generation (merkle vectors + IOU digest vectors) | Test tooling (`test/genFixture.ts`) | Foundry parity tests (consumers) | Existing digest-parity pattern, extended not forked |
| Protocol spec (manifest commitment, redemption, griefing additions) | Docs (`docs/PROTOCOL.md`) | — | Third-party implementers must reproduce rules exactly |

## Project Constraints (from CLAUDE.md)

Directives the plan MUST honor (same authority as locked decisions):

- **GSD workflow enforcement:** all file changes flow through GSD commands (plan/execute phases).
- **Tech stack fixed:** Foundry (`via_ir = true`) + viem-only SDK + npm/tsx/vitest/fast-check; zero-framework dashboard. No new runtime dependencies without cause.
- **No division anywhere in protocol math** — bigint / int256 base units only (merkle + redemption math is hashing and add/sub only; index arithmetic uses shifts/ceil-by-add, never `/` in *protocol value* math — loop index halving `(w + 1) >> 1` is fine and division-free).
- **`ClearingHub.sol` interface unchanged where touched** — v1 stays frozen as Arclear Net v1; merkle root reuses the `manifestHash` bytes32 field.
- **Withdrawal never pausable** in ClearingHub/V2; coordinator holds no keys/authority in the Net product.
- **Shared TS↔Solidity digest fixtures for every new signed struct**; explicit gas limits on all Arc writes (`--with-gas-price 25gwei` deploys; USDC-as-gas-token gotcha).
- **Conventions:** strict TS, named exports only, `camelCase.ts` modules, `{ ok, reason }` validation returns (never throw from check-X-against-Y functions), custom Solidity errors with diagnostic params (no string reverts), full NatSpec on every external function, test naming `test_` / `testFuzz_` / `_revert` segments, internal test helpers `_`-prefixed, `pragma solidity 0.8.26` pinned exactly.
- **Barrel:** new SDK module `merkle.ts` re-exported from `src/index.ts` in dependency order (after `types`/`domain`, before/near `round` since `round.ts` will import it).

## Standard Stack

### Core

**No new packages.** Everything needed already exists in the repo:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| viem | 2.55.5 installed (`^2.21.0` declared) | `keccak256`, `concat`, `hashTypedData`, tx calldata decode (`decodeFunctionData`) for manifest reconstruction | Sole SDK dependency (project constraint); already provides every primitive `src/merkle.ts` needs `[VERIFIED: package.json + existing imports in src/round.ts]` |
| @openzeppelin/contracts | 5.6.1 (vendored) | `ECDSA`, `EIP712._hashTypedDataV4` for on-chain IOU digest verification in `redeemIOU`; existing guards | Already inherited by ClearingHubV2 `[VERIFIED: contracts/src/ClearingHubV2.sol imports]` |
| forge-std | vendored | Test harness, `vm.parseJson*` fixture reads, gas snapshots | Existing pattern in DigestParity.t.sol `[VERIFIED: codebase]` |
| vitest 2.1+ / fast-check 3.22+ | installed | Property tests: shuffle determinism, proof verify/reject, adversarial count/index lies | Existing test stack `[VERIFIED: package.json]` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled `ManifestMerkle.sol` | OZ `MerkleProof.sol` | **Not viable.** OZ docs: proofs are only supported for *commutative* hashing (`H(a,b) == H(b,a)`); "Proving leaf inclusion in trees built using non-commutative hashing functions requires additional logic that is not supported by this library" [CITED: docs.openzeppelin.com/contracts/5.x/api/utils/cryptography]. Commutative hashing erases left/right position — adjacent-leaf bracketing (D-05) is unprovable. D-02 locked ordered pairs for exactly this reason. |
| Hand-rolled `src/merkle.ts` | `@openzeppelin/merkle-tree` (JS) | Same commutative/sorted-pair problem, plus it would add a dependency to a viem-only SDK. Rejected. |
| Hand-rolled | Solady `MerkleProofLib` | Also commutative sorted-pair verification — same disqualification. `[ASSUMED — training knowledge; irrelevant since OZ disqualification already decides it]` |

**Installation:** none. `npm install` adds nothing this phase.

## Package Legitimacy Audit

**No external packages are installed in this phase.** The SDK remains viem-only (existing, pinned via `package-lock.json`); Solidity deps remain the vendored git submodules (`contracts/lib/openzeppelin-contracts` @ 5.6.1, `forge-std`). slopcheck run not applicable — nothing to install.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                        OFF-CHAIN                                      ON-CHAIN (ClearingHubV2)
  ┌────────────────────────────────────────────────┐      ┌──────────────────────────────────────────┐
  │  agents sign IOUs (EIP-712, unchanged)         │      │                                          │
  │        │                                       │      │  executeRound(nonce, participants,       │
  │        ▼                                       │      │        deltas, consumedIds[], sigs[])    │
  │  coordinator: net() ──► consumedIds (sorted)   │      │    1. nullifier check per id ──revert──┐ │
  │        │             [redeemedIds filtered]    │      │    2. root = ManifestMerkle.rootOf(ids)│ │
  │        ▼                                       │      │    3. digest = hashRound(...root)      │ │
  │  merkle.ts: rootOf(ids) ──► manifestHash       │      │    4. verify N sigs, apply deltas      │ │
  │        │                                       │      │    5. rootRing[nonce % k] = {root,     │ │
  │        ▼                                       │ tx   │         nonce, block.timestamp}        │ │
  │  buildProposal ─► consents ─► submit ──────────┼─────►│    6. lastRound[p] = nonce+1  ∀p       │ │
  │                                                │      │                                          │
  │  CREDITOR RECOVERY PATH (debtor dark):         │      │  redeemIOU(iou, sig, proofs[])           │
  │  fetch last k roots + executeRound calldata    │      │    1. staleness: debtor missed ≥ K rounds│ │
  │  of last k rounds (RPC) ─► rebuild leaf sets   │      │    2. coverage: full history buffered OR │ │
  │        │                                       │      │       executedAt(oldest) < expiry − L    │ │
  │        ▼                                       │      │    3. debtor sig valid over hashIou(iou) │ │
  │  merkle.ts: nonInclusionProof(id, leaves_r)    │ tx   │    4. !redeemed[id]                      │ │
  │        for every buffered root r ──────────────┼─────►│    5. non-inclusion proof valid vs EVERY │ │
  │                                                │      │       buffered non-sentinel root         │ │
  │  coordinator watches IouRedeemed events ──►    │      │    6. redeemed[id] = true; debit debtor, │ │
  │  folds redeemed ids into settledIds/net() opts │◄─────┼──     credit creditor; emit IouRedeemed  │ │
  └────────────────────────────────────────────────┘ log  └──────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/
├── merkle.ts                      # NEW: rootOf, inclusionProof, nonInclusionProof, verify* (pure, viem keccak only)
├── round.ts                       # manifestHash() body swapped to merkle root; rest untouched
├── client.ts                      # executeRound args gain consumedIds; new redeemIOU write; reads: roots/lastRound/redeemed; fetchManifest(nonce)
├── abi/ClearingHubV2.ts           # regenerated after contract change
contracts/src/
├── ClearingHubV2.sol              # extended in place (D-10): ring buffer, lastRound, redeemed, redeemIOU, hashIou
├── lib/ManifestMerkle.sol         # NEW: library — rootOf(bytes32[]), verifyInclusion, verifyNonInclusion
contracts/test/
├── ManifestMerkle.t.sol           # NEW: unit + fuzz (adversarial index/count lies must revert)
├── MerkleParity.t.sol             # NEW: reads test/fixtures/merkle.json (same fs_permissions path)
├── ClearingHubV2.t.sol            # NEW/extended: redeemIOU revert matrix, exclusivity both directions
test/
├── merkle.test.ts                 # NEW: fast-check properties (shuffle determinism, verify/reject, bracketing)
├── genFixture.ts                  # extended: emits merkle.json vectors + iouSig for hashIou recovery parity
docs/PROTOCOL.md                   # manifest-commitment section rewritten; redemption spec + griefing additions
```

### Pattern 1: Single choke-point root swap (MERK-01)

**What:** `manifestHash(sortedIds)` in `src/round.ts:19` is the only place the preimage is computed; `buildProposal` and `verifyProposal` call it and compare bytes. Replace its body with `merkleRoot(sortedIds)` (keep the empty-list sentinel `keccak256("0x")` branch, D-04). The Round EIP-712 struct, `ROUND_TYPES`, `hashRound`, and the digest-parity mechanism are untouched.
**Consequence:** `test/fixtures/digest.json` **values change** (the fixture's `manifestHash` and `digest` are outputs of this function) — regenerate with `npm run fixture`. The *encoding* parity D-11 demands still holds; regeneration is the normal pipeline, not a violation. Plans must sequence: merkle lib → swap → regenerate fixture → parity tests green.

### Pattern 2: Merkle construction spec (both implementations, one spec)

Locked by D-01..D-05, made concrete:

```
leaves:  L_i = keccak256(0x00 ‖ id_i)          ids strictly ascending, unique, lowercase-hex order
                                                (== numeric bytes32 order; already the netting rule-7 sort)
node:    N = keccak256(0x01 ‖ left ‖ right)     ordered, never sorted
level-up: pair index 2j,2j+1 → parent j; if level width odd, last node promotes UNCHANGED
root:    single remaining node;  EMPTY manifest → sentinel keccak256("0x") (no tree)
```

- `0x00`/`0x01` prefixes are RFC 6962's domain separation, "required to give second preimage resistance" [CITED: datatracker.ietf.org/doc/html/rfc6962]. See Critical Question 3 for why this beats double-hashing here.
- Tree shape is uniquely determined by leaf count (promotion is deterministic), so `(leaf, index, leafCount, siblings)` verification against a collision-resistant root binds the claimed position — the property bracketing soundness rests on. RFC 6962 makes the same shape-uniqueness observation for its (different) split rule [CITED: RFC 6962 §2.1].
- **Note:** the construction here is level-wise pairing with promotion (D-03), *not* RFC 6962's largest-power-of-two split. Only the prefix scheme is borrowed. The spec in PROTOCOL.md must say this explicitly so third parties don't implement RFC 6962 trees.

### Pattern 3: Proof encoding (recommended — Claude's discretion area)

```solidity
struct InclusionProof {
    bytes32 leaf;        // the raw IOU id (pre-leaf-hash)
    uint256 index;       // 0-based position in the sorted leaf list
    uint256 leafCount;   // total leaves of that round's manifest
    bytes32[] siblings;  // bottom-up; promotion levels consume no sibling
}

enum NonInclusionKind { BelowFirst, AboveLast, Bracket }

struct NonInclusionProof {
    NonInclusionKind kind;
    InclusionProof a;    // BelowFirst: first leaf | AboveLast: last leaf | Bracket: lower neighbor
    InclusionProof b;    // Bracket only: upper neighbor (ignored otherwise)
}
```

Verification rules (identical both sides):
- **Inclusion:** walk up with `i = index`, `w = leafCount`; at each level: if `i` is even and `i == w − 1` → promote (no sibling); else consume next sibling left/right by parity of `i`; then `i >>= 1; w = (w + 1) >> 1`. Require all siblings consumed and result == root and `index < leafCount`.
- **Empty root:** `root == keccak256("0x")` ⇒ non-inclusion holds for every id, no proof structure needed (contract short-circuits).
- **BelowFirst:** verify inclusion of `a` at `index == 0`; require `id < a.leaf`.
- **AboveLast:** verify inclusion of `a` at `index == a.leafCount − 1`; require `id > a.leaf`.
- **Bracket:** verify both; require `a.leafCount == b.leafCount`, `b.index == a.index + 1`, `a.leaf < id < b.leaf`.
- **Single-leaf tree** (`leafCount == 1`, root = `keccak256(0x00 ‖ leaf)`): covered by BelowFirst/AboveLast.
- Strict inequalities everywhere ⇒ `id == leaf` can never pass any non-inclusion branch.

Soundness note (own analysis, MEDIUM confidence — mandate adversarial property tests): a prover lying about `leafCount` or `index` changes the sibling-consumption schedule; matching the true root then requires a keccak collision/second preimage. The one subtle case — claiming a non-last leaf is last by shrinking `leafCount` — fails because the true tree pairs that node as a left child somewhere, and the fake path (promotion or right-child) feeds different bytes upward. fast-check tests must include: random `leafCount±δ` and `index±δ` lies rejected; internal-node-as-leaf rejected (prefix separation); duplicate-leaf and unsorted-input rejected at build time.

### Pattern 4: `redeemIOU` design

```solidity
// storage additions (layout: append only — no proxy, but keep v1-parity slots stable for audit diffing)
struct StoredRoot { bytes32 root; uint64 nonce; uint64 executedAt; }   // 2 slots/entry
mapping(uint256 => StoredRoot) rootRing;      // key: nonce % k  (recommended over bytes32[16]: self-describing entries)
mapping(address => uint64) lastRound;         // 1-based: nonce+1 written in executeRound; 0 = never participated
mapping(bytes32 => bool) redeemed;            // nullifier, key = IOU id (D-13)
uint64 immutable K;                           // default 3  — uncalibrated (D-08)
uint64 immutable RING;                        // default 16 — uncalibrated (D-08)
uint64 immutable MAX_IOU_LIFETIME;            // "L", new — uncalibrated (Critical Question 1)
```

`redeemIOU(Iou calldata iou, bytes calldata sig, NonInclusionProof[] calldata proofs)` checks, in order (custom errors with diagnostic params for each):
1. **Staleness gate (D-06/D-07a):** `roundNonce + 1 − lastRound[iou.debtor] ≥ K` (with `lastRound` 1-based; a never-participated debtor is stale once `roundNonce + 1 ≥ K` — document this edge explicitly).
2. **Coverage rule (D-15/D-07d):** `roundNonce ≤ RING` (nothing ever evicted) **OR** `rootRing[oldest].executedAt < iou.expiry − MAX_IOU_LIFETIME` (see Critical Question 1). No `block.timestamp < expiry` requirement — redemption is deliberately valid after expiry; the window closes structurally when the buffer rolls past `E − L`.
3. **Signature (D-07b):** `ECDSA.recover(hashIou(iou), sig) == iou.debtor` — `hashIou` is a new public view using `_hashTypedDataV4` with the IOU typehash (Critical Question 5).
4. **Nullifier:** `!redeemed[id]` where `id = hashIou(iou)`.
5. **Non-inclusion (D-05):** exactly one proof per buffered round in `[max(0, roundNonce − RING), roundNonce − 1]`, in ascending nonce order; sentinel roots pass without proof content; any missing/extra proof reverts (this also kills the race where a round lands between proof generation and redemption mining — count/nonce mismatch → revert, creditor regenerates).
6. **Effects:** `redeemed[id] = true`; debit `collateral[debtor]` by `iou.amount` (full amount or revert `InsufficientCollateral` — no partial redemption: nullifier is boolean and partial fills are CCP-waterfall territory); credit `collateral[creditor]`; emit `IouRedeemed(id, debtor, creditor, amount, roundNonce)`. Hub token balance untouched (collateral conservation, same as rounds).
- Guards: `nonReentrant`; recommend `whenNotPaused` (redemption is a settlement op like `executeRound`; `withdraw` alone stays unpausable — the D-12 invariant is about exit, not recovery). Permissionless caller (relayer pattern — funds only ever credit the named creditor; consistent with `executeRound`).
- Trivia guards: revert `ZeroAmount` on `amount == 0`, revert on `debtor == creditor`.

### Pattern 5: Fixture-parity extension (D-16, Critical Question 5)

Mirror the digest.json pipeline exactly: `test/genFixture.ts` additionally writes `test/fixtures/merkle.json` containing, for leaf counts {0, 1, 2, 3, 5, 8}: the sorted leaf ids, root, one inclusion proof per leaf, and non-inclusion vectors for each of {below-first, above-last, bracket at several gaps} — plus negative vectors (an id that IS a leaf, offered with a bracket proof, must fail). Foundry `MerkleParity.t.sol` reads it via the existing `fs_permissions = [{ access = "read", path = "../test/fixtures" }]` — no foundry.toml change needed [VERIFIED: contracts/foundry.toml]. Also extend `digest.json` with `iouSig` (debtor signature over the fixture IOU) so the new on-chain `hashIou` gets digest + recovery parity from the already-emitted `iouId` field [VERIFIED: test/genFixture.ts already emits `iouId`].

### Anti-Patterns to Avoid

- **Commutative/sorted-pair hashing anywhere in the tree:** silently breaks bracketing; proofs would verify but position claims become meaningless. The parity fixture with a *bracket* vector is the regression tripwire.
- **Duplicating the odd node (Bitcoin style):** creates ambiguous trees (CVE-2012-2459 class); D-03 locked promotion — property test that `rootOf([a,b,c]) != rootOf([a,b,c,c])`.
- **Verifying non-inclusion against only the roots the creditor chose:** the contract must derive the required nonce range itself from `roundNonce` and `RING` — proofs are answers to the contract's question, never the prover's.
- **Trusting the coordinator for historical leaf sets:** reconstruct from `executeRound` calldata (permissionless RPC), never from a coordinator endpoint.
- **Editing digest fixtures by hand to "make parity pass":** regenerate via `npm run fixture` only; a value change without a struct change is expected here (Pattern 1).
- **Gas estimation on Arc writes:** never rely on `eth_estimateGas` (USDC gas-token gotcha) — all new writes (`redeemIOU`) get explicit `gas` in `src/client.ts`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ECDSA recovery / malleability | custom recover | OZ `ECDSA.recover` (already imported) | s-value malleability, v-normalization edge cases handled |
| EIP-712 domain/digest plumbing | manual `\x19\x01` assembly | OZ `EIP712._hashTypedDataV4` (already inherited) | Domain separator caching + fallback already correct; only the IOU typehash + struct encode is new |
| Typed-data signing/hashing in TS | manual ABI encoding | viem `hashTypedData` / `keccak256` / `concat` (already used) | Existing digest parity proves this path byte-exact |
| Reentrancy / pausing / ownership | custom guards | OZ `ReentrancyGuard`, `Pausable`, `Ownable2Step` (already inherited) | Carried v1 invariants |
| Calldata decode of past rounds | manual hex slicing | viem `decodeFunctionData` with the V2 ABI | Exact ABI decoding, typed |

**Key insight (inverted for this phase):** the merkle tree itself is the *one thing that must be hand-rolled* — verified: OZ MerkleProof supports only commutative hashing and cannot express ordered-position proofs [CITED: docs.openzeppelin.com/contracts/5.x/api/utils/cryptography]. Treat the hand-roll like the netting engine was treated in v1: a written spec in PROTOCOL.md, two independent implementations, fixtures + property tests locking them together.

## Critical Question Resolutions

### Q1 — IOU expiry ↔ redemption window (the D-15 safe rule) — RESOLVED

**Hazard:** IOU consumed in round r; ≥ k rounds later, r's root is evicted; non-inclusion proofs against the remaining buffered roots all pass honestly → creditor double-claims. The nullifier doesn't help (it fires on redeem, not on net).

**Key structural facts:**
1. An IOU can only be *consumed* in a round its **debtor signed** (the debtor is a participant of any round consuming their IOU — netting rule 6 — and `executeRound` requires every participant's signature).
2. An honest debtor's `net()`/`verifyProposal` drops IOUs with `expiry ≤ now + safetyWindow`, so every round that consumed the IOU executed at time `< E` (assumption: safety window ≥ proposal-to-execution latency — 60s default; document it).
3. Signing time `s` is not on-chain and cannot be added without a new signed struct (which D-15's constraint set forbids in spirit and Q5 confirms is unnecessary).

**The rule (recommended, concrete):** introduce **`L = MAX_IOU_LIFETIME`** (new uncalibrated hub parameter, e.g. 24h default) with the SDK-side signing convention **`expiry ≤ signTime + L`** (enforced in `signIou` — refuse to sign otherwise; `{ok,reason}` check helper for verification paths). Then every consumption round executed inside `[E − L, E)`. `redeemIOU` requires:

> **Coverage precondition:** `roundNonce ≤ k` (no root ever evicted — full history verifiable) **OR** `executedAt(oldestBufferedRound) < E − L` (every round in the possible-consumption window is still buffered — evicted rounds all executed strictly before `E − L`, since eviction order follows execution order).

plus non-inclusion proofs against **every** buffered root (rule 5 in Pattern 4). Properties:

- **Complete for honest debtors:** if the IOU was ever netted, the consuming round's root is in the buffer and its non-inclusion proof cannot exist → redemption reverts. Net→cannot-redeem holds unconditionally for any IOU signed under the L-convention.
- **Incentive-safe against violation:** only the *debtor* signs IOUs, and double-claim only *debits the debtor*. A debtor who signs `E > signTime + L` weakens only their own protection; a creditor cannot manufacture a long-lived IOU. Third parties are untouched (redemption moves collateral strictly debtor→creditor). Document this as the safety argument.
- **Fail-closed:** if rounds execute so fast that the buffer spans less than `L` of wall-clock time, condition (b) can never hold and redemption is unavailable (liveness loss, never a safety loss). This is precisely the k↔L↔cadence calibration question — route to Phase 3 (deferred, per CONTEXT).
- **Expiry semantics (D-07d):** redemption is allowed **before or after expiry** — expiry bounds *netting*, not recovery. Post-expiry redemption is actually the calmer case (consumption set frozen). The redemption window closes structurally when the buffer rolls past `E − L`; no `block.timestamp < expiry` check.
- Rejected alternatives: on-chain per-id consumed registry (kills the compression story: ~20k gas/id/round storage); `issuedAt` field in the IOU (new signed struct → fixture obligation + breaks "reuse existing IOU signature"); restricting redemption to `roundNonce ≤ k` only (dies as soon as the chain has history).

### Q2 — Non-inclusion proof shape — RESOLVED

Two inclusion proofs + adjacency check (not a single combined proof): see Pattern 3. Edge cases enumerated: below-first, above-last, empty tree (sentinel short-circuit), single-leaf tree, id-equals-leaf (strict inequalities), lying leafCount/index (schedule mismatch → root mismatch). The two-proof encoding is chosen over a merged multiproof because it reuses one `verifyInclusion` primitive on both sides (smaller spec surface, easier parity fixtures) at a marginal calldata cost.

### Q3 — Second-preimage / cross-domain defense — RESOLVED

Recommend **RFC 6962 prefix bytes**: leaf = `keccak256(0x00 ‖ id)`, node = `keccak256(0x01 ‖ l ‖ r)` [CITED: datatracker.ietf.org/doc/html/rfc6962 — "domain separation is required to give second preimage resistance"]. Rationale vs alternatives:
- OZ's standard defense (double-hash leaves / "avoid 64-byte leaf values") targets commutative trees fed by its JS lib [CITED: docs.openzeppelin.com/contracts/5.x/api/utils/cryptography]; our leaves are already 32-byte digests, so the raw 64-byte-leaf attack shape doesn't arise — but *explicit* prefixes make the leaf/node boundary auditable rather than an accident of input lengths, and cost ~nothing (one extra byte per hash input).
- Cross-domain note: IOU ids are EIP-712 digests (`\x19\x01`-prefixed keccak outputs), and the Round digest is likewise EIP-712 — neither can collide with a `0x00`/`0x01`-prefixed merkle hash input by construction. No path exists for a merkle node to be replayed as a signable digest or vice versa.

### Q4 — Gas impact on `executeRound` and the 1_500_000 client limit — ESTIMATED, MUST MEASURE

Additions per round (n participants, m consumed ids), using stable post-Berlin EVM costs `[ASSUMED — verify with forge gas report in-phase]`:

| Addition | Cost driver | Steady-state estimate (n=5, m=105) |
|----------|------------|------------------------------------|
| Nullifier check per id | cold SLOAD 2100/id | ~220k ← dominant |
| consumedIds calldata | ~16/byte × 32B/id | ~54k |
| On-chain root recompute (m leaf + m−1 node keccaks) | ~150–300 gas/hash incl. memory | ~30–60k |
| `rootRing` write (2 slots, overwrite) | ~5–10k (first pass ~40k) | ~10k |
| `lastRound[p]` per participant | 2100 + 2900 warm-update (20k first time) | ~25k (first round ~110k) |
| **Total added** | | **~340–400k** (first-ever round ~+100k more) |

v1's 105-IOU/5-participant round fit comfortably under the hardcoded `gas: 1_500_000n`; adding ~400k likely still fits at demo scale **but erodes the headroom STATE.md already flags**. Recommendation: (a) measure with `forge snapshot` + a gas-report test at m ∈ {10, 105, 250}; (b) replace the constant in `HubClient.executeRound` with a size-parameterized formula `gas = BASE + PER_PARTICIPANT·n + PER_ID·m` (coefficients from the forge measurements, generous margin), keeping explicit-gas discipline; (c) give `redeemIOU` its own explicit limit (~800k envelope: k=16 non-inclusion proofs ≈ 8KB calldata ≈ 130k + hashing ~30k + storage ~50k + sig ~6k, margin ×2). Report measured numbers in the phase summary (CONTEXT `<specifics>` requires it).

### Q5 — New signed struct? — NO, but two obligations trigger anyway

**(a)** `redeemIOU` reuses the debtor's existing EIP-712 **IOU** signature — no new signed struct, no new signing code in the SDK. BUT the contract must now compute the IOU digest **on-chain for the first time** (`hashIou` with typehash `IOU(address debtor,address creditor,uint256 amount,uint256 nonce,uint64 expiry,bytes32 ref)` — note `expiry` is `uint64`, matching `IOU_TYPES` in `src/domain.ts` [VERIFIED: src/domain.ts:45-54]). That is a *new on-chain implementation of an existing signed struct* → the digest-parity obligation applies in spirit: extend the parity tests to assert `hub.hashIou(iou) == fixture.iouId` (field already emitted by genFixture) and `ECDSA.recover(hashIou, iouSig) == debtor` (add `iouSig` to the fixture). Make `hashIou` public — it doubles as the canonical id for reads (`redeemed[hashIou(iou)]`).

**(b) Locked-decision tension to surface:** D-14's on-chain half ("executeRound reverts if any consumed id is nullified") is **impossible against a bare bytes32 root** — the contract must receive the id list. Recommended resolution: `executeRound(uint64 nonce, address[] participants, int256[] deltas, bytes32[] consumedIds, bytes[] signatures)` with `manifestHash = ManifestMerkle.rootOf(consumedIds)` derived internally (no mismatch possible; signatures over the digest transitively bind the exact id list). This changes the **ABI** of `executeRound` on the redeployed V2 hub while keeping the **signed Round struct byte-identical** — which is what MERK-01's "same bytes32 field, no interface change" protects (the digest fixtures prove it, D-11). Bonus: consumed ids in calldata make every round's leaf set permanently reconstructible from chain data — solving the data-availability problem for creditor proof generation with zero extra gas (vs ~27k/round for event emission). Downstream: regenerate `src/abi/ClearingHubV2.ts`, update `HubClient.executeRound` + coordinator submit, update `demo/e2e.ts` bytecode checks. Planner should flag this ABI note in the plan so the user sees MERK-01 vs D-14 was resolved deliberately.

## Common Pitfalls

### Pitfall 1: Fixture regeneration mistaken for parity breakage
**What goes wrong:** swapping `manifestHash`'s body changes `digest.json` values; a naive reading of D-11 ("existing digest fixtures must still pass") treats this as a violation and hacks around it.
**Why:** D-11 protects the *encoding* (Round struct, typehash, domain), not the sample values.
**Avoid:** regenerate via `npm run fixture` in the same plan step as the swap; parity tests recompute both sides and stay green.
**Warning sign:** any hand-edited value in `test/fixtures/*.json`.

### Pitfall 2: Withdrawal exit hollowing out redemption
**What goes wrong:** docs oversell redemption as guaranteed recovery; a vanishing debtor simply calls the never-pausable `withdraw` before going dark, leaving nothing to redeem.
**Why:** free collateral is a v1 invariant (D-12) — there is no lock, and there must not be one in the Net product.
**Avoid:** PROTOCOL.md must state plainly: redemption recovers *posted, still-present* collateral only; it is a race against exit, honest about being best-effort. Credit caps (`creditCap.ts`) remain the exposure bound. This is the "honest about calibration status" ethos applied to a mechanism.
**Warning sign:** README/PROTOCOL language implying collateralized *guarantee* of IOU recovery.

### Pitfall 3: Keep-alive griefing defeats the staleness gate
**What goes wrong:** a debtor ping-pongs dust IOUs with an accomplice each round, keeping `lastRound` fresh while refusing to ever net a specific creditor's paper — redemption gate never opens.
**Why:** on-chain staleness is a *liveness heuristic*, not an authorization boundary; participation is cheap.
**Avoid:** document in the griefing analysis (PROTOCOL.md addition): selective censorship by a live debtor is visible on-chain (creditor's IOUs never in manifests, debtor active), costs the debtor gas every round, and is out-of-protocol-scope to punish in the Net product. Do not attempt clever on-chain countermeasures this phase.
**Warning sign:** scope creep toward per-creditor participation tracking.

### Pitfall 4: On-chain "K windows" ≠ coordinator "K windows"
**What goes wrong:** D-07's prose says "missed K consecutive consent windows", but the on-chain criterion (D-06) counts *executed rounds without participation* — aborted rounds and idle periods advance no on-chain clock; coordinator miss counters (wall-clock windows) and the chain gate can disagree.
**Avoid:** PROTOCOL.md defines the on-chain gate as "absent from the last ≥ K executed rounds" and labels the coordinator counters as the off-chain early-warning signal only (D-09). e2e (D-17) must drive the *on-chain* condition (execute K rounds without the staller), not just tick the counter.
**Warning sign:** tests that assert redemption eligibility from `coordinator.missed` state.

### Pitfall 5: Proof set chosen by the prover
**What goes wrong:** `redeemIOU` accepts however many proofs the creditor sent; a round executed after proof generation is silently uncovered — or a malicious creditor omits exactly the root containing the IOU.
**Avoid:** the contract derives the required nonce range from its own `roundNonce`/`RING` and demands exactly one proof per buffered round, ordered; any gap reverts (see Pattern 4 rule 5). Property test: proofs array with one root skipped must revert.

### Pitfall 6: Never-participated debtor edge in `lastRound`
**What goes wrong:** storing raw `nonce` makes "participated in round 0" indistinguishable from "never participated" (both 0), silently mis-gating redemption.
**Avoid:** store `nonce + 1` (1-based; 0 = never). Decide and document the never-participated policy: stale once `roundNonce + 1 ≥ K` (they've ignored every window that ever existed). Unit-test both boundaries.

### Pitfall 7: Case-sensitivity drift between TS hex order and bytes32 order
**What goes wrong:** TS sorts hex strings lexicographically; mixed-case ids would sort differently from Solidity's numeric bytes32 order → different leaf order → different roots.
**Why it hasn't bitten yet:** `net()` lowercases ids before sorting (rule 1/7) [VERIFIED: src/netting.ts:39,58].
**Avoid:** `merkle.ts` must normalize ids to lowercase before sort/compare, and the parity fixture must include an id with uppercase-hex input to lock the normalization.

### Pitfall 8: Arc explicit-gas discipline forgotten on the new write
**What goes wrong:** `redeemIOU` via viem without explicit `gas` → estimation reserves the whole USDC balance → simulated transfer reverts (Arc gas-token gotcha).
**Avoid:** explicit `gas` + `maxFeePerGas: MIN_MAX_FEE_PER_GAS` in the new `HubClient.redeemIOU`, same as existing writes [VERIFIED: pattern in src/client.ts:70-118]. Deploy with `--with-gas-price 25gwei`.

## Code Examples

Sketches expressing the shared spec (source: this research's construction spec; primitives verified against existing repo usage of viem and OZ):

### TS: root + inclusion proof walk (`src/merkle.ts`)

```typescript
// Source: spec in this document (Pattern 2/3); viem primitives as used in src/round.ts
import { concat, keccak256, type Hex } from "viem";

const LEAF = "0x00" as Hex;
const NODE = "0x01" as Hex;
export const EMPTY_MANIFEST_ROOT: Hex = keccak256("0x"); // D-04 sentinel

const leafHash = (id: Hex): Hex => keccak256(concat([LEAF, id]));
const nodeHash = (l: Hex, r: Hex): Hex => keccak256(concat([NODE, l, r]));

/** Root over strictly-ascending unique lowercase ids. Empty -> v1 sentinel. */
export function merkleRoot(sortedIds: Hex[]): Hex {
  if (sortedIds.length === 0) return EMPTY_MANIFEST_ROOT;
  let level = sortedIds.map(leafHash);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let j = 0; j + 1 < level.length; j += 2) next.push(nodeHash(level[j], level[j + 1]));
    if (level.length % 2 === 1) next.push(level[level.length - 1]); // D-03: promote lone node
    level = next;
  }
  return level[0];
}
```

### Solidity: inclusion verification core (`ManifestMerkle.sol`)

```solidity
// Source: spec in this document; mirrors the TS walk exactly (parity-fixture-locked)
function verifyInclusion(InclusionProof calldata p, bytes32 root) internal pure returns (bool) {
    if (p.index >= p.leafCount) return false;
    bytes32 h = keccak256(abi.encodePacked(bytes1(0x00), p.leaf));
    uint256 i = p.index;
    uint256 w = p.leafCount;
    uint256 s; // siblings consumed
    while (w > 1) {
        if (i & 1 == 1) {
            h = keccak256(abi.encodePacked(bytes1(0x01), p.siblings[s++], h));
        } else if (i != w - 1) {
            h = keccak256(abi.encodePacked(bytes1(0x01), h, p.siblings[s++]));
        } // else: lone node promotes unchanged (D-03)
        i >>= 1;
        w = (w + 1) >> 1;
    }
    return s == p.siblings.length && h == root;
}
```

### Solidity: on-chain IOU digest (new `hashIou` in ClearingHubV2)

```solidity
// Typehash must byte-match IOU_TYPES in src/domain.ts (note uint64 expiry).
bytes32 private constant IOU_TYPEHASH = keccak256(
    "IOU(address debtor,address creditor,uint256 amount,uint256 nonce,uint64 expiry,bytes32 ref)"
);
function hashIou(Iou calldata iou) public view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(
        IOU_TYPEHASH, iou.debtor, iou.creditor, iou.amount, iou.nonce, iou.expiry, iou.ref
    )));
}
// Parity: assert hashIou(fixtureIou) == digest.json .iouId  (field already emitted today)
```

### TS: historical manifest reconstruction (creditor tooling)

```typescript
// Source: viem decodeFunctionData pattern; RoundExecuted logs already consumed in demo/coordinator.ts
// 1. getContractEvents RoundExecuted for nonces [roundNonce-k, roundNonce-1]
// 2. getTransaction(log.transactionHash) -> decodeFunctionData({ abi: clearingHubV2Abi, data: tx.input })
// 3. args.consumedIds is the exact leaf set (signature-bound via the digest) -> build proofs locally
```

## State of the Art

| Old Approach (v1/Phase 1) | Current Approach (this phase) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `manifestHash = keccak256(concat(sortedIds))` — post-hoc provable only by publishing the whole list | Sorted-leaf merkle root — per-id inclusion AND non-inclusion proofs | This phase | Same bytes32 field; fixture values regenerate |
| Manifest preimage known only to round participants | Consumed ids in `executeRound` calldata — reconstructible by anyone from chain history | This phase (D-14 enforcement side-effect) | Data availability for creditor proofs without trusting a coordinator |
| Unresponsiveness = coordinator-local miss counters (Phase 1 D-06) | On-chain `lastRound` staleness written in `executeRound`; counters demoted to early warning (D-09) | This phase | Zero-authority redemption gate |
| "No individual IOU redemption on-chain" (PROTOCOL.md explicit non-goal) | `redeemIOU` recovery path | This phase | PROTOCOL.md non-goals section must be updated (supersession note, like the threshold-consent one) |
| ClearingHubV2 = near-verbatim v1 copy (Phase 1 D-09) | V2 grows redemption machinery in place (D-10) | This phase | Phase-1 V2 hubs superseded by phase-end redeploy (D-11) |

**Deprecated/outdated within this project:** the "coordinator publishes the id list" model of manifest transparency — replaced by calldata reconstruction.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | EVM gas constants used for estimates (SLOAD cold 2100, SSTORE update ~2900–5k/new 20k, calldata 16/nonzero byte) match Arc Testnet's EVM config | Critical Q4 | Gas formula miscalibrated — mitigated: forge measurement is a planned in-phase step and Arc runs a standard EVM `[ASSUMED]` |
| A2 | v1's real 105-IOU round consumed well under 1.1M gas (leaving ~400k headroom in the 1.5M limit) | Critical Q4 | executeRound with ids could exceed 1.5M at demo scale sooner than expected; the parameterized-gas recommendation covers it either way `[ASSUMED — verifiable from the recorded v1 tx 0x64f3…cf69 on arcscan]` |
| A3 | Promotion-variant soundness argument (lying leafCount/index requires a keccak collision) | Pattern 3 | A structural forgery of "last leaf" claims → false non-inclusion → wrongful redemption. Mitigation is mandatory: adversarial fast-check + Foundry fuzz vectors are Wave-0 test requirements, and the argument should be written into PROTOCOL.md for review `[ASSUMED — own analysis]` |
| A4 | Solady MerkleProofLib is also commutative (no viable third-party ordered-tree lib exists) | Don't Hand-Roll | None — OZ's documented limitation alone already justifies the hand-roll `[ASSUMED]` |
| A5 | 60s netting safety window ≥ proposal-to-execution latency on Arc (so consumption rounds execute strictly before IOU expiry) | Critical Q1 fact 2 | A round could consume an IOU marginally after `E`; coverage window `[E−L, E)` would miss it. Cheap hardening if desired: use `E − L` vs `E + safetyWindow` bounds; flag for planner `[ASSUMED]` |
| A6 | MERK-01's "no ClearingHub interface change" scopes to the manifestHash bytes32 field / signed Round struct, not to `executeRound`'s ABI on the redeployed V2 (which D-14's on-chain nullifier check forces to change) | Critical Q5b | If the user intended a frozen `executeRound` ABI, D-14's on-chain half is unimplementable and must be renegotiated (off-chain-only filtering). Surface at plan review `[ASSUMED — resolved from decision-text analysis]` |
| A7 | `L = MAX_IOU_LIFETIME` default (suggest 24h) and its interaction with k=16/K=3 are acceptable as uncalibrated labels pending Phase 3 | Critical Q1 | Redemption window too narrow/wide in practice — calibration is explicitly deferred; label per project convention `[ASSUMED]` |

## Open Questions (RESOLVED)

> All three resolved by plan 02-04 objective locks: redeemIOU pausable (withdraw alone unpausable); coverage uses executedAt(oldest) < expiry - L with A5 documented; lastRound written for ALL participants incl. zero-delta.

1. **Should `redeemIOU` be pausable?**
   - What we know: `withdraw` must never be pausable (D-12); `executeRound`/`deposit` are pausable circuit-breakers; redemption moves funds between collateral accounts like a round does.
   - What's unclear: whether the owner being able to pause the *recovery* path conflicts with the product story.
   - Recommendation: pausable (bug circuit-breaker parity with `executeRound`); the exit guarantee lives in `withdraw` alone. Planner may lock either way — one-line change.
2. **A5 boundary hardening:** use `executedAt(oldest) < E − L` (recommended, simple) vs a belt-and-braces `E − L − safetyWindow`. Recommend the simple bound plus a documented assumption; decide at plan time.
3. **`lastRound` for zero-delta participants:** a participant with delta 0 still consents (their paper was consumed) and should count as participation — `executeRound` writes for all participants, which is the natural reading of D-06. Confirm in plan (affects the keep-alive griefing surface, Pitfall 3).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | SDK/tests/scripts | ✓ | v24.11.1 | — |
| npm + package-lock | TS deps | ✓ | (bundled) | — |
| forge | contracts build/test/deploy | ✓ | 1.3.5-stable | — |
| anvil | local e2e (`npm run e2e:anvil`) | ✓ (bundled with Foundry 1.3.5) | — | testnet e2e |
| viem | merkle + calldata decode | ✓ | 2.55.5 installed | — |
| Arc Testnet RPC + funded `DEPLOYER_PK` | phase-end redeploy (D-11) | assumed (used in Phase 1 wave 5) | chain 5042002 | deploy step is human-gated anyway (keys in .env) |

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1 + fast-check 3.22 (TS); forge 1.3.5 (Solidity, 512-run fuzz) |
| Config file | `vitest.config.ts`, `contracts/foundry.toml` |
| Quick run command | `npx vitest run test/merkle.test.ts` / `cd contracts && forge test --match-contract ManifestMerkle -vvv` |
| Full suite command | `npm test && npm run test:contracts` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MERK-01 | Root fills the same bytes32 field; Round digest encoding unchanged | parity | `cd contracts && forge test --match-contract 'DigestParity|ClearingHubV2Parity'` (after `npm run fixture`) | ✅ exists (values regenerate) |
| MERK-02 | TS↔Sol byte-identical roots + inclusion + non-inclusion | unit/property/parity | `npx vitest run test/merkle.test.ts`; `forge test --match-contract 'ManifestMerkle|MerkleParity'` | ❌ Wave 0 |
| MERK-02 | Root determinism under shuffle; adversarial index/count lies rejected | property (fast-check + forge fuzz) | same as above | ❌ Wave 0 |
| MERK-03 | redeemIOU happy path + full revert matrix (stale gate, coverage rule, bad sig, missing proof, sentinel rounds, insufficient collateral) | unit (forge, RoundBuilder-style harness) | `forge test --match-contract ClearingHubV2` | ❌ Wave 0 |
| MERK-04 | Nullifier idempotence; redeem→cannot-net (executeRound reverts on nullified id); net→cannot-redeem (non-inclusion fails vs containing root); L-coverage fail-closed | unit + fuzz | `forge test --match-test 'test_.*redeem|testFuzz_.*redeem'` | ❌ Wave 0 |
| D-17 | e2e: stall past K executed rounds → redeem → debtor debited → id never settles later | e2e (anvil) | `npm run e2e:anvil` | ✅ extend `demo/e2e.ts` |
| Gas report | executeRound m∈{10,105,250}; redeemIOU k=16 | gas snapshot | `cd contracts && forge snapshot --match-test 'test_gas'` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted vitest file + `forge test --match-contract <touched>`
- **Per wave merge:** `npm test && npm run test:contracts`
- **Phase gate:** full suite + `npm run e2e:anvil` green before `/gsd:verify-work`; testnet redeploy + `e2e:testnet` at phase end (D-11)

### Wave 0 Gaps
- [ ] `test/merkle.test.ts` — MERK-02 properties (shuffle determinism, verify/reject, bracketing edges, case-normalization)
- [ ] `contracts/test/ManifestMerkle.t.sol` — unit + adversarial fuzz (index/count lies, node-as-leaf, duplicate promotion)
- [ ] `contracts/test/MerkleParity.t.sol` — reads `test/fixtures/merkle.json`
- [ ] `test/genFixture.ts` extension — `merkle.json` vectors + `iouSig` field in `digest.json`
- [ ] `contracts/test/ClearingHubV2.t.sol` — redeemIOU revert matrix + exclusivity + gas tests (model on `ClearingHub.t.sol`/`RoundBuilder.sol`; harness needs a V2 variant since RoundBuilder pins v1)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (signature = authorization) | OZ ECDSA + EIP-712 (existing); debtor sig gates redemption |
| V3 Session Management | no | — |
| V4 Access Control | yes | Permissionless-by-signature model; owner limited to pause (never withdraw); no new coordinator authority (D-06) |
| V5 Input Validation | yes | Custom-error revert matrix on every redeemIOU/executeRound input; contract derives required proof set itself (Pitfall 5) |
| V6 Cryptography | yes | keccak256 primitive only; RFC 6962 domain separation; never hand-roll signature recovery — merkle structure is the sole justified hand-roll, spec-locked |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Merkle second-preimage (node-as-leaf) | Spoofing/Tampering | 0x00/0x01 prefixes (RFC 6962) + fixture negative vectors |
| Ambiguous tree via odd-node duplication (CVE-2012-2459 class) | Tampering | Lone-node promotion (D-03) + `root([a,b,c]) != root([a,b,c,c])` test |
| Forged "last leaf" / leafCount lie | Elevation | Schedule-binding verification + adversarial fuzz (A3) |
| Double-claim: net then redeem past buffer | Tampering (funds) | L-bounded coverage rule (Critical Q1) — fail-closed |
| Double-claim: redeem then net | Tampering | Nullifier + on-chain id check in executeRound (D-14) + off-chain filtering |
| Redemption replay | Replay | Nullifier keyed by EIP-712 id (chain- and hub-bound domain kills cross-hub replay) |
| Race: round lands between proof generation and redeem tx | TOCTOU | Contract-derived proof-set requirement → count/nonce mismatch reverts |
| Debtor exit before redemption | Repudiation-ish | Unfixable by design (withdraw never pausable) — document honestly (Pitfall 2) |
| Keep-alive censorship griefing | DoS | Documented limitation; miss counters + on-chain visibility (Pitfall 3) |
| Gas estimation on Arc (USDC gas token) | DoS | Explicit gas on all writes; parameterized executeRound limit (Critical Q4) |

## Sources

### Primary (HIGH confidence)
- Codebase reads (all files in `<files_to_read>` plus `package.json`, `foundry.toml`, `RoundBuilder.sol`, `src/abi/`, `demo/e2e.ts` greps) — current post-Phase-1 state verified directly
- `/websites/openzeppelin_contracts_5_x` (Context7) — MerkleProof commutative-only limitation, 64-byte-leaf second-preimage warning, Hashes.commutativeKeccak256
- RFC 6962 (datatracker.ietf.org/doc/html/rfc6962) — 0x00/0x01 prefix domain separation, shape-uniqueness by leaf count
- `.planning/` artifacts: 02-CONTEXT.md, 01-CONTEXT.md, REQUIREMENTS.md, STATE.md, config.json; `docs/V2-BRIEF.md`, `docs/PROTOCOL.md`

### Secondary (MEDIUM confidence)
- Own soundness analysis of promotion-variant proof binding (A3) — to be property-tested and written into PROTOCOL.md

### Tertiary (LOW confidence)
- Gas estimates from standard EVM cost tables (A1, A2) — superseded by in-phase `forge snapshot` measurements

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; every primitive already in use in this repo
- Merkle construction & domain separation: HIGH — locked decisions + RFC 6962 citation + OZ limitation verified
- Proof-encoding soundness (promotion variant): MEDIUM — own analysis, mandatory adversarial tests specified
- D-15 rule (L-bounded coverage): HIGH on safety logic, MEDIUM on parameter ergonomics (uncalibrated by design)
- Gas: MEDIUM — estimates only; measurement is a planned deliverable

**Research date:** 2026-07-23
**Valid until:** ~2026-08-22 (stable domain: pinned toolchain, vendored deps, standards-based crypto)
