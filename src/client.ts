import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Account } from "viem/accounts";
import { arcTestnet, MIN_MAX_FEE_PER_GAS } from "./domain.js";
import { clearingHubV3Abi } from "./abi/ClearingHubV3.js";
import { pvpRouterV3Abi } from "./abi/PvPRouterV3.js";
import { manifestLeafId, merkleRoot } from "./merkle.js";
import { unionParticipants } from "./pvp.js";
import { consumedRefs } from "./round.js";
import type { ConsumedIou, Iou, PvPProposal, RoundProposal } from "./types.js";

export { clearingHubV3Abi, pvpRouterV3Abi };

/**
 * ClearingHubV3 `executeRound` gas formula, intrinsic gas included:
 *
 *   gas = BASE + PER_PARTICIPANT * n + PER_REF * m
 *
 * Every constant below is the FITTED formula pinned by `assertLe` at every
 * measured point in contracts/test/GasScalingV3.t.sol, so it cannot silently
 * drift from the contract. Worst-case shape: a fresh hub at nonce 0 with one
 * funded debtor and n-1 fresh creditors, so every participant pays cold
 * SSTOREs for BOTH `collateral` and `lastRound`.
 *
 * | n  | m   | execution | intrinsic | total     | formula    | margin |
 * |----|-----|-----------|-----------|-----------|------------|--------|
 * | 2  | 1   |   136,939 |    27,392 |   164,331 |    525,000 |  3.19x |
 * | 5  | 3   |   349,207 |    34,940 |   384,147 |    885,000 |  2.30x |
 * | 15 | 8   | 1,010,180 |    58,684 | 1,068,864 |  2,010,000 |  1.88x |
 * | 30 | 15  | 1,991,223 |    93,916 | 2,085,139 |  3,675,000 |  1.76x |
 * | 50 | 25  | 3,328,395 |   141,380 | 3,469,775 |  5,925,000 |  1.71x |
 * | 5  | 105 | 3,202,035 |   114,344 | 3,316,379 |  5,475,000 |  1.65x |
 * | 5  | 250 | 7,462,110 |   227,216 | 7,689,326 | 12,000,000 |  1.56x |
 *
 * Implied marginals: ~54,300 per participant (unchanged from V2) and ~28,600
 * to ~30,600 PER CONSUMED REF — a 6.5x jump from V2's ~4,400. That jump is
 * the price of the CR-02 fix and is deliberate: each ref now pays a COLD
 * SSTORE (20,000 + 2,100) into the hub's permanent `consumed` ledger, plus a
 * three-word calldata entry instead of one bytes32. V2's cheaper round bought
 * a redemption guarantee any third party could permanently destroy; V3's
 * dearer round buys one that nothing can erode. The counterpart saving is on
 * the other side of the product — see REDEEM_IOU_GAS.
 *
 * Explicit gas is mandatory on Arc: USDC is the gas token, so estimation
 * reserves the whole balance.
 */
export const EXECUTE_ROUND_GAS_BASE = 300_000n;
export const EXECUTE_ROUND_GAS_PER_PARTICIPANT = 90_000n;
export const EXECUTE_ROUND_GAS_PER_REF = 45_000n;

/**
 * ClearingHubV3 `redeemIOU` flat gas limit — and it genuinely is flat now.
 *
 * V2's redemption walked a RING-slot ring of roots with one bracketing
 * non-inclusion proof each: 199,604 gas of execution plus multiple KB of
 * near-all-non-zero proof calldata, growing with both RING and manifest size,
 * at a margin the audit derived as ≈1.35x under the old 500,000 limit.
 *
 * V3 takes NO proofs. Exclusivity is a single `consumed[leafId]` SLOAD, so
 * `test_gas_v3_redeemIOU_isHistoryIndependent` measures 57,779 execution gas
 * identically after 4 rounds and after 64 — the same 24,212 intrinsic, 82,003
 * total either way. 150,000 is a 1.83x margin over the measured worst point
 * and, unlike its predecessor, is not a function of anything a third party
 * controls.
 */
export const REDEEM_IOU_GAS = 150_000n;

