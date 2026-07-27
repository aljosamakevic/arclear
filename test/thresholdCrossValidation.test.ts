import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  attemptRound,
  type ConsentOutcome,
  type ConsentProvider,
} from "../demo/coordinator.js";
import { addr } from "../demo/flowModel.js";
import {
  availabilityUniforms,
  roundFlowBatch,
  simulateThresholdHistory,
  type ThresholdRoundRecord,
} from "../demo/thresholdModel.js";
import { iouId } from "../src/iou.js";
import { signConsent } from "../src/round.js";
import type { SignedIou } from "../src/types.js";

/**
 * D-02 faithfulness proof: drive the REAL attemptRound (real EIP-712 consent
 * signatures, injected providers, in-memory submit stub) over the SAME seeded
 * flow batches (roundFlowBatch / deriveRoundSeed) and the SAME availability
 * uniforms (availabilityUniforms) the pure model consumes, and assert the
 * per-round outcomes match the model EXACTLY.
 *
 * Tolerance criterion (recorded for CALIBRATION.md methodology): because both
 * sides consume identical seeded flows and identical availability draws, the
 * acceptance tolerance is EXACT equality — relative difference 0, bigint
 * equality on every volume. If any assertion here ever needs loosening, that
 * is a model-fidelity bug to fix in demo/thresholdModel.ts, NOT a tolerance
 * to widen.
 *
 * Address remapping: flowModel's synthetic member addresses cannot sign, so
 * member i's synthetic address is remapped to a deterministic viem account
 * (private key = hex(i+1) left-padded to 64 nibbles). netting never checks
 * IOU signatures, so net() consumes the exact same obligations on both sides.
 * Batches come from roundFlowBatch (round-unique ids) — NEVER raw
 * generateFlows, whose per-call id counter reset would corrupt model and
 * harness identically and hide the bug.
 *
 * Id remapping (CR-01): the real attemptRound derives ids from (hub, iou), so
 * the harness carries the model's round-tagged id into the IOU's `ref` field
 * and sets `.id` to the derived digest. `ref` is netting-inert, so the two
 * sides still consume identical obligations — the harness just gets real ids
 * instead of counters, and keeps the model's round-uniqueness property.
 */

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const NOW = 1_800_000_000n;
const TX_HASH = ("0x" + "ab".repeat(32)) as Hex;
const WINDOW_MS = 500;
const ROUNDS = 5;
const SEEDS = 10;
const DENSITY = 0.5;
const RECIPROCITY = 0.8;
const TIMEOUT = 240_000;

/** Aggregate guard stats across the p=0.9 cells (vacuous-run protection). */
const p09Stats = { settled2pass: 0, exclusions: 0 };

function expectedKind(
  attempt: Awaited<ReturnType<typeof attemptRound>>,
): ThresholdRoundRecord["kind"] | "empty" {
  if (attempt.outcome === "empty") return "empty";
  if (attempt.outcome === "aborted") return "aborted";
  return attempt.passCount === 1 ? "settled-1pass" : "settled-2pass";
}

