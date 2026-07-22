<!-- refreshed: 2026-07-22 -->
# Architecture

**Analysis Date:** 2026-07-22

## System Overview

arclear is a two-stack, three-layer system: an on-chain settlement contract (Solidity/Foundry), an off-chain
TypeScript SDK (the "protocol" implementation shared between engine and clients), and a demo/orchestration
layer that exercises the two together. The SDK and the contract each independently implement the same EIP-712
digest and netting rules; the SDK never trusts the coordinator, and the contract never trusts anyone but the
signatures it recovers.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                          DEMO / ORCHESTRATION LAYER                        │
├───────────────────┬───────────────────┬───────────────────┬──────────────┤
│   demo/setup.ts    │  demo/simulate.ts │ demo/coordinator.ts│ demo/server.ts│
│  (env bootstrap,   │  (synthetic IOU   │  (round lifecycle  │ (HTTP + live │
│   anvil/testnet)   │   traffic gen)    │   state machine)   │  dashboard)  │
└─────────┬──────────┴─────────┬─────────┴─────────┬──────────┴──────┬──────┘
          │                    │                   │                 │
          ▼                    ▼                   ▼                 ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    TYPESCRIPT SDK  (`src/` — the protocol)                 │
│  domain.ts (EIP-712 domain/types)  →  iou.ts (sign/verify IOUs)            │
│  netting.ts (pure netting fn)      →  round.ts (proposal/consent/verify)   │
│  creditCap.ts (client-side risk)   →  client.ts (typed viem contract calls)│
└──────────────────────────────────┬──────────────────────────────────────┘
                                    │ eth_call / eth_sendRawTransaction (viem)
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                 ON-CHAIN SETTLEMENT (`contracts/src/ClearingHub.sol`)      │
│  collateral vault · EIP-712 digest (hashRound) · unanimous-signature       │
│  verification · zero-sum enforcement · manifest commitment · pause         │
└───────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| ClearingHub (contract) | Collateral vault, EIP-712 round digest, unanimous-signature verification, atomic settlement | `contracts/src/ClearingHub.sol` |
| Deploy script | Deploys one hub per ERC-20 via Foundry | `contracts/script/Deploy.s.sol` |
| Domain/types | Shared EIP-712 domain, typed-data schemas, Arc chain config, token addresses | `src/domain.ts` |
| IOU signing | Debtor signs/verifies individual off-chain obligations | `src/iou.ts` |
| Netting engine | Pure, deterministic function: IOUs → net per-participant deltas | `src/netting.ts` |
| Round protocol | Builds proposals, computes shared digest, participant-side re-verification, consent signing | `src/round.ts` |
| Credit cap tracker | Client-side bilateral exposure limits (risk policy, not enforced on-chain) | `src/creditCap.ts` |
| Contract client | Typed viem wrapper for `ClearingHub` reads/writes | `src/client.ts` |
| Type contracts | Shared TS interfaces: `Iou`, `SignedIou`, `NetResult`, `RoundProposal` | `src/types.ts` |
| Package entry | Re-exports the full public SDK surface | `src/index.ts` |
| Demo environment bootstrap | Spins up anvil or attaches to testnet, deploys/funds, deposits collateral | `demo/setup.ts` |
| Demo coordinator | Orchestrates one round: net → propose → collect consents → submit → confirm | `demo/coordinator.ts` |
| Demo traffic generator | Produces ~100 synthetic signed IOUs among 5 personas | `demo/simulate.ts` |
| Demo HTTP server | Serves dashboard + `/state`, `/simulate`, `/round` endpoints | `demo/server.ts` |
| Demo end-to-end script | Scripted run: setup → traffic → round → balance assertions | `demo/e2e.ts` |
| Sweep harness | Parameterized synthetic-flow generator + statistical sweep over reciprocity/density/n | `demo/flowModel.ts`, `demo/sweep.ts` |
| Reporting | Console/box-drawing summary of a settled round | `demo/report.ts` |
| Contract tests | Unit, revert-matrix, fuzz, and cross-stack digest-parity tests | `contracts/test/*.sol` |
| SDK tests | EIP-712 sign/verify roundtrips + property-based netting invariants | `test/eip712.test.ts`, `test/netting.test.ts` |
| Fixture generator | Emits a shared digest fixture consumed by both TS and Foundry tests (parity check) | `test/genFixture.ts` |

