# Arclear — obligation-netting clearinghouse primitive on Arc (v1, 2-day build)

## Context

Submission for the Arc Open Source Showcase (arc-oss.thecanteenapp.com), which calls for standalone, forkable, well-documented **primitives** other Arc builders can adopt (shape: the circlefin/arc-* repos). Analysis of all 362 prior submissions (arc-showcase data) showed payment **netting** is genuine whitespace: 0 real implementations (4 name-collisions do allocation/escrow/lending instead), nothing in circlefin/arc-*, and no off-the-shelf external solution (OpenZeppelin has nothing; state channels are heavyweight and not x402/Arc-native).

**Thesis**: Gateway batching compresses *transaction count*; nothing compresses *value and float*. Agents pre-fund gross outflow even when flows mostly cancel. Arclear lets participants exchange signed EIP-712 IOUs off-chain and periodically settle only **net** positions on-chain from pre-posted collateral — capital compression, bounded bilateral credit ("tab with a limit"), token-agnostic (EURC works; Gateway's rail is USDC-only). Positioning: *complementary* to Gateway, not competing.

Constraint: **~2 days of build time.** Everything below is scoped to that; stretch items are explicitly marked.

## Fixed design decisions

- **Unanimous-consent rounds**: a round executes only with a signature from every affected participant over ONE shared digest of the full sorted position set. Malicious-coordinator attacks die by construction (mismatched data → mismatched digest → recovery fails). No fraud proofs / challenge windows in v1.
- **Atomic settlement from collateral**: round reverts unless every net debtor's pre-posted collateral covers their debit. No failure-to-pay case.
- **One hub per ERC-20**: deploy for USDC `0x3600000000000000000000000000000000000000` (6 dec), then same bytecode for EURC `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (~15 min, makes the token-agnostic claim concrete).
- **IOUs are off-chain evidence in v1** (no individual on-chain redemption — correct redemption needs non-inclusion proofs; that's v2). Compromise kept: each round commits `manifestHash` on-chain — in v1 a plain `keccak256` of the sorted consumed-IOU-id list (NOT a merkle tree; saves a module + tests; the contract field is `bytes32` either way so v2 can swap in a merkle root without contract changes).
- **Toolchain**: Foundry for contracts (fuzz tests are a showcase differentiator — winners shipped Foundry suites). Single npm package (no pnpm monorepo). Dashboard = one static HTML page served by the demo server — same pattern as circle-agent's `public/buyer.html` (tsx server + static page + fetch polling), which the user already knows cold.

## Chain facts (verified from ~/.arc-canteen/context docs)

- Chain ID **5042002**. RPC: use the user's Canteen endpoint `https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_…` (token-bearing — lives ONLY in `.env` as `ARC_RPC_URL`, never committed or hardcoded; `.env.example` and all docs reference the public `https://rpc.testnet.arc.network` as the default/fallback). Explorer `https://testnet.arcscan.app` (Blockscout-style; verify via `forge verify-contract --verifier blockscout --verifier-url https://testnet.arcscan.app/api`, fallback: hardhat etherscan customChain with `apiKey: "empty"`).
- Native gas token is USDC (native accounting 18 dec; ERC-20 interface 6 dec — don't mix). **Min base fee 20 gwei** → set `maxFeePerGas ≥ 25 gwei` everywhere or txs hang.
- Faucet: https://faucet.circle.com/ (Arc Testnet; USDC + EURC). Deployer needs native USDC (gas) AND ERC-20 USDC (collateral).

## Repo layout

New repo at `/Users/aljosamakevic/Documents/Buildground/Playground/arclear/` (git init; MIT):

```
arclear/
├── README.md                  # hero stat, mermaid diagram, deployed addresses, quickstart,
│                              #   "why not just Gateway" + honest v1 trust-model section
├── LICENSE                    # MIT
├── package.json               # npm; scripts: test, e2e:anvil, e2e:testnet, demo, dashboard
├── .env.example               # ARC_RPC_URL, DEPLOYER_PK, AGENT_MNEMONIC, HUB_USDC, HUB_EURC
├── contracts/
│   ├── foundry.toml           # solc 0.8.26, optimizer, rpc_endpoints.arc_testnet
│   ├── src/ClearingHub.sol
│   ├── script/Deploy.s.sol    # reads TOKEN_ADDRESS env
│   └── test/
│       ├── ClearingHub.t.sol        # unit + revert matrix + digest-parity vector
│       ├── ClearingHubFuzz.t.sol    # random flows → net → sign(vm.sign) → execute
│       └── utils/RoundBuilder.sol   # sort/sum/sign helper
├── src/                       # the SDK ("arclear" package, viem only)
│   ├── index.ts  types.ts
│   ├── domain.ts              # EIP-712 domain+types, arcTestnet viem chain def (fee floor)
│   ├── iou.ts                 # signIou / verifyIou / iouId (viem hashTypedData)
│   ├── netting.ts             # pure bigint engine: validate→dedup→drop-expired→sum→sort
│   ├── round.ts               # buildProposal / verifyProposal (recompute+compare) / signConsent / manifestHash
│   ├── creditCap.ts           # bilateral exposure tracker (~30 lines — the "tab limit")
│   └── client.ts              # viem contract wrappers + event watchers; ABI from forge out/
├── test/                      # vitest: netting properties (fast-check), eip712 roundtrip,
│                              #   shared digest fixture consumed by BOTH vitest & forge parity test
├── demo/
│   ├── agents.ts              # 5 EOAs from mnemonic; personas (crawler, summarizer, oracle…)
│   ├── simulate.ts            # ~100 IOUs, $0.05–$0.95, weighted pair matrix (flows mostly cancel)
│   ├── coordinator.ts         # IOU ledger + round lifecycle: propose → collect consents → execute
│   ├── server.ts              # serves GET /state (JSON), POST /round, POST /simulate + public/
│   ├── e2e.ts                 # anvil-or-testnet: deploy/attach → deposit → simulate → round → assert
│   └── report.ts              # gross-vs-net table, compression %, ArcScan link
├── public/dashboard.html      # single static page, fetch-polls /state every 1.5s
└── docs/
    ├── PROTOCOL.md            # schemas, determinism spec (sort/tie-break/dedup rules), lifecycle
    └── THREAT-MODEL.md        # checklist below + trust model + v2 roadmap
```

## Contract: `ClearingHub.sol` (~250 lines, OZ: SafeERC20, ECDSA, EIP712, Ownable2Step, Pausable, ReentrancyGuard)

State: `IERC20 immutable token; uint64 roundNonce; mapping(address => uint256) collateral;` — no registry (depositing is joining), no locked-balance split, no on-chain credit caps (client-side policy; unanimity makes on-chain caps redundant).

```solidity
bytes32 constant ROUND_TYPEHASH = keccak256(
  "Round(uint64 roundNonce,address[] participants,int256[] deltas,bytes32 manifestHash)");
// EIP712("ArcClearingHub","1") → domain binds chainId 5042002 + hub address (= token binding)

deposit(uint256)   // safeTransferFrom; whenNotPaused
withdraw(uint256)  // NOT pausable — exit is always possible
executeRound(uint64 nonce_, address[] participants, int256[] deltas,
             bytes32 manifestHash, bytes[] signatures)  // permissionless
```

`executeRound` order of checks: (1) `nonce_ == roundNonce`; (2) equal lengths ≥ 2; (3) **strictly ascending participants** (canonical order + no duplicates in one O(n) pass); (4) recover each sig against the single `_hashTypedDataV4` digest → must equal `participants[i]`; (5) deltas sum to exactly 0; (6) apply: negative delta requires covering collateral (else revert whole round), positive adds; `delta == 0` allowed (participant whose flows cancelled still consents — their consent extinguishes their paper); (7) `roundNonce++`. Events: `Deposited`, `Withdrawn`, `RoundExecuted(nonce, roundHash, manifestHash, settledVolume)`, `PositionSettled(nonce, participant, delta, newCollateral)` per participant.

Admin: `pause/unpause` gating deposit+executeRound only. No upgradeability, no fees, no owner access to funds — state this in README.

## EIP-712 schemas (SDK `domain.ts`)

Domain (shared by IOU and Round): `{ name: "ArcClearingHub", version: "1", chainId: 5042002, verifyingContract: HUB }` — binds token/hub/chain for free.

```
IOU:   debtor address, creditor address, amount uint256 (6-dec base units),
       nonce uint256 (monotonic per debtor→creditor pair), expiry uint64, ref bytes32
Round: roundNonce uint64, participants address[], deltas int256[], manifestHash bytes32
```

`iouId = hashTypedData(IOU)` — dedup key + manifest leaf. Cross-stack encoding is locked by a **shared digest fixture**: one JSON vector checked by both vitest and a forge test calling `hub.hashRound(...)`.

## Netting engine rules (`netting.ts`, pure, deterministic — spec'd in PROTOCOL.md)

validate sigs → dedup by iouId → drop expired (`expiry <= now + safetyWindow`) → drop already-settled ids (coordinator marks after each executed round) → sum flows per participant (bigint, no division anywhere) → sort participants ascending → drop only participants with **no IOUs in the manifest** (zero-net participants with consumed IOUs stay, delta 0, must sign). Output always sums to zero (property-tested).

## Threat checklist (→ THREAT-MODEL.md, tested where marked)

1. Round replay: killed by on-chain `roundNonce` [test]. 2. Cross-hub/chain/token replay: killed by domain [test: sign for USDC hub, submit to EURC hub → revert]. 3. IOU double-count: dedup by iouId; per-pair nonces [property test]. 4. IOU reuse across rounds: coordinator excludes settled ids; manifestHash makes violations provable. 5. Malicious coordinator: dies by construction — everyone signs the same full digest; SDK `verifyProposal` recomputes, never trusts. 6. Refusal-to-sign / withdraw-before-execute: liveness grief only, never safety (round reverts atomically) [test]; response = rebuild round excluding offender + halt their bilateral credit; README states plainly: v1 trades liveness for simplicity. 7. Zero-delta participants: both paths tested. 8. Malleability: OZ ECDSA. 9. Decimals/rounding: no division exists. 10. ERC-20 quirks: SafeERC20; fee-on-transfer tokens documented out of scope.

## Demo + dashboard

Demo (`npm run demo`): 5 agent EOAs deposit collateral → ~100 IOUs stream (weighted so flows mostly cancel) → coordinator proposes → 5 consents → `executeRound` on Arc Testnet → report prints: **"$41.20 gross → $3.85 settled · 90.7% capital compression · 103 payments → 1 tx"** + ArcScan link.

`public/dashboard.html` (polls `/state`): ① CompressionHero (the big numbers, live), ② Run-round button with lifecycle states (netting → 5/5 consents → confirmed → ArcScan tx link), ③ positions table (gross out / gross in / net / collateral — makes netting visually obvious), ④ live IOU feed, ⑤ round history. No wallet, no framework — cannot flake during judging.

## Schedule (2 days + stretch)

**Day 1 — the core** (contract + SDK are the credibility): scaffold repo/foundry/npm → `ClearingHub.sol` → unit + revert-matrix tests → digest-parity fixture → SDK (`domain`, `iou`, `netting`, `round`, `client`, `creditCap`) → vitest property tests → one fuzz test (`ClearingHubFuzz.t.sol`).

**Day 2 — proof + polish**: demo agents/simulator/coordinator/server → `dashboard.html` → anvil e2e → **testnet deploy USDC hub + EURC hub, verified on ArcScan** (addresses into README) → run real settlement, capture tx links + screenshot → README (hero, mermaid sequence diagram, quickstart, "why not just Gateway", honest v1 limitations + v2 roadmap: threshold consent, merkle manifests + redemption, cross-currency PvP) → PROTOCOL.md + THREAT-MODEL.md (mostly paste from this plan).

**Stretch (only if time remains)**: invariant test suite (handler-based: `balanceOf(hub) == Σ collateral`), GitHub Actions CI (forge test + vitest) + badge, 60s screen recording, `arc-canteen submit-showcase` submission (user is already logged in; walks through repo/live-site/standalone questions — the README's "what primitives / what's new vs circlefin/arc-*" sections are the answers).

**Cut order if behind**: fuzz test → EURC hub → dashboard polish (report.ts terminal output is the fallback demo).

## Verification

1. `forge test -vvv` — all unit/fuzz green, including digest-parity and the revert matrix.
2. `npx vitest run` — netting properties (zero-sum, determinism, dedup) green; shared fixture matches forge.
3. `npm run e2e:anvil` — full flow on local anvil: balances after round exactly match engine output.
4. `npm run e2e:testnet` — real settlement on Arc Testnet (gas ≥ 25 gwei); confirm `RoundExecuted` on ArcScan; both hub addresses verified (green check on ArcScan).
5. Open dashboard while `npm run demo` runs — hero stat updates, round button works, ArcScan links resolve.
6. README review: a stranger can go faucet → clone → `.env` → demo in ≤ 10 minutes; both reviewer questions answered explicitly.
