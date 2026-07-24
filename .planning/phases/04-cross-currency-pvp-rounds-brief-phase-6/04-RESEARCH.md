# Phase 4: Cross-Currency PvP Rounds (brief Phase 6) - Research

**Researched:** 2026-07-24
**Domain:** Payment-vs-payment atomic settlement across two ClearingHubV2 deployments (Solidity router + EIP-712 bundle consent + viem SDK)
**Confidence:** HIGH (core design questions resolved against vendored code and official Arc docs; two LOW items flagged)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Atomicity mechanism
- **D-01 Thin router, hubs unchanged:** a stateless `contracts/src/PvPRouter.sol` executes both legs in ONE transaction: verify the PvP consent layer, then call `hubUSDC.executeRound(...)` and `hubEURC.executeRound(...)` sequentially. Transaction atomicity gives both-or-neither for free — if either leg reverts (bad sig, insufficient collateral, wrong nonce), the whole tx reverts and NO leg settles. The deployed V2 hubs are NOT modified and NOT redeployed.
- **D-02 Router holds no funds, no state that isn't strictly needed:** target stateless (or minimal replay guard only if research shows the hub nonces don't already prevent replay — they should: each leg's roundNonce makes re-execution revert WrongRoundNonce).

#### FX rate binding (PVP-02)
- **D-03 New EIP-712 signed struct `PvPRound`:** binds { usdcLegDigest (bytes32), eurcLegDigest (bytes32), fxNumerator (uint256), fxDenominator (uint256), and any research-determined fields (e.g., pvpNonce/hub addresses if needed for domain separation) }. Every member of the UNION of the two legs' participant sets signs it. The router verifies these signatures on-chain before executing the legs.
- **D-04 Rate as num/den bigint pair** — no division in protocol math; participant-side verification checks the two legs' deltas are consistent with the rate by cross-multiplication.
- **D-05 Fixture obligation honored:** new signed struct → shared TS↔Solidity digest fixture (extend genFixture + a Foundry parity test, same pattern as Round/IOU digests). MANDATORY per project constraint.
- **D-06 `arc-stablecoin-fx` tie-in:** the demo sources its per-round rate the way the official Arc sample does (research resolves the exact mechanism: sample contract read, or signed rate attestation mirroring the sample's shape). If the sample is unreachable from the SDK, mirror its data shape and document the tie-in.

#### Leg construction (SDK/coordinator)
- **D-07 Legs are ordinary rounds:** each leg is built with the existing `net()`/`buildProposal` machinery per hub (threshold consent per leg still applies — exclusion in one leg forces a rebuild of the PvP bundle since the leg digest changes). The PvP layer wraps two leg proposals + the rate; participants verify BOTH legs plus the rate before signing the PvPRound.
- **D-08 Coordinator flow:** collect leg consents AND PvPRound consents (research/planner may fold these into one signing step per member — one PvPRound signature per member may suffice for the PvP layer while leg consents remain per-hub unanimity as the hubs require).
- **D-09 Abort semantics carry over:** the Phase 1 two-pass cap and abort rules apply per leg; any leg abort aborts the PvP round cleanly (nothing settles).

#### Deployment & demo
- **D-10 Deploy `PvPRouter` to Arc testnet** at phase end (explicit gas, Blockscout verify); README records the address. Existing V2 hubs reused.
- **D-11 e2e scenario (anvil):** both-or-neither proven positively (both legs settle atomically, balances exact per the FX rate) and negatively (sabotage one leg — e.g., withhold one consent — and assert NEITHER settles).
- **D-12 Demo surface minimal:** dashboard gains at most a PvP-round row/badge; no new UI beyond the existing pattern (PROJECT.md out-of-scope guard).
- **D-13 Docs:** PROTOCOL.md gains a short PvP section (atomicity argument, PvPRound struct, rate semantics); THREAT-MODEL row for cross-leg risks (partial-settle impossibility argument, FX-rate manipulation bounded by unanimous consent); README use-case note. Final human-verify checkpoint: live router + e2e walkthrough.

#### Carried constraints (unconditional)
- No division in protocol math; bigint base units; {ok,reason} validation returns; custom errors; NatSpec density; explicit measured gas on all writes; withdraw never pausable (hubs untouched anyway); coordinator gains no authority; strict TS.

### Claude's Discretion
- PvPRound field layout details (subject to fixture + research); whether legs' participant sets must be identical or merely overlapping (research the safety implications; simplest safe rule wins)
- Router error surface; gas measurement approach
- Demo persona FX flows (who trades EURC↔USDC and why)

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PVP-01 | USDC + EURC legs settle atomically in a payment-vs-payment round (miniature CLS) | Q1/Q2 analysis: transaction atomicity via a single router call to both hubs' `executeRound`; ReentrancyGuard/Pausable composition verified safe against vendored OZ 5.6.1; no try/catch around leg calls (Pitfall 1); single-leg-extraction limitation analyzed and answer recommended (accept-and-document with signature custody discipline) |
| PVP-02 | An agreed per-round FX rate is signed into the consent digest; ties to the official `arc-stablecoin-fx` sample | Q3/Q4/Q5: `PvPRound` EIP-712 struct in the router's own domain binding both leg digests + fxNumerator/fxDenominator; union-set signing rule; `arc-stablecoin-fx` located (circlefin/arc-stablecoin-fx, Circle App Kit Swap SDK) — its quotes are amount pairs, which map directly to num/den without division |
</phase_requirements>

## Summary

Phase 4 adds exactly one new contract (`PvPRouter.sol`), one new signed struct (`PvPRound`), one new SDK module (`src/pvp.ts`), and demo/e2e/deploy wiring. Every hard question resolves cleanly against code already in the repo:

**Atomicity is structurally sound.** The vendored OpenZeppelin 5.6.1 `ReentrancyGuard` keeps its flag in a namespaced slot in *each contract's own storage* — two hubs have two independent guards, and a router calling `hubA.executeRound` then `hubB.executeRound` performs two top-level entries that each set and clear their own guard. There is no cross-contract interaction, no gas-forwarding hazard at demo scale, and `Pausable` composes correctly (a paused hub reverts its leg → the whole tx reverts → both-or-neither preserved). The one absolute rule: the router must use plain external calls with automatic revert bubbling — **never** try/catch — because swallowing a leg revert is the only way to break atomicity from inside the router.

**The router needs no replay guard, but the honest answer to the central design question is (c) accept-and-document, hardened by signature custody.** A signed `PvPRound` binds two leg digests; each leg digest binds that hub's `roundNonce`; once either leg executes (by any path), re-execution reverts `WrongRoundNonce` and the PvPRound dies with it — replay is structurally impossible, so D-02's stateless target holds. The unavoidable residual is single-leg settlement outside the router: leg consents are valid standalone hub signatures, `executeRound` is permissionless, and the hubs cannot be changed (D-01). Analysis shows the economic harm is bounded and honest to state: a single-leg submission settles one leg *exactly as its participants unanimously signed it*, while the other leg's obligations persist as open, collateral-backed, redeemable IOUs — the failure mode degrades PvP back to Arclear's ordinary bilateral-credit risk model (a Herstatt-style timing exposure), never to unsigned balance movement or double settlement. Mitigation: the coordinator is the only party ever holding a complete leg signature set and must publish it only inside the router transaction; the residual mempool-extraction window is documented plainly in THREAT-MODEL.md.

**The FX tie-in is concrete.** The official sample is `circlefin/arc-stablecoin-fx` (Next.js + Circle App Kit Swap SDK). Its quotes represent the rate as an **amount pair** (`amountIn`/`estimatedOutput`), not a decimal — which maps 1:1 onto D-04's `fxNumerator`/`fxDenominator` base-unit bigints with zero division: for a USDC→EURC quote, `fxNumerator = EURC amountOut base units`, `fxDenominator = USDC amountIn base units`. The demo mirrors this quote shape (the sample itself is a Supabase/Next.js app unreachable from a viem-only SDK; mirroring its data shape is the D-06 sanctioned fallback and must be documented as such).

**Primary recommendation:** Build `PvPRouter` as a stateless contract with immutable `hubUSDC`/`hubEURC`, its own EIP-712 domain `("ArclearPvPRouter", "1")`, a 4-field `PvPRound` typehash, on-chain union-merge signature verification, and leg-digest recomputation via each hub's public `hashRound` — then follow the twice-proven fixture→parity→measured-gas→deploy pipeline.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Both-or-neither leg execution | On-chain (PvPRouter) | — | Only transaction atomicity can enforce it; router sequences the two `executeRound` calls |
| PvPRound signature verification | On-chain (PvPRouter) | SDK (screening) | Rate binding must be enforced where legs execute; SDK pre-screens like `screenConsents` |
| Leg digest ↔ calldata consistency | On-chain (PvPRouter) | — | Router must prove the legs it executes are the legs that were signed (via hubs' public `hashRound`) |
| Leg netting, proposal build, per-leg consent | SDK (`src/netting.ts`, `src/round.ts`) | — | D-07: legs are ordinary rounds; hubs verify per-leg unanimity unchanged |
| FX-rate economic consistency (cross-multiplication) | SDK participant-side (`src/pvp.ts`) | — | D-04; net deltas mix FX and non-FX flows, so rate checks apply to paired trade IOUs, not net deltas — impossible/meaningless on-chain (see Q5) |
| PvP bundle orchestration (collect, rebuild, abort, submit) | Demo coordinator (`demo/coordinator.ts` pattern) | — | Zero-authority coordinator; wraps existing two-pass machinery |
| Rate sourcing (arc-stablecoin-fx shape) | Demo (`demo/` quote mirror) | — | Rate is *agreed*, not oracle-derived; demo mirrors the sample's amount-pair quote shape |
| Deployment + verification | Foundry script (`contracts/script/`) | — | Existing DeployV2 pattern; explicit gas, Blockscout verify |

## Standard Stack

### Core (all already vendored/installed — no new packages this phase)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| OpenZeppelin Contracts | 5.6.1 (vendored, commit `abc1a77`) | `EIP712`, `ECDSA` for the router | Same primitives the hubs use; parity guaranteed [VERIFIED: contracts/lib/openzeppelin-contracts/package.json] |
| forge-std | vendored | Router tests, parity tests, gas measurement | Existing pattern |
| viem | ^2.21.0 (installed 2.55.5) | `hashTypedData`/`signTypedData` for PvPRound; router client | Sole runtime dep, project constraint [VERIFIED: package.json + CLAUDE.md] |
| vitest / fast-check / tsx | 2.1.9 / ^3.22 / ^4.19 | SDK tests, property tests, script running | Existing toolchain [VERIFIED: local `npx vitest --version`] |
| Foundry | forge 1.3.5-stable | Build/test/deploy, `via_ir = true` | Fixed constraint [VERIFIED: local `forge --version`] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Router with own EIP712 domain | Reuse hub domain ("ArcClearingHub","1") with router as verifyingContract | Works mechanically, but lies about the name; a distinct name ("ArclearPvPRouter") makes wallet display and fixtures self-describing. Use a new domain. |
| Hub-pinning via constructor immutables | Hub addresses as calldata + struct fields | Calldata hubs open the evil-hub substitution attack (see Q3); struct-only hub fields still require the router to trust calldata for the call target. Immutables close it structurally. |
| Leg digest recomputation via `hub.hashRound` (external view) | Reimplement EIP-712 Round hashing inside the router | Duplicating domain/typehash logic invites parity drift; the hubs' `hashRound` is public *specifically* "so off-chain implementations can assert encoding parity" — the router is exactly such a consumer. |
| OZ `ReentrancyGuard` on the router | No guard (stateless) | The router holds no funds and no mutable state; the hubs' own guards protect them. Omit — and document why (see Q1). |

**Installation:** none. No new npm or forge dependencies.

## Package Legitimacy Audit

No external packages are installed in this phase. All dependencies are already vendored (OpenZeppelin 5.6.1 git submodule, forge-std) or installed (viem, vitest, fast-check, tsx). slopcheck run: not applicable.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                     ┌──────────────────── off-chain ────────────────────┐
  FX quote (mirrors  │                                                   │
  arc-stablecoin-fx  │  demo/fx quote ──► fxNumerator/fxDenominator      │
  amount-pair shape) │                        │                          │
                     │  USDC IOUs ─► net() ─► buildProposal(hubUSDC) ─┐  │
                     │  EURC IOUs ─► net() ─► buildProposal(hubEURC) ─┤  │
                     │                        │                       │  │
                     │              buildPvPProposal(router,          │  │
                     │                legU.digest, legE.digest,       │  │
                     │                fxNum, fxDen)  ──► pvpDigest    │  │
                     │                        │                       │  │
                     │   each UNION member:  verify legU + legE       │  │
                     │   (verifyProposal ×2) + rate cross-mult        │  │
                     │   + pvpDigest recompute ─► sign: legU consent  │  │
                     │   (if in legU), legE consent (if in legE),     │  │
                     │   PvPRound consent (always)                    │  │
                     └──────────────┬────────────────────────────────────┘
                                    │ ONE tx: executePvP(legU args+sigs,
                                    │          legE args+sigs, fxNum, fxDen,
                                    │          pvpSigs[])
                     ┌──────────────▼──────────── on-chain ──────────────┐
                     │ PvPRouter (stateless; immutable hubUSDC/hubEURC)  │
                     │  1. fxDenominator != 0, fxNumerator != 0          │
                     │  2. rootU = ManifestMerkle.rootOf(legU.ids)       │
                     │     digestU = hubUSDC.hashRound(...) — must equal │
                     │     signed usdcLegDigest (same for EURC leg)      │
                     │  3. union = sortedMerge(legU.participants,        │
                     │             legE.participants)                    │
                     │  4. recover pvpSigs[i] == union[i] over pvpDigest │
                     │  5. hubUSDC.executeRound(legU…)  ── reverts ──►   │
                     │  6. hubEURC.executeRound(legE…)  ── whole tx      │
                     │     (plain calls, NO try/catch — bubbling is the  │
                     │      atomicity mechanism)                         │
                     └───────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
contracts/src/PvPRouter.sol            # the only new contract
contracts/script/DeployPvPRouter.s.sol # HUB_V2_USDC/HUB_V2_EURC env, DeployV2 pattern
contracts/test/PvPRouter.t.sol         # unit + revert matrix + both-or-neither + gas
contracts/test/PvPParity.t.sol         # PvPRound digest fixture parity (DigestParity lineage)
src/pvp.ts                             # pvpDigest, buildPvPProposal, verifyPvPProposal,
                                       #   signPvPConsent, verifyPvPConsent, unionParticipants
src/domain.ts                          # + PVP_TYPES, pvpDomain(router, chainId)
src/types.ts                           # + PvPProposal interface
src/client.ts                          # + PvPRouterClient (executePvP with gas formula)
src/index.ts                           # + export * from "./pvp.js" (before client)
demo/setup.ts                          # extend: SECOND mock token + second hub + router (anvil);
                                       #   HUB_V2_EURC + PVP_ROUTER env (testnet)
demo/coordinator.ts or demo/pvp*.ts    # PvP bundle orchestration wrapping two-pass machinery
demo/e2e.ts                            # + PvP scenario (positive + negative)
test/genFixture.ts                     # + pvp_* keys in digest.json
test/pvp.test.ts                       # digest roundtrip + verifyPvPProposal properties
```

**Correction to CONTEXT.md code insights:** `demo/setup.ts` currently deploys **one** hub + one mock token on anvil (v1's dual-token setup did not carry into the v2 bootstrap). The planner must budget a real extension: second mock token, second `ClearingHubV2`, router deploy, dual funding/deposit — and testnet mode must read `HUB_V2_EURC` (README documents both hub addresses; only `HUB_V2_USDC` is consumed today). [VERIFIED: demo/setup.ts read this session]

### Pattern 1: PvPRound EIP-712 struct and domain (Q3 answer)

**What:** The router is its own EIP-712 verifying contract with a new domain name/version. Exact definitions:

```solidity
// Source: pattern locked against ClearingHubV2.sol + vendored OZ EIP712
contract PvPRouter is EIP712 {
    ClearingHubV2 public immutable hubUSDC;
    ClearingHubV2 public immutable hubEURC;

    bytes32 private constant PVP_ROUND_TYPEHASH = keccak256(
        "PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)"
    );

    constructor(ClearingHubV2 hubUSDC_, ClearingHubV2 hubEURC_)
        EIP712("ArclearPvPRouter", "1")
    { ... }

    function hashPvPRound(
        bytes32 usdcLegDigest, bytes32 eurcLegDigest,
        uint256 fxNumerator, uint256 fxDenominator
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            PVP_ROUND_TYPEHASH, usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator
        )));
    }
}
```

```typescript
// src/domain.ts additions
export const PVP_TYPES = {
  PvPRound: [
    { name: "usdcLegDigest", type: "bytes32" },
    { name: "eurcLegDigest", type: "bytes32" },
    { name: "fxNumerator", type: "uint256" },
    { name: "fxDenominator", type: "uint256" },
  ],
} as const;