## Pattern Overview

**Overall:** Layered protocol-and-reference-implementation pattern. There is no application "framework" — this
is a domain library (netting protocol) plus a thin orchestration/demo layer plus a minimal settlement contract.
The SDK is the source of truth for business logic; the contract is a narrow, auditable enforcement layer that
re-derives the same digest independently.

**Key Characteristics:**
- Off-chain compute, on-chain enforce: all netting math happens in TypeScript (`src/netting.ts`); the contract
  only verifies signatures over a digest and applies deltas.
- Zero-trust coordinator: the "coordinator" (`demo/coordinator.ts`) assembles rounds but every participant
  independently recomputes and compares before signing (`verifyProposal` in `src/round.ts`).
- Pure-function core: `net()` in `src/netting.ts` is a pure, deterministic, side-effect-free function — no I/O,
  no signing, no randomness. This is intentional so third parties can reimplement it from `docs/PROTOCOL.md`.
- Dual-implementation parity: the same EIP-712 digest logic is implemented once in Solidity
  (`ClearingHub.hashRound`) and once in TypeScript (`src/round.ts:roundDigest`); parity is asserted by
  `contracts/test/DigestParity.t.sol` + `test/eip712.test.ts` against a shared fixture
  (`test/fixtures/digest.json`, generated by `test/genFixture.ts`).
- No persistence layer: nothing is stored in a database. State lives in (a) on-chain contract storage
  (`collateral`, `roundNonce`) and (b) in-memory arrays/maps in the demo coordinator (`Coordinator.ious`,
  `Coordinator.settledIds`) that are lost on process restart.

## Layers

**On-chain settlement layer:**
- Purpose: custody collateral, enforce unanimous consent, apply net deltas atomically
- Location: `contracts/src/ClearingHub.sol`
- Contains: one Solidity contract (`ClearingHub`), inheriting OpenZeppelin `EIP712`, `Ownable2Step`, `Pausable`,
  `ReentrancyGuard`
- Depends on: OpenZeppelin contracts (`contracts/lib/openzeppelin-contracts`), an ERC-20 token address passed at
  construction
- Used by: `src/client.ts` (via viem `readContract`/`writeContract`), `demo/setup.ts` (deployment),
  `contracts/test/*.sol`

**SDK / protocol layer:**
- Purpose: implement the netting protocol as a portable, dependency-light TypeScript library (viem-only)
- Location: `src/`
- Contains: EIP-712 domain/types (`domain.ts`), IOU signing (`iou.ts`), netting engine (`netting.ts`), round
  building/verification/consent (`round.ts`), credit-cap risk tracking (`creditCap.ts`), typed contract client
  (`client.ts`), shared type contracts (`types.ts`), generated ABI (`abi/ClearingHub.ts`)
- Depends on: `viem` only (no framework), the deployed `ClearingHub` ABI
- Used by: `demo/*`, `test/*`, any external integrator importing `src/index.ts`

**Demo / orchestration layer:**
- Purpose: reference implementation of a coordinator + 5-agent economy + live dashboard, proving the SDK works
  end-to-end against a real chain (local anvil or Arc Testnet)
- Location: `demo/`
- Contains: environment bootstrap (`setup.ts`), synthetic traffic generation (`simulate.ts`, `flowModel.ts`),
  round-lifecycle state machine (`coordinator.ts`), HTTP server + dashboard host (`server.ts`), scripted e2e run
  (`e2e.ts`), statistical sweep tool (`sweep.ts`), console reporting (`report.ts`), local mock ERC-20
  (`mockToken.ts`), agent persona definitions (`agents.ts`), minimal `.env` loader (`env.ts`)
- Depends on: `src/` SDK entirely; `viem` for chain interaction; Node's built-in `http` module (no web
  framework) for the server
