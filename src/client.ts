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
import { clearingHubAbi } from "./abi/ClearingHub.js";
import { clearingHubV2Abi } from "./abi/ClearingHubV2.js";
import { pvpRouterAbi } from "./abi/PvPRouter.js";
import {
  merkleRoot,
  nonInclusionProof,
  type InclusionProof,
  type NonInclusionProof,
} from "./merkle.js";
import { unionParticipants } from "./pvp.js";
import type { Iou, PvPProposal, RoundProposal } from "./types.js";

export { clearingHubAbi };

/**
 * executeRound gas formula coefficients — measured across PARTICIPANT COUNT,
 * intrinsic gas included (contracts/test/GasScaling.t.sol; every point below
 * is asserted there, so these constants cannot silently drift).
 *
 * B-CR-03: the previous coefficients (40,000/participant, 6,000/id) came from
 * measurements that only ever varied `m` at n=5 — the per-participant term was
 * never measured at all — and from `gasleft()` deltas, which EXCLUDE the
 * 21,000 + 16/non-zero-calldata-byte a submitter actually pays. Both errors
 * pushed the same way: at n=30/m=15 the old formula supplied 1,590,000 against
 * 1,763,412 needed, i.e. a deterministic out-of-gas revert that burns
 * USDC-denominated fees, for pool sizes docs/CALIBRATION.md explicitly
 * analyzes (n = 15/30/50). Crossover was around n=16.
 *
 * Worst-case shape measured: one funded debtor plus n-1 fresh creditors, so
 * every participant pays a 0 -> non-zero SSTORE for `collateral` AND
 * `lastRound` (two 20,000-gas writes) on top of ecrecover and the event.
 *
 * | n  | m   | execution | intrinsic | total     | formula   | margin |
 * |----|-----|-----------|-----------|-----------|-----------|--------|
 * | 2  | 1   |   159,961 |    27,136 |   187,097 |   488,000 |  2.61x |
 * | 5  | 3   |   324,033 |    34,112 |   358,145 |   774,000 |  2.16x |
 * | 15 | 8   |   863,338 |    56,564 |   919,902 | 1,714,000 |  1.86x |
 * | 30 | 15  | 1,673,516 |    89,896 | 1,763,412 | 3,120,000 |  1.77x |
 * | 50 | 25  | 2,765,066 |   134,668 | 2,899,734 | 5,000,000 |  1.72x |
 * | 5  | 105 |   714,417 |    86,192 |   800,609 | 1,590,000 |  1.99x |
 * | 5  | 250 | 1,279,053 |   160,300 | 1,439,353 | 2,750,000 |  1.91x |
 *
 * Implied marginal costs: ~54,400 gas per participant and ~4,400 per id, both
 * intrinsic-inclusive. Explicit gas is mandatory on Arc: USDC is the gas
 * token, so estimation reserves the whole balance.
 */
export const EXECUTE_ROUND_GAS_BASE = 300_000n;
export const EXECUTE_ROUND_GAS_PER_PARTICIPANT = 90_000n;
export const EXECUTE_ROUND_GAS_PER_ID = 8_000n;

/**
 * redeemIOU flat gas limit — measured 199,604 with RING=16 fully populated by
 * 8-id manifests (forge snapshot, plan 02-05, 2026-07-23).
 *
 * B-WR-02: that measurement is a `gasleft()` delta and excludes intrinsic gas,
 * so the old "500,000 is 2.51x" claim was intrinsic-blind. At demo-scale
 * ~105-id manifests the sixteen bracketing proofs carry ~7 siblings each
 * instead of 3 — several KB of near-all-non-zero calldata — and the true
 * margin is far smaller (the audit derives ≈1.35x). Still covered on the
 * deployed RING=16 hubs, but this constant has NOT been re-measured at demo
 * scale: treat 500,000 as covered-but-not-comfortable until it is.
 */
export const REDEEM_IOU_GAS = 500_000n;