export function pvpDomain(router: Address, chainId: number = ARC_TESTNET_CHAIN_ID) {
  return { name: "ArclearPvPRouter", version: "1", chainId, verifyingContract: router } as const;
}
```

**Why no extra fields (hub addresses, pvpNonce, deadline):**
- *Hub addresses:* unnecessary **iff** the hubs are constructor immutables. `verifyingContract = router` and a specific router deployment is permanently bound to one hub pair, so a PvPRound signature in this router's domain *is* consent to legs on exactly that hub pair. Each leg digest additionally binds its hub cryptographically (the hub is `verifyingContract` inside the leg's own domain separator). If the planner instead passed hub addresses as router calldata, an attacker could substitute a malicious "hub" whose `hashRound` echoes the signed digest and whose `executeRound` is a no-op — executing one real leg and one fake leg through the router itself. **Immutables close this class entirely; they are required, not optional.**
- *pvpNonce:* redundant — see Q2 replay analysis below.
- *deadline:* leg consents already have no deadline in the base protocol (a stale unanimous round at an unmoved nonce can always execute — an accepted, documented property). Adding a deadline only to the PvP layer would give false comfort: the legs, not the wrapper, are the replayable objects. Note it in PROTOCOL.md instead.

**Fixture fields needed (extend `test/genFixture.ts` digest.json, flat keys, same regeneration discipline):** `pvpRouter` (fixture constant address), `pvpUsdcLegDigest`, `pvpEurcLegDigest`, `pvpFxNumerator`, `pvpFxDenominator`, `pvpDigest`, `pvpSigner0`, `pvpConsent0`. The parity test (`PvPParity.t.sol`) uses `vm.chainId(5042002)` + `deployCodeTo("PvPRouter.sol:PvPRouter", abi.encode(hubUsdcAddr, hubEurcAddr), pvpRouterAddr)` exactly like `ClearingHubV2Parity.t.sol` (immutables set correctly under `deployCodeTo` — the existing K/RING tests prove the pattern), then asserts `router.hashPvPRound(...) == pvpDigest` and `ECDSA.recover(pvpDigest, pvpConsent0) == pvpSigner0`.

### Pattern 2: Router execution flow (Q1 + Q2 mechanics)

```solidity
// Shape only — errors and NatSpec per project conventions
function executePvP(
    Leg calldata usdcLeg,        // {nonce, participants, deltas, consumedIds, signatures}
    Leg calldata eurcLeg,
    uint256 fxNumerator,
    uint256 fxDenominator,
    bytes[] calldata pvpSignatures   // index-aligned to the sorted union
) external {
    if (fxNumerator == 0 || fxDenominator == 0) revert ZeroRate();

    // 1. Bind calldata legs to the signed digests via the hubs' parity-locked hashRound.
    bytes32 digestU = hubUSDC.hashRound(usdcLeg.nonce, usdcLeg.participants, usdcLeg.deltas,
        ManifestMerkle.rootOf(usdcLeg.consumedIds));
    bytes32 digestE = hubEURC.hashRound(eurcLeg.nonce, eurcLeg.participants, eurcLeg.deltas,
        ManifestMerkle.rootOf(eurcLeg.consumedIds));

    // 2. One PvP signature per member of the sorted union of both participant sets.
    bytes32 pvpDigest = hashPvPRound(digestU, digestE, fxNumerator, fxDenominator);
    _verifyUnionSignatures(usdcLeg.participants, eurcLeg.participants, pvpDigest, pvpSignatures);

    // 3. Execute both legs. PLAIN calls — a revert in either bubbles and undoes everything.
    hubUSDC.executeRound(usdcLeg.nonce, usdcLeg.participants, usdcLeg.deltas,
        usdcLeg.consumedIds, usdcLeg.signatures);
    hubEURC.executeRound(eurcLeg.nonce, eurcLeg.participants, eurcLeg.deltas,
        eurcLeg.consumedIds, eurcLeg.signatures);

    emit PvPExecuted(digestU, digestE, fxNumerator, fxDenominator, pvpDigest);
}
```

Notes:
- `ManifestMerkle.rootOf` takes `bytes32[] memory` [VERIFIED: ManifestMerkle.sol:68] — calldata arrays convert implicitly at the internal-library call. The root is computed twice per leg (router + hub); at demo scale this is cheap (see Q6).
- Union merge: both participants arrays are strictly ascending (the hubs enforce it; the router can rely on `executeRound` re-checking, but must do its own merge for signature indexing — a single-pass sorted merge that also *rejects* non-ascending input keeps failure local and cheap).
- The struct-of-arrays `Leg` calldata shape keeps the ABI legible; via_ir handles stack depth.
- A `Leg`-shaped tuple mirrors `RoundProposal` minus digest — the SDK already has everything needed to build it.

### Pattern 3: PvP bundle consent (SDK + coordinator, Q5/D-07/D-08/D-09)

- `verifyPvPProposal(router, pvpProposal, myIousUSDC, myIousEURC, self, opts) → {ok, reason}`: recompute-and-compare in the established style — run `verifyProposal` per leg the member belongs to (with `expectedRoundNonce` per hub and `pendingConsumedIds` per hub — the WR-06 machinery generalizes per leg), check FX-trade pairing consistency (below), recompute `pvpDigest` from the two *locally verified* leg digests + rate, compare to the proposal.
- **One provider call per member** (folding per D-08): the PvP consent provider returns `{ usdcConsent?: Hex, eurcConsent?: Hex, pvpSignature: Hex }` — members sign their leg consent(s) and the PvPRound in a single verified step. Hub-level unanimity still requires per-leg Round signatures (hubs unchanged); the fold is in collection, not in cryptography.
- **Rebuild/abort semantics (D-09):** any pass-1 timeout/refusal by a union member excludes them from **both** legs in one batch (simplest safe rule); both legs rebuild with the existing `rebuildProposal` at unchanged per-hub nonces; leg digests change → the PvPRound digest changes → *all* PvP signatures and all leg consents are recollected in pass 2. (Optimization — an unchanged leg's consents stay valid since its digest is unchanged — is real but adds state-tracking complexity; recommend full recollection for pass 2, note the optimization in a comment.) Hard cap two passes; any pass-2 incompleteness aborts the whole bundle: nothing settles on either hub.
- **Concurrency guard:** while a PvP bundle is in flight, the coordinator must not run an ordinary round on *either* hub (the per-hub `pendingSubmission` reconciliation generalizes to two hubs; a concurrent ordinary round advancing either nonce makes the router revert `WrongRoundNonce` — expected data, not a fault, same as today's WR-02 handling).

### Pattern 4: FX rate semantics and the arc-stablecoin-fx tie-in (Q4)

**What the sample actually is** [VERIFIED: docs.arc.io/build/stablecoin-fx + github.com/circlefin/arc-stablecoin-fx fetched this session]: `circlefin/arc-stablecoin-fx` is Circle's production-ready sample — a Next.js app doing real-time USDC↔EURC swaps on Arc via the **Circle App Kit Swap SDK** (`kit.estimateSwap` → `kit.swap`), with Circle developer-controlled wallets and a Supabase backend. The underlying institutional engine is Circle StableFX (off-chain RFQ, on-chain PvP settlement — the same settlement idea this phase miniaturizes) [CITED: circle.com/blog + decrypt.co coverage].

**The rate shape:** App Kit swap quotes express the rate as an **amount pair**, not a decimal — e.g. swap params `amountIn` with `estimatedOutput: { amount: '0.989589', token: 'EURC' }` [CITED: docs.arc.io/app-kit/quickstarts/swap-tokens-same-chain.md]. This is exactly D-04's representation:

- **Convention to pin in PROTOCOL.md:** `fxNumerator` = EURC base units, `fxDenominator` = USDC base units. A cross-currency trade pairing `u` USDC-leg base units with `e` EURC-leg base units is rate-consistent iff `e * fxDenominator == u * fxNumerator` (pure bigint cross-multiplication, no division).
- **Quote mirror:** a 1 USDC → 0.989589 EURC quote becomes `fxNumerator = 989_589n`, `fxDenominator = 1_000_000n`. Both tokens are 6 decimals on Arc so there is no decimal-skew term [VERIFIED: src/domain.ts comment + PROTOCOL.md].
- **Tie-in mechanism (D-06 resolved):** the sample's rate comes from an authenticated Circle SDK inside a Next.js/Supabase app — not consumable from a dependency-free viem SDK. Per D-06's explicit fallback: the demo **mirrors the sample's quote data shape** (an `{amountIn, amountOut}` pair in base units per pair-direction, timestamped per round) as its rate source, and PROTOCOL.md/README document the tie-in: "the per-round rate is agreed in the same amount-pair form the official arc-stablecoin-fx sample's App Kit quotes use; a production coordinator would source the pair from an App Kit `estimateSwap` quote." Honesty framing carries over from CONTEXT specifics: the rate is *agreed*, not oracle-derived — unanimous consent bounds manipulation.
- **FX trade pairing convention (needed for participant-side verification):** a cross-currency trade is a *pair* of IOUs — one on each hub, opposite directions between the same two parties — sharing the same `ref` (bytes32, e.g. keccak of a trade id). Verifiers pair by `ref` and check cross-multiplication per pair. This is why the rate check is per-trade, **not** per-net-delta: net deltas mix FX flows with ordinary same-currency flows, so `usdcDelta·fxDen == -eurcDelta·fxNum` does NOT hold in general and must not be asserted (on-chain or off).

### Anti-Patterns to Avoid

- **try/catch (or unchecked low-level call) around either `executeRound`:** silently swallowing a leg revert is the *only* way the router itself can break both-or-neither. Plain high-level external calls bubble reverts automatically — that bubbling IS the PVP-01 mechanism.
- **On-chain FX-vs-delta arithmetic:** net deltas are not rate-checkable (mixed flows). The rate lives in the signed digest; the router verifies signatures, not economics — "off-chain compute, on-chain enforce."
- **Router state (nonces, executed-set mappings):** D-02 + Q2 — hub nonces already make PvPRound replay impossible. Extra state is extra audit surface for zero benefit.
- **Trusting calldata hub addresses:** evil-hub substitution (Q3). Immutables only.
- **Recomputing leg digests with router-local EIP-712 code:** use the hubs' public `hashRound`; it exists precisely for external parity consumers.
- **Reusing pass-1 signatures after any leg rebuild:** every digest in the bundle changed transitively; the T-01-10 rule generalizes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PvPRound domain separator / digest | Manual keccak of domain fields | OZ `EIP712` + `_hashTypedDataV4` (contract), viem `hashTypedData` (SDK) | Same dual-implementation parity regime as Round/IOU; fixture locks them |
| Signature recovery | Raw ecrecover | OZ `ECDSA.recover` | Malleability/short-sig handling already vetted; matches hub behavior byte-for-byte |
| Manifest root in router | New merkle code | `ManifestMerkle.rootOf` (already vendored in-repo) | Sole spec implementation on the Solidity side; UnsortedLeaves guard for free |
| Leg netting/proposals/consent | New PvP-specific netting | `net()`, `buildProposal`, `rebuildProposal`, `verifyProposal`, `signConsent` per hub | D-07: legs are ordinary rounds — zero new netting math |
| Consent collection/screening | New collection loop | `collectConsents` + `screenConsents` generalized (provider returns the signature bundle) | Deadline-snapshot, refusal-as-data, CR-01 screening all carry over |

**Key insight:** the entire phase is a *composition* exercise — the only genuinely new logic is (a) the union merge + PvP signature check in the router, and (b) the participant-side rate cross-multiplication. Everything else is existing machinery invoked twice.

## Critical Design Analysis (the six flagged research questions)

### Q1 — Reentrancy/composition safety of sequential nonReentrant calls: SAFE [VERIFIED: vendored source]

The vendored OZ 5.6.1 `ReentrancyGuard` stores its flag at constant slot `REENTRANCY_GUARD_STORAGE` **in each inheriting contract's own storage** (`contracts/lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol`, read this session). Consequences:

1. **Per-contract, confirmed.** hubUSDC and hubEURC each own an independent guard. Router → hubA.executeRound enters and *exits* hubA's guard before router → hubB.executeRound touches hubB's. No shared state, no interference.
2. **The guard does not prevent sequential same-hub calls** — it clears on return. Calling the *same* hub's `executeRound` twice in one tx is stopped by `roundNonce`, not the guard (second call reverts `WrongRoundNonce` unless it's a genuinely new consented round). Worth a test, not a fix.
3. **No reentry vectors exist anyway:** `executeRound` calls out only via `SafeERC20` on plain ERC-20s (mock token / Arc USDC / EURC — no transfer hooks); Arclear supports no fee-on-transfer or callback tokens by explicit non-goal.
4. **Pausable composition:** if either hub is paused, its leg reverts `EnforcedPause` → whole tx reverts → atomicity *preserved*, not weakened. (An owner pausing one hub between consent and submission is just another leg-abort cause, same class as a withdrawal-induced `InsufficientCollateral`.)
5. **Gas forwarding:** plain calls forward 63/64 of remaining gas (EIP-150); with the explicit client-side limit sized per Q6, both legs and the router overhead fit with ≥1.5× margin — no partial-gas hazard. Do not set per-call gas stipends.
6. **Router's own guard:** unnecessary — the router is stateless and holds no funds. Omit `ReentrancyGuard` (it would be storage writes for nothing) and document the reasoning in NatSpec.

### Q2 — Replay guard & the half-executed-outside-router attack: NO router guard needed; recommend option (c) accept-and-document, hardened

**Replay (confirmed, structural):** a signed PvPRound binds `usdcLegDigest` and `eurcLegDigest`; each leg digest binds `(hub domain, roundNonce, participants, deltas, manifestHash)`. `roundNonce` is monotonic (uint64, incremented every execution, never reused). Once either leg executes — through the router or directly — that hub's nonce advances, re-execution of that leg reverts `WrongRoundNonce`, and any tx carrying the PvPRound reverts with it. Before any leg executes, "replay" is just first execution. Therefore the router needs **no nonce, no executed-set mapping, no state** — D-02's stateless target holds. (Corner: a fully-signed bundle at nonces that never advance remains executable indefinitely — identical to the base protocol's standing property for leg consents; document, don't fix.)

**The central question — single-leg submission outside the router.** The attack: leg consents are ordinary hub Round signatures, valid standalone; `executeRound` is permissionless; anyone holding one leg's complete signature set can submit that leg directly, settling it without its twin. Options analyzed:

- **(a) Sign-only-in-bundle + monitoring:** participants already only produce leg consents inside `verifyPvPProposal` flows, but this constrains honest signers, not attackers holding the signatures. Necessary hygiene, insufficient alone.
- **(b) Make legs unsettleable alone:** impossible without hub changes (would need a "PvP-flagged" round the hub refuses outside a router call) — locked out by D-01. Correctly rejected.
- **(d) Deadline metadata / relayer race:** the Round struct has no deadline field and hubs are frozen; a PvPRound-level deadline doesn't bind the legs (they are the replayable objects). A relayer race (coordinator broadcasts the router tx immediately) shrinks but cannot close the window: **the router transaction itself publishes both legs' complete signature sets in the mempool**, so any observer can extract one leg's calldata and front-run it as a bare `executeRound` with higher gas — leg settles, router tx lands second and reverts `WrongRoundNonce`. Whether Arc testnet has an adversarially observable public mempool is unknown [ASSUMED — flagged A2], but the design must not depend on it.
- **(c) Accept-and-document — RECOMMENDED, because the harm analysis is genuinely bounded:**
  - Every balance movement in the settled leg was unanimously signed by its exact owners over the exact executed position set — the core v1/v2 safety invariant is untouched. No theft, no unsigned movement, no double settlement.
  - The *unsettled* leg's obligations do not vanish: they remain open, signed, collateral-backed IOUs on the other hub — nettable in a later round, and recoverable via `redeemIOU` if the debtor goes dark. The FX trade's second leg degrades from "atomically settled" to "ordinary Arclear bilateral credit" — exactly the risk class every non-PvP round already carries, bounded by credit caps + collateral + redemption.
  - The residual harm is therefore **Herstatt-style timing/counterparty exposure on the open leg** (debtor may withdraw free collateral and stall; redemption races the never-pausable `withdraw` — the documented best-effort property), plus loss of the FX linkage guarantee for that round. It is "one leg settled early with full consent," never "funds moved without consent." Note the claim amount is fixed in the leg's own currency, so there is no rate exposure on the claim itself.
  - The attacker gains nothing economically — they pay gas to settle other people's leg exactly as signed; it is pure griefing.
  - **Hardening that costs nothing:** (i) the coordinator is the only party ever holding a complete leg signature set pre-broadcast — it must never publish leg signatures except inside the router tx; (ii) participants sign leg consents only through `verifyPvPProposal` (bundle context); (iii) a forge test (`test_singleLegDirectSubmissionSettles`) *demonstrates* the limitation so it is machine-documented, and THREAT-MODEL.md states it plainly: *"PvP both-or-neither holds within the router path and against all failure/revert modes; it does not hold against an adversary who obtains and unilaterally submits one leg's full signature set (including mempool extraction of the router tx). The downgrade is to standard netting credit risk, never to unsigned movement."*

### Q3 — EIP-712 domain for PvPRound: answered in Pattern 1

Domain `("ArclearPvPRouter", "1", chainId, router)`; typehash `keccak256("PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)")`; hub pair bound via constructor immutables (mandatory — closes evil-hub substitution); no pvpNonce/deadline; fixture fields listed in Pattern 1.

### Q4 — arc-stablecoin-fx: answered in Pattern 4

Repo: `github.com/circlefin/arc-stablecoin-fx` (Circle App Kit Swap SDK, USDC↔EURC on Arc). Rate = amount pair → direct num/den mapping; demo mirrors the quote shape per D-06's fallback clause; tie-in documented in PROTOCOL.md/README.

### Q5 — Union-set signing over differing participant sets: SAFE; simplest safe rule = allow differing sets, union signs

- **Who must consent to the rate?** Anyone whose signed delta was computed *assuming* the other leg settles at that rate — i.e., anyone with an FX-trade IOU in either leg. Members with only same-currency flows in one leg have deltas independent of the rate. The **union is a superset of everyone who needs to consent**, so union-signing is sound for any set relationship (identical, overlapping, disjoint).
- **Must the sets be identical? No, and requiring it would be wrong:** netting rule 6 means a member appears in a leg iff their IOUs were consumed there. Forcing identical sets would require injecting zero-delta phantom members into a hub round they have no paper in — which `executeRound`'s netting-derived manifests don't support and the netting spec forbids. Differing sets are the *normal* case (e.g., a USDC-only spender who never touches EURC).
- **Safety of union signing:** a signer only ever authorizes (a) their own leg deltas — via leg consents the hubs verify — and (b) the rate + the binding of two specific leg digests — via the PvPRound. Signing the PvPRound moves no balance by itself; balance movement still requires that member's leg consent on the leg containing them. A union member in one leg only is attesting "I consent to my leg *given* this other leg and this rate settle with it" — precisely the PvP semantics.
- **On-chain rule:** router computes the sorted union merge of the two (strictly-ascending) participants arrays and requires exactly one valid PvP signature per union member, index-aligned to the merged order. Reject on merge disorder, length mismatch, or bad recovery (`BadPvPSignature(uint256 index)`).
- **Rate consent nuance for the docs:** technically a non-FX union member's delta doesn't depend on the rate, but having them sign anyway is harmless (they attest the bundle they verified) and keeps the rule stateless and simple — "everyone in either leg signs the bundle."

### Q6 — Gas: router overhead model + client formula shape

Measured Phase 2 baselines (fresh-state worst case, n=5) [VERIFIED: PROTOCOL.md measured-gas table + src/client.ts coefficients]: `executeRound` = 329k (m=10) / 692k (m=105) / 1,255k (m=250); client formula `300_000 + 40_000·n + 6_000·m` with ≥1.5× margin.

Router overhead components per PvP call:
- 2 × cold `CALL` to hubs (~2.6k each) + 2 × cold `STATICCALL` for `hashRound` views (~2.6k + array re-hash, ~200·n gas each)
- 2 × router-side `ManifestMerkle.rootOf` (memory keccaks, ~2m−1 hashes/leg ≈ well under 1k gas per 10 ids)
- n_union × `ECDSA.recover` (~3k precompile + ~2-5k memory/calldata each)
- union merge + calldata: minor
- **Estimate:** router adds roughly `60–120k base + ~8–10k per union signature + ~0.5–1k per consumed id` on top of the two legs' own costs. Total for two demo-scale legs (m≈105 each, n=5, union=5): ≈ 700k + 700k + ~150k ≈ **1.55M — comfortably above the hardcoded 1.5M lesson from STATE.md concerns; the formula approach is mandatory.**

**Recommended client formula shape** (constants to be re-fit from forge `gasleft()` measurements, same plan-02-05 methodology, snapshot into `contracts/.gas-snapshot`):

```typescript
PVP_GAS = PVP_ROUTER_BASE                                    // measure; expect ~150_000n
        + 2n * EXECUTE_ROUND_GAS_BASE                        // reuse existing coefficients
        + EXECUTE_ROUND_GAS_PER_PARTICIPANT * BigInt(n1 + n2)
        + EXECUTE_ROUND_GAS_PER_ID * BigInt(m1 + m2)
        + PVP_GAS_PER_UNION_SIG * BigInt(nUnion)             // measure; expect ~15_000n