/**
 * PvPRouterV3 `executePvP` gas formula, intrinsic gas included:
 *
 *   gas = BASE + PER_PARTICIPANT * (nUsdc + nEurc)
 *              + PER_UNION_SIG   * unionSize
 *              + PER_REF         * (mUsdc + mEurc)
 *
 * Four additive terms, not "two legs of the executeRound formula plus router
 * overhead" as in V2. Participants and union members are counted separately
 * because they cost different things: a participant costs its hub an ecrecover,
 * two cold SSTOREs and a log; a union member costs the router one ecrecover
 * over an already-computed digest. Identical participant sets collapse the
 * union to n while keeping 2n participants; disjoint sets take it to 2n — both
 * regimes are measured, which is what brackets the two coefficients.
 *
 * Pinned in BOTH directions at every point in GasScalingPvPV3.t.sol: `assertLe`
 * of measurement against formula (never under-provision) and of formula against
 * 1.5x measurement (never let the estimate rot into a meaningless number).
 *
 * | n/leg | m/leg | union | execution  | intrinsic | total      | formula    | margin |
 * |-------|-------|-------|------------|-----------|------------|------------|--------|
 * | 2     | 1     |   2   |    308,637 |    38,556 |    347,193 |    426,000 |  1.23x |
 * | 3     | 2     |   3   |    482,185 |    45,524 |    527,709 |    639,000 |  1.21x |
 * | 3     | 2     |   6   |    495,783 |    49,952 |    545,735 |    666,000 |  1.22x |
 * | 10    | 5     |  20   |  1,498,644 |   102,644 |  1,601,288 |  1,900,000 |  1.19x |
 * | 15    | 8     |  15   |  2,197,010 |   120,104 |  2,317,114 |  2,715,000 |  1.17x |
 * | 30    | 15    |  30   |  4,336,796 |   212,240 |  4,549,036 |  5,270,000 |  1.16x |
 * | 5     | 105   |   5   |  7,114,611 |   216,936 |  7,331,547 |  9,145,000 |  1.25x |
 * | 5     | 250   |   5   | 16,980,362 |   442,548 | 17,422,910 | 20,745,000 |  1.19x |
 *
 * Margins are tighter than V2's (14-25% vs 70-180%) by design: the V2 estimate
 * was loose enough to stop meaning anything, and both bounds are now asserted.
 *
 * Explicit gas is mandatory on Arc: USDC is the gas token, so estimation
 * reserves the whole balance.
 */
export const PVP_GAS_BASE = 80_000n;
export const PVP_GAS_PER_PARTICIPANT = 62_000n;
export const PVP_GAS_PER_UNION_SIG = 9_000n;
export const PVP_GAS_PER_REF = 40_000n;

export function publicClient(rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
}

/**
 * Max eth_getLogs span assumed servable in one request. Live Arc providers
 * cap log queries (observed: "query exceeds max block range 100000") on top
 * of pruning genesis history — so long scans must be windowed. 90,000 keeps
 * margin under the observed cap.
 */
export const MAX_LOG_SCAN_SPAN = 90_000n;

/** Inclusive [from, to] windows of at most `span` blocks covering from..to.
 * Empty when to < from. A single window when the range fits — the anvil/test
 * path (earliestBlock 0n, small chains) stays one request. */
export function scanWindows(from: bigint, to: bigint, span: bigint): [bigint, bigint][] {
  const windows: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += span) {
    const end = start + span - 1n < to ? start + span - 1n : to;
    windows.push([start, end]);
  }
  return windows;
}

export function walletClient(account: Account, rpcUrl?: string): WalletClient {
  return createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });
}

/**
 * One entry of a manifest reconstructed from settlement calldata: the raw ref
 * as the chain saw it, plus the party-bound leaf the hub derived from it.
 */
export interface ReconstructedRef {
  id: Hex;
  partyA: Address;
  partyB: Address;
  /** manifestLeafId(id, partyA, partyB) — the hub's consumption-ledger key. */
  leafId: Hex;
}

/**
 * Resolve on-chain `ConsumedRef`s against their leg's participants into the
 * leaves the hub actually committed. Total: out-of-range indices or malformed
 * ids yield `undefined` (not a match candidate), never a throw — the caller is
 * choosing between candidate legs, not validating trusted input.
 */
