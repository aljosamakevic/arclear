---
phase: audit-scope-C-demo
reviewed: 2026-07-27T12:28:42Z
depth: deep
files_reviewed: 10
files_reviewed_list:
  - demo/coordinator.ts
  - demo/pvp.ts
  - demo/setup.ts
  - demo/server.ts
  - demo/e2e.ts
  - demo/simulate.ts
  - demo/agents.ts
  - demo/fx.ts
  - demo/mockToken.ts
  - public/dashboard.html
cross_referenced:
  - src/client.ts
  - src/round.ts
  - src/netting.ts
  - src/pvp.ts
  - src/iou.ts
  - src/domain.ts
  - demo/env.ts
  - demo/report.ts
  - contracts/src/ClearingHubV2.sol
  - fly.toml
  - fly.testnet.toml
  - Dockerfile
findings:
  critical: 8
  warning: 19
  info: 0
  total: 27
status: issues_found
---

# Audit Scope C — demo / coordinator layer

**Reviewed:** 2026-07-27T12:28:42Z
**Depth:** deep (whole-layer, cross-module; not a diff)
**Status:** issues_found

## Summary

The consent state machine itself is the strongest part of this layer. I tried hard to
break `attemptRound`'s two-pass logic (all-stall, quorum collapse, pass-2 stall, empty
rounds, late resolutions after the deadline, synchronously-throwing providers, invalid
signatures inflating miss counters) and **could not**. The D-02 snapshot-then-ignore
guard, the CR-01 `screenConsents` demotion, the D-06/D-07 miss semantics, and the hard
2-pass cap are all correct as written. The prior fixes cited in the brief
(verifyConsent screening, the `/round` 409 guard, the redeemedIds log-driven fold,
the EURC preflight + receipt asserts, top-up-to-target) are individually correct.

What is broken is everything *around* that core, and it is broken in ways that are live
right now on `arclear-demo-testnet.fly.dev`.

Three headline results, each proven with a scratch harness against the repo's own modules:

1. **The live testnet demo bricks itself after three button presses.** `demo/server.ts`
   generates traffic at `amountDivisor: 10n` while `demo/setup.ts` funds each agent with
   0.5 USDC of collateral. Three presses of "Simulate traffic" before "Run netting round"
   produce a worst-case debit of 642,987 base units against a 500,000 balance —
   `executeRound` reverts `InsufficientCollateral`, nothing settles, the unsettled paper
   stays in the pool, and every subsequent round reverts *harder*. `demo/e2e.ts:36-40`
   already documents this exact scale as "never runnable"; the server shipped the number
   the e2e rejected.
2. **A single transient RPC failure permanently wedges the coordinator.** The WR-01
   pending record is taken before broadcast (correct) but has no expiry, no txHash-less
   recovery path, and no operator reset. One 429 from the public Arc RPC during
   `executeRound` leaves `pendingSubmission` set with `txHash === undefined` and the
   on-chain nonce unmoved — and `reconcilePendingSubmission` then returns `blocked`
   forever, even after the RPC recovers.
3. **`recordPendingSubmission` silently clobbers an unreconciled pending record, and the
   hub has no settled-id nullifier.** `ClearingHubV2.executeRound` gates only on
   `redeemed[]` (`contracts/src/ClearingHubV2.sol:218-223`) — round-consumed ids are
   *not* nullified on-chain. Off-chain `settledIds` is therefore the only thing standing
   between the demo and a genuine double-settlement of the same paper. I drove a
   10/10-id double-settle through the public API of `Coordinator`.

On the "no protocol authority" claim: `hold`/`release`/`recordPendingSubmission`/
`foldSettled` are all correctly *only-more-conservative*, and the PvP wrapper cannot
forge consent — that property holds. But the class doc "Holds no keys and no authority"
(`demo/coordinator.ts:335-337`) is false *for this deployment*: the hosted testnet
process holds `AGENT_MNEMONIC` (all five members' keys) and `DEPLOYER_PK` (the funding
key), and signs every consent itself. See WR-16.

Findings are tagged **[HOSTED]** (affects the two live fly.io deployments today) and/or
**[REFERENCE]** (a hazard an integrator inherits by copying this code).

Proof scripts live under the session scratchpad (not committed):
`collateral.mts`, `bursts.mts`, `wedge.mts`, `clobber.mts`, `state.mts`, `leak.mts`.

---

## Critical Issues

### CR-01: Hosted testnet demo is guaranteed to revert after ~3 simulate presses — the server ships the traffic scale the e2e explicitly rejected [HOSTED]

**File:** `demo/server.ts:114`, `demo/setup.ts:55`, cross-ref `demo/e2e.ts:36-40`

**Issue:**
`demo/server.ts:114` uses `amountDivisor: mode === "anvil" ? 1n : 10n`. `demo/e2e.ts:40`
uses `25n` for testnet, with a measured comment directly above it:

> `divisor 10 → -0.383 (reverts at the liveness round — never runnable)`

`TESTNET_COLLATERAL` is `parseUnits("0.5", 6)` = 500,000 base units. Because
`simulateTraffic` re-seeds deterministically from `traffic-${k}` on every call
(`demo/simulate.ts:23`), every 35-IOU burst produces the *identical* delta vector, so
debits add linearly across presses.

Proven (`bursts.mts`, run against `demo/simulate.ts` + `src/netting.ts`):

```
1 press  ( 35 IOUs): worst debit = -214329 vs collateral 500000
2 presses( 70 IOUs): worst debit = -428658 vs collateral 500000
3 presses(105 IOUs): worst debit = -642987 vs collateral 500000  *** REVERTS
4 presses(140 IOUs): worst debit = -857316 vs collateral 500000  *** REVERTS
```

