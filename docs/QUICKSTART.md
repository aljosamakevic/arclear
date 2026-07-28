# Integrator quickstart

Netting in ~15 minutes, for a developer with a funded Arc Testnet key. You
will: deposit collateral into a live hub, sign IOUs off-chain, net them, and
settle the residual in one transaction. Everything below runs against the
deployed `ClearingHubV3` hubs — no contract deployment required.

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
> npm i /path/to/arclear-3.0.0.tgz viem
> ```

The SDK is viem-only: `viem` is its single runtime dependency, and you'll
import a few things (`privateKeyToAccount`, `erc20Abi`) from it directly.

## 2. Connect to the live hubs

Arc Testnet: chain id `5042002`, RPC `https://rpc.testnet.arc.network`,
explorer [testnet.arcscan.app](https://testnet.arcscan.app). The SDK defaults
to this chain — you only pass a `chainId` when targeting something else (e.g.
a local anvil).

Current `ClearingHubV3` deployments (threshold consent + party-bound merkle
manifests + proofless O(1) `redeemIOU`; the one redemption parameter, K=3, is
an **uncalibrated** demo-scale default):

| contract | address |
| -------- | ------- |
| USDC hub (`0x3600…0000`) | [`0xfe96A00f14d61F36AcECe69c39eA01C8af02C1ad`](https://testnet.arcscan.app/address/0xfe96A00f14d61F36AcECe69c39eA01C8af02C1ad) |
| EURC hub (`0x89B5…D72a`) | [`0x79ea853CcaA1FE41f7EDc26469AeAFD905676Fb5`](https://testnet.arcscan.app/address/0x79ea853CcaA1FE41f7EDc26469AeAFD905676Fb5) |
| PvPRouterV3 (binds the two hubs above) | [`0xb69596295AdB785571eeA1eAed9aeD162A510d42`](https://testnet.arcscan.app/address/0xb69596295AdB785571eeA1eAed9aeD162A510d42) |

All three are source-verified on the Arc Blockscout explorer. The V2 hubs and
the V2 `PvPRouter` remain deployed but are **superseded** — their redemption
path is defeatable by any party (see the README's hub lineage table and
[THREAT-MODEL.md](THREAT-MODEL.md) rows 28/29). Point new integrations at the
V3 addresses above.

> **Migrating from V2?** Four things changed at the API surface:
> `net()` returns `consumed: ConsumedIou[]` rather than `consumedIds: Hex[]`;
> `RoundProposal.consumedIds` became `.consumed`; `redeemIOU` lost its proofs
> argument; and `prepareRedemptionProofs` is gone — use `consumed(leafId)` or
> `isConsumed(iou)`. The EIP-712 hub domain, the `IOU` and `Round` structs and
> every signing call are **unchanged**. Details in each section below.

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

const HUB_USDC: Address = "0xfe96A00f14d61F36AcECe69c39eA01C8af02C1ad";

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
`expiry > now + L` (`DEFAULT_MAX_IOU_LIFETIME_SECONDS`, 86,400 s). Under V3
this is an **off-chain hygiene convention only** — no contract reads `L`. It
was load-bearing on V2, whose redemption coverage rule compared a buffered
timestamp against `expiry − L`; V3 deleted both the rule and the immutable, so
violating the convention no longer weakens anyone's redemption protection. It
is kept because bounding how long signed paper sits outstanding still bounds
the window in which a debtor's collateral must remain sufficient. Override per
call with `opts.maxIouLifetimeSeconds`, or check without signing via
`checkIouLifetime(iou, { now })`.

Also note the netting engine drops IOUs expiring within its safety window
(default 60 s), so keep expiries comfortably ahead of settlement.

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
// result.consumed: ConsumedIou[] — see below
// result.grossVolume / result.settledVolume: bigint base units

const roundNonce = await hub.roundNonce();
const proposal = buildProposal(HUB_USDC, roundNonce, result);
// proposal.digest       — the EIP-712 digest every participant signs
// proposal.manifestHash — merkle root over the consumed set's leaves
// proposal.consumed     — ConsumedIou[], ascending by leafId
```

**The consumed set (changed in v3).** `net()` returns
`consumed: ConsumedIou[]`, not `consumedIds: Hex[]`, and `RoundProposal` carries
`.consumed` rather than `.consumedIds`. Each entry is:

```ts
interface ConsumedIou {
  id: Hex;         // hashIou(iou) — also the hub's redemption-nullifier key
  debtor: Address;
  creditor: Address;
  leafId: Hex;     // manifestLeafId(id, debtor, creditor) — the manifest leaf
}                  // AND the key of the hub's permanent `consumed` ledger
```

The set is sorted ascending **by `leafId`**, not by raw id — that is the order
the contract's merkle builder sees. Every field is *derived*: recompute and
compare, never adopt a coordinator's copy.

If you want the raw ids (for your own settled/redeemed bookkeeping, which stays
raw-id-keyed), project them:

```ts
import { consumedIds, manifestLeafId } from "arclear";

const ids = consumedIds(result.consumed);                   // Hex[]
const leaf = manifestLeafId(ids[0], alice.address, bob.address);
```

The calldata form — `ConsumedRef { id, partyAIdx, partyBIdx }`, the two indices
pointing into `participants` — is derived at submission time by
`HubClient.executeRound`, so you never construct it by hand. (`consumedRefs(participants, consumed)`
is exported if you are building the transaction yourself.)

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
`pendingConsumedIds` (the **raw ids** of your outstanding unconfirmed consents,
i.e. `new Set(consumedIds(otherProposal.consumed))`) — `verifyProposal` will
refuse overlaps that could double-settle your paper.

`verifyProposal` is **total**: any malformed proposal returns
`{ ok: false, reason }`, never throws, so an auto-consent daemon gets a refusal
rather than a crash. Refusal reasons you may see, beyond the v2 set
(`roundNonce mismatch`, `delta mismatch`, `self not in participant set`,
`manifestHash does not match the consumed set`, `digest does not match proposal
contents`):

| Reason | Meaning |
| ------ | ------- |
| `consumed id X: debtor/creditor Y is not a participant` | the entry names a party the round does not list, so the hub would revert |
| `consumed id X: debtor and creditor are the same party` | no IOU has one party; the hub rejects it as `SelfConsumedRef` |
| `consumed id X: leafId does not bind the stated parties` | the cached leaf is not what those two addresses derive — a manifest that looks self-consistent but attributes paper to somebody else |
| `my consumed id X is missing from the proposal manifest` | your own recomputation consumed this obligation but the manifest does not carry **its** leaf; consenting would leave your paper live under a round claiming to have netted it |
| `consumed id X overlaps an outstanding unconfirmed consent` | the `pendingConsumedIds` guard |
| `malformed proposal: …` | the totality wrapper — bad hex, out-of-range int256, unsortable manifest |

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
executed rounds in which that debtor settled nothing.

**Under v3 this takes no proofs.** `prepareRedemptionProofs` no longer exists —
the hub gates on a single permanent storage read:

```ts
// Two O(1) reads decide it. Either form works:
const alreadyNetted = await hub.isConsumed(signedByAlice.iou);
// …or, if you're holding the leaf rather than the IOU:
// const alreadyNetted = await hub.consumed(leafId);

const stale =
  (await hub.roundNonce()) >= (await hub.lastRound(alice.address)) + (await hub.K());

if (!alreadyNetted && stale && !(await hub.redeemed(signedByAlice.id))) {
  await hub.redeemIOU(bobWallet, signedByAlice.iou, signedByAlice.signature);
}
```

Note the signature: `redeemIOU(wallet, iou, sig)` — three arguments. The V2
`proofs` parameter is gone, along with the root ring, the `expiry − L` coverage
rule, and the TOCTOU window where a round landing mid-flight invalidated your
proofs. Cost is a flat, **history-independent** 150,000 gas limit
(`REDEEM_IOU_GAS`), measured at 82,003 total whether the hub has seen 4 rounds
or 64.

Two properties worth relying on:

- **Permanent.** Nothing evicts, expires or rewrites a `consumed` entry, so an
  unnetted IOU stays redeemable for as long as the debtor's collateral lasts.
  There is no window to miss.
- **Unforgeable by third parties.** The ledger is keyed on the *party-bound*
  leaf, so the only way your obligation gets marked consumed is a round in which
  **you** signed. On V2, any address could mark it consumed for a few hundred
  thousand gas — which is why V3 exists.

Still **best-effort in one respect, by design**: `withdraw` is never pausable,
so redemption races a debtor's exit and reaches only posted, still-present
collateral. Credit caps remain the exposure bound. `K` is an uncalibrated
demo-scale default of 3. Spec and honesty notes:
[PROTOCOL.md → IOU redemption](PROTOCOL.md#iou-redemption).

> **Auditing a round's manifest** is a separate concern from redemption now.
> `hub.fetchManifest(nonce)` still reconstructs which obligations a round
> extinguished — and, new in v3, under which party pair — from public calldata
> alone, decoding both direct `executeRound` and `PvPRouterV3.executePvP`
> shapes and confirming the leg against the root the chain logged. On live Arc,
> construct the client with the hub's deploy block, since the public RPC prunes
> history and rejects from-genesis scans:
> `new HubClient(HUB_USDC, pub, { earliestBlock: 54004274n })`.

## 5. Cross-currency PvP

Netting compresses obligations *within* a token; the `PvPRouterV3` composes the
USDC and EURC hubs *across* tokens — two leg proposals plus a signed FX rate
settle atomically in one transaction (payment-vs-payment, a miniature CLS).
The SDK covers the whole flow: `buildPvPProposal`, `verifyPvPProposal` (per-leg
re-verification + cross-multiplied rate checks — no division), `signPvPConsent`,
and `PvPRouterClient.executePvP`. Spec:
[PROTOCOL.md → Cross-currency PvP rounds](PROTOCOL.md#cross-currency-pvp-rounds).

Two v3 notes. The bundle's EIP-712 domain is **`("ArclearPvPRouterV3", "1")`**,
so a consent signed for the V2 router is not valid here and vice versa — even
though the `PvPRound` typehash is byte-identical. And **a bundle is two rounds
in one transaction**: at the demo's 105 consumed entries per leg it needs ~7.3M
gas, so it hits a block ceiling at roughly half the manifest size a single
round carries. Size accordingly before assuming a manifest one hub handles
comfortably will fit in a bundle.

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
