/**
 * End-to-end: fund → deposit → ~100 IOUs → net → unanimous consent → one
 * on-chain settlement → assert balances match the engine's math exactly.
 * Then the D-15 canonical liveness scenario: stall a member → the round
 * settles without them (pass 2) → their IOUs settle cleanly next round →
 * nothing ever settles twice (CONS-04).
 * Then the D-17 redemption scenario: a debtor goes dark past K EXECUTED
 * rounds → the creditor reconstructs non-inclusion proofs from calldata and
 * redeems on-chain → debtor debited to the base unit → the redeemed id is
 * structurally dead for netting forever (MERK-03/MERK-04).
 *
 *   npm run e2e:anvil     (local, spawns anvil, deploys everything)
 *   npm run e2e:testnet   (Arc Testnet, needs .env — see README)
 */
import "./env.js";
import { createWalletClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { setup } from "./setup.js";
import { simulateTraffic } from "./simulate.js";
import { Coordinator } from "./coordinator.js";
import { printReport, fmt } from "./report.js";
import { signIou } from "../src/iou.js";
import { net } from "../src/netting.js";
import { signConsent } from "../src/round.js";
import { signPvPConsent, verifyPvPProposal } from "../src/pvp.js";
import { clearingHubV2Abi, clearingHubV2Bytecode } from "../src/abi/ClearingHubV2.js";
import { clearingHubBytecode } from "../src/abi/ClearingHub.js";
import { pvpRouterBytecode } from "../src/abi/PvPRouter.js";
import type { HubClient } from "../src/client.js";
import type { PvPProposal, SignedIou } from "../src/types.js";
import { quoteToRate, sampleQuote, type FxQuote } from "./fx.js";
import { attemptPvPRound, fxTradePair, runPvPRound, type PvPConsentProvider } from "./pvp.js";

const mode = process.argv.includes("--anvil") ? "anvil" : "testnet";
const now = () => BigInt(Math.floor(Date.now() / 1000));
// Testnet traffic scale: the round sequence is deterministic (seeded traffic),
// so per-round deltas scale ~1/divisor and can be traced offline against the
// faucet-funded TESTNET_COLLATERAL (0.5/hub). Measured minimum post-round
// balance from a fresh 0.5 start: divisor 10 → -0.383 (reverts at the
// liveness round — never runnable), 20 → +0.033 (too thin), 25 → +0.117.
const divisor = mode === "anvil" ? 1n : 25n;

let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`[e2e] ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const env = await setup(mode);
console.log(`[e2e] mode=${mode} hub=${env.hub} token=${env.token}`);

// Pitfall 2 guard: prove the hub runs genuine V2 bytecode, not v1 masquerading.
// The 53-byte CBOR metadata tail is shared between creation and runtime code
// and unique per compiled source, so a tail compare against the creation
// bytecode catches "silently exercising v1" without immutable-slot noise.
const deployedCode = (await env.pub.getCode({ address: env.hub })) ?? "0x";
const tail = (h: string) => h.slice(-106);
console.log(`[e2e] deployed code tail ${tail(deployedCode)}`);
if (mode === "anvil") {
  check(tail(deployedCode) === tail(clearingHubV2Bytecode), "hub bytecode matches ClearingHubV2 (metadata tail)");
  check(tail(deployedCode) !== tail(clearingHubBytecode), "hub bytecode differs from v1 ClearingHub");
} else if (tail(deployedCode) !== tail(clearingHubV2Bytecode)) {
  console.log(`[e2e] warn — testnet hub metadata tail differs from local V2 artifact (code hash ${keccak256(deployedCode as Hex)})`);
}

const coordinator = new Coordinator(
  env.hub,
  env.hubClient,
  env.pub,
  env.personas,
  env.relayerWallet,
  env.chain.id,
);

/** Snapshot on-chain collateral for every persona on one hub (default: USDC). */
async function snapshot(hubClient: HubClient = env.hubClient): Promise<Map<string, bigint>> {
  const m = new Map<string, bigint>();
  for (const p of env.personas) {
    m.set(p.account.address, await hubClient.collateral(p.account.address));
  }
  return m;
}

/** Assert every persona's on-chain movement equals the round's engine delta, to the base unit. */
async function assertDeltas(
  before: Map<string, bigint>,
  deltas: Record<string, string>,
  label: string,
  hubClient: HubClient = env.hubClient,
) {
  for (const p of env.personas) {
    const after = await hubClient.collateral(p.account.address);
    const actual = after - before.get(p.account.address)!;
    const expected = BigInt(deltas[p.account.address.toLowerCase()] ?? "0");
    check(
      actual === expected,
      `${label}: ${p.name.padEnd(11)} ${fmt(before.get(p.account.address)!)} → ${fmt(after)} (Δ ${fmt(actual)})`,
    );
  }
}

/** Two collateral snapshots are identical — same personas, same base units. */
function mapsEqual(a: Map<string, bigint>, b: Map<string, bigint>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// Shared per-pair nonce map: threading it through EVERY traffic batch keeps
// IOU ids unique across the whole run (a repeated (pair, nonce) would hash to
// an id already in settledIds and be silently dropped as settled).
const nonces = new Map<string, bigint>();

// ── Baseline: unanimous single-pass round ────────────────────────────────────
const before1 = await snapshot();

console.log("[e2e] simulating ~100 micropayment IOUs …");
const ious = await simulateTraffic(env.hub, env.personas, 105, {
  now: now(),
  chainId: env.chain.id,
  amountDivisor: divisor,
  startNonce: nonces,
});
coordinator.addIous(ious);
console.log(`[e2e] ${ious.length} IOUs signed off-chain (0 transactions so far)`);

console.log("[e2e] running netting round …");
const baseline = await coordinator.runRound(now());
if (baseline.outcome !== "settled") {
  console.error(`[e2e] FAIL — baseline round did not settle (${baseline.outcome})`);
  // WR-08: kill the spawned anvil on EVERY exit path — an orphan bound to
  // 8545 makes the next run silently attach to stale chain state.
  env.anvil?.kill();
  process.exit(1);
}
check(baseline.round.passCount === 1, "baseline round settled in a single pass");
await assertDeltas(before1, baseline.round.deltas, "baseline");
printReport(baseline.round, env.explorerTx);

const grossN = Number(BigInt(baseline.round.grossVolume)) / 1e6;
const settledN = Number(BigInt(baseline.round.settledVolume)) / 1e6;
console.log(
  `[e2e] baseline — $${grossN.toFixed(2)} of obligations settled with $${settledN.toFixed(2)} moving on-chain, in 1 transaction`,
);

// ── D-15 canonical liveness scenario ─────────────────────────────────────────
// stall → round n settles without the staller (pass 2) → unstall → round n+1
// settles their paper → consumed manifests are disjoint (never twice, CONS-04).
console.log("[e2e] liveness scenario: stall → exclude-and-settle → re-settle …");
const staller = env.personas[2]; // Oracle
const stallerLower = staller.account.address.toLowerCase();

const batch2 = await simulateTraffic(env.hub, env.personas, 40, {
  now: now(),
  chainId: env.chain.id,
  amountDivisor: divisor,
  startNonce: nonces,
});
coordinator.addIous(batch2);

// Pitfall 5: the staller's paper must outlive BOTH rounds — sign explicit
// IOUs touching the staller with far-future expiries so exclusion round n
// cannot silently expire them before round n+1 re-settles them.
const farExpiry = now() + 86_400n;
async function explicitIou(debtorIdx: number, creditorIdx: number, amount: bigint) {
  const debtor = env.personas[debtorIdx];
  const creditor = env.personas[creditorIdx];
  const pairKey = `${debtor.account.address}->${creditor.account.address}`;
  const nonce = (nonces.get(pairKey) ?? 0n) + 1n;
  nonces.set(pairKey, nonce);
  return signIou(
    env.hub,
    {
      debtor: debtor.account.address,
      creditor: creditor.account.address,
      amount: amount / divisor,
      nonce,
      expiry: farExpiry,
      ref: keccak256(toHex(`liveness ${debtor.name}->${creditor.name} #${nonce}`)) as Hex,
    },
    debtor.account,
    env.chain.id,
  );
}
coordinator.addIous([
  await explicitIou(2, 3, 300_000n), // staller owes Trader
  await explicitIou(1, 2, 250_000n), // Summarizer owes staller
]);