And with rounds interleaved (`collateral.mts`, one press then one round, repeating):

```
round 1: min balance after = 285671
round 2: min balance after =  71342
round 3: 0x9965...a4dc bal=71342 needs=214329  *** REVERT
```

Failure mode after the first revert is **absorbing**: `submit` throws
`tx reverted: 0x…` (`demo/coordinator.ts:639`), nothing enters `settledIds`, the 105
IOUs stay open, and the next round nets *more* paper against the same balance. The only
partial escape is the 3,600 s IOU expiry (`demo/simulate.ts:46`) dropping the backlog out
of `net()` an hour later — a visitor re-breaks it in 20 seconds. Every attempt burns
faucet gas on a mined revert.

**Fix (minimal):** make the demo's traffic scale a function of the funded collateral
rather than a hand-tuned literal, and refuse to build a proposal that cannot execute.

```ts
// demo/server.ts — match the e2e's measured-safe scale
amountDivisor: mode === "anvil" ? 1n : 25n,
```

Plus a preflight in `Coordinator.submit` (also fixes the gas burn in CR-05):

```ts
// before broadcasting: refuse a round the hub will reject
for (let i = 0; i < proposal.participants.length; i++) {
  const d = proposal.deltas[i];
  if (d >= 0n) continue;
  const bal = await this.hubClient.collateral(proposal.participants[i]);
  if (bal < -d) {
    throw new Error(
      `InsufficientCollateral preflight: ${proposal.participants[i]} has ${bal}, needs ${-d}`,
    );
  }
}
```

Better still, treat it as an abort-as-data outcome (house convention) rather than a
throw, and exclude the under-collateralized member through the existing
exclude-and-recompute machinery.

---

### CR-02: One transient broadcast failure permanently wedges the coordinator — no expiry, no reset, no operator path [HOSTED] [REFERENCE]

**File:** `demo/coordinator.ts:609-641` (record-before-broadcast), `demo/coordinator.ts:481-524` (reconcile)

**Issue:**
`submit` sets `this.pendingSubmission` at line 616 *before* calling
`hubClient.executeRound` (correct for CONS-04). If `executeRound` itself throws — a 429,
a socket reset, `insufficient funds for gas`, `exceeds block gas limit` — the record
survives with `txHash === undefined` and the on-chain nonce unmoved.
`reconcilePendingSubmission` then takes the third branch every time:

- `onChainNonce > pending.roundNonce`? No — nothing mined.
- `pending.txHash`? Undefined — the receipt probe at line 509 is skipped.
- → `{ blocked: true }`, **forever**. There is no age bound, no block-height bound, and
  no `clearPendingSubmission` caller reachable from any HTTP endpoint.

Proven (`wedge.mts`, real `Coordinator` with a stub that fails one broadcast then heals):

```
round 1 threw: HTTP request failed. Status: 429 URL: https://rpc.testnet.arc.network
round 2: outcome=aborted reason=previous submission still unconfirmed … (CONS-04)
round 3: outcome=aborted reason=previous submission still unconfirmed … (CONS-04)
round 4: outcome=aborted reason=previous submission still unconfirmed … (CONS-04)
on-chain nonce still 0n -> coordinator is permanently wedged, no operator recovery path
```

The same wedge occurs with `txHash` set when a tx is dropped from the mempool
(`getTransactionReceipt` returns null forever, nonce never advances).

Worse, the wedge can be **masked as a normal abort**: `runRound`'s catch classifies on
`msg.includes("WrongRoundNonce")` (line 713). If the RPC surfaces a decoded custom error
whose text contains that name while `pendingSubmission` is still set, `/round` returns
`200 {"outcome":"aborted"}` and the dashboard shows nothing wrong while the instance is
dead. (See WR-05.)

**Fix:** the nonce is monotonic and only `executeRound` advances it, so
`onChainNonce === pending.roundNonce` **proves nothing executed**. The only residual risk
is a still-pending tx from *our* relayer. Discriminate on the relayer's account nonce and
bound the record's age:

```ts
private async reconcilePendingSubmission() {
  const pending = this.pendingSubmission;
  if (!pending) return { blocked: false as const };
  const onChainNonce = await this.hubClient.roundNonce();
  if (onChainNonce > pending.roundNonce) { /* …unchanged fold-by-digest… */ }

  // Nothing executed at this nonce. Are any of OUR relayer's txs still pending?
  const from = this.relayerWallet.account!.address;
  const [latest, pendingCount] = await Promise.all([
    this.pub.getTransactionCount({ address: from, blockTag: "latest" }),
    this.pub.getTransactionCount({ address: from, blockTag: "pending" }),
  ]);
  if (pendingCount === latest) {
    // No in-flight relayer tx can still mine -> definitively nothing executed.
    this.pendingSubmission = undefined;
    return { blocked: false as const };
  }
  const tip = await this.pub.getBlockNumber();
  if (tip - pending.sentAtBlock > PENDING_MAX_BLOCKS) {
    this.lastError = `stale pending submission at round ${pending.roundNonce} discarded after ` +
      `${PENDING_MAX_BLOCKS} blocks — verify no RoundExecuted exists before resuming`;
    this.pendingSubmission = undefined;
    return { blocked: false as const };
  }
  return { blocked: true as const, reason: "…" };
}
```

Independently: expose an authenticated operator reset so a wedged hosted instance does
not require a redeploy (which itself re-spends faucet funds — see WR-01).

---

### CR-03: `recordPendingSubmission` clobbers an unreconciled record → double-settlement of already-settled paper [REFERENCE]

**File:** `demo/coordinator.ts:405-419`, `demo/pvp.ts:696-707`, `demo/pvp.ts:593-594`

**Issue:**
`recordPendingSubmission` is a bare assignment with no guard:

