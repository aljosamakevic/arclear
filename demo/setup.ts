import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseUnits,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { arcTestnet, MIN_MAX_FEE_PER_GAS, USDC } from "../src/domain.js";
import { HubClient, PvPRouterClient } from "../src/client.js";
import { clearingHubV2Abi, clearingHubV2Bytecode } from "../src/abi/ClearingHubV2.js";
import { pvpRouterBytecode, pvpRouterAbi } from "../src/abi/PvPRouter.js";
import { mockTokenAbi, mockTokenBytecode } from "./mockToken.js";
import { agents, relayer, ANVIL_MNEMONIC, type AgentPersona } from "./agents.js";

export interface DemoEnv {
  chain: Chain;
  pub: PublicClient;
  /** USDC-side ClearingHubV2 (the original single-hub surface, unchanged). */
  hub: Address;
  /** USDC token (mock on anvil; the native-USDC ERC-20 facade on Arc). */
  token: Address;
  /** Typed client for the USDC hub. */
  hubClient: HubClient;
  /** EURC stand-in token (second mock on anvil; live EURC on Arc). */
  tokenEurc: Address;
  /** EURC-side ClearingHubV2 — per-hub state is strictly separate (Pitfall 3). */
  hubEurc: Address;
  /** Typed client for the EURC hub — never share reads with hubClient. */
  hubClientEurc: HubClient;
  /** PvPRouter bound at deploy time to exactly (hub, hubEurc). */
  router: Address;
  /** Typed router client — formula-gas executePvP submission. */
  routerClient: PvPRouterClient;
  personas: AgentPersona[];
  relayerWallet: WalletClient;
  anvil?: ChildProcess;
  explorerTx: (hash: string) => string;
}

const anvilChain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const ANVIL_COLLATERAL = parseUnits("20", 6);
const TESTNET_COLLATERAL = parseUnits("0.5", 6); // sized for a faucet-funded deployer

/**
 * Approve + deposit collateral for every persona on ONE (token, hub) pair.
 * Parameterized per hub so the dual-hub world keeps per-hub state strictly
 * separate (Pitfall 3): call once for the USDC pair, once for the EURC pair.
 */
async function depositAll(
  env: { chain: Chain; pub: PublicClient; personas: AgentPersona[] },
  target: { token: Address; hub: Address },
  collateralAmount: bigint,
) {
  for (const p of env.personas) {
    const wallet = createWalletClient({
      account: p.account,
      chain: env.chain,
      transport: http(env.chain.rpcUrls.default.http[0]),
    });
    // Explicit gas limits matter on Arc: USDC is both the gas token and the
    // ERC-20, so letting estimation probe with huge limits reserves the whole
    // balance for gas and makes the simulated token transfer fail.
    const fee =
      env.chain.id === arcTestnet.id
        ? { maxFeePerGas: MIN_MAX_FEE_PER_GAS, gas: 200_000n }
        : {};
    const approveHash = await wallet.writeContract({
      address: target.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [target.hub, collateralAmount],
      chain: env.chain,
      account: p.account,
      ...fee,
    });
    await env.pub.waitForTransactionReceipt({ hash: approveHash });
    const depositHash = await wallet.writeContract({
      address: target.hub,
      abi: clearingHubV2Abi,
      functionName: "deposit",
      args: [collateralAmount],
      chain: env.chain,
      account: p.account,
      ...fee,
    });
    await env.pub.waitForTransactionReceipt({ hash: depositHash });
  }
}

/**
 * Local mode: spawn anvil, deploy a dual-hub world — two mock tokens (USDC +
 * EURC stand-ins), two ClearingHubV2s, one PvPRouter bound to both — then
 * mint both tokens to every agent and deposit collateral on BOTH hubs.
 */