```

Reusing the existing leg coefficients keeps one source of truth; the two new constants get their own measured justification comment. Explicit `gas` + `maxFeePerGas: MIN_MAX_FEE_PER_GAS` on the write, per the Arc gas-token gotcha. Arc testnet block gas limit is unverified [ASSUMED — A3]; at reduced testnet demo scale (amountDivisor=10, small manifests) the PvP tx stays far below any plausible limit, but the planner should have the e2e print the measured `gasUsed` for the record.

## Common Pitfalls

### Pitfall 1: try/catch atomicity leak
**What goes wrong:** a well-meaning "graceful error" wrapper around a leg call turns a leg revert into a half-settled PvP round.
**Why it happens:** habit from defensive coding; Solidity try/catch swallows the revert.
**How to avoid:** plain external calls only; a forge test asserts that a failing second leg reverts the *first* leg's state changes (check both hub nonces + a collateral read after the revert).
**Warning signs:** any `try` keyword in PvPRouter.sol; any low-level `.call` on the hubs.

### Pitfall 2: verifying signatures against calldata legs instead of signed digests
**What goes wrong:** router executes legs that differ from what union members signed (rate bound to the wrong legs → PVP-02 broken silently).
**How to avoid:** recompute each leg digest from calldata via `hub.hashRound(..., ManifestMerkle.rootOf(ids))` and require equality with the digests inside the signed PvPRound *before* any execution. Revert `LegDigestMismatch(uint8 leg)`.
**Warning signs:** `usdcLegDigest` used only as a hash input, never compared against a recomputation.

### Pitfall 3: single-hub assumptions in demo plumbing
**What goes wrong:** `setup.ts` deploys one hub; `Coordinator`, `pendingSubmission`, `settledIds`, `reconcileRedeemedIds` are all single-hub. Naive reuse double-books or cross-books state between hubs.
**How to avoid:** instantiate per-hub state (two `HubClient`s, two settled/redeemed id sets — ids are hub-domain-separated by construction so they can't collide, but keeping them per-hub preserves the reconciliation logic); PvP orchestration composes two per-hub views. Extend `setup.ts` for token2/hub2/router on anvil and `HUB_V2_EURC`/`PVP_ROUTER` env on testnet.
**Warning signs:** one `settledIds` set fed IOUs signed against two different hub domains.

### Pitfall 4: WrongRoundNonce races across the bundle
**What goes wrong:** an ordinary round (or a redemption-free concurrent PvP attempt) advances one hub's nonce between bundle consent and router submission → router tx reverts.
**How to avoid:** carry over WR-01/WR-02 exactly: record pending submission per hub before broadcast; classify failure from chain state (nonce moved = expected concurrency, abort as data); never error-string-match. Refuse to start ordinary rounds on either hub while a PvP bundle is in flight.
**Warning signs:** a PvP submit path without the sentAtBlock/digest reconciliation the single-hub path has.

### Pitfall 5: fixture drift on the new struct
**What goes wrong:** TS and Solidity PvPRound digests diverge (field order, uint sizing, domain name typo) and nothing catches it until on-chain BadPvPSignature.
**How to avoid:** the mandatory D-05 pipeline — extend `genFixture.ts`, write `PvPParity.t.sol` (deployCodeTo at the fixture router address with fixture hub addresses as constructor args, `vm.chainId(5042002)`), assert digest + recovery. Regeneration-only discipline; never hand-edit.
**Warning signs:** a PvPRound typehash string that doesn't byte-match between `pvp.ts` docs and `PvPRouter.sol`.

### Pitfall 6: treating union-set signing as rate-consent for net deltas
**What goes wrong:** an on-chain (or off-chain) check asserting `usdcDelta·fxDen == −eurcDelta·fxNum` per participant — false in any round mixing FX and non-FX flows; would brick valid rounds.
**How to avoid:** rate consistency is verified per FX-trade IOU *pair* (shared-`ref` convention), participant-side only (D-04). The router checks signatures, never economics.

### Pitfall 7: e2e negative case that passes vacuously
**What goes wrong:** "neither settles" asserted only via coordinator state, which would also pass if the tx was never sent.
**How to avoid:** assert on-chain: both hub `roundNonce`s unchanged, every persona's collateral on both hubs unchanged, and (for the invalid-signature variant) the router tx mined with `status: "reverted"`.

## Code Examples

### PvP digest + consent (SDK, mirrors round.ts exactly)

```typescript
// src/pvp.ts — pattern locked against src/round.ts:roundDigest/signConsent
export function pvpDigest(
  router: Address,
  p: { usdcLegDigest: Hex; eurcLegDigest: Hex; fxNumerator: bigint; fxDenominator: bigint },
  chainId?: number,
): Hex {
  return hashTypedData({
    domain: pvpDomain(router, chainId),
    types: PVP_TYPES,
    primaryType: "PvPRound",
    message: p,
  });
}
```

### Sorted union merge (both sides implement one spec; property-test TS vs Solidity if desired)

```typescript
/** Union of two strictly-ascending (lowercase-comparable) address lists, ascending. */
export function unionParticipants(a: Address[], b: Address[]): Address[] {
  const out: Address[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i].toLowerCase() : undefined;
    const y = j < b.length ? b[j].toLowerCase() : undefined;
    if (y === undefined || (x !== undefined && x < y)) { out.push(a[i++]); }
    else if (x === undefined || y < x) { out.push(b[j++]); }
    else { out.push(a[i]); i++; j++; }
  }
  return out;
}
```

### Rate consistency by cross-multiplication (participant-side, D-04)

```typescript
/** An FX trade pairing u USDC base units with e EURC base units is consistent
 *  with rate fxNumerator/fxDenominator (EURC-per-USDC) iff this holds. */
