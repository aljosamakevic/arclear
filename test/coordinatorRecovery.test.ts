import { describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { numberToHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { signIou } from "../src/iou.js";
import type { HubClient } from "../src/client.js";
import type { SignedIou } from "../src/types.js";
import type { AgentPersona } from "../demo/agents.js";
import { Coordinator, PENDING_MAX_BLOCKS } from "../demo/coordinator.js";
import { runPvPRound, type PvPLegDeps, type PvPRunDeps } from "../demo/pvp.js";

/**
 * C-CR-02 / C-CR-03 regressions.
 *
 * CR-02: one transient broadcast failure (a 429 out of `executeRound` itself)
 * left `pendingSubmission` set with no txHash and the on-chain nonce unmoved.
 * `reconcilePendingSubmission` had no age bound, no relayer discriminator and
 * no reset path, so every later round returned "previous submission still
 * unconfirmed" — forever, with no operator recovery short of a redeploy.
 *
 * CR-03: `recordPendingSubmission` was a bare assignment, so a second
 * submitter (a PvP leg) silently discarded the only copy of the data needed to
 * fold a mined-but-receipt-lost round. ClearingHubV2.executeRound gates only
 * on `redeemed[]` — there is NO on-chain settled-id nullifier — so losing that
 * record re-nets settled paper into a round that succeeds. Real double
 * settlement.
 */

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const MNEMONIC = "test test test test test test test test test test test junk";
const NOW = 1_800_000_000n;
const EXPIRY = NOW + 3_600n;
const WINDOW_MS = 50;

const personas: AgentPersona[] = [
  {
    name: "A",
    emoji: "a",
    role: "test",
    account: mnemonicToAccount(MNEMONIC, { addressIndex: 1 }),
    stalled: false,
  },
  {
    name: "B",
    emoji: "b",
    role: "test",
    account: mnemonicToAccount(MNEMONIC, { addressIndex: 2 }),
    stalled: false,
  },
];
const relayerAddress = mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).address;

/** One IOU per direction so every round has two participants and real paper. */
async function paper(seed: number): Promise<SignedIou[]> {
  const [a, b] = personas;
  return [
    await signIou(
      HUB,
      {
        debtor: a.account.address,
        creditor: b.account.address,
        amount: 1_000_000n,
        nonce: BigInt(seed),
        expiry: EXPIRY,
        ref: numberToHex(seed, { size: 32 }),
      },
      a.account,
      undefined,
      { now: NOW },
    ),
    await signIou(
      HUB,
      {
        debtor: b.account.address,
        creditor: a.account.address,
        amount: 400_000n,
        nonce: BigInt(seed + 1000),
        expiry: EXPIRY,
        ref: numberToHex(seed + 1000, { size: 32 }),
      },
      b.account,
      undefined,
      { now: NOW },
    ),
  ];
}

/**
 * Minimal chain the Coordinator can be driven against: a monotonic roundNonce
 * that only a settled executeRound advances, RoundExecuted logs carrying the
 * signed digest as `roundHash`, and the relayer's latest/pending transaction
 * counts.
 */
function fakeChain() {
  const chain = {
    nonce: 0n,
    block: 100n,
    executed: [] as { roundNonce: bigint; roundHash: Hex; block: bigint }[],
    relayerLatest: 3,
    relayerPending: 3,
    /** Set to make the next executeRound behave badly. */
    broadcast: "ok" as "ok" | "throw" | "lose-receipt",
    /** Digest/ids of every executeRound the coordinator handed us. */
    submissions: [] as { digest: Hex; consumedIds: Hex[] }[],
  };

  const hubClient = {
    earliestBlock: 0n,
    roundNonce: async () => chain.nonce,
    collateral: async () => 10_000_000n,
    executeRound: async (
      _w: WalletClient,
      proposal: { roundNonce: bigint; digest: Hex; consumed: { id: Hex }[] },
    ) => {
      // v3: the proposal carries party-bound entries, not a bare id list. The
      // stub still records raw ids because that is what settledIds is keyed on
      // and what these disjointness assertions compare.
      chain.submissions.push({
        digest: proposal.digest,
        consumedIds: proposal.consumed.map((c) => c.id),
      });
      if (chain.broadcast === "throw") {
        // The audit's exact shape: the call fails before any transaction
        // exists, so nothing can ever mine at this nonce.
        throw new Error("HTTP request failed. Status: 429");
      }
      const txHash = numberToHex(chain.submissions.length, { size: 32 });
      if (chain.broadcast === "lose-receipt") {
        // Broadcast succeeded and MINED — only the receipt wait died.
        chain.executed.push({
          roundNonce: proposal.roundNonce,
          roundHash: proposal.digest,
          block: chain.block,
        });
        chain.nonce = proposal.roundNonce + 1n;
        return txHash;
      }
      chain.executed.push({
        roundNonce: proposal.roundNonce,
        roundHash: proposal.digest,
        block: chain.block,
      });
      chain.nonce = proposal.roundNonce + 1n;
      return txHash;
    },
  } as unknown as HubClient;

  const pub = {
    getBlockNumber: async () => chain.block,
    getTransactionCount: async ({ blockTag }: { address: Address; blockTag: string }) =>
      blockTag === "pending" ? chain.relayerPending : chain.relayerLatest,
    getTransactionReceipt: async () => {
      throw new Error("not found");
    },
    waitForTransactionReceipt: async () => {
      if (chain.broadcast === "lose-receipt") throw new Error("socket hang up");
      return { status: "success" };
    },
    getContractEvents: async ({
      eventName,
      args,
      fromBlock,
    }: {
      eventName: string;
      args?: { roundNonce?: bigint };
      fromBlock: bigint;
    }) => {
      if (eventName !== "RoundExecuted") return [];
      return chain.executed
        .filter(
          (e) =>
            e.block >= fromBlock &&
            (args?.roundNonce === undefined || e.roundNonce === args.roundNonce),
        )
        .map((e) => ({ args: { roundNonce: e.roundNonce, roundHash: e.roundHash } }));
    },
  } as unknown as PublicClient;

  const wallet = { account: { address: relayerAddress } } as unknown as WalletClient;
  return { chain, hubClient, pub, wallet };
}

function mkCoordinator(f: ReturnType<typeof fakeChain>): Coordinator {
  return new Coordinator(HUB, f.hubClient, f.pub, personas, f.wallet, undefined, {
    consentWindowMs: WINDOW_MS,
  });
}

describe("CR-02: a transient broadcast failure never wedges the coordinator", () => {
  it("clears the record when the relayer's mempool proves nothing can mine", async () => {
    const f = fakeChain();
    const c = mkCoordinator(f);
    c.addIous(await paper(1));

    // Round 1: executeRound itself throws (429). No transaction exists, the
    // nonce never moved — but the record was taken before the broadcast.
    f.chain.broadcast = "throw";
    await expect(c.runRound(NOW, WINDOW_MS)).rejects.toThrow(/429/);
    expect(c.hasPendingSubmission()).toBe(true);

    // Round 2: pending == latest, so no transaction of ours can still mine.
    // Pre-fix this returned "previous submission still unconfirmed" forever.
    f.chain.broadcast = "ok";
    const r2 = await c.runRound(NOW, WINDOW_MS);
    expect(r2.outcome).toBe("settled");
    expect(c.hasPendingSubmission()).toBe(false);
    expect(f.chain.nonce).toBe(1n);
  });

  it("stays blocked while one of OUR transactions could still mine", async () => {
    const f = fakeChain();
    const c = mkCoordinator(f);
    c.addIous(await paper(1));

    f.chain.broadcast = "throw";
    f.chain.relayerPending = f.chain.relayerLatest + 1; // something of ours is queued
    await expect(c.runRound(NOW, WINDOW_MS)).rejects.toThrow(/429/);

    f.chain.broadcast = "ok";
    const r2 = await c.runRound(NOW, WINDOW_MS);
    expect(r2.outcome).toBe("aborted");
    if (r2.outcome !== "aborted") return;
    expect(r2.reason).toMatch(/still unconfirmed/);
    expect(f.chain.nonce).toBe(0n); // nothing was assembled
  });

  it("ages an unresolvable record out of the blocking slot instead of wedging", async () => {
    const f = fakeChain();
    const c = mkCoordinator(f);
    c.addIous(await paper(1));

    // A submission that neither mines nor dies: the relayer keeps a pending
    // transaction, so the mempool discriminator cannot clear it.
    f.chain.broadcast = "throw";
    f.chain.relayerPending = f.chain.relayerLatest + 1;
    await expect(c.runRound(NOW, WINDOW_MS)).rejects.toThrow(/429/);

    // One block short of the bound: still blocked (the guard is a bound, not a
    // free pass).
    f.chain.block += PENDING_MAX_BLOCKS;
    f.chain.broadcast = "ok";
    const early = await c.runRound(NOW, WINDOW_MS);
    expect(early.outcome).toBe("aborted");

    // Past the bound: rounds resume. Pre-fix this returned "previous
    // submission still unconfirmed" for every round, forever.
    f.chain.block += 1n;
    const late = await c.runRound(NOW, WINDOW_MS);
    expect(late.outcome).toBe("settled");
    expect(f.chain.nonce).toBe(1n);
    expect(c.lastError).toMatch(/unconfirmed after 50 blocks/);
  });

  it("an aged-out submission that finally mines is still folded — manifests stay disjoint", async () => {
    const f = fakeChain();
    const c = mkCoordinator(f);
    c.addIous(await paper(1));

    // Round 1 is broadcast into limbo and ages out of the blocking slot.
    f.chain.broadcast = "throw";
    f.chain.relayerPending = f.chain.relayerLatest + 1;
    await expect(c.runRound(NOW, WINDOW_MS)).rejects.toThrow(/429/);
    const stuck = f.chain.submissions[0];
    f.chain.block += PENDING_MAX_BLOCKS + 1n;

    // Round 2 also fails to broadcast, so the nonce is still unmoved and
    // round 1's record is now on the unresolved list.
    await expect(c.runRound(NOW, WINDOW_MS)).rejects.toThrow(/429/);
    expect(c.hasPendingSubmission()).toBe(true);
    expect(f.chain.nonce).toBe(0n);

    // Round 1's transaction escapes the mempool and mines at last.
    f.chain.executed.push({ roundNonce: 0n, roundHash: stuck.digest, block: f.chain.block });
    f.chain.nonce = 1n;
    f.chain.broadcast = "ok";
    f.chain.relayerPending = f.chain.relayerLatest;

    c.addIous(await paper(50));
    const r = await c.runRound(NOW, WINDOW_MS);
    expect(r.outcome).toBe("settled");

    // The settled paper was folded from the unresolved record's digest, so it
    // cannot reappear — ClearingHubV2 would have happily settled it twice.
    const settled = new Set(stuck.consumedIds.map((i) => i.toLowerCase()));
    expect(settled.size).toBeGreaterThan(0);
    for (const id of settled) expect(c.settledIds.has(id as Hex)).toBe(true);
    const latest = f.chain.submissions[f.chain.submissions.length - 1];
    expect(latest.consumedIds.map((i) => i.toLowerCase()).filter((i) => settled.has(i))).toEqual([]);
    expect(c.hasPendingSubmission()).toBe(false); // resolved, not leaked
  });
});

describe("CR-03: an unreconciled pending record is never clobbered", () => {
  it("refuses a second submitter's record and keeps consecutive manifests disjoint", async () => {
    const f = fakeChain();
    const c = mkCoordinator(f);
    c.addIous(await paper(1));

    // Round 1 MINES but the receipt wait dies. The pending record is now the
    // only copy of {roundNonce, digest, consumedIds} that can fold it.
    f.chain.broadcast = "lose-receipt";
    await expect(c.runRound(NOW, WINDOW_MS)).rejects.toThrow(/socket hang up/);
    const round1 = f.chain.submissions[0];
    expect(c.settledIds.size).toBe(0); // not folded yet — the record IS the evidence

    // A PvP leg tries to record its own submission over ours. Pre-fix this was
    // a bare assignment and the evidence vanished.
    expect(() =>
      c.recordPendingSubmission({
        roundNonce: 9n,
        digest: ("0x" + "ee".repeat(32)) as Hex,
        consumedIds: [],
        sentAtBlock: f.chain.block,
      }),
    ).toThrow(/refusing to overwrite an unreconciled pending submission/);

    // Recording the SAME submission again (the txHash update the PvP wrapper
    // does) stays allowed.
    expect(() =>
      c.recordPendingSubmission({
        roundNonce: 0n,
        digest: round1.digest,
        consumedIds: round1.consumedIds,
        sentAtBlock: f.chain.block,
        txHash: ("0x" + "11".repeat(32)) as Hex,
      }),
    ).not.toThrow();

    // Next round: the record survived, so round 1's settlement is folded from
    // its RoundExecuted digest and its paper never re-enters a manifest.
    f.chain.broadcast = "ok";
    c.addIous(await paper(50));
    const r = await c.runRound(NOW, WINDOW_MS);
    expect(r.outcome).toBe("settled");

    const round1Ids = new Set(round1.consumedIds.map((i) => i.toLowerCase()));
    expect(round1Ids.size).toBeGreaterThan(0);
    const round2Ids = f.chain.submissions[1].consumedIds.map((i) => i.toLowerCase());
    expect(round2Ids.filter((i) => round1Ids.has(i))).toEqual([]);
    for (const id of round1Ids) expect(c.settledIds.has(id as Hex)).toBe(true);
  });

  it("runPvPRound refuses to start while a leg has an unreconciled submission", async () => {
    const legState = (pending: boolean) => ({
      openIous: [],
      settledIds: new Set<Hex>(),
      redeemedIds: new Set<Hex>(),
      rounds: [],
      hold: () => {},
      release: () => {},
      recordPendingSubmission: () => {
        throw new Error("must not be reached");
      },
      clearPendingSubmission: () => {},
      hasPendingSubmission: () => pending,
    });
    const leg = (hub: Address, pending: boolean): PvPLegDeps => ({
      hub,
      reader: {
        roundNonce: async () => {
          throw new Error("must not be reached");
        },
        roundExecutedHashes: async () => [],
      },
      state: legState(pending),
    });
    const deps = {
      usdc: leg(HUB, true),
      eurc: leg("0x2222222222222222222222222222222222222222" as Address, false),
      router: "0x9999999999999999999999999999999999999999" as Address,
      routerClient: {
        executePvP: async () => {
          throw new Error("must not be reached");
        },
      },
      relayerWallet: {} as unknown as WalletClient,
      pub: {
        getBlockNumber: async () => 1n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
      providers: new Map(),
      quote: { pair: "EUR/USD", rate: 1, asOf: NOW } as unknown as PvPRunDeps["quote"],
      windowMs: WINDOW_MS,
      now: NOW,
    } as unknown as PvPRunDeps;

    const r = await runPvPRound(deps);
    expect(r.outcome).toBe("blocked");
    if (r.outcome !== "blocked") return;
    expect(r.reason).toMatch(/usdc hub has an unreconciled submission/);
  });
});
