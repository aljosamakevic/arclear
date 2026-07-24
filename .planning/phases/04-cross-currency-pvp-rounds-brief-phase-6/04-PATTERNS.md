# Phase 4: Cross-Currency PvP Rounds (brief Phase 6) - Pattern Map

**Mapped:** 2026-07-24
**Files analyzed:** 20 new/modified files
**Analogs found:** 19 / 20 (union-merge signature verification is the only genuinely new pattern)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `contracts/src/PvPRouter.sol` (new) | contract (stateless settlement router) | request-response (tx-atomic composition) | `contracts/src/ClearingHubV2.sol` | role-match (EIP-712/errors/NatSpec exact; router composition is new) |
| `contracts/script/DeployPvPRouter.s.sol` (new) | deploy script | batch | `contracts/script/DeployV2.s.sol` | exact |
| `contracts/test/utils/` dual-hub harness (new, e.g. `PvPRoundBuilder.sol`) | test harness | — | `contracts/test/utils/RoundBuilderV2.sol` | exact (instantiate twice) |
| `contracts/test/PvPRouter.t.sol` (new) | contract test (unit + revert matrix + gas) | — | `contracts/test/ClearingHubV2.t.sol` | exact |
| `contracts/test/PvPParity.t.sol` (new) | parity test (fixture-driven) | — | `contracts/test/ClearingHubV2Parity.t.sol` (+ `MerkleParity.t.sol` for flat keys) | exact |
| `src/pvp.ts` (new) | SDK module (digest/sign/verify) | request-response | `src/round.ts` | exact |
| `src/domain.ts` (modify) | config/domain constants | — | itself (`domain()`, `ROUND_TYPES`) | exact |
| `src/types.ts` (modify) | type contracts | — | itself (`RoundProposal`) | exact |
| `src/client.ts` (modify) | contract client (write + gas formula) | request-response | itself (`HubClient.executeRound`) | exact |
| `src/index.ts` (modify) | barrel | — | itself | exact |
| `test/genFixture.ts` (modify) | fixture generator | file-I/O | itself (digest.json object + merkle flat keys) | exact |
| `test/pvp.test.ts` (new) | SDK test (roundtrip + property) | — | `test/eip712.test.ts` + `test/rebuild.test.ts` | exact |
| `demo/setup.ts` (modify) | env bootstrap | batch | itself (`setupAnvil`/`setupTestnet`) | exact (must be doubled — see Pitfall 3) |
| `demo/coordinator.ts` (modify) or sibling `demo/pvp*.ts` | orchestration (state machine) | event-driven consent collection | itself (`attemptRound`, `collectConsents`, `screenConsents`, `pendingSubmission`) | exact |
| `demo/e2e.ts` (modify) | e2e script | batch | itself (`check`/`snapshot`/`assertDeltas`) | exact |
| `demo/agents.ts` (modify) | demo config (personas) | — | itself | exact |
| `docs/PROTOCOL.md` (modify) | docs | — | itself (Messages/EIP-712 §, measured-gas table §, superseded-non-goal notes) | exact |
| `docs/THREAT-MODEL.md` (modify) | docs | — | itself (attack-surface + known-limitations tables) | exact |
| `README.md` (modify) | docs | — | itself (deployed-hubs tables, lines 175–204) | exact |
| `public/dashboard.html` (modify) | dashboard (zero-dep UI) | request-response polling | itself (rounds table + badge CSS) | exact |

## Pattern Assignments

### `contracts/src/PvPRouter.sol` (contract, tx-atomic composition)

**Analog:** `contracts/src/ClearingHubV2.sol` — the only currently-live contract; copy its conventions exactly. RESEARCH.md Pattern 1/2 already sketches the router shape; the excerpts below are what to imitate stylistically.

**Imports pattern** (`ClearingHubV2.sol:4-12`) — OZ named imports first, then local:
```solidity
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ManifestMerkle} from "./lib/ManifestMerkle.sol";
```
Router needs only `EIP712`, `ECDSA`, `ManifestMerkle`, and `ClearingHubV2` itself (typed immutables — Q3 requires immutables, not calldata). NO `ReentrancyGuard`/`Pausable`/`Ownable2Step` (stateless, no funds — document why in NatSpec per RESEARCH Q1.6).

