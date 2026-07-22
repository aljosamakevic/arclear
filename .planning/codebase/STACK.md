# Technology Stack

**Analysis Date:** 2026-07-22

## Languages

**Primary:**
- TypeScript 5.6+ (strict mode) - SDK, tests, and demo scripts (`src/`, `test/`, `demo/`)
- Solidity 0.8.26 - On-chain clearing contract (`contracts/src/ClearingHub.sol`)

**Secondary:**
- HTML/vanilla JS - Zero-dependency live dashboard (`public/dashboard.html`), served as a static file by the demo HTTP server

## Runtime

**Environment:**
- Node.js (ESM, `"type": "module"` in `package.json`) — verified running v24.11.1 locally; no `.nvmrc`/engines field pins a specific version
- Solidity contracts run inside the EVM; local dev/test execution via Foundry's Anvil (chain id `31337`) or Arc Testnet (chain id `5042002`)

**Package Manager:**
- npm (root TS project) — `package-lock.json` present
- Foundry's `forge` (contracts) — dependencies vendored under `contracts/lib/` (git submodules, no separate lockfile); local `forge` binary is v1.3.5-stable

## Frameworks

**Core:**
- viem 2.55.5 (declared `^2.21.0` in `package.json`) - sole blockchain client library; used for RPC clients, wallet clients, ABI encoding, EIP-712 signing (`src/client.ts`, `src/domain.ts`, `src/iou.ts`, `src/round.ts`)
- Foundry (forge-std) - Solidity build/test/script framework for `contracts/` (`contracts/foundry.toml`)
- OpenZeppelin Contracts 5.6.1 - Solidity security primitives: `EIP712`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, `ECDSA` (imported in `contracts/src/ClearingHub.sol`, vendored at `contracts/lib/openzeppelin-contracts`)

**Testing:**
- vitest 2.1+ - TypeScript unit/property tests (`vitest.config.ts`, `test/*.test.ts`)
- fast-check 3.22+ - property-based testing (zero-sum, shuffle-determinism, dedup idempotence) used inside `test/netting.test.ts`
- forge test (Foundry) - Solidity unit tests, revert-matrix tests, and 512-run fuzz tests (`contracts/test/ClearingHub.t.sol`, `contracts/test/ClearingHubFuzz.t.sol`, `contracts/test/DigestParity.t.sol`)

**Build/Dev:**
- tsx 4.19+ - runs TypeScript scripts directly without a separate compile step (used for all `npm run` scripts: `fixture`, `e2e:anvil`, `e2e:testnet`, `demo`, `report`, `sweep`)
- TypeScript compiler (`tsc`, via `typescript` 5.6+) - type-checking only; `noEmit: true` in `tsconfig.json` (no build/dist output, no bundler)
- Foundry `forge build` - Solidity compilation with `via_ir = true`, optimizer runs = 1,000,000 (`contracts/foundry.toml`)

## Key Dependencies

**Critical:**
- `viem` ^2.21.0 - the only runtime dependency of the TS SDK; provides EIP-712 typed-data signing, contract read/write clients, and chain definitions
- `@openzeppelin/contracts` 5.6.1 (Solidity, via forge remapping `@openzeppelin/=lib/openzeppelin-contracts/`) - audited building blocks for the settlement contract
- `forge-std` (Solidity, via remapping `forge-std/=lib/forge-std/src/`) - Foundry's standard test/script library

**Infrastructure:**
- `fast-check` ^3.22.0 (dev) - property-based test generation
- `tsx` ^4.19.0 (dev) - TS execution for scripts/demo/e2e without a build step
- `@types/node` ^22.0.0 (dev) - Node type definitions

## Configuration

**Environment:**
- Loaded via a minimal, dependency-free `.env` parser at `demo/env.ts` (regex-based line parser, only sets vars not already in `process.env`)
- Config template: `.env.example` — documents `ARC_RPC_URL`, `DEPLOYER_PK`, `AGENT_MNEMONIC`, `HUB_USDC`, `HUB_EURC`
- `.env` is gitignored (`.gitignore`); never committed
- Foundry reads `ARC_RPC_URL` directly via `[rpc_endpoints]` in `contracts/foundry.toml` (`arc_testnet = "${ARC_RPC_URL}"`)
- Contract deployment reads `TOKEN_ADDRESS` via `vm.envAddress` in `contracts/script/Deploy.s.sol`

**Build:**
- `tsconfig.json` - target ES2022, module/moduleResolution `NodeNext`, `strict: true`, `noEmit: true`, includes `src`, `test`, `demo`
- `vitest.config.ts` - includes `test/**/*.test.ts`, excludes `contracts/**` and `node_modules/**`
- `contracts/foundry.toml` - solc 0.8.26, optimizer on (1,000,000 runs), `via_ir = true`, fuzz runs = 512, `fs_permissions` grants read access to `../test/fixtures` (used for cross-stack digest parity testing)

## Platform Requirements

**Development:**
- Node.js + npm for the TypeScript SDK/demo
- Foundry toolchain (`forge`, `anvil`, `cast`) for contract build/test/deploy — installed separately, not via npm
- Anvil (bundled with Foundry) required for fully local e2e runs (`npm run e2e:anvil`, `npm run demo -- --anvil`)

**Production:**
- No traditional server deployment — the "production" surface is smart contracts deployed to Arc Testnet (chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`)
- Demo dashboard (`demo/server.ts`) is a plain Node `http` server (no framework), intended for local/demo use only, default port 4402

---

*Stack analysis: 2026-07-22*
