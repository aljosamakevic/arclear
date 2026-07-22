<!-- GSD:project-start source:PROJECT.md -->
## Project

**Arclear v2 — From Netting Primitive to Actual Clearinghouse**

Arclear is evolving from a collateralized multilateral netting primitive into a two-product clearing stack on Arc Testnet: **Arclear Net** (permissionless collateralized netting — exists, stays live) and **Arclear CCP** (novation + margin + default waterfall — new). It serves Arc builders running agent swarms that transact bidirectionally at high frequency, showcase reviewers, and anyone wanting a reference implementation of clearing mechanics on-chain.

**Core Value:** A CCP is defined by operating *through* a member failure: the system must keep settling when members stall or default, with every risk mechanism (threshold consent, margin, waterfall) legible, invariant-tested, and honest about its calibration status.

### Constraints

- **Tech stack**: Foundry (`via_ir = true`) + viem-only SDK + npm/tsx/vitest/fast-check, zero-framework dashboard — carried from v1, fixed
- **Timeline**: Part-time; phase boundaries are the natural pause points
- **Compatibility**: `ClearingHub.sol` interface unchanged where touched (merkle root reuses the `manifestHash` bytes32 field); v1 stays live as Arclear Net
- **Protocol math**: No division anywhere in protocol math — bigint / int256 base units only
- **Security**: Withdrawal never pausable in ClearingHub; coordinator holds no keys/authority in the Net product
- **Testing discipline**: Shared TS↔Solidity digest fixtures for every new signed struct; explicit gas limits on all Arc writes
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 5.6+ (strict mode) - SDK, tests, and demo scripts (`src/`, `test/`, `demo/`)
- Solidity 0.8.26 - On-chain clearing contract (`contracts/src/ClearingHub.sol`)
- HTML/vanilla JS - Zero-dependency live dashboard (`public/dashboard.html`), served as a static file by the demo HTTP server
## Runtime
- Node.js (ESM, `"type": "module"` in `package.json`) — verified running v24.11.1 locally; no `.nvmrc`/engines field pins a specific version
- Solidity contracts run inside the EVM; local dev/test execution via Foundry's Anvil (chain id `31337`) or Arc Testnet (chain id `5042002`)
- npm (root TS project) — `package-lock.json` present
- Foundry's `forge` (contracts) — dependencies vendored under `contracts/lib/` (git submodules, no separate lockfile); local `forge` binary is v1.3.5-stable
## Frameworks
- viem 2.55.5 (declared `^2.21.0` in `package.json`) - sole blockchain client library; used for RPC clients, wallet clients, ABI encoding, EIP-712 signing (`src/client.ts`, `src/domain.ts`, `src/iou.ts`, `src/round.ts`)
- Foundry (forge-std) - Solidity build/test/script framework for `contracts/` (`contracts/foundry.toml`)
- OpenZeppelin Contracts 5.6.1 - Solidity security primitives: `EIP712`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, `ECDSA` (imported in `contracts/src/ClearingHub.sol`, vendored at `contracts/lib/openzeppelin-contracts`)
- vitest 2.1+ - TypeScript unit/property tests (`vitest.config.ts`, `test/*.test.ts`)
- fast-check 3.22+ - property-based testing (zero-sum, shuffle-determinism, dedup idempotence) used inside `test/netting.test.ts`
- forge test (Foundry) - Solidity unit tests, revert-matrix tests, and 512-run fuzz tests (`contracts/test/ClearingHub.t.sol`, `contracts/test/ClearingHubFuzz.t.sol`, `contracts/test/DigestParity.t.sol`)
- tsx 4.19+ - runs TypeScript scripts directly without a separate compile step (used for all `npm run` scripts: `fixture`, `e2e:anvil`, `e2e:testnet`, `demo`, `report`, `sweep`)
- TypeScript compiler (`tsc`, via `typescript` 5.6+) - type-checking only; `noEmit: true` in `tsconfig.json` (no build/dist output, no bundler)
- Foundry `forge build` - Solidity compilation with `via_ir = true`, optimizer runs = 1,000,000 (`contracts/foundry.toml`)
## Key Dependencies
- `viem` ^2.21.0 - the only runtime dependency of the TS SDK; provides EIP-712 typed-data signing, contract read/write clients, and chain definitions
- `@openzeppelin/contracts` 5.6.1 (Solidity, via forge remapping `@openzeppelin/=lib/openzeppelin-contracts/`) - audited building blocks for the settlement contract
- `forge-std` (Solidity, via remapping `forge-std/=lib/forge-std/src/`) - Foundry's standard test/script library
- `fast-check` ^3.22.0 (dev) - property-based test generation
- `tsx` ^4.19.0 (dev) - TS execution for scripts/demo/e2e without a build step
- `@types/node` ^22.0.0 (dev) - Node type definitions
## Configuration
- Loaded via a minimal, dependency-free `.env` parser at `demo/env.ts` (regex-based line parser, only sets vars not already in `process.env`)
- Config template: `.env.example` — documents `ARC_RPC_URL`, `DEPLOYER_PK`, `AGENT_MNEMONIC`, `HUB_USDC`, `HUB_EURC`
- `.env` is gitignored (`.gitignore`); never committed
- Foundry reads `ARC_RPC_URL` directly via `[rpc_endpoints]` in `contracts/foundry.toml` (`arc_testnet = "${ARC_RPC_URL}"`)
- Contract deployment reads `TOKEN_ADDRESS` via `vm.envAddress` in `contracts/script/Deploy.s.sol`
- `tsconfig.json` - target ES2022, module/moduleResolution `NodeNext`, `strict: true`, `noEmit: true`, includes `src`, `test`, `demo`
- `vitest.config.ts` - includes `test/**/*.test.ts`, excludes `contracts/**` and `node_modules/**`
- `contracts/foundry.toml` - solc 0.8.26, optimizer on (1,000,000 runs), `via_ir = true`, fuzz runs = 512, `fs_permissions` grants read access to `../test/fixtures` (used for cross-stack digest parity testing)
## Platform Requirements
- Node.js + npm for the TypeScript SDK/demo
- Foundry toolchain (`forge`, `anvil`, `cast`) for contract build/test/deploy — installed separately, not via npm
- Anvil (bundled with Foundry) required for fully local e2e runs (`npm run e2e:anvil`, `npm run demo -- --anvil`)
- No traditional server deployment — the "production" surface is smart contracts deployed to Arc Testnet (chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`)
- Demo dashboard (`demo/server.ts`) is a plain Node `http` server (no framework), intended for local/demo use only, default port 4402
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Scope Note
- **TypeScript SDK/demo** (`src/`, `demo/`, `test/`) — viem-based, functional core
- **Solidity contracts** (`contracts/src/`, `contracts/test/`) — Foundry, OpenZeppelin
## Naming Patterns
- `camelCase.ts` for modules: `netting.ts`, `creditCap.ts`, `genFixture.ts`, `flowModel.ts`
- One concern per file, named after its primary export domain (not the export itself): `iou.ts` exports `iouId`/`signIou`/`verifyIou`, `round.ts` exports `buildProposal`/`verifyProposal`/etc.
- Test files: `<subject>.test.ts` co-located under `test/` (not next to source): `test/netting.test.ts`, `test/eip712.test.ts`
- `PascalCase.sol` matching the primary contract name: `ClearingHub.sol`
- Test files: `<Contract>.t.sol` (Foundry convention): `ClearingHub.t.sol`, `ClearingHubFuzz.t.sol`, `DigestParity.t.sol`
- Test helpers under `test/utils/`: `RoundBuilder.sol`
- `camelCase`, verb-first for actions: `signIou`, `verifyIou`, `buildProposal`, `verifyProposal`, `signConsent`, `manifestHash`
- Private/internal helpers prefixed with nothing special but kept unexported (module-private `function` declarations without `export`), e.g. `iouMessage`, `roundMessage` in `src/iou.ts` / `src/round.ts`
- Class methods on stateful trackers use short, non-verb names when they're queries: `capFor`, `exposureOf`, `wouldExceedCap` (`src/creditCap.ts`)
- `camelCase` for external/public functions: `deposit`, `withdraw`, `executeRound`, `hashRound`, `pause`, `unpause`
- Internal test helpers prefixed `_`: `_setUpActors`, `_fundAndDeposit`, `_buildSignatures`, `_digest`, `_simpleRound` (`contracts/test/utils/RoundBuilder.sol`)
- Test functions prefixed `test_` for units, `testFuzz_` for fuzz tests, with `_revert` / `revert_` segment for negative cases: `test_revert_wrongNonce`, `testFuzz_perturbationAlwaysReverts` (`contracts/test/ClearingHub.t.sol`)
- `bigint` values use short, domain-meaningful names (`amount`, `nonce`, `expiry`, `delta`), never abbreviated beyond domain terms
- Lowercased-address map keys are always explicit about the transform: `debtor.toLowerCase()`, with comments noting the map holds `"lowercase -> checksummed"` (`src/netting.ts:33-34`, `src/creditCap.ts:11`)
- Loop indices in Solidity: bare `i`, `j`, unchecked pre-increment (`++i`) inside `for` loops per Foundry/gas-conscious style (`contracts/src/ClearingHub.sol:120`)
- Interfaces (not `type` aliases) for record-shaped domain objects: `Iou`, `SignedIou`, `NetResult`, `RoundProposal` (`src/types.ts`)
- Solidity custom errors, `PascalCase`, no `Error` suffix: `LengthMismatch`, `TooFewParticipants`, `BadSignature(uint256 index)` (`contracts/src/ClearingHub.sol:58-66`)
## Code Style
- No Prettier/ESLint config present in the repo (`.eslintrc*`, `.prettierrc*` absent) — style is enforced by convention/review only, not tooling
- 2-space indentation throughout TypeScript
- Double quotes for strings in TypeScript
- Trailing semicolons everywhere (TS and Solidity)
- Solidity uses 4-space indentation (Foundry default) and `pragma solidity 0.8.26;` pinned exactly (not a range) in every contract file
- No linter configured. Type safety is enforced instead via `tsconfig.json` `"strict": true` (`tsconfig.json:7`) — treat the TypeScript compiler as the primary correctness gate
- No `any` usage observed in `src/`; all external boundaries (viem, node fs) are fully typed
- NatSpec (`/// @notice`, `/// @dev`, `/// @param`, `/// @title`) used consistently on every public/external function and the contract itself (`contracts/src/ClearingHub.sol:12-27`)
- Custom errors used exclusively over `require(..., "string")` — no string-based reverts in production contract code
- Named return-value style avoided; helper functions return via `returns (...)` tuple destructuring at call sites, e.g. `(address[] memory p, int256[] memory d) = _simpleRound();`
## Import Organization
- None configured. All imports are relative (`./`, `../`) — no `@/` or baseUrl aliases in `tsconfig.json`
- `src/index.ts` re-exports every module with `export * from "./X.js"` in a fixed dependency order (types → domain → iou → netting → round → creditCap → client) — follow this order when adding new SDK modules
- Always named imports with explicit braces: `import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";`
- OpenZeppelin imports grouped first, then local/sibling contract/test imports
- Remappings defined in `contracts/foundry.toml`: `@openzeppelin/=lib/openzeppelin-contracts/`, `forge-std/=lib/forge-std/src/`
## Error Handling
- Plain `throw new Error("message")` for precondition violations, with the failing values interpolated into the message: `throw new Error(\`signer ${account.address} is not debtor ${iou.debtor}\`);` (`src/iou.ts:40`)
- Verification/validation functions return a discriminated result object instead of throwing, when the caller is expected to branch on failure: `{ ok: boolean; reason?: string }` from `verifyProposal` (`src/round.ts:79`) — use this pattern for any new "check X against Y" function rather than throwing
- No custom Error subclasses/classes — errors are generic `Error` with descriptive messages only
- Custom errors exclusively (`error LengthMismatch();`) — gas-efficient and typed; declared at contract top near state (`contracts/src/ClearingHub.sol:58-66`)
- Errors carry diagnostic parameters where useful for off-chain debugging: `error WrongRoundNonce(uint64 expected, uint64 provided);`, `error InsufficientCollateral(address participant, uint256 balance, uint256 required);`
- `nonReentrant` + `whenNotPaused` modifiers guard state-changing external functions except `withdraw`, which is deliberately never pausable (documented via NatSpec, not just code) — new external functions that move funds should default to `nonReentrant`
## Logging
## Comments
- Every exported function in `src/` has a one-line `/** ... */` doc comment describing intent and any non-obvious invariant, e.g. `/** Canonical id: the EIP-712 digest that is also what the debtor signs. */` (`src/iou.ts:22`)
- Numbered-rule comments used for algorithms with strict ordering requirements, cross-referenced to a spec doc: the netting engine's rules are numbered 1-7 in its doc comment and cross-referenced inline (`// rule 1`, `// rule 5`) at the point each rule is implemented (`src/netting.ts:4-20` and inline through the function body)
- Comments explain **why**, not what, especially around security-relevant invariants: `// Withdrawing between consent and execution can only revert the round in full — never partially settle it.`
- `/** ... */` block comments (not `//`) for anything exported; used for both functions and interface fields (`src/types.ts` documents nearly every field inline)
- No `@param`/`@returns` tags used — prose-only doc comments, kept to 1-3 lines
- Full `@title`/`@notice`/`@dev`/`@param` blocks on the contract and every public/external function — this is the most heavily documented part of the codebase; match this density for any new contract function
## Function Design
- TypeScript functions taking >2-3 params bundle trailing optional/config values into an `opts: {...}` object with inline type literal, e.g. `net(ious, opts: { now, safetyWindowSeconds?, settledIds? })` (`src/netting.ts:21-28`), `verifyProposal(..., opts: {...})` (`src/round.ts:78`)
- Required positional params come first (`hub`, `iou`/`proposal`), optional config/`opts` always comes last
- `chainId?: number` is a recurring trailing optional param across signing/verification functions, defaulting to Arc Testnet's chain id inside `domain()` (`src/domain.ts:36`)
- Pure functions return plain data (no wrapping in Result/Either types) except validation functions, which return `{ ok, reason? }`
- Async signing functions return `Promise<Hex>` or `Promise<SignedIou>` directly — no wrapper types
## Module Design
- Named exports only — no default exports anywhere in `src/`
- One class per file when stateful behavior is needed: `CreditCapTracker` (`src/creditCap.ts`), `HubClient` (`src/client.ts`); everything else is free functions
- Interfaces/types are colocated in `src/types.ts` as the single source of truth for domain shapes, imported with `import type` everywhere else
- `src/index.ts` is the sole barrel; it is a flat `export *` re-export list — do not create nested barrel files under subdirectories
## Domain-Specific Conventions
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
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
- Off-chain compute, on-chain enforce: all netting math happens in TypeScript (`src/netting.ts`); the contract
- Zero-trust coordinator: the "coordinator" (`demo/coordinator.ts`) assembles rounds but every participant
- Pure-function core: `net()` in `src/netting.ts` is a pure, deterministic, side-effect-free function — no I/O,
- Dual-implementation parity: the same EIP-712 digest logic is implemented once in Solidity
- No persistence layer: nothing is stored in a database. State lives in (a) on-chain contract storage
## Layers
- Purpose: custody collateral, enforce unanimous consent, apply net deltas atomically
- Location: `contracts/src/ClearingHub.sol`
- Contains: one Solidity contract (`ClearingHub`), inheriting OpenZeppelin `EIP712`, `Ownable2Step`, `Pausable`,
- Depends on: OpenZeppelin contracts (`contracts/lib/openzeppelin-contracts`), an ERC-20 token address passed at
- Used by: `src/client.ts` (via viem `readContract`/`writeContract`), `demo/setup.ts` (deployment),
- Purpose: implement the netting protocol as a portable, dependency-light TypeScript library (viem-only)
- Location: `src/`
- Contains: EIP-712 domain/types (`domain.ts`), IOU signing (`iou.ts`), netting engine (`netting.ts`), round
- Depends on: `viem` only (no framework), the deployed `ClearingHub` ABI
- Used by: `demo/*`, `test/*`, any external integrator importing `src/index.ts`
- Purpose: reference implementation of a coordinator + 5-agent economy + live dashboard, proving the SDK works
- Location: `demo/`
- Contains: environment bootstrap (`setup.ts`), synthetic traffic generation (`simulate.ts`, `flowModel.ts`),
- Depends on: `src/` SDK entirely; `viem` for chain interaction; Node's built-in `http` module (no web
- Used by: `npm run demo`, `npm run e2e:anvil`, `npm run e2e:testnet`, `npm run sweep` (see `package.json`)
- Purpose: zero-dependency live visualization of coordinator state
- Location: `public/dashboard.html`
- Contains: single static HTML file polling `GET /state` and posting to `/simulate` and `/round`
- Depends on: `demo/server.ts` HTTP endpoints only (no build step, no framework)
## Data Flow
### Primary Round-Settlement Path
### Demo Bootstrap Flow
- On-chain state: `collateral` mapping and `roundNonce` (`contracts/src/ClearingHub.sol:36,39`) — the only
- Off-chain state: `Coordinator` instance fields (`ious`, `settledIds`, `phase`, `rounds`) held entirely in
- No client-side database, cache, or session store anywhere in the codebase.
## Key Abstractions
- Purpose: represents one off-chain obligation (debtor owes creditor `amount`), plus its signature and canonical
- Examples: `src/types.ts:4-22`, produced by `src/iou.ts:signIou`
- Pattern: value object; immutable; `id` is derived, never assigned
- Purpose: output of the pure netting function — the canonical, sorted, zero-sum-guaranteed per-participant
- Examples: `src/types.ts:25-36`, produced by `src/netting.ts:net()`
- Pattern: pure computation result; no side effects; safe to recompute independently by any party
- Purpose: a `NetResult` wrapped with a `roundNonce`, `manifestHash`, and the EIP-712 `digest` every participant
- Examples: `src/types.ts:39-47`, produced by `src/round.ts:buildProposal()`
- Pattern: proposal/consent pattern — proposal is untrusted until independently reproduced by each signer
- Purpose: typed wrapper isolating all viem `readContract`/`writeContract` calls against one `ClearingHub`
- Examples: `src/client.ts:26-119`
- Pattern: thin repository/gateway over a single contract ABI
- Purpose: purely client-side bilateral exposure ledger — bounds worst-case unsettled credit per counterparty;
- Examples: `src/creditCap.ts:10-50`
- Pattern: in-memory ledger keyed by `"debtor->creditor"`; caller decides whether to extend more credit
- Purpose: orchestrates the full round lifecycle as an explicit phase state machine
- Examples: `demo/coordinator.ts:9-15,34-178`
- Pattern: reference implementation only — holds no cryptographic authority (cannot forge signatures), so a
## Entry Points
- Location: `contracts/script/Deploy.s.sol`
- Triggers: `forge script contracts/script/Deploy.s.sol ...` (see `README.md` Quickstart)
- Responsibilities: deploys one `ClearingHub` bound to `TOKEN_ADDRESS` env var
- Location: `src/index.ts`
- Triggers: any consumer importing `arclear` (re-exports `types`, `domain`, `iou`, `netting`, `round`,
- Responsibilities: public API surface for third-party integrators
- Location: `demo/e2e.ts`
- Triggers: `npm run e2e:anvil` or `npm run e2e:testnet`
- Responsibilities: scripted full-cycle run (setup → ~105 IOUs → net → consent → settle → assert balances match
- Location: `demo/server.ts`
- Triggers: `npm run demo` (testnet) or `npm run demo -- --anvil` (local)
- Responsibilities: hosts `public/dashboard.html`; exposes `GET /state`, `POST /simulate`, `POST /round`
- Location: `demo/sweep.ts` (drives `demo/flowModel.ts`)
- Triggers: `npm run sweep`
- Responsibilities: runs the pure netting engine over synthetic flow parameters (reciprocity × density × n ×
- Location: `test/*.test.ts` (vitest), `contracts/test/*.sol` (Foundry)
- Triggers: `npm test`, `npm run test:contracts`
- Responsibilities: property-based netting invariants, EIP-712 sign/verify roundtrips, cross-stack digest parity
## Architectural Constraints
- **Threading:** Single-threaded Node.js throughout the TS layer; the demo HTTP server (`demo/server.ts`) uses
- **Global state:** `demo/coordinator.ts`'s `Coordinator` class holds all round/IOU state as instance fields in
- **Circular imports:** None observed — `src/` modules form a strict DAG (`types` → `domain` → `iou`/`round` →
- **On-chain/off-chain digest coupling:** `src/round.ts:roundDigest` and `contracts/src/ClearingHub.sol:hashRound`
- **No division anywhere:** The netting engine (`src/netting.ts`) and contract deliberately use only bigint
## Anti-Patterns
### Trusting a coordinator's output without local recomputation
### Letting gas estimation run unbounded on Arc
## Error Handling
- Contract: custom Solidity errors (`error LengthMismatch()`, `error BadSignature(uint256 index)`, etc.) declared
- SDK: functions throw plain `Error` with descriptive messages (e.g. `src/iou.ts:40` `"signer ... is not debtor
- Demo coordinator: wraps the round lifecycle in try/catch, sets `phase = "failed"` and `lastError`, then
- HTTP server: catches all handler errors and responds `500` with `{ error: message }` (`demo/server.ts:107-111`).
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
