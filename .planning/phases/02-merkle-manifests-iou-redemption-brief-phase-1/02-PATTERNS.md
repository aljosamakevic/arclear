# Phase 2: Merkle Manifests & IOU Redemption - Pattern Map

**Mapped:** 2026-07-23
**Files analyzed:** 17 new/modified files
**Analogs found:** 16 / 17 (ManifestMerkle.sol has no library-form analog; conventions map from ClearingHubV2.sol)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/merkle.ts` (NEW) | utility (pure SDK module) | transform | `src/netting.ts` (spec-comment pure fn) + `src/round.ts:19-22` (hash primitives) | exact |
| `src/round.ts` (MOD) | service (round protocol) | transform | itself — `manifestHash` body swap only | exact |
| `src/client.ts` (MOD) | service (contract gateway) | request-response | itself — `executeRound`/`deposit`/`hashRound` methods | exact |
| `src/index.ts` (MOD) | config (barrel) | — | itself | exact |
| `src/abi/ClearingHubV2.ts` (REGEN) | config (ABI) | — | itself — pasted from `contracts/out` after `forge build` | exact |
| `contracts/src/lib/ManifestMerkle.sol` (NEW) | utility (Solidity library) | transform | `ClearingHubV2.sol` conventions (no library exists yet) | role-partial |
| `contracts/src/ClearingHubV2.sol` (MOD) | contract (settlement) | CRUD (collateral state) | itself + `ClearingHub.sol` function anatomy | exact |
| `contracts/test/ManifestMerkle.t.sol` (NEW) | test (unit+fuzz) | — | `contracts/test/ClearingHubFuzz.t.sol` | role-match |
| `contracts/test/MerkleParity.t.sol` (NEW) | test (fixture parity) | file-I/O | `contracts/test/DigestParity.t.sol` | exact |
| `contracts/test/ClearingHubV2.t.sol` (NEW) | test (revert matrix) | — | `contracts/test/ClearingHub.t.sol` | exact |
| `contracts/test/utils/RoundBuilderV2.sol` (NEW, implied) | test harness | — | `contracts/test/utils/RoundBuilder.sol` (pins v1 — needs V2 variant) | exact |
| `test/merkle.test.ts` (NEW) | test (property) | — | `test/netting.test.ts` | exact |
| `test/genFixture.ts` (MOD) | test tooling (generator) | file-I/O | itself | exact |
| `test/fixtures/merkle.json` (NEW, generated) | fixture | file-I/O | `test/fixtures/digest.json` shape | exact |
| `demo/coordinator.ts` (MOD) | service (orchestrator) | event-driven | itself — `settledIds` filtering + `getContractEvents` reconciliation | exact |
| `demo/e2e.ts` (MOD) | test (e2e script) | request-response | itself — `check()` + stall-scenario structure | exact |
| `contracts/script/DeployV2.s.sol` (MOD) | script (deploy) | — | itself | exact |
| `docs/PROTOCOL.md` (MOD) | docs | — | itself — numbered-rule spec sections + "Explicit non-goals" supersession note | exact |

## Pattern Assignments

### `src/merkle.ts` (utility, transform)

**Analogs:** `src/netting.ts` (module shape) + `src/round.ts` (primitives)

**Imports pattern** — viem-only, named imports, `.js` suffix on local imports (`src/round.ts:1-12`):
```typescript
import {
  concat,
  hashTypedData,
  keccak256,
  ...
  type Address,
  type Hex,
} from "viem";
import type { NetResult, RoundProposal, SignedIou } from "./types.js";
```

**Core pattern — pure function with numbered-rule doc comment cross-referenced to PROTOCOL.md** (`src/netting.ts:4-28`):
```typescript
/**
 * Deterministic multilateral netting. Pure function; bigint arithmetic only —
 * there is no division anywhere in the protocol.
 *
 * Rules (spec: docs/PROTOCOL.md — third parties must implement identically):
 * 1. Dedup by IOU id (identical ids are the same obligation).
 * ...
 * Output invariant: deltas sum to exactly 0n.
 */
