# Coding Conventions

**Analysis Date:** 2026-07-22

## Scope Note

This repo has two distinct code surfaces with their own conventions:
- **TypeScript SDK/demo** (`src/`, `demo/`, `test/`) — viem-based, functional core
- **Solidity contracts** (`contracts/src/`, `contracts/test/`) — Foundry, OpenZeppelin

Each is documented below where conventions diverge.

## Naming Patterns

**Files (TypeScript):**
- `camelCase.ts` for modules: `netting.ts`, `creditCap.ts`, `genFixture.ts`, `flowModel.ts`
- One concern per file, named after its primary export domain (not the export itself): `iou.ts` exports `iouId`/`signIou`/`verifyIou`, `round.ts` exports `buildProposal`/`verifyProposal`/etc.
- Test files: `<subject>.test.ts` co-located under `test/` (not next to source): `test/netting.test.ts`, `test/eip712.test.ts`

**Files (Solidity):**
- `PascalCase.sol` matching the primary contract name: `ClearingHub.sol`
- Test files: `<Contract>.t.sol` (Foundry convention): `ClearingHub.t.sol`, `ClearingHubFuzz.t.sol`, `DigestParity.t.sol`
- Test helpers under `test/utils/`: `RoundBuilder.sol`

**Functions (TypeScript):**
- `camelCase`, verb-first for actions: `signIou`, `verifyIou`, `buildProposal`, `verifyProposal`, `signConsent`, `manifestHash`
- Private/internal helpers prefixed with nothing special but kept unexported (module-private `function` declarations without `export`), e.g. `iouMessage`, `roundMessage` in `src/iou.ts` / `src/round.ts`
- Class methods on stateful trackers use short, non-verb names when they're queries: `capFor`, `exposureOf`, `wouldExceedCap` (`src/creditCap.ts`)

**Functions (Solidity):**
- `camelCase` for external/public functions: `deposit`, `withdraw`, `executeRound`, `hashRound`, `pause`, `unpause`
- Internal test helpers prefixed `_`: `_setUpActors`, `_fundAndDeposit`, `_buildSignatures`, `_digest`, `_simpleRound` (`contracts/test/utils/RoundBuilder.sol`)
- Test functions prefixed `test_` for units, `testFuzz_` for fuzz tests, with `_revert` / `revert_` segment for negative cases: `test_revert_wrongNonce`, `testFuzz_perturbationAlwaysReverts` (`contracts/test/ClearingHub.t.sol`)

**Variables:**
- `bigint` values use short, domain-meaningful names (`amount`, `nonce`, `expiry`, `delta`), never abbreviated beyond domain terms
- Lowercased-address map keys are always explicit about the transform: `debtor.toLowerCase()`, with comments noting the map holds `"lowercase -> checksummed"` (`src/netting.ts:33-34`, `src/creditCap.ts:11`)
- Loop indices in Solidity: bare `i`, `j`, unchecked pre-increment (`++i`) inside `for` loops per Foundry/gas-conscious style (`contracts/src/ClearingHub.sol:120`)

**Types:**
- Interfaces (not `type` aliases) for record-shaped domain objects: `Iou`, `SignedIou`, `NetResult`, `RoundProposal` (`src/types.ts`)
- Solidity custom errors, `PascalCase`, no `Error` suffix: `LengthMismatch`, `TooFewParticipants`, `BadSignature(uint256 index)` (`contracts/src/ClearingHub.sol:58-66`)

## Code Style

**Formatting:**
- No Prettier/ESLint config present in the repo (`.eslintrc*`, `.prettierrc*` absent) — style is enforced by convention/review only, not tooling
- 2-space indentation throughout TypeScript
- Double quotes for strings in TypeScript
- Trailing semicolons everywhere (TS and Solidity)
- Solidity uses 4-space indentation (Foundry default) and `pragma solidity 0.8.26;` pinned exactly (not a range) in every contract file

**Linting:**
- No linter configured. Type safety is enforced instead via `tsconfig.json` `"strict": true` (`tsconfig.json:7`) — treat the TypeScript compiler as the primary correctness gate
- No `any` usage observed in `src/`; all external boundaries (viem, node fs) are fully typed

**Solidity style:**
- NatSpec (`/// @notice`, `/// @dev`, `/// @param`, `/// @title`) used consistently on every public/external function and the contract itself (`contracts/src/ClearingHub.sol:12-27`)
- Custom errors used exclusively over `require(..., "string")` — no string-based reverts in production contract code
- Named return-value style avoided; helper functions return via `returns (...)` tuple destructuring at call sites, e.g. `(address[] memory p, int256[] memory d) = _simpleRound();`

## Import Organization

**Order (TypeScript):**
1. External packages first: `viem`, `viem/accounts`, `fast-check`, node builtins (`node:fs`, `node:path`, `node:url`)
2. Local modules last, always with explicit `.js` extension (NodeNext ESM resolution): `./domain.js`, `../src/netting.js`
3. Type-only imports use `import type { ... }` consistently, often mixed inline with value imports from the same module: `import { hashTypedData, verifyTypedData, type Address, type Hex } from "viem";` (`src/iou.ts:1-6`)

**Path Aliases:**
- None configured. All imports are relative (`./`, `../`) — no `@/` or baseUrl aliases in `tsconfig.json`

**Barrel files:**
- `src/index.ts` re-exports every module with `export * from "./X.js"` in a fixed dependency order (types → domain → iou → netting → round → creditCap → client) — follow this order when adding new SDK modules

