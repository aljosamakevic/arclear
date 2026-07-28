import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { HubClient, scanWindows } from "../src/client.js";
import { clearingHubV3Abi } from "../src/abi/ClearingHubV3.js";
import { pvpRouterV3Abi } from "../src/abi/PvPRouterV3.js";
import { manifestLeafId, merkleRoot } from "../src/merkle.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const TX = ("0x" + "ab".repeat(32)) as Hex;

const PARTIES: [Address, Address] = [
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];

/**
 * v3 refs index INTO the round's participants, so a manifest is only
 * meaningful alongside its participant array — every helper below carries both.
 * Refs must ascend BY DERIVED LEAF, which is what `sortedRefs` enforces; a
 * fixture that happened to be id-ordered would not be settleable on-chain.
 */
function sortedRefs(ids: Hex[]) {
  return ids
    .map((id) => ({
      id,
      partyAIdx: 0,
      partyBIdx: 1,
      leafId: manifestLeafId(id, PARTIES[0], PARTIES[1]),
    }))
    .sort((a, b) => (a.leafId < b.leafId ? -1 : a.leafId > b.leafId ? 1 : 0));
}

/** The root the hub would derive from these refs — what the log commits to. */
function rootOfRefs(ids: Hex[]): Hex {
  return merkleRoot(sortedRefs(ids).map((r) => r.leafId));
}

/** ABI-shaped refs (drops the derived leaf the contract recomputes itself). */
function abiRefs(ids: Hex[]) {
  return sortedRefs(ids).map(({ id, partyAIdx, partyBIdx }) => ({ id, partyAIdx, partyBIdx }));
}

const IDS = [("0x" + "11".repeat(32)) as Hex, ("0x" + "22".repeat(32)) as Hex];

/** Calldata of the executeRound whose manifest fetchManifest reconstructs. */
const EXECUTE_ROUND_CALLDATA = encodeFunctionData({
  abi: clearingHubV3Abi,
  functionName: "executeRound",
  args: [
    3n,
    PARTIES,
    [-5n, 5n],
    abiRefs(IDS),
    [("0x" + "cc".repeat(65)) as Hex, ("0x" + "dd".repeat(65)) as Hex],
  ],
});

/** Ids in the order fetchManifest will return them (ascending by leaf). */
const IDS_IN_MANIFEST_ORDER = sortedRefs(IDS).map((r) => r.id);

/**
 * Chain where round 3 mined at block `MINED_AT`, and `getBlockNumber` behaves
 * like viem's: a tip up to `cacheTime` ms stale unless the caller opts out.
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
        ? [{ transactionHash: TX, args: { manifestHash: rootOfRefs(IDS) } }]
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
    const refs = await new HubClient(HUB, pub).fetchManifest(3n);
    expect(refs.map((r) => r.id)).toEqual(IDS_IN_MANIFEST_ORDER);
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
    ).rejects.toThrow(/HUB_V3_DEPLOY_BLOCK/);
  });
});

/**
 * B-CR-02: PvPRouterV3.executePvP calls hub.executeRound internally, so a
 * PvP-settled round's transaction input carries the ROUTER's selector. Both
 * calldata shapes must decode, and the leg must be selected by the chain's own
 * commitment rather than by argument position.
 */
