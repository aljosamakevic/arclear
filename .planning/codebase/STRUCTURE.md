# Codebase Structure

**Analysis Date:** 2026-07-22

## Directory Layout

```
arclear/
├── contracts/                  # Foundry project — on-chain settlement
│   ├── src/
│   │   └── ClearingHub.sol     # the one production contract
│   ├── script/
│   │   └── Deploy.s.sol        # deployment script (one hub per ERC-20)
│   ├── test/
│   │   ├── ClearingHub.t.sol       # unit + revert-matrix tests
│   │   ├── ClearingHubFuzz.t.sol   # 512-run fuzz tests
│   │   ├── DigestParity.t.sol      # asserts on-chain digest == SDK digest
│   │   └── utils/RoundBuilder.sol  # test helper for building rounds
│   ├── lib/                    # git submodules: forge-std, openzeppelin-contracts
│   ├── out/                    # forge build artifacts (generated, gitignored)
│   ├── cache/                  # forge cache (generated, gitignored)
│   ├── broadcast/              # forge deployment broadcast logs (generated)
│   └── foundry.toml            # Foundry config (solc 0.8.26, via_ir, remappings)
├── src/                        # TypeScript SDK — the protocol implementation
│   ├── types.ts                # shared interfaces: Iou, SignedIou, NetResult, RoundProposal
│   ├── domain.ts                # EIP-712 domain, typed-data schemas, Arc chain config
│   ├── iou.ts                   # sign/verify individual IOUs
│   ├── netting.ts               # pure netting engine
│   ├── round.ts                 # proposal building, digest, consent sign/verify
│   ├── creditCap.ts             # client-side bilateral credit-cap tracker
│   ├── client.ts                # typed viem wrapper around ClearingHub
│   ├── index.ts                 # package entry — re-exports everything above
│   └── abi/
│       └── ClearingHub.ts       # generated ABI + bytecode (from `npm run abi`)
├── demo/                       # reference coordinator + 5-agent simulation + dashboard host
│   ├── env.ts                   # minimal zero-dependency .env loader
│   ├── agents.ts                # 5 persona definitions + relayer account derivation
│   ├── setup.ts                 # environment bootstrap: anvil (local) or testnet (attach)
│   ├── mockToken.ts              # local-only mock ERC-20 (anvil mode)
│   ├── simulate.ts               # synthetic ~100-IOU traffic generator (ring + cross-traffic)
│   ├── flowModel.ts              # parameterized synthetic flow generator for the sweep
│   ├── coordinator.ts            # round lifecycle state machine (net → consent → settle)
│   ├── report.ts                 # console box-drawing round summary
│   ├── e2e.ts                    # scripted end-to-end run + balance assertions
│   ├── server.ts                 # HTTP server hosting dashboard + /state /simulate /round
│   └── sweep.ts                  # statistical sweep over reciprocity/density/n → CSV + SVG
├── test/                       # vitest test suite (TypeScript SDK)
│   ├── eip712.test.ts            # sign/verify roundtrips, digest fixture parity check
│   ├── netting.test.ts           # fast-check property tests for the netting engine
│   ├── genFixture.ts             # generates the shared cross-stack digest fixture
│   └── fixtures/digest.json      # fixture consumed by both TS and Foundry parity tests
├── public/
│   └── dashboard.html            # zero-dependency static live dashboard (served by demo/server.ts)
├── docs/
│   ├── PROTOCOL.md                # netting/EIP-712 protocol specification (implementer's spec)
│   ├── THREAT-MODEL.md            # trust model / safety-liveness checklist
│   ├── PLAN.md                    # project planning notes
│   ├── V2-BRIEF.md                # v2 roadmap kickoff brief
│   └── sweep/                     # generated sweep output (CSV + SVG charts)
├── .planning/                  # GSD planning artifacts (config, PROJECT.md, codebase docs)
├── .claude/                     # local Claude Code settings
├── package.json                  # npm scripts, deps (viem, vitest, fast-check, tsx, typescript)
├── tsconfig.json                  # strict TS config; includes src, test, demo
├── vitest.config.ts                # vitest config: only test/**/*.test.ts
├── .env / .env.example             # runtime secrets (ARC_RPC_URL, DEPLOYER_PK, AGENT_MNEMONIC, HUB_USDC)
└── README.md                       # project overview, quickstart, trust model summary
```

## Directory Purposes

**`contracts/`:**
- Purpose: self-contained Foundry project for the on-chain settlement contract
- Contains: Solidity source, scripts, tests, vendored libraries (OpenZeppelin, forge-std), build artifacts
- Key files: `contracts/src/ClearingHub.sol`, `contracts/foundry.toml`, `contracts/script/Deploy.s.sol`