function reconstructRefs(
  participants: readonly Address[],
  refs: readonly { id: Hex; partyAIdx: number; partyBIdx: number }[],
): ReconstructedRef[] | undefined {
  try {
    return refs.map((r) => {
      const partyA = participants[r.partyAIdx];
      const partyB = participants[r.partyBIdx];
      if (partyA === undefined || partyB === undefined) {
        throw new Error(`party index out of range for ${r.id}`);
      }
      return { id: r.id, partyA, partyB, leafId: manifestLeafId(r.id, partyA, partyB) };
    });
  } catch {
    return undefined;
  }
}

/**
 * Does this reconstructed manifest hash to the root the chain committed to?
 * Total: a leaf list the merkle builder refuses (unsorted, duplicated) is
 * simply not a match, never a throw.
 */
function rootMatches(refs: ReconstructedRef[] | undefined, root: Hex): boolean {
  if (refs === undefined) return false;
  try {
    return merkleRoot(refs.map((r) => r.leafId)).toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}

/** Typed wrapper around one ClearingHubV3 deployment. */
export class HubClient {
  /** Lower bound for every unbounded event scan this client issues. Defaults
   * to 0n (anvil/tests run against full-history nodes — behavior unchanged).
   * The public Arc RPC prunes old history and rejects eth_getLogs from
   * genesis, so live-testnet callers pass the hub's deploy block. */
  readonly earliestBlock: bigint;

  constructor(
    readonly hub: Address,
    readonly pub: PublicClient,
    opts: { earliestBlock?: bigint } = {},
  ) {
    this.earliestBlock = opts.earliestBlock ?? 0n;
  }

  collateral(participant: Address): Promise<bigint> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "collateral",
      args: [participant],
    });
  }

  roundNonce(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubV3Abi, functionName: "roundNonce" })
      .then(BigInt);
  }

  token(): Promise<Address> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "token",
    });
  }

  /** The hub's staleness gate K: a debtor is redeemable-against after being
   *  absent from the last >= K executed rounds. */
  K(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubV3Abi, functionName: "K" })
      .then(BigInt);
  }

  /**
   * 1-based marker of the last round in which this address actually SETTLED
   * something — a non-zero delta, or a ConsumedRef naming them as a party
   * (0 = never). V3/WR-11 narrowed this from V2's "last round co-signed": mere
   * co-signature no longer refreshes the liveness clock, so an address cannot
   * stay non-stale by rubber-stamping rounds it has no stake in.
   */
  lastRound(participant: Address): Promise<bigint> {
    return this.pub
      .readContract({
        address: this.hub,
        abi: clearingHubV3Abi,
        functionName: "lastRound",
        args: [participant],
      })
      .then(BigInt);
  }

  /**
   * RoundExecuted `roundHash` values logged for `roundNonce` since
   * `fromBlock`. The logged roundHash IS the EIP-712 Round digest the
   * participants signed, so a submitter whose receipt wait failed can decide
   * "did MY round mine, or a concurrent one?" from chain state alone —
   * the WR-01/WR-02 reconciliation primitive.
   */
  async roundExecutedHashes(roundNonce: bigint, fromBlock: bigint): Promise<Hex[]> {
    const logs = await this.pub.getContractEvents({
      address: this.hub,
      abi: clearingHubV3Abi,
      eventName: "RoundExecuted",
      args: { roundNonce },
      fromBlock,
    });
    return logs.flatMap((l) => (l.args.roundHash === undefined ? [] : [l.args.roundHash]));
  }

  /** Nullifier check: has this IOU id already been redeemed on-chain? Keyed by
   *  the RAW id, unlike `consumed` — only the debtor's own signature can write
   *  here, so raw-id keying is the strictly more conservative choice. */
  redeemed(id: Hex): Promise<boolean> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "redeemed",
      args: [id],
    });
  }

  /**
   * The CR-02 consumption ledger: has any round ever netted this PARTY-BOUND
   * leaf? This single O(1) read is the whole of V3's redemption precondition,
   * replacing V2's ring of roots and its per-root non-inclusion proofs.
   * Permanent by construction — nothing evicts, expires or rewrites an entry.
   */
  consumed(leafId: Hex): Promise<boolean> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "consumed",
      args: [leafId],
    });
  }

  /** Convenience form of `consumed` for callers holding the IOU rather than
   *  the leaf: has this exact obligation already been netted by a round? */
  isConsumed(iou: Iou): Promise<boolean> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "isConsumed",
      args: [iou],
    });
  }

  /** On-chain party-bound manifest leaf — parity-locked against the SDK's
   *  manifestLeafId (test/fixtures/merkle.json + MerkleParityV3.t.sol). */
  manifestLeafId(id: Hex, partyA: Address, partyB: Address): Promise<Hex> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "manifestLeafId",
      args: [id, partyA, partyB],
    });
  }

  /** On-chain IOU digest — parity-locked against the SDK's iouId. */
  hashIou(iou: Iou): Promise<Hex> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "hashIou",
      args: [iou],
    });
  }

  /**
   * Reconstruct round `nonce`'s consumed manifest from settlement calldata,
   * resolved into the party-bound leaves the hub committed.
   *
   * The manifest is signature-bound: the unanimously signed digest commits to
   * the merkle root the contract derived from this exact calldata, so an
   * auditor needs only an RPC endpoint — NEVER a coordinator endpoint, which
   * could serve a fabricated leaf set.
   *
   * NOT a redemption dependency under v3. V2 needed this to build one
   * non-inclusion proof per buffered root; V3's `redeemIOU` takes no proofs
   * and `consumed(leafId)` answers the same question in O(1). What survives is
   * the auditing use it always also had: independently recovering WHICH
   * obligations a round extinguished, and — new in V3 — under WHICH party
   * pair, which is the fact `consumed` is keyed on.
   *
   * Two settlement shapes reach a hub (CR-02): a direct `executeRound`, and a
   * `PvPRouterV3.executePvP` bundle whose legs call `executeRound` internally.
   * For the latter the transaction input carries the ROUTER's selector, which
   * the hub ABI does not contain — decoding it against the hub ABI throws
   * AbiFunctionSignatureNotFoundError. Both shapes are decoded here, and the
   * selected leg is confirmed by recomputing its merkle root against the
   * `manifestHash` the RoundExecuted log itself carries — so a bundle whose
   * two legs share a nonce across two hubs is disambiguated by the chain's own
   * commitment, not by argument position.
   */
  async fetchManifest(nonce: bigint): Promise<ReconstructedRef[]> {
    // earliestBlock (hub deploy block on live Arc) floors the scan — the
    // public RPC rejects from-genesis ranges as pruned history — and the
    // range is windowed because live providers also cap per-request spans.
    //
    // cacheTime: 0 is load-bearing. viem caches getBlockNumber for `cacheTime`
    // ms, defaulting to pollingInterval = 4,000 — so a round mined in the last
    // 4 s falls OUTSIDE [earliestBlock, latest], the scan returns no logs, and
    // this throws for a round that provably executed. Measured: 2 of 5 clean
    // `npm run e2e:anvil` runs failed in prepareRedemptionProofs this way
    // (audit 2026-07-27, E-CR-03). Any scan BOUND must read the true tip.
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    if (this.earliestBlock > latest) {
      // scanWindows would return [] and the empty-logs branch below would
      // blame the round. Name the real cause: a mis-set deploy block.
      throw new Error(
        `earliestBlock ${this.earliestBlock} is past the chain tip ${latest} — ` +
          `check HUB_V3_DEPLOY_BLOCK for hub ${this.hub}`,
      );
    }
    const logs = [];
    for (const [fromBlock, toBlock] of scanWindows(this.earliestBlock, latest, MAX_LOG_SCAN_SPAN)) {
      logs.push(
        ...(await this.pub.getContractEvents({
          address: this.hub,
          abi: clearingHubV3Abi,
          eventName: "RoundExecuted",
          args: { roundNonce: nonce },
          fromBlock,
          toBlock,
        })),
      );
    }
    if (logs.length === 0) {
      throw new Error(`no RoundExecuted event for round nonce ${nonce} at hub ${this.hub}`);
    }
    const log = logs[logs.length - 1];
    // Non-indexed event field: present on any real log, but a decoding that
    // could not recover it must degrade to nonce-only selection, not crash.
    const committedRoot = log.args?.manifestHash;
    const tx = await this.pub.getTransaction({ hash: log.transactionHash });

    // Direct settlement: the hub's own selector.
    let hubCall: ReturnType<typeof decodeFunctionData<typeof clearingHubV3Abi>> | undefined;
    try {
      hubCall = decodeFunctionData({ abi: clearingHubV3Abi, data: tx.input });
    } catch {
      hubCall = undefined; // not a hub call — try the router shape below
    }
    if (hubCall !== undefined) {
      if (hubCall.functionName !== "executeRound") {
        throw new Error(`round ${nonce} tx ${tx.hash} is not an executeRound call`);
      }
      const refs = reconstructRefs(hubCall.args[1], hubCall.args[3]);
      if (refs === undefined) {
        throw new Error(
          `round ${nonce} tx ${tx.hash}: executeRound calldata has a party index out of range`,
        );
      }
      if (committedRoot !== undefined && !rootMatches(refs, committedRoot)) {
        throw new Error(
          `round ${nonce} tx ${tx.hash}: executeRound calldata does not hash to the logged manifestHash`,
        );
      }
      return refs;
    }

    // PvP settlement: the router called into this hub. Pick the leg the log
    // commits to — nonce narrows the candidates, the root decides.
    let routerCall: ReturnType<typeof decodeFunctionData<typeof pvpRouterV3Abi>>;
    try {
      routerCall = decodeFunctionData({ abi: pvpRouterV3Abi, data: tx.input });
    } catch {
      throw new Error(
        `round ${nonce} tx ${tx.hash} was settled by an unrecognised caller ` +
          `(neither ClearingHubV3 nor PvPRouterV3 calldata)`,
      );
    }
    if (routerCall.functionName !== "executePvP") {
      throw new Error(`round ${nonce} tx ${tx.hash} is not an executePvP call`);
    }
    const legs = [routerCall.args[0], routerCall.args[1]];
    const candidates = legs
      .filter((l) => BigInt(l.nonce) === nonce)
      .map((l) => reconstructRefs(l.participants, l.consumedRefs));
    if (candidates.length === 0) {
      throw new Error(`round ${nonce} has no matching leg in PvP tx ${tx.hash}`);
    }
    const matched =
      committedRoot === undefined
        ? candidates.filter((r): r is ReconstructedRef[] => r !== undefined)
        : candidates.filter((r): r is ReconstructedRef[] => rootMatches(r, committedRoot));
    if (matched.length !== 1) {
      throw new Error(
        `round ${nonce} tx ${tx.hash}: ${matched.length} PvP legs match the logged ` +
          `manifestHash — cannot identify this hub's leg`,
      );
    }
    return matched[0];
  }

  /** On-chain digest — used to assert parity with the SDK's roundDigest. */
  hashRound(p: {
    roundNonce: bigint;
    participants: Address[];
    deltas: bigint[];
    manifestHash: Hex;
  }): Promise<Hex> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "hashRound",
      args: [p.roundNonce, p.participants, p.deltas, p.manifestHash],
    });
  }

  async deposit(wallet: WalletClient, amount: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "deposit",
      args: [amount],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: 200_000n,
    });
  }

  async withdraw(wallet: WalletClient, amount: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "withdraw",
      args: [amount],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: 200_000n,
    });
  }

  /**
   * Submit a fully consented round. Permissionless — any relayer works.
   * The party-bound `ConsumedRef[]` is DERIVED here from the proposal's
   * consumed set, never carried as calldata-shaped state: indices are
   * meaningless without their participant array, so resolving them at the last
   * possible moment is what keeps them consistent with what was signed.
   */
  async executeRound(
    wallet: WalletClient,
    proposal: RoundProposal,
    signatures: Hex[],
  ): Promise<Hex> {
    const refs = consumedRefs(proposal.participants, proposal.consumed);
    const gas =
      EXECUTE_ROUND_GAS_BASE +
      EXECUTE_ROUND_GAS_PER_PARTICIPANT * BigInt(proposal.participants.length) +
      EXECUTE_ROUND_GAS_PER_REF * BigInt(refs.length);
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "executeRound",
      args: [proposal.roundNonce, proposal.participants, proposal.deltas, refs, signatures],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas,
    });
  }

  /**
   * Redeem a stale-debtor IOU. NO PROOFS (v3 CR-02): the hub gates on
   * `consumed[manifestLeafId(id, debtor, creditor)]`, one O(1) storage read
   * whose answer no third party can manufacture. V2's proof array, root ring
   * and TOCTOU regeneration loop are all gone — a round landing between the
   * caller's decision and the mining of this transaction can no longer
   * invalidate it, because there is no proof to invalidate.
   */
  async redeemIOU(wallet: WalletClient, iou: Iou, sig: Hex): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV3Abi,
      functionName: "redeemIOU",
      args: [iou, sig],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: REDEEM_IOU_GAS,
    });
  }
}

