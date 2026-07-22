# Arclear v2 kickoff brief — from netting primitive to actual clearinghouse

**How to use this doc:** open a fresh Claude Code session in this repo, run
`/gsd-new-project`, and when it asks what you're building, paste or reference
this file (`@docs/V2-BRIEF.md`). Every question GSD asks should be answerable
from here; the "Answers for GSD's questions" section at the bottom covers the
usual ones. Phases below map 1:1 onto a GSD roadmap.

---

## 1. Where v1 stands (context for a fresh session)

Arclear v1 (branch `v1`, also current `main`) is a **collateralized
multilateral netting primitive** on Arc Testnet:

- `contracts/src/ClearingHub.sol` — collateral vault + atomic netting rounds
  under **unanimous EIP-712 consent** over one shared digest of the full
  position set. 26 Foundry tests (unit / revert matrix / 512-run fuzz /
  TS↔Solidity digest parity).
- `src/` — viem SDK: IOU + consent signing (`iou.ts`, `round.ts`),
  deterministic netting engine (`netting.ts`, spec in `docs/PROTOCOL.md`),
  bilateral credit caps (`creditCap.ts`), typed client (`client.ts`).
  16 fast-check property tests.
- `demo/` — 5-agent swarm + coordinator + dashboard (`public/dashboard.html`).
- Deployed + source-verified on Arc Testnet (chain 5042002):
  USDC hub `0xd5A9ef69b47b0a3C8d326fDABd57aCaFA7D3d6e2`,
  EURC hub `0x867AD43f216B03c2a79eE02eC56F4bbEf90502c0`.
  Real settlement: 105 IOUs → 1 tx, 92.3% compression
  (`0x64f3c58b0af6efcc622248550a7ca0dd963c35251c3f79b2fd237da89cfa2c69`).
- Empirics: `demo/sweep.ts` → `docs/sweep/` — 200 seeds/cell over
  (reciprocity, density, n). Key findings: compression needs no bilateral
  reciprocity at n≥5 (cycles cancel on their own); aggregate volume
  compression saturates ~n=15–20 (85→92% by n=50); but the
  **worst-participant p10 collateral saving keeps climbing** (≈0% at n≤5,
  33% at n=15, 53% at n=50). **Design consequence: netting's value
  concentrates in pools too large for unanimity → liveness work is the
  prerequisite for everything else.**

Environment facts (also in `.env.example` / README):
- Chain 5042002, RPC via `ARC_RPC_URL` (.env), explorer
  `https://testnet.arcscan.app` (Blockscout verifier works, `--with-gas-price
  25gwei`, min base fee 20 gwei).
- **Gas-token gotcha:** USDC is the native gas token AND the ERC-20 at
  `0x3600…0000` — one balance, two views (18-dec native / 6-dec ERC-20).
  Always set explicit `gas` limits on writes or estimation reserves the whole
  balance and token transfers revert in simulation.
- Toolchain: Foundry (`via_ir = true`), npm + tsx + vitest + fast-check,
  viem-only SDK, zero-framework dashboard.

## 2. What v1 is NOT, and what "actual clearinghouse" means

