/**
 * End-to-end: fund → deposit → ~100 IOUs → net → unanimous consent → one
 * on-chain settlement → assert balances match the engine's math exactly.
 *
 *   npm run e2e:anvil     (local, spawns anvil, deploys everything)
 *   npm run e2e:testnet   (Arc Testnet, needs .env — see README)
 */
import "./env.js";
import { setup } from "./setup.js";
import { simulateTraffic } from "./simulate.js";
import { Coordinator } from "./coordinator.js";
import { printReport, fmt } from "./report.js";

const mode = process.argv.includes("--anvil") ? "anvil" : "testnet";
const now = () => BigInt(Math.floor(Date.now() / 1000));

const env = await setup(mode);
console.log(`[e2e] mode=${mode} hub=${env.hub} token=${env.token}`);

const coordinator = new Coordinator(
  env.hub,
  env.hubClient,
  env.pub,
  env.personas,
  env.relayerWallet,
  env.chain.id,
);

// Snapshot collateral before.
const before = new Map<string, bigint>();
for (const p of env.personas) {
  before.set(p.account.address, await env.hubClient.collateral(p.account.address));
}

console.log("[e2e] simulating ~100 micropayment IOUs …");
const ious = await simulateTraffic(env.hub, env.personas, 105, {
  now: now(),
  chainId: env.chain.id,
  amountDivisor: mode === "anvil" ? 1n : 10n,
});
coordinator.addIous(ious);
console.log(`[e2e] ${ious.length} IOUs signed off-chain (0 transactions so far)`);

console.log("[e2e] running netting round …");
const roundResult = await coordinator.runRound(now());
if (roundResult.outcome !== "settled") {
  console.error(`[e2e] FAIL — round did not settle (${roundResult.outcome}): ${roundResult.reason}`);
  process.exit(1);
}
const round = roundResult.round;

// Assert: on-chain balance movement == engine deltas, to the base unit.
let mismatches = 0;
for (const p of env.personas) {
  const after = await env.hubClient.collateral(p.account.address);
  const actual = after - before.get(p.account.address)!;
  const expected = BigInt(round.deltas[p.account.address.toLowerCase()] ?? "0");
  const ok = actual === expected;
  if (!ok) mismatches++;
  console.log(
    `[e2e] ${p.emoji} ${p.name.padEnd(11)} collateral ${fmt(before.get(p.account.address)!)} → ${fmt(after)} (Δ ${fmt(actual)}) ${ok ? "✓" : `✗ expected ${fmt(expected)}`}`,
  );
}

printReport(round, env.explorerTx);

const grossN = Number(BigInt(round.grossVolume)) / 1e6;
const settledN = Number(BigInt(round.settledVolume)) / 1e6;
console.log(
  `[e2e] PASS — $${grossN.toFixed(2)} of obligations settled with $${settledN.toFixed(2)} moving on-chain, in 1 transaction`,
);

if (mismatches > 0) {
  console.error("[e2e] FAIL — balance deltas disagree with engine output");
  process.exit(1);
}

env.anvil?.kill();
process.exit(0);
