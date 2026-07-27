import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { HubClient, scanWindows } from "../src/client.js";
import { clearingHubV2Abi } from "../src/abi/ClearingHubV2.js";
import { pvpRouterAbi } from "../src/abi/PvPRouter.js";
import { merkleRoot } from "../src/merkle.js";

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
      toBlock >= opts.minedAt
        ? [{ transactionHash: TX, args: { manifestHash: merkleRoot(IDS) } }]
        : [],
    getTransaction: async () => ({ hash: TX, input: EXECUTE_ROUND_CALLDATA }),
  } as unknown as PublicClient;
  return { pub, calls };
}

/** A chain whose round `nonce` was settled by `input`, logging `manifestHash`. */
function settledBy(input: Hex, manifestHash: Hex): PublicClient {
  return {
    getBlockNumber: async () => 10n,
    getContractEvents: async () => [{ transactionHash: TX, args: { manifestHash } }],
    getTransaction: async () => ({ hash: TX, input }),
  } as unknown as PublicClient;
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

/**
 * B-CR-02: PvPRouter.executePvP calls hub.executeRound internally, so a
 * PvP-settled round's transaction input carries the ROUTER's selector. Since
 * prepareRedemptionProofs walks every buffered nonce, one PvP settlement made
 * the whole creditor-recovery path throw for the next RING rounds.
 */
describe("HubClient.fetchManifest round provenance (B-CR-02)", () => {
  const IDS_USDC = [("0x" + "33".repeat(32)) as Hex, ("0x" + "44".repeat(32)) as Hex];
  const IDS_EURC = [("0x" + "55".repeat(32)) as Hex, ("0x" + "66".repeat(32)) as Hex];
  const leg = (nonce: bigint, consumedIds: readonly Hex[]) => ({
    nonce,
    participants: [
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
    ] as readonly Address[],
    deltas: [-5n, 5n] as readonly bigint[],
    consumedIds,
    signatures: [("0x" + "cc".repeat(65)) as Hex, ("0x" + "dd".repeat(65)) as Hex] as readonly Hex[],
  });
  // Both legs at the SAME nonce — the shape that makes nonce-only leg
  // selection ambiguous (each hub keeps its own nonce sequence).
  const PVP_CALLDATA = encodeFunctionData({
    abi: pvpRouterAbi,
    functionName: "executePvP",
    args: [
      leg(3n, IDS_USDC),
      leg(3n, IDS_EURC),
      ("0x" + "01".repeat(32)) as Hex,
      ("0x" + "02".repeat(32)) as Hex,
      1_000_000n,
      1_000_000n,
      [("0x" + "ee".repeat(65)) as Hex],
    ],
  });

  it("the router selector is genuinely absent from the hub ABI (the shipped bug)", () => {
    expect(() =>
      decodeFunctionData({ abi: clearingHubV2Abi, data: PVP_CALLDATA }),
    ).toThrow(/not found on ABI|signature/i);
  });

  it("decodes a PvP-settled round, picking the leg the log commits to", async () => {
    // USDC hub's log: its own leg's root.
    const usdcPub = settledBy(PVP_CALLDATA, merkleRoot(IDS_USDC));
    expect(await new HubClient(HUB, usdcPub).fetchManifest(3n)).toEqual(IDS_USDC);
    // EURC hub's log at the same nonce, same transaction: the OTHER leg.
    const eurcPub = settledBy(PVP_CALLDATA, merkleRoot(IDS_EURC));
    expect(await new HubClient(HUB, eurcPub).fetchManifest(3n)).toEqual(IDS_EURC);
  });

  it("still decodes an ordinary executeRound settlement", async () => {
    const pub = settledBy(EXECUTE_ROUND_CALLDATA, merkleRoot(IDS));
    expect(await new HubClient(HUB, pub).fetchManifest(3n)).toEqual(IDS);
  });

  it("refuses calldata whose ids do not hash to the logged manifestHash", async () => {
    // The whole point of the manifest is that it is chain-committed: calldata
    // that disagrees with the log is not a manifest we may serve to redeemIOU.
    const pub = settledBy(EXECUTE_ROUND_CALLDATA, ("0x" + "99".repeat(32)) as Hex);
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /does not hash to the logged manifestHash/,
    );
  });

  it("refuses a PvP bundle with no leg at this nonce", async () => {
    const other = encodeFunctionData({
      abi: pvpRouterAbi,
      functionName: "executePvP",
      args: [
        leg(7n, IDS_USDC),
        leg(9n, IDS_EURC),
        ("0x" + "01".repeat(32)) as Hex,
        ("0x" + "02".repeat(32)) as Hex,
        1n,
        1n,
        [],
      ],
    });
    const pub = settledBy(other, merkleRoot(IDS_USDC));
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /no matching leg in PvP tx/,
    );
  });

  it("names the real cause for calldata from neither known contract", async () => {
    const pub = settledBy("0xdeadbeef" as Hex, merkleRoot(IDS));
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /unrecognised caller/,
    );
  });
});
