/**
 * End-to-end: fund → deposit → ~100 IOUs → net → unanimous consent → one
 * on-chain settlement → assert balances match the engine's math exactly.
 * Then the D-15 canonical liveness scenario: stall a member → the round
 * settles without them (pass 2) → their IOUs settle cleanly next round →
 * nothing ever settles twice (CONS-04).
 *
 *   npm run e2e:anvil     (local, spawns anvil, deploys everything)
 *   npm run e2e:testnet   (Arc Testnet, needs .env — see README)
 */
import "./env.js";
import { keccak256, toHex, type Hex } from "viem";
import { setup } from "./setup.js";
import { simulateTraffic } from "./simulate.js";
import { Coordinator } from "./coordinator.js";
import { printReport, fmt } from "./report.js";
import { signIou } from "../src/iou.js";
import { clearingHubV2Bytecode } from "../src/abi/ClearingHubV2.js";
import { clearingHubBytecode } from "../src/abi/ClearingHub.js";

const mode = process.argv.includes("--anvil") ? "anvil" : "testnet";
const now = () => BigInt(Math.floor(Date.now() / 1000));
const divisor = mode === "anvil" ? 1n : 10n;

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

/** Snapshot on-chain collateral for every persona. */
async function snapshot(): Promise<Map<string, bigint>> {
  const m = new Map<string, bigint>();
  for (const p of env.personas) {
    m.set(p.account.address, await env.hubClient.collateral(p.account.address));
  }
  return m;
}

/** Assert every persona's on-chain movement equals the round's engine delta, to the base unit. */
async function assertDeltas(before: Map<string, bigint>, deltas: Record<string, string>, label: string) {
  for (const p of env.personas) {
    const after = await env.hubClient.collateral(p.account.address);
    const actual = after - before.get(p.account.address)!;
    const expected = BigInt(deltas[p.account.address.toLowerCase()] ?? "0");
    check(
      actual === expected,
      `${label}: ${p.name.padEnd(11)} ${fmt(before.get(p.account.address)!)} → ${fmt(after)} (Δ ${fmt(actual)})`,
    );
  }
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

// ── Verdict ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`[e2e] FAIL — ${failures} assertion(s) failed`);
  env.anvil?.kill();
  process.exit(1);
}
console.log("[e2e] PASS — baseline settlement + liveness scenario (stall → exclude → re-settle → never twice)");

env.anvil?.kill();
process.exit(0);