- Used by: `npm run demo`, `npm run e2e:anvil`, `npm run e2e:testnet`, `npm run sweep` (see `package.json`)

**Static dashboard (view layer):**
- Purpose: zero-dependency live visualization of coordinator state
- Location: `public/dashboard.html`
- Contains: single static HTML file polling `GET /state` and posting to `/simulate` and `/round`
- Depends on: `demo/server.ts` HTTP endpoints only (no build step, no framework)

## Data Flow

### Primary Round-Settlement Path

1. Agents sign individual IOUs off-chain: `signIou()` (`src/iou.ts:33`) — debtor signs an EIP-712 `IOU` message;
   produces a `SignedIou` with a canonical `id` (the digest itself).
2. IOUs accumulate in the coordinator's in-memory list: `Coordinator.addIous()` (`demo/coordinator.ts:51`).
3. Coordinator computes net positions: `net()` (`src/netting.ts:21`) — pure function; dedups by id, drops
   expired/settled IOUs, sums flows per participant, sorts participants ascending.
4. Coordinator builds a signable proposal: `buildProposal()` (`src/round.ts:52`) — computes `manifestHash` over
   sorted consumed-IOU ids and the EIP-712 `roundDigest`.
5. Each participant independently re-verifies before consenting: `verifyProposal()` (`src/round.ts:73`) —
   recomputes netting from its own IOU view and byte-compares deltas, manifest hash, and digest against the
   proposal. This is the trust boundary: a coordinator cannot forge consent because tampering breaks the digest.
6. Each participant signs consent over the shared digest: `signConsent()` (`src/round.ts:112`).
7. Any relayer (permissionless) submits the round: `HubClient.executeRound()` (`src/client.ts:97`) →
   `ClearingHub.executeRound()` (`contracts/src/ClearingHub.sol:104`).
8. Contract re-derives the same digest (`hashRound`, `contracts/src/ClearingHub.sol:153`), verifies N signatures
   via `ECDSA.recover`, asserts strictly-ascending participants and zero-sum deltas, then atomically debits/credits
   `collateral[participant]` and increments `roundNonce`.
9. Coordinator marks consumed IOUs as settled: `Coordinator.settledIds` (`demo/coordinator.ts:97`), so they are
   excluded from future `net()` calls.

### Demo Bootstrap Flow

1. `demo/setup.ts:setup(mode)` branches on `"anvil"` vs `"testnet"`.
2. Anvil mode: spawns a local anvil process, deploys a `MockToken` and a `ClearingHub`, mints and deposits
   collateral for all 5 personas (`setupAnvil()`, `demo/setup.ts`).
3. Testnet mode: attaches to an existing `HUB_USDC` deployment, derives agent keys from `AGENT_MNEMONIC`, tops up
   USDC from `DEPLOYER_PK`, deposits collateral idempotently (`setupTestnet()`, `demo/setup.ts`).
4. Both paths return a `DemoEnv` used identically by `demo/e2e.ts` and `demo/server.ts`.

**State Management:**
- On-chain state: `collateral` mapping and `roundNonce` (`contracts/src/ClearingHub.sol:36,39`) — the only
  durable, authoritative state in the system.
- Off-chain state: `Coordinator` instance fields (`ious`, `settledIds`, `phase`, `rounds`) held entirely in
  process memory (`demo/coordinator.ts:35-40`); not persisted, not shared across processes. A production
  deployment would need to replace this with a real store/queue.
- No client-side database, cache, or session store anywhere in the codebase.

## Key Abstractions

**SignedIou / Iou:**
- Purpose: represents one off-chain obligation (debtor owes creditor `amount`), plus its signature and canonical
  id (the EIP-712 digest itself, used for dedup and manifest membership)
- Examples: `src/types.ts:4-22`, produced by `src/iou.ts:signIou`
- Pattern: value object; immutable; `id` is derived, never assigned

**NetResult:**
- Purpose: output of the pure netting function — the canonical, sorted, zero-sum-guaranteed per-participant
  positions plus the list of IOUs consumed
