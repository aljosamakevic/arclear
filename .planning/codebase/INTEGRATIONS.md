# External Integrations

**Analysis Date:** 2026-07-22

## APIs & External Services

**Blockchain RPC:**
- Arc Testnet JSON-RPC - `https://rpc.testnet.arc.network` (chain id `5042002`)
  - Client: `viem` `createPublicClient`/`createWalletClient` (`src/client.ts`, `demo/setup.ts`)
  - Configured via `ARC_RPC_URL` env var, with the public endpoint as the default fallback (`src/domain.ts:12`, `.env.example`)
  - Chain definition: `arcTestnet` in `src/domain.ts` (custom `defineChain`, native currency USDC, 18 "decimals" as configured though the underlying ERC-20 facade uses 6)

**Local Blockchain (dev-only):**
- Anvil (Foundry's local EVM node) - spawned as a child process for fully local demo/e2e runs
  - Spawn logic: `demo/setup.ts` (`spawn("anvil", ["--silent"], ...)`)
  - Chain id `31337`, RPC `http://127.0.0.1:8545` (`demo/setup.ts:32-37`)
  - Also used directly via `forge test` for contract tests

**Block Explorer:**
- ArcScan - `https://testnet.arcscan.app`
  - Used for constructing transaction links (`demo/setup.ts:191`, `demo/server.ts:67`) and referenced in `README.md` for deployed hub addresses and verified source

**Faucet:**
- Circle Faucet - `https://faucet.circle.com/` (Arc Testnet selection)
  - Manual step documented in `README.md` and `.env.example` to fund the deployer with native USDC (gas) and ERC-20 USDC (collateral)

## Data Storage

**Databases:**
- None. No database of any kind — all state is either on-chain (`ClearingHub.sol` collateral mapping, round nonce) or held in-memory in the demo coordinator process (`demo/coordinator.ts`)

**File Storage:**
- Local filesystem only:
  - `.env` for secrets/config (never committed)
  - `test/fixtures/digest.json` - fixture consumed cross-stack by both the TS SDK (`test/genFixture.ts`) and Foundry tests (`contracts/test/DigestParity.t.sol`, granted read access via `fs_permissions` in `contracts/foundry.toml`)
  - `contracts/broadcast/`, `contracts/cache/`, `contracts/out/` - Foundry build/deploy artifacts (gitignored)
  - `docs/sweep/sweep.csv` and `.svg` charts - output of the parameter sweep script (`demo/sweep.ts`)

**Caching:**
- None

## Authentication & Identity

**Auth Provider:**
- None (no user-facing auth system). Identity/authorization on-chain is purely cryptographic:
  - EIP-712 typed-data signatures authorize IOUs and round settlement (`src/iou.ts`, `src/round.ts`, domain defined in `src/domain.ts`)
  - `Ownable2Step` (OpenZeppelin) gates a narrow owner role on `ClearingHub.sol` (pause/unpause only — "no owner access to funds" per design)
  - Demo agent identities are deterministic BIP-39 HD wallet accounts derived via `viem/accounts` `mnemonicToAccount` (`demo/agents.ts`), from either the well-known Anvil test mnemonic or `AGENT_MNEMONIC` env var for testnet

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry/error-tracking SDK)

**Logs:**
- `console.log`/`console.error` only, throughout demo scripts (`demo/server.ts`, `demo/report.ts`, `demo/e2e.ts`) and Foundry's `console.log` in `contracts/script/Deploy.s.sol`

## CI/CD & Deployment

**Hosting:**
- No application hosting — this is a protocol/SDK repo. The only "deployment" artifact is the `ClearingHub` contract, deployed via Foundry script to Arc Testnet
- Demo dashboard runs locally only (`npm run demo`), not deployed anywhere

**CI Pipeline:**
- None detected (no `.github/workflows`, no CI config files found)

**Deployment tooling:**
- `contracts/script/Deploy.s.sol` (Foundry script) - deploys one `ClearingHub` per ERC-20 (`TOKEN_ADDRESS` env var), invoked via:
  `forge script contracts/script/Deploy.s.sol --root contracts --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PK" --broadcast --with-gas-price 25gwei`
- Two hubs already deployed and source-verified on Arc Testnet (per `README.md`):
  - USDC hub: `0xd5A9ef69b47b0a3C8d326fDABd57aCaFA7D3d6e2`
  - EURC hub: `0x867AD43f216B03c2a79eE02eC56F4bbEf90502c0`

## Environment Configuration

**Required env vars** (`.env.example`):
- `ARC_RPC_URL` - Arc Testnet RPC endpoint (defaults to public endpoint if unset)
- `DEPLOYER_PK` - 0x-prefixed private key funding deployments/relaying; needs native USDC (gas) + ERC-20 USDC (collateral top-ups)
- `AGENT_MNEMONIC` - BIP-39 mnemonic used to derive the 5 demo agent accounts (indices 1-5; index 0 reserved for deployer/relayer, see `demo/agents.ts`)
- `HUB_USDC` - deployed ClearingHub address for the USDC token, set after running the deploy script
- `HUB_EURC` - deployed ClearingHub address for the EURC token
- `PORT` (optional, defaults to `4402`) - demo dashboard HTTP server port (`demo/server.ts:25`)
- `TOKEN_ADDRESS` (Foundry-only, passed at deploy time, not in `.env`) - ERC-20 address the new hub will clear (`contracts/script/Deploy.s.sol`)

**Secrets location:**
- `.env` file at repo root, gitignored (`.gitignore` lines: `.env`, `.env.local`); loaded by both the custom Node loader (`demo/env.ts`) and directly by Foundry via `${ARC_RPC_URL}` interpolation in `contracts/foundry.toml`
- No secrets manager / vault integration

## Webhooks & Callbacks

**Incoming:**
- Demo dashboard HTTP endpoints (not authenticated, localhost-only by convention) served by `demo/server.ts`:
  - `GET /` and `GET /dashboard.html` - serves `public/dashboard.html`
  - `GET /state` - returns coordinator state as JSON, polled by the dashboard
  - `POST /simulate` - triggers a burst of ~35 signed IOUs via `demo/simulate.ts`
  - `POST /round` - triggers `Coordinator.runRound` to settle a netting round on-chain

**Outgoing:**
- None (no external webhook dispatch). All on-chain "callbacks" are direct contract calls (`deposit`, `withdraw`, `executeRound`) via `viem` wallet clients in `src/client.ts`

---

*Integration audit: 2026-07-22*
