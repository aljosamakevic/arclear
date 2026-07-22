# Phase 1: Threshold Consent (brief Phase 0) - Pattern Map

**Mapped:** 2026-07-22
**Files analyzed:** 15 new/modified files
**Analogs found:** 14 / 15 (the consent-provider/timeout seam has no codebase analog — use RESEARCH.md Pattern 2)

## File Classification

| New/Modified File | Kind | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|------|-----------|----------------|---------------|
| `src/round.ts` | modify | SDK pure-core module | transform (pure) | itself + `src/netting.ts` | exact |
| `src/types.ts` | modify | type contracts | — | itself | exact |
| `src/abi/ClearingHubV2.ts` | new | artifact module (abi + bytecode) | — | `src/abi/ClearingHub.ts` | exact |
| `contracts/src/ClearingHubV2.sol` | new | settlement contract | request-response (atomic settlement) | `contracts/src/ClearingHub.sol` | exact (near-verbatim copy per D-09) |
| `contracts/test/ClearingHubV2Parity.t.sol` | new | Foundry test | file-I/O (fixture read) | `contracts/test/DigestParity.t.sol` | exact |
| `contracts/script/Deploy.s.sol` (extend) or `DeployV2.s.sol` | new/modify | deploy script | request-response | `contracts/script/Deploy.s.sol` | exact |
| `demo/coordinator.ts` | modify | orchestrator / phase state machine | event-driven (two-pass) | itself | exact (existing phases + error handling) |
| `demo/server.ts` | modify | HTTP routes (stall toggle, abort-aware `/round`) | request-response | itself (`/simulate`, `/round` handlers) | exact |
| `demo/agents.ts` | modify | persona config / stall flag | — | itself | exact |
| `demo/setup.ts` | modify | env bootstrap (V2 bytecode deploy) | file-I/O + chain writes | itself | exact |
| `demo/e2e.ts` | modify | scripted e2e (liveness scenario) | batch | itself | exact |
| `public/dashboard.html` | modify | zero-framework UI (stall toggle, exclusion rounds) | polling request-response | itself | exact |
| `test/rebuild.test.ts` | new | vitest + fast-check property tests | transform | `test/netting.test.ts` + `test/eip712.test.ts` | exact |
| `docs/PROTOCOL.md` | modify | spec doc (threshold-consent + griefing section) | — | itself (existing section structure) | exact |
| `demo/coordinator.ts` `collectConsents` seam | new logic | async timeout collector | event-driven | **none** — see "No Analog Found" | — |

## Pattern Assignments

### `src/round.ts` — `rebuildProposal` + `verifyProposal` `excluded` opt (SDK pure core, transform)

**Analog:** `src/round.ts` itself (buildProposal/verifyProposal) composed with `src/netting.ts` (net)

**Imports pattern** (`src/round.ts:1-12`) — viem named imports first, then local `.js`-suffixed relative imports, `import type` for shapes:
```typescript
import {
  concat,
  hashTypedData,
  keccak256,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import type { Account } from "viem/accounts";
import { domain, ROUND_TYPES } from "./domain.js";
import { net } from "./netting.js";
import type { NetResult, RoundProposal, SignedIou } from "./types.js";
```

**Core pattern to copy — `buildProposal`** (`src/round.ts:51-66`). `rebuildProposal` must terminate in exactly this call (never hand-assemble a digest):
```typescript
/** Coordinator: turn a netting result into a signable proposal. */
export function buildProposal(
  hub: Address,
  roundNonce: bigint,
  result: NetResult,
  chainId?: number,
): RoundProposal {
  const mh = manifestHash(result.consumedIds);
  const p = {
    roundNonce,
    participants: result.participants,
    deltas: result.deltas,
    manifestHash: mh,
  };
  return { ...p, digest: roundDigest(hub, p, chainId), consumedIds: result.consumedIds };
}
```

**Function-signature pattern — required positionals first, `opts` object last** (`src/round.ts:73-79`); `rebuildProposal(hub, roundNonce, openIous, excluded, opts)` follows this exactly, and the `excluded?: Address[]` extension goes inside `verifyProposal`'s existing `opts`:
```typescript
export function verifyProposal(
  hub: Address,
  proposal: RoundProposal,
  myIous: SignedIou[],
  self: Address,
  opts: { now: bigint; safetyWindowSeconds?: bigint; settledIds?: ReadonlySet<Hex>; chainId?: number },
): { ok: boolean; reason?: string } {
```