// Every open IOU touching the staller must be excluded in round n and
// consumed in round n+1.
const stallerIds = new Set(
  coordinator.openIous
    .filter(
      (s) =>
        s.iou.debtor.toLowerCase() === stallerLower ||
        s.iou.creditor.toLowerCase() === stallerLower,
    )
    .map((s) => s.id.toLowerCase()),
);
check(stallerIds.size > 0, `staller ${staller.name} has ${stallerIds.size} open IOU(s) before round n`);

// ── Round n: staller silent → exclusion round settles without them ──────────
staller.stalled = true;
const settledBeforeN = new Set(coordinator.settledIds);
const beforeN = await snapshot();

const roundN = await coordinator.runRound(now(), 2_000); // short window keeps e2e fast
check(roundN.outcome === "settled", `round n settled despite ${staller.name} stalling`);
if (roundN.outcome !== "settled") {
  console.error(`[e2e] FAIL — round n outcome=${roundN.outcome}`);
  env.anvil?.kill();
  process.exit(1);
}
check(roundN.round.passCount === 2, `round n took 2 passes (got ${roundN.round.passCount})`);
check(roundN.round.excluded.includes(stallerLower), `round n excluded ${staller.name}`);
check((roundN.round.deltas[stallerLower] ?? "0") === "0", `${staller.name} engine delta is 0 in round n`);