**`contracts/lib/`:**
- Purpose: vendored/submodule dependencies for Foundry (not hand-edited)
- Contains: `forge-std` (test/scripting utilities), `openzeppelin-contracts` (full OZ monorepo)
- Key files: not modified by this project; referenced via remappings in `foundry.toml`

**`contracts/out/`, `contracts/cache/`, `contracts/broadcast/`:**
- Purpose: Foundry build/deploy artifacts
- Generated: Yes (by `forge build` / `forge script ... --broadcast`)
- Committed: `broadcast/` is committed (deployment record); `out/` and `cache/` should be gitignored — verify
  before adding new files here

**`src/`:**
- Purpose: the portable, viem-only TypeScript SDK — this is the protocol implementation, importable standalone
- Contains: pure logic modules (`netting.ts`), signing/verification modules (`iou.ts`, `round.ts`), domain/config
  (`domain.ts`), shared types (`types.ts`), a typed contract client (`client.ts`), a generated ABI (`abi/`)
- Key files: `src/index.ts` (public entry), `src/netting.ts` (core algorithm), `src/round.ts` (protocol digest)

**`src/abi/`:**
- Purpose: generated contract ABI + bytecode consumed by `src/client.ts` and `demo/setup.ts`
- Generated: Yes — regenerated via `npm run abi` (copies `contracts/out/ClearingHub.sol/ClearingHub.json`)
- Committed: `ClearingHub.ts` is committed as the checked-in generated artifact; do not hand-edit

**`demo/`:**
- Purpose: reference coordinator implementation, synthetic multi-agent economy, and a live dashboard host,
  proving the SDK end-to-end against real chains (anvil or Arc Testnet)
- Contains: environment bootstrap, traffic simulators, the round-lifecycle state machine, an HTTP server, a
  scripted e2e runner, a statistical sweep tool
- Key files: `demo/coordinator.ts` (orchestration core), `demo/setup.ts` (chain bootstrap), `demo/server.ts`
  (HTTP + dashboard)

**`test/`:**
- Purpose: TypeScript SDK test suite (vitest) — property-based and example-based
- Contains: EIP-712 sign/verify tests, netting-engine property tests (fast-check), the shared cross-stack digest
  fixture and its generator
- Key files: `test/netting.test.ts` (property tests), `test/eip712.test.ts` (parity + roundtrip tests)

**`public/`:**
- Purpose: static assets served by the demo HTTP server
- Contains: `dashboard.html` — a single zero-dependency file (no build step, no bundler)
- Generated: No; hand-written

**`docs/`:**
- Purpose: protocol specification and project documentation for humans and third-party implementers
- Contains: `PROTOCOL.md` (the netting/EIP-712 spec third parties must reproduce identically), `THREAT-MODEL.md`,
  planning docs (`PLAN.md`, `V2-BRIEF.md`), and generated sweep output (`docs/sweep/`)
- Generated: `docs/sweep/*.csv` and `*.svg` are generated by `npm run sweep`; the `.md` files are hand-written