**EIP-712 constructor + typehash pattern** (`ClearingHubV2.sol:52-54,159-168`):
```solidity
bytes32 private constant ROUND_TYPEHASH = keccak256(
    "Round(uint64 roundNonce,address[] participants,int256[] deltas,bytes32 manifestHash)"
);
constructor(IERC20 token_, uint64 k_, uint64 ring_, uint64 maxIouLifetime_)
    EIP712("ArcClearingHub", "1")
```
Router: `EIP712("ArclearPvPRouter", "1")`, `PVP_ROUND_TYPEHASH = keccak256("PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)")`, `ClearingHubV2 public immutable hubUSDC; ClearingHubV2 public immutable hubEURC;`.

**Custom error pattern** (`ClearingHubV2.sol:140-157`) — PascalCase, diagnostic params for off-chain debugging:
```solidity
error WrongRoundNonce(uint64 expected, uint64 provided);
error BadSignature(uint256 index);
error InsufficientCollateral(address participant, uint256 balance, uint256 required);
```
Router error surface (per RESEARCH): `ZeroRate()`, `LegDigestMismatch(uint8 leg)`, `BadPvPSignature(uint256 index)`, plus union-merge disorder/length-mismatch errors in the same style.

**Signature-verification loop** (`ClearingHubV2.sol:230-239`) — strictly-ascending check fused with per-index recovery; copy this loop shape for the union-merge verification:
```solidity
int256 sum;
address prev;
for (uint256 i; i < n; ++i) {
    address p = participants[i];
    if (p <= prev) revert ParticipantsNotStrictlyAscending();
    prev = p;
    if (ECDSA.recover(digest, signatures[i]) != p) revert BadSignature(i);
    sum += deltas[i];
}
```

**Public digest view for parity consumers** (`ClearingHubV2.sol:380-399`) — router's `hashPvPRound` mirrors `hashRound`:
```solidity
/// @notice EIP-712 digest every participant signs. Public so off-chain
///         implementations can assert encoding parity against the chain.
function hashRound(uint64 nonce_, address[] calldata participants, int256[] calldata deltas, bytes32 manifestHash)
    public view returns (bytes32)
{
    return _hashTypedDataV4(keccak256(abi.encode(
        ROUND_TYPEHASH, nonce_,
        keccak256(abi.encodePacked(participants)),
        keccak256(abi.encodePacked(deltas)),
        manifestHash)));
}
```
The router also CALLS this exact function on each hub to bind calldata legs to signed digests (Pitfall 2: never reimplement leg hashing).

**Leg execution:** plain high-level external calls `hubUSDC.executeRound(...)` then `hubEURC.executeRound(...)` — no `try`, no low-level `.call` (RESEARCH Pitfall 1: bubbling IS the atomicity mechanism).

**NatSpec density** (`ClearingHubV2.sol:14-38`): full `@title`/`@notice`/`@dev`/`@param` block on the contract and every external function, including why-comments on security invariants ("Withdrawing between consent and execution can only revert the round in full"). Match this density; the router's contract-level `@dev` should state the atomicity argument, statelessness rationale, and the single-leg-extraction limitation pointer.

---

### `contracts/script/DeployPvPRouter.s.sol` (deploy script)

**Analog:** `contracts/script/DeployV2.s.sol` (whole file, lines 17-35):
```solidity
contract DeployV2 is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        uint64 k = uint64(vm.envOr("HUB_K", uint256(3)));
        vm.startBroadcast();
        ClearingHubV2 hub = new ClearingHubV2(IERC20(token), k, ring, maxIouLifetime);
        vm.stopBroadcast();
        console.log("ClearingHubV2 deployed for token %s at %s", token, address(hub));
    }
}
```
Copy: env via `vm.envAddress` (`HUB_V2_USDC`, `HUB_V2_EURC`), `vm.startBroadcast()/stopBroadcast()`, `console.log` of the deployed address and both hub bindings. Copy the file-header comment style (`DeployV2.s.sol:8-16`) documenting the exact invocation with `--with-gas-price 25gwei` (explicit gas mandatory on Arc — USDC is the gas token).

---

### `contracts/test/utils/` dual-hub harness (test harness)

**Analog:** `contracts/test/utils/RoundBuilderV2.sol`. Simplest path: a new `abstract contract PvPRoundBuilder is Test` that instantiates two tokens + two `ClearingHubV2`s + one `PvPRouter`, and reuses RoundBuilderV2's member shapes. Key reusable pieces:

**Actor derivation, sorted ascending** (`RoundBuilderV2.sol:31-54`):
```solidity
ks[i] = uint256(keccak256(abi.encode("arclear-actor", i)));
as_[i] = vm.addr(ks[i]);
// bubble-sort addresses + keys together; participants must be strictly ascending
```