- Examples: `src/types.ts:25-36`, produced by `src/netting.ts:net()`
- Pattern: pure computation result; no side effects; safe to recompute independently by any party

**RoundProposal:**
- Purpose: a `NetResult` wrapped with a `roundNonce`, `manifestHash`, and the EIP-712 `digest` every participant
  signs — the exact payload sent to `executeRound`
- Examples: `src/types.ts:39-47`, produced by `src/round.ts:buildProposal()`
- Pattern: proposal/consent pattern — proposal is untrusted until independently reproduced by each signer
  (`verifyProposal`)

**HubClient:**
- Purpose: typed wrapper isolating all viem `readContract`/`writeContract` calls against one `ClearingHub`
  deployment, including gas/fee overrides required by Arc's dual-role USDC gas token
- Examples: `src/client.ts:26-119`
- Pattern: thin repository/gateway over a single contract ABI

**CreditCapTracker:**
- Purpose: purely client-side bilateral exposure ledger — bounds worst-case unsettled credit per counterparty;
  never enforced on-chain
- Examples: `src/creditCap.ts:10-50`
- Pattern: in-memory ledger keyed by `"debtor->creditor"`; caller decides whether to extend more credit

**Coordinator (demo-only):**
- Purpose: orchestrates the full round lifecycle as an explicit phase state machine
  (`idle → netting → collecting-consents → submitting → confirmed/failed`)
- Examples: `demo/coordinator.ts:9-15,34-178`
- Pattern: reference implementation only — holds no cryptographic authority (cannot forge signatures), so a
  malicious or buggy coordinator can at worst stall or misreport, never move funds without consent

## Entry Points

**Contract deployment:**
- Location: `contracts/script/Deploy.s.sol`
- Triggers: `forge script contracts/script/Deploy.s.sol ...` (see `README.md` Quickstart)
- Responsibilities: deploys one `ClearingHub` bound to `TOKEN_ADDRESS` env var

**SDK package entry:**
- Location: `src/index.ts`
- Triggers: any consumer importing `arclear` (re-exports `types`, `domain`, `iou`, `netting`, `round`,
  `creditCap`, `client`)
- Responsibilities: public API surface for third-party integrators

**Demo end-to-end script:**
- Location: `demo/e2e.ts`
- Triggers: `npm run e2e:anvil` or `npm run e2e:testnet`
- Responsibilities: scripted full-cycle run (setup → ~105 IOUs → net → consent → settle → assert balances match
  engine output exactly)

**Demo HTTP server:**
- Location: `demo/server.ts`
- Triggers: `npm run demo` (testnet) or `npm run demo -- --anvil` (local)
- Responsibilities: hosts `public/dashboard.html`; exposes `GET /state`, `POST /simulate`, `POST /round`

**Sweep tool:**
- Location: `demo/sweep.ts` (drives `demo/flowModel.ts`)
- Triggers: `npm run sweep`
- Responsibilities: runs the pure netting engine over synthetic flow parameters (reciprocity × density × n ×
  200 seeds) and writes `docs/sweep/sweep.csv` + SVG charts; no chain interaction

**Test suites:**
- Location: `test/*.test.ts` (vitest), `contracts/test/*.sol` (Foundry)
- Triggers: `npm test`, `npm run test:contracts`
- Responsibilities: property-based netting invariants, EIP-712 sign/verify roundtrips, cross-stack digest parity
  (`test/genFixture.ts` → `test/fixtures/digest.json` → consumed by both stacks)

## Architectural Constraints

- **Threading:** Single-threaded Node.js throughout the TS layer; the demo HTTP server (`demo/server.ts`) uses
  `node:http` directly with async/await, no worker threads or clustering.
- **Global state:** `demo/coordinator.ts`'s `Coordinator` class holds all round/IOU state as instance fields in
  process memory — restarting `demo/server.ts` loses all unsettled IOUs and round history. There is no
  persistence layer by design (this is a reference demo, not a production coordinator).