const afterN = await env.hubClient.collateral(staller.account.address);
check(afterN - beforeN.get(staller.account.address)! === 0n, `${staller.name} on-chain collateral delta is exactly 0n`);
await assertDeltas(beforeN, roundN.round.deltas, "round n");

const consumedN = new Set(
  [...coordinator.settledIds].filter((id) => !settledBeforeN.has(id)).map((id) => id.toLowerCase()),
);
check(
  [...stallerIds].every((id) => !consumedN.has(id)),
  `none of ${staller.name}'s ${stallerIds.size} IOU ids appear in round n's consumed manifest`,
);
printReport(roundN.round, env.explorerTx);

// ── Round n+1: staller back → their excluded paper settles cleanly ──────────
staller.stalled = false;
const settledBeforeN1 = new Set(coordinator.settledIds);
const beforeN1 = await snapshot();

const roundN1 = await coordinator.runRound(now(), 2_000);
check(roundN1.outcome === "settled", `round n+1 settled after ${staller.name} unstalled`);
if (roundN1.outcome !== "settled") {
  console.error(`[e2e] FAIL — round n+1 outcome=${roundN1.outcome}`);
  env.anvil?.kill();
  process.exit(1);
}
const consumedN1 = new Set(
  [...coordinator.settledIds].filter((id) => !settledBeforeN1.has(id)).map((id) => id.toLowerCase()),
);
check(
  [...stallerIds].every((id) => consumedN1.has(id)),
  `all ${stallerIds.size} previously excluded IOU ids are in round n+1's consumed manifest`,
);
check(
  [...consumedN].every((id) => !consumedN1.has(id)),
  `consumed manifests of rounds n and n+1 are disjoint — nothing settles twice (CONS-04)`,
);
await assertDeltas(beforeN1, roundN1.round.deltas, "round n+1");
printReport(roundN1.round, env.explorerTx);

// ── D-17 redemption scenario (MERK-03/MERK-04) ───────────────────────────────
// Dark debtor → creditor self-serve recovery from calldata-reconstructed
// proofs → permanent netting exclusion. Eligibility is asserted from the
// ON-CHAIN condition (lastRound/roundNonce reads over EXECUTED rounds) —
// coordinator counters are early warning only and never consulted (D-09).
console.log("[e2e] redemption scenario: dark debtor → creditor recovers from chain data …");
const redemptionCreditor = env.personas[3]; // Trader
const redemptionAmount = 300_000n / divisor; // fixed base units
const redemptionPairKey = `${staller.account.address}->${redemptionCreditor.account.address}`;
const redemptionNonce = (nonces.get(redemptionPairKey) ?? 0n) + 1n;
nonces.set(redemptionPairKey, redemptionNonce);
const redemptionIou = await signIou(
  env.hub,
  {
    debtor: staller.account.address,
    creditor: redemptionCreditor.account.address,
    amount: redemptionAmount,
    nonce: redemptionNonce,
    // L-convention boundary: expiry = now + L is the latest an honest signer
    // may pick, keeping every possibly-consuming round inside [expiry-L, expiry).
    expiry: now() + 86_400n,
    ref: keccak256(toHex(`redemption ${staller.name}->${redemptionCreditor.name} #${redemptionNonce}`)) as Hex,
  },
  staller.account,
  env.chain.id,
);
const redemptionId = redemptionIou.id.toLowerCase() as Hex;
coordinator.addIous([redemptionIou]);

// The debtor goes dark. K executed rounds must settle among the OTHER
// personas — an aborted round advances no on-chain clock, so each round below
// must genuinely execute (Pitfall 4).
staller.stalled = true;
const K: bigint = await env.pub.readContract({
  address: env.hub,
  abi: clearingHubV2Abi,
  functionName: "K",
});
const othersOnly = env.personas.filter((p) => p !== staller);
for (let i = 1n; i <= K; i++) {
  const staleTraffic = await simulateTraffic(env.hub, othersOnly, 30, {
    now: now(),
    chainId: env.chain.id,
    amountDivisor: divisor,
    startNonce: nonces,
  });
  coordinator.addIous(staleTraffic);
  const r = await coordinator.runRound(now(), 2_000);
  check(r.outcome === "settled", `staleness round ${i}/${K} executed without ${staller.name}`);
  if (r.outcome !== "settled") {
    console.error(`[e2e] FAIL — staleness round ${i} outcome=${r.outcome}`);
    env.anvil?.kill();
    process.exit(1);
  }
}