**Validation-return pattern — `{ ok, reason }`, never throw; failing values interpolated into `reason`** (`src/round.ts:80-108`). New checks (self in excluded, excluded address present in participants, filtered-delta mismatch) each add one early-return in this style:
```typescript
  const selfLc = self.toLowerCase();
  const idx = proposal.participants.findIndex((a) => a.toLowerCase() === selfLc);
  if (idx === -1) return { ok: false, reason: "self not in participant set" };

  const recomputed = net(myIous, opts);
  const myIdx = recomputed.participants.findIndex((a) => a.toLowerCase() === selfLc);
  const myDelta = myIdx === -1 ? 0n : recomputed.deltas[myIdx];
  if (proposal.deltas[idx] !== myDelta) {
    return {
      ok: false,
      reason: `delta mismatch: proposal says ${proposal.deltas[idx]}, local view says ${myDelta}`,
    };
  }
  // ...
  if (manifestHash(proposal.consumedIds) !== proposal.manifestHash) {
    return { ok: false, reason: "manifestHash does not match consumedIds" };
  }
  const expectedDigest = roundDigest(hub, proposal, opts.chainId);
  if (expectedDigest !== proposal.digest) {
    return { ok: false, reason: "digest does not match proposal contents" };
  }
  return { ok: true };
```