export function rateConsistent(u: bigint, e: bigint, fxNumerator: bigint, fxDenominator: bigint): boolean {
  return e * fxDenominator === u * fxNumerator; // bigint only — no division exists in the protocol
}
```

### Both-or-neither forge assertions (PvPRouter.t.sol core)

```solidity
// negative: sabotage EURC leg (e.g. one bad signature) → NOTHING settles
uint64 nonceU = hubUSDC.roundNonce();
uint64 nonceE = hubEURC.roundNonce();
uint256 balBefore = hubUSDC.collateral(alice);
vm.expectRevert(abi.encodeWithSelector(ClearingHubV2.BadSignature.selector, 1));
router.executePvP(usdcLeg, corruptedEurcLeg, fxNum, fxDen, pvpSigs);
assertEq(hubUSDC.roundNonce(), nonceU, "USDC leg must not have settled");
assertEq(hubEURC.roundNonce(), nonceE, "EURC leg must not have settled");
assertEq(hubUSDC.collateral(alice), balBefore, "no balance moved");
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| PROTOCOL.md non-goal: "No cross-currency rounds (one hub = one token)" | PvP router composes two single-token hubs atomically | This phase | The non-goal gets a "superseded" note (third one — the doc already has the pattern for threshold consent and redemption) |
| One hub, one coordinator state | Dual-hub demo env + per-hub coordinator state, PvP wrapper | This phase | setup.ts/coordinator/e2e extensions (Pitfall 3) |
| Rate = decimal float (naive FX) | Amount-pair num/den bigints, mirroring App Kit quote shape | Design-time | No division constraint satisfied; direct tie-in to the official sample's representation |

