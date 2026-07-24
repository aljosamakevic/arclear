// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {ClearingHubV2} from "./ClearingHubV2.sol";
import {ManifestMerkle} from "./lib/ManifestMerkle.sol";

/// @title PvPRouter — atomic payment-vs-payment settlement across two ClearingHubV2 hubs
/// @notice Executes a USDC leg and a EURC leg — each an ordinary netting round
///         on its own hub — inside ONE transaction (PVP-01, a miniature CLS).
///         Authority is pure signatures: every member of the sorted union of
///         both legs' participant sets signs an EIP-712 `PvPRound` binding the
///         two leg digests and the agreed FX rate (PVP-02); the hubs then
///         independently re-verify per-leg unanimity, nonce, zero-sum, and
///         collateral exactly as for any other round. `executePvP` is
///         permissionless, and the router holds no funds and no authority
///         (D-01): it cannot forge consent, only sequence it.
/// @dev    Atomicity mechanism (PVP-01): both `executeRound` calls are PLAIN
///         high-level external calls — a revert in either leg (bad signature,
///         wrong nonce, insufficient collateral, paused hub, nullified id, …)
///         bubbles up and reverts the whole transaction, so neither leg ever
///         settles alone through this contract. Revert bubbling IS the
///         both-or-neither mechanism; catching a leg failure (try/catch or a
///         low-level call) is the only way this contract could break it, so
///         no such wrapper exists anywhere here.
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
///
///         Hub binding: the hub pair is fixed at deployment via constructor
///         immutables — hub addresses NEVER come from calldata (RESEARCH Q3).
///         A PvPRound signature in this router's domain (`verifyingContract`
///         is this router) is therefore consent to legs on exactly this hub
///         pair; evil-hub substitution is structurally closed.
///
///         Known limitation (RESEARCH Q1.6/Q2c): leg consents are ordinary
///         hub Round signatures, valid standalone — an adversary who obtains
///         one leg's complete signature set (including by extracting it from
///         this router's pending transaction in the mempool) can settle that
///         leg directly on its hub without its twin. The downgrade is to
///         ordinary collateralized netting credit risk on the open leg, never
///         to unsigned balance movement; see docs/THREAT-MODEL.md
///         (single-leg extraction) for the full analysis and the signature
///         custody discipline that narrows the window.
contract PvPRouter is EIP712 {
    /// @notice One netting round exactly as its hub's `executeRound` consumes
    ///         it: nonce, strictly-ascending participants, per-participant
    ///         deltas, strictly-ascending consumed IOU ids, and one Round
    ///         consent signature per participant. Mirrors the SDK's
    ///         RoundProposal minus the derived digest.
    struct Leg {
        uint64 nonce;
        address[] participants;
        int256[] deltas;
        bytes32[] consumedIds;
        bytes[] signatures;
    }

    /// @notice The USDC-side hub. Immutable by design — never calldata (D-02).
    ClearingHubV2 public immutable hubUSDC;

    /// @notice The EURC-side hub. Immutable by design — never calldata (D-02).
    ClearingHubV2 public immutable hubEURC;

    bytes32 private constant PVP_ROUND_TYPEHASH = keccak256(
        "PvPRound(bytes32 usdcLegDigest,bytes32 eurcLegDigest,uint256 fxNumerator,uint256 fxDenominator)"
    );

    /// @notice Emitted after both legs settled atomically in this transaction.
    event PvPExecuted(
        bytes32 usdcLegDigest,
        bytes32 eurcLegDigest,
        uint256 fxNumerator,
        uint256 fxDenominator,
        bytes32 pvpDigest
    );

    error ZeroRate();
    error LegDigestMismatch(uint8 leg);
    error BadPvPSignature(uint256 index);
    error PvPSignatureCountMismatch(uint256 expected, uint256 provided);
    error UnionNotStrictlyAscending();

    /// @notice Permanently binds this router to one hub pair. The EIP-712
    ///         domain ("ArclearPvPRouter", "1") uses this router as
    ///         verifyingContract, so PvPRound consent is inseparable from
    ///         exactly these two hubs (RESEARCH Q3 — immutables are the
    ///         mitigation, not an optimization).
    /// @param hubUSDC_ The deployed ClearingHubV2 clearing USDC.
    /// @param hubEURC_ The deployed ClearingHubV2 clearing EURC.
    constructor(ClearingHubV2 hubUSDC_, ClearingHubV2 hubEURC_) EIP712("ArclearPvPRouter", "1") {
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

    /// @notice Settle both legs atomically. Permissionless: authority comes
    ///         from the union's PvPRound signatures plus each leg's own
    ///         unanimous Round signatures, which the hubs verify themselves.
    ///         Order of checks: rate sanity, calldata-vs-signed leg binding,
    ///         union consent, then execution — nothing executes before every
    ///         signature is proven.
    /// @dev    Leg digests are recomputed via each hub's public, parity-locked
    ///         `hashRound` over the calldata legs (never reimplemented here —
    ///         Pitfall 2), so a signature over `usdcLegDigest`/`eurcLegDigest`
    ///         transitively binds the exact calldata being executed.
    ///         ManifestMerkle.rootOf additionally reverts UnsortedLeaves on a
    ///         disordered manifest before any signature work.
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
            usdcLeg.nonce, usdcLeg.participants, usdcLeg.deltas, ManifestMerkle.rootOf(usdcLeg.consumedIds)
        );
        if (digestU != usdcLegDigest) revert LegDigestMismatch(0);
        bytes32 digestE = hubEURC.hashRound(
            eurcLeg.nonce, eurcLeg.participants, eurcLeg.deltas, ManifestMerkle.rootOf(eurcLeg.consumedIds)
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
        //     atomicity mechanism; Pitfall 1).
        hubUSDC.executeRound(
            usdcLeg.nonce, usdcLeg.participants, usdcLeg.deltas, usdcLeg.consumedIds, usdcLeg.signatures
        );
        hubEURC.executeRound(
            eurcLeg.nonce, eurcLeg.participants, eurcLeg.deltas, eurcLeg.consumedIds, eurcLeg.signatures
        );

        // (6) Both legs settled — announce the bundle.
        emit PvPExecuted(digestU, digestE, fxNumerator, fxDenominator, pvpDigest);
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