export function net(
  ious: SignedIou[],
  opts: {
    now: bigint;
    safetyWindowSeconds?: bigint;
    settledIds?: ReadonlySet<Hex>;
  },
): NetResult {
```
merkle.ts must carry the same style: numbered construction rules (leaf prefix, ordered pair, promotion, sentinel) in the doc comment, inline `// rule N` markers, `docs/PROTOCOL.md` cross-reference.

**Sentinel + hash primitive to preserve** — the empty-manifest branch being replaced (`src/round.ts:19-22`):
```typescript
export function manifestHash(sortedIds: Hex[]): Hex {
  if (sortedIds.length === 0) return keccak256("0x");   // D-04: keep this sentinel
  return keccak256(concat(sortedIds));                   // body being swapped to merkleRoot
}
```

**Case-normalization pattern (Pitfall 7)** — explicit lowercase transform before sort/compare (`src/netting.ts:39,55`):
```typescript
const id = s.id.toLowerCase() as Hex;
...
const sortedAddrs = [...positions.keys()].sort(); // rule 5 (hex lexicographic == numeric)
```

**Validation pattern** — check-X-against-Y functions return `{ ok, reason? }`, never throw (`src/round.ts:130-134`):
```typescript
): { ok: boolean; reason?: string } {
  if (opts.expectedRoundNonce !== undefined && proposal.roundNonce !== opts.expectedRoundNonce) {
    return {
      ok: false,
      reason: `roundNonce mismatch: proposal says ${proposal.roundNonce}, local chain view says ${opts.expectedRoundNonce}`,
    };
  }
```
Use for `verifyInclusion`/`verifyNonInclusion` TS mirrors if callers branch on failure; plain `throw new Error` with interpolated values (`src/iou.ts:40`) for build-time precondition violations (unsorted/duplicate input to `merkleRoot`).

---

### `src/round.ts` (service, transform) — MODIFIED

**Analog:** itself. The swap is a single choke point:

- `manifestHash()` at `src/round.ts:19-22` — replace body with `merkleRoot(sortedIds)` (import from `./merkle.js`); keep the exported name and signature so `buildProposal` (`:58`), `verifyProposal` (`:179`), and `test/genFixture.ts:40` are untouched.
- The doc comment at `:14-18` already anticipates this: "v2 can swap in a merkle root … without touching the contract" — rewrite it to state the merkle construction reference.
- `verifyProposal`'s check at `:179-181` (`manifestHash(proposal.consumedIds) !== proposal.manifestHash`) transparently becomes a root check. No other edits.

---

### `src/client.ts` (service gateway, request-response) — MODIFIED

**Analog:** itself.

**Read pattern** (`src/client.ts:32-39`):
```typescript
collateral(participant: Address): Promise<bigint> {
  return this.pub.readContract({
    address: this.hub,
    abi: clearingHubAbi,
    functionName: "collateral",
    args: [participant],
  });
}
```
Copy for new reads: `lastRound(addr)`, `redeemed(id)`, `rootRing(slot)`, `hashIou(iou)`. Note `roundNonce()` wraps with `.then(BigInt)` (`:41-45`) — uint64 returns may arrive as number; keep that coercion for new uint64 reads.

**Write pattern with Arc explicit-gas discipline** (`src/client.ts:97-118`) — every write sets `maxFeePerGas: MIN_MAX_FEE_PER_GAS` and an explicit `gas` (never estimation):
```typescript
async executeRound(
  wallet: WalletClient,
  proposal: RoundProposal,
  signatures: Hex[],
): Promise<Hex> {
  return wallet.writeContract({
    address: this.hub,
    abi: clearingHubAbi,
    functionName: "executeRound",
    args: [
      proposal.roundNonce,
      proposal.participants,
      proposal.deltas,
      proposal.manifestHash,
      signatures,
    ],
    chain: wallet.chain,
    account: wallet.account!,
    maxFeePerGas: MIN_MAX_FEE_PER_GAS,
    gas: 1_500_000n,
  });
}
```
Changes: `executeRound` args swap `proposal.manifestHash` → `proposal.consumedIds` (D-14/Q5b ABI change); replace `1_500_000n` with the size-parameterized formula from RESEARCH Q4; new `redeemIOU` write copies this method shape with its own explicit limit (~800k envelope per research). NOTE: `src/client.ts` currently imports `clearingHubAbi` (v1) — verify which ABI the V2 paths use (demo uses `clearingHubV2Abi` from `src/abi/ClearingHubV2.ts`); new methods must target the regenerated V2 ABI.

**MIN_MAX_FEE_PER_GAS source** (`src/domain.ts:28`): `export const MIN_MAX_FEE_PER_GAS = 25_000_000_000n; // 25 gwei`

---

### `src/index.ts` (barrel) — MODIFIED

Flat `export *` list in dependency order (`src/index.ts:1-7`). Insert `export * from "./merkle.js";` after `./netting.js`, before `./round.js` (round.ts will import merkle.ts):
```typescript
export * from "./types.js";
export * from "./domain.js";
export * from "./iou.js";
export * from "./netting.js";
export * from "./merkle.js";   // NEW — before round (round imports it)
export * from "./round.js";
export * from "./creditCap.js";
export * from "./client.js";
```

---

### `contracts/src/lib/ManifestMerkle.sol` (Solidity library, transform) — NEW

**Analog:** no library exists in the codebase — copy *conventions* from `contracts/src/ClearingHubV2.sol`:

- Header: `// SPDX-License-Identifier: MIT` + `pragma solidity 0.8.26;` pinned exactly (`ClearingHubV2.sol:1-2`).
- `/// @title` + `/// @notice` + `/// @dev` block on the library itself, matching the density of `ClearingHubV2.sol:12-29`.
- Custom errors, PascalCase, no `Error` suffix, diagnostic params (`ClearingHubV2.sol:60-68`):
```solidity
error LengthMismatch();
error WrongRoundNonce(uint64 expected, uint64 provided);
error BadSignature(uint256 index);
```
(library verify functions may instead return `bool` per the research sketch — reserve errors for structural misuse like `index >= leafCount`; pick one and mirror in TS).
- Loop style: bare `i`, pre-increment `++i` in for loops (`ClearingHubV2.sol:122`); the level-walk sketch in RESEARCH Code Examples (`verifyInclusion`) is the spec to implement.
- Hashing: `keccak256(abi.encodePacked(bytes1(0x00), leaf))` / `keccak256(abi.encodePacked(bytes1(0x01), l, r))` — mirrors TS `keccak256(concat([LEAF, id]))` byte-for-byte (parity-fixture-locked).
- Foundry remappings already cover imports (`@openzeppelin/=lib/openzeppelin-contracts/`); the library itself should need no imports.

---

### `contracts/src/ClearingHubV2.sol` (contract, CRUD) — MODIFIED

**Analog:** itself. Function anatomy to replicate for `redeemIOU` and the `executeRound` additions:

**State + immutable declaration block** (`ClearingHubV2.sol:33-45`):
```solidity
/// @notice The single ERC-20 this hub clears. ...
IERC20 public immutable token;

/// @notice Nonce of the next round to execute; increments once per round.
uint64 public roundNonce;

/// @notice Free collateral per participant, in token base units.
mapping(address => uint256) public collateral;

bytes32 private constant ROUND_TYPEHASH = keccak256(
    "Round(uint64 roundNonce,address[] participants,int256[] deltas,bytes32 manifestHash)"
);
```
New state (rootRing, lastRound, redeemed, K/RING/MAX_IOU_LIFETIME immutables, IOU_TYPEHASH) follows this shape: NatSpec'd public state, `private constant` typehashes. Append-only ordering per RESEARCH Pattern 4 note. Constructor gains the uncalibrated params — current constructor (`:70-72`):
```solidity
constructor(IERC20 token_) EIP712("ArcClearingHub", "1") Ownable(msg.sender) {
    token = token_;
}
```
Keep `EIP712("ArcClearingHub", "1")` byte-identical (digest fixtures depend on it).

**Guarded external function anatomy** (`ClearingHub`/`V2` `executeRound`, `:106-151`): full `@notice`/`@param` NatSpec, `whenNotPaused nonReentrant` modifiers, custom-error checks first, digest via `hashRound`, verify loop with `ECDSA.recover(digest, signatures[i]) != p → revert BadSignature(i)`, effects loop with `InsufficientCollateral(p, balance, debit)` diagnostics, event emission last. `redeemIOU` copies this ordering (checks → nullifier write → collateral debit/credit → event).

**Collateral debit pattern to reuse in `redeemIOU`** (`ClearingHubV2.sol:137-146`):
```solidity
if (delta < 0) {
    uint256 debit = uint256(-delta);
    if (balance < debit) revert InsufficientCollateral(p, balance, debit);
    newBalance = balance - debit;
} else {
    settledVolume += uint256(delta);
    newBalance = balance + uint256(delta);
}
collateral[p] = newBalance;
emit PositionSettled(nonce_, p, delta, newBalance);
```

**Public digest helper pattern for the new `hashIou`** (`ClearingHubV2.sol:153-172`):
```solidity
/// @notice EIP-712 digest every participant signs. Public so off-chain
///         implementations can assert encoding parity against the chain.
function hashRound(
    uint64 nonce_,
    address[] calldata participants,
    int256[] calldata deltas,
    bytes32 manifestHash
) public view returns (bytes32) {
    return _hashTypedDataV4(
        keccak256(
            abi.encode(
                ROUND_TYPEHASH,
                nonce_,
                keccak256(abi.encodePacked(participants)),
                keccak256(abi.encodePacked(deltas)),
                manifestHash
            )
        )
    );
}
```
`hashIou` follows the same shape with `IOU(address debtor,address creditor,uint256 amount,uint256 nonce,uint64 expiry,bytes32 ref)` — field order/types must byte-match `IOU_TYPES` in `src/domain.ts:45-54` (note `expiry` is `uint64`).

**Withdraw invariant — do not touch** (`ClearingHubV2.sol:83-94`): `withdraw` has no `whenNotPaused`; its NatSpec documents why. Carried unconditionally (D-12).

**`executeRound` signature change** (Q5b): `bytes32 manifestHash` param → `bytes32[] calldata consumedIds`; derive `manifestHash = ManifestMerkle.rootOf(consumedIds)` internally; add per-id nullifier check, `rootRing` write, and `lastRound[p] = nonce_ + 1` in the existing participant loop (`:132-147`). The `RoundExecuted` event (`:49-55`) keeps its `manifestHash` field (now the root).

---

### `contracts/test/utils/RoundBuilderV2.sol` (test harness) — NEW (implied)

**Analog:** `contracts/test/utils/RoundBuilder.sol` — it pins v1 (`import {ClearingHub}` at `:6`, `hub = new ClearingHub(usdc)` at `:31`, `_digest` reads `address(hub)` at `:107`). A V2 variant is required, not an edit — v1 tests keep using the original.

Copy wholesale, changing: contract type to `ClearingHubV2` with the new constructor params (K, RING, L), `_simpleRound`-style helpers gaining `consumedIds`, and a `_signIou(pk, Iou)` helper mirroring `_signRound` (`RoundBuilder.sol:69-79`):
```solidity
function _signRound(
    uint256 pk,
    uint64 nonce_,
    address[] memory participants,
    int256[] memory deltas,
    bytes32 manifestHash
) internal view returns (bytes memory) {
    bytes32 digest = _digest(nonce_, participants, deltas, manifestHash);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
    return abi.encodePacked(r, s, v);
}
```
`MockUSDC` (`RoundBuilder.sol:8-18`) is importable as-is — do not duplicate it. The actor derivation + address sort (`:29-52`) copies unchanged. The local `_digest` mirror (`:82-111`) shows how to reproduce the EIP-712 domain (`"ArcClearingHub"`, `"1"`, `block.chainid`, `address(hub)`) for memory arrays — the IOU digest mirror follows the same recipe.

---

### `contracts/test/ClearingHubV2.t.sol` (revert-matrix test) — NEW

**Analog:** `contracts/test/ClearingHub.t.sol`.

**Test naming + revert-matrix pattern** (`ClearingHub.t.sol:105-118`):
```solidity
function test_revert_wrongNonce() public {
    (address[] memory p, int256[] memory d) = _simpleRound();
    bytes[] memory sigs = _buildSignatures(7, p, d, MANIFEST);
    vm.expectRevert(abi.encodeWithSelector(ClearingHub.WrongRoundNonce.selector, 0, 7));
    hub.executeRound(7, p, d, MANIFEST, sigs);
}
```
Conventions: `test_` / `testFuzz_` prefixes, `_revert` segment for negatives, `vm.expectRevert(Contract.Err.selector)` for bare errors and `abi.encodeWithSelector(...)` for parameterized ones, section-divider comments (`// ------- revert matrix`).

**Invariant assertions after settlement** (`ClearingHub.t.sol:75-81`): per-actor collateral, `roundNonce` bump, hub-token-balance conservation (`assertEq(usdc.balanceOf(address(hub)), 15e6)`) — redeemIOU tests must assert the same conservation (collateral moves debtor→creditor, hub balance untouched).

**Event assertion pattern** (`ClearingHub.t.sol:71-73`):
```solidity
vm.expectEmit(true, true, false, true);
emit ClearingHub.RoundExecuted(0, _digest(0, p, d, MANIFEST), MANIFEST, 3, 3e6);
hub.executeRound(0, p, d, MANIFEST, sigs);
```

**Pause-boundary test to replicate for redeemIOU pausability decision** (`ClearingHub.t.sol:41-47`, `test_withdraw_worksWhilePaused`).

**Fuzz pattern for exclusivity/adversarial tests** (`ClearingHubFuzz.t.sol:68-92`, `testFuzz_perturbationAlwaysReverts`): seed-driven tamper, `vm.expectRevert()` generic, then `assertEq(hub.roundNonce(), 0, "state must be untouched")` — copy for "proofs array with one root skipped must revert" and nullifier idempotence.

---

### `contracts/test/MerkleParity.t.sol` (fixture parity) — NEW

**Analog:** `contracts/test/DigestParity.t.sol` (whole file, 40 lines).

**Fixture-read pattern** (`DigestParity.t.sol:13-26`):
```solidity
function test_digestMatchesSdkFixture() public {
    string memory json = vm.readFile("../test/fixtures/digest.json");

    address hubAddr = vm.parseJsonAddress(json, ".hub");
    uint256 chainId = vm.parseJsonUint(json, ".chainId");
    uint64 nonce_ = uint64(vm.parseJsonUint(json, ".roundNonce"));
    address[] memory participants = vm.parseJsonAddressArray(json, ".participants");
    int256[] memory deltas = vm.parseJsonIntArray(json, ".deltas");
    bytes32 manifestHash = vm.parseJsonBytes32(json, ".manifestHash");
    ...
```
`foundry.toml` `fs_permissions` already grants read on `../test/fixtures` — read `merkle.json` the same way, no config change. `vm.parseJsonBytes32Array` handles leaf/sibling arrays; for nested proof vectors prefer flat top-level keys (`.case3.root`, `.case3.proof0.siblings`) since `vm.parseJson*` addresses by JSON path.

**Domain-recreation pattern for `hashIou` parity** (`DigestParity.t.sol:29-38`) — needed because the fixture domain pins chain 5042002 and a fixed hub address:
```solidity
vm.chainId(chainId);
MockUSDC usdc = new MockUSDC();
deployCodeTo("ClearingHub.sol:ClearingHub", abi.encode(address(usdc)), hubAddr);
ClearingHub hub = ClearingHub(hubAddr);

bytes32 onchain = hub.hashRound(nonce_, participants, deltas, manifestHash);
assertEq(onchain, expectedDigest, "TS and Solidity round digests diverge");

// viem signature must recover on-chain: locks the whole signing path.
assertEq(ECDSA.recover(onchain, consent0), signer0, "consent signature recovery diverges");
```
For V2 use the `ClearingHubV2Parity.t.sol:32` variant: `deployCodeTo("ClearingHubV2.sol:ClearingHubV2", abi.encode(...constructor args...), hubAddr)` — note the V2 constructor now takes extra params; the `abi.encode` must include them. The `hashIou` parity assertions (`hub.hashIou(iou) == fixture.iouId`; `ECDSA.recover(hashIou, iouSig) == debtor`) extend `ClearingHubV2Parity.t.sol` or live here.

Pure-merkle parity (rootOf/verify against `merkle.json`) needs no hub deployment at all — a bare `Test` contract calling the library suffices.

---

### `test/merkle.test.ts` (property test) — NEW

**Analog:** `test/netting.test.ts`.

**Imports + deterministic fake-data helper** (`test/netting.test.ts:1-31`):
```typescript
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { net } from "../src/netting.js";
...
function fakeIou(...): SignedIou {
  const id = keccak256(toHex(`${debtor}|${creditor}|${amount}|${nonce}|${expiry}`)) as Hex;
  ...
}
```
For merkle tests, generate arbitrary bytes32 ids the same way (`keccak256(toHex(...))` from fc integers) — no signing needed.

**Arbitrary + property pattern** (`test/netting.test.ts:33-53`):
```typescript
const arbIou = fc
  .record({ d: fc.integer({ min: 0, max: 5 }), ... })
  .filter(({ d, c }) => d !== c)
  .map(({ d, c, amount, nonce }) => fakeIou(ADDRS[d], ADDRS[c], amount, nonce));

const arbIous = fc.array(arbIou, { minLength: 0, maxLength: 200 });

describe("netting engine properties", () => {
  it("deltas always sum to zero", () => {
    fc.assert(
      fc.property(arbIous, (ious) => {
        const r = net(ious, { now: NOW });
        expect(r.deltas.reduce((a, b) => a + b, 0n)).toBe(0n);
      }),
    );
  });
```

**Shuffle-determinism property to copy directly** (`test/netting.test.ts:55-67`) — the Fisher-Yates-over-`fc.infiniteStream(fc.nat())` shuffle is exactly the D-16 "root determinism under shuffle" test:
```typescript
it("is deterministic under input shuffling", () => {
  fc.assert(
    fc.property(arbIous, fc.infiniteStream(fc.nat()), (ious, rand) => {
      const shuffled = [...ious];
      const it_ = rand[Symbol.iterator]();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = (it_.next().value as number) % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(net(shuffled, { now: NOW })).toEqual(net(ious, { now: NOW }));
    }),
  );
});
```
Also copy the concrete-example style for edge cases (`:139-150`, circular flows) for: single-leaf tree, `root([a,b,c]) != root([a,b,c,c])`, uppercase-hex normalization, id-equals-leaf rejection.

---

### `test/genFixture.ts` (fixture generator) — MODIFIED

**Analog:** itself (72 lines, whole file is the pattern).

**Deterministic construction** (`test/genFixture.ts:15-39`): fixed `HUB` address, fixed private keys sorted by address, one canonical `Iou` with `iouId(HUB, iou)`. Extend, don't fork:
- add `iouSig` via `signIou(HUB, iou, accounts[0])` (debtor is `participants[0]` — signer key already at hand),
- emit `merkle.json` alongside `digest.json` with roots/proof vectors for leaf counts {0,1,2,3,5,8} incl. an uppercase-hex input id.

**Serialization + write pattern** (`test/genFixture.ts:55-72`):
```typescript
const fixture = {
  hub: HUB,
  chainId: 5042002,
  roundNonce: 0,
  participants,
  deltas: deltas.map(String),   // bigints stringified for JSON
  manifestHash: mh,
  digest,
  iouId: id,
  signer0: participants[0],
  consent0: consent,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "digest.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
```
NOTE: `digest.json` values (`manifestHash`, `digest`, `consent0`) change when `manifestHash()` becomes a merkle root — regenerate via `npm run fixture` in the same plan step as the swap (Pitfall 1); never hand-edit.

---

### `demo/coordinator.ts` (orchestrator, event-driven) — MODIFIED

**Analog:** itself. Redeemed-ids filtering slots into the existing `settledIds` machinery:

- Open-IOU filter (`demo/coordinator.ts:368`): `this.ious.filter((s) => !this.settledIds.has(s.id.toLowerCase() as Hex))` — redeemed ids can either fold into `settledIds` or a parallel `redeemedIds` set passed through `net()` opts (D-14; `net()` opts already accept `settledIds: ReadonlySet<Hex>`, `src/netting.ts:26`).
- Event-reconciliation pattern to copy for watching `IouRedeemed` (`demo/coordinator.ts:382-400`): `pendingSubmission` is folded iff its `RoundExecuted` log is on-chain via `this.pub.getContractEvents({ ..., eventName: "RoundExecuted", ... })`; ids join sets as `id.toLowerCase() as Hex` only on confirmed settlement (`:549-550`).
- Miss counters (`:158-172`, `applyMissSemantics`) stay untouched — demoted to early-warning only (D-09); do not wire them to redemption eligibility (Pitfall 4).
- Submission path (`:477-493`) passes `proposal` to `hubClient.executeRound` — updates transparently when the client signature gains `consumedIds` (already on `RoundProposal`).

---

### `demo/e2e.ts` (e2e script) — MODIFIED

**Analog:** itself.

**check() pattern** (`demo/e2e.ts:25-29`):
```typescript
let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`[e2e] ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}
```

**Stall-scenario structure to extend for the redemption scenario** (`demo/e2e.ts:130-226`): explicit far-expiry IOUs touching the staller via `signIou` with per-pair nonce map (`:134-158`), `staller.stalled = true`, snapshot → `coordinator.runRound(now(), 2_000)` → per-persona delta assertions via `assertDeltas` (`:66-77`), consumed-manifest set-difference checks (`:193-199`). The redemption extension drives the *on-chain* condition — execute ≥ K rounds without the staller (Pitfall 4) — then `hubClient.redeemIOU(...)`, assert debtor debited / creditor credited to the base unit, and assert the redeemed id never appears in a later round's consumed set (reuse the disjointness check at `:221-224`).

**Bytecode-tail guard** (`demo/e2e.ts:38-46`) — the 53-byte CBOR metadata-tail compare against `clearingHubV2Bytecode` still works after regeneration; it recompiles into the new artifact automatically.

---

### `contracts/script/DeployV2.s.sol` (deploy script) — MODIFIED

**Analog:** itself (whole 22-line file):
```solidity
/// Deploys one ClearingHubV2 for TOKEN_ADDRESS. Explicit gas price is
/// mandatory on Arc (USDC is both native gas token and ERC-20):
///
///   TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
///   forge script script/DeployV2.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
contract DeployV2 is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        vm.startBroadcast();
        ClearingHubV2 hub = new ClearingHubV2(IERC20(token));
        vm.stopBroadcast();
        console.log("ClearingHubV2 deployed for token %s at %s", token, address(hub));
    }
}
```
Changes: constructor gains K/RING/L — read via `vm.envOr("PARAM", default)` or hardcode the uncalibrated defaults with a comment labeling them uncalibrated; update the usage comment. Keep `--with-gas-price 25gwei` in the doc comment.

---

### `docs/PROTOCOL.md` — MODIFIED

**Analog:** itself. Existing section skeleton (from headings): `## Messages (EIP-712)` → `### IOU` / `### Round`, `## Netting determinism spec` (numbered rules — the style merkle construction must follow), `## Threshold consent (v2)` with `### Griefing analysis` (extend with keep-alive griefing, Pitfall 3), `## Manifest commitment` (rewrite to the merkle spec, explicitly noting it is NOT RFC 6962 tree shape), `## Explicit non-goals` (add a supersession note for "no individual IOU redemption" mirroring the existing threshold-consent supersession pattern).

