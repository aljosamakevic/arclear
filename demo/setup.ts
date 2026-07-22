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
import { HubClient } from "../src/client.js";
import { clearingHubAbi, clearingHubBytecode } from "../src/abi/ClearingHub.js";
import { mockTokenAbi, mockTokenBytecode } from "./mockToken.js";
import { agents, relayer, ANVIL_MNEMONIC, type AgentPersona } from "./agents.js";

export interface DemoEnv {
  chain: Chain;
  pub: PublicClient;
  hub: Address;
  token: Address;
  hubClient: HubClient;
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

async function depositAll(env: Omit<DemoEnv, "explorerTx" | "anvil">, collateralAmount: bigint) {
  for (const p of env.personas) {
    const wallet = createWalletClient({
      account: p.account,
      chain: env.chain,
      transport: http(env.chain.rpcUrls.default.http[0]),
    });
    const fee = env.chain.id === arcTestnet.id ? { maxFeePerGas: MIN_MAX_FEE_PER_GAS } : {};
    const approveHash = await wallet.writeContract({
      address: env.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [env.hub, collateralAmount],
      chain: env.chain,
      account: p.account,
      ...fee,
    });
    await env.pub.waitForTransactionReceipt({ hash: approveHash });
    const depositHash = await wallet.writeContract({
      address: env.hub,
      abi: clearingHubAbi,
      functionName: "deposit",
      args: [collateralAmount],
      chain: env.chain,
      account: p.account,
      ...fee,
    });
    await env.pub.waitForTransactionReceipt({ hash: depositHash });
  }
}

/** Local mode: spawn anvil, deploy mock token + hub, fund and deposit. */
export async function setupAnvil(): Promise<DemoEnv> {
  const anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));

  const chain = anvilChain;
  const pub = createPublicClient({ chain, transport: http() });
  const personas = agents(ANVIL_MNEMONIC);
  const deployer = relayer(ANVIL_MNEMONIC);
  const wallet = createWalletClient({ account: deployer, chain, transport: http() });

  const tokenTx = await wallet.deployContract({
    abi: mockTokenAbi,
    bytecode: mockTokenBytecode,
    account: deployer,
    chain,
  });
  const token = (await pub.waitForTransactionReceipt({ hash: tokenTx })).contractAddress!;
  const hubTx = await wallet.deployContract({
    abi: clearingHubAbi,
    bytecode: clearingHubBytecode,
    args: [token],
    account: deployer,
    chain,
  });
  const hub = (await pub.waitForTransactionReceipt({ hash: hubTx })).contractAddress!;

  for (const p of personas) {
    const mintHash = await wallet.writeContract({
      address: token,
      abi: mockTokenAbi,
      functionName: "mint",
      args: [p.account.address, parseUnits("100", 6)],
      account: deployer,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash: mintHash });
  }

  const env = {
    chain,
    pub,
    hub,
    token,
    hubClient: new HubClient(hub, pub),
    personas,
    relayerWallet: wallet,
  };
  await depositAll(env, ANVIL_COLLATERAL);
  return { ...env, anvil, explorerTx: (h) => h };
}

/**
 * Testnet mode: attach to a deployed hub (HUB_USDC env), derive agents from
 * AGENT_MNEMONIC, top up their USDC from the deployer if needed. On Arc, USDC
 * is the native gas token with an ERC-20 facade, so one transfer funds both
 * gas and collateral.
 */
export async function setupTestnet(): Promise<DemoEnv> {
  const hub = process.env.HUB_USDC as Address | undefined;
  const mnemonic = process.env.AGENT_MNEMONIC;
  const deployerPk = process.env.DEPLOYER_PK;
  if (!hub) throw new Error("HUB_USDC not set — deploy first (see README)");
  if (!mnemonic) throw new Error("AGENT_MNEMONIC not set");
  if (!deployerPk) throw new Error("DEPLOYER_PK not set");

  const chain = arcTestnet;
  const pub = createPublicClient({ chain, transport: http() });
  const personas = agents(mnemonic);
  const { privateKeyToAccount } = await import("viem/accounts");
  const deployer = privateKeyToAccount(deployerPk as `0x${string}`);
  const wallet = createWalletClient({ account: deployer, chain, transport: http() });
  const hubClient = new HubClient(hub, pub);

  const token = await hubClient.token();

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
      });
      await pub.waitForTransactionReceipt({ hash: h });
    }
  }

  const env = { chain, pub, hub, token, hubClient, personas, relayerWallet: wallet };

  // Deposit collateral only for agents that don't have any yet (idempotent).
  for (const p of personas) {
    const c = await hubClient.collateral(p.account.address);
    if (c === 0n) {
      await depositAll({ ...env, personas: [p] }, TESTNET_COLLATERAL);
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