- **Circular imports:** None observed — `src/` modules form a strict DAG (`types` → `domain` → `iou`/`round` →
  `netting`/`creditCap`/`client`; `index.ts` re-exports all).
- **On-chain/off-chain digest coupling:** `src/round.ts:roundDigest` and `contracts/src/ClearingHub.sol:hashRound`
  must stay byte-for-byte identical (same `ROUND_TYPEHASH`, same encoding order). Any protocol change requires
  updating both plus the shared fixture in `test/fixtures/digest.json` and `docs/PROTOCOL.md`.
- **No division anywhere:** The netting engine (`src/netting.ts`) and contract deliberately use only bigint
  addition/subtraction — no rounding-error surface exists in the settlement math.

## Anti-Patterns

### Trusting a coordinator's output without local recomputation

**What happens:** A participant signs a round proposal without calling `verifyProposal()` first.
**Why it's wrong:** The coordinator (`demo/coordinator.ts`) holds no cryptographic authority, but if a client
signs blindly, it defeats the entire "unanimous consent over a re-derivable digest" security model — a buggy or
malicious coordinator could present different data to different signers.
**Do this instead:** Always call `verifyProposal()` (`src/round.ts:73`) against your own locally-tracked IOUs
before calling `signConsent()`. Every code path in this repo that signs a round consent goes through this check
first (see `demo/coordinator.ts:80-86`).

### Letting gas estimation run unbounded on Arc

**What happens:** Submitting a write transaction without an explicit `gas` limit on Arc Testnet, where USDC is
simultaneously the native gas token and the ERC-20 collateral token.
**Why it's wrong:** viem's gas estimation probes with large limits, which reserves the account's entire USDC
balance for gas and makes the simulated token transfer revert with "transfer amount exceeds balance" (documented
gotcha in `README.md`).
**Do this instead:** Always pass explicit `gas` and `maxFeePerGas` (≥ `MIN_MAX_FEE_PER_GAS`, 25 gwei) on writes —
see `src/client.ts:70-118` and `demo/setup.ts` fee overrides for the pattern.

## Error Handling

**Strategy:** Fail loud and stop, at every layer. No silent fallbacks, no retries baked into the SDK.

**Patterns:**
- Contract: custom Solidity errors (`error LengthMismatch()`, `error BadSignature(uint256 index)`, etc.) declared
  and reverted explicitly — no `require(string)` messages (`contracts/src/ClearingHub.sol:58-66`).
- SDK: functions throw plain `Error` with descriptive messages (e.g. `src/iou.ts:40` `"signer ... is not debtor
  ..."`); `verifyProposal()` returns a typed `{ ok: boolean; reason?: string }` result instead of throwing, so
  callers can decide to refuse consent gracefully (`src/round.ts:79`).
- Demo coordinator: wraps the round lifecycle in try/catch, sets `phase = "failed"` and `lastError`, then
  rethrows (`demo/coordinator.ts:117-121`) — callers (HTTP handler, e2e script) surface the error but the
  coordinator object remains inspectable afterward.
- HTTP server: catches all handler errors and responds `500` with `{ error: message }` (`demo/server.ts:107-111`).

## Cross-Cutting Concerns

**Logging:** Plain `console.log`/`console.error` throughout `demo/*` and box-drawing console reports
(`demo/report.ts`). No structured logging framework; nothing in `src/` logs (library code stays silent).

**Validation:** Enforced twice, independently: off-chain via `verifyProposal()`'s byte-for-byte comparison
(`src/round.ts`), and on-chain via signature recovery + strictly-ascending + zero-sum checks
(`contracts/src/ClearingHub.sol:120-127`). No shared validation library — the two implementations are
deliberately parallel and parity-tested (`contracts/test/DigestParity.t.sol`).

**Authentication:** Purely cryptographic — EIP-712 signatures recovered via ECDSA are the only form of
authorization in the system. No sessions, no API keys, no user accounts. `Ownable2Step` on the contract gates
only `pause()`/`unpause()` (circuit breaker), never fund movement.

---

*Architecture analysis: 2026-07-22*