// On-chain staleness precondition, exactly as redeemIOU checks it:
// roundNonce >= lastRound[debtor] + K (lastRound is 1-based; 0 = never).
const nonceBeforeRedeem = await env.hubClient.roundNonce();
const lastRoundStaller = await env.hubClient.lastRound(staller.account.address);
check(
  nonceBeforeRedeem >= lastRoundStaller + K,
  `on-chain staleness holds: roundNonce ${nonceBeforeRedeem} >= lastRound ${lastRoundStaller} + K ${K}`,
);

// Creditor path: reconstruct every buffered manifest from executeRound
// calldata (never a coordinator endpoint) and submit redeemIOU themselves.
const debtorBefore = await env.hubClient.collateral(staller.account.address);
const creditorBefore = await env.hubClient.collateral(redemptionCreditor.account.address);
const proofs = await env.hubClient.prepareRedemptionProofs(redemptionIou.id);
const creditorWallet = createWalletClient({
  account: redemptionCreditor.account,
  chain: env.chain,
  transport: http(env.chain.rpcUrls.default.http[0]),
});
const redeemTx = await env.hubClient.redeemIOU(
  creditorWallet,
  redemptionIou.iou,
  redemptionIou.signature,
  proofs,
);
const redeemReceipt = await env.pub.waitForTransactionReceipt({ hash: redeemTx });
check(redeemReceipt.status === "success", `redeemIOU mined successfully (${redeemTx})`);

const debtorAfter = await env.hubClient.collateral(staller.account.address);
const creditorAfter = await env.hubClient.collateral(redemptionCreditor.account.address);
check(
  debtorBefore - debtorAfter === redemptionAmount,
  `${staller.name} collateral debited by exactly ${redemptionAmount} base units (${fmt(debtorBefore)} → ${fmt(debtorAfter)})`,
);
check(
  creditorAfter - creditorBefore === redemptionAmount,
  `${redemptionCreditor.name} collateral credited by exactly ${redemptionAmount} base units (${fmt(creditorBefore)} → ${fmt(creditorAfter)})`,
);
check(await env.hubClient.redeemed(redemptionIou.id), "redeemed(id) is true on-chain");

// Exclusivity tail (MERK-04/D-17): the debtor comes back, traffic touches
// them again, and the redeemed id must never appear in any consumed manifest —
// the coordinator's redeemedIds reconciliation drops it from netting forever.
staller.stalled = false;
const tailTraffic = await simulateTraffic(env.hub, env.personas, 40, {
  now: now(),
  chainId: env.chain.id,
  amountDivisor: divisor,
  startNonce: nonces,
});
coordinator.addIous(tailTraffic);
// Deterministic paper touching the returned debtor in both directions.
coordinator.addIous([
  await explicitIou(2, 4, 200_000n), // staller owes Auditor
  await explicitIou(0, 2, 150_000n), // Crawler owes staller
]);

const settledBeforeTail = new Set(coordinator.settledIds);
const beforeTail = await snapshot();
const tailRound = await coordinator.runRound(now(), 2_000);
check(tailRound.outcome === "settled", `tail round settled with ${staller.name} participating again`);
if (tailRound.outcome !== "settled") {
  console.error(`[e2e] FAIL — tail round outcome=${tailRound.outcome}`);
  env.anvil?.kill();
  process.exit(1);
}
check(stallerLower in tailRound.round.deltas, `${staller.name} participated in the tail round`);
const consumedTail = new Set(
  [...coordinator.settledIds].filter((id) => !settledBeforeTail.has(id)).map((id) => id.toLowerCase()),
);
check(!consumedTail.has(redemptionId), "redeemed id absent from the tail round's consumed manifest");
// Union across ALL rounds ever settled: settledIds is exactly that union, and
// the redeemed id must not be in it — it can never settle (disjointness idiom).
check(
  !coordinator.settledIds.has(redemptionId),
  "redeemed id absent from the union of every consumed manifest — it can never settle (MERK-04/D-17)",
);
await assertDeltas(beforeTail, tailRound.round.deltas, "tail round");
printReport(tailRound.round, env.explorerTx);