**Digest-exactly-as-the-hub-derives-it + signing** (`RoundBuilderV2.sol:113-145`):
```solidity
function _digestV2(uint64 nonce_, address[] memory participants, int256[] memory deltas, bytes32[] memory consumedIds)
    internal view returns (bytes32)
{
    return hub.hashRound(nonce_, participants, deltas, ManifestMerkle.rootOf(consumedIds));
}
function _signRound(uint256 pk, ...) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
    return abi.encodePacked(r, s, v);
}
```
Dual-hub versions must take the hub as a parameter (`_digestV2(hub, ...)`) instead of the single `hub` field. Add a `_signPvP(pk, pvpDigest)` and a `_buildPvPSignatures(union, pvpDigest)` following `_buildSignatures` (`RoundBuilderV2.sol:135-145`).

**Fund + deposit helper** (`RoundBuilderV2.sol:56-62`) and simple-round fixture (`RoundBuilderV2.sol:99-109` — A(-3) B(+1) C(+2) with `_manifest(3, salt)`): parameterize by hub/token.

---

### `contracts/test/PvPRouter.t.sol` (unit + revert matrix + both-or-neither + gas)

**Analog:** `contracts/test/ClearingHubV2.t.sol`.

**Naming:** `test_executePvP_*`, `test_revert_executePvP_*`, `testFuzz_*` (e.g. `test_revert_redeemIOU_badSignature` at `ClearingHubV2.t.sol:193`). Include the documented-limitation test `test_singleLegDirectSubmissionSettles` (RESEARCH Q2c).

**Revert assertion pattern** (used throughout, e.g. `ClearingHubV2.t.sol:72-86`): `vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.BadSignature.selector, 1));` then the call. RESEARCH "Code Examples" gives the exact both-or-neither assertion skeleton (both nonces + a collateral read after the revert).

**Gas measurement pattern** (`ClearingHubV2.t.sol:406-439`) — `gasleft()` deltas around a fresh-state worst-case call, logged via `console2.log`, one test per size point:
```solidity
uint256 g0 = gasleft();
hub.executeRound(0, p, d, ids, sigs);
used = g0 - gasleft();
assertEq(hub.roundNonce(), 1, "round must have executed");
...
function test_gas_executeRound_m105() public {
    console2.log("gas_executeRound n=5 m=105:", _gasExecuteRound(105));
}
```
Copy for `test_gas_executePvP_*` at the sizes needed to fit the client formula constants (`PVP_ROUTER_BASE`, `PVP_GAS_PER_UNION_SIG`); snapshot into `contracts/.gas-snapshot` per the plan 02-05 methodology cited in `src/client.ts:20-26`.

---

### `contracts/test/PvPParity.t.sol` (fixture parity)

**Analog:** `contracts/test/ClearingHubV2Parity.t.sol` — this is the deployCodeTo-with-immutables pattern the RESEARCH mandates.

**setUp pattern** (`ClearingHubV2Parity.t.sol:19-39`):
```solidity
json = vm.readFile("../test/fixtures/digest.json");
address hubAddr = vm.parseJsonAddress(json, ".hub");
uint256 chainId = vm.parseJsonUint(json, ".chainId");
vm.chainId(chainId);                       // 5042002 — fixture domain
deployCodeTo(
    "ClearingHubV2.sol:ClearingHubV2",
    abi.encode(address(usdc), uint64(3), uint64(16), uint64(86400)),  // constructor args → immutables
    hubAddr
);
```
For the router: `deployCodeTo("PvPRouter.sol:PvPRouter", abi.encode(fixtureHubUsdcAddr, fixtureHubEurcAddr), pvpRouterAddr)` with the fixture's `pvpRouter` address.

**Assertion pattern** (`ClearingHubV2Parity.t.sol:41-55`):
```solidity
bytes32 onchain = hub.hashRound(nonce_, participants, deltas, manifestHash);
assertEq(onchain, expectedDigest, "V2 digest diverges from v1 fixture - D-11 violated");
assertEq(ECDSA.recover(onchain, consent0), signer0, "consent signature recovery diverges");
```
Same two assertions over `router.hashPvPRound(pvpUsdcLegDigest, pvpEurcLegDigest, pvpFxNumerator, pvpFxDenominator)` vs `pvpDigest`, and `ECDSA.recover(pvpDigest, pvpConsent0) == pvpSigner0`.

**Flat-key JSON addressing** (if multiple keyed vectors are needed): `MerkleParity.t.sol:25-28` — `vm.parseJsonBytes32(json, string.concat(prefix, "_leaf"))`. Foundry `fs_permissions` already grants read access to `../test/fixtures` (`contracts/foundry.toml`).

---

### `src/pvp.ts` (SDK module, digest/sign/verify)

