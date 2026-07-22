import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signIou } from "../src/iou.js";
import { net } from "../src/netting.js";
import {
  buildProposal,
  rebuildProposal,
  roundDigest,
  signConsent,
  verifyConsent,
  verifyProposal,
} from "../src/round.js";
import type { Iou, RoundProposal, SignedIou } from "../src/types.js";
import {
  applyMissSemantics,
  attemptRound,
  collectConsents,
  type ConsentOutcome,
  type ConsentProvider,
} from "../demo/coordinator.js";

const HUB = "0x1111111111111111111111111111111111111111" as Address;
const NOW = 1_800_000_000n;
const FUTURE = NOW + 3_600n;

const ADDRS: Address[] = Array.from(
  { length: 6 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
);

/** Test IOUs don't need real signatures — the engine keys on `id`. */
function fakeIou(
  debtor: Address,
  creditor: Address,
  amount: bigint,
  nonce: bigint,
  expiry: bigint = FUTURE,
): SignedIou {
  const id = keccak256(
    toHex(`${debtor}|${creditor}|${amount}|${nonce}|${expiry}`),
  ) as Hex;
  return {
    iou: { debtor, creditor, amount, nonce, expiry, ref: id },
    signature: "0x",
    id,
  };
}

const arbIou = fc
  .record({
    d: fc.integer({ min: 0, max: 5 }),
    c: fc.integer({ min: 0, max: 5 }),
    amount: fc.bigInt({ min: 1n, max: 10_000_000n }),
    nonce: fc.bigInt({ min: 0n, max: 1_000n }),
  })
  .filter(({ d, c }) => d !== c)
  .map(({ d, c, amount, nonce }) => fakeIou(ADDRS[d], ADDRS[c], amount, nonce));

const arbIous = fc.array(arbIou, { minLength: 0, maxLength: 200 });

/** Arbitrary excluded-member subset — never everyone (a round needs ≥2 members). */
const arbStalled = fc.subarray(ADDRS, { maxLength: ADDRS.length - 2 });

describe("rebuildProposal properties", () => {
  it("rebuild deltas always sum to zero (CONS-05)", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const { result } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        expect(result.deltas.reduce((a, b) => a + b, 0n)).toBe(0n);
      }),
    );
  });

  it("no excluded address in rebuilt participants (CONS-02)", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const ex = new Set(excluded.map((a) => a.toLowerCase()));
        const { result } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        for (const p of result.participants) {
          expect(ex.has(p.toLowerCase())).toBe(false);
        }
      }),
    );
  });

  it("no consumed id touches an excluded member (CONS-02)", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const ex = new Set(excluded.map((a) => a.toLowerCase()));
        const byId = new Map(ious.map((s) => [s.id.toLowerCase(), s]));
        const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        for (const id of proposal.consumedIds) {
          const s = byId.get(id.toLowerCase());
          expect(s).toBeDefined();
          expect(ex.has(s!.iou.debtor.toLowerCase())).toBe(false);
          expect(ex.has(s!.iou.creditor.toLowerCase())).toBe(false);
        }
      }),
    );
  });

  it("is deterministic under input shuffling", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, fc.infiniteStream(fc.nat()), (ious, excluded, rand) => {
        const shuffled = [...ious];
        const it_ = rand[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (it_.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const a = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
        const b = rebuildProposal(HUB, 0n, shuffled, excluded, { now: NOW });
        expect(b.proposal.participants).toEqual(a.proposal.participants);
        expect(b.proposal.deltas).toEqual(a.proposal.deltas);
        expect(b.proposal.manifestHash).toBe(a.proposal.manifestHash);
        expect(b.proposal.digest).toBe(a.proposal.digest);
      }),
    );
  });

  it("cascade: a member whose only IOUs touch an excluded member drops out", () => {
    // B's only paper touches A (excluded). C↔D keep the round alive.
    // Rule 6: no consumed IOUs → B never appears in the rebuilt set.
    const ious = [
      fakeIou(ADDRS[0], ADDRS[1], 10n, 1n),
      fakeIou(ADDRS[2], ADDRS[3], 5n, 1n),
    ];
    const { result } = rebuildProposal(HUB, 0n, ious, [ADDRS[0]], { now: NOW });
    const lower = result.participants.map((p) => p.toLowerCase());
    expect(lower).not.toContain(ADDRS[0].toLowerCase());
    expect(lower).not.toContain(ADDRS[1].toLowerCase());
    expect(lower).toEqual([ADDRS[2].toLowerCase(), ADDRS[3].toLowerCase()]);
  });

  it("settled ids never appear in rebuilt consumedIds", () => {
    fc.assert(
      fc.property(arbIous, arbStalled, (ious, excluded) => {
        const settled = new Set<Hex>(
          ious.filter((_, i) => i % 2 === 0).map((s) => s.id.toLowerCase() as Hex),
        );
        const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, {
          now: NOW,
          settledIds: settled,
        });
        for (const id of proposal.consumedIds) {
          expect(settled.has(id.toLowerCase() as Hex)).toBe(false);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Task 2: excluded-aware verifyProposal — honest rebuilds verify, every
// modeled coordinator lie is refused with a diagnostic reason.
// ---------------------------------------------------------------------------

const alice = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const bob = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
const carol = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);

function iou(debtor: Address, creditor: Address, amount: bigint, nonce = 1n): Iou {
  return {
    debtor,
    creditor,
    amount,
    nonce,
    expiry: NOW + 86_400n,
    ref: ("0x" + "00".repeat(32)) as Hex,
  };
}

/** Four real signed IOUs among alice/bob/carol; excluding carol changes every delta. */
async function threeMemberEconomy(): Promise<SignedIou[]> {
  return [
    await signIou(HUB, iou(alice.address, bob.address, 100n), alice),
    await signIou(HUB, iou(bob.address, alice.address, 30n), bob),
    await signIou(HUB, iou(carol.address, alice.address, 50n), carol),
    await signIou(HUB, iou(bob.address, carol.address, 20n), bob),
  ];
}

describe("verifyProposal with excluded set", () => {
  it("honest rebuild verifies for every remaining participant", async () => {
    const ious = await threeMemberEconomy();
    const excluded = [carol.address];
    const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
    for (const account of [alice, bob]) {
      const check = verifyProposal(HUB, proposal, ious, account.address, {
        now: NOW,
        excluded,
      });
      expect(check.ok).toBe(true);
    }
  });

  it("refuses when self is in the excluded set", async () => {
    const ious = await threeMemberEconomy();
    const excluded = [carol.address];
    const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
    const check = verifyProposal(HUB, proposal, ious, carol.address, {
      now: NOW,
      excluded,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/excluded/);
  });

  it("refuses when an excluded address appears in participants", async () => {
    const ious = await threeMemberEconomy();
    const excluded = [carol.address];
    const { proposal } = rebuildProposal(HUB, 0n, ious, excluded, { now: NOW });
    // Lying coordinator: sneak the excluded address back into participants with
    // a zero delta and recompute manifestHash + digest so only this check fires.
    const participants = [...proposal.participants, carol.address];
    const deltas = [...proposal.deltas, 0n];
    const p = {
      roundNonce: proposal.roundNonce,
      participants,
      deltas,
      manifestHash: proposal.manifestHash,
    };
    const tampered = {
      ...p,
      digest: roundDigest(HUB, p),
      consumedIds: proposal.consumedIds,
    };
    const check = verifyProposal(HUB, tampered, ious, alice.address, {
      now: NOW,
      excluded,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/excluded/);
  });

  it("withheld exclusion produces a delta mismatch refusal", async () => {
    const ious = await threeMemberEconomy();
    const { proposal } = rebuildProposal(HUB, 0n, ious, [carol.address], { now: NOW });
    // Participant is NOT told who was dropped: local net() over the unfiltered
    // view disagrees with the rebuilt deltas — zero-trust refusal.
    const check = verifyProposal(HUB, proposal, ious, alice.address, { now: NOW });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/delta mismatch/);
  });

  it("consent signatures bind to the rebuilt digest, never replay from pass 1", async () => {
    const ious = await threeMemberEconomy();
    const pass1 = buildProposal(HUB, 0n, net(ious, { now: NOW }));
    const { proposal: rebuilt } = rebuildProposal(HUB, 0n, ious, [carol.address], {
      now: NOW,
    });
    expect(rebuilt.digest).not.toBe(pass1.digest);

    const consent = await signConsent(HUB, rebuilt, alice);
    expect(await verifyConsent(HUB, rebuilt, alice.address, consent)).toBe(true);
    expect(await verifyConsent(HUB, rebuilt, bob.address, consent)).toBe(false);

    // A pass-1 consent can never be replayed against the pass-2 digest.
    const consent1 = await signConsent(HUB, pass1, alice);
    expect(await verifyConsent(HUB, rebuilt, alice.address, consent1)).toBe(false);
  });

  it("omitted excluded opt keeps pass-1 semantics for existing callers", async () => {
    const ious = await threeMemberEconomy();
    const pass1 = buildProposal(HUB, 0n, net(ious, { now: NOW }));
    for (const account of [alice, bob, carol]) {
      const check = verifyProposal(HUB, pass1, ious, account.address, { now: NOW });
      expect(check.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 03 Task 1: collectConsents — wall-clock window with deterministic
// timeout snapshot (CONS-01, D-02), refusal-as-data (D-07), miss semantics
// (D-06/D-07). Providers are injected fakes; windows are ms-scale.
// ---------------------------------------------------------------------------

/** collectConsents only reads `participants`; everything else is inert. */
function fakeProposal(participants: Address[]): RoundProposal {
  return {
    roundNonce: 0n,
    participants,
    deltas: participants.map(() => 0n),
    manifestHash: ("0x" + "00".repeat(32)) as Hex,
    digest: ("0x" + "00".repeat(32)) as Hex,
    consumedIds: [],
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function consentAfter(ms: number, signature: Hex): ConsentProvider {
  return async () => {
    await delay(ms);
    return { kind: "consent", signature };
  };
}

describe("collectConsents window (CONS-01)", () => {
  const members = ADDRS.slice(0, 3);

  it("all consent before deadline: resolves early with no timeouts", async () => {
    const providers = new Map<string, ConsentProvider>(
      members.map((a, i) => [a.toLowerCase(), consentAfter(5, `0x0${i + 1}` as Hex)]),
    );
    const started = Date.now();
    const out = await collectConsents(fakeProposal(members), [], providers, 50);
    // Early completion clears the deadline timer — well before the window.
    expect(Date.now() - started).toBeLessThan(45);
    expect(out.consents.size).toBe(3);
    expect(out.refused).toEqual([]);
    expect(out.timedOut).toEqual([]);
  });

  it("stalled provider is snapshotted as timed out at the deadline", async () => {
    const providers = new Map<string, ConsentProvider>([
      [members[0].toLowerCase(), consentAfter(2, "0x01")],
      [members[1].toLowerCase(), consentAfter(2, "0x02")],
      [members[2].toLowerCase(), () => new Promise(() => {})],
    ]);
    const out = await collectConsents(fakeProposal(members), [], providers, 30);
    expect(out.timedOut.map((a) => a.toLowerCase())).toEqual([members[2].toLowerCase()]);
    expect(out.consents.size).toBe(2);
    // consents/refused/timedOut partition the member set exactly.
    expect(out.consents.size + out.refused.length + out.timedOut.length).toBe(members.length);
  });

  it("refusal is data with its reason, never a throw", async () => {
    const providers = new Map<string, ConsentProvider>([
      [members[0].toLowerCase(), consentAfter(2, "0x01")],
      [members[1].toLowerCase(), async () => ({ kind: "refusal", reason: "delta mismatch" })],
      [members[2].toLowerCase(), consentAfter(2, "0x03")],
    ]);
    const out = await collectConsents(fakeProposal(members), [], providers, 50);
    expect(out.refused).toEqual([{ address: members[1], reason: "delta mismatch" }]);
    expect(out.consents.size).toBe(2);
    expect(out.timedOut).toEqual([]);
  });

  it("late consent after the snapshot mutates nothing (D-02)", async () => {
    const windowMs = 25;
    const providers = new Map<string, ConsentProvider>([
      [members[0].toLowerCase(), consentAfter(2, "0x01")],
      [members[1].toLowerCase(), consentAfter(2, "0x02")],
      [members[2].toLowerCase(), consentAfter(windowMs + 20, "0x03")],
    ]);
    const out = await collectConsents(fakeProposal(members), [], providers, windowMs);
    expect(out.timedOut.map((a) => a.toLowerCase())).toEqual([members[2].toLowerCase()]);
    const before = new Map(out.consents);
    await delay(40); // let the late provider settle — snapshot must be immutable
    expect(out.consents).toEqual(before);
    expect(out.consents.size + out.refused.length + out.timedOut.length).toBe(members.length);
  });

  it("miss semantics D-06/D-07: timeout increments, consent resets, refusal unchanged", () => {
    const missed = new Map<string, number>([
      [members[0].toLowerCase(), 2],
      [members[1].toLowerCase(), 1],
      [members[2].toLowerCase(), 3],
    ]);
    applyMissSemantics(missed, {
      consents: new Map([[members[0].toLowerCase(), "0x01" as Hex]]),
      refused: [{ address: members[1], reason: "delta mismatch" }],
      timedOut: [members[2]],
    });
    expect(missed.get(members[0].toLowerCase())).toBe(0); // consent → reset
    expect(missed.get(members[1].toLowerCase())).toBe(1); // refusal → unchanged
    expect(missed.get(members[2].toLowerCase())).toBe(4); // timeout → increment
  });
});

// ---------------------------------------------------------------------------
// Plan 03 Task 3: two-pass state machine invariants — CONS-03 end-to-end
// unanimity, CONS-04 sequence, quorum floor (D-01), pass-2 abort (D-03).
// Real accounts (repeated-byte keys) so consent signatures genuinely verify.
// ---------------------------------------------------------------------------

const dave = privateKeyToAccount(("0x" + "44".repeat(32)) as Hex);
const erin = privateKeyToAccount(("0x" + "55".repeat(32)) as Hex);
const ACCOUNTS = [alice, bob, carol, dave, erin];
const REAL_ADDRS = ACCOUNTS.map((a) => a.address);

const arbRealIou = fc
  .record({
    d: fc.integer({ min: 0, max: 4 }),
    c: fc.integer({ min: 0, max: 4 }),
    amount: fc.bigInt({ min: 1n, max: 10_000_000n }),
    nonce: fc.bigInt({ min: 0n, max: 1_000n }),
  })
  .filter(({ d, c }) => d !== c)
  .map(({ d, c, amount, nonce }) => fakeIou(REAL_ADDRS[d], REAL_ADDRS[c], amount, nonce));

const arbRealIous = fc.array(arbRealIou, { minLength: 0, maxLength: 40 });
const arbStalledReal = fc.subarray(REAL_ADDRS, { maxLength: REAL_ADDRS.length - 2 });
const arbRefusingReal = fc.subarray(REAL_ADDRS, { maxLength: REAL_ADDRS.length - 2 });

/**
 * Provider harness: stalled → never resolve; refusing → refusal outcome;
 * honest → verifyProposal (passing the excluded list through to
 * opts.excluded — exercising the Plan 01 seam end-to-end) then signConsent.
 * `stalledPass2` members answer pass 1 but stall once an excluded list exists.
 */
function mkProviders(
  accounts: typeof ACCOUNTS,
  behavior: { stalled?: Address[]; refusing?: Address[]; stalledPass2?: Address[] },
  hub: Address,
  ious: SignedIou[],
  settledIds: ReadonlySet<Hex>,
  opts: { now: bigint },
): Map<string, ConsentProvider> {
  const stalled = new Set((behavior.stalled ?? []).map((a) => a.toLowerCase()));
  const refusing = new Set((behavior.refusing ?? []).map((a) => a.toLowerCase()));
  const stalledPass2 = new Set((behavior.stalledPass2 ?? []).map((a) => a.toLowerCase()));
  const providers = new Map<string, ConsentProvider>();
  for (const account of accounts) {
    const key = account.address.toLowerCase();
    providers.set(key, (proposal, excluded) => {
      if (stalled.has(key)) return new Promise<ConsentOutcome>(() => {});
      if (excluded.length > 0 && stalledPass2.has(key)) {
        return new Promise<ConsentOutcome>(() => {});
      }
      if (refusing.has(key)) {
        return Promise.resolve<ConsentOutcome>({ kind: "refusal", reason: "injected refusal" });
      }
      return (async (): Promise<ConsentOutcome> => {
        const check = verifyProposal(hub, proposal, ious, account.address, {
          now: opts.now,
          settledIds,
          excluded,
        });
        if (!check.ok) return { kind: "refusal", reason: check.reason ?? "verify failed" };
        return { kind: "consent", signature: await signConsent(hub, proposal, account) };
      })();
    });
  }
  return providers;
}

/** Recording submit: captures every call, returns a fake tx hash. */
function mkSubmit() {
  const calls: { proposal: RoundProposal; signatures: Hex[] }[] = [];
  const submit = async (proposal: RoundProposal, signatures: Hex[]): Promise<Hex> => {
    calls.push({ proposal, signatures });
    return ("0x" + "ab".repeat(32)) as Hex;
  };
  return { calls, submit };
}

describe("two-pass state machine", () => {
  it(
    "CONS-03: whatever is submitted is unanimously signed over the exact executed set",
    async () => {
      // numRuns capped at 25: each run does real EIP-712 signing plus up to two
      // ~15ms wall-clock windows — the cap keeps the async property under ~30s.
      await fc.assert(
        fc.asyncProperty(
          arbRealIous,
          arbStalledReal,
          arbRefusingReal,
          async (ious, stalled, refusing) => {
            const settledIds = new Set<Hex>();
            const providers = mkProviders(ACCOUNTS, { stalled, refusing }, HUB, ious, settledIds, {
              now: NOW,
            });
            const { calls, submit } = mkSubmit();
            const outcome = await attemptRound({
              hub: HUB,
              roundNonce: 0n,
              openIous: ious,
              settledIds,
              providers,
              windowMs: 15,
              now: NOW,
              submit,
            });
            if (outcome.outcome === "settled") {
              expect(calls.length).toBe(1);
              const { proposal, signatures } = calls[0];
              // Unanimity over the SUBMITTED digest, index-aligned (CONS-03).
              expect(signatures.length).toBe(proposal.participants.length);
              for (let i = 0; i < proposal.participants.length; i++) {
                expect(
                  await verifyConsent(HUB, proposal, proposal.participants[i], signatures[i]),
                ).toBe(true);
              }
              // Every address with a nonzero delta in the executed set is a participant.
              const { result } = rebuildProposal(HUB, 0n, ious, outcome.excluded, {
                now: NOW,
                settledIds: new Set<Hex>(),
              });
              const submitted = new Set(proposal.participants.map((a) => a.toLowerCase()));
              result.participants.forEach((p, i) => {
                if (result.deltas[i] !== 0n) expect(submitted.has(p.toLowerCase())).toBe(true);
              });
            } else {
              // Aborted or empty: nothing submitted, settledIds mirror untouched.
              expect(calls.length).toBe(0);
              expect(settledIds.size).toBe(0);
            }
          },
        ),
        { numRuns: 25 },
      );
    },
    30_000,
  );

  it("CONS-04 sequence: excluded member's IOUs settle next round; manifests disjoint", async () => {
    const [a, b, c, d, e] = ACCOUNTS;
    // a/b/c form a cycle; d↔e only trade with each other. Stalling e drops
    // both d↔e IOUs (cascade: d's only paper touches e).
    const ious = [
      fakeIou(a.address, b.address, 100n, 1n),
      fakeIou(b.address, c.address, 80n, 1n),
      fakeIou(c.address, a.address, 50n, 1n),
      fakeIou(d.address, e.address, 30n, 1n),
      fakeIou(e.address, d.address, 10n, 1n),
    ];
    const settledIds = new Set<Hex>();

    // Round n: e stalls.
    const p1 = mkProviders(ACCOUNTS, { stalled: [e.address] }, HUB, ious, settledIds, { now: NOW });
    const s1 = mkSubmit();
    const o1 = await attemptRound({
      hub: HUB,
      roundNonce: 0n,
      openIous: ious,
      settledIds,
      providers: p1,
      windowMs: 50,
      now: NOW,
      submit: s1.submit,
    });
    expect(o1.outcome).toBe("settled");
    if (o1.outcome !== "settled") return;
    expect(o1.passCount).toBe(2);
    expect(o1.excluded.map((x) => x.toLowerCase())).toEqual([e.address.toLowerCase()]);
    const manifestN = o1.proposal.consumedIds.map((id) => id.toLowerCase());
    // e's (and cascaded d's) IOUs stay open — absent from manifest n.
    expect(manifestN).not.toContain(ious[3].id.toLowerCase());
    expect(manifestN).not.toContain(ious[4].id.toLowerCase());
    // Mimic the coordinator: consumed ids join settledIds ONLY now.
    for (const id of o1.proposal.consumedIds) settledIds.add(id.toLowerCase() as Hex);
    expect(settledIds.has(ious[3].id.toLowerCase() as Hex)).toBe(false);
    expect(settledIds.has(ious[4].id.toLowerCase() as Hex)).toBe(false);

    // Round n+1: everyone honest over the still-open IOUs.
    const p2 = mkProviders(ACCOUNTS, {}, HUB, ious, settledIds, { now: NOW });
    const s2 = mkSubmit();
    const o2 = await attemptRound({
      hub: HUB,
      roundNonce: 1n,
      openIous: ious,
      settledIds,
      providers: p2,
      windowMs: 50,
      now: NOW,
      submit: s2.submit,
    });
    expect(o2.outcome).toBe("settled");
    if (o2.outcome !== "settled") return;
    const manifestN1 = o2.proposal.consumedIds.map((id) => id.toLowerCase());
    expect(manifestN1).toContain(ious[3].id.toLowerCase());
    expect(manifestN1).toContain(ious[4].id.toLowerCase());
    // manifest_n ∩ manifest_{n+1} === ∅ (CONS-04).
    const first = new Set(manifestN);
    for (const id of manifestN1) expect(first.has(id)).toBe(false);
  });

  it(
    "never settles twice: sequential settled rounds consume disjoint id sets",
    async () => {
      await fc.assert(
        fc.asyncProperty(arbRealIous, arbStalledReal, async (ious, stalled) => {
          const settledIds = new Set<Hex>();
          const manifests: string[][] = [];

          const p1 = mkProviders(ACCOUNTS, { stalled }, HUB, ious, settledIds, { now: NOW });
          const s1 = mkSubmit();
          const o1 = await attemptRound({
            hub: HUB,
            roundNonce: 0n,
            openIous: ious,
            settledIds,
            providers: p1,
            windowMs: 15,
            now: NOW,
            submit: s1.submit,
          });
          if (o1.outcome === "settled") {
            manifests.push(o1.proposal.consumedIds.map((id) => id.toLowerCase()));
            for (const id of o1.proposal.consumedIds) settledIds.add(id.toLowerCase() as Hex);
          }

          const p2 = mkProviders(ACCOUNTS, {}, HUB, ious, settledIds, { now: NOW });
          const s2 = mkSubmit();
          const o2 = await attemptRound({
            hub: HUB,
            roundNonce: 1n,
            openIous: ious,
            settledIds,
            providers: p2,
            windowMs: 30,
            now: NOW,
            submit: s2.submit,
          });
          if (o2.outcome === "settled") {
            manifests.push(o2.proposal.consumedIds.map((id) => id.toLowerCase()));
          }

          if (manifests.length === 2) {
            const first = new Set(manifests[0]);
            for (const id of manifests[1]) expect(first.has(id)).toBe(false);
          }
        }),
        { numRuns: 15 },
      );
    },
    30_000,
  );

  it("quorum abort D-01: rebuild below 2 participants aborts, submit never called", async () => {
    const [a, b, c] = ACCOUNTS;
    // c is on every IOU: excluding c leaves nothing to net.
    const ious = [
      fakeIou(a.address, c.address, 10n, 1n),
      fakeIou(b.address, c.address, 20n, 1n),
    ];
    const settledIds = new Set<Hex>();
    const providers = mkProviders(ACCOUNTS, { stalled: [c.address] }, HUB, ious, settledIds, {
      now: NOW,
    });
    const { calls, submit } = mkSubmit();
    const outcome = await attemptRound({
      hub: HUB,
      roundNonce: 0n,
      openIous: ious,
      settledIds,
      providers,
      windowMs: 50,
      now: NOW,
      submit,
    });
    expect(outcome.outcome).toBe("aborted");
    if (outcome.outcome !== "aborted") return;
    expect(outcome.reason).toMatch(/quorum/);
    expect(calls.length).toBe(0);
    expect(settledIds.size).toBe(0);
  });

  it("pass-2 stall aborts D-03: consented pass 1, stalled pass 2 — nothing settles", async () => {
    const [a, b, c, d] = ACCOUNTS;
    const ious = [
      fakeIou(a.address, b.address, 100n, 1n),
      fakeIou(b.address, c.address, 50n, 1n),
      fakeIou(c.address, a.address, 30n, 1n),
      fakeIou(a.address, d.address, 10n, 1n),
    ];
    const settledIds = new Set<Hex>();
    // d stalls pass 1 (forces the rebuild); b consents pass 1 but stalls pass 2.
    const providers = mkProviders(
      ACCOUNTS,
      { stalled: [d.address], stalledPass2: [b.address] },
      HUB,
      ious,
      settledIds,
      { now: NOW },
    );
    const { calls, submit } = mkSubmit();
    const outcome = await attemptRound({
      hub: HUB,
      roundNonce: 0n,
      openIous: ious,
      settledIds,
      providers,
      windowMs: 50,
      now: NOW,
      submit,
    });
    expect(outcome.outcome).toBe("aborted");
    if (outcome.outcome !== "aborted") return;
    expect(outcome.passCount).toBe(2);
    expect(outcome.reason).toMatch(/pass 2/);
    expect(calls.length).toBe(0);
    expect(settledIds.size).toBe(0);
  });
});