/** One leg as the router's executePvP consumes it: the embedded RoundProposal
 *  fields plus its collected consent signatures, ABI-tuple-shaped. Refs are
 *  resolved against THIS leg's participants (Pitfall 3: never the other's). */
function toAbiLeg(leg: RoundProposal, signatures: Hex[]) {
  return {
    nonce: leg.roundNonce,
    participants: leg.participants,
    deltas: leg.deltas,
    consumedRefs: consumedRefs(leg.participants, leg.consumed),
    signatures,
  };
}

/** Typed wrapper around one PvPRouterV3 deployment: hub-pair reads, PvPRound
 *  digest parity checks, and formula-gas atomic PvP submission. */
export class PvPRouterClient {
  private readonly pub: PublicClient;

  constructor(
    readonly router: Address,
    rpcUrl?: string,
  ) {
    this.pub = publicClient(rpcUrl);
  }

  /** The immutable USDC-side hub the router was deployed against. */
  hubUSDC(): Promise<Address> {
    return this.pub.readContract({
      address: this.router,
      abi: pvpRouterV3Abi,
      functionName: "hubUSDC",
    });
  }

  /** The immutable EURC-side hub the router was deployed against. */
  hubEURC(): Promise<Address> {
    return this.pub.readContract({
      address: this.router,
      abi: pvpRouterV3Abi,
      functionName: "hubEURC",
    });
  }