**Analog:** `src/round.ts` — mirror it function-for-function.

**Imports + digest pattern** (`round.ts:1-11,37-48`):
```typescript
import { hashTypedData, verifyTypedData, type Address, type Hex } from "viem";
import type { Account } from "viem/accounts";
import { domain, ROUND_TYPES } from "./domain.js";

export function roundDigest(
  hub: Address,
  p: { roundNonce: bigint; participants: Address[]; deltas: bigint[]; manifestHash: Hex },
  chainId?: number,
): Hex {
  return hashTypedData({
    domain: domain(hub, chainId),
    types: ROUND_TYPES,
    primaryType: "Round",
    message: roundMessage(p),
  });
}
```
→ `pvpDigest(router, {usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator}, chainId?)` using `pvpDomain`/`PVP_TYPES`. Trailing optional `chainId?: number` is the established convention.

**Sign/verify pair** (`round.ts:197-228`):
```typescript
export async function signConsent(hub: Address, proposal: RoundProposal, account: Account, chainId?: number): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({ domain: domain(hub, chainId), types: ROUND_TYPES, primaryType: "Round", message: roundMessage(proposal) });
}
export async function verifyConsent(...): Promise<boolean> {
  return verifyTypedData({ address: participant, domain: ..., signature });
}
```
→ `signPvPConsent` / `verifyPvPConsent`, identical shape.

**Validation-as-data pattern** (`round.ts:119-195`) — `verifyPvPProposal` must return `{ ok: boolean; reason?: string }` with the failing values interpolated into `reason`, early-return per check, exactly like `verifyProposal`:
```typescript
if (opts.expectedRoundNonce !== undefined && proposal.roundNonce !== opts.expectedRoundNonce) {
  return { ok: false, reason: `roundNonce mismatch: proposal says ${proposal.roundNonce}, local chain view says ${opts.expectedRoundNonce}` };
}
...
const expectedDigest = roundDigest(hub, proposal, opts.chainId);
if (expectedDigest !== proposal.digest) {
  return { ok: false, reason: "digest does not match proposal contents" };
}
return { ok: true };
```
Per RESEARCH Pattern 3, `verifyPvPProposal` composes `verifyProposal` per leg (passing the per-hub `expectedRoundNonce`/`pendingConsumedIds` — the WR-06 machinery), then checks FX-trade pairing by shared `ref` with cross-multiplication (`e * fxDenominator === u * fxNumerator`), then recomputes `pvpDigest` from the locally verified leg digests.

**Lowercase address handling** (`round.ts:74,158-160`): all address comparisons via `.toLowerCase()`; `unionParticipants` (RESEARCH code example) already follows this.

---

### `src/domain.ts` (modify — add `PVP_TYPES`, `pvpDomain`)

**Analog:** its own `domain()` + `ROUND_TYPES` (`domain.ts:43-70`):
```typescript
export function domain(hub: Address, chainId: number = ARC_TESTNET_CHAIN_ID) {
  return { name: "ArcClearingHub", version: "1", chainId, verifyingContract: hub } as const;
}
export const ROUND_TYPES = {
  Round: [
    { name: "roundNonce", type: "uint64" },
    { name: "participants", type: "address[]" },
    ...
  ],
} as const;
```
Copy verbatim shape: `pvpDomain(router, chainId = ARC_TESTNET_CHAIN_ID)` returning `{ name: "ArclearPvPRouter", version: "1", ... } as const`, and `PVP_TYPES` with the 4 fields in typehash order (RESEARCH Pattern 1 has the exact literal). Keep the doc-comment style explaining what the domain binds (`domain.ts:37-42`).

---

### `src/types.ts` (modify — add `PvPProposal`)

**Analog:** `RoundProposal` (`types.ts:38-47`):
```typescript
/** A round proposal awaiting unanimous consent. */
export interface RoundProposal {
  roundNonce: bigint;
  participants: Address[];
  deltas: bigint[];
  manifestHash: Hex;
  /** The EIP-712 digest every participant signs. */
  digest: Hex;
  consumedIds: Hex[];
}
```
`PvPProposal` follows: interface (not type alias), per-field `/** ... */` doc comments, plain data with `bigint`/`Hex`. Likely fields: two embedded `RoundProposal` legs (or their digests), `fxNumerator`, `fxDenominator`, `digest`.

---

### `src/client.ts` (modify — router client + gas formula)

**Analog:** `HubClient` in the same file.

