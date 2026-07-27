---
phase: audit-E-ops-docs
reviewed: 2026-07-27T12:55:00Z
depth: deep
scope: operational security, packaging, deployment config, docs-vs-code truthfulness
files_reviewed: 34
files_reviewed_list:
  - Dockerfile
  - .dockerignore
  - fly.toml
  - fly.testnet.toml
  - package.json
  - package-lock.json
  - tsconfig.json
  - tsconfig.build.json
  - .gitignore
  - .env.example
  - demo/env.ts
  - demo/server.ts
  - demo/setup.ts
  - demo/coordinator.ts
  - demo/agents.ts
  - demo/e2e.ts
  - demo/simulate.ts
  - src/index.ts
  - src/domain.ts
  - src/client.ts
  - src/iou.ts
  - src/round.ts
  - src/netting.ts
  - public/dashboard.html
  - contracts/src/ClearingHub.sol
  - contracts/src/ClearingHubV2.sol
  - contracts/src/lib/ManifestMerkle.sol
  - contracts/script/Deploy.s.sol
  - contracts/script/DeployV2.s.sol
  - contracts/.gas-snapshot
  - README.md
  - docs/QUICKSTART.md
  - docs/PROTOCOL.md
  - docs/CONCEPTS.md
  - docs/THREAT-MODEL.md
  - docs/CALIBRATION.md
  - docs/PLAN.md
  - docs/V2-BRIEF.md
findings:
  critical: 7
  warning: 21
  info: 7
  total: 35
status: issues_found
---

# Audit Scope E: Ops, Packaging & Documentation Truthfulness

**Reviewed:** 2026-07-27
**Depth:** deep (cross-file, cross-stack, on-chain verification, executed builds/tests)
**Status:** issues_found

## Summary

Four jobs were run: secret hygiene, supply chain/packaging, deployment config, and
docs-vs-code truthfulness. Every claim below was produced by running a command, not
by reading alone.

**The good news first, because it is load-bearing for the rest of the report.** The
numeric honesty of this project holds up under direct verification:

- **Test counts are exact.** `npx vitest run` → 120 passed; `forge test` → 101 passed.
  README.md:144, :162, :182, :183 all match.