describe("HubClient.fetchManifest round provenance (B-CR-02)", () => {
  const IDS_USDC = [("0x" + "33".repeat(32)) as Hex, ("0x" + "44".repeat(32)) as Hex];
  const IDS_EURC = [("0x" + "55".repeat(32)) as Hex, ("0x" + "66".repeat(32)) as Hex];
  const leg = (nonce: bigint, ids: Hex[]) => ({
    nonce,
    participants: PARTIES as readonly Address[],
    deltas: [-5n, 5n] as readonly bigint[],
    consumedRefs: abiRefs(ids),
    signatures: [("0x" + "cc".repeat(65)) as Hex, ("0x" + "dd".repeat(65)) as Hex] as readonly Hex[],
  });
  // Both legs at the SAME nonce — the shape that makes nonce-only leg
  // selection ambiguous (each hub keeps its own nonce sequence).
  const PVP_CALLDATA = encodeFunctionData({
    abi: pvpRouterV3Abi,
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
      decodeFunctionData({ abi: clearingHubV3Abi, data: PVP_CALLDATA }),
    ).toThrow(/not found on ABI|signature/i);
  });

  it("decodes a PvP-settled round, picking the leg the log commits to", async () => {
    // USDC hub's log: its own leg's root.
    const usdcPub = settledBy(PVP_CALLDATA, rootOfRefs(IDS_USDC));
    expect((await new HubClient(HUB, usdcPub).fetchManifest(3n)).map((r) => r.id)).toEqual(
      sortedRefs(IDS_USDC).map((r) => r.id),
    );
    // EURC hub's log at the same nonce, same transaction: the OTHER leg.
    const eurcPub = settledBy(PVP_CALLDATA, rootOfRefs(IDS_EURC));
    expect((await new HubClient(HUB, eurcPub).fetchManifest(3n)).map((r) => r.id)).toEqual(
      sortedRefs(IDS_EURC).map((r) => r.id),
    );
  });

  it("still decodes an ordinary executeRound settlement", async () => {
    const pub = settledBy(EXECUTE_ROUND_CALLDATA, rootOfRefs(IDS));
    expect((await new HubClient(HUB, pub).fetchManifest(3n)).map((r) => r.id)).toEqual(
      IDS_IN_MANIFEST_ORDER,
    );
  });

  it("resolves each ref's party indices into the addresses the leaf binds", async () => {
    // The v3 point of reconstruction: not just WHICH obligations a round
    // extinguished, but under WHICH party pair — that pair is what the hub's
    // `consumed` ledger is keyed on, so an auditor who only recovered ids
    // could not tell whether their own paper was the paper that was netted.
    const pub = settledBy(EXECUTE_ROUND_CALLDATA, rootOfRefs(IDS));
    const refs = await new HubClient(HUB, pub).fetchManifest(3n);
    for (const r of refs) {
      expect([r.partyA, r.partyB].sort()).toEqual([...PARTIES].sort());
      expect(r.leafId).toBe(manifestLeafId(r.id, r.partyA, r.partyB));
    }
  });

  it("refuses calldata whose refs do not hash to the logged manifestHash", async () => {
    // The whole point of the manifest is that it is chain-committed: calldata
    // that disagrees with the log is not a manifest we may serve to anyone.
    const pub = settledBy(EXECUTE_ROUND_CALLDATA, ("0x" + "99".repeat(32)) as Hex);
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /does not hash to the logged manifestHash/,
    );
  });

  it("refuses calldata whose ids match but whose party attribution does not", async () => {
    // v3-specific: the same ids under a DIFFERENT pair derive different leaves
    // and therefore a different root. Reconstruction must reject it rather
    // than report a manifest the chain never committed — the party binding is
    // the entire CR-01 fix, so losing it here would quietly undo the audit.
    const otherParties: [Address, Address] = [
      "0x4444444444444444444444444444444444444444",
      "0x5555555555555555555555555555555555555555",
    ];
    const otherLeaves = IDS.map((id) => manifestLeafId(id, otherParties[0], otherParties[1])).sort();
    const pub = settledBy(EXECUTE_ROUND_CALLDATA, merkleRoot(otherLeaves));
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /does not hash to the logged manifestHash/,
    );
  });

  it("refuses a PvP bundle with no leg at this nonce", async () => {
    const other = encodeFunctionData({
      abi: pvpRouterV3Abi,
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
    const pub = settledBy(other, rootOfRefs(IDS_USDC));
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /no matching leg in PvP tx/,
    );
  });

  it("names the real cause for calldata from neither known contract", async () => {
    const pub = settledBy("0xdeadbeef" as Hex, rootOfRefs(IDS));
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /unrecognised caller/,
    );
  });

  it("names the real cause for a ref whose party index is out of range", async () => {
    // A named diagnostic, not an array-index crash (WR-08 class). Only
    // reachable from malformed/adversarial calldata, since the hub itself
    // reverts PartyIndexOutOfRange before such a round can execute.
    const bad = encodeFunctionData({
      abi: clearingHubV3Abi,
      functionName: "executeRound",
      args: [
        3n,
        PARTIES,
        [-5n, 5n],
        [{ id: IDS[0], partyAIdx: 0, partyBIdx: 9 }],
        [("0x" + "cc".repeat(65)) as Hex, ("0x" + "dd".repeat(65)) as Hex],
      ],
    });
    const pub = settledBy(bad, rootOfRefs(IDS));
    await expect(new HubClient(HUB, pub).fetchManifest(3n)).rejects.toThrow(
      /party index out of range/,
    );
  });
});