**Exclusion-filter pattern — lowercase-key comparison** (mirrors `src/netting.ts:45-46`; the codebase always compares addresses via `.toLowerCase()` and keeps a note that maps hold "lowercase -> checksummed", `src/netting.ts:33-34`):
```typescript
    const debtor = s.iou.debtor.toLowerCase();
    const creditor = s.iou.creditor.toLowerCase();
```
So the rebuild filter is: `const ex = new Set(excluded.map((a) => a.toLowerCase()));` then keep `s` iff neither `s.iou.debtor.toLowerCase()` nor `s.iou.creditor.toLowerCase()` is in `ex`. Re-net with the unchanged `net()` — no new netting math (`src/netting.ts:21-64` is the fixture-locked engine; its doc comment's numbered-rules style, `src/netting.ts:4-20`, is the model for documenting the rebuild rules).

**Doc-comment pattern** (`src/netting.ts:4-20`, `src/round.ts:68-72`): `/** ... */` block on every export, prose-only, states the invariant ("Pure function; bigint arithmetic only — there is no division anywhere in the protocol"). `rebuildProposal` gets one stating: pure, same-roundNonce, excluded list is out-of-band metadata never part of the signed struct (D-08).

---

### `src/types.ts` — new exported shapes (type contracts)

**Analog:** `src/types.ts` (whole file, 47 lines)

**Pattern** (`src/types.ts:38-47`): `interface` (never `type` alias) for record shapes; `/** ... */` doc comment on the interface and on non-obvious fields:
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
Per RESEARCH open question 1: do NOT widen `RoundProposal` with `excluded` — keep it exactly mirroring the signed struct; excluded list travels as a separate argument/opts field. `ConsentOutcome`/provider types stay in `demo/coordinator.ts` unless promoted (RESEARCH open question 3 recommends demo-local). If any new type IS exported from `src/`, `src/index.ts` needs no change only if it lands in an already-barreled module (`round.ts`, `types.ts` are both in the flat barrel: `src/index.ts` exports in fixed order types → domain → iou → netting → round → creditCap → client).

---

### `contracts/src/ClearingHubV2.sol` (settlement contract — near-verbatim copy)

**Analog:** `contracts/src/ClearingHub.sol` (181 lines — copy the entire file, then apply D-09's minimal diff)

**Copy verbatim, byte-for-byte** (the parity test depends on these):
- Import block (`ClearingHub.sol:1-10`): OZ imports grouped first, named imports with braces, `pragma solidity 0.8.26;` pinned.
- `ROUND_TYPEHASH` string (`ClearingHub.sol:41-43`):
```solidity
    bytes32 private constant ROUND_TYPEHASH = keccak256(
        "Round(uint64 roundNonce,address[] participants,int256[] deltas,bytes32 manifestHash)"
    );
```
- Constructor domain args (`ClearingHub.sol:68-70`) — D-11 hinges on this exact string pair:
```solidity
    constructor(IERC20 token_) EIP712("ArcClearingHub", "1") Ownable(msg.sender) {
        token = token_;
    }
```
- All custom errors (`ClearingHub.sol:58-66`), all events (`45-56`), `executeRound` (`104-149`), `hashRound` (`153-170`), `pause`/`unpause` (`174-180`).
- The never-pausable `withdraw` with its why-comment (`ClearingHub.sol:81-92`) — security-critical to survive the copy:
```solidity
    /// @notice Withdraw free collateral. Deliberately NOT pausable: exit is
    ///         always possible. Withdrawing between consent and execution can
    ///         only revert the round in full — never partially settle it.
    function withdraw(uint256 amount) external nonReentrant {
```

**Change only:** `contract ClearingHub` → `contract ClearingHubV2`, and the `@title`/`@notice` header block (`ClearingHub.sol:12-27`) gains a v2 version marker noting the threshold-consent protocol lives off-chain and the execution path is identical to v1. Match the existing NatSpec density (full `@title`/`@notice`/`@dev`/`@param` — see `executeRound`'s param docs at `ClearingHub.sol:94-103`).

---

### `contracts/test/ClearingHubV2Parity.t.sol` (Foundry test, fixture file-I/O)

**Analog:** `contracts/test/DigestParity.t.sol` (40 lines — copy whole structure, swap names)

**Complete pattern** (`DigestParity.t.sol:12-40`) — fixture parse, `vm.chainId`, `deployCodeTo` at the fixture's pinned hub address, digest + recovery assertions:
```solidity
contract DigestParityTest is Test {
    function test_digestMatchesSdkFixture() public {
        string memory json = vm.readFile("../test/fixtures/digest.json");

        address hubAddr = vm.parseJsonAddress(json, ".hub");
        uint256 chainId = vm.parseJsonUint(json, ".chainId");
        uint64 nonce_ = uint64(vm.parseJsonUint(json, ".roundNonce"));
        address[] memory participants = vm.parseJsonAddressArray(json, ".participants");
        int256[] memory deltas = vm.parseJsonIntArray(json, ".deltas");
        bytes32 manifestHash = vm.parseJsonBytes32(json, ".manifestHash");
        bytes32 expectedDigest = vm.parseJsonBytes32(json, ".digest");
        address signer0 = vm.parseJsonAddress(json, ".signer0");
        bytes memory consent0 = vm.parseJsonBytes(json, ".consent0");

        vm.chainId(chainId);
        MockUSDC usdc = new MockUSDC();
        deployCodeTo("ClearingHub.sol:ClearingHub", abi.encode(address(usdc)), hubAddr);
        ClearingHub hub = ClearingHub(hubAddr);

        bytes32 onchain = hub.hashRound(nonce_, participants, deltas, manifestHash);
        assertEq(onchain, expectedDigest, "TS and Solidity round digests diverge");

        assertEq(ECDSA.recover(onchain, consent0), signer0, "consent signature recovery diverges");
    }
}
```
V2 variant: same fixture file (NO regeneration per D-11), swap the artifact string to `"ClearingHubV2.sol:ClearingHubV2"` and the type to `ClearingHubV2` (Pitfall 1: artifact string must match `out/` layout; `forge build` first). `MockUSDC` is imported from the test-utils file, not duplicated: `import {MockUSDC} from "./utils/RoundBuilder.sol";` (`DigestParity.t.sol:7`). Note `contracts/foundry.toml` `fs_permissions` already grants read access to `../test/fixtures`.

**If V2 unit smoke tests are wanted:** `contracts/test/utils/RoundBuilder.sol` is the harness analog — but `RoundBuilder` type-binds `ClearingHub` (`RoundBuilder.sol:22,31`) and `_digest` derives the domain separator from `address(hub)` with hardcoded `"ArcClearingHub"`/`"1"` strings (`RoundBuilder.sol:99-110`). Prefer parameterizing by address / hub instance over duplicating the 125-line harness (RESEARCH open question 2). Test naming: `test_...`, `test_revert_...`, `testFuzz_...` per existing convention.

---

### `contracts/script/Deploy.s.sol` extension (deploy script)

**Analog:** `contracts/script/Deploy.s.sol` (21 lines — full file is the pattern)

```solidity
/// Deploys one ClearingHub for TOKEN_ADDRESS.
///
///   TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
///   forge script script/Deploy.s.sol --rpc-url arc_testnet \
///     --private-key $DEPLOYER_PK --broadcast --with-gas-price 25gwei
contract Deploy is Script {
    function run() external {
        address token = vm.envAddress("TOKEN_ADDRESS");
        vm.startBroadcast();
        ClearingHub hub = new ClearingHub(IERC20(token));
        vm.stopBroadcast();
        console.log("ClearingHub deployed for token %s at %s", token, address(hub));
    }
}
```
Copy for a `DeployV2` contract (same file or new `DeployV2.s.sol`): `vm.envAddress("TOKEN_ADDRESS")`, `startBroadcast`/`stopBroadcast`, `console.log` of the address, and the usage doc-comment including `--with-gas-price 25gwei` (Arc gas gotcha — Pitfall 7). New `.env.example` keys `HUB_V2_USDC`/`HUB_V2_EURC` alongside the existing `HUB_USDC`/`HUB_EURC`.

---

### `src/abi/ClearingHubV2.ts` (artifact module)

**Analog:** `src/abi/ClearingHub.ts` (639 lines)

**Structure:** exactly two exports — `export const clearingHubAbi = [ ... ]` (forge-out ABI JSON pasted as a TS array, `ClearingHub.ts:1`) and `export const clearingHubBytecode = "0x..." as const;` (`ClearingHub.ts:639`, single line, `as const`). V2 module mirrors this: `clearingHubV2Abi` (byte-identical ABI content — no interface change) + `clearingHubV2Bytecode` (differs by name/metadata hash). Source of truth is `contracts/out/ClearingHubV2.sol/ClearingHubV2.json` after `forge build`; note the npm `abi` script only copies JSON — this `.ts` module is maintained manually (Pitfall 2). Without this file, anvil e2e silently exercises v1 bytecode.

---

### `demo/setup.ts` — point anvil deploy at V2 (bootstrap)

**Analog:** `demo/setup.ts` itself

**Deploy pattern to retarget** (`demo/setup.ts:97-104`, currently imports from `../src/abi/ClearingHub.js` at line 16):
```typescript
  const hubTx = await wallet.deployContract({
    abi: clearingHubAbi,
    bytecode: clearingHubBytecode,
    args: [token],
    account: deployer,
    chain,
  });
  const hub = (await pub.waitForTransactionReceipt({ hash: hubTx })).contractAddress!;
```
Swap the import to the V2 module. `HubClient` needs no change (ABI-identical). Testnet mode reads the hub address from env (`setup.ts:138-141` pattern: `process.env.HUB_USDC` with a throw-if-missing guard) — V2 testnet runs read `HUB_V2_USDC` the same way.

**Arc gas discipline** (`demo/setup.ts:49-55`) — apply to any new Arc write:
```typescript
    // Explicit gas limits matter on Arc: USDC is both the gas token and the
    // ERC-20, so letting estimation probe with huge limits reserves the whole
    // balance for gas and makes the simulated token transfer fail.
    const fee =
      env.chain.id === arcTestnet.id
        ? { maxFeePerGas: MIN_MAX_FEE_PER_GAS, gas: 200_000n }
        : {};
```

---

### `demo/coordinator.ts` — two-pass state machine, miss counters, consent providers

**Analog:** `demo/coordinator.ts` itself

**Phase union + executed-round record to extend** (`demo/coordinator.ts:9-27`) — add rebuild phases (e.g. `"rebuilding"`, `"collecting-consents-pass-2"`, `"aborted"`; naming is discretion) to the string-literal union, and `excluded: string[]` + `passCount: 1 | 2` to `ExecutedRound` (all bigints serialized as strings, addresses lowercase — see the `deltas` field comment):
```typescript
export type RoundPhase =
  | "idle"
  | "netting"
  | "collecting-consents"
  | "submitting"
  | "confirmed"
  | "failed";

export interface ExecutedRound {
  roundNonce: string;
  txHash: Hex;
  manifestHash: Hex;
  participants: number;
  grossVolume: string;
  settledVolume: string;
  iouCount: number;
  /** address (lowercase) -> signed delta in base units, as strings. */
  deltas: Record<string, string>;
}
```

**State-field pattern** (`demo/coordinator.ts:34-49`): plain public instance fields, `readonly` constructor params. Miss counters (D-06) and stall flags join here, e.g. `missed = new Map<string, number>()` keyed lowercase — with D-07 semantics: timeout → increment, consent → reset to 0, refusal → unchanged.

**The consent loop being replaced** (`demo/coordinator.ts:71-89`) — this is the seam where providers slot in; note the anti-pattern to remove at line 85 (refusal currently throws; v2 treats refusal as data):
```typescript
      this.phase = "collecting-consents";
      const signatures: Hex[] = [];
      for (let i = 0; i < proposal.participants.length; i++) {
        const persona = this.personas.find(
          (p) => p.account.address.toLowerCase() === proposal.participants[i].toLowerCase(),
        );
        if (!persona) throw new Error(`no key for participant ${proposal.participants[i]}`);

        // Each agent re-derives the netting from its own view before signing.
        const check = verifyProposal(this.hub, proposal, this.openIous, persona.account.address, {
          now,
          settledIds: this.settledIds,
          chainId: this.chainId,
        });
        if (!check.ok) throw new Error(`${persona.name} refused consent: ${check.reason}`);

        signatures.push(await signConsent(this.hub, proposal, persona.account, this.chainId));
        this.phaseDetail = `${signatures.length}/${proposal.participants.length} consents`;
      }
```

**Submit-and-record pattern to keep for both pass outcomes** (`demo/coordinator.ts:91-116`): submit via `hubClient.executeRound`, `waitForTransactionReceipt`, throw on revert status, then add consumed ids lowercase into `settledIds` and push the `ExecutedRound`:
```typescript
      const txHash = await this.hubClient.executeRound(this.relayerWallet, proposal, signatures);
      const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`tx reverted: ${txHash}`);

      for (const id of proposal.consumedIds) this.settledIds.add(id.toLowerCase() as Hex);
```
Pass 2 reuses the pass-1 `roundNonce` (fetched once at `demo/coordinator.ts:68`: `const roundNonce = await this.hubClient.roundNonce();`) — Pitfall 4.

**Error-handling pattern** (`demo/coordinator.ts:117-121`) — genuine faults only; a pass-2 abort is a structured outcome, NOT this path (Pitfall 6):
```typescript
    } catch (e) {
      this.phase = "failed";
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
```
`runRound`'s return widens to a structured `{ outcome: "settled" | "aborted", ... }`-style result so aborts don't become HTTP 500s.

**State-serialization pattern** (`demo/coordinator.ts:125-177` `state()`): everything the dashboard needs is stringified bigints + lowercase-address records; stall flags, miss counters, and exclusion info for round history get added here in the same shape.

---

### `demo/server.ts` — stall-toggle endpoint + abort-aware `/round` (HTTP routes)

**Analog:** `demo/server.ts` itself

**Route-dispatch pattern — if-chains on method+url inside one try/catch** (`demo/server.ts:50-56, 98-111`). A `POST /stall` (or similar) route copies the `/round` shape; the catch stays the 500 path for genuine faults only:
```typescript
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard.html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(dashboardPath));
      return;
    }
    // ...
    if (req.method === "POST" && req.url === "/round") {
      const round = await coordinator.runRound(now());
      printReport(round, env.explorerTx);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(round));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
});
```
Note: no request-body parsing exists anywhere in this server (all POSTs are body-less; per-request variation via URL). A stall toggle keyed by agent fits the existing style as query/path data (e.g. `POST /stall?agent=Crawler`) rather than introducing JSON-body parsing. `/state` enrichment pattern (`demo/server.ts:57-71`): spread `coordinator.state()` plus server-local fields (`mode`, `hub`, `simulating`) — stall flags join this spread.

---

### `demo/agents.ts` — stall flag (persona config)

**Analog:** `demo/agents.ts` itself (32 lines)

**Pattern** (`demo/agents.ts:7-12`): plain interface + factory returning literals:
```typescript
export interface AgentPersona {
  name: string;
  emoji: string;
  role: string;
  account: HDAccount;
}
```
Either add a mutable `stalled?: boolean` here or keep a parallel `Map<string, boolean>` registry in the coordinator/server (discretion per CONTEXT). Personas are constructed once in `setup.ts` and shared by reference, so a mutable flag on the persona object is visible everywhere.

---

### `public/dashboard.html` — stall toggle + exclusion-round display

**Analog:** `public/dashboard.html` itself

**Poll-and-render pattern** (`dashboard.html:101-161`): single `poll()` fetching `/state` every 1500ms, rendering with template-literal `innerHTML`, bigint-as-string decoded with `BigInt(...)`:
```javascript
async function poll() {
  try {
    const s = await (await fetch("/state")).json();
    // ...
  } catch (e) { $("phase").textContent = "⚠ server unreachable"; }
}
poll();
setInterval(poll, 1500);
```

**Button-action pattern** (`dashboard.html:163-167`) — per-agent stall toggles follow this fetch-POST shape (rendered inside the agent-positions rows):
```javascript
$("simulateBtn").onclick = async () => { await fetch("/simulate", { method: "POST" }); };
$("roundBtn").onclick = async () => {
  $("roundBtn").disabled = true;
  try { await fetch("/round", { method: "POST" }); } finally { $("roundBtn").disabled = false; }
};
```

**Rounds-table row pattern to extend with excluded/passCount columns** (`dashboard.html:142-149`):
```javascript
      $("rounds").querySelector("tbody").innerHTML = s.rounds.map((r) => {
        const g = BigInt(r.grossVolume), st = BigInt(r.settledVolume);
        const comp = g === 0n ? "—" : (Number((g - st) * 1000n / g) / 10).toFixed(1) + "%";
        const link = s.explorerBase
          ? `<a href="${s.explorerBase}/tx/${r.txHash}" target="_blank">${short(r.txHash)} ↗</a>`
          : short(r.txHash);
        return `<tr><td>${r.roundNonce}</td>...</tr>`;
      }).join("");
```

**Phase-label map to extend with new phases** (`dashboard.html:152-159`) — every new `RoundPhase` string needs an entry here:
```javascript
    const phases = {
      "idle": "", "netting": "⏳ computing net positions…",
      "collecting-consents": "✍️ " + s.phaseDetail,
      "submitting": "📡 submitting settlement…",
      "confirmed": "✅ settled · " + ...,
      "failed": "❌ " + (s.lastError ?? "failed"),
    };
```
Percent display uses the no-division-in-protocol-friendly bigint trick `Number((g - st) * 1000n / g) / 10` (display-only division is fine here).

---

### `demo/e2e.ts` — liveness scenario (scripted e2e)

**Analog:** `demo/e2e.ts` itself (74 lines)

**Assertion pattern** (`demo/e2e.ts:29-58`): snapshot collateral before, run round, compare on-chain deltas to engine output to the base unit, count mismatches, `process.exit(1)` on failure:
```typescript
const before = new Map<string, bigint>();
for (const p of env.personas) {
  before.set(p.account.address, await env.hubClient.collateral(p.account.address));
}
// ... run round ...
let mismatches = 0;
for (const p of env.personas) {
  const after = await env.hubClient.collateral(p.account.address);
  const actual = after - before.get(p.account.address)!;
  const expected = BigInt(round.deltas[p.account.address.toLowerCase()] ?? "0");
  const ok = actual === expected;
  if (!ok) mismatches++;
  // console.log with ✓/✗ per agent
}
```
The liveness extension repeats this: stall one persona → round n settles without them (assert their delta is 0 and their IOU ids not in manifest) → unstall → round n+1 settles their IOUs (assert manifest disjointness). Log prefix convention `[e2e]`; script ends with `env.anvil?.kill(); process.exit(0);` (`e2e.ts:73-74`) — note Pitfall 3: `process.exit` currently masks leaked timers; new timeout timers must be cleared/`unref()`'d anyway.

---

### `test/rebuild.test.ts` (vitest + fast-check property tests)

**Analogs:** `test/netting.test.ts` (property style, fixtures) + `test/eip712.test.ts` (real-signature round trips)

**Test-fixture helpers to reuse verbatim** (`test/netting.test.ts:7-43`) — deterministic address pool, `fakeIou` (no real signatures needed for engine-level tests), arbitraries:
```typescript
const NOW = 1_800_000_000n;
const FUTURE = NOW + 3_600n;

const ADDRS: Address[] = Array.from(
  { length: 6 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
);

/** Test IOUs don't need real signatures — the engine keys on `id`. */
function fakeIou(
  debtor: Address,
  creditor: Address,
  amount: bigint,
  nonce: bigint,
  expiry: bigint = FUTURE,
): SignedIou {
  const id = keccak256(
    toHex(`${debtor}|${creditor}|${amount}|${nonce}|${expiry}`),
  ) as Hex;
  return { iou: { debtor, creditor, amount, nonce, expiry, ref: id }, signature: "0x", id };
}

const arbIou = fc
  .record({
    d: fc.integer({ min: 0, max: 5 }),
    c: fc.integer({ min: 0, max: 5 }),
    amount: fc.bigInt({ min: 1n, max: 10_000_000n }),
    nonce: fc.bigInt({ min: 0n, max: 1_000n }),
  })
  .filter(({ d, c }) => d !== c)
  .map(({ d, c, amount, nonce }) => fakeIou(ADDRS[d], ADDRS[c], amount, nonce));

const arbIous = fc.array(arbIou, { minLength: 0, maxLength: 200 });
```
Add `const arbStalled = fc.subarray(ADDRS, { maxLength: ADDRS.length - 2 });` (RESEARCH Code Examples).

**Property-assertion pattern** (`test/netting.test.ts:46-53`) — zero-sum after rebuild copies this shape against `rebuildProposal(...).result`:
```typescript
  it("deltas always sum to zero", () => {
    fc.assert(
      fc.property(arbIous, (ious) => {
        const r = net(ious, { now: NOW });
        expect(r.deltas.reduce((a, b) => a + b, 0n)).toBe(0n);
      }),
    );
  });
```
Shuffle-determinism pattern for the rebuild (`test/netting.test.ts:55-67`), settled-ids exclusion pattern for never-settles-twice (`test/netting.test.ts:92-98`).

**Real-signature pattern for CONS-03 consent verification** (`test/eip712.test.ts:19-23, 63-81`) — fixed hub address, `privateKeyToAccount` with repeated-byte keys, `verifyProposal`/`signConsent`/`verifyConsent` round trip:
```typescript
const HUB = "0x1111111111111111111111111111111111111111" as Address;
const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
// ...
    const consent = await signConsent(HUB, proposal, alice);
    expect(await verifyConsent(HUB, proposal, alice.address, consent)).toBe(true);
    expect(await verifyConsent(HUB, proposal, bob.address, consent)).toBe(false);
```
Negative-case pattern with `check.reason` matching (`test/eip712.test.ts:83-94`): tamper the proposal, assert `check.ok === false` and `check.reason` matches a regex.

---

### `docs/PROTOCOL.md` — threshold-consent + griefing section (spec doc)

**Analog:** `docs/PROTOCOL.md` itself. Existing section order: Roles → Messages (EIP-712) → Netting determinism spec → Round lifecycle → Settlement semantics → Manifest commitment → Explicit non-goals in v1. The new threshold-consent section extends "Round lifecycle" territory and must **supersede** the "No threshold consent" bullet in the non-goals section (`docs/PROTOCOL.md:124-128` — Pitfall 8). Numbered-rule style matches the netting determinism spec (mirrored by `src/netting.ts:8-17`'s numbered rules). Include verbatim: "worst case is two signature-collection passes: a latency cost, never a safety cost" and the domain line "in a payments CCP the defaulter's position is a scalar debit in a stable unit". Keep `docs/THREAT-MODEL.md` row 7 / limitations table consistent (update "v2 answer" → shipped); D-07's refusal ≠ miss distinction must hold across both docs.

## Shared Patterns

### `{ ok, reason }` validation returns (never throw from verify functions)
**Source:** `src/round.ts:79, 82, 87-92, 101-107`
**Apply to:** all new/extended check functions (`verifyProposal` extension, any rebuild-validity check); coordinator treats a `false` result as refusal-data, never as an exception.

### `opts`-last function signatures with `now`/`settledIds`/`chainId`
**Source:** `src/netting.ts:21-27`, `src/round.ts:73-78`
**Apply to:** `rebuildProposal` and any new SDK function — required positionals first, inline-typed `opts` object last, `chainId?: number` trailing optional.

### Lowercase-key address handling
**Source:** `src/netting.ts:33-34, 45-50` (maps hold "lowercase -> checksummed"), `demo/coordinator.ts:57, 97, 101`
**Apply to:** exclusion sets, miss-counter maps, consent maps, `settledIds` writes — always `.toLowerCase()` on the key, keep checksummed originals for output.

### Phase state machine + `phaseDetail` + `lastError`
**Source:** `demo/coordinator.ts:9-15, 37-40, 62-63, 117-121`
**Apply to:** all new coordinator phases; every phase transition sets `this.phase` and a human-readable `this.phaseDetail`; the dashboard's phase map (`dashboard.html:152-159`) must gain matching entries.

### Bigints-as-strings across the HTTP/JSON boundary
**Source:** `demo/coordinator.ts:99-112` (ExecutedRound), `demo/coordinator.ts:142-176` (state()), decoded via `BigInt(...)` in `dashboard.html:97, 109-110`
**Apply to:** every new field crossing coordinator → server → dashboard (miss counters, exclusion lists, pass counts).

### Arc gas discipline on writes
**Source:** `demo/setup.ts:49-55` (`maxFeePerGas: MIN_MAX_FEE_PER_GAS`, explicit `gas`), `Deploy.s.sol:10-12` (`--with-gas-price 25gwei`), `src/client.ts` (executeRound `gas: 1_500_000n` — see RESEARCH A2)
**Apply to:** V2 deploy script invocations and any new viem write against Arc Testnet.

### NatSpec density + custom errors (Solidity)
**Source:** `contracts/src/ClearingHub.sol:12-27` (contract header), `58-66` (errors carrying diagnostics: `WrongRoundNonce(uint64 expected, uint64 provided)`), `94-103` (per-param docs)
**Apply to:** `ClearingHubV2.sol` (survives the copy) and any new Solidity test/harness code; no `require(..., "string")` anywhere.

### Fixture-locked digest chain
**Source:** `test/genFixture.ts` → `test/fixtures/digest.json` → `test/eip712.test.ts:96-110` (TS side) + `contracts/test/DigestParity.t.sol` (Sol side)
**Apply to:** the V2 parity test consumes the SAME fixture; no new signed structs → no regeneration (D-11). The TS fixture test at `eip712.test.ts:96-110` is the model if a TS-side V2 assertion is wanted.

## No Analog Found

Files/mechanisms with no close match in the codebase (planner should use RESEARCH.md patterns instead):

| Mechanism | Role | Data Flow | Reason | Fallback |
|-----------|------|-----------|--------|----------|
| `collectConsents` timeout collector + consent-provider seam (lands in `demo/coordinator.ts`) | async orchestration | event-driven with wall-clock deadline | No existing `Promise.race`/deadline code anywhere; the only `setTimeout` uses are anvil startup sleep (`setup.ts:82`) and streaming delay (`server.ts:87`) | RESEARCH.md Pattern 2 (typed `ConsentOutcome`, shared deadline timer, snapshot-then-ignore per Pitfall 3, `clearTimeout` + `unref()`) |

## Metadata

**Analog search scope:** `src/`, `demo/`, `test/`, `public/`, `contracts/src/`, `contracts/test/`, `contracts/script/`, `docs/`
**Files scanned:** 16 read in full (or head+grep for `src/abi/ClearingHub.ts`); all analogs are current, actively-tested code (last touched in the v1 milestone commits)
**Pattern extraction date:** 2026-07-22