// ── PvP scenario (D-11, PVP-01): cross-currency both-or-neither ──────────────
// FX trades between the designated FX personas (Trader pays USDC, Oracle pays
// the rate-exact EURC back) mixed with ordinary same-currency flows on BOTH
// hubs settle in ONE atomic router transaction. Runs in BOTH modes: anvil at
// dollar scale, testnet at cents scale (faucet-funded 0.5-token collateral
// per hub — setup wires EURC funding/deposits the same as USDC).
{
  console.log("[e2e] pvp scenario: atomic cross-currency settlement (both-or-neither) …");

  // Pitfall-2 idiom applied to the router: prove the deployed router runs the
  // local PvPRouter artifact (metadata-tail compare). Hard check on anvil,
  // warning on testnet — same idiom as the hub check above.
  const routerCode = (await env.pub.getCode({ address: env.router })) ?? "0x";
  if (mode === "anvil") {
    check(tail(routerCode) === tail(pvpRouterBytecode), "router bytecode matches PvPRouter (metadata tail)");
  } else if (tail(routerCode) !== tail(pvpRouterBytecode)) {
    console.log(`[e2e] warn — testnet router metadata tail differs from local PvPRouter artifact (code hash ${keccak256(routerCode as Hex)})`);
  }

  const coordinatorEurc = new Coordinator(
    env.hubEurc,
    env.hubClientEurc,
    env.pub,
    env.personas,
    env.relayerWallet,
    env.chain.id,
  );
  // Per-pair nonce map for the EURC hub — kept separate from the USDC map so
  // each hub's (pair, nonce) sequence stays independently legible.
  const noncesEurc = new Map<string, bigint>();

  // Anvil keeps the sample quote (rate on a 1-USDC pair). Testnet expresses
  // the same ~0.9896 EURC/USDC rate on a 0.01-USDC pair so cents-scale FX
  // amounts stay cross-multiplication-exact (D-04: usdcAmount must have an
  // exact EURC counterpart at the rate).
  const quote: FxQuote =
    mode === "anvil"
      ? sampleQuote()
      : { amountIn: 10_000n, amountOut: 9_896n, timestamp: Math.floor(Date.now() / 1000) };
  const { fxNumerator, fxDenominator } = quoteToRate(quote);
  const oracle = env.personas[2]; // FX trader: earns USDC, pays EURC
  const trader = env.personas[3]; // FX trader: pays USDC, earns EURC

  const nextNonce = (map: Map<string, bigint>, debtor: Address, creditor: Address): bigint => {
    const key = `${debtor}->${creditor}`;
    const n = (map.get(key) ?? 0n) + 1n;
    map.set(key, n);
    return n;
  };

  /** One FX trade: Trader pays `usdcAmount` USDC to Oracle, Oracle pays the
   *  rate-exact EURC back — shared ref, per-hub pair-nonce sequences. */
  const fxPair = (usdcAmount: bigint) =>
    fxTradePair(
      { account: trader.account, address: trader.account.address },
      { account: oracle.account, address: oracle.account.address },
      usdcAmount,
      quote,
      {
        hubUsdc: env.hub,
        hubEurc: env.hubEurc,
        nonces: {
          usdc: nextNonce(nonces, trader.account.address, oracle.account.address),
          eurc: nextNonce(noncesEurc, oracle.account.address, trader.account.address),
        },
        expiry: now() + 3_600n,
        chainId: env.chain.id,
        now: now(),
      },
    );

  /** Ordinary same-currency IOU on `hub` — mixed flows exercise the
   *  Pitfall-6-safe design: rate checks are per FX pair, never per delta. */
  async function ordinaryIou(
    hub: Address,
    map: Map<string, bigint>,
    debtorIdx: number,
    creditorIdx: number,
    amount: bigint,
  ): Promise<SignedIou> {
    const debtor = env.personas[debtorIdx];
    const creditor = env.personas[creditorIdx];
    const pairKey = `${debtor.account.address}->${creditor.account.address}`;
    const nonce = (map.get(pairKey) ?? 0n) + 1n;
    map.set(pairKey, nonce);
    return signIou(
      hub,
      {
        debtor: debtor.account.address,
        creditor: creditor.account.address,
        amount,
        nonce,
        expiry: now() + 3_600n,
        ref: keccak256(toHex(`pvp ordinary ${hub} ${debtor.name}->${creditor.name} #${nonce}`)) as Hex,
      },
      debtor.account,
      env.chain.id,
    );
  }

  /** One consistent view per PvP attempt: every provider verifies against the
   *  SAME open-IOU snapshot, live per-hub nonces, and clock as the attempt. */
  interface PvPView {
    openU: SignedIou[];
    openE: SignedIou[];
    nonceU: bigint;
    nonceE: bigint;
    at: bigint;
  }
  const pvpView = async (): Promise<PvPView> => ({
    openU: coordinator.openIous,
    openE: coordinatorEurc.openIous,
    nonceU: await env.hubClient.roundNonce(),
    nonceE: await env.hubClientEurc.roundNonce(),
    at: now(),
  });

  /** Honest union member: re-verifies both legs, every FX pair, and the bundle
   *  digest from its own view — refuses as data on any mismatch (D-07). */
  const honestPvP =
    (persona: (typeof env.personas)[number], view: PvPView): PvPConsentProvider =>
    async (proposal, excluded) => {
      const verdict = verifyPvPProposal(
        env.router,
        env.hub,
        env.hubEurc,
        proposal,
        view.openU,
        view.openE,
        persona.account.address,
        {
          now: view.at,
          chainId: env.chain.id,
          usdc: {
            excluded,
            settledIds: coordinator.settledIds,
            redeemedIds: coordinator.redeemedIds,
            expectedRoundNonce: view.nonceU,
          },
          eurc: {
            excluded,
            settledIds: coordinatorEurc.settledIds,
            redeemedIds: coordinatorEurc.redeemedIds,
            expectedRoundNonce: view.nonceE,
          },
        },
      );
      if (!verdict.ok) return { kind: "refusal", reason: `${persona.name}: ${verdict.reason}` };
      const lc = persona.account.address.toLowerCase();
      const inU = proposal.usdcLeg.participants.some((p) => p.toLowerCase() === lc);
      const inE = proposal.eurcLeg.participants.some((p) => p.toLowerCase() === lc);
      return {
        kind: "consent" as const,
        ...(inU
          ? { usdcConsent: await signConsent(env.hub, proposal.usdcLeg, persona.account, env.chain.id) }
          : {}),
        ...(inE
          ? { eurcConsent: await signConsent(env.hubEurc, proposal.eurcLeg, persona.account, env.chain.id) }
          : {}),
        pvpSignature: await signPvPConsent(env.router, proposal, persona.account, env.chain.id),
      };
    };

  /** Providers for every persona (honest), with optional per-address overrides. */
  const pvpProviders = (view: PvPView, overrides?: Map<string, PvPConsentProvider>) => {
    const m = new Map<string, PvPConsentProvider>();
    for (const p of env.personas) m.set(p.account.address.toLowerCase(), honestPvP(p, view));
    for (const [k, v] of overrides ?? []) m.set(k, v);
    return m;
  };

  /** Engine deltas ("lowercase -> base-unit string") recomputed locally per
   *  hub — the e2e's own math, independent of anything the wrapper reports. */
  const localDeltas = (
    open: SignedIou[],
    leg: { settledIds: Set<Hex>; redeemedIds: Set<Hex> },
    at: bigint,
  ): Record<string, string> => {
    const result = net(open, { now: at, settledIds: leg.settledIds, redeemedIds: leg.redeemedIds });
    const deltas: Record<string, string> = {};
    result.participants.forEach((p, i) => {
      deltas[p.toLowerCase()] = result.deltas[i].toString();
    });
    return deltas;
  };

  // ── Positive: both legs settle atomically with FX-exact balances ───────────
  // Seed 2 FX trade pairs + ordinary same-currency flows on EACH hub, so both
  // legs mix FX and non-FX paper. Anvil keeps its dollar-scale sizes; testnet
  // trades cents (net FX exposure 0.05 USDC — well inside the 0.5 collateral).
  const [fxAmount1, fxAmount2] = mode === "anvil" ? [3_000_000n, 2_000_000n] : [30_000n, 20_000n];
  const fx1 = await fxPair(fxAmount1);
  const fx2 = await fxPair(fxAmount2);
  coordinator.addIous([
    fx1.usdc,
    fx2.usdc,
    await ordinaryIou(env.hub, nonces, 0, 1, 400_000n / divisor), // Crawler owes Summarizer (USDC, non-FX)
    await ordinaryIou(env.hub, nonces, 4, 0, 250_000n / divisor), // Auditor owes Crawler (USDC, non-FX)
  ]);
  coordinatorEurc.addIous([
    fx1.eurc,
    fx2.eurc,
    await ordinaryIou(env.hubEurc, noncesEurc, 1, 2, 200_000n / divisor), // Summarizer owes Oracle (EURC, non-FX)
    await ordinaryIou(env.hubEurc, noncesEurc, 3, 4, 150_000n / divisor), // Trader owes Auditor (EURC, non-FX)
  ]);

  const view1 = await pvpView();
  const beforeU1 = await snapshot();
  const beforeE1 = await snapshot(env.hubClientEurc);
  const expectedU = localDeltas(view1.openU, coordinator, view1.at);
  const expectedE = localDeltas(view1.openE, coordinatorEurc, view1.at);

  const pvpOut = await runPvPRound({
    usdc: { hub: env.hub, reader: env.hubClient, state: coordinator },
    eurc: { hub: env.hubEurc, reader: env.hubClientEurc, state: coordinatorEurc },
    router: env.router,
    routerClient: env.routerClient,
    relayerWallet: env.relayerWallet,
    pub: env.pub,
    providers: pvpProviders(view1),
    quote,
    windowMs: 2_000,
    now: view1.at,
    chainId: env.chain.id,
  });
  check(pvpOut.outcome === "settled", `pvp round settled atomically (outcome=${pvpOut.outcome})`);
  if (pvpOut.outcome !== "settled") {
    console.error(`[e2e] FAIL — pvp round outcome=${pvpOut.outcome}`);
    env.anvil?.kill();
    process.exit(1);
  }
  check(pvpOut.rounds.usdc.passCount === 1, "pvp round settled in a single pass");
  check((await env.hubClient.roundNonce()) === view1.nonceU + 1n, "USDC hub roundNonce advanced exactly 1");
  check((await env.hubClientEurc.roundNonce()) === view1.nonceE + 1n, "EURC hub roundNonce advanced exactly 1");
  await assertDeltas(beforeU1, expectedU, "pvp usdc leg");
  await assertDeltas(beforeE1, expectedE, "pvp eurc leg", env.hubClientEurc);
  check(
    pvpOut.rounds.usdc.pvp?.fxNumerator === fxNumerator.toString() &&
      pvpOut.rounds.eurc.pvp?.fxDenominator === fxDenominator.toString(),
    `both hubs' round records carry the PvP rate tag (${fxNumerator}/${fxDenominator})`,
  );

  const pvpReceipt = await env.pub.getTransactionReceipt({ hash: pvpOut.txHash });
  check(pvpReceipt.status === "success", `pvp router tx mined successfully (${pvpOut.txHash})`);
  // A3 record: Arc's block gas limit is unverified — this measured figure is
  // the evidence that demo-scale PvP fits comfortably under any plausible limit.
  console.log(`[e2e] pvp gasUsed=${pvpReceipt.gasUsed}`);
  console.log(`[e2e] pvp tx ${env.explorerTx(pvpOut.txHash)}`);
  printReport(pvpOut.rounds.usdc, env.explorerTx);
  printReport(pvpOut.rounds.eurc, env.explorerTx);

  // Negative scenarios stay anvil-only: (b) deliberately mines a REVERTING
  // router tx, and burning live faucet USDC on a known revert proves nothing
  // the forge revert matrix (T-04-25) and this anvil path don't already cover.
  if (mode === "anvil") {
    // ── Negative (a): consent sabotage — the FX trader withholds consent ─────
    // D-11 "withhold one consent": Trader refuses EVERY pass (a persistent
    // refusal — a plain one-pass stall would just get them excluded and, with
    // enough surviving flows, the round would settle without them: that is the
    // liveness feature, not the sabotage). Here the EURC leg is FX-only, so the
    // saboteur is structurally essential: excluding them from BOTH legs (D-09)
    // drops the EURC leg below quorum and the WHOLE bundle aborts — the fully
    // consentable USDC leg must not settle either.
    console.log("[e2e] pvp negative (a): FX trader withholds consent → neither settles …");
    const pairA = await fxPair(1_000_000n);
    coordinator.addIous([
      pairA.usdc,
      await ordinaryIou(env.hub, nonces, 0, 1, 300_000n), // Crawler owes Summarizer — USDC quorum survives exclusion
      await ordinaryIou(env.hub, nonces, 4, 0, 200_000n), // Auditor owes Crawler
    ]);
    coordinatorEurc.addIous([pairA.eurc]); // EURC leg is FX-only: the saboteur is essential

    const refuse: PvPConsentProvider = async () => ({
      kind: "refusal",
      reason: `${trader.name}: sabotage — withholding PvP consent in every pass (D-11)`,
    });
    const viewA = await pvpView();
    const snapUBeforeA = await snapshot();
    const snapEBeforeA = await snapshot(env.hubClientEurc);

    const outA = await runPvPRound({
      usdc: { hub: env.hub, reader: env.hubClient, state: coordinator },
      eurc: { hub: env.hubEurc, reader: env.hubClientEurc, state: coordinatorEurc },
      router: env.router,
      routerClient: env.routerClient,
      relayerWallet: env.relayerWallet,
      pub: env.pub,
      providers: pvpProviders(viewA, new Map([[trader.account.address.toLowerCase(), refuse]])),
      quote,
      windowMs: 2_000,
      now: viewA.at,
      chainId: env.chain.id,
    });
    check(outA.outcome === "aborted", `sabotaged bundle aborted (outcome=${outA.outcome})`);
    // Pitfall 7 (vacuous-pass trap): "neither settles" is asserted from CHAIN
    // state — both hub nonces and every persona's collateral on both hubs —
    // never from coordinator state alone, which would also pass if the tx was
    // never sent.
    check((await env.hubClient.roundNonce()) === viewA.nonceU, `USDC hub roundNonce unchanged (${viewA.nonceU})`);
    check((await env.hubClientEurc.roundNonce()) === viewA.nonceE, `EURC hub roundNonce unchanged (${viewA.nonceE})`);
    check(mapsEqual(snapUBeforeA, await snapshot()), "every persona's USDC-hub collateral unchanged (map-equal)");
    check(mapsEqual(snapEBeforeA, await snapshot(env.hubClientEurc)), "every persona's EURC-hub collateral unchanged (map-equal)");

    // ── Negative (b): forced on-chain revert — a mined tx that settles nothing
    // The (a) paper is all still open (nothing settled); with everyone honest it
    // builds a fully consented bundle. A recording submit captures the proposal
    // and signature sets WITHOUT broadcasting; one EURC leg signature is then
    // corrupted and the bundle submitted directly via the router client — the
    // EURC hub's BadSignature revert must bubble through the router and unwind
    // the USDC leg too, on a REAL node (complements the forge matrix, T-04-25).
    console.log("[e2e] pvp negative (b): corrupted EURC leg signature → mined revert, nothing settles …");
    const viewB = await pvpView();
    const captured: {
      proposal: PvPProposal;
      legSigs: { usdc: Hex[]; eurc: Hex[] };
      pvpSigs: Hex[];
    }[] = [];
    const outB = await attemptPvPRound({
      usdc: {
        ious: viewB.openU,
        hub: env.hub,
        expectedRoundNonce: viewB.nonceU,
        settledIds: coordinator.settledIds,
        redeemedIds: coordinator.redeemedIds,
      },
      eurc: {
        ious: viewB.openE,
        hub: env.hubEurc,
        expectedRoundNonce: viewB.nonceE,
        settledIds: coordinatorEurc.settledIds,
        redeemedIds: coordinatorEurc.redeemedIds,
      },
      router: env.router,
      fxNumerator,
      fxDenominator,
      providers: pvpProviders(viewB),
      windowMs: 2_000,
      now: viewB.at,
      chainId: env.chain.id,
      submit: async (proposal, legSigs, pvpSigs) => {
        captured.push({ proposal, legSigs, pvpSigs });
        return ("0x" + "00".repeat(32)) as Hex; // recorded, never broadcast
      },
    });
    check(
      outB.kind === "settled" && captured.length === 1,
      "recording submit captured a fully consented bundle without broadcasting",
    );
    if (captured.length !== 1) {
      console.error(`[e2e] FAIL — pvp negative (b) could not assemble a bundle (${outB.kind})`);
      env.anvil?.kill();
      process.exit(1);
    }

    // Corrupt one EURC leg signature: flip one nibble inside r — the structure
    // stays valid, ecrecover yields a wrong signer, the hub reverts BadSignature.
    const corruptSig = (sig: Hex): Hex =>
      (sig.slice(0, 20) + (sig[20] === "a" ? "b" : "a") + sig.slice(21)) as Hex;
    const { proposal: bundleB, legSigs: legSigsB, pvpSigs: pvpSigsB } = captured[0];
    const corruptedLegSigs = {
      usdc: legSigsB.usdc,
      eurc: legSigsB.eurc.map((s, i) => (i === 0 ? corruptSig(s) : s)),
    };
    const snapUBeforeB = await snapshot();
    const snapEBeforeB = await snapshot(env.hubClientEurc);
    const txB = await env.routerClient.executePvP(env.relayerWallet, bundleB, corruptedLegSigs, pvpSigsB);
    const receiptB = await env.pub.waitForTransactionReceipt({ hash: txB });
    check(receiptB.status === "reverted", `corrupted bundle mined with status reverted (${txB})`);
    check((await env.hubClient.roundNonce()) === viewB.nonceU, `USDC hub roundNonce unchanged after revert (${viewB.nonceU})`);
    check((await env.hubClientEurc.roundNonce()) === viewB.nonceE, `EURC hub roundNonce unchanged after revert (${viewB.nonceE})`);
    check(mapsEqual(snapUBeforeB, await snapshot()), "every persona's USDC-hub collateral unchanged after revert (map-equal)");
    check(mapsEqual(snapEBeforeB, await snapshot(env.hubClientEurc)), "every persona's EURC-hub collateral unchanged after revert (map-equal)");
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`[e2e] FAIL — ${failures} assertion(s) failed`);
  env.anvil?.kill();
  process.exit(1);
}
console.log(
  "[e2e] PASS — baseline settlement + liveness scenario (stall → exclude → re-settle → never twice) + redemption scenario (dark debtor → self-serve recovery → never nets again)" +
    (mode === "anvil"
      ? " + pvp both-or-neither (atomic settle · sabotage abort · forced-revert atomicity)"
      : " + pvp both-or-neither (atomic cross-currency settle, live on Arc Testnet)"),
);

env.anvil?.kill();
process.exit(0);