/**
 * executePvP gas formula coefficients — the two legs reuse the executeRound
 * coefficients above, so B-WR-01's under-provisioning (~1.0x margin at n=30
 * per leg, uncovered from n≥40) was entirely inherited from B-CR-03 and is
 * fixed by the corrected leg terms. These two constants cover the router's own
 * overhead: leg calldata, 2x hashRound recomputation, the union merge, and one
 * ECDSA recover per union member. Measured router-attributable execution is
 * ~298,000 at n=30 and ~525,000 at n=50 per bundle — the growth is per-union-
 * member and is what PVP_GAS_PER_UNION_SIG pays for, so the fixed base did not
 * need to move.
 *
 * Measured, intrinsic included (contracts/test/GasScaling.t.sol, both legs
 * over the same n participants so union = n):
 *
 * | n/leg | m/leg | execution | intrinsic | total     | formula    | margin |
 * |-------|-------|-----------|-----------|-----------|------------|--------|
 * | 3     | 10    |   559,152 |    52,692 |   611,844 |  1,695,000 |  2.77x |
 * | 5     | 105   | 1,779,054 |   160,488 | 1,939,542 |  3,605,000 |  1.86x |
 * | 30    | 15    | 3,645,115 |   204,332 | 3,849,447 |  7,040,000 |  1.83x |
 * | 50    | 25    | 6,054,934 |   322,900 | 6,377,834 | 11,100,000 |  1.74x |
 *
 * Explicit gas is mandatory on Arc: USDC is the gas token, so estimation
 * reserves the whole balance.
 */
export const PVP_ROUTER_GAS_BASE = 350_000n;
export const PVP_GAS_PER_UNION_SIG = 15_000n;

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
 * Does this id list hash to the root the chain committed to? Total: a list the
 * merkle builder refuses (unsorted, duplicated) is simply not a match, never a
 * throw — the caller is choosing between candidates, not validating input.
 */