**Measured-gas coefficient block** (`client.ts:20-29`) — constants with a measurement-provenance comment:
```typescript
/**
 * executeRound gas formula coefficients — from forge-measured gasleft() deltas
 * (plan 02-05, 2026-07-23, fresh-state worst case at n=5): m=10 → 329,108;
 * m=105 → 691,708; m=250 → 1,254,993. The formula carries ≥1.5x margin ...
 */
export const EXECUTE_ROUND_GAS_BASE = 300_000n;
export const EXECUTE_ROUND_GAS_PER_PARTICIPANT = 40_000n;
export const EXECUTE_ROUND_GAS_PER_ID = 6_000n;
```
New constants `PVP_ROUTER_GAS_BASE` / `PVP_GAS_PER_UNION_SIG` get the same style of justification comment, reusing the existing leg coefficients (RESEARCH Q6 formula).

**Write pattern with explicit gas** (`client.ts:238-263`):
```typescript
async executeRound(wallet: WalletClient, proposal: RoundProposal, signatures: Hex[]): Promise<Hex> {
  const gas =
    EXECUTE_ROUND_GAS_BASE +
    EXECUTE_ROUND_GAS_PER_PARTICIPANT * BigInt(proposal.participants.length) +
    EXECUTE_ROUND_GAS_PER_ID * BigInt(proposal.consumedIds.length);
  return wallet.writeContract({
    address: this.hub,
    abi: clearingHubV2Abi,
    functionName: "executeRound",
    args: [...],
    chain: wallet.chain,
    account: wallet.account!,
    maxFeePerGas: MIN_MAX_FEE_PER_GAS,
    gas,
  });
}
```
`PvPRouterClient.executePvP` copies this exactly (formula gas, `maxFeePerGas: MIN_MAX_FEE_PER_GAS`, never estimation). Read views (`hashPvPRound`) copy the `readContract` shape (`client.ts:196-209`). A new ABI module `src/abi/PvPRouter.ts` mirrors `src/abi/ClearingHubV2.js` (abi + bytecode exports, consumed by `demo/setup.ts:16` and e2e bytecode-tail checks).

---

### `src/index.ts` (modify)

**Analog:** itself — flat `export *` list in dependency order (`index.ts:1-8`). Insert `export * from "./pvp.js";` after `round.js`/`creditCap.js` and BEFORE `client.js` (RESEARCH structure note; CLAUDE.md: types → domain → iou → netting → merkle → round → creditCap → client order).

---

### `test/genFixture.ts` (modify — pvp_* keys)

**Analog:** its own digest.json construction.

**Deterministic account + fixture-object pattern** (`genFixture.ts:26-38,72-90`):
```typescript
const HUB = "0x1111111111111111111111111111111111111111" as Address;
const keys = ["0x...0a01", "0x...0a02", "0x...0a03"] as const;
const accounts = keys.map((k) => privateKeyToAccount(k as Hex))
  .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
...
const fixture = {
  hub: HUB,
  chainId: 5042002,
  digest,
  signer0: participants[0],
  consent0: consent,
  ...
};
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
```
Add (flat keys, per RESEARCH Pattern 1): `pvpRouter` (a fixed constant address like `0x2222...` style), `pvpUsdcLegDigest`, `pvpEurcLegDigest` (derive from two `buildProposal` calls against two fixture hub addresses), `pvpFxNumerator`/`pvpFxDenominator` (as `String(...)` — bigints are stringified, see `deltas.map(String)` at line 77), `pvpDigest`, `pvpSigner0`, `pvpConsent0`, plus the two fixture hub addresses the parity test passes to `deployCodeTo`. Regeneration-only discipline — header comment at `genFixture.ts:1-8` says it: "never hand-edit any value".

---

### `test/pvp.test.ts` (SDK tests)

**Analogs:** `test/eip712.test.ts` (digest/sign/verify roundtrips + fixture assertion), `test/rebuild.test.ts` (fast-check property style).

**Roundtrip + tamper-rejection pattern** (`eip712.test.ts:65-102`):
```typescript
const consent = await signConsent(HUB, proposal, alice);
expect(await verifyConsent(HUB, proposal, alice.address, consent)).toBe(true);
expect(await verifyConsent(HUB, proposal, bob.address, consent)).toBe(false);
...
const tampered = { ...proposal, deltas: proposal.deltas.map((d, i) => (i === 0 ? d + 1n : d - 1n)) };
const check = verifyProposal(HUB, tampered, [a], alice.address, { now: NOW });
expect(check.ok).toBe(false);
expect(check.reason).toMatch(/delta mismatch|digest/);
```

**Fixture-match test** (`eip712.test.ts:134-148`) — a vitest test reading the same `digest.json` and asserting the TS side reproduces `pvpDigest`; keeps TS and forge locked to one vector.