  /** On-chain PvPRound digest — used to assert parity with the SDK's pvpDigest. */
  hashPvPRound(
    usdcLegDigest: Hex,
    eurcLegDigest: Hex,
    fxNumerator: bigint,
    fxDenominator: bigint,
  ): Promise<Hex> {
    return this.pub.readContract({
      address: this.router,
      abi: pvpRouterV3Abi,
      functionName: "hashPvPRound",
      args: [usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator],
    });
  }

  /** The router's local mirror of the hub's party-bound leaf derivation —
   *  read it to assert the two implementations have not diverged. */
  manifestLeafId(id: Hex, partyA: Address, partyB: Address): Promise<Hex> {
    return this.pub.readContract({
      address: this.router,
      abi: pvpRouterV3Abi,
      functionName: "manifestLeafId",
      args: [id, partyA, partyB],
    });
  }

  /**
   * Submit a fully consented PvP bundle atomically. Permissionless — any
   * relayer works. Gas is the measured formula (never estimation — Arc's
   * gas token is USDC, so estimation reserves the whole balance): router
   * base + both legs' executeRound formula terms + per-union-signature cost,
   * with the signed leg digests passed explicitly so the router binds the
   * calldata legs to exactly what the union consented to.
   */
  async executePvP(
    wallet: WalletClient,
    proposal: PvPProposal,
    legSignatures: { usdc: Hex[]; eurc: Hex[] },
    pvpSignatures: Hex[],
  ): Promise<Hex> {
    const nUnion = unionParticipants(
      proposal.usdcLeg.participants,
      proposal.eurcLeg.participants,
    ).length;
    const gas =
      PVP_GAS_BASE +
      PVP_GAS_PER_PARTICIPANT *
        BigInt(proposal.usdcLeg.participants.length + proposal.eurcLeg.participants.length) +
      PVP_GAS_PER_UNION_SIG * BigInt(nUnion) +
      PVP_GAS_PER_REF *
        BigInt(proposal.usdcLeg.consumed.length + proposal.eurcLeg.consumed.length);
    return wallet.writeContract({
      address: this.router,
      abi: pvpRouterV3Abi,
      functionName: "executePvP",
      args: [
        toAbiLeg(proposal.usdcLeg, legSignatures.usdc),
        toAbiLeg(proposal.eurcLeg, legSignatures.eurc),
        proposal.usdcLeg.digest,
        proposal.eurcLeg.digest,
        proposal.fxNumerator,
        proposal.fxDenominator,
        pvpSignatures,
      ],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas,
    });
  }
}