function rootMatches(ids: Hex[], root: Hex): boolean {
  try {
    return merkleRoot(ids).toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}

/** Solidity enum order: BelowFirst = 0, AboveLast = 1, Bracket = 2. */
const KIND_TO_UINT = { belowFirst: 0, aboveLast: 1, bracket: 2 } as const;

function toAbiInclusion(p: InclusionProof) {
  return {
    leaf: p.leaf,
    index: BigInt(p.index),
    leafCount: BigInt(p.leafCount),
    siblings: p.siblings,
  };
}

/** TS proof → ABI tuple: index/leafCount widen to bigint, kind to its enum uint. */
function toAbiProof(p: NonInclusionProof) {
  return { kind: KIND_TO_UINT[p.kind], a: toAbiInclusion(p.a), b: toAbiInclusion(p.b) };
}

/** Typed wrapper around one ClearingHubV2 deployment. */
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
      abi: clearingHubV2Abi,
      functionName: "collateral",
      args: [participant],
    });
  }

  roundNonce(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubV2Abi, functionName: "roundNonce" })
      .then(BigInt);
  }

  token(): Promise<Address> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "token",
    });
  }

  /** Nonce of the round AFTER the participant's last consented round (0 = never). */
  lastRound(participant: Address): Promise<bigint> {
    return this.pub
      .readContract({
        address: this.hub,
        abi: clearingHubV2Abi,
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
      abi: clearingHubV2Abi,
      eventName: "RoundExecuted",
      args: { roundNonce },
      fromBlock,
    });
    return logs.flatMap((l) => (l.args.roundHash === undefined ? [] : [l.args.roundHash]));
  }

  /** Nullifier check: has this IOU id already been redeemed on-chain? */
  redeemed(id: Hex): Promise<boolean> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "redeemed",
      args: [id],
    });
  }

  /** Buffered manifest root at ring slot `nonce % RING`. */
  rootRing(slot: bigint): Promise<{ root: Hex; nonce: bigint; executedAt: bigint }> {
    return this.pub
      .readContract({
        address: this.hub,
        abi: clearingHubV2Abi,
        functionName: "rootRing",
        args: [slot],
      })
      .then(([root, nonce, executedAt]) => ({
        root,
        nonce: BigInt(nonce),
        executedAt: BigInt(executedAt),
      }));
  }

  /** On-chain IOU digest — parity-locked against the SDK's iouId. */
  hashIou(iou: Iou): Promise<Hex> {
    return this.pub.readContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "hashIou",
      args: [iou],
    });
  }

  /** The hub's RING immutable: how many executed-round roots stay buffered. */
  ringSize(): Promise<bigint> {
    return this.pub
      .readContract({ address: this.hub, abi: clearingHubV2Abi, functionName: "RING" })
      .then(BigInt);
  }

  /**
   * Reconstruct round `nonce`'s consumed-id manifest from settlement calldata.
   * The id list is signature-bound: the unanimously signed digest commits to
   * the merkle root the contract derived from this exact calldata, so a
   * creditor needs only an RPC endpoint — NEVER a coordinator endpoint, which
   * could serve a fabricated leaf set to break non-inclusion proofs.
   *
   * Two settlement shapes reach a hub (CR-02): a direct `executeRound`, and a
   * `PvPRouter.executePvP` bundle whose legs call `executeRound` internally.
   * For the latter the transaction input carries the ROUTER's selector, which
   * the hub ABI does not contain — decoding it against the hub ABI threw
   * AbiFunctionSignatureNotFoundError, and since prepareRedemptionProofs walks
   * every buffered nonce, one PvP settlement bricked redemption for the next
   * RING rounds. Both shapes are decoded here, and the selected leg is
   * confirmed by recomputing its merkle root against the `manifestHash` the
   * RoundExecuted log itself carries — so a bundle whose two legs share a
   * nonce across two hubs is disambiguated by the chain's own commitment, not
   * by argument position.
   */
  async fetchManifest(nonce: bigint): Promise<Hex[]> {
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
          `check HUB_V2_DEPLOY_BLOCK for hub ${this.hub}`,
      );
    }
    const logs = [];
    for (const [fromBlock, toBlock] of scanWindows(this.earliestBlock, latest, MAX_LOG_SCAN_SPAN)) {
      logs.push(
        ...(await this.pub.getContractEvents({
          address: this.hub,
          abi: clearingHubV2Abi,
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
    let hubCall: ReturnType<typeof decodeFunctionData<typeof clearingHubV2Abi>> | undefined;
    try {
      hubCall = decodeFunctionData({ abi: clearingHubV2Abi, data: tx.input });
    } catch {
      hubCall = undefined; // not a hub call — try the router shape below
    }
    if (hubCall !== undefined) {
      if (hubCall.functionName !== "executeRound") {
        throw new Error(`round ${nonce} tx ${tx.hash} is not an executeRound call`);
      }
      const ids = [...hubCall.args[3]];
      if (committedRoot !== undefined && !rootMatches(ids, committedRoot)) {
        throw new Error(
          `round ${nonce} tx ${tx.hash}: executeRound calldata does not hash to the logged manifestHash`,
        );
      }
      return ids;
    }

    // PvP settlement: the router called into this hub. Pick the leg the log
    // commits to — nonce narrows the candidates, the root decides.
    let routerCall: ReturnType<typeof decodeFunctionData<typeof pvpRouterAbi>>;
    try {
      routerCall = decodeFunctionData({ abi: pvpRouterAbi, data: tx.input });
    } catch {
      throw new Error(
        `round ${nonce} tx ${tx.hash} was settled by an unrecognised caller ` +
          `(neither ClearingHubV2 nor PvPRouter calldata)`,
      );
    }
    if (routerCall.functionName !== "executePvP") {
      throw new Error(`round ${nonce} tx ${tx.hash} is not an executePvP call`);
    }
    const legs = [routerCall.args[0], routerCall.args[1]];
    const candidates = legs.filter((l) => BigInt(l.nonce) === nonce);
    if (candidates.length === 0) {
      throw new Error(`round ${nonce} has no matching leg in PvP tx ${tx.hash}`);
    }
    const matched =
      committedRoot === undefined
        ? candidates
        : candidates.filter((l) => rootMatches([...l.consumedIds], committedRoot));
    if (matched.length !== 1) {
      throw new Error(
        `round ${nonce} tx ${tx.hash}: ${matched.length} PvP legs match the logged ` +
          `manifestHash — cannot identify this hub's leg`,
      );
    }
    return [...matched[0].consumedIds];
  }

  /**
   * Assemble the full contract-shaped proof array for redeeming `id`: the
   * buffered nonce range is derived from on-chain roundNonce/RING exactly as
   * redeemIOU derives it (ascending, count = min(roundNonce, RING)) — never
   * caller-chosen. Empty manifests yield the structurally-valid placeholder
   * (the contract short-circuits sentinel roots without reading content).
   * TOCTOU: if a round lands before the redemption mines, the contract's
   * count/position check reverts and the caller simply regenerates.
   */
  async prepareRedemptionProofs(id: Hex): Promise<NonInclusionProof[]> {
    const nonce = await this.roundNonce();
    const ring = await this.ringSize();
    const count = nonce < ring ? nonce : ring;
    const proofs: NonInclusionProof[] = [];
    for (let n = nonce - count; n < nonce; n++) {
      const ids = await this.fetchManifest(n);
      proofs.push(nonInclusionProof(ids, id));
    }
    return proofs;
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
      abi: clearingHubV2Abi,
      functionName: "hashRound",
      args: [p.roundNonce, p.participants, p.deltas, p.manifestHash],
    });
  }

  async deposit(wallet: WalletClient, amount: bigint): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
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
      abi: clearingHubV2Abi,
      functionName: "withdraw",
      args: [amount],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: 200_000n,
    });
  }

  /** Submit a fully consented round. Permissionless — any relayer works. */
  async executeRound(
    wallet: WalletClient,
    proposal: RoundProposal,
    signatures: Hex[],
  ): Promise<Hex> {
    const gas =
      EXECUTE_ROUND_GAS_BASE +
      EXECUTE_ROUND_GAS_PER_PARTICIPANT * BigInt(proposal.participants.length) +
      EXECUTE_ROUND_GAS_PER_ID * BigInt(proposal.consumedIds.length);
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "executeRound",
      args: [
        proposal.roundNonce,
        proposal.participants,
        proposal.deltas,
        proposal.consumedIds,
        signatures,
      ],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas,
    });
  }

  /** Redeem a stale-debtor IOU against the hub's buffered non-inclusion regime. */
  async redeemIOU(
    wallet: WalletClient,
    iou: Iou,
    sig: Hex,
    proofs: NonInclusionProof[],
  ): Promise<Hex> {
    return wallet.writeContract({
      address: this.hub,
      abi: clearingHubV2Abi,
      functionName: "redeemIOU",
      args: [iou, sig, proofs.map(toAbiProof)],
      chain: wallet.chain,
      account: wallet.account!,
      maxFeePerGas: MIN_MAX_FEE_PER_GAS,
      gas: REDEEM_IOU_GAS,
    });
  }
}