**Property style** (`rebuild.test.ts:53-77`): `fc.record`/`fc.array` arbitraries over small address pools, `fc.assert(fc.property(...))`. Use for `unionParticipants` correctness (identical/overlapping/disjoint sets, ascending output) and `rateConsistent` cross-multiplication properties.

---

### `demo/setup.ts` (modify — dual hub + router)

**Analog:** itself. **Confirmed research correction:** `setupAnvil` (`setup.ts:80-130`) deploys exactly ONE mock token + ONE hub — the extension is real work, not a confirm.

**Deploy sequence to double** (`setup.ts:90-105`):
```typescript
const tokenTx = await wallet.deployContract({ abi: mockTokenAbi, bytecode: mockTokenBytecode, account: deployer, chain });
const token = (await pub.waitForTransactionReceipt({ hash: tokenTx })).contractAddress!;
const hubTx = await wallet.deployContract({
  abi: clearingHubV2Abi,
  bytecode: clearingHubV2Bytecode,
  args: [token, 3n, 16n, 86_400n],   // same UNCALIBRATED defaults as DeployV2.s.sol
  account: deployer, chain,
});
```
Repeat for token2/hub2 (EURC stand-in), then deploy the router with `args: [hubUsdc, hubEurc]`; mint + `depositAll` per hub (helper at `setup.ts:42-77` already takes `hub`/`token` via the env object — parameterize or call twice with per-hub views).

**Env-key pattern for testnet** (`setup.ts:139-145`): `HUB_V2_USDC` guard with actionable error message — add `HUB_V2_EURC` and `PVP_ROUTER` the same way:
```typescript
const hub = process.env.HUB_V2_USDC as Address | undefined;
if (!hub) throw new Error("HUB_V2_USDC not set — deploy ClearingHubV2 first (see README)");
```
**`DemoEnv` interface** (`setup.ts:20-30`) grows dual-hub fields (e.g. `hubEurc`, `hubClientEurc`, `router`, `routerClient`) — keep per-hub state separate (Pitfall 3: never one `settledIds` for two hub domains). Also extend `.env.example`.

---

### `demo/coordinator.ts` (modify) / PvP orchestration seam

**Analog:** itself — the PvP layer wraps the existing machinery; do not fork it.

**Consent provider + outcome types to generalize** (`coordinator.ts:29-36`) — per RESEARCH Pattern 3 the PvP provider returns a bundle `{ usdcConsent?, eurcConsent?, pvpSignature }`; keep the discriminated-union style:
```typescript
export type ConsentOutcome =
  | { kind: "consent"; signature: Hex }
  | { kind: "refusal"; reason: string };
```

**Deadline-snapshot collection** (`coordinator.ts:54-122`) — `collectConsents` races providers against ONE wall-clock deadline, snapshot-then-ignore (`settled` flag, line 75), microtask-routed provider calls (WR-05, lines 99-101), throwing provider → reasoned refusal (lines 109-118). Reuse or generalize directly; the PvP collection needs the same semantics over the union set.

**Signature screening** (`coordinator.ts:132-154`) — `screenConsents` demotes invalid signatures to refusals via `verifyConsent`, `catch { ok = false }` on malformed bytes. PvP variant screens leg consents per hub AND `pvpSignature` via `verifyPvPConsent`.

**Chain-free attempt core** (`coordinator.ts:207-304`) — `attemptRound` is the structural template for `attemptPvPRound`: pure args object with injected `submit: (proposal, signatures) => Promise<Hex>`, structured `RoundAttemptOutcome` union (`settled | aborted | empty`, lines 178-196), aborts as data never throws, exclusion in ONE batch (line 252), rebuild at the SAME nonce (line 256), hard 2-pass cap. Per RESEARCH open question 1, keep the chain-free core + injected-submit pattern wherever the PvP orchestration lives.