**Deprecated/outdated:** OZ marks storage-based `ReentrancyGuard` as deprecated in favor of `ReentrancyGuardTransient` for v6.0 — irrelevant here (hubs are deployed and frozen; the router needs no guard at all).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | App Kit swap quote field details (`amountIn`/`estimatedOutput` shape) are stable and representative of the sample's rate representation | Pattern 4 | Cosmetic — the demo mirrors a shape; if field names differ the PROTOCOL.md tie-in note needs a wording fix, protocol unaffected |
| A2 | Arc testnet has an observable public mempool (assumed adversarially, i.e., worst case) | Q2 | If mempool is private, the single-leg-extraction window shrinks to coordinator misbehavior only — the accept-and-document answer only gets stronger |
| A3 | Arc testnet block gas limit comfortably exceeds the ~1.6M demo-scale PvP tx | Q6 | If tight, reduce testnet PvP manifest sizes (amountDivisor already reduces scale); e2e prints gasUsed for the record |

## Open Questions

1. **Where does the PvP orchestration live — extend `Coordinator` or a sibling `PvPCoordinator`?**
   - What we know: `Coordinator` is single-hub with per-hub reconciliation state; `attemptRound` is chain-free and submit-injected.
   - What's unclear: cleanest seam — a chain-free `attemptPvPRound` (two leg builds + bundle collection + injected submit) mirroring `attemptRound` looks right, composed by a thin dual-hub coordinator wrapper.
   - Recommendation: planner's structural call; keep the chain-free core + injected-submit pattern either way (it's what makes the abort semantics testable without anvil).