/** One leg as the router's executePvP consumes it: the embedded RoundProposal
 *  fields plus its collected consent signatures, ABI-tuple-shaped. */
function toAbiLeg(leg: RoundProposal, signatures: Hex[]) {
  return {
    nonce: leg.roundNonce,
    participants: leg.participants,
    deltas: leg.deltas,
    consumedIds: leg.consumedIds,
    signatures,
  };
}

/** Typed wrapper around one PvPRouter deployment: hub-pair reads, PvPRound
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
      abi: pvpRouterAbi,
      functionName: "hubUSDC",
    });
  }

  /** The immutable EURC-side hub the router was deployed against. */
  hubEURC(): Promise<Address> {
    return this.pub.readContract({
      address: this.router,
      abi: pvpRouterAbi,
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
      abi: pvpRouterAbi,
      functionName: "hashPvPRound",
      args: [usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator],
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
      PVP_ROUTER_GAS_BASE +
      2n * EXECUTE_ROUND_GAS_BASE +
      EXECUTE_ROUND_GAS_PER_PARTICIPANT *
        BigInt(proposal.usdcLeg.participants.length + proposal.eurcLeg.participants.length) +
      EXECUTE_ROUND_GAS_PER_ID *
        BigInt(proposal.usdcLeg.consumedIds.length + proposal.eurcLeg.consumedIds.length) +
      PVP_GAS_PER_UNION_SIG * BigInt(nUnion);
    return wallet.writeContract({
      address: this.router,
      abi: pvpRouterAbi,
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
