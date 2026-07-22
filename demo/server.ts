/**
 * Demo server: hosts the dashboard and drives the swarm.
 *
 *   npm run demo            → testnet (needs .env, deployed hub)
 *   npm run demo -- --anvil → fully local
 *
 * Endpoints:
 *   GET  /            dashboard
 *   GET  /state       full JSON state for the dashboard
 *   POST /simulate    generate a burst of ~35 signed IOUs
 *   POST /round       run a netting round on-chain
 */
import "./env.js";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./setup.js";
import { simulateTraffic } from "./simulate.js";
import { Coordinator } from "./coordinator.js";
import { printReport } from "./report.js";

const mode = process.argv.includes("--anvil") ? "anvil" : "testnet";
const now = () => BigInt(Math.floor(Date.now() / 1000));
const PORT = Number(process.env.PORT ?? 4402);

console.log(`[demo] setting up (${mode}) …`);
const env = await setup(mode);
console.log(`[demo] hub=${env.hub} token=${env.token} chain=${env.chain.id}`);

const coordinator = new Coordinator(
  env.hub,
  env.hubClient,
  env.pub,
  env.personas,
  env.relayerWallet,
  env.chain.id,
);

const nonces = new Map<string, bigint>();
let simulating = false;

const dashboardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "dashboard.html",
);

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard.html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(dashboardPath));
      return;
    }
    if (req.method === "GET" && req.url === "/state") {
      const state = await coordinator.state(now());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...state,
          mode,
          hub: env.hub,
          token: env.token,
          chainId: env.chain.id,
          explorerBase: env.chain.id === 5042002 ? "https://testnet.arcscan.app" : null,
          simulating,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/simulate") {
      if (!simulating) {
        simulating = true;
        // fire-and-forget so the dashboard can watch IOUs stream in
        (async () => {
          try {
            const batch = await simulateTraffic(env.hub, env.personas, 35, {
              now: now(),
              chainId: env.chain.id,
              amountDivisor: mode === "anvil" ? 1n : 10n,
              startNonce: nonces,
            });
            for (const iou of batch) {
              coordinator.addIous([iou]);
              await new Promise((r) => setTimeout(r, 120)); // visible streaming
            }
          } finally {
            simulating = false;
          }
        })();
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/round") {
      const round = await coordinator.runRound(now());
      printReport(round, env.explorerTx);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(round));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
});

server.listen(PORT, () => {
  console.log(`[demo] dashboard: http://localhost:${PORT}/`);
  console.log(`[demo] press the buttons there, or:`);
  console.log(`[demo]   curl -X POST localhost:${PORT}/simulate`);
  console.log(`[demo]   curl -X POST localhost:${PORT}/round`);
});