async function runSeed(
  n: number,
  p: number,
  seed: number,
  stats?: { settled2pass: number; exclusions: number },
): Promise<void> {
  // Model side: the pure simulation over the shared draw streams.
  const history = simulateThresholdHistory({
    n,
    density: DENSITY,
    reciprocity: RECIPROCITY,
    seed,
    rounds: ROUNDS,
    uptime: p,
  });
  expect(history.records).toHaveLength(ROUNDS);

  // Real side: deterministic signing accounts, one per member index.
  const uniforms = availabilityUniforms(seed, ROUNDS, n);
  const accounts = Array.from({ length: n }, (_, i) =>
    privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}` as Hex),
  );
  // flowModel synthetic address (lowercase) -> real signing address.
  const remap = new Map<string, Address>();
  for (let i = 0; i < n; i++) remap.set(addr(i).toLowerCase(), accounts[i].address);

  const settledIds = new Set<Hex>();
  let openPool: SignedIou[] = [];
  // Providers close over the current round index — updated before each attempt.
  const roundRef = { r: 0 };

  const providers = new Map<string, ConsentProvider>();
  for (let i = 0; i < n; i++) {
    const account = accounts[i];
    providers.set(account.address.toLowerCase(), (proposal, excluded) => {
      // Pass detection: attemptRound passes [] in pass 1, the (always
      // non-empty) excluded batch in pass 2.
      const pass = excluded.length === 0 ? 1 : 2;
      const online = uniforms[roundRef.r * n * 2 + i * 2 + (pass - 1)] < p;
      // Offline = stall: a never-resolving promise, so the member can ONLY
      // manifest as a coordinator-deadline timeout — never as a refusal.
      if (!online) return new Promise<ConsentOutcome>(() => {});
      return (async (): Promise<ConsentOutcome> => ({
        kind: "consent",
        // Real EIP-712 signature — screenConsents demotes anything invalid to
        // a refusal, which would silently diverge from the model.
        signature: await signConsent(HUB, proposal, account, undefined),
      }))();
    });
  }

  let modelCumulative = 0n;
  let realCumulative = 0n;

  for (let r = 0; r < ROUNDS; r++) {
    roundRef.r = r;
    // SAME batch as the model (round-unique ids), addresses remapped only.
    const batch = roundFlowBatch(seed, r, { n, density: DENSITY, reciprocity: RECIPROCITY });
    for (const s of batch) {
      // CR-01: the real attemptRound DERIVES ids from (hub, iou), so the
      // harness must hand it structurally real paper. The model's round-tagged
      // synthetic id becomes the IOU's `ref` — a bytes32 field inside the
      // digest — which reproduces the model's round-uniqueness property
      // (identical flows in different rounds stay distinct obligations)
      // without touching any netting-relevant field.
      const iou = {
        ...s.iou,
        debtor: remap.get(s.iou.debtor.toLowerCase())!,
        creditor: remap.get(s.iou.creditor.toLowerCase())!,
        ref: s.id,
      };
      openPool.push({ ...s, iou, id: iouId(HUB, iou) });
    }

    const attempt = await attemptRound({
      hub: HUB,
      roundNonce: BigInt(r),
      openIous: openPool,
      settledIds,
      providers,
      windowMs: WINDOW_MS,
      now: NOW,
      submit: async () => TX_HASH,
    });

    const record = history.records[r];
    expect(record.kind).toBe(expectedKind(attempt));

    if (attempt.outcome === "empty") continue;

    // An offline member must ALWAYS manifest as a timeout — any refusal means
    // consent signing or verification broke (a diagnosable failure, not a
    // tolerance case).
    expect(attempt.pass1.refused).toEqual([]);
    // Excluded-set MEMBERSHIP through the remap, not just size (WR-04): an
    // aborted round consumes nothing, so a same-size wrong-membership
    // divergence would leave both pools identical and pass every later check.
    const expectedExcluded = record.excluded.map((a) => remap.get(a)!.toLowerCase()).sort();
    expect(attempt.excluded.map((a) => a.toLowerCase()).sort()).toEqual(expectedExcluded);
    if (stats && attempt.excluded.length > 0) stats.exclusions++;

    if (attempt.outcome !== "settled") continue;

    // EXACT bigint equality — the faithfulness proof.
    expect(attempt.result.settledVolume).toBe(record.settledVolume);
    expect(attempt.result.grossVolume).toBe(record.grossVolume);
    expect(attempt.proposal.consumedIds.length).toBe(record.consumedCount);

    // Per-member delta equality through the remap (WR-04): the settled
    // round's exact per-member allocation, not just its aggregate volumes.
    const actualDeltas = new Map<string, bigint>();
    attempt.result.participants.forEach((member, i) =>
      actualDeltas.set(member.toLowerCase(), attempt.result.deltas[i]),
    );
    const expectedDeltas = new Map<string, bigint>();
    for (const [member, delta] of record.deltas) {
      expectedDeltas.set(remap.get(member)!.toLowerCase(), delta);
    }
    expect(actualDeltas).toEqual(expectedDeltas);

    modelCumulative += record.settledVolume;
    realCumulative += attempt.result.settledVolume;
    if (stats && attempt.passCount === 2) stats.settled2pass++;

    // Fold consumed ids exactly as Coordinator.runRound does, then prune the
    // pool (value-neutral: net() rule 3 drops settled ids anyway — this
    // mirrors the model's own pruning and Coordinator.openIous).
    for (const id of attempt.proposal.consumedIds) settledIds.add(id.toLowerCase() as Hex);
    openPool = openPool.filter((s) => !settledIds.has(s.id.toLowerCase() as Hex));
  }

  // Cumulative settled volume over the whole history — exact bigint equality.
  expect(realCumulative).toBe(modelCumulative);
}

describe("threshold model vs real attemptRound — exact-match cross-validation (D-02)", () => {
  it(
    "n=5, p=1.0 — every round settles 1-pass, volumes exactly equal",
    { timeout: TIMEOUT },
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) await runSeed(5, 1.0, seed);
    },
  );

  it(
    "n=15, p=1.0 — every round settles 1-pass, volumes exactly equal",
    { timeout: TIMEOUT },
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) await runSeed(15, 1.0, seed);
    },
  );

  it(
    "n=5, p=0.9 — exclusions, 2-pass settles and aborts match exactly",
    { timeout: TIMEOUT },
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) await runSeed(5, 0.9, seed, p09Stats);
    },
  );

  it(
    "n=15, p=0.9 — exclusions, 2-pass settles and aborts match exactly",
    { timeout: TIMEOUT },
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) await runSeed(15, 0.9, seed, p09Stats);
    },
  );

  it("p=0.9 cells were not vacuous: at least one 2-pass settle and one exclusion", () => {
    // Guard against an all-online run silently proving nothing about the
    // exclude-and-recompute path.
    expect(p09Stats.settled2pass).toBeGreaterThanOrEqual(1);
    expect(p09Stats.exclusions).toBeGreaterThanOrEqual(1);
  });
});
