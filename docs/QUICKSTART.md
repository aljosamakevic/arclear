# Integrator quickstart

Netting in ~15 minutes, for a developer with a funded Arc Testnet key. You
will: deposit collateral into a live hub, sign IOUs off-chain, net them, and
settle the residual in one transaction. Everything below runs against the
deployed `ClearingHubV2` hubs — no contract deployment required.

Prerequisite: an Arc Testnet account with USDC. One drip from
[faucet.circle.com](https://faucet.circle.com/) covers both gas and collateral
(on Arc, USDC is the native gas token *and* the ERC-20 at `0x3600…0000` — one
balance, two views).

## 1. Install

```bash
npm i arclear viem
```

> **Not yet published to npm.** Until it is, install from a local build —
> a plain `npm i github:aljosamakevic/arclear` will *not* work, because the
> package ships compiled output (`dist/`) that a git install doesn't build:
>
> ```bash
> git clone https://github.com/aljosamakevic/arclear.git
> cd arclear && npm install && npm run build && npm pack
> # then, in your project:
> npm i /path/to/arclear-2.0.0.tgz viem
> ```

The SDK is viem-only: `viem` is its single runtime dependency, and you'll
import a few things (`privateKeyToAccount`, `erc20Abi`) from it directly.

## 2. Connect to the live hubs

Arc Testnet: chain id `5042002`, RPC `https://rpc.testnet.arc.network`,
explorer [testnet.arcscan.app](https://testnet.arcscan.app). The SDK defaults
to this chain — you only pass a `chainId` when targeting something else (e.g.
a local anvil).

Current `ClearingHubV2` deployments (threshold consent + merkle manifests +
`redeemIOU`; redemption params K=3 / RING=16 / L=86,400 s are **uncalibrated**
demo-scale defaults):

| contract | address |
| -------- | ------- |
| USDC hub (`0x3600…0000`) | [`0x3b9a9617b91589a15A14122183e6305D9F0a5a16`](https://testnet.arcscan.app/address/0x3b9a9617b91589a15A14122183e6305D9F0a5a16) |
| EURC hub (`0x89B5…D72a`) | [`0xECcCD7E43B0Caf4D81420483dEE20E5e258FB85E`](https://testnet.arcscan.app/address/0xECcCD7E43B0Caf4D81420483dEE20E5e258FB85E) |
| PvPRouter (binds the two hubs above) | [`0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c`](https://testnet.arcscan.app/address/0x8287dD162e73f1a1DD15774dDc8A4137a2d3fE8c) |

> **Gas-token gotcha:** because USDC is the gas token, letting gas estimation
> run reserves your *whole* balance and makes simulated token transfers revert
> — always set an explicit `gas` limit on writes. `HubClient` does this for
> you on every write; only your own raw `writeContract` calls (like the
> `approve` below) need it by hand.

## 3. The flow, end to end

The example below is one file, two participants (`alice` and `bob`), both keys
local — in production each party runs steps 3 and 5 on their own machine and
only signatures travel. Amounts are **bigint base units** (6 decimals for
USDC): `1_250_000n` = 1.25 USDC. There is no floating point and no division
anywhere in protocol math.

> **Never commit keys.** Load them from the environment (`process.env`), keep
> `.env` gitignored.

### 3.1 Create clients

```ts
import { erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  publicClient,
  walletClient,
  HubClient,
  signIou,
  net,
  buildProposal,
  verifyProposal,
  signConsent,
  USDC,
  MIN_MAX_FEE_PER_GAS,
} from "arclear";

const HUB_USDC: Address = "0x3b9a9617b91589a15A14122183e6305D9F0a5a16";

const alice = privateKeyToAccount(process.env.ALICE_PK as Hex);
const bob = privateKeyToAccount(process.env.BOB_PK as Hex);

const pub = publicClient(); // defaults to the Arc Testnet RPC
const aliceWallet = walletClient(alice);
const bobWallet = walletClient(bob);
const hub = new HubClient(HUB_USDC, pub);
```

### 3.2 Deposit collateral

Collateral is what makes your IOUs credible: a net debtor whose collateral
doesn't cover their net debit makes the whole round revert. Size it to your
expected **net** position, not your gross turnover. The hub pulls tokens via
`transferFrom`, so approve first:

```ts
const collateral = 5_000_000n; // 5 USDC

for (const [account, wallet] of [[alice, aliceWallet], [bob, bobWallet]] as const) {
  const approveHash = await wallet.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [HUB_USDC, collateral],
    chain: wallet.chain,
    account,
    maxFeePerGas: MIN_MAX_FEE_PER_GAS, // 25 gwei — Arc's floor is 20
    gas: 100_000n,                     // explicit gas, always (gotcha above)
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  await pub.waitForTransactionReceipt({ hash: await hub.deposit(wallet, collateral) });
}
```

Withdrawal (`hub.withdraw(wallet, amount)`) is **never pausable** — depositing
is joining, leaving needs nobody's permission.

### 3.3 Sign IOUs off-chain

An IOU is an EIP-712-signed obligation: debtor owes creditor `amount`. No
token moves — this is the credit layer, bounded by whatever caps you configure
(see `CreditCapTracker` in the SDK). The debtor signs:

```ts
const now = BigInt(Math.floor(Date.now() / 1000));

// Alice owes Bob 1.25 USDC:
const signedByAlice = await signIou(
  HUB_USDC,
  {
    debtor: alice.address,
    creditor: bob.address,
    amount: 1_250_000n,
    nonce: 1n,                 // monotonic per (debtor -> creditor) pair
    expiry: now + 3_600n,      // unix seconds
    ref: ("0x" + "00".repeat(32)) as Hex, // opaque: invoice hash, memo hash…
  },
  alice,
);

// Bob owes Alice 0.75 USDC back:
const signedByBob = await signIou(
  HUB_USDC,
  {
    debtor: bob.address,
    creditor: alice.address,
    amount: 750_000n,
    nonce: 1n,
    expiry: now + 3_600n,
    ref: ("0x" + "00".repeat(32)) as Hex,
  },
  bob,
);
```

**The L lifetime convention:** `signIou` refuses any IOU with
`expiry > now + L` (L defaults to 86,400 s, mirroring the hub's
`MAX_IOU_LIFETIME`). Honoring it is what makes the hub's redemption coverage
rule complete for honest debtors — a debtor who violates it weakens only their
own double-claim protection. Also note the netting engine drops IOUs expiring
within its safety window (default 60 s), so keep expiries comfortably ahead of
settlement.

### 3.4 Net and build the proposal

`net()` is a pure, deterministic function — anyone can run it and get
byte-identical output ([spec](PROTOCOL.md#netting-determinism-spec)):

`net()` never trusts a caller-supplied `SignedIou.id`: you must either let it
re-derive each id from the signed struct (`{ hub }`, the safe default for
anything that will settle) or explicitly opt out. Trusting an attacker-supplied
id would let a coordinator commit a fake id to the manifest while the real IOU
stays redeemable — the debtor would pay twice.

```ts
const ious = [signedByAlice, signedByBob];
const result = net(ious, { now, hub: HUB_USDC });
// result.participants: strictly ascending addresses
// result.deltas: index-aligned, sums to exactly 0n; negative = net debtor
// Here: Alice -500_000n, Bob +500_000n — the 0.75 reciprocal portion cancelled.

const roundNonce = await hub.roundNonce();
const proposal = buildProposal(HUB_USDC, roundNonce, result);
```

### 3.5 Verify and consent — every participant, independently

**Never trust the coordinator's arithmetic.** Each participant recomputes the
netting from the IOUs *they* have seen and compares byte-for-byte before
signing — that distrust is what makes unanimity safe:

```ts
// Each party runs this with their own local IOU set and own chain read:
const check = verifyProposal(HUB_USDC, proposal, ious, alice.address, {
  now,
  expectedRoundNonce: roundNonce, // your OWN read of hub.roundNonce() — refuses stale/overlapping proposals
});
if (!check.ok) throw new Error(`refusing to consent: ${check.reason}`);

const aliceSig = await signConsent(HUB_USDC, proposal, alice);
const bobSig = await signConsent(HUB_USDC, proposal, bob); // bob verifies his copy first, same as above
```

If you sign consents for multiple concurrent proposals, also pass
`pendingConsumedIds` (the consumed ids of your outstanding unconfirmed
consents) — `verifyProposal` will refuse overlaps that could double-settle
your paper.

### 3.6 Execute the round

`signatures[i]` must be `participants[i]`'s consent — the contract recovers
per index:

```ts
const signatures = proposal.participants.map((p) =>
  p.toLowerCase() === alice.address.toLowerCase() ? aliceSig : bobSig,
);

const txHash = await hub.executeRound(aliceWallet, proposal, signatures);
await pub.waitForTransactionReceipt({ hash: txHash });

console.log("alice collateral:", await hub.collateral(alice.address)); // 4_500_000n
console.log("bob collateral:", await hub.collateral(bob.address));     // 5_500_000n
```

Submission is permissionless — any relayer can send it; the signatures are
the authority. `HubClient.executeRound` computes an explicit gas limit from a
forge-measured formula, so estimation never touches your balance.

## 4. When a member goes dark

An unresponsive participant can't stall settlement (threshold consent excludes
and recomputes), and their creditors aren't stranded: a creditor holding a
signed IOU from a debtor who stopped consenting can recover the amount
directly from that debtor's posted collateral via `redeemIOU`, after K
executed rounds have passed without the IOU settling. The SDK assembles the
required merkle non-inclusion proofs from public calldata — no coordinator
trust:

```ts
const proofs = await hub.prepareRedemptionProofs(signedByAlice.id);
await hub.redeemIOU(bobWallet, signedByAlice.iou, signedByAlice.signature, proofs);
```

This is **best-effort by design** — it races the never-pausable `withdraw`,
and the K/RING/L parameters are uncalibrated demo defaults. Spec and honesty
notes: [PROTOCOL.md → IOU redemption](PROTOCOL.md#iou-redemption).

## 5. Cross-currency PvP

Netting compresses obligations *within* a token; the `PvPRouter` composes the
USDC and EURC hubs *across* tokens — two leg proposals plus a signed FX rate
settle atomically in one transaction (payment-vs-payment, a miniature CLS).
The SDK covers the whole flow: `buildPvPProposal`, `verifyPvPProposal` (per-leg
re-verification + cross-multiplied rate checks — no division), `signPvPConsent`,
and `PvPRouterClient.executePvP`. Spec:
[PROTOCOL.md → Cross-currency PvP rounds](PROTOCOL.md#cross-currency-pvp-rounds).

## 6. Run the full demo locally

A 5-agent service economy signing ~100 IOUs and settling them in one round, on
a throwaway local chain (spawns anvil, deploys, funds — no testnet key
needed):

```bash
npm run demo -- --anvil     # live dashboard at http://localhost:4402
npm run e2e:anvil           # scripted end-to-end with balance assertions, ~20s
```

No local setup at all: the same dashboard is hosted as a free-play sandbox at
[arclear-demo.fly.dev](https://arclear-demo.fly.dev) and as a live Arc Testnet
instance at [arclear-demo-testnet.fly.dev](https://arclear-demo-testnet.fly.dev)
(real settlements against the hubs in section 2; rounds link to arcscan).

## 7. Where to go next

- [CONCEPTS.md](CONCEPTS.md) — vocabulary, the two-layer capital model, why a
  coordinator can't cheat, and when netting is *not* worth it
- [PROTOCOL.md](PROTOCOL.md) — the full protocol spec: netting determinism
  rules, round lifecycle, threshold consent, manifests, redemption
- [CALIBRATION.md](CALIBRATION.md) — what pool sizes actually pay off:
  measured compression under realistic uptime, and the honest p10 numbers