- **All seven documented contract addresses resolve on Arc Testnet** (chain id read
  back as 5042002). V2 USDC hub `token()` = `0x3600…0000`, V2 EURC hub `token()` =
  `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, both with `K=3 / RING=16 /
  MAX_IOU_LIFETIME=86400` — matching README.md:227-228, QUICKSTART.md:41-42 and
  PROTOCOL.md:390-391. `PvPRouter.hubUSDC()`/`hubEURC()` read back as exactly the two
  V2 hubs README.md:244 claims it pins.
- **Both cited transaction hashes exist and succeeded.** The PvP tx used **507,394 gas**
  — byte-exact with README.md:248.
- **Every gas figure in PROTOCOL.md:516-522 is reproducible.** `forge test --match-test
  test_gas_ -vvv` emits 329108 / 691708 / 1254993 / 199604 / 563814 / 1734897 — all six
  match the table exactly.
- **Every CALIBRATION.md number transcribes its CSV verbatim.** All 9 headline cells,
  all 6 latency rows, all 24 margin cells, the "16 rows at n=50, p=0.8" claim (exactly
  16), the "144 rows / all p99_tail_coverage 0.0000" claim, and the "best cell 0.5519 at
  n=15, p=1.0, q=2.0, N=16" claim all check out against `docs/sweep/*.csv`.
- **Every README sweep finding checks out** against `docs/sweep/sweep.csv`: n=3 needs
  reciprocity ≥ 0.4 to clear 30% (0.2959 at 0.3, 0.4444 at 0.4); density 0.1→1.0 at n=10
  gives 0.6634→0.8718; p10 worst saving 0.0000/0.3248/0.5309 at n≤5/15/50.
- **PROTOCOL.md's redemption gate order matches `ClearingHubV2.sol:318-378` step for
  step**, including the strict `<` in the coverage rule and the underflow guard. The
  merkle construction and both proof-verification walks match
  `ManifestMerkle.sol:66-146` exactly.
- **Every THREAT-MODEL test citation resolves** — all 23 named Foundry test functions
  and the named TS tests exist.
- **The QUICKSTART code type-checks against the real published artifact.** I ran
  `npm pack`, installed the tarball into a fresh consumer project, transcribed
  QUICKSTART.md §3.1-§4 verbatim, and `tsc` exits 0 — with and without `@types/node`.
- **The README headline box is a real e2e output.** `npm run e2e:anvil` printed
  `105 IOUs / $55.19597 / $4.25945 / 92.3%` — README.md:15-19 rounds this honestly.
- **`.env` cannot reach the Docker image.** The Dockerfile uses explicit `COPY` of
  `package.json`, `package-lock.json`, `tsconfig.json`, `src`, `demo`, `public` — there
  is no `COPY . .`, no `ARG`/`ENV` secret, and no `.npmrc`. `.dockerignore` covers
  `.env`/`.env.*` as belt-and-braces.
- **Nothing secret was ever committed.** `git log --all -S` on `PRIVATE_KEY`,
  `DEPLOYER_PK`, `AGENT_MNEMONIC`, `MNEMONIC` returns only variable-name references; no
  commit ever added a `.env`; no 12-word phrase appears in history. The only committed
  `0x[0-9a-f]{64}` literals are ABIs, fixtures, tx hashes and broadcast records.
- **Supply chain is genuinely viem-only.** `dist/**` imports nothing outside `viem` and
  relative siblings. Lockfile is drift-free (`npm ci --dry-run` adds only optional
  `fsevents`). `npm audit --omit=dev` → 0 vulnerabilities.

**The bad news.** Everything above is undermined by seven blockers, four of which are
live on `arclear-demo-testnet.fly.dev` right now:

1. The **token-bearing private RPC URL leaks to unauthenticated HTTP callers** via two
   independent paths. I proved this end-to-end. This is the single most urgent item.
2. The **shipped SDK's `fetchManifest` is intermittently broken** by a viem caching
   default, which makes the flagship `redeemIOU` recovery path unreliable and makes the
   documented `npm run e2e:anvil` quickstart fail roughly 40% of the time (measured:
   2 failures in 5 clean runs, two distinct symptoms, same root cause).
3. The **README's testnet quickstart cannot work** — it deploys the wrong contract and
   writes to env keys nothing reads.
4. The **faucet-protection rate limit is fail-open and unpinned**, while the README
   advertises it as the thing stopping a visitor draining the demo budget.

---

## Blockers

### CR-01: Token-bearing RPC URL leaks to any HTTP caller via 500 error bodies — LIVE

**Severity:** BLOCKER — affects the live public deployment now
**Files:** `demo/server.ts:176-180` (sink) · `src/client.ts:118-125` and every viem call
site (source) · `.env.example:2` and `docs/PLAN.md:22` (context)

`demo/server.ts` terminates every handler in a catch-all that puts the raw error message
on the wire:

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));      // demo/server.ts:179
}
```

viem embeds the **full RPC URL** in `HttpRequestError.message` / `RpcRequestError.message`
via `metaMessages: [..., \`URL: ${getUrl(url)}\`]`
(`node_modules/viem/_esm/errors/request.js:5-15`). `getUrl` strips only *basic-auth*
credentials (`node_modules/viem/_esm/errors/utils.js:19-33`) — a **path-embedded API
token is preserved verbatim**.

This is not theoretical. The repo's own `.env` sets `ARC_RPC_URL` to a **119-character
token-bearing endpoint on `rpc.testnet.arc-node.thecanteenapp.com`** (verified without
printing the value; `is_public_default: false`, 2 path segments, long opaque token
segment). `.env.example:2` explicitly invites this ("swap in your own provider endpoint
if you have one") and `fly.testnet.toml:4` lists `ARC_RPC_URL` as a fly secret for the
live app.

**Proof (executed):** driving `HubClient.collateral` — the exact call `/state` makes —
against a keyed URL and formatting the result exactly as server.ts:177-179 does:

```
LEAKS_RPC_URL_IN_HTTP_500: true
{"error":"HTTP request failed.\n\nStatus: 401\nURL: https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_FAKE_TOKEN_abcdef123456\nRequest body: {\"method\":\"eth_call\",...
```

Triggering it is trivial: `GET /state` performs 5 sequential `collateral()` reads
(`demo/coordinator.ts:733-737`), the dashboard polls it every 1.5 s
(`public/dashboard.html:231`), and the RPC layer already rate-limits — my own read loop
against the *public* Arc RPC returned `"request limit reached"` within a handful of
requests. Any RPC hiccup, timeout, or quota rejection returns the credential.

**Fix:** never put transport errors on the wire. Log the detail, return an opaque token.

```ts
} catch (e) {
  const id = randomUUID();
  console.error(`[demo] request failed (${id})`, e);   // server-side only
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "internal error", id }));
}
```

**Also rotate the Canteen RPC token** — assume it has already been served to visitors.

---

### CR-02: The same credential leaks through the unauthenticated `/state` payload and into every visitor's DOM — LIVE

**Severity:** BLOCKER — affects the live public deployment now
**Files:** `demo/coordinator.ts:718-720` (capture) · `demo/server.ts:80-97` (exposure) ·
`public/dashboard.html:200,203` (render)

Independent of CR-01. `Coordinator.runRound` stores the raw error message as durable
state:

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  ...
  this.phase = "failed";
  this.lastError = msg;          // demo/coordinator.ts:719
  throw e;
}
```

`Coordinator.state()` returns `lastError` unmodified (`demo/coordinator.ts:749`), and
`demo/server.ts:80-97` serves that object from `GET /state` — no auth, no cooldown,
polled every 1.5 s by every open dashboard tab. `public/dashboard.html:200` then renders
it:

```js
"failed": "❌ " + (s.lastError ?? "failed"),
...
$("phase").innerHTML = cd + ... + (phases[s.phase] ?? "");   // dashboard.html:203
```

So one failed round on the testnet app pins the credential-bearing viem message into
`/state` **until the next successful round**, and paints it on screen for anyone who
loads the page. This is strictly worse than CR-01: it persists and it is served on the
happy path.

Secondary issue at the same line: `innerHTML` with a server-derived error string is a
latent DOM-XSS sink. Today nothing attacker-controlled reaches `lastError`, but the
class of bug is one error-message change away.

**Fix:**

```ts
// demo/coordinator.ts — sanitize at the boundary
this.lastError = redact(msg);   // strip URLs, or map to a stable code
```

and in `public/dashboard.html:203` use `textContent` for the error branch (or escape),
keeping `innerHTML` only for the fixed-template ArcScan anchor at line 199.

---

### CR-03: `HubClient.fetchManifest` reads a cached block number — `redeemIOU` proof assembly and the documented `e2e:anvil` quickstart fail intermittently

**Severity:** BLOCKER — shipped SDK correctness bug; breaks a documented command
**Files:** `src/client.ts:224-238` · propagates to `src/client.ts:258-269`
(`prepareRedemptionProofs`) · surfaced by `demo/e2e.ts:326` · documented at
`docs/QUICKSTART.md:242`

```ts
const latest = await this.pub.getBlockNumber();          // src/client.ts:224
for (const [fromBlock, toBlock] of scanWindows(this.earliestBlock, latest, MAX_LOG_SCAN_SPAN)) {
  ... getContractEvents({ ..., fromBlock, toBlock })
}
if (logs.length === 0) throw new Error(`no RoundExecuted event for round nonce ${nonce} ...`);
```

viem's `getBlockNumber()` is **cached for `cacheTime` ms, which defaults to
`pollingInterval` = 4000 ms**. A round mined within the last 4 seconds is therefore
outside `[earliestBlock, latest]`, the scan returns zero logs, and `fetchManifest` throws
for a round that provably executed.

**Proof (executed against a fresh anvil):**

```
client cacheTime(ms): 4000
before mine, getBlockNumber: 0n
after mining 3 blocks:
  cached getBlockNumber()               : 0n
  uncached getBlockNumber({cacheTime:0}): 3n
```

**Impact, measured.** `npm run e2e:anvil` — README.md:184 (`# full flow, locally, ~20s`)
and QUICKSTART.md:268 — failed **2 of 5 clean runs** (stray anvils killed between each):

```
Error: no RoundExecuted event for round nonce 5 at hub 0xe7f1725e…
    at HubClient.fetchManifest (src/client.ts:240)
    at async HubClient.prepareRedemptionProofs (src/client.ts:265)
    at async demo/e2e.ts:326
```

The failure lands immediately after `✓ staleness round 3/3 executed without Oracle` —
i.e. rounds 3/4/5 mined milliseconds before `prepareRedemptionProofs` ran, exactly the
4-second window. This is not a demo-only defect: `prepareRedemptionProofs` is the
public SDK entry point QUICKSTART.md:242 tells integrators to call, so the headline v2
recovery path (`redeemIOU`) is intermittently unusable in production.

**Fix (one line):**

```ts
const latest = await this.pub.getBlockNumber({ cacheTime: 0 });   // src/client.ts:224
```

Same treatment for `demo/coordinator.ts:447` (`reconcileRedeemedIds`), where a stale tip
lets a just-redeemed id survive into the next proposal and revert the round with
`NullifiedIdInManifest` — safe on-chain, but a wasted round and wasted relayer gas.
`demo/coordinator.ts:615` and `demo/setup.ts:248` are safe (staleness there only widens a
scan). Consider also raising the error message to distinguish "not yet indexed" from
"never happened", and guard `scanWindows` returning `[]` when `earliestBlock > latest`
(a mis-set `HUB_V2_DEPLOY_BLOCK` currently produces the same misleading message).

---

### CR-04: The README's testnet quickstart deploys the wrong contract and writes to dead env keys

**Severity:** BLOCKER — the primary "run it yourself" path is broken
**Files:** `README.md:195-210` vs `demo/setup.ts:216-227` · `contracts/script/Deploy.s.sol:16`
vs `contracts/script/DeployV2.s.sol` / `contracts/script/DeployPvPRouter.s.sol`

README.md:204-209 instructs:

```bash
TOKEN_ADDRESS=0x3600…0000 forge script contracts/script/Deploy.s.sol …
# put the printed address into .env as HUB_USDC, then:
npm run e2e:testnet        # or: npm run demo (dashboard against testnet)
```

Three defects compound:

1. `contracts/script/Deploy.s.sol:16` deploys **`ClearingHub`** — the *v1* contract. The
   demo has run on `ClearingHubV2` since Phase 1. `DeployV2.s.sol` and
   `DeployPvPRouter.s.sol` exist but the README never mentions either.
2. `HUB_USDC` / `HUB_EURC` are **read by nothing**. A repo-wide grep across `src/`,
   `demo/`, `contracts/`, `fly*.toml` finds only `.env.example:13-14`, the comment at
   `demo/setup.ts:213`, and unrelated local constants in `test/pvp.test.ts`. They are
   dead configuration presented as required configuration.
3. `demo/setup.ts:221-225` hard-requires `HUB_V2_USDC`, `HUB_V2_EURC` **and**
   `PVP_ROUTER`. Following the README literally therefore terminates at
   `Error: HUB_V2_USDC not set — deploy ClearingHubV2 first (see README)` — an error
   message that points back at a README which does not contain those instructions.

**Fix:** rewrite README.md:203-209 to the actual path — `DeployV2.s.sol` twice (USDC,
EURC), then `DeployPvPRouter.s.sol` with both hub addresses, then set `HUB_V2_USDC`,
`HUB_V2_EURC`, `PVP_ROUTER`, `HUB_V2_DEPLOY_BLOCK`. Either delete `HUB_USDC`/`HUB_EURC`
from `.env.example:12-14` or relabel them `# unused by the demo — v1 record only`.

---

### CR-05: The faucet-protection rate limit is fail-open, unpinned, and contradicted by the README — LIVE

**Severity:** BLOCKER — the advertised control protecting real funds may not exist
**Files:** `demo/server.ts:48,52-59` · `fly.testnet.toml` (no `[env]` block) ·
`README.md:40-42`

README.md:40-42 tells visitors:

> Button presses are rate-limited (20 s cooldown) so a curious visitor can't drain the
> faucet budget.

The code default is **off**:

```ts
const COOLDOWN_MS = Number(process.env.DEMO_COOLDOWN_MS ?? 0);   // demo/server.ts:48
function cooldown(endpoint: string): number {
  if (COOLDOWN_MS <= 0) return 0;                                 // demo/server.ts:53
```

`DEMO_COOLDOWN_MS` appears nowhere in `fly.testnet.toml`, nowhere in `fly.toml`, and is
not even in the secrets list `fly.testnet.toml:4-5` enumerates. The `20 s` figure exists
only in prose. Consequences:

- The value is **not version-controlled**, so a redeploy from a clean `flyctl` context,
  a new machine, or an app recreate silently ships an unthrottled app that spends real
  faucet USDC per `/round`.
- `Number("20s")` or any typo → `NaN`; `NaN <= 0` is `false`, so the guard falls through
  to `elapsed < NaN` → `false` → **no throttling, silently**. The fail-open path has two
  entrances.

`DEMO_COOLDOWN_MS` is not a secret — it belongs in the tracked fly config.

**Fix:**

```toml
# fly.testnet.toml
[env]
  DEMO_COOLDOWN_MS = "20000"
```

```ts
// demo/server.ts:48 — fail closed and reject garbage
const raw = Number(process.env.DEMO_COOLDOWN_MS ?? 20_000);
const COOLDOWN_MS = Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
```

---

### CR-06: `POST /stall` is unauthenticated, uncooled, and can permanently brick the live testnet demo — LIVE

**Severity:** BLOCKER — availability of the flagship public demo
**Files:** `demo/server.ts:130-145` · `fly.testnet.toml:22-27` · `fly.toml:11-16`

```ts
if (req.method === "POST" && req.url?.startsWith("/stall")) {
  const agent = new URL(req.url, "http://x").searchParams.get("agent") ?? "";
  ...
  persona.stalled = !persona.stalled;      // demo/server.ts:141
```

No auth, no origin check, and — unlike `/simulate` (line 100) and `/round` (line 147) —
**no `cooldown()` call**. Any visitor can `curl -XPOST 'https://arclear-demo-testnet.fly.dev/stall?agent=Oracle'`.

The state is durable and there is no reset path: both fly configs set
`auto_stop_machines = false` with `min_machines_running = 1`
(`fly.toml:14-16`, `fly.testnet.toml:25-27`) precisely so the machine *never* restarts.
Stalling 4 of the 5 personas drives every rebuilt round below the quorum floor of 2
(PROTOCOL.md:164-165, `ClearingHubV2.sol:215` `TooFewParticipants`), so every subsequent
`/round` aborts — permanently, for every visitor, until a human redeploys.

**Fix:** put `/stall` behind the same `cooldown()` gate, and either require a shared
secret header on the hosted testnet app or gate the endpoint on
`mode === "anvil"`/`process.env.DEMO_ALLOW_STALL`. Minimum viable:

```ts
if (mode !== "anvil" && process.env.DEMO_ALLOW_STALL !== "1") {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "stall injection disabled" }));
  return;
}
const retryInMs = cooldown("/stall");
```

---

### CR-07: The published SDK crashes on import outside Node and silently absorbs the host application's environment

**Severity:** BLOCKER — blocks `npm publish`; `package.json` is otherwise fully
publish-configured (`prepublishOnly`, `files`, `exports`)
**Files:** `src/domain.ts:12` → `dist/domain.js` · `src/index.ts:2` (barrel) ·
`docs/QUICKSTART.md:16-17`

```ts
export const arcTestnet = defineChain({
  ...
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"] } },
});                                                        // src/domain.ts:6-22
```

This is a **top-level module-evaluation side effect** in a module the barrel re-exports
second (`src/index.ts:2`), so it runs on any `import "arclear"`.

**Proof (executed against the built `dist/`):**

```
IMPORT FAILED without process: ReferenceError process is not defined
```

Any environment without a `process` global — browser bundles, Cloudflare Workers without
`nodejs_compat`, Deno without the Node shim — hard-fails at import time. viem itself is
browser-safe; this SDK is not, and QUICKSTART.md:16 says `npm i arclear viem` with no
runtime caveat.

Two further consequences even inside Node:

- A library silently reading the **host application's** `ARC_RPC_URL` is surprising
  action-at-a-distance. `docs/QUICKSTART.md:90` states `publicClient()` "defaults to the
  Arc Testnet RPC" — it does not; it defaults to whatever the embedding process happens
  to have exported.
- Because `arcTestnet` is a frozen module constant, the value is captured at first
  import and cannot be changed afterwards.

**Fix:** remove the ambient read from the library and resolve it in the demo layer,
which already owns `.env` loading:

```ts
// src/domain.ts — no process access
export const ARC_PUBLIC_RPC = "https://rpc.testnet.arc.network";
export const arcTestnet = defineChain({ ..., rpcUrls: { default: { http: [ARC_PUBLIC_RPC] } } });
```

`publicClient(rpcUrl?)`/`walletClient(account, rpcUrl?)` already take an explicit URL
(`src/client.ts:57,80`), so `demo/setup.ts` can pass `process.env.ARC_RPC_URL` in.

---

## Warnings

### WR-01: Unbounded in-memory coordinator on a machine configured never to restart

**Files:** `demo/coordinator.ts:422,426-428,704,727` · `fly.toml:14-16,18-20` ·
`fly.testnet.toml:25-31`

`this.ious.push(...batch)` (line 422) never prunes; `this.rounds.push(executed)`
(line 704) never prunes; `state()` recomputes `net(this.ious, …)` over the **entire
history** on every poll (line 727) and serializes the full `rounds` array (line 784).
Both fly apps pin `auto_stop_machines = false` + `min_machines_running = 1` on a
`shared-cpu-1x / 1gb` VM, so the process is expected to run indefinitely with no state
reset — while README.md:33 promises the sandbox "resets on restart".

With `DEMO_COOLDOWN_MS` unset (CR-05), `/simulate` sustains ~8 IOUs/s
(`demo/server.ts:111,119`: 35 IOUs × 120 ms). Growth is unbounded in both memory and
per-poll CPU.

**Fix:** cap retained history — e.g. drop settled IOUs from `this.ious` once folded into
`settledIds`, and keep `this.rounds` to a bounded tail (`this.rounds.slice(-50)`) in the
`/state` payload.

### WR-02: `/state` amplifies RPC load and is the trigger for CR-01/CR-02

**Files:** `demo/coordinator.ts:732-737` · `public/dashboard.html:231` · `demo/server.ts:80`

Each `/state` issues **five sequential** `collateral()` RPC reads in a `for` loop, and
the dashboard polls every 1500 ms per open tab. Ten concurrent visitors ≈ 33 RPC
reads/s. My own paced verification loop against the public Arc RPC hit
`"request limit reached"` well below that. Quota rejection is what converts this into the
credential leak of CR-01/CR-02.

**Fix:** cache the collateral map for ~5 s, batch via multicall, and/or decouple the
chain-read cadence from the poll cadence.

### WR-03: `.gitignore` does not cover `.env.*` — a `.env.testnet` would be committed

**Files:** `.gitignore:2-3` vs `.dockerignore:2-4`

`.dockerignore` correctly uses `.env` + `.env.*` + `!.env.example`. `.gitignore` lists
only `.env` and `.env.local`. Verified with `git check-ignore -v`: `.env` and
`.env.local` are ignored; **`.env.testnet`, `.env.production`, `.env.prod` are not.**
This repo now runs two deployments with different secret sets
(`fly.testnet.toml:4-5`) — creating `.env.testnet` is the obvious next step and would
commit live keys.

Also unignored: `arclear-2.0.0.tgz`, produced by the `npm pack` that
`docs/QUICKSTART.md:26` instructs users to run.

**Fix:**

```gitignore
.env
.env.*
!.env.example
*.tgz
```

### WR-04: Dockerfile pipes a remote script to `bash` and installs whatever Foundry is current

**Files:** `Dockerfile:11-12`

```dockerfile
RUN curl -L https://foundry.paradigm.xyz | bash \
  && /root/.foundry/bin/foundryup
```

Two problems: (a) arbitrary remote code executed as root at build time — a compromise of
`foundry.paradigm.xyz` compromises the image; (b) `foundryup` with no version pin means
every rebuild produces a **different anvil**, so the sandbox app is not reproducible and
an upstream anvil regression silently ships. CLAUDE.md records the local toolchain as
`forge v1.3.5-stable`; the image does not pin it.

**Fix:** `foundryup --version v1.3.5` (or install the release tarball by URL + checksum).

### WR-05: Dockerfile base image is a floating tag

**Files:** `Dockerfile:4`

`FROM node:24-bookworm-slim` re-resolves on every build. Pin by digest
(`node:24-bookworm-slim@sha256:…`) so a rebuild of a known-good commit is byte-stable.

### WR-06: Container runs as root

**Files:** `Dockerfile:4-31` (no `USER` directive)

The `node` image ships a non-root `node` user. The demo needs no root privileges at
runtime. Add `USER node` (and `chown` the workdir) so a container escape starts from an
unprivileged account.

### WR-07: The production image ships the entire dev toolchain, including the vulnerable vite/esbuild chain

**Files:** `Dockerfile:17-19,31` · `package.json:57-63` · `tsconfig.build.json`

`npm ci` installs devDependencies by design ("tsx runs the server"), so `vitest`, `vite`,
`vite-node`, `@vitest/mocker`, `esbuild`, `typescript` and `fast-check` all land in the
runtime image. `npm audit` reports **5 vulnerabilities (3 moderate, 1 high, 1 critical)**
entirely in that chain (`GHSA-67mh-4wv8-2f99` esbuild dev-server SSRF and its
transitive dependents). `npm audit --omit=dev` reports **0** — i.e. the whole exposure is
self-inflicted by shipping devDeps.

`esbuild@0.28.1` additionally carries a `postinstall: node install.js` script that runs
during the image build.

**Fix:** compile ahead of time and run plain Node. `tsconfig.build.json` already exists;
extend its `include` to `["src", "demo"]`, add a build stage, and make the final stage
`npm ci --omit=dev` + `CMD ["node", "dist/demo/server.js"]`.

### WR-08: No healthcheck, and the port opens only after a bootstrap that spends real money

**Files:** `demo/server.ts:29,183` · `fly.toml:8-16` · `fly.testnet.toml:18-27`

`const env = await setup(mode);` (line 29) runs to completion **before**
`server.listen(PORT)` (line 183). On the testnet app that bootstrap broadcasts real
transactions — top-up transfers and deposits (`demo/setup.ts:315-335, 372-392, 413-424`).
Neither fly config declares an `[[http_service.checks]]` block and the Dockerfile has no
`HEALTHCHECK`, so fly falls back to a TCP probe against a port that does not exist yet.

If `setup()` throws — e.g. the deployer runs dry and `demo/setup.ts:307-314` fires — the
process exits, fly restarts it, and it re-attempts the funding transactions on every
restart. A crash-loop therefore burns faucet funds and the app is simply down, with
nothing distinguishing "booting" from "broken".

**Fix:** bind the listener first and serve `/health` + a "booting" dashboard state, run
`setup()` asynchronously into a readiness flag, and add:

```toml
[[http_service.checks]]
  interval = "15s"
  timeout = "5s"
  grace_period = "60s"
  method = "GET"
  path = "/health"
```

### WR-09: `demo/e2e.ts` leaks a live anvil on unexpected-throw paths, breaking the next run

**Files:** `demo/e2e.ts:130-132` (comment claims "kill the spawned anvil on EVERY exit
path"), `:211,240,308,376,621,743,771,781` · `demo/coordinator.ts:639`

The kill is hand-placed at nine call sites rather than registered as a process hook. An
unexpected rejection escapes them all — I hit exactly this at `demo/e2e.ts:372`
(`Error: tx reverted:` thrown from `demo/coordinator.ts:639`), and confirmed anvil PID
21010 survived the run. The follow-up `npm run e2e:anvil` then bound to the **surviving
foreign chain** (`demo/setup.ts` cannot bind 8545, its child dies silently) and failed
with a confusing mid-scenario revert.

**Fix:** replace the nine call sites with one registration in `demo/setup.ts`:

```ts
const anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
const kill = () => { try { anvil.kill(); } catch {} };
process.once("exit", kill);
process.once("SIGINT", () => { kill(); process.exit(130); });
process.once("uncaughtException", (e) => { kill(); throw e; });
```

### WR-10: anvil is spawned blind — no readiness check, no error handler, no port check

**Files:** `demo/setup.ts:125-126`

```ts
const anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
```

`stdio: "ignore"` discards the "Address already in use" message; no `error` listener means
a missing Foundry install surfaces as an unhandled `'error'` event rather than "install
Foundry"; and the fixed 1200 ms sleep is a guess. When port 8545 is already held (WR-09,
or a developer's own anvil), the demo silently attaches to a foreign chain — the exact
confusing failure mode observed.

**Fix:** poll `eth_chainId` until it answers (with a timeout), attach
`anvil.on("error", …)` and `anvil.on("exit", …)`, and fail loudly if the port is already
bound.

### WR-11: `contracts/.gas-snapshot` is stale, and PROTOCOL.md cites it as evidence

**Files:** `contracts/.gas-snapshot` · `docs/PROTOCOL.md:531`

PROTOCOL.md:531 says "Snapshot persisted in `contracts/.gas-snapshot`". `forge snapshot
--check` **exits 1**:

```
Diff in "PvPRouterTest::test_gas_executePvP_small()": consumed "(gas: 990737)" gas, expected "(gas: 991157)" gas
```

420 gas of drift. Small, but this file is cited as the durable proof of the gas table.

**Fix:** run `forge snapshot` and commit; add `forge snapshot --check` to CI so it cannot
drift again.

### WR-12: README claims `ClearingHub.sol` is "~250 lines"; it is 181

**Files:** `README.md:8,138,387` vs `contracts/src/ClearingHub.sol` (181 lines)

The claim appears three times ("as a ~250-line contract you deploy", "(~250 lines,
Foundry)", "a ~250-line collateral-and-settlement contract"). Measured: `wc -l` →
**181**. `ClearingHubV2.sol` is 430 and `PvPRouter.sol` is 247, so no file matches ~250
either. `git log` shows `ClearingHub.sol` has exactly one commit and was never longer.

In a project whose stated value proposition is auditable honesty, a 38% overstatement of
the very number used to argue "small enough to read" is a self-inflicted wound.

**Fix:** say "~180-line" (or "a ~180-line v1 hub, ~430 lines with the v2 extensions").

### WR-13: The QUICKSTART redemption snippet cannot succeed as written

**Files:** `docs/QUICKSTART.md:241-244` in the context of `docs/QUICKSTART.md:56-58,220`

§3 is explicitly "one file" (line 56). §3.6 settles the round containing
`signedByAlice`. §4 then does:

```ts
const proofs = await hub.prepareRedemptionProofs(signedByAlice.id);
await hub.redeemIOU(bobWallet, signedByAlice.iou, signedByAlice.signature, proofs);
```

That id is now a leaf of the round-0 manifest, so no valid non-inclusion proof exists
against the buffered root — `nonInclusionProof` cannot construct one, and
`ClearingHubV2.sol:362-364` would reject it as `NonInclusionProofInvalid`. Additionally
the staleness gate (`ClearingHubV2.sol:333`) requires `roundNonce >= lastRound[alice] + 3`,
which cannot hold one round after Alice consented. The snippet type-checks (verified)
but is semantically impossible.

**Fix:** introduce a distinct, never-netted IOU for §4 and state the two preconditions
inline (K executed rounds must have passed; the IOU must never have been consumed).

### WR-14: `docs/PLAN.md` is committed, stale, and discloses the private RPC endpoint's host

**Files:** `docs/PLAN.md:22`

> use the user's Canteen endpoint `https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_…`

The token itself is elided, but the **hostname and token prefix format are published**,
and I confirmed the host is real and token-gated (a fabricated token returns HTTP 401).
Combined with CR-01/CR-02 — which serve the *complete* URL — this is an unnecessary extra
disclosure.

Separately, `docs/PLAN.md` is a frozen v1 planning document (2-day scope, "manifestHash
is a plain keccak256, NOT a merkle tree" at line 20) with no superseded banner, reachable
from the repo tree.

**Fix:** delete the endpoint reference (or replace with `<your provider endpoint>`), and
either add a `> **Superseded — v1 historical record.**` banner to `docs/PLAN.md` or move
it under `.planning/`.

### WR-15: `docs/V2-BRIEF.md` still presents the CCP arc as the plan of record

**Files:** `docs/V2-BRIEF.md:58-76,126-171,205-242` vs `docs/CALIBRATION.md:204-209`

CALIBRATION.md:206 records the decision: *"2026-07-24: CCP arc skipped by user
decision"*, and line 208-209 notes "there is no downstream CCP consumer of these
parameters". `docs/V2-BRIEF.md` carries no such marker — it still describes
`ArclearCCP.sol`, novation, margin, the default waterfall, and an effort map
("Phase 2: ~4 · Phase 3: ~5 …") in the future tense, and line 237 states the project
*is* "a two-product clearing stack".

The same stale framing sits in `CLAUDE.md` ("**Arclear CCP** (novation + margin +
default waterfall — new)").

**Fix:** add a superseded banner at the top of `docs/V2-BRIEF.md` pointing at
CALIBRATION.md §6, and update the CLAUDE.md project blurb.

### WR-16: `/simulate` reports success while doing nothing

**Files:** `demo/server.ts:99-128`

When `simulating` is already `true` (a burst takes ~4.2 s), the handler still consumes
the cooldown stamp at line 100 and returns `202 {"ok":true}` at line 126-127 without
queuing anything. The dashboard shows a successful action that produced no IOUs.

**Fix:** return `409 {"error":"simulation already running"}` before calling `cooldown()`.

### WR-17: The rate limiter is global, in-memory, and per-machine

**Files:** `demo/server.ts:45-59`

Documented as deliberate, but two consequences are not: (a) it resets on every restart —
and CR-05/WR-08 make restarts plausible; (b) it is per-machine, so `auto_start_machines
= true` (`fly.testnet.toml:27`) scaling to two machines doubles the effective request
rate against the faucet budget.

**Fix:** for a demo, note the limitation in the config comment; for correctness, key on a
persisted timestamp or move the limit to fly's edge.

### WR-18: `demo/env.ts` captures trailing whitespace and does not strip quotes

**Files:** `demo/env.ts:9-10`

`/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/` — the greedy `(.*)` consumes trailing spaces before
`\s*$` can. Verified:

```
"ARC_RPC_URL=https://x  "   -> [ 'ARC_RPC_URL', '"https://x  "' ]
'AGENT_MNEMONIC="a b c"'    -> [ 'AGENT_MNEMONIC', '"\"a b c\""' ]
'export DEPLOYER_PK=0xdef'  -> NO MATCH
```

A trailing space on `DEPLOYER_PK` produces viem's opaque "invalid private key"; quoting
the mnemonic (a near-universal `.env` habit) produces a wrong derivation path silently.
CRLF is handled correctly by accident (JS `.` excludes `\r`).

**Fix:**

```ts
const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
if (m && !(m[1] in process.env)) {
  process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
```

### WR-19: `package.json` metadata is not quite publish-clean

**Files:** `package.json:20-23,33-37`

- `repository.url` should be `git+https://github.com/aljosamakevic/arclear.git`
  (npm's canonical form).
- No `engines` field. The Dockerfile pins Node 24 and `dist/` targets ES2022 + NodeNext;
  add `"engines": { "node": ">=20" }` so npm warns rather than failing at runtime.
- `files` ships `.js.map` / `.d.ts.map` (verified in `npm pack --dry-run`) but not the
  `src/**/*.ts` they reference, so every sourcemap in the tarball is dangling. Either add
  `"src"` to `files` or set `"sourceMap": false, "declarationMap": false` in
  `tsconfig.build.json`.

### WR-20: The tarball ships ~80 kB of deploy bytecode the public API never exposes

**Files:** `dist/abi/ClearingHubV2.js` (54.9 kB), `dist/abi/PvPRouter.js` (25.6 kB) ·
`src/index.ts` · `src/client.ts:20`

`npm pack --dry-run` shows both bytecode modules in the tarball. The barrel re-exports
only `clearingHubAbi` (the **v1** ABI, `src/client.ts:20`) — `clearingHubV2Abi`,
`clearingHubV2Bytecode`, `pvpRouterAbi` and `pvpRouterBytecode` are unreachable from
`import … from "arclear"`, yet `HubClient` is documented as "Typed wrapper around one
**ClearingHubV2** deployment" (`src/client.ts:101`) and calls V2 ABI throughout.

An integrator who needs the V2 ABI (to decode events, or to deploy) cannot get it from
the package; meanwhile they pay for the bytecode they cannot use.

**Fix:** decide deliberately — either export `clearingHubV2Abi` / `pvpRouterAbi` from the
barrel (and split bytecode into a separate `arclear/bytecode` subpath export), or exclude
`dist/abi/*Bytecode*` from `files`.

### WR-21: `/stall` reflects arbitrary caller input into a response body

**Files:** `demo/server.ts:134,138`

```ts
const agent = new URL(req.url, "http://x").searchParams.get("agent") ?? "";
...
res.end(JSON.stringify({ error: `unknown agent: ${agent}` }));
```

`content-type: application/json` means modern browsers will not sniff this as HTML, so
this is not exploitable today. It is still an unnecessary reflection of untrusted input.

**Fix:** return a fixed string plus the list of valid agent names.

---

## Info

### IN-01: PROTOCOL.md's anvil PvP gas figure has drifted

`docs/PROTOCOL.md:533-534` cites "~507,442 gas" for the anvil e2e PvP bundle. Two runs
today measured **507,466**; the on-chain testnet tx measured **507,394**
(README.md:248 — exact). The "~" makes the claim defensible; refresh it anyway.

### IN-02: The "Phase-1 v2 hubs" are presented as a distinct contract tier but look like v1

`README.md:251-258` lists `0xa984…7f3c` / `0x57A0…32Cb3` under "Arclear Net v2 — Phase-1
hubs (threshold consent only, …)". Their deployed runtime code is **13,658 hex chars —
identical in length to the v1 hubs**, while the current V2 hubs are 24,162. That is
exactly what PROTOCOL.md:141-143 predicts ("the digest, the fixtures, and the contract
interface are unchanged from v1" — threshold consent needed no contract change), so
these are almost certainly the same `ClearingHub` source redeployed. Codehashes differ,
but OpenZeppelin `EIP712` bakes `address(this)` into an immutable, so per-address
codehash divergence proves nothing.

Presenting them as a separate "v2" contract tier reads as more on-chain change than
occurred. Consider "additional `ClearingHub` deployments from the Phase-1 threshold-consent
milestone — same contract as v1; superseded".

### IN-03: `npm pack` contents are otherwise correct

`LICENSE` (MIT, matching `package.json:19`) is auto-included; 56 files, 90 kB packed. No
test, demo, `.env`, or contract-source file leaks into the tarball. `exports`/`types`
resolve — verified by installing the tarball into a clean project and type-checking with
`"types": []` (exit 0), so consumers do **not** need `@types/node`.

### IN-04: README relative links to non-shipped files

`files` ships only `dist`, `README.md`, `docs/CONCEPTS.md`. The shipped README links to
`docs/PROTOCOL.md`, `docs/QUICKSTART.md`, `docs/THREAT-MODEL.md`, `docs/CALIBRATION.md`,
`docs/sweep/*.svg`, `contracts/src/ClearingHub.sol`, `src/*.ts` and
`public/dashboard.html`. npmjs.com rewrites relative links to the repository URL so most
resolve, but the two sweep SVGs (README.md:304,312) are worth verifying on the npm page
before publishing.

### IN-05: `scanWindows` returns an empty list when `earliestBlock > latest`

`src/client.ts:71-78` with `from > to` yields `[]`, so `fetchManifest` reports "no
RoundExecuted event for round nonce N" — the same message as CR-03 — when the real cause
is a mis-set `HUB_V2_DEPLOY_BLOCK` above the chain tip. Distinguish the two.

### IN-06: `.dockerignore` is correct but load-bearing only for context size

Because the Dockerfile uses explicit `COPY` (lines 18, 22-25) rather than `COPY . .`,
`.dockerignore` cannot be the thing that keeps `.env` out of the image. Worth a one-line
comment so a future `COPY . .` refactor does not quietly rely on it.

### IN-07: `mnemonicToAccount` derivation indices are documented and consistent

`demo/agents.ts:22,34`: index 0 = deployer/relayer, 1..5 = personas. Matches the comment
and `demo/setup.ts`. No issue — recorded because it is the one place a mnemonic is
expanded, and the expansion never reaches logs or HTTP responses.

---

## Verification commands (for re-running this audit)

```bash
npx vitest run                                        # 120 passed
cd contracts && forge test                            # 101 passed
cd contracts && forge test --match-test test_gas_ -vvv # 6 gas figures
cd contracts && forge snapshot --check                # exits 1 (WR-11)
npm run build && npm pack --dry-run                   # tarball contents
node --input-type=module -e "delete globalThis.process; await import('./dist/domain.js')"  # CR-07
for i in 1 2 3 4 5; do npm run e2e:anvil >/dev/null 2>&1; echo $?; pkill -f 'anvil --silent'; done  # CR-03
git check-ignore -v .env.testnet .env.production      # WR-03 (no output = not ignored)
git log --all -S'DEPLOYER_PK' --oneline               # history clean
npm audit --omit=dev                                  # 0 vulnerabilities
npm audit                                             # 5 (dev chain, WR-07)
```

---

_Reviewed: 2026-07-27T12:55:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
