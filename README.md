# ⚖️ arclear

**A permissionless multilateral obligation-netting clearinghouse primitive for
any ERC-20 on [Arc](https://arc.network).** 100 micropayments, 1 settlement:
parties accumulate signed EIP-712 IOUs off-chain (a tab, with a limit), then
settle only the **net** residual from pre-posted collateral — atomically, under
consent, in one transaction. It moves working capital from turnover-sized to
exposure-sized: the reason DTCC and CLS exist, as a single contract you
deploy.

```
┌─────────────────────────────────────────────────────────┐
│                 ARCLEAR NETTING ROUND                   │
└─────────────────────────────────────────────────────────┘
  obligations netted     105 IOUs
  gross value            $55.19
  settled on-chain       $4.26
  capital compression    92.3%
  transactions           105 payments → 1 settlement tx
```

*(real output of `npm run e2e:anvil`; parameters and honest caveats in
[Measured compression](#measured-compression-when-is-netting-worth-it) below)*

## ▶ Try it live

Two hosted views of the same dashboard, cross-linked from their banners:

**[arclear-demo.fly.dev](https://arclear-demo.fly.dev)** — the **sandbox**.
Click **Simulate traffic**, then **Run netting round**, and watch ~35 signed
IOUs collapse into a single settlement. It runs against an in-container
[anvil](https://book.getfoundry.sh/anvil/) chain: no real funds, no keys,
resets on restart — press every button freely.

**[arclear-demo-testnet.fly.dev](https://arclear-demo-testnet.fly.dev)** — the
**live Arc Testnet** version. Same buttons, but every netting round is a real
settlement on chain 5042002, paid from faucet funds — each round's tx hash
links straight to [arcscan](https://testnet.arcscan.app). Button presses are
rate-limited (20 s cooldown) so a curious visitor can't drain the faucet
budget.

The dashboard and protocol code are identical in both; the difference is real:
the sandbox settles on a throwaway chain, the testnet view spends actual
(faucet) USDC on actual blocks.

> **Both hosted apps are currently serving a pre-V3 image** — the testnet view's
> `/state` reports the V2 USDC hub `0x3b9a…5a16`, not the current V3 hub. They
> are pending a Fly redeploy plus a secrets update (`HUB_V3_USDC`,
> `HUB_V3_EURC`, `PVP_ROUTER_V3`, `HUB_V3_DEPLOY_BLOCK`). Until that lands, the
> hosted views demonstrate v2 behaviour. Everything else in this README —
> `main`, the SDK, the local demo, and the [live V3 transactions
> below](#deployed-hubs-arc-testnet-chain-5042002) — is V3. Run
> `npm run demo -- --anvil` or `npm run e2e:testnet` locally for the V3 flow.

## Why this exists

Circle Gateway's x402 nanopayments compress **your outbound transaction count
and gas**: many signed authorizations, one bulk settlement, netting *your own*
outflows against your **prepaid** Gateway balance. What it does not do is
offset the flows coming back the other way — the money the same counterparties
owe *you* — or extend credit between parties. Each authorization is backed by
USDC you deposited, so your working capital stays sized to your outbound spend.
Two agents trading $500 of services in both directions each keep ~$500 funded.

Netting fixes that other axis. Obligations accumulate off-chain as signed IOUs
(a tab, with a limit); a round cancels offsetting *and cyclic* flows (A→B→C→A)
and settles only residuals from pre-posted collateral. Working capital drops
from turnover-sized to exposure-sized — the reason DTCC and CLS exist. And a
hub clears **any ERC-20**: deploy one for USDC, one for EURC. Netting
compresses obligations *within* a token; the `PvPRouterV3` composes two hubs
*across* tokens — USDC and EURC legs settling atomically in one transaction,
a miniature CLS.

|                        | Gateway / x402 nanopayments | arclear netting            |
| ---------------------- | --------------------------- | -------------------------- |
| compresses             | your outbound tx count + gas | reciprocal value + float   |
| netting scope          | one payer's own outflows    | full graph (bilateral + cyclic) |
| funding model          | prepaid balance ≥ your spend | collateral ≥ net exposure  |
| credit between parties | none (prepay)               | bounded tab                |
| tokens                 | USDC / Circle stablecoins   | any ERC-20                 |
| operator / custody     | Circle facilitator; non-custodial deposit, 7-day trustless exit | permissionless; no operator; withdraw never pausable |
| member default         | n/a (prepaid → no credit risk) | collateralized redemption (`redeemIOU`, best-effort) |

**They compose, they don't compete.** Net your mutual obligations through
Arclear, then settle the residual over whatever rail you like — including
Gateway. Gateway compresses transactions; Arclear compresses reciprocal float —
which is why Arclear carries a credit layer (bounded caps + a collateralized
recovery path) and Gateway doesn't need one.

## Capital model: collateral vs credit (two layers)

Arclear is **collateralized**. "Netting efficiency" means *post your net, not
your gross* — never *post nothing*.

**Layer 1 — on-chain collateral (posted upfront, real funds locked).** You
`deposit()` into the hub before you're a credible counterparty. A net debtor
whose collateral doesn't cover their net debit makes the round *revert*
(`InsufficientCollateral`). You size this to your **net** position, which
netting keeps far below your gross turnover.

**Layer 2 — off-chain inter-party credit (the tab, between settlements).**
When a creditor renders service and accepts a signed IOU instead of immediate
payment, they are *extending credit* — holding a promise, not cash. No token
moves. This is what lets obligations pile up and cancel. The creditor's
exposure in this window is bounded and backed four ways:

1. **Credit caps** cap the maximum loss to any one counterparty.
2. **Posted collateral backs the credit** — it's what makes your IOUs
   credible; more deposited → more credit others will extend you.
3. **`redeemIOU`** lets a creditor recover from a vanished debtor's collateral
   (best-effort; races the never-pausable `withdraw`).
4. **Round frequency** shrinks the credit window.

Worked example — A owes B $500, B owes A $300: net is A owes B **$200**. A
needs collateral ≥ **$200** (the net), not $500 (the gross); during the day B's
exposure to A is bounded by A's credit cap.

*(**Debtor** = the party that owes and signs the IOU; **creditor** = the party
that is owed. Canonical definitions in [PROTOCOL.md →
Roles](docs/PROTOCOL.md#roles); more vocabulary in
[docs/CONCEPTS.md](docs/CONCEPTS.md).)*

## Why use Arclear as a primitive

- **Capital efficiency by netting, not prepay.** Post collateral sized to your
  *net* position, not your *gross* turnover. Two agents trading $500 in both
  directions tie up ~$0 for the offsetting portion instead of ~$500 each.
- **Multilateral + cyclic cancellation.** Not just A↔B — obligation cycles
  (A→B→C→A) cancel on their own. The sweep shows >30% median volume
  compression at *zero* bilateral reciprocity for n ≥ 5.
- **Any ERC-20.** One hub per token (USDC, EURC, …). Not stablecoin-locked.
- **No trusted operator.** Depositing is joining. The coordinator holds no
  keys and cannot forge consent; every participant recomputes the netting
  before signing; the chain enforces zero-sum. Withdrawal is never pausable.
- **Bounded, backed credit.** Bilateral caps bound worst-case loss per
  counterparty; a debtor's posted collateral backs their IOUs. `redeemIOU`
  adds a collateralized recovery path if a member goes dark: on the current
  **V3** hubs, eligibility is one permanent on-chain read that no third party
  can manufacture or erode. Still best-effort in one respect by design — it
  races the never-pausable `withdraw`, so it recovers posted, still-present
  collateral only. (On the superseded but still-deployed **V2** hubs it can be
  permanently disabled by any party for a few hundred thousand gas — size
  exposure there on caps + collateral alone;
  [THREAT-MODEL.md](docs/THREAT-MODEL.md) rows 28/29.)
- **Composable.** Net through Arclear, settle the residual over whatever rail
  you like — including Gateway. Different compression axes; they stack.
- **Legible & tested.** Deterministic netting engine with a published spec
  third parties re-implement; TS↔Solidity digest parity; property + fuzz tests.

## What's in the box

- **[`ClearingHubV3.sol`](contracts/src/ClearingHubV3.sol)** (599 lines,
  Foundry) — the current hub: collateral vault + atomic round settlement.
  Unanimous EIP-712 consent over a single shared digest of the full position
  set; strictly-ascending participant canonicalization; zero-sum enforcement;
  **party-bound merkle manifest commitment**; a **permanent on-chain
  consumption ledger**; pause that can never trap funds. Paired with the
  stateless **[`PvPRouterV3`](contracts/src/PvPRouterV3.sol)** (410 lines) for
  atomic cross-currency settlement. Its ancestors
  [`ClearingHub`](contracts/src/ClearingHub.sol) (181 lines, v1) and
  [`ClearingHubV2`](contracts/src/ClearingHubV2.sol) (430 lines) stay deployed
  and stay in-tree. **241 Foundry tests: unit + revert matrix + 512-run fuzz +
  cross-stack digest/merkle parity + PoC suite for the two audit findings.**
- **IOU redemption (`ClearingHubV3`)** — the collateralized recovery path:
  when a debtor goes dark past K executed rounds, their creditor calls
  `redeemIOU(iou, sig)` with the debtor's existing EIP-712 IOU signature —
  **no proofs** — and recovers the amount straight from the debtor's posted
  collateral; a nullifier guarantees the redeemed IOU can never net again.
  Eligibility is a single permanent `consumed[leafId]` read: **O(1),
  history-independent, and unforgeable by third parties**, because the ledger
  is keyed on a leaf that binds the obligation to both its parties, and both
  must sign the round that writes it. Still best-effort in one respect by
  design — it races the never-pausable `withdraw`, so it recovers posted,
  still-present collateral only. This is a redesign, not the original: a
  full-repo audit found two ways any party could permanently destroy V2's
  redemption for a few hundred thousand gas. That story, the fix, and what it
  cost in gas are in [PROTOCOL.md → What V3 fixed, and what is still live on
  the V2 hubs](docs/PROTOCOL.md#what-v3-fixed-and-what-is-still-live-on-the-v2-hubs).
- **[`src/`](src/) — the TypeScript SDK** (viem-only): EIP-712 IOU + consent
  signing ([iou.ts](src/iou.ts), [round.ts](src/round.ts)), the deterministic
  netting engine ([netting.ts](src/netting.ts), spec in
  [PROTOCOL.md](docs/PROTOCOL.md)), bilateral credit caps
  ([creditCap.ts](src/creditCap.ts)), typed contract client
  ([client.ts](src/client.ts)), plus the merkle manifest library, PvP consent
  layer, and exclusion-aware sweep model. **184 TypeScript tests (vitest +
  fast-check): zero-sum, shuffle-determinism, dedup idempotence, merkle
  byte-parity, PvP digest parity, id/leaf-derivation refusals, verification
  totality, and exact-match coordinator cross-validation.**
- **[`demo/`](demo/)** — a 5-agent service economy (crawler → summarizer →
  oracle → trader → auditor) that signs ~100 IOUs and settles them in one
  round, on local anvil or Arc Testnet, with a zero-dependency live
  [dashboard](public/dashboard.html).
- **[`demo/sweep.ts`](demo/sweep.ts)** — the honesty machine: sweeps flow
  reciprocity, pair density, and participant count over 200 seeds per cell and
  reports median **and p10** compression (charts below, raw CSV in
  [docs/sweep](docs/sweep/sweep.csv)).

## Quickstart

**Integrating the SDK into your own project?** Start with the
[integrator quickstart](docs/QUICKSTART.md) — live hub addresses, the full
sign → net → consent → settle flow in runnable code, ~15 minutes.

```bash
git clone <this repo> && cd arclear
npm install
cd contracts && forge install && forge test && cd ..   # 241 Foundry tests
npm test                                               # 184 TypeScript tests
npm run e2e:anvil                                      # full flow, locally, ~60s
```

`e2e:anvil` runs four scenarios end to end — baseline settlement, liveness
(stall → exclude → re-settle → never settle the same paper twice), redemption
(dark debtor → self-serve recovery with no proofs → the recovered IOU can never
net again), and atomic cross-currency PvP (settle · sabotage abort ·
forced-revert atomicity). The same four pass against the live V3 hubs with
`npm run e2e:testnet`.

Live dashboard, locally (spawns anvil, deploys, funds five agents — the same
thing the [arclear-demo.fly.dev](https://arclear-demo.fly.dev) sandbox runs):

```bash
npm run demo -- --anvil
# open http://localhost:4402 → "Simulate traffic" → "Run netting round"
```

Arc Testnet: copy `.env.example` → `.env`, set `ARC_RPC_URL`, `DEPLOYER_PK`
(fund it at [faucet.circle.com](https://faucet.circle.com/) — on Arc, USDC is
the native gas token with a 6-decimal ERC-20 facade at
`0x3600000000000000000000000000000000000000`, so one faucet drip covers both
gas and collateral), and `AGENT_MNEMONIC`.

You can skip deploying entirely and point `.env` at the already-live hubs in
[Deployed hubs](#deployed-hubs-arc-testnet-chain-5042002) below. To deploy
your own, the demo needs **three** contracts — a `ClearingHubV3` per token
plus the `PvPRouterV3` that binds them (`demo/setup.ts` requires all three and
refuses to start otherwise):

```bash
# 1. V3 USDC hub. The constructor is (token, K) — V3 takes ONE tunable.
#    K=3 is an UNCALIBRATED demo-scale default; override with HUB_K.
#    RING and MAX_IOU_LIFETIME are gone with the root ring and the coverage
#    rule; HUB_RING / HUB_MAX_IOU_LIFETIME have no effect.
TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
forge script contracts/script/DeployV3.s.sol --root contracts \
  --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PK" \
  --broadcast --with-gas-price 25gwei

# 2. V3 EURC hub (same bytecode, different token)
TOKEN_ADDRESS=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a \
forge script contracts/script/DeployV3.s.sol --root contracts \
  --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PK" \
  --broadcast --with-gas-price 25gwei

# 3. Put both printed addresses into .env as HUB_V3_USDC / HUB_V3_EURC,
#    then deploy the router that pins them as constructor immutables. The
#    script refuses a pair that is zero-addressed, identical, codeless, not
#    actually ClearingHubV3, or clearing the same token.
HUB_V3_USDC=0x… HUB_V3_EURC=0x… \
forge script contracts/script/DeployPvPRouterV3.s.sol --root contracts \
  --rpc-url "$ARC_RPC_URL" --private-key "$DEPLOYER_PK" \
  --broadcast --with-gas-price 25gwei
```

Then finish `.env`: `PVP_ROUTER_V3` (the printed router address) and
`HUB_V3_DEPLOY_BLOCK` (your **V3 USDC** hub's deploy block, decimal — the
public RPC prunes old history, so event scans need a floor; it is printed in
`contracts/broadcast/DeployV3.s.sol/5042002/`). Now:

```bash
npm run e2e:testnet        # or: npm run demo (dashboard against testnet)
```

> `.env.example` also carries `HUB_USDC` / `HUB_EURC` (v1 `ClearingHub`) and
> `HUB_V2_USDC` / `HUB_V2_EURC` / `PVP_ROUTER` (V2). Both sets are **unused by
> the demo** and kept only as a record of the still-deployed earlier
> generations — nothing in `src/`, `demo/` or `contracts/` reads them, and
> `Deploy.s.sol` / `DeployV2.s.sol` / `DeployPvPRouter.s.sol` are not part of
> this path.

### Deployed hubs (Arc Testnet, chain 5042002)

Three generations are live. **V3 is current** — it is what the SDK, the demo
and the hosted testnet dashboard use, and what unqualified statements in these
docs describe. Earlier generations are kept on-chain as a record and are
labeled below; **do not point new integrations at them.**

**Arclear Net v3 — current hubs** (`ClearingHubV3` — threshold consent +
party-bound merkle manifests + a permanent consumption ledger + proofless O(1)
`redeemIOU`. One tunable, `K = 3`, an **uncalibrated** demo-scale default;
`RING` and `L` no longer exist. Set as `HUB_V3_USDC` / `HUB_V3_EURC` in
`.env`):

| token | hub | status |
| ----- | --- | ------ |
| USDC `0x3600…0000` | [`0xfe96A00f14d61F36AcECe69c39eA01C8af02C1ad`](https://testnet.arcscan.app/address/0xfe96A00f14d61F36AcECe69c39eA01C8af02C1ad) | source verified ✓ · **current** |
| EURC `0x89B5…D72a` | [`0x79ea853CcaA1FE41f7EDc26469AeAFD905676Fb5`](https://testnet.arcscan.app/address/0x79ea853CcaA1FE41f7EDc26469AeAFD905676Fb5) | source verified ✓ · **current** |

**Cross-currency PvP router** (`PvPRouterV3` — atomic USDC+EURC
payment-vs-payment rounds against the two V3 hubs above, which it pins as
constructor immutables; stateless, holds no funds, no owner, no pause. EIP-712
domain `("ArclearPvPRouterV3", "1")`, so V2-router consents can never replay
here. Set as `PVP_ROUTER_V3` in `.env`; spec in [PROTOCOL.md → Cross-currency
PvP rounds](docs/PROTOCOL.md#cross-currency-pvp-rounds)):

| contract | address | status |
| -------- | ------- | ------ |
| PvPRouterV3 (hubUSDC `0xfe96…C1ad` · hubEURC `0x79ea…6Fb5`) | [`0xb69596295AdB785571eeA1eAed9aeD162A510d42`](https://testnet.arcscan.app/address/0xb69596295AdB785571eeA1eAed9aeD162A510d42) | source verified ✓ · **current** |

Deploy block of the V3 USDC hub — set as `HUB_V3_DEPLOY_BLOCK`, the floor for
every event scan, since the public RPC prunes old history: **54004274**.

The full live-testnet run against V3, all four scenarios, in one sitting:

| what | on chain |
| ---- | -------- |
| Baseline round — 105 obligations, 5 participants, $0.170373 settled, 3,211,427 gas, one transaction | [`0x97546e…527171`](https://testnet.arcscan.app/tx/0x97546ebfe62f758da5648359b576d97d49603e52bd64c2f7d5d322a9d7527171) |
| Self-serve redemption against a dark debtor — **no proofs**, 74,825 gas | [`0x92506e…288c3e`](https://testnet.arcscan.app/tx/0x92506e982f8e5d02a911af754fc86cee11b873c799f4d6c4e8e58545be288c3e) |
| Atomic cross-currency PvP — USDC and EURC legs advancing in one transaction, 624,338 gas | [`0x8cc874…1f8aa7`](https://testnet.arcscan.app/tx/0x8cc8749392eec5f2c516822bb7b735d95954a42d44d1fd943f397bd21d1f8aa7) |

**Arclear Net v2** (`ClearingHubV2` — threshold consent + merkle manifests +
`redeemIOU`. **Superseded and still live.** A 2026-07-27 audit found two ways
any party can permanently destroy redemption on these hubs, per-IOU or hub-wide,
for a few hundred thousand gas — that is why V3 exists. Settlement safety and
zero-sum on them are unaffected; only the recovery product is. If you use them,
size credit on caps + posted collateral alone —
[THREAT-MODEL.md](docs/THREAT-MODEL.md) rows 28/29):

| token | hub | status |
| ----- | --- | ------ |
| USDC `0x3600…0000` | [`0x3b9a9617b91589a15A14122183e6305D9F0a5a16`](https://testnet.arcscan.app/address/0x3b9a9617b91589a15A14122183e6305D9F0a5a16) | source verified ✓ · superseded |
| EURC `0x89B5…D72a` | [`0xECcCD7E43B0Caf4D81420483dEE20E5e258FB85E`](https://testnet.arcscan.app/address/0xECcCD7E43B0Caf4D81420483dEE20E5e258FB85E) | source verified ✓ · superseded |
| PvPRouter (V2) | [`0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c`](https://testnet.arcscan.app/address/0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c) | source verified ✓ · superseded |

Real cross-currency settlement through the V2 router, kept as a record — a USDC
leg and an EURC leg (FX trades at an agreed 0.9896 rate mixed with ordinary
same-currency flows), both hubs advancing atomically in one transaction,
507,394 gas:
[`0x05c64e…f66197`](https://testnet.arcscan.app/tx/0x05c64e9c1a9280989980240e89b4451c2b50fc945800fb7f28cdbebf8af66197)

**Arclear Net v2 — Phase-1 hubs** (threshold consent only, no merkle
manifests or redemption; superseded, still live on-chain):

| token | hub | status |
| ----- | --- | ------ |
| USDC `0x3600…0000` | [`0xa984c64e1eA12B5aF5F573d58C3483fB8aB47f3c`](https://testnet.arcscan.app/address/0xa984c64e1eA12B5aF5F573d58C3483fB8aB47f3c) | source verified ✓ · superseded |
| EURC `0x89B5…D72a` | [`0x57A047599EaCDbe77Cc8C1A7978f88D700332Cb3`](https://testnet.arcscan.app/address/0x57A047599EaCDbe77Cc8C1A7978f88D700332Cb3) | source verified ✓ · superseded |

**Arclear Net v1** (`ClearingHub` — unanimous consent; the original primitive,
stays live):

| token | hub | status |
| ----- | --- | ------ |
| USDC `0x3600…0000` | [`0xd5A9ef69b47b0a3C8d326fDABd57aCaFA7D3d6e2`](https://testnet.arcscan.app/address/0xd5A9ef69b47b0a3C8d326fDABd57aCaFA7D3d6e2) | source verified ✓ |
| EURC `0x89B5…D72a` | [`0x867AD43f216B03c2a79eE02eC56F4bbEf90502c0`](https://testnet.arcscan.app/address/0x867AD43f216B03c2a79eE02eC56F4bbEf90502c0) | source verified ✓ |

Real settlement on the v1 USDC hub — 105 IOUs, $5.52 gross, $0.43 settled,
92.3% compression, one transaction:
[`0x64f3c5…a2c69`](https://testnet.arcscan.app/tx/0x64f3c58b0af6efcc622248550a7ca0dd963c35251c3f79b2fd237da89cfa2c69)

> Gas-token gotcha (documented so you don't rediscover it): USDC is Arc's
> native gas token *and* the ERC-20 at `0x3600…0000` — one balance, two
> views. Always set an explicit `gas` limit on writes; letting estimation
> probe with block-sized limits reserves your whole balance for gas and makes
> simulated token transfers revert with "transfer amount exceeds balance".

## Use cases

**Where netting pays off:** a set of parties transacting repeatedly and
bidirectionally in one ERC-20, where reciprocal flows cancel. The more
mutual/cyclic the trade, the bigger the win.

| Use case | The bidirectional flow | Why netting wins |
|---|---|---|
| **Agent service mesh** | crawler→summarizer→oracle→trader→auditor→crawler | Cyclic flows cancel; agents fund net exposure, not gross API spend |
| **M2M / DePIN marketplaces** | nodes relay bandwidth/compute *for each other* | High reciprocity → high compression |
| **API / usage billing among vendors** | providers who also consume each other's APIs | Sub-cent metered billing needs near-zero settlement cost |
| **Intercompany treasury** | subsidiaries invoicing each other | On-chain intercompany netting — literally the DTCC/CLS model |
| **Trading desks / market makers** | counterparties with offsetting positions | Net-exposure settlement |
| **Game / app economies** | players transferring among a fixed pool | Thousands of transfers → one settlement, bounded per-player credit |
| **L2 / consortium fee-sharing** | sequencers/relayers splitting revenue mutually | Recurring bilateral obligations that net cleanly |

The honest counterweight — when netting is *not* worth it — is measured, not
asserted: see [Measured
compression](#measured-compression-when-is-netting-worth-it) below and the raw
sweep data in [docs/sweep](docs/sweep/sweep.csv).

**What already exists (and why this is still the gap):** Gateway/x402
(unidirectional, prepaid, USDC / Circle stablecoins); payment/state channels
(pairwise, per-channel capital lockup, routing + watchtower complexity);
rollups (compress gas, not float); streaming like Superfluid (gross
directional flows). Traditional netting (DTCC/CLS/ACH) is off-chain,
permissioned, and operator-trusted. Nothing occupies Arclear's spot:
**permissionless, multilateral, on-credit netting with a collateralized
recovery path, for any ERC-20, as a deployable contract.**

## Measured compression (when is netting worth it?)

One tuned demo number is marketing. So we swept the flow-shape space —
**reciprocity** (probability a flow A→B has a counter-flow B→A), **density**
(fraction of pairs that trade), and **n** (participants) — 200 seeds per
cell, reporting median *and* tenth-percentile (the round an operator budgets
for). Reproduce with `npm run sweep`.

![compression vs reciprocity](docs/sweep/compression-vs-reciprocity.svg)

*Median volume compression (y-axis, 0–100%) vs bilateral reciprocity (x-axis,
0 = purely one-directional flows, 1 = every debt reciprocated), one line per
participant count n. The lines stay high and nearly flat even at reciprocity 0
for n ≥ 5 — multilateral netting cancels cyclic flows without needing pairs to
trade both ways.*

![collateral saving vs n](docs/sweep/collateral-vs-n.svg)

*Worst-placed participant's collateral saving (y-axis) vs participant count n
(x-axis), showing median and the tenth percentile (p10) — the bad round an
operator budgets for. Median rises from 37% at n=5 to 63% at n=50; the p10 is
the honest floor: ≈ 0% at n ≤ 5 (small pools can leave someone saving nothing
in one round of ten), 33% at n=15, 53% at n=50. Netting's value concentrates
in larger pools. See [docs/CALIBRATION.md](docs/CALIBRATION.md) for how these
idealized numbers hold up under realistic member uptime.*

Findings, including the ones that surprised us:

1. **Multilateral netting doesn't need bilateral reciprocity.** At n ≥ 5,
   median volume compression exceeds 30% even at reciprocity 0 — randomly
   directed flows form cancelable cycles on their own (A→B→C→A). Only tiny
   groups (n=3) need real reciprocity (≥ 0.4) to clear that bar.
2. **Aggregate volume compression mostly saturates by n ≈ 15–20** (85% at
   n=15 → 92% at n=50, density 0.5, reciprocity 0.8).
3. **But the operator-relevant number keeps climbing.** The *worst-placed*
   participant's collateral saving — median 37% at n=5 → 63% at n=50 — and
   crucially its p10: **≈ 0% for n ≤ 5**, 33% at n=15, 53% at n=50. In small
   pools, one round in ten leaves somebody saving nothing; large pools pay
   even their unluckiest member.
4. **Density barely matters** (66% → 87% compression across the whole 0.1–1.0
   range at n=10): netting is robust to sparse trading graphs.
5. The headline demo runs at n=5 with ring-shaped traffic (effective
   reciprocity ≈ 0.8), which is why it shows ~90%: it sits in the friendly
   region. Point 3 is the honest counterweight — and the design consequence
   below.

**Design consequence:** the value of netting concentrates in *larger* pools —
exactly where unanimous consent gets fragile. That made threshold consent the
highest-value next step, ahead of any margin/default machinery: the data said
scale the pool before you underwrite it. It shipped, and
[CALIBRATION.md](docs/CALIBRATION.md) then measured what the two-pass abort cap
costs at scale — the practical unlock is n ≈ 15 at 90% per-round member uptime
and n ≈ 30 at 95%, beyond which aborts dominate.

## What the audit found, and what the fix cost

The most useful thing in this repo may be that it survived being audited
properly. A full-repo audit on 2026-07-27 found **two redeploy-class flaws in
the shipped `ClearingHubV2` redemption path**, both reproduced against the live
contract:

1. **Manifest poisoning.** `executeRound` accepted a bare list of consumed IOU
   ids and never bound one to anybody. Rounds were free (two throwaway
   addresses, zero deltas, no collateral, no IOU needs to exist), so anyone —
   canonically the debtor — could write a victim's IOU id into a manifest.
   After that, no non-inclusion proof for that id could ever exist and
   `redeemIOU` was permanently defeated for it. ~3,808 gas per poisoned id.
2. **Root-ring flush.** Redemption required a non-inclusion proof against every
   root in a 16-slot ring, plus a coverage precondition comparing the oldest
   buffered timestamp against `expiry − L`. `oldestExecutedAt` only ever rises,
   so ~1.05M gas of free rounds closed that window **permanently, for every
   outstanding IOU on the hub at once**, against every debtor. Verified still
   reverting a week later.

Settlement safety, zero-sum and the signed-consent invariant were never
affected — both attacks execute rounds that move no balance and that every
participant signed. The damage was confined to the recovery product. But
"recovery any stranger can delete for a few hundred thousand gas" is not a
credit bound, and the docs said so plainly rather than shipping past it.

**V3 is the redesign.** Manifest leaves became **party-bound**
(`keccak256(id ‖ lo ‖ hi)` over the sorted debtor/creditor pair), so consuming
real paper requires the **creditor** to be a signing participant — a poisoner
writes a different key that no honest redemption reads. And consumption became
a **permanent on-chain ledger** rather than a ring of roots, which deleted the
ring, the coverage rule, the `MAX_IOU_LIFETIME` parameter and the entire
non-inclusion proof surface. Redemption is now O(1) and history-independent.

**What it cost, measured** (`contracts/test/GasScalingV3.t.sol`, like-for-like
against the V2 shapes, intrinsic gas included):

| shape | V2 | V3 | change |
| ----- | -- | -- | ------ |
| n=2, m=1 | 187,097 | 164,331 | **−12%** — deleting the ring write pays for one ledger entry |
| n=5, m=3 | 358,145 | 384,147 | +7% |
| n=30, m=15 | 1,763,412 | 2,085,139 | +18% |
| n=50, m=25 | 2,899,734 | 3,469,775 | +20% |
| n=5, m=105 (demo) | 800,609 | 3,316,379 | **+314% (4.1×)** |
| `redeemIOU` execution | 199,604 | **57,779** | **−71% (3.5× cheaper)**, and no longer grows with history |

So: **7–20% more gas at realistic round shapes** (a participant only appears
because one of their IOUs was consumed, so `m ≈ n/2` is the floor), 4.1× at the
demo's manifest-heavy `m = 105`, in exchange for a redemption guarantee no
third party can destroy and a redemption path that got 3.5× cheaper. Note the
inversion: under v2 rounds were cheap and redemption dear; under v3 it is the
other way round. Budget accordingly.

**What V3 does not claim.** Staleness is paced by rounds, not seconds, so a
debtor can refresh their own clock by settling fabricated paper with an
accomplice, and a third party can accelerate everyone else's staleness by
paying for rounds — neither moves collateral without the affected party's
signature, and both are documented rather than papered over. Redemption still
races the never-pausable `withdraw`. Single-leg PvP extraction is unchanged and
still accepted. **And the V2 hubs stay deployed with both flaws live** — they
are labeled as superseded in the table above, not quietly retired.

Full write-up: [PROTOCOL.md → What V3 fixed, and what is still live on the V2
hubs](docs/PROTOCOL.md#what-v3-fixed-and-what-is-still-live-on-the-v2-hubs) and
[THREAT-MODEL.md](docs/THREAT-MODEL.md) rows 28/29.

## Trust model, honestly

- **Safety is on-chain and unconditional**: no balance moves without its
  owner's signature over the exact full position set. A malicious coordinator
  is structurally harmless — it holds no keys, every participant recomputes
  the netting before consenting (`verifyProposal`), and any tampering breaks
  the shared digest. Fuzz tests assert every perturbation reverts. This held
  unchanged through all three contract generations, including under both audit
  findings above.
- **Liveness is bounded**: an unresponsive participant no longer stalls
  settlement — threshold consent excludes non-responders in one deterministic
  batch and rebuilds the round from the consenting subset (worst case two
  signature-collection passes: a latency cost, never a safety cost; spec in
  [PROTOCOL.md](docs/PROTOCOL.md)). Withdrawal is never pausable, and credit
  caps still bound a staller's paper.
- **Credit between rounds is a bounded bet**: the SDK's bilateral caps limit
  worst-case loss per counterparty to the cap you configured. On V3,
  `redeemIOU` is a real second line — eligibility is one permanent on-chain
  read no third party can forge or erode — but it still races the
  never-pausable `withdraw`, so caps remain what you size against.
- **The redemption clock is paced by rounds, not seconds**, which anyone
  willing to pay for rounds can move in either direction. Documented, not
  claimed closed; it never moves collateral without the affected party's
  signature.
- No upgradeability, no fees, no owner access to funds. `renounceOwnership` is
  disabled on V3 — renouncing while paused would make `unpause` unreachable and
  brick the protocol (funds would still exit, since `withdraw` is never
  pausable).

Full checklist: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Protocol spec:
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Roadmap

In order, per the sweep data:

1. **Threshold consent** — ✅ shipped: non-signers are *excluded and
   recomputed*, never outvoted; the final set still signs unanimously,
   preserving consent-before-settlement.
2. **Merkle manifests + on-chain IOU redemption** — ✅ shipped: sorted-leaf
   merkle manifest roots in the same `bytes32` field, and `redeemIOU` recovery
   against an unresponsive debtor's collateral.
3. **Cross-currency rounds** — ✅ shipped (`PvPRouterV3`, live above): USDC and
   EURC legs settling atomically (payment-vs-payment, a miniature CLS on Arc),
   with the agreed per-round FX rate signed into the union's PvPRound consent
   digest.
4. **Audit and redeploy** — ✅ shipped (`ClearingHubV3` + `PvPRouterV3`, the
   current hubs above): party-bound manifest leaves and a permanent consumption
   ledger, closing both redeploy-class findings of the 2026-07-27 audit. See
   [What the audit found](#what-the-audit-found-and-what-the-fix-cost).
5. **Calibrate `K`** — next. `K = 3` remains an uncalibrated demo-scale
   default; V3 shrank the calibration surface from `K`/`RING`/`L` to `K` alone
   and removed the ring-depth-versus-cadence trade-off that made the original
   question hard ([CALIBRATION.md](docs/CALIBRATION.md)).

## For Arc Open Source Showcase reviewers

**What primitives does this expose?** A forkable clearing layer: a
collateral-and-settlement contract that started at 181 lines (`ClearingHub`)
and is 599 in its current form (`ClearingHubV3`, party-bound manifests +
consumption ledger + redemption), plus a 410-line stateless `PvPRouterV3`; a
deterministic netting engine with a published spec third parties can
re-implement; EIP-712 IOU/consent schemas; credit-cap tracking; and a reference
coordinator + dashboard. Each piece is importable on its own.

**Is it honest about its own failures?** That is the part worth reviewing. A
full-repo audit found two real flaws in the shipped V2 contract; the repo
documents exactly what they were, what they cost to exploit, the redesign that
closes them, and the ~7–20% round-gas increase that fix was worth paying —
rather than quietly redeploying. The superseded hubs stay listed and labeled.
See [What the audit found](#what-the-audit-found-and-what-the-fix-cost).

**What does it add beyond the `circlefin/arc-*` repos?** Those repos cover
*making* payments (commerce, p2p, x402 nanopayments, escrow, FX). None touch
clearing: nothing nets obligations, nothing compresses float, nothing gives
agents bounded credit. Gateway compresses your outbound transaction count;
arclear compresses reciprocal value and float across the full obligation
graph — a complementary layer the reference stack doesn't have, for USDC and
EURC alike. The [use-case table](#use-cases) above maps where that layer pays
off.

## License

[MIT](LICENSE)