```ts
recordPendingSubmission(p: {…}) { this.pendingSubmission = p; }
```

`runPvPRound` calls it on both legs (`demo/pvp.ts:696-697`, again at 706-707). It first
calls `state.hold(...)` — but `holdReason` is only consulted at `runRound`'s *entry*
(`demo/coordinator.ts:530`), so it cannot stop a round already awaiting a receipt. So the
sequence is reachable:

1. Ordinary `runRound` broadcasts round N; the receipt wait dies (transport). The pending
   record — the *only* copy of `{roundNonce, digest, consumedIds}` needed to fold that
   settlement — is the recovery data.
2. A PvP bundle (or any second submitter sharing this `Coordinator`) records its own leg
   → the ordinary round's record is silently discarded.
3. The PvP bundle mines-and-reverts → `clearPendingSubmission()` (`demo/pvp.ts:713-714`).
4. Next `runRound` re-nets round N's already-settled paper.

Step 4 is a real double-settlement, not a revert, because
`ClearingHubV2.executeRound` gates only on `redeemed[]`
(`contracts/src/ClearingHubV2.sol:218-223`) — **there is no settled-id nullifier
on-chain**. Off-chain `settledIds` is the sole defense.

Proven (`clobber.mts`, all through `Coordinator`'s public API):

```
round 1 (mined, receipt lost): socket hang up
settledIds after round 1: 0 (pending record holds the recovery data)
PvP leg overwrote the pending record (no guard, no error)
round 3 outcome: settled
round 3 consumed 10 ids at nonce 1
DOUBLE SETTLE: 10/10 ids from the round-1 manifest are in the round-3 manifest
```

**Fix:** make the record write refuse to destroy an unreconciled one, and make `hold`
cover in-flight rounds.

```ts
recordPendingSubmission(p: PvPPending & { txHash?: Hex }) {
  const cur = this.pendingSubmission;
  if (cur && cur.digest !== p.digest) {
    throw new Error(
      `refusing to overwrite an unreconciled pending submission (round ${cur.roundNonce}, ` +
      `digest ${cur.digest}) — reconcile it before recording another`,
    );
  }
  this.pendingSubmission = p;
}
```

and in `runPvPRound`, before `attemptPvPRound`, assert both legs are quiescent
(`pendingSubmission === undefined` and no round in flight) — returning
`{ outcome: "blocked" }` if not, which the existing `PvPRunResult` union already models.

---

### CR-04: `/stall` is unauthenticated, unrate-limited, and can disable settlement on the live testnet instance [HOSTED]

**File:** `demo/server.ts:130-145`

**Issue:**
`/stall` is the only POST endpoint with **no** cooldown check (contrast lines 100 and 147)
and no authentication. It mutates persistent server state
(`persona.stalled = !persona.stalled`, line 141) that directly controls whether real
settlements can occur.

Failing scenario (5 unauthenticated requests, no browser needed):

```
for a in Crawler Summarizer Oracle Trader Auditor; do
  curl -sX POST "https://arclear-demo-testnet.fly.dev/stall?agent=$a"; done
```

Every subsequent `/round` now: waits the full 30 s `consentWindowMs`
(`demo/coordinator.ts:378`, never overridden by the server) for pass 1, excludes all five
members, rebuilds to 0 participants, and aborts at the D-01 quorum floor
(`demo/coordinator.ts:258-266`). The live "settles real rounds on Arc Testnet" demo now
demonstrates only aborts, to every visitor, indefinitely. A loop re-applies it faster
than anyone can un-toggle it through the dashboard.

Secondary: `req.url?.startsWith("/stall")` (line 130) also matches `/stallion`,
`/stall-anything`; and the toggle semantics mean a script cannot be idempotently
countered.

**Fix:** put `/stall` behind the same cooldown as the other POSTs, make it idempotent
(`?stalled=true|false` rather than a toggle), require exact path match, and gate failure
injection behind an operator token on any non-anvil deployment.

```ts
if (req.method === "POST" && new URL(req.url!, "http://x").pathname === "/stall") {
  if (mode !== "anvil" && req.headers["x-demo-token"] !== process.env.DEMO_ADMIN_TOKEN) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "failure injection is operator-only on the live instance" }));
    return;
  }
  const retryInMs = cooldown("/stall");
  if (retryInMs > 0) { /* 429 */ }
  const want = new URL(req.url!, "http://x").searchParams.get("stalled");
  persona.stalled = want === null ? !persona.stalled : want === "true";
  …
}
```

---

### CR-05: Unbounded `/simulate` accumulation → gas-formula explosion → broadcast rejection → permanent wedge [HOSTED]

**File:** `demo/server.ts:99-129`, `demo/coordinator.ts:421-423`, `src/client.ts:318-337`

**Issue:**
`/simulate` appends 35 signed IOUs per call to `coordinator.ious`
(`addIous` is `this.ious.push(...batch)` — no cap, no pruning, no dedupe). Nothing ever
removes an IOU from that array: not settlement, not redemption, not expiry. With
`DEMO_COOLDOWN_MS=20000` a scripted caller adds 105 IOUs/min; on the sandbox
(`fly.toml` sets no cooldown at all, so `COOLDOWN_MS = 0` — see CR-07) the only limiter
is the `simulating` flag and the 120 ms stream delay, i.e. ~500 IOUs/min.

Because CR-01 makes rounds stop settling, `openIous` grows monotonically even under
*honest* use. `HubClient.executeRound` sizes gas as

```
300_000 + 40_000 * participants + 6_000 * consumedIds.length        (src/client.ts:318-321)
```

so the manifest length is a direct multiplier on the requested gas limit:

| open IOUs | requested gas | balance the relayer must hold at 25 gwei |
|---|---|---|
| 105 | 1.13 M | 0.028 USDC |
| 2,000 | 12.5 M | 0.313 USDC |
| 5,000 | 30.5 M | 0.763 USDC (and ≥ a 30 M block limit) |

Once the requested limit exceeds the block gas limit, or `gas * maxFeePerGas` exceeds the
deployer's remaining USDC, `eth_sendRawTransaction` rejects → `executeRound` **throws** →
CR-02's permanent wedge, with `pendingSubmission` set and `txHash` undefined. ~19 minutes
of scripted `/simulate` at the 20 s cooldown reaches 2,000 IOUs; faucet depletion reaches
the same rejection sooner.

Memory: `ious` on a 1 GB fly VM (`fly.testnet.toml:31-32`) grows until OOM-kill, which
restarts the machine and re-runs `setupTestnet` — re-spending funding (see WR-01).

**Fix:** cap accumulation and cap the manifest.

```ts
// demo/coordinator.ts
const MAX_OPEN_IOUS = 2_000;
addIous(batch: SignedIou[]) {
  this.ious.push(...batch);
  // drop paper that can never net again: settled, redeemed, or long expired
  if (this.ious.length > MAX_OPEN_IOUS * 4) this.prune(BigInt(Math.floor(Date.now() / 1000)));
  if (this.ious.length > MAX_OPEN_IOUS * 8) throw new Error("IOU pool full");
}
```

and refuse to build a round whose manifest would exceed a gas budget:

```ts
const MAX_MANIFEST_IDS = 400n; // 300k + 40k*n + 6k*400 ≈ 2.9M — comfortably under any block limit
if (BigInt(result.consumedIds.length) > MAX_MANIFEST_IDS) {
  return { outcome: "empty", reason: `manifest too large (${result.consumedIds.length} ids) — settle in batches` };
}
```

---

### CR-06: 500 responses and `/state.lastError` leak raw transport errors, including `ARC_RPC_URL` [HOSTED]

**File:** `demo/server.ts:176-180`, `demo/coordinator.ts:718-720`, `demo/coordinator.ts:749`

**Issue:**
The catch-all returns the raw exception message to any caller:

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}
```

viem embeds the transport URL, the request body, and the full call arguments in its error
messages. My `wedge.mts` run reproduces the exact shape a visitor would receive:

```
HTTP request failed. Status: 429 URL: https://rpc.testnet.arc.network
```

`.env.example:2-3` explicitly invites operators to *"swap in your own provider
endpoint"* — provider endpoints for testnet RPC are routinely of the form
`https://…/v2/<API_KEY>`. That key is then served to anyone who can make `/round` fail,
which CR-01 guarantees will happen.

