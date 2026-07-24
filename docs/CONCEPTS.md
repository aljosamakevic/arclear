# Arclear concepts

A short conceptual companion to the [README](../README.md). The README is the
scannable landing page; the depth lives here. Normative protocol rules live in
[PROTOCOL.md](PROTOCOL.md) — where this doc and the spec differ, the spec wins.

## 1. Vocabulary

- **Debtor / creditor** — canonical definitions live in
  [PROTOCOL.md → Roles](PROTOCOL.md#roles) (this doc does not redefine them).
  In short: the **debtor** owes and **signs the IOU** — the signature is them
  admitting the debt and authorizing that their collateral can be reduced by
  it; the **creditor** is owed. Roles are per-IOU and flip all day; those
  flip-flopping positions are exactly what nets out.
- **IOU** — one signed off-chain obligation: `debtor owes creditor amount`,
  with a per-pair nonce, an expiry, and an opaque `ref` linking it to the
  business event. Its canonical id is the EIP-712 digest the debtor signed.
- **Round** — one atomic settlement: a canonical participant set, index-aligned
  net **deltas** that sum to exactly zero, and a manifest committing to the
  exact IOU ids consumed. Every affected participant signs the same digest
  over the full arrays.
- **Delta** — a participant's net position in a round, in token base units
  (bigint / int256; no division exists anywhere in the protocol). Negative =
  net debtor (collateral debited), positive = net creditor (collateral
  credited), zero = flows cancelled exactly (they still sign — consent is what
  extinguishes their paper).
- **Coordinator** — any process that relays IOUs, computes nettings, and
  assembles rounds. It holds **no keys and no authority**; anyone can run one.

## 2. The two-layer capital model

Arclear is **collateralized**. "Netting efficiency" means *post your net, not
your gross* — never *post nothing*.

**Layer 1 — on-chain collateral (posted upfront, real funds locked).** You
`deposit()` into the hub before you're a credible counterparty. A net debtor
whose collateral doesn't cover their net debit makes the round *revert*
(`InsufficientCollateral`). You size this to your **net** position, which
netting keeps far below your gross turnover.

**Layer 2 — off-chain inter-party credit (the tab, between settlements).**
When a creditor renders service and accepts a signed IOU instead of immediate
payment, they are *extending credit* — holding a promise, not cash. No token
moves. This is what lets obligations pile up and cancel. The creditor's
exposure in this window is bounded and backed four ways:

1. **Credit caps** cap the maximum loss to any one counterparty.
2. **Posted collateral backs the credit** — it's what makes your IOUs
   credible; more deposited → more credit others will extend you.
3. **`redeemIOU`** lets a creditor recover from a vanished debtor's collateral
   (best-effort; races the never-pausable `withdraw`).
4. **Round frequency** shrinks the credit window.

**Worked example, symmetric ($0 net).** A owes B $500 and B owes A $500 by end
of day. Net position: **$0 each**. Neither side needs collateral for this pair
beyond dust; the entire $1,000 of gross obligations cancels and nothing
settles on-chain. Under a prepaid rail, each side would have kept ~$500
funded all day to make the same payments.

**Worked example, asymmetric ($200 net).** A owes B $500, B owes A $300: net
is A owes B **$200**. A needs collateral ≥ **$200** (the net), not $500 (the
gross). During the day, B's exposure to A is the unsettled tab — bounded by
A's credit cap, backed by A's posted collateral, recoverable via `redeemIOU`
if A goes dark, and shrunk by settling more often.

## 3. Why a coordinator can't cheat

The coordinator is a convenience, not an authority. Three facts make it
structurally harmless:

1. **It holds no keys.** It cannot forge an IOU (only the debtor's signature
   creates one) and cannot forge consent (only each participant's signature
   over the round digest counts). `executeRound` is permissionless — the
   coordinator has no privileged on-chain role at all.
2. **Every participant recomputes before signing.** `verifyProposal` re-runs
   the published, deterministic netting spec over the IOUs the participant
   has seen and compares the result — participants *never trust* the
   coordinator's arithmetic. A proposal with wrong deltas, a padded
   participant list, or a doctored manifest fails local recomputation and is
   refused.
3. **One digest, signed by everyone.** All participants sign the *same*
   EIP-712 digest over the full position set. A coordinator cannot show
   different data to different signers: any inconsistency produces mismatched
   digests, and on-chain signature recovery fails. Fuzz tests assert every
   perturbation of an executed round's data reverts.

What a malicious coordinator *can* do is delay or censor — a liveness cost,
never a fund-safety cost — and anyone affected can simply run their own
coordinator. See the griefing analysis in
[PROTOCOL.md](PROTOCOL.md#griefing-analysis).

## 4. Netting vs batching vs channels

Where Arclear sits among the mechanisms that also claim to "compress
payments":

| Mechanism | What it compresses | Funding model | Credit between parties | Scope |
|---|---|---|---|---|
| **Gateway / x402 nanopayments** | your outbound tx count + gas | prepaid balance ≥ your spend (USDC / Circle stablecoins) | none (prepay) | one payer's own outflows |
| **Payment / state channels** | on-chain tx count per pair | capital locked **per channel**, per counterparty | within the channel only | pairwise; multi-hop needs routing + watchtowers |
| **Rollups** | gas per transaction | full value moves; float untouched | none | general computation |
| **Streaming (e.g. Superfluid)** | payment granularity | sender-funded gross directional flows | none | one-directional streams |
| **Traditional netting (DTCC / CLS / ACH)** | value + float — the same axis as Arclear | net-exposure funding | yes, institutionally underwritten | off-chain, permissioned, operator-trusted |
| **Arclear** | reciprocal value + float | collateral ≥ **net** exposure | bounded tab, collateral-backed | full multilateral graph (bilateral + cyclic), any ERC-20 |

The gap Arclear occupies: **permissionless, multilateral, on-credit netting
with a collateralized recovery path, for any ERC-20, as a deployable
contract.** Channels get you pairwise compression at the price of per-channel
lockup and routing complexity; rollups and batching compress *transactions*,
not *float*; traditional netting does compress float but only inside a
permissioned operator. These compose rather than compete — net through
Arclear, settle residuals over whatever rail you like, including Gateway.

## 5. When netting is NOT worth it

Honesty about the losing regions is the point, not a footnote. Two of them
are measured:

**Small pools.** The v1 sweep ([docs/sweep/sweep.csv](sweep/sweep.csv), 200
seeds per cell) shows the worst-placed participant's tenth-percentile
collateral saving is **≈ 0% at n ≤ 5**: in a small pool, one round in ten
leaves somebody saving nothing. Multilateral netting's value concentrates in
larger pools (p10 saving 33% at n=15, 53% at n=50).

**Unreliable members under the two-pass abort cap.** Larger pools only pay
off if rounds actually execute, and v2's threshold consent deliberately hard
caps every attempt at **two** signature-collection passes — a second stall
aborts the round rather than settling partially. The Phase 3 calibration
sweep ([docs/sweep/threshold-sweep.csv](sweep/threshold-sweep.csv)) measures
what that cap costs against per-member per-round consent reliability *p*:
the practical unlock is **n ≈ 15 at 90% per-round uptime** and **n ≈ 30 at
95%** — beyond that, abort dominates (at n=50, p=0.9 the abort rate is
≈ 99%: with fifty members each missing one round in ten, almost every
attempt sees a second-pass stall). The full writeup — methodology,
cross-validation, and the margin-parameter data — is in `docs/CALIBRATION.md`.

So the honest prescription: below n ≈ 5, netting may save a given participant
nothing in a bad round; above n ≈ 15–30, member reliability — not netting
math — becomes the binding constraint. Size your pool, your round cadence,
and your expiries against both curves, and reproduce every number here with
`npm run sweep`.