export async function setupAnvil(): Promise<DemoEnv> {
  const anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));

  const chain = anvilChain;
  const rpcUrl = chain.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain, transport: http() });
  const personas = agents(ANVIL_MNEMONIC);
  const deployer = relayer(ANVIL_MNEMONIC);
  const wallet = createWalletClient({ account: deployer, chain, transport: http() });

  /** Deploy one mock token; returns its address. */
  const deployToken = async (): Promise<Address> => {
    const tx = await wallet.deployContract({
      abi: mockTokenAbi,
      bytecode: mockTokenBytecode,
      account: deployer,
      chain,
    });
    return (await pub.waitForTransactionReceipt({ hash: tx })).contractAddress!;
  };

  /** Deploy one ClearingHubV2 bound to `tokenAddr`; returns its address. */
  const deployHub = async (tokenAddr: Address): Promise<Address> => {
    const tx = await wallet.deployContract({
      abi: clearingHubV2Abi,
      bytecode: clearingHubV2Bytecode,
      // K/RING/MAX_IOU_LIFETIME: the same UNCALIBRATED defaults as DeployV2.s.sol.
      args: [tokenAddr, 3n, 16n, 86_400n],
      account: deployer,
      chain,
    });
    return (await pub.waitForTransactionReceipt({ hash: tx })).contractAddress!;
  };

  const token = await deployToken();
  const hub = await deployHub(token);
  const tokenEurc = await deployToken();
  const hubEurc = await deployHub(tokenEurc);

  // Router immutables pin the exact hub pair — the anvil world mirrors the
  // testnet deployment shape one-for-one.
  const routerTx = await wallet.deployContract({
    abi: pvpRouterAbi,
    bytecode: pvpRouterBytecode,
    args: [hub, hubEurc],
    account: deployer,
    chain,
  });
  const router = (await pub.waitForTransactionReceipt({ hash: routerTx })).contractAddress!;

  for (const p of personas) {
    for (const t of [token, tokenEurc]) {
      const mintHash = await wallet.writeContract({
        address: t,
        abi: mockTokenAbi,
        functionName: "mint",
        args: [p.account.address, parseUnits("100", 6)],
        account: deployer,
        chain,
      });
      await pub.waitForTransactionReceipt({ hash: mintHash });
    }
  }

  const env = {
    chain,
    pub,
    hub,
    token,
    hubClient: new HubClient(hub, pub),
    tokenEurc,
    hubEurc,
    hubClientEurc: new HubClient(hubEurc, pub),
    router,
    routerClient: new PvPRouterClient(router, rpcUrl),
    personas,
    relayerWallet: wallet,
  };
  // Pitfall 3: one depositAll call per (token, hub) pair — per-hub state stays separate.
  await depositAll(env, { token, hub }, ANVIL_COLLATERAL);
  await depositAll(env, { token: tokenEurc, hub: hubEurc }, ANVIL_COLLATERAL);
  return { ...env, anvil, explorerTx: (h) => h };
}

/**
 * Testnet mode: attach to a deployed V2 hub (HUB_V2_USDC env), derive agents
 * from AGENT_MNEMONIC, top up their USDC from the deployer if needed. On Arc,
 * USDC is the native gas token with an ERC-20 facade, so one transfer funds
 * both gas and collateral. The v1 HUB_USDC key stays reserved for Arclear Net.
 */
export async function setupTestnet(): Promise<DemoEnv> {
  const hub = process.env.HUB_V2_USDC as Address | undefined;
  const hubEurc = process.env.HUB_V2_EURC as Address | undefined;
  const router = process.env.PVP_ROUTER as Address | undefined;
  const mnemonic = process.env.AGENT_MNEMONIC;
  const deployerPk = process.env.DEPLOYER_PK;
  if (!hub) throw new Error("HUB_V2_USDC not set — deploy ClearingHubV2 first (see README)");
  if (!hubEurc) {
    throw new Error("HUB_V2_EURC not set — deploy the EURC ClearingHubV2 first (see README)");
  }
  if (!router) throw new Error("PVP_ROUTER not set — deploy PvPRouter first (see README)");
  if (!mnemonic) throw new Error("AGENT_MNEMONIC not set");
  if (!deployerPk) throw new Error("DEPLOYER_PK not set");

  const chain = arcTestnet;
  const pub = createPublicClient({ chain, transport: http() });
  const personas = agents(mnemonic);
  const { privateKeyToAccount } = await import("viem/accounts");
  const deployer = privateKeyToAccount(deployerPk as `0x${string}`);
  const wallet = createWalletClient({ account: deployer, chain, transport: http() });
  const hubClient = new HubClient(hub, pub);
  const hubClientEurc = new HubClient(hubEurc, pub);
  const routerClient = new PvPRouterClient(router);

  const token = await hubClient.token();
  // EURC on Arc is a plain ERC-20 (not the gas token) — agents' EURC funding
  // and deposits are the deploy-phase concern (04-06 e2e:testnet), same as
  // the USDC idempotent-deposit loop below covers the USDC side.
  const tokenEurc = await hubClientEurc.token();

  // Top up each agent to ≥ 25 USDC (collateral + gas headroom).
  for (const p of personas) {
    const bal = await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [p.account.address],
    });
    const target = parseUnits("0.7", 6);
    if (bal < target) {
      const h = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [p.account.address, target - bal],
        account: deployer,
        chain,
        maxFeePerGas: MIN_MAX_FEE_PER_GAS,
        gas: 80_000n,
      });
      await pub.waitForTransactionReceipt({ hash: h });
    }
  }

  const env = {
    chain,
    pub,
    hub,
    token,
    hubClient,
    tokenEurc,
    hubEurc,
    hubClientEurc,
    router,
    routerClient,
    personas,
    relayerWallet: wallet,
  };

  // Deposit collateral only for agents that don't have any yet (idempotent).
  for (const p of personas) {
    const c = await hubClient.collateral(p.account.address);
    if (c === 0n) {
      await depositAll({ ...env, personas: [p] }, { token, hub }, TESTNET_COLLATERAL);
    }
  }

  return {
    ...env,
    explorerTx: (h) => `https://testnet.arcscan.app/tx/${h}`,
  };
}

export async function setup(mode: "anvil" | "testnet"): Promise<DemoEnv> {
  return mode === "anvil" ? setupAnvil() : setupTestnet();
}

export { USDC };