## Shared Patterns

### Arc explicit-gas discipline
**Source:** `src/client.ts:70-118` + `src/domain.ts:28`
**Apply to:** every new/changed `HubClient` write (`redeemIOU`, `executeRound`)
```typescript
maxFeePerGas: MIN_MAX_FEE_PER_GAS,   // 25_000_000_000n
gas: <explicit constant or size-parameterized formula>,
```
Never rely on estimation (USDC-gas-token gotcha). Deploys use `--with-gas-price 25gwei`.

### Custom Solidity errors with diagnostic params
**Source:** `contracts/src/ClearingHubV2.sol:60-68`
**Apply to:** ManifestMerkle.sol, all new ClearingHubV2 checks
```solidity
error WrongRoundNonce(uint64 expected, uint64 provided);
error InsufficientCollateral(address participant, uint256 balance, uint256 required);
```
No string reverts anywhere. New errors: e.g. `DebtorNotStale(uint64 lastRound, uint64 required)`, `AlreadyRedeemed(bytes32 id)`, `CoverageWindowNotBuffered(...)`, `NullifiedIdInManifest(bytes32 id)` — same naming shape.

### `{ ok, reason? }` validation returns (TS)
**Source:** `src/round.ts:114-187` (`verifyProposal`)
**Apply to:** any new TS "check X against Y" function (proof verification pre-flight, L-convention check in `signIou` path)
Throwing `Error` with interpolated values (`src/iou.ts:39-41`) is reserved for caller-bug preconditions.