**Pending-submission reconciliation to generalize per hub** (`coordinator.ts:351-357,420-463,540-573`):
```typescript
private pendingSubmission?: { roundNonce: bigint; digest: Hex; consumedIds: Hex[]; sentAtBlock: bigint; txHash?: Hex };
...
// WR-01: record the in-flight submission BEFORE broadcasting
const sentAtBlock = await this.pub.getBlockNumber();
this.pendingSubmission = { roundNonce: proposal.roundNonce, digest: proposal.digest, consumedIds: proposal.consumedIds, sentAtBlock };
const txHash = await this.hubClient.executeRound(this.relayerWallet, proposal, signatures);
...
// WR-02: classify a nonce race from chain state, not error strings
const onChainNonce = await this.hubClient.roundNonce();
if (onChainNonce !== proposal.roundNonce) throw new Error(`WrongRoundNonce: ...`);
```
The PvP submit records pending state for BOTH hubs before broadcast and classifies failure from both nonces (Pitfall 4). Refuse ordinary rounds on either hub while a PvP bundle is in flight (mirrors `reconcilePendingSubmission`'s `blocked` return, lines 458-463).

---

### `demo/e2e.ts` (modify — PvP positive + negative scenario)

**Analog:** itself.

**check/snapshot/assertDeltas idiom** (`e2e.ts:29-33,61-81`):
```typescript
let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`[e2e] ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}
async function snapshot(): Promise<Map<string, bigint>> { /* per-persona hubClient.collateral */ }
async function assertDeltas(before, deltas, label) { /* on-chain delta === engine delta, to the base unit */ }
```
Snapshot/assertDeltas need per-hub variants (two collateral maps).

**On-chain negative assertions** (Pitfall 7 — pattern from the liveness scenario, `e2e.ts:183-204`): assert from CHAIN state, not coordinator state — both `roundNonce()`s unchanged, every persona's collateral unchanged on both hubs, and for the invalid-signature variant the router tx mined with `status: "reverted"` (receipt pattern at `e2e.ts:313-314`).

**Exit hygiene** (`e2e.ts:104-109`): `env.anvil?.kill()` on EVERY failure path before `process.exit(1)` (WR-08).

**Bytecode-tail guard** (`e2e.ts:42-50`) — optional but cheap for the router: metadata-tail compare against the local artifact proves the deployed router is the compiled source.

---

### `demo/agents.ts` (modify — FX personas)

**Analog:** itself (`agents.ts:22-31`):
```typescript
{ name: "Crawler", emoji: "🕷️", role: "sells raw web data", account: mk(1), stalled: false },
```
FX flows are Claude's discretion — either extend existing personas' roles with EURC-side activity or add role text making one pair the USDC↔EURC traders. Keep index 0 reserved for deployer/relayer; keep the `stalled` failure-injection flag (the PvP negative e2e case can use it to withhold one consent).

---

### `docs/PROTOCOL.md` (modify)

**Analog:** its own section patterns. PvP section fits after "IOU redemption" (line 380) following the same shape: struct definition (mirror "Messages (EIP-712)" §, line 35 — typehash literal + field table), atomicity argument, rate semantics + the num/den convention and per-trade `ref`-pairing rule (RESEARCH Pattern 4), the arc-stablecoin-fx tie-in note, and the standing-consent/no-deadline note (Q3). Add measured-gas rows to the "Measured gas" table (line 510). The "Explicit non-goals" § (line 528) already has the superseded-note pattern (lines 533-538):
```
> Superseded: v1 listed the absence of threshold consent as a non-goal — one
```
Add the third superseded note for "No cross-currency rounds (one hub = one token)".

---

### `docs/THREAT-MODEL.md` (modify)

**Analog:** its own two tables. Attack-surface row format (`THREAT-MODEL.md:29`):
```
| 1 | Replay an executed round | on-chain `roundNonce` check + increment | `test_revert_replaySameRound` |
```
Add rows for: single-leg extraction (accept-and-document, cite `test_singleLegDirectSubmissionSettles`), evil-hub substitution (immutables), leg/digest mismatch (`LegDigestMismatch`), PvPRound replay (structural, leg nonces), FX-rate manipulation (unanimous consent binds the rate — say plainly it is agreed, not oracle-derived, per CONTEXT specifics). Known-limitations table rows (`THREAT-MODEL.md:52-59`) use the "documented limitation, accepted" phrasing of row 18/19 — the mempool-extraction residual belongs there with the exact framing RESEARCH Q2c quotes.

---

### `README.md` (modify)

**Analog:** the deployed-hubs table lineage (`README.md:175-204`):
```
| token | hub | status |
| USDC `0x3600…0000` | [`0x3b9a9617b91589a15A14122183e6305D9F0a5a16`](https://testnet.arcscan.app/address/...) | source verified ✓ |
```
Add a router entry in the same linked-address + "source verified" format, plus the one-sentence positioning tie-in (netting compresses within a token; PvP composes two hubs atomically across tokens — CLS analogy) per CONTEXT specifics.

---

### `public/dashboard.html` (modify — minimal PvP badge)

**Analog:** its own rounds table + badge CSS. Badge style exists (`dashboard.html:19,59-60`); the rounds table row renderer (`dashboard.html:147-161`) already renders per-round cells with conditional styling:
```javascript
// Exclusion rounds (passCount 2 / non-empty excluded) are visibly distinct (D-14).
return `<tr><td>${r.roundNonce}</td><td>${r.iouCount}</td>...<td>${passCell}</td><td>${exclCell}</td><td>${link}</td></tr>`;
```
D-12 bound: at most a PvP badge/cell on rounds that were PvP legs (a boolean/tag on `ExecutedRound` surfaced through `/state`). No new panels, no new endpooints beyond what `/state` already carries.

## Shared Patterns

### New signed struct → fixture → parity (D-05, twice-proven pipeline)
**Sources:** `test/genFixture.ts` (generation) → `test/fixtures/digest.json` → `contracts/test/ClearingHubV2Parity.t.sol` (consumption) + `test/eip712.test.ts:134-148` (TS-side lock).
**Apply to:** `PvPRound` — the mandatory pipeline. Order of work: TS digest (`src/pvp.ts` + `src/domain.ts`) → fixture keys → forge parity test → contract. Regeneration-only: `npm run fixture`, never hand-edit.

### Explicit measured gas on all Arc writes
**Sources:** `src/client.ts:20-37` (coefficient constants + provenance comments), `client.ts:243-262` (formula + `maxFeePerGas: MIN_MAX_FEE_PER_GAS` + `gas`), `contracts/test/ClearingHubV2.t.sol:406-439` (gasleft() measurement tests).
**Apply to:** `PvPRouterClient.executePvP`, `demo/setup.ts` router/hub2 writes, `DeployPvPRouter.s.sol` invocation docs. Never rely on estimation (USDC is the gas token — estimation reserves the whole balance).

### Custom errors with diagnostic params, no string reverts
**Source:** `contracts/src/ClearingHubV2.sol:140-157`.
**Apply to:** every `PvPRouter` revert path.

### `{ ok, reason? }` validation returns; refusal/abort as data
**Sources:** `src/round.ts:119-195` (verifyProposal), `demo/coordinator.ts:178-196` (`RoundAttemptOutcome` union), `coordinator.ts:109-118` (throwing provider → refusal).
**Apply to:** `verifyPvPProposal`, `attemptPvPRound` outcome type, PvP consent providers.

### Lowercase-key address maps / comparisons
**Sources:** `src/round.ts:74,158`, `demo/coordinator.ts:64-70` (comment convention: map holds "lowercase -> checksummed").
**Apply to:** `unionParticipants`, PvP consent maps, per-hub settled/redeemed id sets.

### Chain-state classification, never error-string matching
**Source:** `demo/coordinator.ts:556-570` (WR-02: explicit gas skips simulation so no decoded error arrives; read `roundNonce` after a reverted receipt to classify).
**Apply to:** PvP submit path — read BOTH hub nonces after a reverted router tx.

### NatSpec / doc-comment density
**Sources:** `contracts/src/ClearingHubV2.sol:14-38` (Solidity), `src/round.ts:103-118` (TS why-comments with requirement IDs like WR-06, D-14).
**Apply to:** everything; cross-reference decision IDs (D-01..D-13, PVP-01/02) inline the way existing code cites its plan IDs.

## No Analog Found

| Concern | Role | Reason | Fallback |
|---------|------|--------|----------|
| On-chain sorted union merge + index-aligned multi-sig verify over a derived (non-calldata-length-matched) set | `PvPRouter.sol` internal | No existing contract verifies signatures over a set it derives by merging two inputs | RESEARCH "Pattern 2" note + the `ClearingHubV2.sol:230-239` loop shape (ascending check + `ECDSA.recover` + indexed error); TS mirror `unionParticipants` in RESEARCH Code Examples |
| Cross-contract composition (a contract calling another protocol contract's state-changing function) | `PvPRouter.sol` | Hubs only ever call the ERC-20; no in-repo contract calls another protocol contract | Plain high-level calls, no try/catch (RESEARCH Pitfall 1); both-or-neither forge assertions in RESEARCH Code Examples |
| Dual-hub coordinator state (two settled/redeemed sets, two pending submissions) | demo layer | `Coordinator` is single-hub by construction | Instantiate per-hub state and compose (RESEARCH Pitfall 3); ids are hub-domain-separated so they cannot collide, but keep them per-hub anyway |

## Metadata

**Analog search scope:** `contracts/src`, `contracts/test`, `contracts/test/utils`, `contracts/script`, `src/`, `test/`, `demo/`, `docs/`, `public/`, `README.md`
**Files scanned:** 55 candidates listed; 18 read in full, 2 large test files read via targeted grep + offset reads (`ClearingHubV2.t.sol`, `rebuild.test.ts`)
**Pattern extraction date:** 2026-07-24