2. **Pass-2 optimization (retain unchanged-leg consents)** — real but adds bookkeeping; recommend full recollection (noted in Pattern 3). Planner may accept the simpler rule outright.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| forge/anvil/cast | contracts build/test/deploy, e2e | ✓ | forge 1.3.5-stable | — |
| node + npm | SDK/tests/demo | ✓ | v24.11.1 | — |
| vitest | SDK tests | ✓ | 2.1.9 | — |
| tsx | npm scripts | ✓ (devDependency, via npm run) | ^4.19 | — |
| Arc testnet RPC + funded deployer | D-10 testnet deploy, e2e:testnet | assumed (used in Phases 1–3) | — | anvil-only until deploy step |

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 2.1.9 (TS) + forge 1.3.5 (Solidity, via_ir, fuzz runs 512) |
| Config file | `vitest.config.ts`, `contracts/foundry.toml` |
| Quick run command | `npm test` (vitest run, seconds) |
| Full suite command | `npm test && npm run test:contracts && npm run e2e:anvil` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PVP-01 | Both legs settle in one tx; balances exact | unit (forge) | `cd contracts && forge test --match-contract PvPRouterTest -vvv` | ❌ Wave 0 (`contracts/test/PvPRouter.t.sol`) |
| PVP-01 | Either-leg failure reverts everything (revert matrix: bad leg sig, wrong nonce, insufficient collateral, paused hub, bad PvP sig, union mismatch, zero rate, leg-digest mismatch) | unit (forge) | same | ❌ Wave 0 |
| PVP-01 | Single-leg direct submission settles (documented limitation) | unit (forge) | `forge test --match-test test_singleLegDirectSubmission` | ❌ Wave 0 |
| PVP-01 | e2e both-or-neither positive + negative on anvil (D-11) | e2e | `npm run e2e:anvil` | ❌ extend `demo/e2e.ts` |
| PVP-02 | PvPRound TS↔Solidity digest + recovery parity (D-05) | parity (forge, fixture) | `forge test --match-contract PvPParityTest` | ❌ Wave 0 (`contracts/test/PvPParity.t.sol` + genFixture pvp_* keys) |
| PVP-02 | pvpDigest/sign/verify roundtrip; verifyPvPProposal accept/reject (rate mismatch, digest mismatch, wrong leg) | unit + property (vitest/fast-check) | `npx vitest run test/pvp.test.ts` | ❌ Wave 0 (`test/pvp.test.ts`) |
| PVP-02 | Union merge correctness (differing/identical/disjoint sets) | property (vitest + forge fuzz) | `npx vitest run test/pvp.test.ts` / forge fuzz | ❌ Wave 0 |
| D-10 | Live router on Arc testnet + walkthrough | manual-only (human-verify checkpoint) | — (justification: real testnet deploy + explorer verification) | — |