Worse, it is not transient: `runRound`'s catch stores the same string in
`this.lastError` (line 719), and `state()` serializes it (line 749) into **every**
subsequent `GET /state` response until the next successful round — which, per CR-01,
never comes. The dashboard renders it verbatim (`public/dashboard.html:200`).

**Fix:** log verbosely server-side, return a stable reference to the client, and scrub
before storing.

```ts
} catch (e) {
  const id = randomUUID();
  console.error(`[demo] ${id}`, e);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "internal error", ref: id }));
}
```

```ts
// demo/coordinator.ts — never persist raw transport text into public state
const redact = (m: string) =>
  m.replace(/https?:\/\/\S+/g, "<rpc>").split("\n")[0].slice(0, 200);
this.lastError = redact(msg);
```

---

### CR-07: The only faucet-spend control is an undeclared env var defaulting to "unlimited", and being global it hands availability to the fastest poller [HOSTED]

**File:** `demo/server.ts:45-59`, `fly.testnet.toml:24`, `fly.toml`

**Issue:** two independent defects in one mechanism.

**(a) Undeclared.** `const COOLDOWN_MS = Number(process.env.DEMO_COOLDOWN_MS ?? 0)`.
Grepping the whole repo, `DEMO_COOLDOWN_MS` appears in exactly two places: this line, and
a *comment* in `fly.testnet.toml:24` claiming "Button presses are rate-limited via
DEMO_COOLDOWN_MS". It is set in **no** `[env]` block, **no** `.env.example` entry, and
**no** documentation. The sole control protecting a real funding key on an
unauthenticated internet endpoint is unversioned out-of-band configuration that
fails **open**: any redeploy to a fresh app, any machine that loses the secret, any
`fly.toml`-based bring-up runs with unlimited spend. `fly.toml` (the sandbox) sets it
nowhere either, which is why the sandbox has no limiter at all — the substrate for CR-05.

**(b) Global, so it is also a denial-of-service primitive.** `lastPostAt` is keyed by
endpoint, not by client:

```ts
const last = lastPostAt.get(endpoint);
if (elapsed < COOLDOWN_MS) return COOLDOWN_MS - elapsed;
lastPostAt.set(endpoint, Date.now());
```

A single attacker polling `POST /round` every 250 ms wins essentially every 20 s window,
so *every* legitimate visitor receives 429 forever while the attacker still gets
3 rounds/min of real on-chain spend. The global design bounds total spend (its stated
goal) but converts the shared budget into a first-come lockout. Real exposure at
3 rounds/min: ~1.1 M gas × 25 gwei ≈ 0.028 USDC/round → ~120 USDC/day of faucet burn,
all of it on reverts once CR-01 fires.

**Fix:** declare the value in versioned config, fail closed on non-anvil deployments, and
add a per-IP bucket on top of the global budget.

```ts
const isAnvil = mode === "anvil";
const COOLDOWN_MS = Number(process.env.DEMO_COOLDOWN_MS ?? (isAnvil ? 0 : 20_000));
if (!isAnvil && COOLDOWN_MS <= 0) {
  throw new Error("refusing to run a funded testnet demo with DEMO_COOLDOWN_MS disabled");
}
```