v1 is a *netting* layer: it compresses value but stays fully collateralized
(every debit covered before a round executes) and fully consensual (a round
needs everyone's signature). A real clearinghouse — a CCP — does three things
v1 deliberately does not:

1. **Novation** — the hub becomes the counterparty to both legs (A→B becomes
   A→Hub and Hub→B). Members face the hub, not each other.
2. **Undercollateralization with margin** — members post *less* than gross
   exposure; the hub sizes initial + variation margin to cover a defaulter's
   likely loss.
3. **A default waterfall** — when a member fails to pay, the hub pays anyway,
   from a defined ordered stack of resources.

Each breaks a v1 invariant on purpose: novation changes the zero-sum set
(participants + hub), margin replaces "collateral ≥ debit or revert", the
waterfall removes "no failure-to-pay case". That is why the CCP is a **second
contract** (`ArclearCCP.sol`) sharing the settlement layer — never an
extension of `ClearingHub.sol`. v1 stays live as "Arclear Net".

Domain insight to keep front and center (it makes the whole design
tractable): **in a payments CCP the defaulter's position is a scalar debit in
a stable unit.** No volatile mark, no close-out auction, no hedging. Loss =
uncovered debit. Say this in the docs of every phase that touches risk.

## 3. The plan — phases in dependency order

Each phase ships standalone value and lands as a PR from a feature branch
onto `main` (`v1` branch stays frozen as the showcase snapshot).

### Phase 0 — Threshold consent (liveness; prerequisite for everything)

A CCP is defined by operating *through* a member failure; unanimity halts on
one. But naive k-of-n is unacceptable: a non-signer would have their balance
moved without consent. **Fixed decision: exclude-and-recompute, never
outvote.**

- Round proposal covers a *candidate* set. Coordinator collects consents with
  a timeout; on timeout it rebuilds the round from the consenting subset:
  the excluded member's IOUs drop from the manifest, counterparties' deltas
  are recomputed. **Everyone in the final set signs the final digest** —
  unanimity over the final set, threshold over the candidate set. Worst case
  is two signature-collection passes: a latency cost, never a safety cost.
- Property preserved (test it as an invariant): *every settled balance
  movement was signed for by its owner over the exact executed position set.*
- Contract: `ClearingHubV2.sol` (mostly unchanged execution path; the change
  is coordinator/SDK protocol + round-rebuild logic in `round.ts`).
- Tests: exclusion round is zero-sum after redistribution; an IOU excluded in
  round n settles cleanly in round n+1; the same IOU cannot settle twice;
  griefing cost analysis (repeated refusal = repeated rebuild latency).

### Phase 1 — Merkle manifests + on-chain IOU redemption

Needed by Phase 0 (an excluded member must prove their IOU was *not*
consumed, to re-present it later) and by default handling (a creditor must
prove a claim). 

- Swap `manifestHash` preimage from plain keccak list to a **sorted-leaf
  merkle root** — same `bytes32` field, no ClearingHub interface change.
  Sorted leaves give cheap non-inclusion proofs (prove the two adjacent
  leaves bracketing the missing id).
- `src/merkle.ts` + `contracts/src/lib/ManifestMerkle.sol` (build, prove
  inclusion, prove non-inclusion).
- `redeemIOU(iou, sig, proofs[])`: a creditor presents an unconsumed IOU +
  non-inclusion proofs against the last k round roots, debits the debtor's
  collateral directly. Gated: only against a debtor flagged unresponsive
  (missed K consecutive consent windows) — this is the "counterparty
  vanished" recovery path. Nullifier mapping prevents re-redemption.
- Tests: inclusion/non-inclusion proof parity TS↔Solidity (extend the digest
  fixture pattern); redeem→cannot-net and net→cannot-redeem exclusivity.

### Phase 2 — Novation: `ArclearCCP.sol`

- ```solidity
  struct MemberAccount { uint256 initialMargin; uint256 variationMargin; int256 openPosition; }
  mapping(address => MemberAccount) accounts;
  int256 hubPosition;      // must be 0 in a matched book
  uint256 guarantyFund;    // mutualized member contributions
  ```
- `novate(IOU[] ious, bytes[] sigs)` — verifies both parties' signatures and
  margin headroom, extinguishes the bilateral obligation, writes position
  deltas; both members now face the hub.
- **The invariant test to write first:** `Σ openPosition == 0 && hubPosition
  == 0` under any sequence of novations/settlements. A matched book has no
  market risk, only credit risk; if the handler can make `hubPosition`
  nonzero, that is a solvency bug.
- `executeRound` here settles `openPosition → 0` against variation margin and
  collateral rather than netting bilateral IOUs.

### Phase 3 — Margin (the intellectually hard part; budget the most time)

- **Initial margin:** `IM = q × EWMA(rolling peak intra-cycle net debit)`
  per member, lookback N rounds, multiplier q targeting e.g. 99th percentile
  of historical peak debits. N and q are exposed governance parameters.
  **Do not pretend they're calibrated** — document that production needs
  backtesting; the sweep harness (`demo/flowModel.ts`) is the natural
  backtest generator, extend it rather than building new.
- **Variation margin:** each round, mark open positions; adverse-side members
  must top up within a window. `callMargin(member, amount, deadline)` →
  top-up → else `declareDefault(member)` **callable by anyone**
  (permissionless default declaration removes operator discretion to hide a
  failure).
- **Procyclicality cap:** IM may rise at most X% per round. This trades
  solvency for stability; choose X, document the trade explicitly, cite that
  every real CCP wrestles with this. No clean solution exists — say so.
- Tests: margin covers the modeled 99th-percentile debit on sweep-generated
  histories; cap binds under a simulated stress ramp; VM call → default flow.

### Phase 4 — Default waterfall: `DefaultWaterfall.sol`

Standard order — deviating without reason is a domain red flag:

1. Defaulter's variation margin
2. Defaulter's initial margin
3. Defaulter's guaranty-fund contribution
4. **Operator skin-in-the-game** (a tranche the operator posts, junior to
   survivors' funds — a CCP without it profits from under-margining; include
   it)
5. Surviving members' guaranty fund, pro rata
6. Capped assessment rights (further call on survivors)
7. Last resort: pro-rata haircut of positive positions (VM-gains haircutting)

- Each tranche = a separate internal function returning the residual, so the
  sequence is legible and testable tranche-by-tranche.
- Close-out valuation: the scalar uncovered debit (see domain insight above).
- Tests: each tranche exhausts into the next; the good case (waterfall stops
  at tranche 3, zero mutualization); a default reaching assessments; global
  invariant `total assets == total liabilities + fund balances` after any
  waterfall execution.

### Phase 5 — Membership & governance

Undercollateralized credit means knowing who you extend it to. v1's
"depositing is joining" cannot survive here.

- Membership registry: admission, minimum guaranty contribution, suspension
  path.
- **Say plainly in the README:** this is where the design stops being
  permissionless. The permissionless→permissioned transition is the real
  cost of becoming a clearinghouse; showing you understand it is worth more
  than hiding it. (Arclear Net v1 remains the permissionless product.)

### Phase 6 — Cross-currency PvP rounds (independent; can run parallel)

USDC + EURC legs settling atomically (payment-vs-payment; miniature CLS).
Needs an agreed FX rate per round signed into the consent digest. Ties to the
official `arc-stablecoin-fx` sample.

### Calibration checkpoint (between Phases 1 and 2)

Before writing CCP code: extend `demo/sweep.ts` to simulate threshold-consent
rounds with unresponsive members and margin/undercollateralization scenarios.
Two questions it must answer: (a) what member count does threshold consent
actually unlock in practice, (b) what q/N margin parameters survive the p10
rounds. If the answers are ugly, the CCP scope gets revisited with data —
that was the original decision gate and it stays honest to keep it.

## 4. Fixed decisions (do not relitigate in the new session)

Carried from v1: EIP-712 domain `ArcClearingHub/1` binding hub+chain; no
division anywhere in protocol math (bigint / int256 base units only);
withdrawal never pausable in ClearingHub; coordinator holds no keys/authority
in the Net product; Foundry + viem + tsx toolchain; shared TS↔Solidity digest
fixtures for every new signed struct; explicit gas limits on all Arc writes.

New for v2: exclude-and-recompute (never outvote); sorted-leaf merkle for
manifests; CCP is a separate contract + package ("Arclear Net" and "Arclear
CCP" are two products sharing a settlement layer); standard waterfall order
incl. operator skin-in-the-game; permissionless `declareDefault`;
procyclicality cap on IM; uncalibrated risk parameters labeled as such.

## 5. Rough effort map (focused days)

Phase 0: ~3 · Phase 1: ~3 · checkpoint: ~1 · Phase 2: ~4 · Phase 3: ~5 ·
Phase 4: ~4 · Phase 5: ~2 · Phase 6: ~3 (parallelizable). Total ≈ 18–25.
Phases 0+1 alone are a shippable "Arclear Net v2" release and a showcase
resubmission moment.

## 6. Answers for GSD's questions

- **What is this?** Evolving Arclear from a collateralized netting primitive
  into a two-product clearing stack: Arclear Net (permissionless netting,
  exists) and Arclear CCP (novation + margin + default waterfall, new).
- **Who is it for?** Arc builders running agent swarms that transact
  bidirectionally at high frequency; showcase reviewers; and as a reference
  implementation of clearing mechanics on-chain.
- **Success criteria:** Phase 0+1 live on Arc Testnet with the demo running
  threshold rounds through a simulated stalled member; CCP phases pass their
  invariant suites (matched book, waterfall conservation) and settle a
  simulated default end-to-end on testnet; every risk parameter documented
  with its calibration status; README honesty sections maintained.
- **Non-goals:** mainnet deployment; real-money custody; calibrated
  production risk parameters; UI beyond the existing dashboard pattern;
  fee-on-transfer tokens.
- **Existing context to ingest:** `docs/PLAN.md` (v1 plan), `docs/PROTOCOL.md`,
  `docs/THREAT-MODEL.md`, `docs/sweep/sweep.csv`, this file.
- **Branching:** feature branches → `main`; `v1` frozen.
- **Timeline:** part-time; phase boundaries are the natural pause points.