### Sampling Rate
- **Per task commit:** `npm test` (plus `forge test --match-contract PvP*` when contracts changed)
- **Per wave merge:** `npm test && npm run test:contracts`
- **Phase gate:** full suite incl. `npm run e2e:anvil` green before `/gsd:verify-work`; regenerate fixtures (`npm run fixture`) before parity runs whenever genFixture changed

### Wave 0 Gaps
- [ ] `test/pvp.test.ts` — covers PVP-02 SDK side
- [ ] `contracts/test/PvPRouter.t.sol` — covers PVP-01 (needs a dual-hub RoundBuilder-style harness; extend `contracts/test/utils/`)
- [ ] `contracts/test/PvPParity.t.sol` + `test/genFixture.ts` pvp_* extension — covers PVP-02 parity (D-05, mandatory)
- [ ] Framework install: none — all frameworks present

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (signature = authorization) | OZ ECDSA + EIP-712 typed data; per-member recovery over shared digest |
| V3 Session Management | no | — |
| V4 Access Control | yes | Permissionless by design; authority = N signatures; router immutables pin hubs |
| V5 Input Validation | yes | Custom-error revert matrix (ZeroRate, LegDigestMismatch, BadPvPSignature, union checks); hubs re-validate everything independently |
| V6 Cryptography | yes | Never hand-roll: OZ EIP712/ECDSA on-chain, viem hashTypedData/signTypedData off-chain, fixture-locked |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Single-leg extraction from router tx (mempool front-run) | Tampering/DoS on FX linkage | Accept-and-document (Q2); signature custody discipline; downgrade bounded to ordinary credit risk — THREAT-MODEL row required (D-13) |
| Evil-hub substitution via calldata hub addresses | Spoofing | Constructor immutables (Q3) |
| Leg/digest mismatch (execute unsigned legs) | Tampering | On-chain `hashRound` recomputation vs signed digests (Pitfall 2) |
| PvPRound replay | Replay | Structural: leg roundNonces (Q2); test it, don't add state |
| Signature malleability | Spoofing | OZ ECDSA.recover (rejects high-s) |
| FX-rate manipulation | Tampering | Unanimous consent binds the rate; rate is agreed, not oracle-fed — say plainly (CONTEXT specifics) |
| Atomicity leak via try/catch | Tampering | Plain calls only + revert-bubbling test (Pitfall 1) |
| Cross-round double consent across hubs | Repudiation/double-settle | Per-hub WR-06 machinery (expectedRoundNonce, pendingConsumedIds) applied per leg |