### Lowercase normalization before hex sort/compare
**Source:** `src/netting.ts:39,45-46,55`; `demo/coordinator.ts:368,398,550`
**Apply to:** `src/merkle.ts` (leaf sort), coordinator redeemed-id sets, e2e set logic. TS lexicographic sort over lowercase hex == Solidity numeric bytes32 order (Pitfall 7 — lock with an uppercase-input fixture vector).

### Fixture-parity pipeline
**Source:** `test/genFixture.ts` → `test/fixtures/*.json` → `vm.readFile("../test/fixtures/...")` + `vm.parseJson*` (`DigestParity.t.sol:14-26`); `contracts/foundry.toml` `fs_permissions` already grants the read.
**Apply to:** `merkle.json` + `iouSig` extension. Regenerate only via `npm run fixture`.

### EIP-712 dual-implementation parity
**Source:** `src/domain.ts:36-63` (domain + IOU_TYPES/ROUND_TYPES) ↔ `ClearingHubV2.sol:43-45,153-172` (typehash + `_hashTypedDataV4`) ↔ `RoundBuilder.sol:82-111` (test-side mirror)
**Apply to:** new `hashIou` (typehash string must byte-match `IOU_TYPES`, `expiry` is `uint64`) and the V2 test-harness IOU digest mirror.

