// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {ClearingHubV3} from "./ClearingHubV3.sol";
import {ManifestMerkle} from "./lib/ManifestMerkle.sol";

/// @title PvPRouterV3 — atomic payment-vs-payment settlement across two ClearingHubV3 hubs
/// @notice Executes a USDC leg and a EURC leg — each an ordinary netting round
///         on its own hub — inside ONE transaction (PVP-01, a miniature CLS).
///         Authority is pure signatures: every member of the sorted union of
///         both legs' participant sets signs an EIP-712 `PvPRound` binding the
///         two leg digests and the agreed FX rate (PVP-02); the hubs then
///         independently re-verify per-leg unanimity, nonce, zero-sum, party
///         binding and collateral exactly as for any other round. `executePvP`
///         is permissionless, and the router holds no funds and no authority
///         (D-01): it cannot forge consent, only sequence it.
/// @dev    **Why a second router at all.** `PvPRouter` is bound to a
///         `ClearingHubV2` pair by immutables (deliberately — see below), and
///         calls the V2 `executeRound(uint64,address[],int256[],bytes32[],bytes[])`
///         signature, which V3 does not have. Neither the hub pair nor the leg
///         ABI can be changed after deployment, so V3 needs its own router.
///         `PvPRouter` and the two live V2 hubs stay exactly as they are.
///
///         **What changed vs PvPRouter, and why.**
///
///         (1) `Leg.consumedIds` (`bytes32[]`) became `Leg.consumedRefs`
///             (`ClearingHubV3.ConsumedRef[]`) — V3's CR-01 fix. The router
///             passes the refs through to the hub UNCHANGED; it never
///             reorders, dedupes or rewrites them.
///
///         (2) The leg's `manifestHash` is now the merkle root over the
///             PARTY-BOUND leaves `manifestLeafId(id, participants[a],
///             participants[b])`, not over raw ids. The router must derive
///             those leaves to reproduce the leg digest, so `manifestLeafId`
///             is mirrored here (public, parity-asserted against
///             `ClearingHubV3.manifestLeafId` in PvPRouterV3.t.sol — the same
///             dual-implementation discipline `ManifestMerkle`/`src/merkle.ts`
///             and the EIP-712 digests already carry). Nothing else about
///             V3's ref semantics is reimplemented: distinctness of the two
///             party indices, the `redeemed`/`consumed` exclusivity gates and
///             the leaf-ascent rule are all the hub's, and their reverts
///             bubble. The one check the router does make is a BOUNDS check on
///             each party index, purely so an out-of-range index produces a
///             named error instead of an array-out-of-bounds Panic(0x32)
///             (audit WR-08 class: never mask a diagnostic).
///
///         (3) Constructor validation (audit WR-07). The hub pair is rejected
///             if either address is zero or if the two are the same contract —
///             with one hub for both legs the second `executeRound` would
///             revert `WrongRoundNonce` for every normal bundle, bricking the
///             router silently. WR-07 was raised against `PvPRouter` as a
///             future-deploy hazard; this is that future deploy. Deliberately
///             NOT a `code.length` check: `hashPvPRound` never calls a hub, so
///             fixture/parity harnesses can construct the router at a fixed
///             address with no hub code present. The deploy script carries the
///             code-length assertion instead.
///
///         (4) A distinct EIP-712 domain: `("ArclearPvPRouterV3", "1")`. Both
///             the name AND `verifyingContract` differ from `PvPRouter`'s
///             `("ArclearPvPRouter", "1")`, so a PvPRound consent signed for
///             one router is not a valid signature for the other even though
///             `PVP_ROUND_TYPEHASH` is byte-identical between them. Consent to
///             a V2 bundle can never be replayed as consent to a V3 bundle,
///             and vice versa.
///
///         (5) `PvPExecuted` indexes the three digests (audit IN-08), so
///             indexers can filter a bundle by either leg or by the bundle
///             digest. Topic layout: [sig, usdcLegDigest, eurcLegDigest,
///             pvpDigest]; data: [fxNumerator, fxDenominator].
///
///         **Unchanged, deliberately:** `PVP_ROUND_TYPEHASH` is byte-identical
///         to `PvPRouter`'s, so the shared TS↔Solidity PvP digest fixture and
///         the whole off-chain signing path carry over field-for-field; only
///         the domain separator differs. The union merge, the exact-count
///         signature rule, the zero-rate gate, the leg-digest binding and the
///         revert surface are ported unchanged.
///
///         Atomicity mechanism (PVP-01): both `executeRound` calls are PLAIN
///         high-level external calls — a revert in either leg (bad signature,
///         wrong nonce, insufficient collateral, paused hub, already-consumed
///         leaf, nullified id, …) bubbles up and reverts the whole
///         transaction, so neither leg ever settles alone through this
///         contract. Revert bubbling IS the both-or-neither mechanism;
///         catching a leg failure (try/catch or a low-level call) is the only
///         way this contract could break it, so no such wrapper exists
///         anywhere here.
///
///         Statelessness (D-02): the only state is the two immutable hub
///         addresses — zero storage slots. Deliberately NO reentrancy guard
///         (the router is stateless and holds no funds; each hub carries its
///         own guard in its own storage, entered and exited per leg), NO
///         pause switch, and NO owner: there is nothing to protect, nothing
///         to gate, and nothing to elevate to. The hubs' never-pausable
///         `withdraw` path is untouched. Replay needs no router state either:
///         each signed leg digest binds its hub's roundNonce, so once either
///         leg executes (by ANY path) the bundle can never execute again —
///         the leg reverts WrongRoundNonce and takes the transaction with it.
///         V3 adds a second, independent replay barrier: every consumed leaf
///         is permanently recorded, so a re-signed bundle reusing any of the
///         same paper reverts `AlreadyConsumed`.
///
///         Hub binding: the hub pair is fixed at deployment via constructor
///         immutables — hub addresses NEVER come from calldata (RESEARCH Q3).
///         A PvPRound signature in this router's domain (`verifyingContract`
///         is this router) is therefore consent to legs on exactly this hub
///         pair; evil-hub substitution is structurally closed.
///
///         Known limitation (RESEARCH Q1.6/Q2c), carried over unchanged: leg
///         consents are ordinary hub Round signatures, valid standalone — an
///         adversary who obtains one leg's complete signature set (including
///         by extracting it from this router's pending transaction in the
///         mempool) can settle that leg directly on its hub without its twin.
///         The downgrade is to ordinary collateralized netting credit risk on
///         the open leg, never to unsigned balance movement; see
///         docs/THREAT-MODEL.md (single-leg extraction) for the full analysis
///         and the signature custody discipline that narrows the window.
///         `test_singleLegDirectSubmissionSettles` pins it as accepted
///         behaviour rather than a regression.
contract PvPRouterV3 is EIP712 {
    /// @notice One netting round exactly as its hub's `executeRound` consumes
    ///         it: nonce, strictly-ascending participants, per-participant
    ///         deltas, the party-bound consumed refs (strictly ascending BY
    ///         DERIVED LEAF, which is what the hub's `rootOf` sees — not by raw
    ///         id), and one Round consent signature per participant. Mirrors
    ///         the SDK's RoundProposal minus the derived digest.
    struct Leg {
        uint64 nonce;
        address[] participants;
        int256[] deltas;
        ClearingHubV3.ConsumedRef[] consumedRefs;
        bytes[] signatures;
    }

    /// @notice The USDC-side hub. Immutable by design — never calldata (D-02).
    ClearingHubV3 public immutable hubUSDC;

    /// @notice The EURC-side hub. Immutable by design — never calldata (D-02).
    ClearingHubV3 public immutable hubEURC;

    /// @dev Byte-identical to PvPRouter's typehash — only the domain differs.
    bytes32 private constant PVP_ROUND_TYPEHASH = keccak256(
        "PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)"
    );

    /// @notice Emitted after both legs settled atomically in this transaction.
    /// @dev    IN-08: the three digests are indexed so a bundle is filterable
    ///         by either leg or by its own digest.
    event PvPExecuted(
        bytes32 indexed usdcLegDigest,
        bytes32 indexed eurcLegDigest,
        bytes32 indexed pvpDigest,
        uint256 fxNumerator,
        uint256 fxDenominator
    );

    error ZeroRate();
    error LegDigestMismatch(uint8 leg);
    error BadPvPSignature(uint256 index);
    error PvPSignatureCountMismatch(uint256 expected, uint256 provided);
    error UnionNotStrictlyAscending();

    /// @notice A hub pair that would make the router unusable or unsafe: a zero
    ///         address, or the same hub on both sides (WR-07).
    error BadConfig();

    /// @notice A ConsumedRef names a participant index that does not exist in
    ///         its leg. `leg` is 0 for the USDC leg, 1 for the EURC leg.
    /// @dev    The router's ONLY structural check on refs. It exists so the
    ///         failure is a named error rather than a Panic(0x32) from indexing
    ///         `participants`; the hub raises its own `PartyIndexOutOfRange`
    ///         for the same condition, which this simply pre-empts.
    error LegPartyIndexOutOfRange(
        uint8 leg, uint256 refIndex, uint32 partyIdx, uint256 participantCount
    );

    /// @notice Permanently binds this router to one hub pair. The EIP-712
    ///         domain ("ArclearPvPRouterV3", "1") uses this router as
    ///         verifyingContract, so PvPRound consent is inseparable from
    ///         exactly these two hubs (RESEARCH Q3 — immutables are the
    ///         mitigation, not an optimization).
    /// @param hubUSDC_ The deployed ClearingHubV3 clearing USDC.
    /// @param hubEURC_ The deployed ClearingHubV3 clearing EURC.
    constructor(ClearingHubV3 hubUSDC_, ClearingHubV3 hubEURC_)
        EIP712("ArclearPvPRouterV3", "1")
    {
        // WR-07: the immutables are only as good as what deploy passes.
        if (address(hubUSDC_) == address(0) || address(hubEURC_) == address(0)) revert BadConfig();
        if (address(hubUSDC_) == address(hubEURC_)) revert BadConfig();
        hubUSDC = hubUSDC_;
        hubEURC = hubEURC_;
    }

    /// @notice EIP-712 digest every union member signs to consent to the PvP
    ///         bundle: both leg digests plus the agreed FX rate as a
    ///         numerator/denominator base-unit pair (PVP-02 — no division
    ///         anywhere; rate economics are verified participant-side by
    ///         cross-multiplication). Public so off-chain implementations can
    ///         assert encoding parity against the chain.
    /// @param usdcLegDigest The USDC leg's hub Round digest (hubUSDC.hashRound).
    /// @param eurcLegDigest The EURC leg's hub Round digest (hubEURC.hashRound).
    /// @param fxNumerator EURC base units of the agreed rate pair; never zero.
    /// @param fxDenominator USDC base units of the agreed rate pair; never zero.
    function hashPvPRound(
        bytes32 usdcLegDigest,
        bytes32 eurcLegDigest,
        uint256 fxNumerator,
        uint256 fxDenominator
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PVP_ROUND_TYPEHASH, usdcLegDigest, eurcLegDigest, fxNumerator, fxDenominator
                )
            )
        );
    }

    /// @notice Local mirror of `ClearingHubV3.manifestLeafId` — the manifest
    ///         leaf, and the hub's consumption-ledger key, for one consumed
    ///         IOU: a commitment to the id AND its two parties, ordered
    ///         canonically so the leaf is identical whichever way round the
    ///         caller supplies debtor and creditor.
    /// @dev    Duplicated rather than called: reproducing a leg digest needs
    ///         one leaf per ref, and an external staticcall per leaf would cost
    ///         more than the whole merkle pass. Byte-equality with the hub's
    ///         implementation is asserted (unit + fuzz) in PvPRouterV3.t.sol —
    ///         if these two ever diverge, every leg digest the router derives
    ///         diverges too and `LegDigestMismatch` fires, so the failure is
    ///         loud and closed, never silent.
    function manifestLeafId(bytes32 id, address partyA, address partyB)
        public
        pure
        returns (bytes32)
    {
        (address lo, address hi) = partyA < partyB ? (partyA, partyB) : (partyB, partyA);
        return keccak256(abi.encodePacked(id, lo, hi));
    }

    /// @notice Settle both legs atomically. Permissionless: authority comes
    ///         from the union's PvPRound signatures plus each leg's own
    ///         unanimous Round signatures, which the hubs verify themselves.
    ///         Order of checks: rate sanity, calldata-vs-signed leg binding,
    ///         union consent, then execution — nothing executes before every
    ///         signature is proven.
    /// @dev    Leg digests are recomputed via each hub's public, parity-locked
    ///         `hashRound` over the calldata legs (never reimplemented here —
    ///         Pitfall 2), so a signature over `usdcLegDigest`/`eurcLegDigest`
    ///         transitively binds the exact calldata being executed — including
    ///         each ref's party attribution, which now travels into the root.
    ///         ManifestMerkle.rootOf additionally reverts UnsortedLeaves on a
    ///         manifest that is not ascending by derived leaf, before any
    ///         signature work.
    ///
    ///         IN-06 (documented, not a security check): the two `*LegDigest`
    ///         parameters are redundant — the recomputed values are what get
    ///         used. They are an explicit caller assertion that the calldata
    ///         being executed is the calldata the union signed over, and the
    ///         resulting `LegDigestMismatch` can only fire on caller error.
    ///
    ///         IN-07 (documented, unavoidable): each leg's merkle root is
    ///         computed here and again inside the hub. The hub cannot trust a
    ///         root supplied by a caller, so the duplication is the price of
    ///         the router being just another unprivileged caller.
    /// @param usdcLeg The USDC round, exactly as hubUSDC.executeRound takes it.
    /// @param eurcLeg The EURC round, exactly as hubEURC.executeRound takes it.
    /// @param usdcLegDigest The USDC leg digest the union signed over.
    /// @param eurcLegDigest The EURC leg digest the union signed over.
    /// @param fxNumerator Agreed rate numerator (EURC base units); never zero.
    /// @param fxDenominator Agreed rate denominator (USDC base units); never zero.
    /// @param pvpSignatures Exactly one PvPRound signature per member of the
    ///        sorted union of both legs' participant sets, index-aligned to
    ///        merged ascending order.
    function executePvP(
        Leg calldata usdcLeg,
        Leg calldata eurcLeg,
        bytes32 usdcLegDigest,
        bytes32 eurcLegDigest,
        uint256 fxNumerator,
        uint256 fxDenominator,
        bytes[] calldata pvpSignatures
    ) external {
        // (1) A zero rate component would make every cross-multiplication
        //     rate check vacuous — reject before touching anything else.
        if (fxNumerator == 0 || fxDenominator == 0) revert ZeroRate();

        // (2) Bind calldata legs to the signed digests via the hubs' public
        //     hashRound (Pitfall 2: never verify against calldata directly).
        bytes32 digestU = hubUSDC.hashRound(
            usdcLeg.nonce,
            usdcLeg.participants,
            usdcLeg.deltas,
            _legManifestRoot(0, usdcLeg.participants, usdcLeg.consumedRefs)
        );
        if (digestU != usdcLegDigest) revert LegDigestMismatch(0);
        bytes32 digestE = hubEURC.hashRound(
            eurcLeg.nonce,
            eurcLeg.participants,
            eurcLeg.deltas,
            _legManifestRoot(1, eurcLeg.participants, eurcLeg.consumedRefs)
        );
        if (digestE != eurcLegDigest) revert LegDigestMismatch(1);

        // (3) The PvP consent digest over the recomputed (== signed) leg
        //     digests and the rate.
        bytes32 pvpDigest = hashPvPRound(digestU, digestE, fxNumerator, fxDenominator);

        // (4) Union consent: exactly one valid signature per member of the
        //     sorted union of both participant sets, index-aligned (Q5 —
        //     the union is a superset of everyone whose delta assumed the
        //     other leg settles at this rate).
        (address[] memory union_, uint256 unionCount) =
            _unionOf(usdcLeg.participants, eurcLeg.participants);
        if (pvpSignatures.length != unionCount) {
            revert PvPSignatureCountMismatch(unionCount, pvpSignatures.length);
        }
        for (uint256 i; i < unionCount; ++i) {
            if (ECDSA.recover(pvpDigest, pvpSignatures[i]) != union_[i]) revert BadPvPSignature(i);
        }

        // (5) Execute both legs. PLAIN external calls — a revert in either
        //     bubbles and undoes everything (PVP-01: bubbling IS the
        //     atomicity mechanism; Pitfall 1). Refs are forwarded exactly as
        //     received: the router never rewrites a leg.
        hubUSDC.executeRound(
            usdcLeg.nonce,
            usdcLeg.participants,
            usdcLeg.deltas,
            usdcLeg.consumedRefs,
            usdcLeg.signatures
        );
        hubEURC.executeRound(
            eurcLeg.nonce,
            eurcLeg.participants,
            eurcLeg.deltas,
            eurcLeg.consumedRefs,
            eurcLeg.signatures
        );

        // (6) Both legs settled — announce the bundle.
        emit PvPExecuted(digestU, digestE, pvpDigest, fxNumerator, fxDenominator);
    }

    /// @dev The leg's `manifestHash`: the merkle root over the PARTY-BOUND
    ///      leaves this leg's refs commit, derived exactly as
    ///      `ClearingHubV3.executeRound` derives it. Bounds-checks both party
    ///      indices so an out-of-range ref is a named error rather than a
    ///      Panic; every other ref rule (distinct parties, ascent by leaf, the
    ///      redeemed/consumed exclusivity gates) belongs to the hub and its
    ///      revert bubbles from step (5) — or, for ascent, from `rootOf` here.
    function _legManifestRoot(
        uint8 leg,
        address[] calldata participants,
        ClearingHubV3.ConsumedRef[] calldata refs
    ) private pure returns (bytes32) {
        uint256 n = participants.length;
        uint256 m = refs.length;
        bytes32[] memory leaves = new bytes32[](m);
        for (uint256 i; i < m; ++i) {
            ClearingHubV3.ConsumedRef calldata r = refs[i];
            if (r.partyAIdx >= n) revert LegPartyIndexOutOfRange(leg, i, r.partyAIdx, n);
            if (r.partyBIdx >= n) revert LegPartyIndexOutOfRange(leg, i, r.partyBIdx, n);
            leaves[i] = manifestLeafId(r.id, participants[r.partyAIdx], participants[r.partyBIdx]);
        }
        return ManifestMerkle.rootOf(leaves);
    }

    /// @dev Single-pass sorted merge of the two participant lists into their
    ///      ascending union. The merged stream must be strictly ascending —
    ///      which holds iff BOTH inputs are strictly ascending — otherwise
    ///      reverts UnionNotStrictlyAscending; this also rejects the zero
    ///      address, matching the hubs' own participant ordering rule. The
    ///      returned buffer is over-allocated to `a.length + b.length`; only
    ///      the first `count` entries are meaningful.
    function _unionOf(address[] calldata a, address[] calldata b)
        private
        pure
        returns (address[] memory, uint256)
    {
        uint256 na = a.length;
        uint256 nb = b.length;
        address[] memory buf = new address[](na + nb);
        uint256 i;
        uint256 j;
        uint256 count;
        address prev;
        while (i < na || j < nb) {
            address next;
            if (j == nb || (i < na && a[i] < b[j])) {
                next = a[i];
                ++i;
            } else if (i == na || b[j] < a[i]) {
                next = b[j];
                ++j;
            } else {
                // Same address in both legs: one union entry, one signature.
                next = a[i];
                ++i;
                ++j;
            }
            if (next <= prev) revert UnionNotStrictlyAscending();
            prev = next;
            buf[count] = next;
            ++count;
        }
        return (buf, count);
    }
}