## Sources

### Primary (HIGH confidence)
- Repo source read this session: `contracts/src/ClearingHubV2.sol`, `src/round.ts`, `src/domain.ts`, `src/types.ts`, `src/client.ts`, `demo/coordinator.ts`, `demo/setup.ts`, `demo/e2e.ts`, `test/genFixture.ts`, `contracts/test/DigestParity.t.sol`, `contracts/test/ClearingHubV2Parity.t.sol`, `contracts/test/MerkleParity.t.sol`, `contracts/script/DeployV2.s.sol`, `docs/PROTOCOL.md`, `docs/V2-BRIEF.md`
- Vendored OZ 5.6.1 (commit `abc1a77`): `ReentrancyGuard.sol` (per-contract slot semantics), `Pausable.sol` (EnforcedPause)
- [docs.arc.io/build/stablecoin-fx](https://docs.arc.io/build/stablecoin-fx) — sample identity + repo link
- [github.com/circlefin/arc-stablecoin-fx](https://github.com/circlefin/arc-stablecoin-fx) — architecture (App Kit Swap SDK, wallets, Supabase)
- [docs.arc.io/app-kit/quickstarts/swap-tokens-same-chain.md](https://docs.arc.io/app-kit/quickstarts/swap-tokens-same-chain.md) — quote amount-pair shape (`amountIn`, `estimatedOutput`, `stopLimit`)

### Secondary (MEDIUM confidence)
- [Circle: Introducing Arc](https://www.circle.com/blog/introducing-arc-an-open-layer-1-blockchain-purpose-built-for-stablecoin-finance), [Decrypt on StableFX](https://decrypt.co/348452/circle-unveils-on-chain-fx-engine-to-expand-stablecoin-trading-on-arc-network), [The Block on StableFX](https://www.theblock.co/post/378723/circle-arc-onchain-fx-engine-multi-currency-stablecoin-program) — StableFX = RFQ + on-chain PvP settlement context

### Tertiary (LOW confidence)
- Arc testnet mempool visibility and block gas limit — unverified (A2, A3)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; everything verified locally
- Architecture (router/struct/union/replay): HIGH — reasoned against exact vendored sources and shipped contracts
- Single-leg threat analysis: HIGH on mechanics and harm bound; MEDIUM on Arc mempool specifics (worst case assumed)
- arc-stablecoin-fx tie-in: HIGH on identity/shape; MEDIUM on exact quote field naming (A1)
- Gas: MEDIUM — formula shape sound, constants require the mandated forge measurement

**Research date:** 2026-07-24
**Valid until:** ~2026-08-24 (stable domain; Arc docs are the only fast-moving source)