### Foundry test conventions
**Source:** `contracts/test/ClearingHub.t.sol`, `ClearingHubFuzz.t.sol`
**Apply to:** all new `.t.sol` files: `test_` / `testFuzz_` / `_revert` naming, `_`-prefixed internal helpers, harness inheritance (`contract X is RoundBuilderV2`), section-divider comments, `assertEq(..., "message")` on invariants, state-untouched assertions after expected reverts.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `contracts/src/lib/ManifestMerkle.sol` | Solidity library | transform | No `library` exists in `contracts/src/` (no `lib/` dir yet — create it). Conventions map from `ClearingHubV2.sol`; the algorithm itself comes from RESEARCH.md Pattern 2/3 + Code Examples (deliberate hand-roll — OZ MerkleProof is commutative-only and unusable). |

Also note: no ring-buffer or nullifier-mapping precedent exists on-chain — implement fresh per RESEARCH Pattern 4, using the state-declaration conventions above.

## Metadata

**Analog search scope:** `src/`, `test/`, `demo/`, `contracts/src/`, `contracts/test/`, `contracts/test/utils/`, `contracts/script/`, `docs/`
**Files scanned:** 20 read in full or targeted (all ≤ 810 lines; coordinator/e2e read via targeted sections)
**Pattern extraction date:** 2026-07-23
**Key caveats for planner:**
1. `RoundBuilder.sol` pins v1 — a V2 harness variant is a required new file, not an edit.
2. `src/client.ts` currently binds the v1 ABI (`clearingHubAbi`); new V2 methods must target the regenerated `clearingHubV2Abi` — resolve the client/ABI wiring explicitly in the plan.
3. `ClearingHubV2Parity.t.sol:32` `deployCodeTo` passes only `abi.encode(address(usdc))` — the V2 constructor arg encoding must be updated once K/RING/L params land, or the parity test fails at deploy.
4. `digest.json` values (manifestHash/digest/consent0) regenerate when the root swap lands — sequence: merkle lib → swap → `npm run fixture` → parity green.