**`.planning/`:**
- Purpose: GSD (this tool's own) planning artifacts — phase plans, codebase maps, project config
- Contains: `config.json`, `PROJECT.md`, `codebase/` (this document lives here)
- Generated: Partially — `codebase/*.md` are generated by `/gsd:map-codebase`; `PROJECT.md`/`config.json` are
  authored by GSD planning commands

## Key File Locations

**Entry Points:**
- `src/index.ts`: public SDK package entry (re-exports all of `src/`)
- `demo/server.ts`: HTTP server + dashboard host (`npm run demo`)
- `demo/e2e.ts`: scripted end-to-end demonstration (`npm run e2e:anvil` / `npm run e2e:testnet`)
- `contracts/script/Deploy.s.sol`: contract deployment entry (`forge script ...`)

**Configuration:**
- `contracts/foundry.toml`: Solidity compiler/test/fuzz configuration, remappings, RPC endpoint alias
- `tsconfig.json`: strict TS compiler options (ES2022, NodeNext, no emit)
- `vitest.config.ts`: test file glob, excludes `contracts/` and `node_modules/`
- `package.json`: npm scripts (`test`, `test:contracts`, `fixture`, `abi`, `e2e:anvil`, `e2e:testnet`, `demo`,
  `report`, `sweep`)
- `.env` / `.env.example`: `ARC_RPC_URL`, `DEPLOYER_PK`, `AGENT_MNEMONIC`, `HUB_USDC`, `PORT` (see `demo/env.ts`
  for the loader; never read `.env` contents directly when exploring this repo)

**Core Logic:**
- `contracts/src/ClearingHub.sol`: settlement contract (collateral, digest, signature verification)
- `src/netting.ts`: the netting algorithm (must match `docs/PROTOCOL.md` exactly)
- `src/round.ts`: EIP-712 round digest, proposal building, participant-side verification
- `demo/coordinator.ts`: reference round-lifecycle orchestration

**Testing:**
- `contracts/test/`: Foundry unit, revert-matrix, fuzz, and digest-parity tests
- `test/`: vitest property tests and sign/verify roundtrip tests
- `test/genFixture.ts` + `test/fixtures/digest.json`: cross-stack (TS ↔ Solidity) parity fixture — regenerate
  with `npm run fixture` whenever the digest encoding changes

## Naming Conventions

**Files:**
- TypeScript source: `camelCase.ts` (e.g. `creditCap.ts`, `flowModel.ts`) — one concern per file, named after
  the primary export/domain concept
- Solidity source: `PascalCase.sol` matching the contract name (`ClearingHub.sol`)
- Solidity tests: `<ContractOrConcern>.t.sol` (Foundry convention: `ClearingHub.t.sol`,
  `ClearingHubFuzz.t.sol`, `DigestParity.t.sol`)
- Solidity scripts: `<Verb>.s.sol` (Foundry convention: `Deploy.s.sol`)
- TS tests: `<concern>.test.ts` (vitest convention: `eip712.test.ts`, `netting.test.ts`)

**Directories:**
- Top-level directories separate concerns by stack/purpose, not by feature: `contracts/` (Solidity),
  `src/` (SDK), `demo/` (orchestration/reference app), `test/` (SDK tests), `public/` (static assets),
  `docs/` (specs/docs)
- Foundry's internal layout (`src/`, `script/`, `test/`, `lib/`, `out/`, `cache/`) is nested entirely inside
  `contracts/` to keep it isolated from the top-level TypeScript `src/`/`test/`

## Where to Add New Code

**New protocol feature (e.g. threshold consent, merkle manifests — see `docs/V2-BRIEF.md`):**
- Contract changes: `contracts/src/ClearingHub.sol` (or a new contract file in `contracts/src/` if
  sufficiently distinct); add tests in `contracts/test/`
- SDK changes: new module in `src/` (follow existing pattern: pure logic separate from signing/verification
  separate from chain I/O); export from `src/index.ts`
- Update `docs/PROTOCOL.md` if the wire format or netting rules change — third parties depend on this spec
  matching `src/netting.ts` and `contracts/src/ClearingHub.sol` exactly
- Regenerate `test/fixtures/digest.json` via `npm run fixture` if the EIP-712 digest encoding changes

**New demo capability (e.g. new agent persona, new dashboard view):**
- Agent/persona changes: `demo/agents.ts`
- Traffic pattern changes: `demo/simulate.ts` (realistic ring traffic) or `demo/flowModel.ts` (parameterized
  synthetic traffic for the sweep)
- New HTTP endpoint: `demo/server.ts` (follow the existing `if (req.method === ... && req.url === ...)` pattern)
- Dashboard UI changes: `public/dashboard.html` directly (no build step)

**New SDK test:**
- Property/unit tests: `test/<concern>.test.ts`, following the vitest + fast-check patterns in
  `test/netting.test.ts` and `test/eip712.test.ts`

**New contract test:**
- `contracts/test/<Concern>.t.sol`; reuse `contracts/test/utils/RoundBuilder.sol` for constructing test rounds

**Utilities:**
- Shared TS helpers/types: `src/types.ts` (data contracts) or a new small module in `src/` if the helper is
  domain logic; avoid adding a generic `utils.ts` grab-bag — existing modules are each single-purpose

## Special Directories

**`contracts/out/`:**
- Purpose: Foundry compiler output (ABIs, bytecode, build-info)
- Generated: Yes (`forge build`)
- Committed: Should not be committed — verify `.gitignore` before adding files here; `src/abi/ClearingHub.ts` is
  the intentionally-committed copy produced from this output via `npm run abi`

**`contracts/cache/`:**
- Purpose: Foundry incremental-build cache
- Generated: Yes
- Committed: No

**`contracts/broadcast/`:**
- Purpose: Foundry deployment transaction records (one subfolder per script, keyed by chain id, e.g.
  `Deploy.s.sol/5042002/`)
- Generated: Yes (`forge script ... --broadcast`)
- Committed: Yes — serves as an on-record deployment history (chain 5042002 = Arc Testnet)

**`contracts/lib/`:**
- Purpose: vendored Foundry dependencies (git submodules)
- Generated: No (external code, pulled via `forge install`)
- Committed: Submodule references only, not the vendored source itself

**`docs/sweep/`:**
- Purpose: output of the statistical compression sweep (`npm run sweep`)
- Generated: Yes (`demo/sweep.ts` writes `sweep.csv` and the two `.svg` charts referenced in `README.md`)
- Committed: Yes — used as evidence in the README's "Measured compression" section

**`node_modules/`:**
- Purpose: npm dependencies
- Generated: Yes
- Committed: No

---

*Structure analysis: 2026-07-22*