```toml
# fly.testnet.toml
[env]
  DEMO_COOLDOWN_MS = "20000"
  DEMO_DAILY_TX_BUDGET = "200"
```

Per-IP layer (`x-forwarded-for` is trustworthy behind fly's proxy) plus a hard daily
transaction budget that stops broadcasting entirely when exhausted.

---

### CR-08: `GET /state` is unauthenticated, unthrottled, O(total IOUs), and issues 5 RPC calls per request [HOSTED]

**File:** `demo/server.ts:80-98`, `demo/coordinator.ts:725-745`

**Issue:**
`/state` is the only endpoint with no guard of any kind, and it is the most expensive one.
`Coordinator.state()` does two costly things per call:

- `net(this.ious, …)` at line 727 — over **every IOU ever created**, not `openIous`.
  Settled and expired paper is walked on every poll forever.
- an `await this.hubClient.collateral(...)` per persona in a sequential loop
  (lines 733-737) — 5 `eth_call`s, on the shared public Arc RPC, per request.

Measured (`state.mts`, real `Coordinator`, 21,000 IOUs *all* marked settled — i.e. zero
open paper, purely dead weight):

```
GET /state: 7.3 ms of CPU per request with 0 open IOUs, 5 RPC eth_calls per request
dashboard polls every 1.5s => 3.3 RPC calls/sec per open browser tab, unthrottled
```

Two attacks, both trivially scripted against a single-threaded Node process:

- **CPU:** cost scales linearly with `ious.length`, which CR-05 lets an attacker grow
  without bound. At 200 k IOUs (~30 min of `/simulate`) each `/state` costs ~70 ms; the
  event loop saturates at ~14 req/s.
- **RPC amplification / cascade:** 100 req/s of `/state` produces 500 `eth_call`/s from
  the fly machine to `rpc.testnet.arc.network`. Getting the demo's egress IP rate-limited
  or banned is the *precondition* for CR-02 — the resulting 429 during a broadcast wedges
  the coordinator permanently.

Also note `res.end(readFileSync(dashboardPath))` at line 77 — a synchronous disk read on
the event loop per `GET /`.

**Fix:** cache `/state`, net only open paper, and batch the collateral reads.

```ts
// demo/coordinator.ts
const preview = net(this.openIous, { now, settledIds: this.settledIds, redeemedIds: this.redeemedIds });
const balances = await this.pub.multicall({
  contracts: this.personas.map((p) => ({
    address: this.hub, abi: clearingHubV2Abi, functionName: "collateral", args: [p.account.address],
  })),
});
```

```ts
// demo/server.ts — one recompute per second regardless of visitor count
let stateCache: { at: number; body: string } | undefined;
if (req.method === "GET" && req.url === "/state") {
  if (!stateCache || Date.now() - stateCache.at > 1_000) {
    stateCache = { at: Date.now(), body: JSON.stringify({ …await coordinator.state(now()) }) };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(stateCache.body);
  return;
}
```

Read the dashboard file once at boot rather than per request.

---

## Warnings

### WR-01: Fire-and-forget `/simulate` has no `catch`; a crash restarts the machine and re-spends funding [HOSTED]

**File:** `demo/server.ts:109-124`, `demo/setup.ts:283-336`

The background task is `try { … } finally { simulating = false; }` — **no catch, and no
`.catch()` on the returned promise**. Any rejection inside becomes an unhandled rejection,
which Node ≥15 treats as fatal by default. There is no `process.on("unhandledRejection")`
or `("uncaughtException")` handler anywhere in `demo/` or `src/`.

The consequence is a spend loop, not just a crash: fly restarts the machine
(`min_machines_running = 1`), `setupTestnet` runs again, and the top-up logic transfers up
to `5 × (GAS_RESERVE 0.2 + collateral shortfall ≤ 0.5)` USDC plus ~15 transactions of gas
**per restart**. Combined with CR-05's OOM path, an attacker who exhausts the 1 GB VM
converts memory pressure into faucet drain.

**Fix:** `.catch((e) => { console.error(e); })` on the IIFE, plus process-level handlers
that log and keep serving rather than exiting, plus a boot-time guard that refuses to
re-fund more than N times per hour.

### WR-02: Cooldown is stamped before the no-op and in-flight guards, so rejected requests consume the window [HOSTED]

**File:** `demo/server.ts:100-105`, `146-160`

`cooldown()` both checks *and* stamps. `/round` stamps at line 147 and only then checks
`roundInFlight` at 156 — a request that gets a 409 has already burned the next 20 s for
everybody. `/simulate` stamps at line 100 and then may do nothing at all if `simulating`
is already true (line 106), still returning `202 {ok:true}`.

**Fix:** split into `peek()` / `stamp()`; stamp only after the action is actually
initiated.

### WR-03: `setupAnvil` sleeps blindly, never checks anvil started, and silently attaches to a stale chain [HOSTED sandbox] [REFERENCE]

**File:** `demo/setup.ts:125-126`

```ts
const anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
```

Three problems: (1) no `anvil.on("error", …)` — if the binary is missing, the
`ChildProcess` `'error'` event has no listener and Node throws an uncaught exception with
a confusing message; (2) `stdio: "ignore"` discards the only diagnostic; (3) if port 8545
is already bound (an orphan from a previous run — the exact hazard WR-08/`demo/e2e.ts:130`
calls out), `spawn` fails but the code proceeds to deploy against the **stale** chain, and
the `-- --anvil` sandbox then shows a world that does not match its own bootstrap.

**Fix:** attach an `error` handler, and poll `pub.getBlockNumber()` with a deadline
instead of sleeping; assert `chainId === 31337` and `blockNumber === 0n` before deploying.

### WR-04: `setupAnvil` never checks deployment or mint receipts and uses `contractAddress!` [REFERENCE]

**File:** `demo/setup.ts:136-187`

`deployToken`, `deployHub`, the router deploy, and the mint loop all await receipts and
ignore `status`; three of them then non-null-assert `contractAddress!`. This directly
contradicts the discipline documented ten lines below in `depositAll`
(`demo/setup.ts:90-98`: *"Explicit gas skips simulation, so a revert only ever surfaces in
the receipt status — swallowing it here is how agents silently ended up with zero
collateral at boot"*). A reverted deploy yields `contractAddress === null`, and the
`!` turns it into `undefined` flowing into every downstream `address:` field.

**Fix:** apply the same assertion to every receipt in this file:

```ts
const r = await pub.waitForTransactionReceipt({ hash: tx });
if (r.status !== "success" || !r.contractAddress) {
  throw new Error(`deploy reverted or produced no address: tx ${tx}`);
}
return r.contractAddress;
```

### WR-05: `WrongRoundNonce` is classified by substring match on an error message — the anti-pattern the adjacent comment disclaims [REFERENCE]

**File:** `demo/coordinator.ts:708-717`

The comment at line 712 says the marker "is produced by submit's own chain-state check
(WR-02)" — but the outer classifier is `if (msg.includes("WrongRoundNonce"))`, a string
match on an arbitrary exception. Any error whose text happens to carry that substring
(a node that *does* decode custom errors on `eth_sendRawTransaction`, a wrapped viem error,
a future message change) is silently downgraded to a benign abort. That path returns
`200 {"outcome":"aborted"}` while `pendingSubmission` may still be set — masking CR-02's
wedge behind a normal-looking response.

**Fix:** have `submit` throw a typed sentinel and match on identity, not text:

```ts
class ConcurrentRoundError extends Error {}
// …
if (onChainNonce !== proposal.roundNonce) throw new ConcurrentRoundError(`…`);
// …
if (e instanceof ConcurrentRoundError) { /* abort-as-data */ }
```

### WR-06: `hold()`/`release()` is a single non-reentrant slot and does not stop an in-flight round [REFERENCE]

**File:** `demo/coordinator.ts:386-394`, `demo/coordinator.ts:530`, `demo/pvp.ts:592-594`, `demo/pvp.ts:780-783`

`holdReason` is one string; `release()` clears it unconditionally in a `finally`. Two
overlapping PvP runs over the same hub pair → the first to finish releases the hold the
second still depends on, and an ordinary round can then advance a leg's nonce mid-bundle
(exactly the Pitfall-4 failure the hold exists to prevent). Separately, `runRound` reads
`holdReason` only at entry, so `hold()` cannot stop a round already awaiting a receipt —
the precondition for CR-03.

**Fix:** make it a token/counter and have `runRound` re-check before `submit`:

```ts
private holds = new Map<symbol, string>();
hold(reason: string): symbol { const t = Symbol(reason); this.holds.set(t, reason); return t; }
release(t: symbol) { this.holds.delete(t); }
get held() { return this.holds.size > 0; }
```

### WR-07: `runPvPRound` builds legs without reconciling redeemedIds or pendingSubmission [REFERENCE]

**File:** `demo/pvp.ts:652-666`

`Coordinator.runRound` calls `reconcilePendingSubmission()` then `reconcileRedeemedIds()`
before netting (`demo/coordinator.ts:542-552`). `runPvPRound` reads
`usdc.state.openIous` / `eurc.state.openIous` directly with neither. A redemption
submitted by any creditor since the coordinator's last round is therefore still in the
leg's candidate set, and `executeRound` reverts `NullifiedIdInManifest`
(`contracts/src/ClearingHubV2.sol:222`) — the whole atomic bundle dies after a full
two-pass consent collection and a real gas spend. The contract's nullifier gate prevents
loss here; the cost is wasted gas and an unexplained abort.

**Fix:** add a `reconcile(): Promise<void>` member to `PvPLegState` and await it for both
legs immediately after taking the holds, before reading `openIous`.

### WR-08: `attemptRound` throws instead of aborting-as-data when a participant has no provider [REFERENCE]

**File:** `demo/coordinator.ts:64-70`

```ts
if (!providers.get(key)) throw new Error(`no consent provider for participant ${participant}`);
```

The module contract (lines 176-177) is explicit: *"Aborts are expected protocol behavior —
data, never thrown errors (Pitfall 6)."* This one path violates it. In the demo every
participant is a persona so it never fires, but an integrator whose IOU pool contains one
address outside their member registry gets a hard throw out of `attemptRound` on **every**
round — an unrecoverable, self-inflicted liveness failure where the intended behavior
(exclude the unknown member, rebuild, settle among the rest) is already implemented one
function away.

**Fix:** treat "no provider" as a pass-1 refusal-for-cause so the existing
exclude-and-recompute machinery handles it.

### WR-09: `Coordinator.addIous` performs no validation whatsoever [REFERENCE]

**File:** `demo/coordinator.ts:421-423`

`this.ious.push(...batch)` — no `verifyIou`, no expiry check, no hub/chainId check, no
`id === iouId(hub, iou, chainId)` recomputation, no dedupe. The demo signs its own IOUs so
this is invisible here, but the file is the reference an integrator copies for a real
ingestion endpoint. A forged or mis-domained IOU that reaches the pool costs a full
consent round (two 30 s windows) before honest members refuse it.

**Fix:**

```ts
async addIous(batch: SignedIou[]) {
  for (const s of batch) {
    if (s.id.toLowerCase() !== iouId(this.hub, s.iou, this.chainId).toLowerCase()) {
      throw new Error(`iou id does not match its contents / hub domain`);
    }
    if (!(await verifyIou(this.hub, s, this.chainId))) {
      throw new Error(`iou ${s.id} is not signed by its debtor ${s.iou.debtor}`);
    }
  }
  this.ious.push(...batch);
}
```

### WR-10: Log-derived `settledIds` / `redeemedIds` are never un-folded on a reorg [REFERENCE]

**File:** `demo/coordinator.ts:446-471`, `demo/coordinator.ts:500-505`, `demo/pvp.ts:639-644`

Both reconciliation paths fold ids from event logs with no confirmation depth and no
inverse operation. A reorg that orphans a `RoundExecuted` or `IouRedeemed` log leaves those
ids permanently in the in-memory sets, so that paper can never enter a proposal again —
an unrecoverable liveness loss for a real obligation, with no diagnostic. The direction is
conservative (no double-settle), but the doc comments claim convergence *from chain logs
alone*, and this path does not converge back.

**Fix:** fold only from logs at least `CONFIRMATIONS` blocks deep
(`toBlock: tip - CONFIRMATIONS`), and set `redemptionScanBlock` to that same bound rather
than `tip`.

### WR-11: Unwindowed `getContractEvents` in two places, contradicting the windowing discipline elsewhere [REFERENCE]

**File:** `demo/coordinator.ts:489-499`, `src/client.ts:160-169`

`reconcilePendingSubmission` and `HubClient.roundExecutedHashes` both call
`getContractEvents({ fromBlock, /* no toBlock */ })`. `MAX_LOG_SCAN_SPAN` and
`scanWindows` exist precisely because *"live Arc providers cap log queries (observed:
'query exceeds max block range 100000')"* (`src/client.ts:61-67`) and are correctly used
in `fetchManifest` and `reconcileRedeemedIds`. These two are the exact calls that run
during a wedge recovery, i.e. when `sentAtBlock` is oldest — so the recovery path is the
one most likely to hit the provider cap and throw, deepening CR-02.

**Fix:** route both through `scanWindows(fromBlock, await pub.getBlockNumber(), MAX_LOG_SCAN_SPAN)`.

### WR-12: `rounds` grows without bound and is serialized in full on every `/state` [HOSTED]

**File:** `demo/coordinator.ts:348`, `demo/coordinator.ts:784`

`rounds: this.rounds` ships the entire history — each entry carrying a `deltas` record —
in every poll, to every tab, every 1.5 s. Nothing trims it. Combined with CR-08 this is a
bandwidth and serialization amplifier that grows for the life of the process.

**Fix:** `rounds: this.rounds.slice(-25)` in `state()` (mirroring the existing
`openIous.slice(-25)` at line 767), and cap the retained array.

### WR-13: `ious` is never pruned — settled, redeemed, and long-expired paper is walked forever [HOSTED]

**File:** `demo/coordinator.ts:339`, `426-432`, `727`

`net()` correctly *ignores* expired/settled/redeemed IOUs, but nothing removes them from
the array, so every `openIous` access and the `state()` preview pay for them
indefinitely. Quantified in CR-08's measurement: 21,000 fully-settled IOUs cost 7.3 ms of
CPU per `/state` call while contributing nothing.

**Fix:** a `prune(now)` that drops IOUs whose id is in `settledIds`/`redeemedIds` or whose
`expiry` is more than one safety window in the past; call it at the end of `runRound`.

### WR-14: Dashboard writes server-controlled strings into `innerHTML`; no CSP [HOSTED] [REFERENCE]

**File:** `public/dashboard.html:200`, `195-199`, `157`, `203`

`s.lastError` and `s.phaseDetail` are concatenated into `$("phase").innerHTML`. Per CR-06
those strings are raw viem/RPC error text — attacker-influence over an upstream error body
is the only missing link to DOM XSS on a page that has no `Content-Security-Policy`, no
`X-Content-Type-Options`, and no escaping helper anywhere. Line 157 also interpolates a
name straight into an inline `onclick="toggleStall('${a.name}')"` handler. Names and roles
are constants today; the pattern is what integrators copy.

**Fix:** render text through `textContent`, or add a one-line escaper and use it on every
server-sourced substring; serve a `Content-Security-Policy: default-src 'self'` header (it
would require moving the inline script to a file, which is worth doing anyway).

### WR-15: `demo/e2e.ts` orphans anvil on every throwing path, despite the WR-08 comment claiming otherwise [REFERENCE]

**File:** `demo/e2e.ts:129-134` (comment), and all `await` sites

The comment at line 130-132 states the intent: *"kill the spawned anvil on EVERY exit path
— an orphan bound to 8545 makes the next run silently attach to stale chain state."* But
`env.anvil?.kill()` appears only on the explicit `process.exit(1)` branches. Every
`await coordinator.runRound(...)` (proven throwable in CR-02), `await runPvPRound(...)`,
`await env.hubClient.redeemIOU(...)`, and any `setup()` failure after the spawn rejects
straight out of top-level await — leaving the orphan the comment warns about, which then
triggers WR-03 on the next run.

**Fix:** wrap the body in `try { … } finally { env.anvil?.kill(); }`, or register
`process.on("exit" | "uncaughtException" | "unhandledRejection", () => env.anvil?.kill())`
immediately after `setup()` returns.

### WR-16: "Holds no keys and no authority" is false for the hosted deployment; nothing prevents the public anvil mnemonic on testnet [HOSTED] [REFERENCE]

**File:** `demo/coordinator.ts:333-337`, `demo/agents.ts:4-5`, `demo/setup.ts:219-233`

The class doc asserts *"Holds no keys and no authority — every agent independently
verifies the proposal before consenting."* The *protocol* property is real and I verified
it holds everywhere including the PvP path (`hold`/`recordPendingSubmission`/`foldSettled`
can only make an instance more conservative; no path forges a signature). But the
**deployment** contradicts the sentence: the hosted testnet process derives all five
members from `AGENT_MNEMONIC` and signs every consent itself (`demo/coordinator.ts:566-606`),
while also holding `DEPLOYER_PK`. A compromise of that fly machine is a compromise of every
key in the system. Nothing in `setupTestnet` rejects `AGENT_MNEMONIC === ANVIL_MNEMONIC`
— the well-known public test mnemonic — which would make every agent's funds
world-spendable.

**Fix:** restate the invariant precisely ("holds no *protocol* authority: it cannot forge
consent — in this demo it does hold the members' keys purely to simulate them"), and add a
boot guard:

```ts
if (mnemonic.trim() === ANVIL_MNEMONIC) {
  throw new Error("AGENT_MNEMONIC is the public anvil test mnemonic — refusing to run on a funded chain");
}
```

### WR-17: Miss counters are skipped whenever `submit` throws [REFERENCE]

**File:** `demo/coordinator.ts:644-669`

`applyMissSemantics(this.missed, attempt.pass1)` runs at line 669, *after* the `await
attemptRound(...)`. Since `submit` is invoked from inside `attemptRound`, any submission
failure (revert, transport error, nonce race) propagates past line 669, so that round's
pass-1 timeouts are never recorded. D-06's "consecutive missed consent windows" therefore
undercounts exactly in the scenarios where a member's unresponsiveness matters most.

**Fix:** apply pass-1 miss semantics as soon as the pass-1 snapshot exists — either inside
`attemptRound` via a callback, or by moving the call into a `finally` that has access to
`attempt.pass1`.

### WR-18: Assorted server hardening gaps [HOSTED]

**File:** `demo/server.ts`

- **26** — `Number(process.env.PORT ?? 4402)` yields `NaN` for a malformed `PORT`;
  `listen(NaN)` silently binds a random port, so fly's health check fails opaquely.
  Validate with `Number.isInteger`.
- **77** — synchronous `readFileSync` per `GET /`; read once at boot.
- **80, 99, 146** — exact-match routing means `/state?x=1` 404s while `/stallXYZ` (line
  130, `startsWith`) succeeds. Normalize with `new URL(req.url, "http://x").pathname`
  everywhere.
- **90 vs 64** — `explorerBase` is derived from `env.chain.id === 5042002` while
  `explorerTxBase` is derived from `mode`. Two sources of truth for the same fact; the
  comment at line 62-63 claims the derivation exists so they *"can never disagree"*.
- **all POST handlers** — request bodies are never consumed. Node will not drain them, so
  a client sending a large body against `Connection: keep-alive` leaves unread data on the
  socket. Add `req.resume()` before responding.
- **no** `server.headersTimeout` / `requestTimeout` / `maxHeadersCount` are set, and no
  security headers (`X-Content-Type-Options`, `Referrer-Policy`) are emitted.

### WR-19: Production image installs Foundry via unpinned `curl | bash` [HOSTED]

**File:** `Dockerfile:9-11`

```dockerfile
RUN curl -L https://foundry.paradigm.xyz | bash && /root/.foundry/bin/foundryup
```

The image that serves both public demos executes an unpinned remote script at build time
and then installs whatever `foundryup` resolves to at that moment — no version pin, no
checksum, no lockfile. A compromise or a breaking upstream release changes what the
sandbox runs, silently. The image also ships full devDependencies and runs via `npx tsx`.

**Fix:** pin the foundry release (`foundryup --version <tag>`) and verify a published
checksum, or vendor the `anvil` binary from a pinned release artifact.

---

## What I could not break (verified negative results)

Recorded so the next reviewer does not re-tread it:

- **Two-pass consent state machine** — all-stall (→ quorum abort, all misses recorded),
  quorum collapse to 1 participant, pass-2 stall (→ clean abort, never a pass 3),
  empty rounds (<2 participants → `empty`, no chain I/O), late provider resolutions after
  the deadline (D-02 snapshot holds), synchronously-throwing providers (WR-05 microtask
  hop works), and invalid signatures (demoted to refusal, correctly *not* counted as a
  miss per D-07). All correct.
- **Pass-1 signatures never carry into pass 2** — `rebuildProposal` produces a new digest
  and `collectConsents` is re-run from scratch. Confirmed.
- **PvP cannot forge consent** — `screenPvPConsents` verifies both leg consents (by reusing
  `screenConsents`) and the `PvPRound` signature before `finalize` can see them; the
  `!` assertions in `finalize` are all discharged by the preceding
  `consents.size === union.length` check plus `legParticipants ⊆ union`.
- **`fxTradePair`'s division** is genuinely only an amount constructor — a truncating
  quotient (including the `eurcAmount === 0` case for tiny inputs) is rejected by the
  `rateConsistent` cross-multiplication immediately after.
- **Memory retention from stalled providers** — I hypothesized that the never-settling
  `new Promise(() => {})` (`demo/coordinator.ts:567`) retains the `RoundProposal` via its
  reaction list. Measured over 200 rounds with 20,000-id manifests: **0 MB retained**. V8
  collects the whole unreachable promise/reaction cycle. Hypothesis disproven; not a
  finding.
- **`scanWindows` / `redemptionScanBlock` advance** — the deliberate one-block overlap is
  correct and the `Set` fold is idempotent; a reorg to a shorter chain rewinds safely.
- **`net()` determinism, zero-sum, dedupe, and the settled/redeemed filters** — behaved
  correctly under every input I fed it.

---

_Reviewed: 2026-07-27T12:28:42Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