**Solidity imports:**
- Always named imports with explicit braces: `import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";`
- OpenZeppelin imports grouped first, then local/sibling contract/test imports
- Remappings defined in `contracts/foundry.toml`: `@openzeppelin/=lib/openzeppelin-contracts/`, `forge-std/=lib/forge-std/src/`

## Error Handling

**TypeScript:**
- Plain `throw new Error("message")` for precondition violations, with the failing values interpolated into the message: `throw new Error(\`signer ${account.address} is not debtor ${iou.debtor}\`);` (`src/iou.ts:40`)
- Verification/validation functions return a discriminated result object instead of throwing, when the caller is expected to branch on failure: `{ ok: boolean; reason?: string }` from `verifyProposal` (`src/round.ts:79`) — use this pattern for any new "check X against Y" function rather than throwing
- No custom Error subclasses/classes — errors are generic `Error` with descriptive messages only

**Solidity:**
- Custom errors exclusively (`error LengthMismatch();`) — gas-efficient and typed; declared at contract top near state (`contracts/src/ClearingHub.sol:58-66`)
- Errors carry diagnostic parameters where useful for off-chain debugging: `error WrongRoundNonce(uint64 expected, uint64 provided);`, `error InsufficientCollateral(address participant, uint256 balance, uint256 required);`
- `nonReentrant` + `whenNotPaused` modifiers guard state-changing external functions except `withdraw`, which is deliberately never pausable (documented via NatSpec, not just code) — new external functions that move funds should default to `nonReentrant`

## Logging

**Framework:** None — no logging library in `src/` or `demo/`. `console.log`/`console.error` used directly in scripts (`demo/`, `test/genFixture.ts`) for CLI-style progress/diagnostic output. Never used inside `src/` library code (library code stays side-effect free; only entry-point scripts print).

## Comments

**When to comment:**
- Every exported function in `src/` has a one-line `/** ... */` doc comment describing intent and any non-obvious invariant, e.g. `/** Canonical id: the EIP-712 digest that is also what the debtor signs. */` (`src/iou.ts:22`)
- Numbered-rule comments used for algorithms with strict ordering requirements, cross-referenced to a spec doc: the netting engine's rules are numbered 1-7 in its doc comment and cross-referenced inline (`// rule 1`, `// rule 5`) at the point each rule is implemented (`src/netting.ts:4-20` and inline through the function body)
- Comments explain **why**, not what, especially around security-relevant invariants: `// Withdrawing between consent and execution can only revert the round in full — never partially settle it.`

**JSDoc/TSDoc:**
- `/** ... */` block comments (not `//`) for anything exported; used for both functions and interface fields (`src/types.ts` documents nearly every field inline)
- No `@param`/`@returns` tags used — prose-only doc comments, kept to 1-3 lines

**Solidity NatSpec:**
- Full `@title`/`@notice`/`@dev`/`@param` blocks on the contract and every public/external function — this is the most heavily documented part of the codebase; match this density for any new contract function

## Function Design

**Size:** Small, single-purpose functions (typically under 20 lines). The largest function, `executeRound` (`contracts/src/ClearingHub.sol:104-149`), is ~45 lines and is split into clearly commented phases (validate → recompute digest → verify signatures & sum → apply deltas).

**Parameters:**
- TypeScript functions taking >2-3 params bundle trailing optional/config values into an `opts: {...}` object with inline type literal, e.g. `net(ious, opts: { now, safetyWindowSeconds?, settledIds? })` (`src/netting.ts:21-28`), `verifyProposal(..., opts: {...})` (`src/round.ts:78`)
- Required positional params come first (`hub`, `iou`/`proposal`), optional config/`opts` always comes last
- `chainId?: number` is a recurring trailing optional param across signing/verification functions, defaulting to Arc Testnet's chain id inside `domain()` (`src/domain.ts:36`)

**Return Values:**
- Pure functions return plain data (no wrapping in Result/Either types) except validation functions, which return `{ ok, reason? }`
- Async signing functions return `Promise<Hex>` or `Promise<SignedIou>` directly — no wrapper types

## Module Design

**Exports:**
- Named exports only — no default exports anywhere in `src/`
- One class per file when stateful behavior is needed: `CreditCapTracker` (`src/creditCap.ts`), `HubClient` (`src/client.ts`); everything else is free functions
- Interfaces/types are colocated in `src/types.ts` as the single source of truth for domain shapes, imported with `import type` everywhere else

**Barrel Files:**
- `src/index.ts` is the sole barrel; it is a flat `export *` re-export list — do not create nested barrel files under subdirectories

## Domain-Specific Conventions

**bigint discipline:** All monetary/on-chain values (`amount`, `nonce`, `delta`, `expiry`) are `bigint`, never `number`. Division is explicitly avoided in the netting engine ("Pure function; bigint arithmetic only — there is no division anywhere in the protocol", `src/netting.ts:5`). When adding new numeric logic touching money or chain-native values, use `bigint` and avoid `/`.

**Address case handling:** Addresses are compared/keyed in lowercase internally but the original checksummed form is preserved for output — see the `positions`/`original` map pairing pattern in `src/netting.ts:33-56`. Replicate this pattern (lowercase key map + parallel checksum map) whenever de-duplicating or aggregating by address.

**Determinism requirement:** Any function that produces an on-chain-relevant artifact (netting result, manifest hash, round digest) must be deterministic and order-independent — enforced by property tests (see TESTING.md). New logic in this area must not depend on `Map`/`Set` iteration order for output; always sort before returning (`src/netting.ts:55,58`).

---

*Convention analysis: 2026-07-22*
