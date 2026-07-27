import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { HubClient, scanWindows } from "../src/client.js";
import { clearingHubV2Abi } from "../src/abi/ClearingHubV2.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const TX = ("0x" + "ab".repeat(32)) as Hex;
const IDS = [("0x" + "11".repeat(32)) as Hex, ("0x" + "22".repeat(32)) as Hex];

/** Calldata of the executeRound whose manifest fetchManifest reconstructs. */
const EXECUTE_ROUND_CALLDATA = encodeFunctionData({
  abi: clearingHubV2Abi,
  functionName: "executeRound",
  args: [
    3n,
    ["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"],
    [-5n, 5n],
    IDS,
    [("0x" + "cc".repeat(65)) as Hex, ("0x" + "dd".repeat(65)) as Hex],
  ],
});

/**
 * Chain where round 3 mined at block `MINED_AT`, and `getBlockNumber` behaves
 * like viem's: a tip up to `cacheTime` ms stale unless the caller opts out.
 * `honorsCacheTime: false` models the pre-fix call (viem's 4,000 ms default).
 */
function fakeChain(opts: { staleTip: bigint; trueTip: bigint; minedAt: bigint }) {
  const calls: unknown[] = [];
  const pub = {
    getBlockNumber: async (args?: { cacheTime?: number }) => {
      calls.push(args);
      return args?.cacheTime === 0 ? opts.trueTip : opts.staleTip;
    },
    getContractEvents: async ({ toBlock }: { toBlock: bigint }) =>
      toBlock >= opts.minedAt ? [{ transactionHash: TX }] : [],
    getTransaction: async () => ({ hash: TX, input: EXECUTE_ROUND_CALLDATA }),
  } as unknown as PublicClient;
  return { pub, calls };
}

describe("HubClient.fetchManifest scan bound (E-CR-03)", () => {
  it("reads the true tip, so a just-mined round is inside the scan window", async () => {
    // Round mined at block 7; viem's cached tip is still 4 (mined < 4 s ago).
    const { pub, calls } = fakeChain({ staleTip: 4n, trueTip: 7n, minedAt: 7n });
    const ids = await new HubClient(HUB, pub).fetchManifest(3n);
    expect(ids).toEqual(IDS);
    // The opt-out is what makes it work — not luck about which tip was cached.
    expect(calls).toEqual([{ cacheTime: 0 }]);
  });

  it("would have missed that round on the cached tip (the shipped bug)", async () => {
    // Same chain, but the client is denied the opt-out: the scan ends at block
    // 4 and the round that provably executed at 7 is invisible.
    const { pub } = fakeChain({ staleTip: 4n, trueTip: 7n, minedAt: 7n });
    const cachedOnly = {
      ...pub,
      getBlockNumber: async () => 4n,
    } as unknown as PublicClient;
    await expect(new HubClient(HUB, cachedOnly).fetchManifest(3n)).rejects.toThrow(
      /no RoundExecuted event for round nonce 3/,
    );
  });

  it("blames the deploy block, not the round, when earliestBlock is past the tip", async () => {
    const { pub } = fakeChain({ staleTip: 7n, trueTip: 7n, minedAt: 7n });
    // scanWindows is empty here — without the guard the caller would be told
    // the round never happened.
    expect(scanWindows(99n, 7n, 90_000n)).toEqual([]);
    await expect(
      new HubClient(HUB, pub, { earliestBlock: 99n }).fetchManifest(3n),
    ).rejects.toThrow(/HUB_V2_DEPLOY_BLOCK/);
  });
});
